import { OCR_TYPES, OCR_LIMITS, OCR_VERSION, cancelled, checkAbort, abortable } from "./pipeline.js";

// Kept separate from extraction/processingStatus so issue #3 can use its own store.
export function sourceVersion(file) {
  return JSON.stringify([file.driveFileId || file.id, file.mimeType, Number(file.size), file.modifiedTime,
    file.sha256Checksum || file.sha256 || null]);
}

export class OcrLibrary {
  constructor({ store, drive, auth, session, recognize, locks = globalThis.navigator?.locks }) {
    Object.assign(this, { store, drive, auth, session, recognize, locks });
  }

  guard() { return this.auth.assert(this.session); }

  async summaries(assets) {
    await this.guard();
    const versions = new Map(assets.map(asset => [asset.driveFileId, asset]));
    const summaries = Object.create(null);
    for (const record of await this.store.list("ocrResults", this.session.id)) {
      const asset = versions.get(record.id);
      if (!asset || sourceVersion(asset) !== record.sourceVersion || record.engineVersion !== OCR_VERSION) {
        await this.store.delete("ocrResults", this.session.id, record.id);
      } else summaries[asset.assetId] = record.status;
    }
    await this.guard();
    return summaries;
  }

  async canonical(id) {
    await this.guard();
    try {
      const file = await this.drive.getFile(id);
      await this.guard();
      if (file.trashed || !file.capabilities?.canDownload) throw new Error("Drive no longer allows reading this file. Check its sharing permissions.");
      if (!OCR_TYPES.includes(file.mimeType)) throw new Error("Choose a PDF, JPG, JPEG, or PNG file to read text.");
      if (!Number(file.size) || Number(file.size) > OCR_LIMITS.maxBytes) throw new Error("Choose a non-empty file up to 20 MB.");
      return file;
    } catch (error) {
      // A network failure also hides the result until permission can be verified.
      if (error.code !== "accountChanged") await this.store.delete("ocrResults", this.session.id, id);
      throw error;
    }
  }

  async read(assetId, { force = false, signal, onProgress } = {}) {
    await this.guard();
    const assets = await this.store.list("assets", this.session.id);
    const asset = assets.find(item => item.assetId === assetId);
    if (!asset) throw new Error("This file is no longer in the connected account's library.");
    const operation = async () => {
      checkAbort(signal);
      const file = await this.canonical(asset.driveFileId);
      // Drive may omit its checksum; only use our hash if the source version matches.
      const hash = file.sha256Checksum || (file.modifiedTime === asset.modifiedTime ? asset.sha256 : null);
      const version = sourceVersion({ ...file, sha256: hash });
      const cached = await this.store.get("ocrResults", this.session.id, file.id);
      await this.guard(); checkAbort(signal);
      if (!force && cached?.sourceVersion === version && cached.engineVersion === OCR_VERSION) return cached;
      await this.store.delete("ocrResults", this.session.id, file.id);
      onProgress?.({ stage: "downloading", message: "Downloading the original from Drive…" });
      const controller = new AbortController();
      const stop = () => controller.abort(cancelled());
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        const blob = await abortable(this.drive.download(file.id), controller.signal);
        await this.guard(); checkAbort(controller.signal);
        if (blob.size !== Number(file.size)) throw new Error("The Drive file changed during download. Refresh and try again.");
        if (hash) {
          const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (actual !== hash) throw new Error("The Drive file changed during download. Refresh and try again.");
        }
        const result = await this.recognize(blob, { mimeType: file.mimeType, signal: controller.signal, onProgress });
        await this.guard();
        const latest = await this.canonical(file.id);
        if (sourceVersion({ ...latest, sha256: latest.modifiedTime === file.modifiedTime ? hash : null }) !== version) {
          throw new Error("The Drive file changed while reading. Refresh and try again.");
        }
        const save = async () => {
          await this.guard();
          // Lock with account changes so an old session cannot commit afterward.
          const saved = await this.store.put("ocrResults", this.session.id, file.id,
            { ...result, assetId, driveFileId: file.id, sourceVersion: version });
          await this.guard();
          return saved;
        };
        return this.auth.sessionLock ? await this.auth.sessionLock(save) : await save();
      } finally { signal?.removeEventListener("abort", stop); }
    };
    return this.locks ? this.locks.request(`filewise:ocr:${this.session.id}:${asset.driveFileId}`,
      { ...(signal ? { signal } : {}) }, operation) : operation();
  }
}
