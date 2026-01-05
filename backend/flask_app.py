from flask import Flask, request, jsonify, send_file, after_this_request
from flask_cors import CORS
from werkzeug.utils import secure_filename
import tempfile, os, shutil, time, subprocess, threading, uuid 

# import the functions defined in gif_maker.py
from gif_maker import images_to_gif, single_image_to_gif_kenburns

app = Flask(__name__)
CORS(app)  # allow frontend to call API during dev

# Limit max upload size (bytes)
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024  # 200 MB

# --- Job store ---
job_store = {}  # job_id -> dict
job_store_lock = threading.Lock()


def run_ffmpeg_with_progress(cmd_list, duration_seconds, job_id):
    """
    Run ffmpeg command (list) and parse stderr for time= to update job progress.
    """
    proc = subprocess.Popen(cmd_list, stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    start = time.time()
    try:
        while True:
            line = proc.stderr.readline()
            if not line:
                if proc.poll() is not None:
                    break
                continue
            if "time=" in line:
                try:
                    part = line.strip().split("time=")[-1].split(" ")[0]
                    hh, mm, ss = part.split(":")
                    now = float(hh) * 3600 + float(mm) * 60 + float(ss)
                    pct = min(99.9, max(0.0, (now / max(1.0, duration_seconds)) * 100.0))
                    elapsed = time.time() - start
                    eta = None
                    if pct > 0.5:
                        eta = max(0.0, elapsed * (100.0 / pct - 1.0))
                    with job_store_lock:
                        job = job_store.get(job_id)
                        if job:
                            job['progress'] = pct
                            job['eta'] = eta
                except Exception:
                    pass
        rc = proc.wait()
        return rc
    except Exception:
        try:
            proc.kill()
        except:
            pass
        raise


def process_video_job(job_id, params):
    """
    Background job for video/GIF processing.
    """
    with job_store_lock:
        job_store[job_id]['status'] = 'running'
        job_store[job_id]['progress'] = 0.0
        job_store[job_id]['eta'] = None

    try:
        input_video = params['input_video']
        start = float(params.get('start', 0.0))
        end = params.get('end', None)
        end = float(end) if end else None
        fps = int(params.get('fps', 12))
        width = int(params.get('width', 640))
        out_format = params.get('format', 'gif')
        speed = float(params.get('speed', 1.0))
        loops = int(params.get('loops', 0))
        loop_forever = bool(params.get('loop_forever', False))
        bounce = bool(params.get('bounce', False))

        # Probe video duration
        try:
            p = subprocess.run([
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                input_video
            ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            total_dur = float(p.stdout.strip())
        except Exception:
            total_dur = 60.0  # fallback if probe fails

        # Determine segment based on user's trim settings
        if end is None:
            end_time = total_dur
        else:
            end_time = min(end, total_dur)
        seg_len = max(0.1, end_time - start)

        # Temporary directory
        tmpdir = tempfile.mkdtemp(prefix=f"job_{job_id}_")
        small_video = os.path.join(tmpdir, "segment.mp4")
        final_out = os.path.join(tmpdir, f"result.{ 'mp4' if out_format=='mp4' else 'gif' }")

        # Re-encode small segment
        scale_expr = f"scale={max(320, int(width))}:-2"
        recode_cmd = [
            "ffmpeg", "-y",
            "-ss", str(start),
            "-t", str(seg_len),
            "-i", input_video,
            "-vf", scale_expr,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-an",
            small_video
        ]
        subprocess.run(recode_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Convert to target format
        if out_format == 'mp4':
            ff_cmd = [
                "ffmpeg", "-y", "-i", small_video,
                "-filter:v", f"setpts={1.0/max(1e-6, speed)}*PTS",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                final_out
            ]
            rc = run_ffmpeg_with_progress(ff_cmd, seg_len, job_id)
            if rc != 0:
                raise RuntimeError(f"ffmpeg exit {rc}")
        else:
            # GIF: palettegen + paletteuse
            pal = os.path.join(tmpdir, "palette.png")
            cmd_pal = [
                "ffmpeg", "-y", "-i", small_video,
                "-vf", f"fps={fps},scale={max(320,int(width))}:-2:flags=lanczos,palettegen",
                pal
            ]
            subprocess.run(cmd_pal, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            cmd_gif = [
                "ffmpeg", "-y", "-i", small_video, "-i", pal,
                "-lavfi", f"fps={fps},scale={max(320,int(width))}:-2:flags=lanczos[x];[x][1:v]paletteuse",
                "-loop", "0" if loop_forever else str(loops),
                final_out
            ]
            rc = run_ffmpeg_with_progress(cmd_gif, seg_len, job_id)
            if rc != 0:
                raise RuntimeError(f"ffmpeg exit {rc}")

            # Optional bounce with gifsicle
            if bounce:
                try:
                    rev = os.path.join(tmpdir, "rev.gif")
                    subprocess.run(["gifsicle", "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    bounced = os.path.join(tmpdir, "bounced.gif")
                    subprocess.run(["gifsicle", "--optimize=3", final_out, "--reverse", "-o", bounced], check=True)
                    os.replace(bounced, final_out)
                except Exception:
                    pass

        # Done
        with job_store_lock:
            job = job_store.get(job_id)
            if job:
                job['status'] = 'done'
                job['progress'] = 100.0
                job['eta'] = 0.0
                job['output'] = final_out
                job['tmpdir'] = tmpdir

    except Exception as e:
        with job_store_lock:
            job = job_store.get(job_id)
            if job:
                job['status'] = 'error'
                job['error'] = str(e)


# --- API Routes ---

@app.route("/api/generate", methods=["POST"])
def generate():
    """
    Accepts multipart/form-data:
      - files[]: one or more uploaded files
      - mode: 'video' | 'images' | 'single'
      - fps, duration, width, height, zoom, pan (strings, optional)
    Returns:
      - GIF binary (content-type: image/gif) on success
    """
    mode = request.form.get("mode", "single")
    # parse parameters with safe defaults
    def get_int(name, default=None):
        v = request.form.get(name)
        try:
            return int(v) if v is not None and v != '' else default
        except:
            return default
    def get_float(name, default=None):
        v = request.form.get(name)
        try:
            return float(v) if v is not None and v != '' else default
        except:
            return default

    fps = get_int("fps", 15)
    duration = get_float("duration", 3.0)
    width = get_int("width", None)
    height = get_int("height", None)
    zoom = get_float("zoom", 1.12)
    pan = request.form.get("pan", "diagonal")

    files = request.files.getlist("files[]")
    if not files:
        return jsonify({"error": "No files uploaded (files[])."}), 400

    # create temp dir per request
    tmpdir = tempfile.mkdtemp(prefix="gifgen_")
    saved_paths = []
    try:
        for i, f in enumerate(files):
            filename = secure_filename(f.filename) or f"upload_{i}"
            out_path = os.path.join(tmpdir, f"{i:03d}_{filename}")
            f.save(out_path)
            saved_paths.append(out_path)

        out_gif = os.path.join(tmpdir, "result.gif")

        # call the right function
        if mode == "images":
            size = (width, height) if (width and height) else None
            images_to_gif(saved_paths, out_gif, fps=fps, loop=0, size=size)
        elif mode == "single":
            first = saved_paths[0]
            tgt_size = (width or 640, height or 360)
            single_image_to_gif_kenburns(first, out_gif, duration=duration, fps=fps, target_size=tgt_size, zoom=zoom, pan_path=pan)
        else:
            return jsonify({"error": f"Unknown mode: {mode}"}), 400

        if not os.path.exists(out_gif):
            return jsonify({"error": "GIF not produced."}), 500

        @after_this_request
        def cleanup(response):
            try:
                shutil.rmtree(tmpdir)
            except Exception as e:
                app.logger.error("Failed to cleanup tmpdir: %s", e)
            return response

        return send_file(out_gif, mimetype="image/gif")
    except Exception as e:
        try:
            shutil.rmtree(tmpdir)
        except:
            pass
        app.logger.exception("generation failed")
        return jsonify({"error": "internal error", "detail": str(e)}), 500


@app.route("/api/generate_async", methods=["POST"])
def generate_async():
    files = request.files.getlist("files[]")
    if not files:
        return jsonify({"error":"no files uploaded"}), 400

    tmpdir = tempfile.mkdtemp(prefix="upload_")
    saved = []
    for i, f in enumerate(files):
        fn = secure_filename(f.filename) or f"upload_{i}"
        path = os.path.join(tmpdir, f"{i:03d}_{fn}")
        f.save(path)
        saved.append(path)

    params = {
        "input_video": saved[0],
        "start": request.form.get("start", 0.0),
        "end": request.form.get("end", None),
        "fps": request.form.get("fps", 12),
        "width": request.form.get("width", 640),
        "format": request.form.get("format", "gif"),
        "speed": request.form.get("speed", 1.0),
        "loops": request.form.get("loops", 0),
        "loop_forever": request.form.get("loop_forever", "false").lower() == "true",
        "bounce": request.form.get("bounce", "false").lower() == "true"
    }

    job_id = uuid.uuid4().hex
    with job_store_lock:
        job_store[job_id] = {
            "status": "queued",
            "progress": 0.0,
            "eta": None,
            "output": None,
            "error": None,
            "tmpdir": tmpdir
        }

    # Run worker thread
    t = threading.Thread(target=process_video_job, args=(job_id, params), daemon=True)
    t.start()

    return jsonify({"job_id": job_id}), 202


@app.route("/api/job_status/<job_id>", methods=["GET"])
def job_status(job_id):
    with job_store_lock:
        job = job_store.get(job_id)
        if not job:
            return jsonify({"error":"unknown job"}), 404
        return jsonify({
            "status": job['status'],
            "progress": job.get('progress', 0.0),
            "eta": job.get('eta'),
            "output": job.get('output') and os.path.basename(job.get('output')),
            "error": job.get('error')
        })


@app.route("/api/job_output/<job_id>", methods=["GET"])
def job_output(job_id):
    with job_store_lock:
        job = job_store.get(job_id)
        if not job:
            return jsonify({"error":"unknown job"}), 404
        if job['status'] != 'done' or not job.get('output'):
            return jsonify({"error":"not_ready"}), 400
        return send_file(job['output'], as_attachment=True)


if __name__ == "__main__":
    # Development server
    app.run(host="0.0.0.0", port=5000, debug=True)