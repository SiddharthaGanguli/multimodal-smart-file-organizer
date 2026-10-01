export const OCR_TYPES = ["application/pdf", "image/jpeg", "image/png"];
export const OCR_LIMITS = Object.freeze({ maxBytes: 20 * 1024 * 1024, maxPages: 25,
  maxPixels: 12_000_000, maxSourcePixels: 40_000_000, maxText: 1_000_000,
  pageTimeoutMs: 45_000, jobTimeoutMs: 180_000 });
export const OCR_VERSION = "tesseract.js-7.0.0/eng-best-int-1.0.0/pdfjs-6.3.289/layout-2";

export function ocrError(code, message) { return Object.assign(new Error(message), { code }); }
export function cancelled() { return ocrError("cancelled", "Reading cancelled. You can try again."); }
export function checkAbort(signal) { if (signal?.aborted) throw signal.reason || cancelled(); }

// Race without leaving listeners or unhandled rejections behind. Resources are
// registered synchronously by adapters, so abort can terminate even a hung worker.
export function abortable(task, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || cancelled());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function selectPages(count, requested, limit = OCR_LIMITS.maxPages) {
  if (!Number.isSafeInteger(count) || count < 1) throw ocrError("invalidFile", "This file has no readable pages.");
  if (requested === undefined && count > limit) throw ocrError("pageLimit", `Read up to ${limit} pages at a time. Split this PDF into smaller files.`);
  const pages = requested === undefined ? Array.from({ length: count }, (_, i) => i + 1) : requested;
  if (!Array.isArray(pages) || !pages.length || pages.length > limit ||
      pages.some(n => !Number.isSafeInteger(n) || n < 1 || n > count)) {
    throw ocrError("invalidPages", `Choose between 1 and ${limit} valid page numbers.`);
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

function failure(error) {
  const known = ["cancelled", "timeout", "pageLimit", "invalidPages", "invalidFile", "unsupportedType",
    "sizeLimit", "pixelLimit", "textLimit", "password", "engineFailed", "renderFailed"];
  return known.includes(error?.code) ? { code: error.code, message: error.message } :
    { code: "invalidFile", message: "Could not read this file. Try a clearer image or a new PDF export." };
}

/** Platform-neutral orchestration; adapters own rasterization and worker lifetime. */
export async function runOcr(blob, { mimeType = blob?.type, pageNumbers, signal,
  onProgress = () => {}, adapters, limits = OCR_LIMITS } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort(cancelled());
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(() => controller.abort(ocrError("timeout", "Reading took too long. Try fewer pages or a smaller image.")), limits.jobTimeoutMs);
  const active = controller.signal;
  const disposers = [];
  const register = dispose => {
    if (active.aborted) { try { Promise.resolve(dispose()).catch(() => {}); } catch { /* best effort */ } }
    else disposers.push(dispose);
  };
  const cleanup = () => { for (const dispose of disposers.splice(0).reverse()) { try { Promise.resolve(dispose()).catch(() => {}); } catch { /* best effort */ } } };
  active.addEventListener("abort", cleanup, { once: true });
  const progress = value => { if (!active.aborted) onProgress(value); };
  const result = { schemaVersion: 1, method: "ocr", engineVersion: OCR_VERSION, language: "eng",
    status: "failed", startedAt: new Date().toISOString(), pageCount: null, requestedPages: [], pages: [], text: "" };
  let pageNumber;
  try {
    checkAbort(active);
    if (!OCR_TYPES.includes(mimeType)) throw ocrError("unsupportedType", "Read text from a PDF, JPG, JPEG, or PNG file.");
    if (!blob?.size || blob.size > limits.maxBytes) throw ocrError("sizeLimit", "Choose a non-empty file up to 20 MB.");
    progress({ stage: "opening", message: "Opening the document…" });
    const source = await abortable(adapters.open(blob, { mimeType, signal: active, register, limits }), active);
    result.pageCount = source.pageCount;
    result.requestedPages = selectPages(source.pageCount, pageNumbers, limits.maxPages);
    progress({ stage: "loading", message: "Preparing English text recognition…" });
    const engine = await abortable(adapters.engine({ signal: active, register, onProgress: value => progress({
      stage: "recognizing", pageNumber, total: result.requestedPages.length, ...value,
    }) }), active);
    let characters = 0;
    for (pageNumber of result.requestedPages) {
      checkAbort(active);
      const pageTimer = setTimeout(() => controller.abort(ocrError("timeout", `Page ${pageNumber} took too long. Try a smaller or clearer scan.`)), limits.pageTimeoutMs);
      let raster;
      try {
        progress({ stage: "rendering", pageNumber, total: result.requestedPages.length, message: `Reading page ${pageNumber}…` });
        raster = await abortable(source.render(pageNumber), active);
        const data = await abortable(engine.recognize(raster.bytes), active);
        checkAbort(active);
        const text = String(data.text || "").replaceAll("\u0000", "").trim();
        characters += text.length;
        if (characters > limits.maxText) throw ocrError("textLimit", "This document contains too much text. Split it into smaller files.");
        const confidence = Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, data.confidence)) : 0;
        result.pages.push({ pageNumber, text, confidence, width: raster.width, height: raster.height,
          status: !text ? "empty" : confidence < 60 ? "needs_review" : "complete" });
      } catch (error) {
        if (active.aborted || ["textLimit", "engineFailed"].includes(error?.code)) throw error;
        result.pages.push({ pageNumber, status: "failed", text: "", confidence: null, error: failure(error) });
      } finally { clearTimeout(pageTimer); raster?.close?.(); }
    }
    const hasText = result.pages.some(page => page.text);
    const hasFailures = result.pages.some(page => page.status === "failed");
    result.status = hasFailures ? (hasText ? "partial" : "failed") : !hasText ? "empty" :
      result.pages.some(page => page.status === "needs_review") ? "needs_review" : "complete";
  } catch (error) {
    const problem = failure(active.aborted ? active.reason : error);
    result.error = problem;
    if (problem.code === "cancelled") { result.status = "cancelled"; result.pages = []; }
    else {
      if (pageNumber && !result.pages.some(page => page.pageNumber === pageNumber)) {
        result.pages.push({ pageNumber, status: "failed", text: "", confidence: null, error: problem });
      }
      result.status = result.pages.some(page => page.text) ? "partial" : "failed";
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    active.removeEventListener("abort", cleanup);
    cleanup();
  }
  result.text = result.pages.filter(page => page.text).map(page => page.text).join("\n\n");
  result.completedAt = new Date().toISOString();
  return result;
}
