// The companion only receives document bytes. Google credentials stay in the extension.
const TYPES = {
  "text/plain": "txt",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const STATUSES = new Set(["extracted", "empty", "needs_ocr", "failed"]);

export function canExtract(asset) { return Object.hasOwn(TYPES, asset?.mimeType || ""); }

export class LocalExtractor {
  constructor({ baseUrl = "http://127.0.0.1:8000", fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    // Never allow a configuration change to send private documents to a remote host.
    if (baseUrl !== "http://127.0.0.1:8000") throw new Error("Extraction must use the local Filewise service.");
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async extract(blob, asset) {
    if (!canExtract(asset)) throw new Error("Text extraction supports PDF, DOCX, and TXT files. Images need OCR in a later milestone.");
    if (blob.size > 20 * 1024 * 1024) throw new Error("Extraction supports files up to 20 MB.");
    const type = TYPES[asset.mimeType];
    let filename = String(asset.name || "document").replace(/[<>:"\\/|?*\x00-\x1f]/g, "_").slice(0, 240);
    if (!filename.toLowerCase().endsWith(`.${type}`)) filename += `.${type}`;
    const url = new URL("/extractions", this.baseUrl);
    url.searchParams.set("filename", filename);
    let response;
    try {
      response = await this.fetchImpl(url.href, {
        method: "POST", body: blob, credentials: "omit", redirect: "error",
        headers: { "Content-Type": "application/octet-stream", "X-Filewise-Request": "extraction-v1" },
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      throw new Error(error.name === "TimeoutError" || error.name === "AbortError"
        ? "Text extraction timed out. Retry extraction for this file."
        : "Start the local extraction service (see Setup & help), then click Retry extraction. Your file is saved in Drive.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(typeof body?.detail === "string" ? body.detail : `Extraction service returned HTTP ${response.status}.`);
    }
    const result = await response.json();
    if (result?.schema_version !== 1 || !STATUSES.has(result.status) || typeof result.text !== "string" ||
        result.file_type !== type || !Array.isArray(result.parts) || !Array.isArray(result.ocr_pages)) {
      throw new Error("The extraction service returned an invalid result. Check that it is the current Filewise service.");
    }
    return { ...result, source_name: asset.name };
  }
}
