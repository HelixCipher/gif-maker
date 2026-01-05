import React, { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";

// Gif Maker Frontend (theme preserved)
// - For images/single: uses existing synchronous /api/generate (returns gif blob).
// - For video: uses /api/generate_async and polls /api/job_status/<id> to show progress & ETA,
//   then fetches /api/job_output/<id> when done.

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

  // --- new state for video trimming & controls ---
  const videoRef = useRef(null);
  const [videoURL, setVideoURL] = useState(null);
  const [durationSec, setDurationSec] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);

  // dimensions UI: presets + manual fields
  const [dimensionPreset, setDimensionPreset] = useState("640x360");

  // new controls
  const [speed, setSpeed] = useState(1.0);
  const [loopsPreset, setLoopsPreset] = useState("0");
  const [manualLoops, setManualLoops] = useState("");
  const [loopForever, setLoopForever] = useState(false);
  const [bounce, setBounce] = useState(false);
  const [outFormat, setOutFormat] = useState("gif"); // gif or mp4
  const [maxSeconds, setMaxSeconds] = useState(8);

  // async job tracking (video)
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [eta, setEta] = useState(null);
  const pollerRef = useRef(null);

  // Helper: derived loops value
  const loops = manualLoops !== "" ? Number(manualLoops) : Number(loopsPreset || 0);

  // --- file handlers ---
  function handleDrop(e) {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files);
    addFiles(dropped);
  }

  function handleFilesSelected(e) {
    const chosen = Array.from(e.target.files || []);
    addFiles(chosen);
  }

  function addFiles(list) {
  // append
  setFiles((prev) => {
    const next = prev.concat(list);
    // if first file is a video, set video preview and switch mode to video
    if (next.length > 0) {
      const first = next[0];
      if (first.type && first.type.startsWith("video/")) {
        const url = URL.createObjectURL(first);
        setVideoURL((old) => { if (old) URL.revokeObjectURL(old); return url; });
        setMode("video");                 // <- NEW: ensure UI uses video async flow
      } else {
        // not video -> clear video preview
        if (videoURL) {
          URL.revokeObjectURL(videoURL);
          setVideoURL(null);
        }
        // optionally set mode to image(s) if prefer automatic behavior:
        // setMode(next.length === 1 ? "single" : "images");
      }
    }
    return next;
  });
  setPreviewUrl(null);
  }


  function clearFiles() {
    // revoke preview url
    if (previewUrl) {
      try { URL.revokeObjectURL(previewUrl); } catch {}
      setPreviewUrl(null);
    }
    // revoke video blob
    if (videoURL) {
      try { URL.revokeObjectURL(videoURL); } catch {}
      setVideoURL(null);
    }
    // clear file input
    if (inputRef.current) inputRef.current.value = "";
    setFiles([]);
    setError(null);
    setJobId(null);
    setJobStatus(null);
    setProgress(0);
    setEta(null);
    stopPolling();
  }

  function removeFile(index) {
    setFiles((prev) => {
      const copy = prev.slice();
      const [removed] = copy.splice(index, 1);
      if (removed && removed === files[0] && videoURL) {
        try { URL.revokeObjectURL(videoURL); } catch {}
        setVideoURL(null);
      }
      if (copy.length === 0) {
        // clear previews
        if (previewUrl) { try{URL.revokeObjectURL(previewUrl)}catch{}; setPreviewUrl(null); }
        setJobId(null);
        setJobStatus(null);
      }
      return copy;
    });
  }

  // --- Video trimming behaviour ---
  useEffect(() => {
    if (!videoRef.current) return;
    const v = videoRef.current;
    const onLoaded = () => {
      const dur = v.duration || 0;
      setDurationSec(dur);
      setStartTime(0);
      setEndTime(dur);
    };
    v.addEventListener("loadedmetadata", onLoaded);
    return () => v.removeEventListener("loadedmetadata", onLoaded);
  }, [videoURL]);

  // when user moves sliders, seek the video so user sees live result and time
  useEffect(() => {
    if (!videoRef.current) return;
    const v = videoRef.current;
    // clamp and seek to startTime so user sees frame at start
    if (!isNaN(startTime) && startTime >= 0 && startTime <= (durationSec || Infinity)) {
      try {
        v.currentTime = Math.min(startTime, Math.max(0, (v.duration || durationSec) - 0.001));
      } catch (e) {
        // ignore seek errors (some browsers may throw if metadata not loaded)
      }
    }
  }, [startTime, durationSec, videoURL]);

  // --- backend interaction ---
  function makeFormDataForAsync() {
    const fd = new FormData();
    files.forEach((f) => fd.append("files[]", f, f.name));
    fd.append("mode", mode);          // 'single' | 'images' | 'video'
    fd.append("fps", String(fps));
    fd.append("duration", String(duration));
    fd.append("width", String(width));
    fd.append("height", String(height));
    fd.append("zoom", String(zoom));
    fd.append("pan", pan);

    // video-specific fields (ignored for images)
    fd.append("start", String(startTime));
    fd.append("end", String(endTime));
    fd.append("format", outFormat);
    fd.append("speed", String(speed));
    fd.append("loops", String(loops));
    fd.append("loop_forever", String(loopForever));
    fd.append("bounce", String(bounce));
    fd.append("max_seconds", String(maxSeconds));

    return fd;
  }


  // For images/single: original synchronous upload -> returns blob
  function uploadSync() {
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

    xhr.responseType = "blob";
    const fd = makeFormDataForAsync();
    xhr.send(fd);
  }

  // For video: start async job and poll
  async function startVideoJob() {
    if (!files.length) { setError("Add a video file first."); return; }
    setError(null);
    setBusy(true);
    setProgress(0);
    setPreviewUrl(null);
    setJobId(null);
    setJobStatus(null);
    setEta(null);

    const fd = new FormData();
    files.forEach((f) => fd.append("files[]", f, f.name));
    fd.append("mode", "video");
    fd.append("start", String(startTime));
    fd.append("end", String(endTime));
    fd.append("fps", String(fps));
    fd.append("width", String(width));
    fd.append("format", outFormat);
    fd.append("speed", String(speed));
    fd.append("loops", String(loops));
    fd.append("loop_forever", String(loopForever));
    fd.append("bounce", String(bounce));
    fd.append("max_seconds", String(maxSeconds));

    try {
      const res = await fetch("/api/generate_async", { method: "POST", body: fd });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || res.statusText);
      }
      const j = await res.json();
      const id = j.job_id;
      setJobId(id);
      // start polling
      startPolling(id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  function startPolling(id) {
    stopPolling(); // clear any old
    pollerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/job_status/${id}`);
        if (!res.ok) {
          // treat as transient error; continue
          return;
        }
        const json = await res.json();
        setJobStatus(json.status);
        setProgress(Number(json.progress || 0));
        setEta(json.eta !== undefined && json.eta !== null ? Math.round(json.eta) : null);
        if (json.status === "done") {
          // fetch output
          stopPolling();
          setBusy(false);
          // get file
          const outRes = await fetch(`/api/job_output/${id}`);
          if (outRes.ok) {
            const blob = await outRes.blob();
            const url = URL.createObjectURL(blob);
            setPreviewUrl(url);
            setProgress(100);
          } else {
            setError("Job done but failed to fetch output.");
          }
        } else if (json.status === "error") {
          stopPolling();
          setBusy(false);
          setError(json.error || "Server-side processing failed");
        }
      } catch (e) {
        // keep polling; optionally surface transient errors
        console.error("poll error", e);
      }
    }, 900);
  }

  function stopPolling() {
    if (pollerRef.current) {
      clearInterval(pollerRef.current);
      pollerRef.current = null;
    }
  }

  // unified upload entry point:
  function upload() {
    // if mode is video, use async flow to show ETA/progress
    if (mode === "video") {
      startVideoJob();
    } else {
      uploadSync();
    }
  }

  // Reset enhanced: clear everything, stop polling, revoke blobs
  function resetAll() {
    stopPolling();
    if (previewUrl) {
      try { URL.revokeObjectURL(previewUrl); } catch {}
    }
    if (videoURL) {
      try { URL.revokeObjectURL(videoURL); } catch {}
    }
    setFiles([]);
    if (inputRef.current) inputRef.current.value = "";
    setPreviewUrl(null);
    setVideoURL(null);
    setDurationSec(0);
    setStartTime(0);
    setEndTime(0);
    setJobId(null);
    setJobStatus(null);
    setProgress(0);
    setEta(null);
    setBusy(false);
    setError(null);
    
    // Reset all parameters to defaults
    setMode("single");
    setFps(15);
    setDuration(3);
    setWidth(640);
    setHeight(360);
    setZoom(1.12);
    setPan("diagonal");
    setDimensionPreset("640x360");
    setSpeed(1.0);
    setManualLoops("");
    setLoopsPreset("0");
    setLoopForever(false);
    setBounce(false);
    setOutFormat("gif");
    setMaxSeconds(8);
  }

  // ensure we clean up blobs on unmount
  useEffect(() => {
    return () => {
      try { stopPolling(); } catch {}
      if (previewUrl) try { URL.revokeObjectURL(previewUrl); } catch {}
      if (videoURL) try { URL.revokeObjectURL(videoURL); } catch {}
    };
  }, []); // eslint-disable-line

  // toggle dark/light mode by adding/removing class on html element (unchanged)
  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [dark]);

  // dimension preset handler
  useEffect(() => {
    if (dimensionPreset === "640x360") { setWidth(640); setHeight(360); }
    else if (dimensionPreset === "1280x720") { setWidth(1280); setHeight(720); }
    else if (dimensionPreset === "320x240") { setWidth(320); setHeight(240); }
    // custom leaves manual values
  }, [dimensionPreset]);

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
            {/* Controls Column */}
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

                {/* Parameters & new controls */}
                <div className="p-3 rounded-xl border border-white/8 bg-white/10 space-y-2">
                  <label className="block text-sm font-medium">Parameters</label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs">FPS
                      <input type="number" value={fps} onChange={(e) => setFps(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>

                    <label className="text-xs">Duration (s)
                      <input type="number" value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>

                    <label className="text-xs">Dimensions (preset)
                      <select value={dimensionPreset} onChange={(e)=>setDimensionPreset(e.target.value)} className="w-full mt-1 rounded-md p-1">
                        <option value="640x360">640 x 360</option>
                        <option value="1280x720">1280 x 720</option>
                        <option value="320x240">320 x 240</option>
                        <option value="custom">Custom</option>
                      </select>
                    </label>
                    <div className="flex gap-2">
                      <label className="text-xs w-full">Width (px)
                        <input type="number" value={width} onChange={(e)=>setWidth(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                      </label>
                      <label className="text-xs w-full">Height (px)
                        <input type="number" value={height} onChange={(e)=>setHeight(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                      </label>
                    </div>

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

                    {/* new: speed */}
                    <label className="text-xs">Speed
                      <input step="0.1" type="number" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>

                    {/* loops preset + manual input */}
                    <label className="text-xs">Loops (preset)
                      <select value={loopsPreset} onChange={(e)=>setLoopsPreset(e.target.value)} className="w-full mt-1 rounded-md p-1">
                        <option value="0">0</option>
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                        <option value="5">5</option>
                        <option value="10">10</option>
                      </select>
                    </label>
                    <label className="text-xs">Manual loops (override)
                      <input type="number" value={manualLoops} onChange={(e)=>setManualLoops(e.target.value)} placeholder="empty -> use preset" className="w-full mt-1 rounded-md p-1" />
                    </label>

                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={loopForever} onChange={(e)=>setLoopForever(e.target.checked)} />
                      <span className="text-xs">Loop forever</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={bounce} onChange={(e)=>setBounce(e.target.checked)} />
                      <span className="text-xs">Bounce</span>
                    </div>

                    <label className="text-xs">Output format
                      <select value={outFormat} onChange={(e)=>setOutFormat(e.target.value)} className="w-full mt-1 rounded-md p-1">
                        <option value="gif">GIF</option>
                        <option value="mp4">MP4 (recommended)</option>
                      </select>
                    </label>

                    <label className="text-xs">Max seconds (server cap)
                      <input type="number" value={maxSeconds} onChange={(e)=>setMaxSeconds(Number(e.target.value))} className="w-full mt-1 rounded-md p-1" />
                    </label>

                  </div>
                </div>

                <div className="flex gap-2">
                  <button onClick={upload} disabled={busy} className="flex-1 py-2 rounded-lg bg-indigo-600 text-white">{busy ? 'Working...' : (mode==='video' ? 'Generate (async)' : 'Generate GIF')}</button>
                  <button onClick={resetAll} className="py-2 px-3 rounded-lg border">Reset</button>
                </div>

                {error && <div className="text-sm text-red-400">{error}</div>}

                {/* progress / ETA (show when job in progress) */}
                { (jobId || busy) && mode === 'video' && (
                  <div className="mt-2">
                    <div className="text-sm">Progress: {progress}% {eta ? `• ETA: ${eta}s` : ''}</div>
                    <div className="w-full bg-white/10 h-2 rounded-full mt-1">
                      <div className="h-2 rounded-full bg-indigo-500" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}

              </div>
            </div>

            {/* Preview Column */}
            <div className="col-span-2">
              <motion.div initial={{ opacity: 0.9 }} animate={{ opacity: 1 }} className="rounded-xl border border-white/8 p-4 h-full flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-semibold text-black/90 dark:text-white/90">Preview</h2>
                  <div className="text-sm text-black/60 dark:text-white/60">Result will appear here after generation</div>
                </div>

                <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* preview area: if video selected show video preview + trim UI */}
                  <div className="bg-white/5 rounded-lg p-4 flex flex-col items-center justify-center">
                    { videoURL && (
                      <div style={{ width: "100%" }}>
                        <video ref={videoRef} src={videoURL} controls style={{ width: "100%", maxHeight: 420 }} />
                        <div className="mt-2 text-sm text-black/60 dark:text-white/60">Trim: start {startTime.toFixed(2)}s — end {endTime.toFixed(2)}s • length {(endTime - startTime).toFixed(2)}s</div>

                        <div className="mt-2 grid grid-cols-1 gap-2">
                          <label className="text-xs">Start</label>
                          <input type="range" min="0" max={durationSec || 0} step="0.01" value={startTime} onChange={(e)=>setStartTime(Math.min(Number(e.target.value), endTime - 0.05))} />
                          <label className="text-xs">End</label>
                          <input type="range" min="0" max={durationSec || 0} step="0.01" value={endTime} onChange={(e)=>setEndTime(Math.max(Number(e.target.value), startTime + 0.05))} />
                        </div>
                      </div>
                    )}

                    { previewUrl ? (
                      <div className="flex flex-col items-center gap-3">
                        {/* preview image or video depending on format */}
                        { outFormat === 'mp4' ? (
                          <video src={previewUrl} controls className="max-w-full max-h-96 rounded-md shadow" />
                        ) : (
                          <img src={previewUrl} alt="gif preview" className="max-w-full max-h-96 rounded-md shadow" />
                        )}

                        <div className="flex gap-2">
                          <a href={previewUrl} download={outFormat === 'mp4' ? 'output.mp4' : 'output.gif'} className="px-4 py-2 rounded-md border bg-white/10">Download</a>
                          <button onClick={() => { try{ URL.revokeObjectURL(previewUrl) }catch{}; setPreviewUrl(null); }} className="px-4 py-2 rounded-md border">Clear</button>
                        </div>
                      </div>
                    ) : (
                      !videoURL && <div className="text-center text-sm text-black/50 dark:text-white/40">No preview yet. Generate a GIF to preview it here.</div>
                    )}
                  </div>

                  <div className="bg-white/5 rounded-lg p-4">
                    <h3 className="text-sm font-medium mb-2">Quick Tips</h3>
                    <ul className="text-sm space-y-2 list-disc ml-4 text-black/60 dark:text-white/60">
                      <li>Single-image animation uses Ken-Burns style panning + subtle jitter (server-side).</li>
                      <li>For video inputs, keep clips short (GIFs grow quickly with length & resolution).</li>
                      <li>Use lower FPS and smaller dimensions for smaller file sizes. Prefer MP4 for longer clips.</li>
                    </ul>
                    <div className="mt-3">
                      <h4 className="text-xs font-medium">Backend contract</h4>
                      <p className="text-xs text-black/50 dark:text-white/40">POST <code>/api/generate</code> (sync for images) or <code>/api/generate_async</code> (video). Use <code>/api/job_status/&lt;id&gt;</code> to poll progress and <code>/api/job_output/&lt;id&gt;</code> to download results.</p>
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
