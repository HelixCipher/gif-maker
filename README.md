# GIF Maker

<p align="center">
  <img src="URL" width="800" alt="Project Project_Demonstration_GIF.gif"/>
</p>

A web-based tool to generate GIFs from images, multiple images, or videos.  
Built with **React + Vite** for the frontend and **Flask** for the backend.

---

## Features

- Convert a single image into a GIF with Ken Burns effect.  
- Convert multiple images into a GIF.  
- Convert videos into GIFs or MP4s.
- Adjustable parameters: FPS, duration, width, height, zoom, pan, speed, loops, bounce, output format.
- Trim video previews before generating output. 
- Works in modern browsers with a simple GUI.

---


---

## Requirements

- Python 3.11+
- Node.js 20+
- Conda environment recommended for Python dependencies
- FFmpeg installed and available in PATH

---

## Backend Setup (Flask)

1. Create and activate a Python environment:

```bash
conda create -n gifmaker python=3.11
conda activate gifmaker
```


2. Install dependencies:

```bash
pip install flask flask-cors moviepy imageio-ffmpeg pillow numpy python-dotenv tqdm
```

3. Run the backend:

```bash
python backend/flask_app.py
```

- The backend will be available at http://localhost:5000.

---

## Frontend Setup (React + Vite)

1. Navigate to frontend:

```bash
cd frontend
```

2. Install dependencies:

```bash
npm install
```

3. Start the development server:

```bash
npm run dev
```

* Open your browser at the URL shown in the terminal.

4. Tailwind:

```bash
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```
- Add Tailwind directives to index.css if desired.

---

## Usage

- Open the frontend in your browser.

- Upload a file (image, multiple images, or video).

- For videos, trim start and end using the preview sliders.

- Set parameters (FPS, duration, width/height, zoom, pan, speed, loops, bounce, output format) if needed.

- Click Generate GIF or Generate (async).

- Download the resulting GIF or MP4.


### API Endpoints

### POST /api/generate

**Form Data:**

| Field     | Type   | Description                          |
|-----------|--------|--------------------------------------|
| mode      | string | `single`, `images`, `video`          |
| files[]   | file   | One or more files                     |
| fps       | int    | Frames per second                     |
| duration  | float  | Duration in seconds (for single image) |
| width     | int    | Max width                             |
| height    | int    | Max height                            |
| zoom      | float  | Zoom factor (for single image)       |
| pan       | string | Pan path (`diagonal`, `horizontal`, etc.) |

**Returns:** GIF file (`image/gif`)


### POST /api/generate_async

**Form Data:**

| Field        | Type   | Description                                         |
|--------------|--------|-----------------------------------------------------|
| files[]      | file   | One video file                                      |
| start        | float  | Start time in seconds                               |
| end          | float  | End time in seconds                                 |
| fps          | int    | Frames per second                                   |
| width        | int    | Output width                                        |
| format       | string | `gif` or `mp4`                                     |
| speed        | float  | Playback speed multiplier                           |
| loops        | int    | Number of loops for GIF                             |
| loop_forever | bool   | Loop GIF indefinitely                               |
| bounce       | bool   | Apply bounce effect to GIF                          |
| max_seconds  | float  | Maximum length in seconds                            |

**Returns:** JSON with `job_id`. Poll `/api/job_status/<job_id>` for progress and `/api/job_output/<job_id>` to download output.



---

## Notes / Troubleshooting

- Ensure you’re using the same Python environment where moviepy and imageio-ffmpeg are installed.

- For video-to-GIF conversion, FFmpeg must be installed and on your PATH.

- For GIF bounce effect, install gifsicle.

- Large videos or many images may produce big GIFs and take time to generate.

- Video trimming is supported via the preview sliders before generation.

- Output can now be either GIF or MP4 for better performance on longer clips.

- CORS is enabled for development. Lock it down in production.

---