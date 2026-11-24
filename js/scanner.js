// Nutrition label OCR, done entirely in the browser with Tesseract.js (loaded on first use).
import { parseNutritionLabel } from './label-parser.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let workerPromise;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Could not load the label reader. Are you online?'));
    document.head.appendChild(el);
  });
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker('eng', 1, {
        logger: (m) => m.status === 'recognizing text' && onProgress?.(m.progress),
      });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Downscale huge phone photos, grayscale and boost contrast — OCR is faster and more accurate.
async function preprocess(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 2000;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const c = Math.max(0, Math.min(255, (g - 128) * 1.6 + 128));
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export async function scanLabel(file, onProgress) {
  const [worker, image] = await Promise.all([getWorker(onProgress), preprocess(file)]);
  const { data } = await worker.recognize(image);
  return { ...parseNutritionLabel(data.text), rawText: data.text };
}
