const video = document.getElementById('video');
const captureCanvas = document.getElementById('canvas');
const captureCtx = captureCanvas.getContext('2d');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');
const swatch = document.getElementById('swatch');
const colorHex = document.getElementById('colorHex');
// resultToast removed per user request; showToast becomes a no-op
const retryCameraBtn = document.getElementById('retryCameraBtn');
const retryDetectorBtn = document.getElementById('retryDetectorBtn');
const verifyingEl = document.getElementById('verifying');
const progressBar = document.getElementById('progressBar');
const verifyingText = document.getElementById('verifyingText');
const bigResult = document.getElementById('bigResult');
const captureBtn = document.getElementById('captureBtn');

// Globals for face detection instance and last-onResults callback so we can instantiate
// the detector at any time (before/after camera start) and wire the callback.
let faceDetection = null;
let latestOnResults = null;

let mpCamera = null;
let lastFaceBox = null; // {x,y,w,h} in pixels
let faceDetectionAvailable = false;
let luminanceHistory = [];
const LUMA_SMOOTH = 5;
// Tone decision simplified: if smoothLuma < 0.5 => oscuro, otherwise claro
let streamActive = false;

function startCamera(hasFace = true) {
  faceDetectionAvailable = !!hasFace;
  // Prepare face detection results handler (only if available)
  const onResults = async (results) => {
    // Resize overlay to match video
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

    if (results.detections && results.detections.length > 0) {
      // Use the first detection (largest face) for color sampling
      const det = results.detections[0];
      const box = det.boundingBox;
      // boundingBox: {xCenter, yCenter, width, height} normalized
      const x = (box.xCenter - box.width / 2) * overlay.width;
      const y = (box.yCenter - box.height / 2) * overlay.height;
      const w = box.width * overlay.width;
      const h = box.height * overlay.height;

  // Draw rectangle
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.9)';
      overlayCtx.lineWidth = Math.max(2, overlay.width * 0.004);
      overlayCtx.strokeRect(x, y, w, h);

  // store last face box in pixel coords for use on capture
  lastFaceBox = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };

      // Sample color from the face region using hidden canvas
      captureCanvas.width = overlay.width;
      captureCanvas.height = overlay.height;
      captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

      // Shrink sampling area a bit to avoid background edges
      const padX = Math.max(0, Math.round(w * 0.15));
      const padY = Math.max(0, Math.round(h * 0.18));
      const sx = Math.max(0, Math.round(x + padX));
      const sy = Math.max(0, Math.round(y + padY));
      const sw = Math.max(1, Math.round(w - padX * 2));
      const sh = Math.max(1, Math.round(h - padY * 2));

      try {
        const img = captureCtx.getImageData(sx, sy, sw, sh);
        const avg = averageColor(img.data);
        // If region is mostly black (overlay or error), ignore
        if (avg.blackRatio && avg.blackRatio > 0.6) {
          // skip updating
        } else {
          const hex = rgbToHex(avg.r, avg.g, avg.b);
          swatch.style.background = hex;
          colorHex.textContent = hex.toUpperCase();
        }
      } catch (e) {
        console.warn('No se pudo leer la región de la cara:', e);
      }
    } else {
      colorHex.textContent = '--';
      lastFaceBox = null;
    }
  };

  // Attempt to instantiate the detector (if available). We use a helper so it can be
  // called before or after the camera starts.
  latestOnResults = onResults;
  tryInstantiateFaceDetection(latestOnResults);

  if (!faceDetectionAvailable) {
    console.warn('FaceDetection module not available; running without face detector');
    showToast('Detector facial no disponible. Alinea la cara y recarga la página.');
  }

  // Start a rendering loop that sends the video frame to MediaPipe when ready.
  let running = true;
  async function processLoop() {
    try {
      if (video && video.readyState >= 2) {
        // quick check: draw a tiny region and see if it's not all black
        try {
          captureCtx.drawImage(video, 0, 0, 4, 4);
          const small = captureCtx.getImageData(0, 0, 4, 4).data;
          let allBlack = true;
          for (let i = 0; i < small.length; i += 4) {
            if (small[i] !== 0 || small[i+1] !== 0 || small[i+2] !== 0) { allBlack = false; break; }
          }
          if (!allBlack && faceDetection) await faceDetection.send({ image: video });
        } catch (inner) {
          console.warn('small-sample check failed:', inner);
        }
      }
    } catch (err) {
      console.error('Error sending frame to faceDetection:', err);
    }
    if (running) requestAnimationFrame(processLoop);
  }

  // expose a stop function (in case we want to stop later)
  mpCamera = { stop: () => { running = false; } };
  requestAnimationFrame(processLoop);
  
  // update camera status every 800ms
  const statusEl = document.getElementById('cameraStatus');
  let statusInterval = setInterval(() => {
    if (!statusEl) return;
    if (video && video.srcObject) statusEl.textContent = 'Cámara: activa';
    else statusEl.textContent = 'Cámara: inactiva';
  }, 800);
  // clear on stop
  mpCamera._clearStatus = () => clearInterval(statusInterval);
}

