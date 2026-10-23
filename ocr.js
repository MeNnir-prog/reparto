// ocr.js — OCR en el propio iPhone con Tesseract.js (WebAssembly). Las imágenes NO salen del teléfono.
// Solo se descarga el motor y el idioma español (una vez; luego quedan en caché).
import { detectGrid, analyzeTable } from './logic.js';

const TESS_VERSION = '5.1.1';
const CDN = {
  script: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/tesseract.min.js`,
  worker: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/worker.min.js`,
  core: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_VERSION}`,
  lang: undefined // por defecto de tesseract.js (jsDelivr, @tesseract.js-data/spa)
};
const LOCAL = {
  script: './vendor/tesseract/tesseract.min.js',
  worker: './vendor/tesseract/worker.min.js',
  core: './vendor/tesseract/core',
  lang: './vendor/tesseract/lang'
};

let workerP = null;
let source = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

async function hasLocal() {
  try { const r = await fetch(LOCAL.script, { method: 'HEAD', cache: 'no-store' }); return r.ok; } catch { return false; }
}

let progressCb = () => {};
export function ocrSource() { return source; }

async function getWorker() {
  if (workerP) return workerP;
  workerP = (async () => {
    const paths = (await hasLocal()) ? LOCAL : CDN;
    source = paths === LOCAL ? 'local' : 'cdn';
    if (!window.Tesseract) {
      try { await loadScript(paths.script); }
      catch (e) { throw new Error('Sin conexión: el motor de OCR se descarga la primera vez. Conectate a internet o usá “Pegar texto”.'); }
    }
    const opts = {
      workerPath: paths.worker, corePath: paths.core,
      logger: m => { if (m.status) progressCb(m); }
    };
    if (paths.lang) opts.langPath = paths.lang;
    const w = await window.Tesseract.createWorker('spa', 1, opts);
    await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1', user_defined_dpi: '300' });
    return w;
  })();
  workerP.catch(() => { workerP = null; });
  return workerP;
}

export async function terminateOcr() {
  if (!workerP) return;
  try { (await workerP).terminate(); } catch {}
  workerP = null;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo abrir la imagen')); };
    img.src = url;
  });
}

/** Escala la imagen y calcula su versión en gris. Devuelve { canvas (color, para recortes), gray, width, height } */
async function prepare(file) {
  const img = await loadImage(file);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  // Letras más grandes = mejor lectura (las capturas de iPhone suelen tener letra chica)
  let scale = Math.min(2.5, Math.max(1, 2400 / w0));
  const maxPx = 12e6; // límite de memoria en iPhone
  if (w0 * h0 * scale * scale > maxPx) scale = Math.sqrt(maxPx / (w0 * h0));
  const width = Math.round(w0 * scale), height = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  const d = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return { canvas, gray, width, height };
}

/**
 * Imagen para el OCR: texto negro sobre blanco aunque las filas estén pintadas de colores.
 * Cada celda de la grilla se divide por su propio color de fondo (la mediana de la celda);
 * sin grilla se usan bloques. Las líneas de la grilla desaparecen (quedan blancas).
 */
function cleanForOcr(gray, width, height, grid) {
  const edges = (lines, max, step) => {
    const e = lines.length >= 2 ? [0, ...lines.map(Math.round), max] : [];
    if (!e.length) for (let v = 0; v < max; v += step) e.push(v);
    if (e[e.length - 1] !== max) e.push(max);
    return [...new Set(e)].sort((a, b) => a - b);
  };
  const ys = edges(grid.h, height, 48), xs = edges(grid.v, width, 96);
  const out = new Uint8ClampedArray(width * height * 4);
  const hist = new Uint32Array(256);
  for (let yi = 0; yi < ys.length - 1; yi++) {
    for (let xi = 0; xi < xs.length - 1; xi++) {
      const y0 = ys[yi], y1 = ys[yi + 1], x0 = xs[xi], x1 = xs[xi + 1];
      hist.fill(0);
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[gray[y * width + x]]++; n++; }
      // Fondo: valor que deja el 60 % de los píxeles por debajo (el texto ocupa poco de la celda)
      let acc = 0, bg = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.6) { bg = v; break; } }
      bg = Math.max(bg, 40);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const p = y * width + x;
        const r = gray[p] / bg;
        const v = r >= 0.88 ? 255 : r <= 0.45 ? 0 : ((r - 0.45) / 0.43) * 255;
        const o = p * 4; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
      }
    }
  }
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(out, width, height), 0, 0);
  return c;
}

/** Recorte de una fila (para mostrar al lado del texto reconocido). */
export function cropRow(canvas, row, pad = 6) {
  const x0 = Math.max(0, Math.floor(row.x0 - pad)), y0 = Math.max(0, Math.floor(row.y0 - pad / 2));
  const x1 = Math.min(canvas.width, Math.ceil(row.x1 + pad)), y1 = Math.min(canvas.height, Math.ceil(row.y1 + pad / 2));
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return '';
  const s = Math.min(1, 640 / w);
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(canvas, x0, y0, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

/**
 * Segunda pasada: las celdas útiles que quedaron vacías o con lectura dudosa se vuelven a leer
 * de a una (modo "una línea"; el pedido solo con "#" y dígitos). Se queda con la mejor lectura.
 */
async function rereadCells(worker, clean, analysis, onProgress) {
  const useful = Object.entries(analysis.roles).filter(([, r]) => r !== 'none').map(([k, r]) => ({ ci: Number(k), role: r }));
  const data = analysis.rows.filter(b => !b.header);
  const jobs = [];
  for (const b of data) {
    const filled = Object.keys(b.byCol).length;
    if (filled < 2) continue; // fila vacía o basura
    for (const { ci, role } of useful) {
      const cell = b.byCol[ci];
      if (!cell || cell.conf < (role === 'address' ? 60 : 75)) jobs.push({ b, ci, role });
    }
  }
  if (!jobs.length) return;
  const PAD = 2;
  try {
    for (let i = 0; i < jobs.length; i++) {
      const { b, ci, role } = jobs[i];
      onProgress({ status: 'Revisando celdas dudosas', progress: i / jobs.length });
      const col = analysis.columns[ci];
      const left = Math.max(0, Math.round(col.x0) + PAD), top = Math.max(0, Math.round(b.y0) + PAD);
      const width = Math.min(clean.width - left, Math.round(col.x1 - col.x0) - 2 * PAD);
      const height = Math.min(clean.height - top, Math.round(b.y1 - b.y0) - 2 * PAD);
      if (width < 8 || height < 8) continue;
      // Con varias líneas (dirección larga) el modo "bloque" lee mejor que "una línea"
      const multi = height > analysis.lineHeight * 1.8;
      await worker.setParameters({
        tessedit_pageseg_mode: multi ? '6' : '7',
        tessedit_char_whitelist: role === 'order' ? '#0123456789' : ''
      });
      const { data: r } = await worker.recognize(clean, { rectangle: { left, top, width, height } });
      const text = (r.text || '').replace(/\s+/g, ' ').trim();
      const conf = r.confidence ?? 0;
      const old = b.byCol[ci];
      if (text && /[0-9A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(text) && (old ? conf > old.conf : conf >= 50)) {
        b.byCol[ci] = { text, conf, words: [], x0: left, x1: left + width, y0: top, y1: top + height };
      }
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  }
}

/**
 * Procesa una captura. onProgress({status, progress}).
 * Devuelve { analysis, canvas }.
 */
export async function recognizeImage(file, onProgress = () => {}) {
  progressCb = onProgress;
  onProgress({ status: 'Preparando imagen', progress: 0 });
  const prep = await prepare(file);
  const grid = detectGrid(prep.gray, prep.width, prep.height);
  let words, clean = null;
  if (typeof window.__OCR_TEST_PROVIDER__ === 'function') {
    // Solo para pruebas automáticas (no existe en uso normal)
    words = await window.__OCR_TEST_PROVIDER__(file, prep.width, prep.height);
  } else {
    clean = cleanForOcr(prep.gray, prep.width, prep.height, grid);
    onProgress({ status: 'Cargando OCR', progress: 0 });
    const worker = await getWorker();
    progressCb = onProgress;
    const { data } = await worker.recognize(clean);
    words = (data.words || []).map(w => ({
      text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1
    }));
  }
  const analysis = analyzeTable(words, grid, { width: prep.width, height: prep.height });
  if (clean) await rereadCells(await getWorker(), clean, analysis, onProgress);
  return { analysis, canvas: prep.canvas, grid, wordCount: words.length };
}
