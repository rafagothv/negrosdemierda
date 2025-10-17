const video = document.getElementById('video');
const captureCanvas = document.getElementById('canvas');
const captureCtx = captureCanvas.getContext('2d');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');
const swatch = document.getElementById('swatch');
const colorHex = document.getElementById('colorHex');
const resultToast = document.getElementById('resultToast');
const resultTextEl = document.getElementById('resultText');

let mpCamera = null;
let lastFaceBox = null; // {x,y,w,h} in pixels

function startCamera() {
  // MediaPipe CameraUtils will handle the stream and call our onFrame
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
        const hex = rgbToHex(avg.r, avg.g, avg.b);
        swatch.style.background = hex;
        colorHex.textContent = hex.toUpperCase();
      } catch (e) {
        console.warn('No se pudo leer la región de la cara:', e);
      }
    } else {
      colorHex.textContent = '--';
      lastFaceBox = null;
    }
  };

  const faceDetection = new faceDetectionModule.FaceDetection({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`
  });

  faceDetection.setOptions({
    model: 'short',
    minDetectionConfidence: 0.6
  });

  faceDetection.onResults(onResults);

  // Hook camera
  mpCamera = new Camera(video, {
    onFrame: async () => {
      await faceDetection.send({image: video});
    },
    width: 640,
    height: 480
  });

  mpCamera.start();
}

function averageColor(data) {
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

function rgbToHex(r, g, b) {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// Keep the old capture() for manual snapshots (optional)
function capturar() {
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
    const hex = rgbToHex(avg.r, avg.g, avg.b);
    swatch.style.background = hex;
    colorHex.textContent = hex.toUpperCase();

    // Compute luminance (relative luminance formula)
    const luminance = (0.2126 * avg.r + 0.7152 * avg.g + 0.0722 * avg.b) / 255;
    // threshold: 0.5 default (tunable). Above -> claro, below -> oscuro
    const threshold = 0.5;
    const tone = luminance >= threshold ? 'Predomina tono claro' : 'Predomina tono oscuro';

    // show toast
    showToast(tone, 2200);
  } catch (e) {
    console.error('Error capturando color:', e);
    showToast('Error al procesar imagen');
  }
}

function showToast(text, duration = 2200) {
  if (!resultToast || !resultTextEl) return;
  resultTextEl.textContent = text;
  resultToast.hidden = false;
  resultToast.style.display = 'inline-flex';
  setTimeout(() => {
    resultToast.hidden = true;
    resultToast.style.display = '';
  }, duration);
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
  // Small delay to ensure video element is ready for Camera
  let started = false;
  function tryStartCamera() {
    if (!started) {
      started = true;
      startCamera();
      // fallback: if video not playing in 2s, use getUserMedia
      setTimeout(() => {
        if (!video.srcObject || video.readyState < 2) {
          navigator.mediaDevices.getUserMedia({ video: true })
            .then(stream => {
              video.srcObject = stream;
            })
            .catch(err => {
              showToast('No se pudo acceder a la cámara');
              console.error('getUserMedia error:', err);
            });
        }
      }, 2000);
    }
  }
  tryStartCamera();
});

