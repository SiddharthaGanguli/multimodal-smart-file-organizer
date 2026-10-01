import { validateFile } from "./validation.js";
import { canExtract } from "./extraction.js";

const FOLDER_TYPE = "application/vnd.google-apps.folder";
const MIME_EXTENSIONS = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/plain": [".txt"], "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"],
};

/** A journal is committed before Drive mutations; retries retain the same Drive ID. */
export class Library {
  constructor({ store, drive, auth, session, config, extractor, locks = globalThis.navigator?.locks }) {
    Object.assign(this, { store, drive, auth, session, config, extractor, locks });
  }

  async guard() { await this.auth.assert(this.session); }

  async locked(operation) {
    if (this.locks) return this.locks.request(`filewise:${this.session.id}`, operation);
    return operation();
  }

  async saveAsset(file, { sha256 = null, assetId = crypto.randomUUID(), source = "drive" } = {}) {
    await this.guard();
    if (!file?.id || file.trashed) throw new Error("This Drive file is no longer available.");
    if (!MIME_EXTENSIONS[file.mimeType]) {
      throw Object.assign(new Error("Choose a PDF, DOCX, TXT, JPG, JPEG, or PNG file."), { code: "unsupportedType" });
    }
    const previous = await this.store.get("assets", this.session.id, file.id);
    // A changed remote version invalidates the locally computed hash and derived state.
    const unchanged = Boolean(previous && file.modifiedTime && previous.modifiedTime === file.modifiedTime &&
      previous.mimeType === file.mimeType && previous.name === file.name &&
      previous.size === Number(file.size || 0) &&
      (!file.sha256Checksum || !previous.sha256 || file.sha256Checksum === previous.sha256));
    const value = {
      assetId: previous?.assetId || assetId, driveFileId: file.id,
      name: file.name, mimeType: file.mimeType, size: Number(file.size || 0),
      parents: file.parents || [], createdTime: file.createdTime, modifiedTime: file.modifiedTime,
      sha256: file.sha256Checksum || sha256 || (unchanged ? previous?.sha256 : null) || null,
      source: previous?.source || source,
      processingStatus: unchanged ? previous.processingStatus : "not_processed",
      extraction: unchanged ? previous.extraction || null : null,
      processingError: unchanged ? previous.processingError || null : null,
      registeredAt: previous?.registeredAt || new Date().toISOString(),
      // Construct the known Google URL; never navigate to an arbitrary metadata URL.
      driveUrl: `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`,
    };
    await this.guard();
    const saved = await this.store.put("assets", this.session.id, file.id, value);
    await this.guard();
    return saved;
  }

  async refresh() {
    return this.locked(() => this.refreshAssets());
  }

  async refreshAssets() {
    await this.guard();
    const assets = await this.store.list("assets", this.session.id);
    const visible = [];
    for (const asset of assets) {
      try {
        const file = await this.drive.getFile(asset.driveFileId);
        if (file.trashed) {
          await this.store.delete("assets", this.session.id, asset.driveFileId);
        } else {
          visible.push(await this.saveAsset(file));
        }
      } catch (error) {
        if (error.code === "unsupportedType") {
          await this.store.delete("assets", this.session.id, asset.driveFileId);
          continue;
        }
        if (error.status === 404 || (error.status === 403 &&
            ["insufficientFilePermissions", "forbidden", "http403"].includes(error.code))) {
          await this.store.delete("assets", this.session.id, asset.driveFileId);
        } else throw error;
      }
    }
    await this.guard();
    return visible.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  }

  async importFiles(ids) {
    return this.locked(async () => {
      await this.guard();
      let count = 0;
      for (const id of [...new Set(ids)]) {
        // Re-fetch canonical metadata using the active user's token; Picker messages are untrusted.
        await this.saveAsset(await this.drive.getFile(id));
        count++;
      }
      return count;
    });
  }

  async destination() {
    await this.guard();
    const record = await this.store.get("settings", this.session.id, "destination");
    if (!record) return null;
    const folder = await this.drive.getFile(record.driveFileId);
    await this.guard();
    if (folder.trashed || folder.mimeType !== FOLDER_TYPE || !folder.capabilities?.canAddChildren) {
      throw new Error("The upload folder is unavailable or read-only. Choose another folder.");
    }
    return { id: folder.id, name: folder.name };
  }

