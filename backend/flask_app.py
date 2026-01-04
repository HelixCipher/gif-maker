from flask import Flask, request, send_file, jsonify, after_this_request
from flask_cors import CORS
from werkzeug.utils import secure_filename
import tempfile, os, shutil

# import the functions defined in gif_maker.py
from gif_maker import video_to_gif, images_to_gif, single_image_to_gif_kenburns

app = Flask(__name__)
CORS(app)  # allow frontend dev server to call this. Remove/lock down in production.

# Optional: limit max upload size (bytes) -> set to reasonable value
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024  # 200 MB

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
        if mode == "video":
            # use the first file as the video input
            video_in = saved_paths[0]
            max_width = width if width else 800
            video_to_gif(video_in, out_gif, fps=fps, max_width=max_width)
        elif mode == "images":
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


if __name__ == "__main__":
    # For development only. In production use gunicorn/uvicorn behind a reverse proxy.
    app.run(host="0.0.0.0", port=5000, debug=True)
