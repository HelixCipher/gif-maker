"""
Usage examples:
  # Video -> GIF
  python gif_maker.py video -i input.mp4 -o out.gif --fps 15 --max-width 800

  # Multiple images -> GIF
  python gif_maker.py images -i img1.png img2.png img3.png -o out.gif --fps 10

  # Single image -> animated GIF (Ken Burns + subtle warp)
  python gif_maker.py single -i portrait.jpg -o portrait_anim.gif --duration 4 --fps 15 --zoom 1.18

This script uses:
 - moviepy for video reading (requires ffmpeg)
 - pillow for image ops
 - imageio for gif writing
 - numpy
"""
import argparse
import os
import math
from pathlib import Path
from typing import List, Tuple

import numpy as np
from PIL import Image, ImageEnhance
import imageio

# moviepy import inside function to keep startup light if unused
def video_to_gif(input_path: str, output_path: str, fps: int = 15, max_width: int = 800, max_seconds: float = 12.0):
    """
    Convert a video file to a gif.
    Strategy:
      1) Try moviepy (robust imports, API fallbacks) with simple write_gif call.
      2) If moviepy conversion fails (API differences or runtime errors), fallback to ffmpeg CLI:
         - re-encode a short/resized mp4 (limits duration, reduces memory)
         - generate palette (palettegen)
         - create gif using palette (paletteuse)
    Returns: writes to output_path or raises RuntimeError on failure.
    """
    # robust import for VideoFileClip across moviepy package layouts
    VideoFileClip = None
    try:
        from moviepy.editor import VideoFileClip
    except Exception:
        try:
            from moviepy.video.io.VideoFileClip import VideoFileClip
        except Exception:
            VideoFileClip = None

    # helper for ffmpeg fallback
    import subprocess, shutil, shlex, uuid

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Video file not found: {input_path}")

    # Attempt moviepy path if available
    if VideoFileClip is not None:
        try:
            clip = VideoFileClip(input_path)
            # optional trim
            try:
                if max_seconds and getattr(clip, "duration", None) is not None and clip.duration > max_seconds:
                    clip = clip.subclip(0, max_seconds)
            except Exception:
                pass

            # resize via best available API
            clip_w = getattr(clip, "w", None)
            if clip_w and clip_w > max_width:
                try:
                    if hasattr(clip, "resize"):
                        clip = clip.resize(width=max_width)
                    else:
                        from moviepy.video.fx import all as vfx_all
                        clip = clip.fx(vfx_all.resize, width=max_width)
                except Exception:
                    # ignore and continue; fallback will handle if this fails
                    pass

            # try the simple write_gif call (no 'program' kwarg)
            try:
                clip.write_gif(output_path, fps=fps)
                try:
                    clip.close()
                except Exception:
                    pass
                return
            except TypeError:
                # older/newer moviepy may throw TypeError for unexpected kwargs; try without args
                try:
                    clip.write_gif(output_path)
                    try:
                        clip.close()
                    except Exception:
                        pass
                    return
                except Exception as e:
                    # fall through to ffmpeg fallback
                    last_err = e
            except Exception as e:
                last_err = e
            # ensure clip closed before fallback
            try:
                clip.close()
            except Exception:
                pass
        except Exception as e:
            # moviepy import/usage failed; fall through to ffmpeg fallback
            last_err = e
    else:
        last_err = RuntimeError("moviepy not available (VideoFileClip import failed).")

    # -------------------------------
    # Fallback: ffmpeg CLI (palette method)
    # -------------------------------
    try:
        tmpdir = tempfile.mkdtemp(prefix="gif_ffmpeg_")
        # create an intermediate small video (mp4) to avoid codec & size issues
        small_video = os.path.join(tmpdir, f"{uuid.uuid4().hex}_small.mp4")
        pal = os.path.join(tmpdir, f"{uuid.uuid4().hex}_palette.png")
        gif_tmp = os.path.join(tmpdir, f"{uuid.uuid4().hex}_out.gif")

        # build ffmpeg re-encode command (limit duration and scale width)
        ffmpeg_recode = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-t", str(max_seconds or 8),
            "-vf", f"scale={max(320, int(max_width))}:-2",
            "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "23",
            "-an",
            small_video
        ]
        subprocess.run(ffmpeg_recode, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # palettegen
        cmd_pal = [
            "ffmpeg", "-y", "-i", small_video,
            "-vf", f"fps={fps},scale={max(320, int(max_width))}:-2:flags=lanczos,palettegen",
            pal
        ]
        subprocess.run(cmd_pal, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # paletteuse -> gif
        # use -loop 0 for infinite loop
        cmd_gif = [
            "ffmpeg", "-y", "-i", small_video, "-i", pal,
            "-lavfi", f"fps={fps},scale={max(320, int(max_width))}:-2:flags=lanczos[x];[x][1:v]paletteuse",
            "-loop", "0",
            gif_tmp
        ]
        subprocess.run(cmd_gif, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # move result into place
        shutil.move(gif_tmp, output_path)
        shutil.rmtree(tmpdir, ignore_errors=True)
        return
    except subprocess.CalledProcessError as ex:
        # include stderr for better diagnostics
        stderr = ex.stderr.decode(errors="ignore") if ex.stderr else str(ex)
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise RuntimeError(f"ffmpeg conversion failed: {stderr}") from ex
    except Exception as ex:
        shutil.rmtree(tmpdir, ignore_errors=True)
        # debug, chain it for context
        raise RuntimeError(f"video_to_gif failed (moviepy err={repr(last_err)}) and ffmpeg fallback failed: {ex}") from ex




def images_to_gif(image_paths: List[str], output_path: str, fps: int = 10, loop: int = 0, size: Tuple[int,int]=None):
    """
    Make an animated GIF from a list of image filenames.
    Ensures all frames are the same size and consistent mode.
    - If size is None, choose the smallest (w,h) among inputs to avoid upscaling.
    - Center-crops differing aspect ratios to preserve composition.
    """
    if not image_paths:
        raise ValueError("images_to_gif: no image paths provided")

    pil_images = []
    widths, heights = [], []
    for p in image_paths:
        if not os.path.exists(p):
            raise FileNotFoundError(f"Image not found: {p}")
        img = Image.open(p).convert("RGBA")
        pil_images.append(img)
        widths.append(img.width)
        heights.append(img.height)

    # choose conservative common size (smallest) to avoid upscaling if not provided
    if size is None:
        target_w = min(widths)
        target_h = min(heights)
        size = (target_w, target_h)
    else:
        size = (int(size[0]), int(size[1]))

    frames = []
    duration_s = 1.0 / max(1, fps)
    target_w, target_h = size

    for img in pil_images:
        w, h = img.size

        # Crop to the same aspect ratio as the target, centered
        src_ratio = w / h
        tgt_ratio = target_w / target_h
        if abs(src_ratio - tgt_ratio) > 1e-6:
            if src_ratio > tgt_ratio:
                # source is wider -> crop sides
                new_w = int(h * tgt_ratio)
                left = (w - new_w) // 2
                img_cropped = img.crop((left, 0, left + new_w, h))
            else:
                # source is taller -> crop top/bottom
                new_h = int(w / tgt_ratio)
                top = (h - new_h) // 2
                img_cropped = img.crop((0, top, w, top + new_h))
        else:
            img_cropped = img

        img_resized = img_cropped.resize((target_w, target_h), Image.LANCZOS)
        frames.append(np.array(img_resized))

    print(f"[images_to_gif] Writing {len(frames)} frames to {output_path} at {fps} fps (size={size})")
    imageio.mimsave(output_path, frames, format='GIF', duration=duration_s, loop=loop)


def single_image_to_gif_kenburns(
    image_path: str,
    output_path: str,
    duration: float = 3.0,
    fps: int = 15,
    target_size: Tuple[int,int] = (640, 360),
    zoom: float = 1.12,
    pan_path: str = "diagonal",
    jitter_deg: float = 0.8,
    color_jitter: float = 0.03,
    loop: int = 0,
):
    """
    Create a lightweight animated GIF from one image using Ken Burns + small affine jitter.
    - pan_path: "diagonal", "center_out", "left_to_right", "random"
    - zoom: final zoom multiplier (e.g., 1.12 => small zoom-in)
    - jitter_deg: small rotation jitter range in degrees
    - color_jitter: fraction to randomly adjust brightness/contrast
    """
    im = Image.open(image_path).convert("RGB")
    orig_w, orig_h = im.size
    tgt_w, tgt_h = target_size

    total_frames = max(3, int(duration * fps))
    duration_ms = int(1000 / fps)

    # decide start and end centers based on pan_path
    def choose_centers():
        if pan_path == "diagonal":
            start = (int(orig_w * 0.15), int(orig_h * 0.15))
            end = (int(orig_w * 0.85), int(orig_h * 0.85))
        elif pan_path == "center_out":
            start = (orig_w // 2, orig_h // 2)
            end = (int(orig_w * 0.8), int(orig_h * 0.5))
        elif pan_path == "left_to_right":
            start = (int(orig_w * 0.2), orig_h // 2)
            end = (int(orig_w * 0.8), orig_h // 2)
        else:  # random
            rng = np.random.RandomState(42)
            start = (rng.randint(int(orig_w*0.1), int(orig_w*0.4)), rng.randint(int(orig_h*0.1), int(orig_h*0.4)))
            end = (rng.randint(int(orig_w*0.6), int(orig_w*0.9)), rng.randint(int(orig_h*0.6), int(orig_h*0.9)))
        return start, end

    start_center, end_center = choose_centers()

    frames = []
    for i in range(total_frames):
        t = i / max(1, total_frames - 1)
        # ease in-out for smoother motion
        ease = 0.5 - 0.5 * math.cos(math.pi * t)

        # compute scale: from 1.0 -> zoom
        scale = 1.0 + (zoom - 1.0) * ease

        # compute center
        cx = int(start_center[0] * (1 - ease) + end_center[0] * ease)
        cy = int(start_center[1] * (1 - ease) + end_center[1] * ease)

        # compute crop box in original image coordinates
        crop_w = int(orig_w / scale)
        crop_h = int(orig_h / scale)

        # ensure crop stays inside image
        left = max(0, min(orig_w - crop_w, cx - crop_w // 2))
        top = max(0, min(orig_h - crop_h, cy - crop_h // 2))
        right = left + crop_w
        bottom = top + crop_h

        crop = im.crop((left, top, right, bottom))
        # resize crop to target size
        frame = crop.resize((tgt_w, tgt_h), Image.LANCZOS)

        # small rotation jitter
        ang = (np.sin(2 * math.pi * t * 1.0) * jitter_deg * 0.5) + (np.random.uniform(-jitter_deg, jitter_deg) * 0.3)
        frame = frame.rotate(ang, resample=Image.BICUBIC, expand=False, fillcolor=(0,0,0))

        # small color jitter for life
        if color_jitter > 0:
            b = 1.0 + np.random.uniform(-color_jitter, color_jitter)
            c = 1.0 + np.random.uniform(-color_jitter, color_jitter)
            e1 = ImageEnhance.Brightness(frame)
            frame = e1.enhance(b)
            e2 = ImageEnhance.Contrast(frame)
            frame = e2.enhance(c)

        frames.append(frame.convert("P", palette=Image.ADAPTIVE))

    # Save as GIF using PIL's save_all for smaller filesize and decent compatibility
    print(f"[single_image_to_gif_kenburns] Writing {len(frames)} frames to {output_path} ({duration}s @ {fps}fps)")
    frames[0].save(
        output_path,
        save_all=True,
        append_images=frames[1:],
        duration=duration_ms,
        loop=loop,
        optimize=True,
        disposal=2,
    )


def find_image_files_from_args(paths: List[str]) -> List[str]:
    files = []
    for p in paths:
        path = Path(p)
        if path.is_dir():
            # gather common image extensions
            for ext in ("*.png", "*.jpg", "*.jpeg", "*.webp", "*.bmp", "*.tiff"):
                files.extend(sorted([str(x) for x in path.glob(ext)]))
        elif "*" in p:
            files.extend(sorted([str(x) for x in Path('.').glob(p)]))
        else:
            files.append(str(path))
    # filter out non-existent
    files = [f for f in files if Path(f).exists()]
    return files


def main():
    parser = argparse.ArgumentParser(description="Create GIFs from videos or images, plus single-image Ken Burns animation.")
    sub = parser.add_subparsers(dest="mode", required=True)

    # video subparser
    pv = sub.add_parser("video", help="Convert a video file to GIF (requires ffmpeg).")
    pv.add_argument("-i", "--input", required=True, help="Path to video file")
    pv.add_argument("-o", "--output", required=True, help="Output GIF path")
    pv.add_argument("--fps", type=int, default=15)
    pv.add_argument("--max-width", type=int, default=800)

    # images -> gif
    pi = sub.add_parser("images", help="Convert multiple images to GIF.")
    pi.add_argument("-i", "--input", nargs="+", required=True, help="Image files or directories or glob patterns")
    pi.add_argument("-o", "--output", required=True)
    pi.add_argument("--fps", type=int, default=10)
    pi.add_argument("--width", type=int, default=None)
    pi.add_argument("--height", type=int, default=None)
    pi.add_argument("--loop", type=int, default=0)

    # single image -> animated gif
    ps = sub.add_parser("single", help="Animate a single image via Ken Burns + subtle jitter.")
    ps.add_argument("-i", "--input", required=True)
    ps.add_argument("-o", "--output", required=True)
    ps.add_argument("--duration", type=float, default=3.0)
    ps.add_argument("--fps", type=int, default=15)
    ps.add_argument("--width", type=int, default=640)
    ps.add_argument("--height", type=int, default=360)
    ps.add_argument("--zoom", type=float, default=1.12)
    ps.add_argument("--pan", dest="pan", choices=["diagonal", "center_out", "left_to_right", "random"], default="diagonal")

    args = parser.parse_args()

    if args.mode == "video":
        video_to_gif(args.input, args.output, fps=args.fps, max_width=args.max_width)
    elif args.mode == "images":
        files = find_image_files_from_args(args.input)
        if not files:
            raise SystemExit(f"No images found in {args.input}")
        size = (args.width, args.height) if args.width and args.height else None
        images_to_gif(files, args.output, fps=args.fps, loop=args.loop, size=size)
    elif args.mode == "single":
        single_image_to_gif_kenburns(
            args.input,
            args.output,
            duration=args.duration,
            fps=args.fps,
            target_size=(args.width, args.height),
            zoom=args.zoom,
            pan_path=args.pan,
        )
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