  async setDestination(id) {
    await this.guard();
    const folder = await this.drive.getFile(id);
    if (folder.trashed || folder.mimeType !== FOLDER_TYPE || !folder.capabilities?.canAddChildren) {
      throw new Error("Choose a Google Drive folder where you can add files.");
    }
    await this.guard();
    await this.store.put("settings", this.session.id, "destination", { driveFileId: id });
    await this.guard();
    return { id, name: folder.name };
  }

  async ensureDestination() {
    const existing = await this.destination();
    if (existing) return existing;
    const available = await this.drive.findFolders();
    let folder = available.find((item) => !item.trashed && item.capabilities?.canAddChildren);
    if (!folder) {
      let journal = await this.store.get("settings", this.session.id, "folderOperation");
      if (!journal) {
        const id = await this.drive.generateId();
        journal = await this.store.put("settings", this.session.id, "folderOperation", { driveFileId: id });
      }
      await this.guard();
      folder = await this.drive.createFolder({ id: journal.driveFileId, name: this.config.uploadFolderName });
    }
    await this.guard();
    await this.store.put("settings", this.session.id, "destination", { driveFileId: folder.id });
    await this.store.delete("settings", this.session.id, "folderOperation");
    await this.guard();
    return { id: folder.id, name: folder.name };
  }

  async upload(file, { operationId, onProgress = () => {} } = {}) {
    return this.locked(async () => {
      await this.guard();
      const valid = await validateFile(file, { maxBytes: this.config.maxUploadBytes });
      let operation = operationId && await this.store.get("operations", this.session.id, operationId);
      if (operationId && !operation) throw new Error("This upload does not belong to the connected account.");
      if (operation && (operation.sha256 !== valid.sha256 || operation.size !== valid.size)) {
        throw new Error("Select the same original file to resume this upload.");
      }
      if (!operation) {
        const folder = await this.ensureDestination();
        const driveFileId = await this.drive.generateId();
        const id = crypto.randomUUID();
        await this.guard();
        operation = await this.store.put("operations", this.session.id, id, {
          operationId: id, driveFileId, parentId: folder.id, assetId: crypto.randomUUID(),
          ...valid, status: "pending", createdAt: new Date().toISOString(),
        });
      }
      try {
        await this.guard();
        const remote = await this.drive.upload({
          id: operation.driveFileId, name: operation.name, mimeType: operation.mimeType,
          sha256: operation.sha256,
          parentId: operation.parentId, file, sessionUrl: operation.sessionUrl,
          onSession: async (sessionUrl) => {
            await this.guard();
            operation = await this.store.put("operations", this.session.id, operation.id,
              { ...operation, sessionUrl, status: "uploading", error: null });
          }, onProgress,
        });
        if (remote.id !== operation.driveFileId || remote.trashed ||
            Number(remote.size) !== operation.size || remote.mimeType !== operation.mimeType ||
            (remote.sha256Checksum && remote.sha256Checksum !== operation.sha256)) {
          throw new Error("Drive file differs from this upload. Review it in Drive before retrying.");
        }
        const asset = await this.saveAsset(remote, { ...operation, source: "upload" });
        await this.guard();
        await this.store.delete("operations", this.session.id, operation.id);
        await this.guard();
        return asset;
      } catch (error) {
        // Keep the journal even if the upload completed remotely but the local commit failed.
        // Recovery queries that same Drive ID; it never creates a replacement ID.
        await this.store.put("operations", this.session.id, operation.id,
          { ...operation, status: "needs_attention", error: error.message }).catch(() => {});
        throw error;
      }
    });
  }

  async recover() {
    return this.locked(async () => {
      const operations = await this.store.list("operations", this.session.id);
      for (const operation of operations) {
        await this.guard();
        try {
          const remote = await this.drive.getFile(operation.driveFileId);
          if (remote.trashed || Number(remote.size) !== operation.size ||
              (remote.sha256Checksum && remote.sha256Checksum !== operation.sha256)) {
            throw new Error("Drive file differs from the interrupted upload. Review it in Drive.");
          }
          await this.saveAsset(remote, { ...operation, source: "upload" });
          await this.store.delete("operations", this.session.id, operation.id);
        } catch (error) {
          if (![404, 403].includes(error.status)) {
            await this.store.put("operations", this.session.id, operation.id,
              { ...operation, status: "needs_attention", error: error.message });
          }
        }
      }
      await this.guard();
      return this.store.list("operations", this.session.id);
    });
  }

