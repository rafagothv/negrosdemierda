const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

navigator.mediaDevices.getUserMedia({ video: true })
  .then(stream => video.srcObject = stream)
  .catch(err => console.error("Error al acceder a la cámara:", err));

function capturar() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);
  detectarColorPromedio();
}

function detectarColorPromedio() {
  const zona = ctx.getImageData(
    canvas.width / 2 - 50,
    canvas.height / 2 - 50,
    100, 100
  );

  let r = 0, g = 0, b = 0;
  for (let i = 0; i < zona.data.length; i += 4) {
    r += zona.data[i];
    g += zona.data[i + 1];
    b += zona.data[i + 2];
  }

  const total = zona.data.length / 4;
  r = Math.round(r / total);
  g = Math.round(g / total);
  b = Math.round(b / total);

  const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  console.log("Color promedio:", hex);
  document.body.style.backgroundColor = hex;
}

