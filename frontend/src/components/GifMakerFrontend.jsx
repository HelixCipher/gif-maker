import React, { useState, useRef } from "react";
import { motion } from "framer-motion";

// Gif Maker Frontend (single-file React component)
// - Tailwind CSS is used for styling (theme)
// - Expects a backend POST endpoint at /api/generate that accepts FormData
//    fields: mode (video|images|single), files[] (one or many), fps, duration, width, height, zoom, pan
// - Backend should return the generated GIF as the response body with content-type image/gif
// - This component handles upload progress, preview, and download

export default function GifMakerFrontend() {
  const [mode, setMode] = useState("single");
  const [files, setFiles] = useState([]);
  const [fps, setFps] = useState(15);
  const [duration, setDuration] = useState(3);
  const [width, setWidth] = useState(640);
  const [height, setHeight] = useState(360);
  const [zoom, setZoom] = useState(1.12);
  const [pan, setPan] = useState("diagonal");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [error, setError] = useState(null);
  const [dark, setDark] = useState(true);

  const inputRef = useRef(null);

  function handleDrop(e) {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files);
    setFiles((prev) => prev.concat(dropped));
  }

  function handleFilesSelected(e) {
    const chosen = Array.from(e.target.files || []);
    setFiles((prev) => prev.concat(chosen));
  }

  function clearFiles() {
    setFiles([]);
    setPreviewUrl(null);
  }

  function removeFile(index) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function makeFormData() {
    const fd = new FormData();
    fd.append("mode", mode);
    // backend expects files[]
    files.forEach((f) => fd.append("files[]", f, f.name));
    fd.append("fps", String(fps));
    fd.append("duration", String(duration));
    fd.append("width", String(width));
    fd.append("height", String(height));
    fd.append("zoom", String(zoom));
    fd.append("pan", pan);
    return fd;
  }

  function upload() {
    if (!files.length) {
      setError("Add at least one file to continue.");
      return;
    }
    setError(null);
    setBusy(true);
    setProgress(0);
    setPreviewUrl(null);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/generate", true);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        setProgress(pct);
      }
    };

    xhr.onload = () => {
      setBusy(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response;
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setProgress(100);
      } else {
        setError(`Server error: ${xhr.status} ${xhr.statusText}`);
      }
    };

    xhr.onerror = () => {
      setBusy(false);
      setError("Network error during upload.");
    };

    xhr.responseType = "blob"; // expecting gif blob
    const fd = makeFormData();
    xhr.send(fd);
  }

  // toggle dark/light mode by adding/removing class on html element
  React.useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [dark]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-white/30 to-white/5 dark:from-black/20 dark:to-black/40 p-6">
      <div className="max-w-4xl w-full">
        <div className="backdrop-blur-lg bg-white/30 dark:bg-black/30 border border-white/10 dark:border-white/6 rounded-2xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-semibold text-black/90 dark:text-white/90">GIF Maker</h1>
              <p className="mt-1 text-sm text-black/60 dark:text-white/60">Convert video or images into animated GIFs</p>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-sm text-black/70 dark:text-white/70">Theme</span>
                <button
                  onClick={() => setDark((d) => !d)}
                  className="relative inline-flex h-7 w-12 items-center rounded-full p-1 transition-all"
                  aria-label="Toggle theme"
                >
                  <span
                    className={`absolute inset-0 rounded-full transition-opacity ${dark ? "bg-black/40" : "bg-white/50"}`}
                  />
                  <span
                    className={`relative h-5 w-5 rounded-full bg-white shadow transform transition-transform ${dark ? "translate-x-5" : "translate-x-0"}`}
                  />
                </button>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Controls column */}
            <div className="col-span-1">
              <div className="space-y-4">
                <div className="p-3 rounded-xl border border-white/8 bg-white/20 dark:bg-black/20">
                  <label className="block text-sm font-medium mb-2">Mode</label>
                  <div className="flex gap-2">
                    <label className={`flex-1 p-2 rounded-lg text-center cursor-pointer ${mode === 'single' ? 'border-2 border-indigo-400' : 'border'} `}>
                      <input type="radio" name="mode" value="single" checked={mode==='single'} onChange={() => setMode('single')} className="hidden" />
                      Single image
                    </label>
                    <label className={`flex-1 p-2 rounded-lg text-center cursor-pointer ${mode === 'images' ? 'border-2 border-indigo-400' : 'border'} `}>
                      <input type="radio" name="mode" value="images" checked={mode==='images'} onChange={() => setMode('images')} className="hidden" />
                      Multiple images
                    </label>
                    <label className={`flex-1 p-2 rounded-lg text-center cursor-pointer ${mode === 'video' ? 'border-2 border-indigo-400' : 'border'} `}>
                      <input type="radio" name="mode" value="video" checked={mode==='video'} onChange={() => setMode('video')} className="hidden" />
                      Video
                    </label>
                  </div>
                </div>

                <div className="p-3 rounded-xl border border-white/8 bg-white/10">
                  <label className="block text-sm font-medium mb-2">Files</label>
                  <div
                    onDrop={handleDrop}
                    onDragOver={(e) => e.preventDefault()}
                    className="rounded-lg p-4 border-2 border-dashed border-white/10 bg-white/5 text-sm text-black/70 dark:text-white/70 cursor-pointer"
                    onClick={() => inputRef.current && inputRef.current.click()}
                  >
                    <input ref={inputRef} type="file" multiple accept="image/*,video/*" className="hidden" onChange={handleFilesSelected} />
                    <div className="flex flex-col items-center justify-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
                      </svg>
                      <div>{files.length ? `${files.length} file(s) ready` : "Drop files here or click to select"}</div>
                      <div className="text-xs text-black/50 dark:text-white/40">Accepts images and short videos (ffmpeg required server-side)</div>
                    </div>
                  </div>

                  {files.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {files.map((f, i) => (
                        <div key={i} className="flex items-center justify-between bg-white/5 p-2 rounded-md">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium">{f.name}</div>
                            <div className="text-xs text-black/50 dark:text-white/40">{Math.round(f.size/1024)} KB</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button className="text-xs px-2 py-1 rounded-md border" onClick={() => removeFile(i)}>Remove</button>
                          </div>
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <button onClick={clearFiles} className="flex-1 rounded-md py-2 bg-transparent border">Clear</button>
                        <button onClick={() => inputRef.current && inputRef.current.click()} className="flex-1 rounded-md py-2 bg-indigo-600 text-white">Add more</button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-3 rounded-xl border border-white/8 bg-white/10 space-y-2">
                  <label className="block text-sm font-medium">Parameters</label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs">FPS
                      <input type="number" value={fps} onChange={(e) => setFps(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>
                    <label className="text-xs">Duration (s)
                      <input type="number" value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>
                    <label className="text-xs">Width
                      <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>
                    <label className="text-xs">Height
                      <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>
                    <label className="text-xs">Zoom
                      <input step="0.01" type="number" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>
                    <label className="text-xs">Pan
                      <select value={pan} onChange={(e) => setPan(e.target.value)} className="w-full mt-1 rounded-md p-1">
                        <option value="diagonal">Diagonal</option>
                        <option value="center_out">Center out</option>
                        <option value="left_to_right">Left to right</option>
                        <option value="random">Random</option>
                      </select>
                    </label>
                  </div>

                </div>

                <div className="flex gap-2">
                  <button onClick={upload} disabled={busy} className="flex-1 py-2 rounded-lg bg-indigo-600 text-white">{busy ? 'Working...' : 'Generate GIF'}</button>
                  <button onClick={() => { setPreviewUrl(null); setError(null); }} className="py-2 px-3 rounded-lg border">Reset</button>
                </div>

                {error && <div className="text-sm text-red-400">{error}</div>}

                {busy && (
                  <div className="mt-2">
                    <div className="text-sm">Uploading: {progress}%</div>
                    <div className="w-full bg-white/10 h-2 rounded-full mt-1">
                      <div className="h-2 rounded-full bg-indigo-500" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}

              </div>
            </div>

            {/* Preview column */}
            <div className="col-span-2">
              <motion.div initial={{ opacity: 0.9 }} animate={{ opacity: 1 }} className="rounded-xl border border-white/8 p-4 h-full flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-semibold text-black/90 dark:text-white/90">Preview</h2>
                  <div className="text-sm text-black/60 dark:text-white/60">Result will appear here after generation</div>
                </div>

                <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-white/5 rounded-lg p-4 flex flex-col items-center justify-center">
                    {previewUrl ? (
                      <div className="flex flex-col items-center gap-3">
                        <img src={previewUrl} alt="gif preview" className="max-w-full max-h-96 rounded-md shadow" />
                        <div className="flex gap-2">
                          <a href={previewUrl} download="output.gif" className="px-4 py-2 rounded-md border bg-white/10">Download GIF</a>
                          <button onClick={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }} className="px-4 py-2 rounded-md border">Clear</button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center text-sm text-black/50 dark:text-white/40">No preview yet. Generate a GIF to preview it here.</div>
                    )}
                  </div>

                  <div className="bg-white/5 rounded-lg p-4">
                    <h3 className="text-sm font-medium mb-2">Quick Tips</h3>
                    <ul className="text-sm space-y-2 list-disc ml-4 text-black/60 dark:text-white/60">
                      <li>Single-image animation uses Ken-Burns style panning + subtle jitter (server-side).</li>
                      <li>For video inputs, keep clips short (GIFs grow quickly with length & resolution).</li>
                      <li>Use lower FPS and smaller dimensions for smaller file sizes.</li>
                    </ul>
                    <div className="mt-3">
                      <h4 className="text-xs font-medium">Backend contract</h4>
                      <p className="text-xs text-black/50 dark:text-white/40">POST /api/generate with FormData (files[] + parameters). Respond with content-type image/gif and the binary data of the gif.</p>
                    </div>
                  </div>
                </div>

              </motion.div>
            </div>
          </div>

          <div className="mt-4 text-xs text-black/50 dark:text-white/40"></div>
        </div>
      </div>
    </div>
  );
}
