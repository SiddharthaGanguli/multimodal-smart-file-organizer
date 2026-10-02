import { OCR_VERSION } from "../ocr/pipeline.js";
import { sourceVersion } from "../ocr/library.js";

export function searchParts(asset, ocr) {
  const extraction = asset.extraction;
  const parts = [];
  const covered = new Set();
  if (["extracted", "needs_ocr"].includes(extraction?.status)) {
    for (const part of extraction.parts || []) {
      if (!part.text?.trim() || part.needs_ocr) continue;
      parts.push({ text: part.text, location: part.location, page_number: part.page_number ?? null,
        method: "extraction", needs_review: false });
      if (part.page_number) covered.add(part.page_number);
    }
    if (!parts.length && extraction.text?.trim() && !extraction.ocr_pages?.length) {
      parts.push({ text: extraction.text, location: "document", page_number: null,
        method: "extraction", needs_review: false });
    }
  }
  if (ocr?.engineVersion === OCR_VERSION && ocr.sourceVersion === sourceVersion(asset)) {
    for (const page of ocr.pages || []) {
      if (!page.text?.trim() || covered.has(page.pageNumber) || !["complete", "needs_review"].includes(page.status)) continue;
      parts.push({ text: page.text, location: `page ${page.pageNumber}`, page_number: page.pageNumber,
        method: "ocr", needs_review: page.status !== "complete" || ocr.status === "partial" });
    }
  }
  if (!parts.length) throw new Error("Extract text or run OCR before adding this file to search.");
  if (parts.length > 1024 || parts.reduce((sum, part) => sum + part.text.length, 0) > 200000) {
    throw new Error("Search supports up to 200,000 text characters per file. Split this document first.");
  }
  return parts;
}

export const toSource = asset => ({ name: asset.name, mime_type: asset.mimeType, size: asset.size,
  modified_time: asset.modifiedTime, sha256: asset.sha256 || null });

export class SearchLibrary {
  constructor({ library, store, client }) { Object.assign(this, { library, store, client }); }
  get session() { return this.library.session; }
  guard() { return this.library.guard(); }
  get consentKey() { return `hosted-search:${this.client.origin}`; }

  async enabled() {
    const record = await this.store.get("settings", this.session.id, this.consentKey);
    await this.guard();
    return record?.enabled === true;
  }

  async requireConsent() {
    if (!await this.enabled()) throw new Error("Enable hosted search before uploading text or searching.");
  }

  async enable() {
    await this.guard();
    await this.store.put("settings", this.session.id, this.consentKey, { enabled: true });
    await this.guard();
  }

  async index(assetId, signal) {
    signal?.throwIfAborted();
    await this.requireConsent();
    const asset = await this.library.checkedAsset(assetId);
    signal?.throwIfAborted();
    const ocr = await this.store.get("ocrResults", this.session.id, asset.driveFileId);
    await this.guard();
    signal?.throwIfAborted();
    const result = await this.client.request("index", { file_id: asset.driveFileId,
      source: toSource(asset), parts: searchParts(asset, ocr) }, signal);
    await this.guard();
    return result;
  }

  async query(query, signal) {
    signal?.throwIfAborted();
    await this.requireConsent();
    const response = await this.client.request("query", { query, limit: 10 }, signal);
    signal?.throwIfAborted();
    if (!Array.isArray(response.results) || response.results.length > 20) throw new Error("Search returned invalid results.");
    const assets = await this.store.list("assets", this.session.id);
    await this.guard();
    const results = [];
    for (const hit of response.results) {
      signal?.throwIfAborted();
      const asset = assets.find(value => value.driveFileId === hit.file_id);
      // Only show files explicitly registered in this profile's library.
      if (!asset || typeof hit.snippet !== "string" || hit.snippet.length > 10000 ||
          typeof hit.location !== "string" || hit.location.length > 150) continue;
      let current;
      try { current = await this.library.checkedAsset(asset.assetId); } catch (error) {
        if (["accountChanged", "authRequired", "networkError", "invalidResponse"].includes(error.code) ||
            error.status === 401 || error.retryable) throw error;
        continue;
      }
      await this.guard();
      signal?.throwIfAborted();
      const source = toSource(current);
      if (!hit.source || ["name", "mime_type", "size", "modified_time"].some(key => hit.source[key] !== source[key]) ||
          (source.sha256 && hit.source.sha256 !== source.sha256)) continue;
      results.push({ ...hit, assetId: current.assetId, name: current.name });
    }
    await this.guard();
    return { ...response, results };
  }

  async forget(signal) {
    signal?.throwIfAborted();
    await this.requireConsent();
    await this.client.request("forget", {}, signal);
    await this.guard();
    await this.store.delete("settings", this.session.id, this.consentKey);
    await this.guard();
  }
}
