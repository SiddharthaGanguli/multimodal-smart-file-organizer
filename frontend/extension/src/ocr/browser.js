import { runOcr, checkAbort, ocrError, abortable } from "./pipeline.js";

const vendor = path => new URL(`../../vendor/${path}`, import.meta.url).href;

// Pin the Tesseract.js 7 worker protocol here. Owning its Worker directly lets us
// terminate it during initialization, crashes, or recognition (including hangs).
async function engine({ signal, register, onProgress }) {
  const worker = new Worker(vendor("tesseract/worker.min.js"));
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  const engineFailure = () => ocrError("engineFailed", "Text recognition stopped unexpectedly. Try again with a smaller image.");
  const close = () => {
    closed = true;
    worker.terminate();
    for (const job of pending.values()) job.reject(engineFailure());
    pending.clear();
  };
  register(close);
  worker.onerror = event => { event.preventDefault(); close(); };
  worker.onmessageerror = close;
  worker.onmessage = ({ data }) => {
    if (data.status === "progress") {
      onProgress({ fraction: Math.max(0, Math.min(1, Number(data.data?.progress) || 0)) });
      return;
    }
    const job = pending.get(data.jobId);
    if (!job) return;
    pending.delete(data.jobId);
    if (data.status === "resolve") job.resolve(data.data);
    else job.reject(engineFailure());
  };
  const send = (action, payload) => {
    checkAbort(signal);
    if (closed) return Promise.reject(engineFailure());
    const jobId = `filewise-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(jobId, { resolve, reject });
      worker.postMessage({ workerId: "filewise-ocr", jobId, action, payload });
    });
  };
  await send("load", { options: { lstmOnly: true, corePath: vendor("tesseract-core/"), logging: false } });
  await send("loadLanguage", { langs: "eng", options: { langPath: vendor("tessdata/"), gzip: true, cacheMethod: "none", lstmOnly: true } });
  await send("initialize", { langs: "eng", oem: 1, config: {} });
  // The API defaults to a single text block. Whole document pages need automatic
  // layout segmentation, otherwise parallel columns get joined line by line.
  await send("setParameters", { params: { tessedit_pageseg_mode: "3" } });
  return { recognize: image => send("recognize", { image, options: { rotateAuto: true }, output: { text: true, blocks: false, hocr: false, tsv: false } }) };
}

export function imageDimensions(bytes, mimeType) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png" && bytes.length >= 24 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let i = 2;
    while (i + 3 < bytes.length) {
      if (bytes[i++] !== 255) break;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 0xda || marker === 0xd9 || i + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { width: view.getUint16(i + 5), height: view.getUint16(i + 3) };
      }
      i += length;
    }
  }
  throw ocrError("invalidFile", "This image is damaged or is not a supported JPG or PNG.");
}

function dimensions(width, height, maxPixels, scale = 1) {
  if (![width, height].every(n => Number.isFinite(n) && n > 0) || width / height > 100 || height / width > 100) {
    throw ocrError("invalidFile", "The page has invalid dimensions.");
  }
  const ratio = Math.min(scale, Math.sqrt(maxPixels / (width * height)), 8192 / width, 8192 / height);
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), ratio };
}

async function rasterBytes(canvas, signal) {
  const blob = await abortable(new Promise(resolve => canvas.toBlob(resolve, "image/png")), signal);
  if (!blob) throw ocrError("renderFailed", "Could not render this page as an image.");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
}

async function open(blob, { mimeType, signal, register, limits }) {
  if (mimeType !== "application/pdf") {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const size = imageDimensions(bytes, mimeType);
    if (size.width * size.height > limits.maxSourcePixels) throw ocrError("pixelLimit", "This photo is too large to decode safely. Resize it to 40 megapixels or less.");
    return { pageCount: 1, async render() {
      let bitmap;
      const canvas = document.createElement("canvas");
      try {
        // Also close late decode completions after cancellation.
        const decoding = createImageBitmap(blob);
        decoding.then(value => { if (signal.aborted) value.close(); }, () => {});
        bitmap = await abortable(decoding, signal);
        const target = dimensions(bitmap.width, bitmap.height, limits.maxPixels, Math.min(2, 1800 / bitmap.width));
        canvas.width = target.width; canvas.height = target.height;
        const context = canvas.getContext("2d");
        context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return await rasterBytes(canvas, signal);
      } finally { bitmap?.close(); canvas.width = canvas.height = 0; }
    } };
  }
  const pdfjs = await import("../../vendor/pdfjs/pdf.min.mjs");
  checkAbort(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = vendor("pdfjs/pdf.worker.min.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()),
    isEvalSupported: false, enableXfa: false, stopAtErrors: true, useSystemFonts: false,
    maxImageSize: limits.maxSourcePixels, canvasMaxAreaInBytes: limits.maxPixels * 4,
    cMapUrl: vendor("pdfjs/cmaps/"), cMapPacked: true,
    standardFontDataUrl: vendor("pdfjs/standard_fonts/"), wasmUrl: vendor("pdfjs/wasm/") });
  register(() => task.destroy());
  let pdf;
  try { pdf = await task.promise; } catch (error) {
    if (error.name === "PasswordException") throw ocrError("password", "This PDF is password protected. Upload an unlocked copy to read its text.");
    throw error;
  }
  return { pageCount: pdf.numPages, async render(pageNumber) {
    const page = await pdf.getPage(pageNumber);
    const canvas = document.createElement("canvas");
    let render;
    const abort = () => render?.cancel();
    signal.addEventListener("abort", abort, { once: true });
    try {
      checkAbort(signal);
      const viewport = page.getViewport({ scale: 1 });
      // PDF units are 1/72 inch. Aim for 300 DPI while retaining the pixel caps.
      const target = dimensions(viewport.width, viewport.height, limits.maxPixels, 300 / 72);
      canvas.width = target.width; canvas.height = target.height;
      render = page.render({ canvasContext: canvas.getContext("2d"), viewport: page.getViewport({ scale: target.ratio }), background: "white" });
      await render.promise;
      return await rasterBytes(canvas, signal);
    } finally {
      signal.removeEventListener("abort", abort);
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } };
}

/** No network OCR service: source bytes, rendering, and recognition stay on device. */
export function recognize(blob, options = {}) { return runOcr(blob, { ...options, adapters: { open, engine } }); }