// Try to locate and instantiate the MediaPipe FaceDetection class if possible.
// Accepts an optional onResults callback (the detection pipeline callback from startCamera).
function tryInstantiateFaceDetection(onResults) {
  // If already instantiated, wire the callback if provided and return true
  if (faceDetection) {
    try { if (onResults) faceDetection.onResults(onResults); } catch (e) {}
    return true;
  }

  // Find possible FaceDetection export locations
  let FaceDetectionClass = null;
  try {
    if (typeof faceDetectionModule !== 'undefined' && faceDetectionModule && faceDetectionModule.FaceDetection) FaceDetectionClass = faceDetectionModule.FaceDetection;
  } catch (e) {}
  try { if (!FaceDetectionClass && typeof FaceDetection !== 'undefined') FaceDetectionClass = FaceDetection; } catch (e) {}
  try { if (!FaceDetectionClass && window && window.FaceDetection) FaceDetectionClass = window.FaceDetection; } catch (e) {}
  try { if (!FaceDetectionClass && window && window.faceDetectionModule && window.faceDetectionModule.FaceDetection) FaceDetectionClass = window.faceDetectionModule.FaceDetection; } catch (e) {}

  if (!FaceDetectionClass) {
    // Not available yet
    return false;
  }

  try {
    faceDetection = new FaceDetectionClass({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}` });
    faceDetection.setOptions({ model: 'short', minDetectionConfidence: 0.6 });
    if (onResults) faceDetection.onResults(onResults);
    faceDetectionAvailable = true;
    return true;
  } catch (e) {
    console.warn('Failed to instantiate FaceDetection class:', e);
    faceDetectionAvailable = false;
    faceDetection = null;
    return false;
  }
}

function averageColor(data) {
  let r = 0, g = 0, b = 0, count = 0;
  let blackPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    const ri = data[i], gi = data[i + 1], bi = data[i + 2];
    r += ri;
    g += gi;
    b += bi;
    count++;
    if (ri === 0 && gi === 0 && bi === 0) blackPixels++;
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), blackRatio: blackPixels / count };
}

function rgbToHex(r, g, b) {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// Keep the old capture() for manual snapshots (optional)
function capturar() {
  // Ensure the camera stream is active; start on demand if not
  if (!streamActive) {
    startStream();
    // startStream will call startCamera once the video has frames; wait a short moment
    // and then continue only after video is playing
    // We return here so the user can press Capturar again once stream is active.
    return;
  }
  
  // (continúa la lógica de captura)
  // Ensure the canvas has a sensible size. If video not ready, use fallback size.
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  captureCanvas.width = vw;
  captureCanvas.height = vh;

  try {
    captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  } catch (err) {
    console.error('drawImage failed:', err);
    showToast('Error: cámara no disponible');
    return;
  }
  // Decide region: prefer last face box, else center crop
  let sx, sy, sw, sh;
  if (lastFaceBox) {
    sx = lastFaceBox.x + Math.round(lastFaceBox.w * 0.12);
    sy = lastFaceBox.y + Math.round(lastFaceBox.h * 0.14);
    sw = Math.max(8, Math.round(lastFaceBox.w * 0.76));
    sh = Math.max(8, Math.round(lastFaceBox.h * 0.7));
  } else {
    if (faceDetectionAvailable) {
      showToast('No se detectó rostro, intenta alinear la cara y vuelve a capturar');
      return;
    }
    // fallback: center crop if no detector available
    sw = Math.round(captureCanvas.width * 0.3);
    sh = Math.round(captureCanvas.height * 0.3);
    sx = Math.round((captureCanvas.width - sw) / 2);
    sy = Math.round((captureCanvas.height - sh) / 2);
  }

  try {
    // Guard against out-of-bounds coordinates
    sx = Math.max(0, Math.min(sx, captureCanvas.width - 1));
    sy = Math.max(0, Math.min(sy, captureCanvas.height - 1));
    sw = Math.max(1, Math.min(sw, captureCanvas.width - sx));
    sh = Math.max(1, Math.min(sh, captureCanvas.height - sy));

    const img = captureCtx.getImageData(sx, sy, sw, sh);
    const avg = averageColor(img.data);
    if (avg.blackRatio && avg.blackRatio > 0.6) {
      // likely invalid sample (black overlay); notify user
      showToast('Muestra inválida, intenta otra vez');
      return;
    }
    const hex = rgbToHex(avg.r, avg.g, avg.b);
    swatch.style.background = hex;
    colorHex.textContent = hex.toUpperCase();

    // Compute luminance (relative luminance formula)
    const luminance = (0.2126 * avg.r + 0.7152 * avg.g + 0.0722 * avg.b) / 255;
    // smoothing
    luminanceHistory.push(luminance);
    if (luminanceHistory.length > LUMA_SMOOTH) luminanceHistory.shift();
  const smoothLuma = luminanceHistory.reduce((a,b) => a + b, 0) / luminanceHistory.length;
  const tone = smoothLuma >= 0.5 ? 'Predomina tono claro' : 'Predomina tono oscuro';

    // Show verifying progress only after capture, animate for a longer period (8s) then show a large result
    if (verifyingEl && progressBar && verifyingText) {
      const VERIFY_MS = 8000; // 6-10s requested by user; default to 8s
      // Freeze last frame into a data URL so the big result can show the exact captured frame
      let lastFrameDataUrl = null;
      try {
        // draw current video into the captureCanvas in full size
        captureCanvas.width = vw;
        captureCanvas.height = vh;
        captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
        lastFrameDataUrl = captureCanvas.toDataURL('image/png');
      } catch (e) {
        console.warn('No se pudo capturar el último frame:', e);
      }

      // Stop camera tracks to 'turn off' the camera while verifying
      if (video && video.srcObject) {
        try {
          const tracks = video.srcObject.getTracks();
          tracks.forEach(t => t.stop());
          // clear srcObject so UI reflects camera off
          video.srcObject = null;
          // mark stream as inactive and stop processing loop if present
          streamActive = false;
          if (mpCamera && typeof mpCamera.stop === 'function') mpCamera.stop();
          if (mpCamera && mpCamera._clearStatus) mpCamera._clearStatus();
        } catch (e) { console.warn('Error stopping tracks:', e); }
      }

      // ensure verifying visible and reset bar
      verifyingEl.style.display = 'flex';
      progressBar.style.transition = 'none';
      progressBar.style.width = '0%';
      // force layout
      void progressBar.offsetWidth;
      // animate
      progressBar.style.transition = `width ${VERIFY_MS}ms linear`;
      progressBar.style.width = '100%';
      verifyingText.textContent = 'Verificando...';
      // hide retry and disable capture while verifying
      if (retryCameraBtn) retryCameraBtn.style.display = 'none';
      if (typeof captureBtn !== 'undefined' && captureBtn) captureBtn.disabled = true;

      setTimeout(() => {
        // end of verifying
        verifyingEl.style.display = 'none';
        progressBar.style.width = '0%';
        if (retryCameraBtn) retryCameraBtn.style.display = '';
        if (typeof captureBtn !== 'undefined' && captureBtn) captureBtn.disabled = false;
        // show a big, prominent result overlay using the frozen last frame
        showBigResult(tone, hex, avg, lastFrameDataUrl);
        // accessibility toast as well
        showToast(tone, 1800);
      }, VERIFY_MS);
    } else {
      // fallback: show as toast
      if (retryCameraBtn) retryCameraBtn.style.display = '';
      showToast(tone, 2200);
    }
  } catch (e) {
    console.error('Error capturando color:', e);
    showToast('Error al procesar imagen');
  }
}

// Start camera stream on demand. This does not run automatically on page load.
function startStream() {
  if (streamActive) return;
  navigator.mediaDevices.getUserMedia({ video: true })
    .then(stream => {
      video.srcObject = stream;
      streamActive = true;
      // try to play; if play is blocked, user will need to interact
      const p = video.play();
      p && p.catch(e => console.warn('video.play() blocked:', e));
      // initialize the face detector pipeline after stream has frames
      initAfterStream(true);
      // attempt to instantiate the detector immediately and schedule a retry
      tryInstantiateFaceDetection(latestOnResults);
      setTimeout(() => tryInstantiateFaceDetection(latestOnResults), 3000);
    })
    .catch(err => {
      console.error('No se pudo activar la cámara:', err);
    });
}

// Display a full-screen big result overlay for a few seconds
function showBigResult(text, hex, avg, frameDataUrl) {
  if (!bigResult) return;
  // Build a richer layout: frozen frame (if available), big swatch and label
  let inner = '';
  if (frameDataUrl) {
    inner += `<img src="${frameDataUrl}" alt="captured frame" style="max-width:420px; width:86%; height:auto; border-radius:12px; box-shadow:0 6px 20px rgba(0,0,0,0.4);">`;
  }
  if (hex) {
    inner += `<div style="margin-top:18px;display:flex;flex-direction:column;align-items:center;gap:10px;"><div style="background:${hex};width:140px;height:140px;border-radius:12px;border:6px solid rgba(255,255,255,0.18);"></div><div style="font-size:44px;font-weight:800;text-align:center;">${text}</div><div style="font-size:18px;opacity:0.92;">${hex.toUpperCase()}</div></div>`;
  } else {
    inner += `<div style="margin-top:18px;font-size:44px;font-weight:800;text-align:center;">${text}</div>`;
  }
  bigResult.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;">${inner}</div>`;
  bigResult.style.display = 'flex';
  // Add an explicit Aceptar button to close the overlay
  const acceptBtn = document.getElementById('bigResultAcceptBtn');
  if (acceptBtn) acceptBtn.remove();
  const btn = document.createElement('button');
  btn.id = 'bigResultAcceptBtn';
  btn.className = 'accept-btn';
  btn.textContent = 'Aceptar';
  btn.addEventListener('click', () => {
    bigResult.style.display = 'none';
    // clear content
    bigResult.innerHTML = '';
    // restart camera and detector
    startStream();
  });
  // append to the inner container
  const innerContainer = bigResult.firstElementChild || bigResult;
  innerContainer.appendChild(btn);
}

// Permite reintentar el acceso a la cámara
function reintentarCamara() {
  // Detener stream actual si existe
  if (video.srcObject) {
    let tracks = video.srcObject.getTracks();
    tracks.forEach(track => track.stop());
    video.srcObject = null;
  }
  // Reiniciar: pedir permisos otra vez y arrancar
  navigator.mediaDevices.getUserMedia({ video: true })
    .then(stream => {
      video.srcObject = stream;
      // try to play; if it fails, still start camera loop
      video.play().catch(e => console.warn('video.play() failed on retry:', e))
        .finally(() => {
          startCamera();
          showToast('Reintentando cámara...', 1200);
        });
    })
    .catch(err => {
      console.error('Reintentar getUserMedia error:', err);
      showToast('No se pudo acceder a la cámara');
    });
}

function showToast() {
  // intentionally no-op; toasts/messages removed
}

// Start when video is ready
video.addEventListener('loadedmetadata', () => {
  // resize overlay to initial size
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
});

// Load Face Detection module shim (MediaPipe provides faceDetectionModule)
// When using the npm build, faceDetectionModule is available globaly from the script.
// Start the camera after the scripts are loaded and the page is visible.
window.addEventListener('DOMContentLoaded', () => {
  // Try to dynamically load the face detection script (if not already loaded).
  function loadScript(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      let timer = setTimeout(() => {
        s.onerror = null;
        s.onload = null;
        reject(new Error('timeout'));
      }, timeout);
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = (e) => { clearTimeout(timer); reject(e); };
      document.head.appendChild(s);
    });
  }

  async function ensureFaceModule() {
    if (typeof faceDetectionModule !== 'undefined') return true;
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/face_detection.js', 3000);
      return typeof faceDetectionModule !== 'undefined';
    } catch (e) {
      console.warn('Failed to load face_detection script dynamically:', e);
      return false;
    }
  }

  // Try to ensure the face module is available and start the camera automatically.
  ensureFaceModule().then((hasFace) => {
    // Attempt to start camera silently on load; if autoplay is blocked, video.play() will
    // surface an error but the stream will still be set and detection will initialize when
    // frames are available.
    navigator.mediaDevices.getUserMedia({ video: true })
      .then(stream => {
        video.srcObject = stream;
        streamActive = true;
        const p = video.play();
        if (p && p.then) p.catch(e => console.warn('video.play() blocked, user interaction may be required:', e));
        // Initialize detector only after the video actually starts playing or has data
        initAfterStream(hasFace);
        // Also attempt to instantiate right away (in case module already loaded)
        tryInstantiateFaceDetection(latestOnResults);
        setTimeout(() => tryInstantiateFaceDetection(latestOnResults), 3000);
      })
      .catch(err => {
        // If auto-start fails, leave startStream as a fallback triggered by user capture
        console.error('getUserMedia auto-start error:', err);
      });

    if (retryDetectorBtn) {
      retryDetectorBtn.addEventListener('click', async () => {
        retryDetectorBtn.disabled = true;
        retryDetectorBtn.textContent = 'Reintentando...';
        const ok = await ensureFaceModule();
        if (ok) {
          // attempt to instantiate detector now
          tryInstantiateFaceDetection(latestOnResults);
          retryDetectorBtn.style.display = 'none';
        } else {
          retryDetectorBtn.disabled = false;
          retryDetectorBtn.textContent = 'Reintentar detección facial';
        }
      });
    }
  });
});

// Helper: call startCamera(hasFace) only after the video element has started producing frames
function initAfterStream(hasFace) {
  let started = false;
  function tryStart() {
    if (started) return;
    if (video && video.readyState >= 2) {
      started = true;
      startCamera(hasFace);
      video.removeEventListener('playing', tryStart);
      video.removeEventListener('loadeddata', tryStart);
    }
  }
  video.addEventListener('playing', tryStart);
  video.addEventListener('loadeddata', tryStart);
  // fallback: try after a short delay in case events don't fire
  setTimeout(tryStart, 600);
}