  async access(assetId, { download = false } = {}) {
    await this.guard();
    const assets = await this.store.list("assets", this.session.id);
    const asset = assets.find((record) => record.assetId === assetId);
    if (!asset) throw new Error("File not found in this account.");
    const remote = await this.drive.getFile(asset.driveFileId);
    if (remote.trashed) throw new Error("This file is in the Google Drive trash.");
    await this.guard();
    if (download) {
      if (!remote.capabilities?.canDownload) throw new Error("Google Drive does not permit downloading this file.");
      if (Number(remote.size) > this.config.maxUploadBytes) throw new Error("Open files larger than 20 MB in Google Drive.");
      const blob = await this.drive.download(remote.id);
      await this.guard();
      return { blob, name: remote.name };
    }
    return `https://drive.google.com/file/d/${encodeURIComponent(remote.id)}/view`;
  }

  async checkedAsset(assetId) {
    await this.guard();
    const assets = await this.store.list("assets", this.session.id);
    const asset = assets.find((record) => record.assetId === assetId);
    if (!asset) throw new Error("File not found in this account.");
    let remote;
    try {
      remote = await this.drive.getFile(asset.driveFileId);
    } catch (error) {
      if (error.status === 404 || (error.status === 403 &&
          ["insufficientFilePermissions", "forbidden", "http403"].includes(error.code))) {
        await this.store.delete("assets", this.session.id, asset.driveFileId);
      }
      throw error;
    }
    await this.guard();
    if (remote.trashed) {
      await this.store.delete("assets", this.session.id, asset.driveFileId);
      throw new Error("This file is in the Google Drive trash.");
    }
    let saved;
    try { saved = await this.saveAsset(remote); } catch (error) {
      if (error.code === "unsupportedType") await this.store.delete("assets", this.session.id, remote.id);
      throw error;
    }
    if (!remote.capabilities?.canDownload) {
      await this.store.put("assets", this.session.id, remote.id,
        { ...saved, extraction: null, processingStatus: "not_processed", processingError: null });
      throw new Error("Google Drive does not permit downloading or extracting this file.");
    }
    return saved;
  }

  async extractionResult(assetId) {
    return this.locked(async () => {
      const asset = await this.checkedAsset(assetId);
      if (!asset.extraction) throw new Error("No current extraction is available. Click Extract text first.");
      await this.guard();
      return asset.extraction;
    });
  }

  async extract(assetId) {
    return this.locked(async () => {
      const asset = await this.checkedAsset(assetId);
      if (!canExtract(asset)) throw new Error("Text extraction supports PDF, DOCX, and TXT files.");
      let result = null;
      let errorMessage = null;
      try {
        if (!this.extractor) throw new Error("The local extraction service is not configured.");
        if (asset.size > this.config.maxUploadBytes) throw new Error("Extraction supports files up to 20 MB.");
        const blob = await this.drive.download(asset.driveFileId);
        await this.guard();
        if (blob.size !== asset.size) throw new Error("The Drive file changed. Refresh and retry extraction.");
        if (asset.sha256) {
          const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
          if (sha256 !== asset.sha256) throw new Error("The Drive file changed. Refresh and retry extraction.");
        }
        await this.guard();
        result = await this.extractor.extract(blob, asset);
        await this.guard();
        errorMessage = result.error || null;
      } catch (error) {
        await this.guard();
        if (error.code === "authRequired" || error.code === "accountChanged" || error.status === 401) throw error;
        errorMessage = error.message || "Text extraction failed. Retry this file.";
      }
      // Revalidate permissions/version after processing; don't attach text to a newer file.
      const current = await this.checkedAsset(assetId);
      if (current.modifiedTime !== asset.modifiedTime || current.sha256 !== asset.sha256 ||
          current.mimeType !== asset.mimeType || current.name !== asset.name || current.size !== asset.size) {
        throw new Error("The Drive file changed during extraction. Retry extraction for the new version.");
      }
      await this.guard();
      const saved = await this.store.put("assets", this.session.id, asset.driveFileId, {
        ...current, extraction: result, processingStatus: result?.status || "failed", processingError: errorMessage,
      });
      await this.guard();
      return saved;
    });
  }
}
