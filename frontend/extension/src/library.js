import { validateFile } from "./validation.js";

const FOLDER_TYPE = "application/vnd.google-apps.folder";
const MIME_EXTENSIONS = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/plain": [".txt"], "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"],
};

/** A journal is committed before Drive mutations; retries retain the same Drive ID. */
export class Library {
  constructor({ store, drive, auth, session, config, locks = globalThis.navigator?.locks }) {
    Object.assign(this, { store, drive, auth, session, config, locks });
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
    const unchanged = previous?.modifiedTime === file.modifiedTime;
    const value = {
      assetId: previous?.assetId || assetId, driveFileId: file.id,
      name: file.name, mimeType: file.mimeType, size: Number(file.size || 0),
      parents: file.parents || [], createdTime: file.createdTime, modifiedTime: file.modifiedTime,
      sha256: file.sha256Checksum || sha256 || (unchanged ? previous?.sha256 : null) || null,
      source: previous?.source || source, processingStatus: "not_processed",
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
        if (error.code === "unsupportedType") continue;
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
}
