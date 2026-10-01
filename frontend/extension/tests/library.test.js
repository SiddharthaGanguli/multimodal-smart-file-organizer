import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Library } from "../src/library.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ACCOUNT_A = { id: "account-a", epoch: "session-a" };
const ACCOUNT_B = { id: "account-b", epoch: "session-b" };
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const file = (text = "preserve my original", name = "original.txt") => new File([text], name, { type: "text/plain" });
const driveError = (status, details = {}) => Object.assign(new Error(`Drive HTTP ${status}`), { status, code: `http${status}`, retryable: false, ...details });

class MemoryStore {
  constructor() {
    this.records = new Map();
    this.writes = [];
    this.failNextPut = null;
  }

  key(name, accountId, id) { return JSON.stringify([name, accountId, id]); }
  async put(name, accountId, id, value) {
    if (!accountId || !id) throw new Error("Account and record ID required");
    if (this.failNextPut === name) {
      this.failNextPut = null;
      throw new Error("Injected metadata commit failure");
    }
    const record = { ...clone(value), accountId, id };
    this.records.set(this.key(name, accountId, id), record);
    this.writes.push({ name, accountId, id, value: clone(record) });
    if (this.onPut) await this.onPut(name, accountId, id);
    return clone(record);
  }
  async get(name, accountId, id) { return clone(this.records.get(this.key(name, accountId, id))); }
  async list(name, accountId) {
    return [...this.records.entries()]
      .filter(([key]) => {
        const parts = JSON.parse(key);
        return parts[0] === name && parts[1] === accountId;
      })
      .map(([, value]) => clone(value));
  }
  async delete(name, accountId, id) { this.records.delete(this.key(name, accountId, id)); }
}

class FakeDrive {
  constructor() {
    this.remote = new Map();
    this.bytes = new Map();
    this.getErrors = new Map();
    this.generated = [];
    this.uploads = [];
    this.folders = [];
    this.downloads = [];
    this.gets = [];
    this.nextUploadError = null;
    this.nextFolderError = null;
  }
  addFile(id, text = "remote original", extras = {}) {
    const bytes = Buffer.from(text);
    const metadata = {
      id, name: `${id}.txt`, mimeType: "text/plain", size: String(bytes.length),
      parents: ["chosen-folder"], createdTime: "2026-01-01T00:00:00.000Z",
      modifiedTime: "2026-01-02T00:00:00.000Z", sha256Checksum: hash(bytes),
      trashed: false, capabilities: { canDownload: true }, ...extras,
    };
    this.remote.set(id, metadata);
    this.bytes.set(id, bytes);
    return clone(metadata);
  }
  addFolder(id = "chosen-folder") {
    const metadata = { id, name: "Private originals", mimeType: FOLDER_TYPE, trashed: false, capabilities: { canAddChildren: true } };
    this.remote.set(id, metadata);
    return metadata;
  }
  async getFile(id) {
    this.gets.push(id);
    if (this.onGet) await this.onGet(id);
    if (this.getErrors.has(id)) throw this.getErrors.get(id);
    if (!this.remote.has(id)) throw driveError(404);
    return clone(this.remote.get(id));
  }
  async generateId() {
    const id = `generated-${this.generated.length + 1}`;
    this.generated.push(id);
    return id;
  }
  async findFolders() {
    return this.folderResults ?? [...this.remote.values()].filter((entry) => entry.mimeType === FOLDER_TYPE);
  }
  async createFolder({ id, name }) {
    this.folders.push(id);
    if (!this.remote.has(id)) this.remote.set(id, { ...this.addFolder(id), name });
    if (this.nextFolderError) {
      const error = this.nextFolderError;
      this.nextFolderError = null;
      throw error;
    }
    return clone(this.remote.get(id));
  }
  async upload({ id, name, mimeType, parentId, file: original, onSession, onProgress }) {
    this.uploads.push(id);
    if (this.remote.has(id)) return clone(this.remote.get(id));
    await onSession(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`);
    if (this.nextUploadError) {
      const error = this.nextUploadError;
      this.nextUploadError = null;
      throw error;
    }
    const bytes = Buffer.from(await original.arrayBuffer());
    const metadata = this.addFile(id, bytes, { name, mimeType, parents: [parentId] });
    if (this.onUploaded) await this.onUploaded(id);
    onProgress(1);
    return metadata;
  }
  async download(id) {
    this.downloads.push(id);
    if (this.onDownload) await this.onDownload(id);
    if (!this.bytes.has(id)) throw driveError(404);
    return new Blob([this.bytes.get(id)], { type: this.remote.get(id).mimeType });
  }
}

async function fixture({ destination = true } = {}) {
  const store = new MemoryStore();
  const drive = new FakeDrive();
  const auth = {
    active: clone(ACCOUNT_A),
    async assert(session) {
      if (!session || this.active?.id !== session.id || this.active.epoch !== session.epoch) {
        throw new Error("The connected account changed. Reconnect before continuing.");
      }
    },
  };
  const config = { maxUploadBytes: 20 * 1024 * 1024, uploadFolderName: "Filewise originals" };
  const makeLibrary = (session = ACCOUNT_A) => new Library({ store, drive, auth, session, config, locks: null });
  const library = makeLibrary();
  if (destination) {
    drive.addFolder();
    await store.put("settings", ACCOUNT_A.id, "destination", { driveFileId: "chosen-folder" });
  }
  return { store, drive, auth, library, makeLibrary };
}

test("upload preserves original bytes and commits account-scoped metadata only", async () => {
  const { store, drive, library } = await fixture();
  const original = file("hello\nनमस्ते\né");
  const progress = [];
  const asset = await library.upload(original, { onProgress: (value) => progress.push(value) });
  assert.deepEqual(drive.bytes.get(asset.driveFileId), Buffer.from(await original.arrayBuffer()));
  assert.equal(asset.sha256, hash(drive.bytes.get(asset.driveFileId)));
  assert.equal(asset.name, original.name);
  assert.equal(asset.size, original.size);
  assert.equal(asset.accountId, ACCOUNT_A.id);
  assert.equal(asset.source, "upload");
  assert.equal(asset.processingStatus, "not_processed");
  assert.deepEqual(asset.parents, ["chosen-folder"]);
  assert.equal(asset.driveUrl, `https://drive.google.com/file/d/${asset.driveFileId}/view`);
  assert.equal(progress.at(-1), 1);
  assert.equal((await store.list("operations", ACCOUNT_A.id)).length, 0);
  assert.equal((await store.list("assets", ACCOUNT_B.id)).length, 0);
  assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 1);
  for (const entry of store.writes) {
    assert.equal(Object.values(entry.value).some((value) => value instanceof Blob || value instanceof ArrayBuffer), false);
    assert.equal("file" in entry.value || "content" in entry.value, false);
  }
});

test("remote success plus failed local commit retains its journal and recovers the same Drive ID", async () => {
  const { store, drive, library } = await fixture();
  store.failNextPut = "assets";
  await assert.rejects(library.upload(file()), /metadata commit failure/);
  const [pending] = await store.list("operations", ACCOUNT_A.id);
  assert.equal(pending.status, "needs_attention");
  assert.equal(drive.remote.has(pending.driveFileId), true);
  assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 0);
  assert.deepEqual(await library.recover(), []);
  const [asset] = await store.list("assets", ACCOUNT_A.id);
  assert.equal(asset.driveFileId, pending.driveFileId);
  assert.equal(asset.assetId, pending.assetId);
  assert.equal(asset.sha256, pending.sha256);
  assert.equal(drive.uploads.length, 1);
  assert.equal(drive.generated.length, 1);
});

test("metadata journal commit failure prevents a remote upload", async () => {
  const { store, drive, library } = await fixture();
  store.failNextPut = "operations";
  await assert.rejects(library.upload(file()), /metadata commit failure/);
  assert.equal(drive.uploads.length, 0);
  assert.equal(drive.bytes.size, 0);
});

test("resume rejects different same-size bytes, then retries the original using its existing ID", async () => {
  const { store, drive, library } = await fixture();
  drive.nextUploadError = new Error("Network interrupted");
  await assert.rejects(library.upload(file("original")), /Network interrupted/);
  const [pending] = await store.list("operations", ACCOUNT_A.id);
  await assert.rejects(library.upload(file("modified"), { operationId: pending.operationId }), /same original file/);
  assert.equal(drive.uploads.length, 1);
  const asset = await library.upload(file("original"), { operationId: pending.operationId });
  assert.equal(asset.driveFileId, pending.driveFileId);
  assert.deepEqual(drive.uploads, [pending.driveFileId, pending.driveFileId]);
  assert.equal(drive.generated.length, 1);
  assert.equal((await store.list("operations", ACCOUNT_A.id)).length, 0);
});

test("a resumable upload operation cannot be used by another account", async () => {
  const { store, drive, auth, library, makeLibrary } = await fixture();
  drive.nextUploadError = new Error("Offline");
  await assert.rejects(library.upload(file()), /Offline/);
  const [pending] = await store.list("operations", ACCOUNT_A.id);
  auth.active = clone(ACCOUNT_B);
  await assert.rejects(makeLibrary(ACCOUNT_B).upload(file(), { operationId: pending.operationId }), /does not belong/);
  assert.equal(drive.uploads.length, 1);
  assert.equal((await store.list("operations", ACCOUNT_A.id)).length, 1);
});

test("folder creation timeout retains its generated ID even while Drive listing has not caught up", async () => {
  const { store, drive, library } = await fixture({ destination: false });
  drive.folderResults = [];
  drive.nextFolderError = new Error("Folder creation timed out");
  await assert.rejects(library.ensureDestination(), /timed out/);
  const journal = await store.get("settings", ACCOUNT_A.id, "folderOperation");
  assert.ok(journal.driveFileId);
  assert.equal(await store.get("settings", ACCOUNT_A.id, "destination"), undefined);
  const destination = await library.ensureDestination();
  assert.equal(destination.id, journal.driveFileId);
  assert.deepEqual(drive.folders, [journal.driveFileId, journal.driveFileId]);
  assert.equal(drive.generated.length, 1);
  assert.equal(await store.get("settings", ACCOUNT_A.id, "folderOperation"), undefined);
});

test("import fetches canonical metadata, deduplicates references, and never uploads or downloads originals", async () => {
  const { store, drive, library } = await fixture();
  drive.addFile("selected-file", "already in Drive", { name: "canonical.txt", webViewLink: "https://untrusted.example/" });
  assert.equal(await library.importFiles(["selected-file", "selected-file"]), 1);
  const [asset] = await store.list("assets", ACCOUNT_A.id);
  assert.equal(asset.name, "canonical.txt");
  assert.equal(asset.source, "drive");
  assert.equal(asset.driveUrl, "https://drive.google.com/file/d/selected-file/view");
  assert.deepEqual(drive.gets, ["selected-file"]);
  assert.equal(drive.uploads.length, 0);
  assert.equal(drive.downloads.length, 0);
  assert.equal(drive.generated.length, 0);
});

test("account switch while fetching import metadata cannot register files under either account", async () => {
  const { store, drive, auth, library } = await fixture();
  drive.addFile("selected-file");
  drive.onGet = () => { auth.active = clone(ACCOUNT_B); };
  await assert.rejects(library.importFiles(["selected-file"]), /account changed/);
  assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 0);
  assert.equal((await store.list("assets", ACCOUNT_B.id)).length, 0);
});

test("account switch after remote upload retains the old account journal without exposing an asset", async () => {
  const { store, drive, auth, library } = await fixture();
  drive.onUploaded = () => { auth.active = clone(ACCOUNT_B); };
  await assert.rejects(library.upload(file()), /account changed/);
  assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 0);
  assert.equal((await store.list("assets", ACCOUNT_B.id)).length, 0);
  assert.equal((await store.list("operations", ACCOUNT_A.id)).length, 1);
  assert.equal((await store.list("operations", ACCOUNT_B.id)).length, 0);
});

test("refresh removes inaccessible, deleted and trashed references but preserves other accounts", async () => {
  const { store, drive, library } = await fixture();
  for (const id of ["missing", "denied", "trashed", "available"]) {
    await library.saveAsset(drive.addFile(id));
  }
  await store.put("assets", ACCOUNT_B.id, "missing", { assetId: "b-only", driveFileId: "missing" });
  drive.getErrors.set("missing", driveError(404));
  drive.getErrors.set("denied", driveError(403));
  drive.remote.get("trashed").trashed = true;
  assert.deepEqual((await library.refresh()).map((asset) => asset.driveFileId), ["available"]);
  assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 1);
  assert.equal((await store.list("assets", ACCOUNT_B.id)).length, 1);
});

test("refresh keeps references on retryable or quota errors", async () => {
  for (const error of [
    driveError(403, { code: "rateLimitExceeded", retryable: true }),
    driveError(403, { code: "userRateLimitExceeded", retryable: true }),
    driveError(403, { code: "storageQuotaExceeded" }),
    driveError(403, { code: "dailyLimitExceeded" }),
    driveError(403, { code: "activeItemCreationLimitExceeded" }),
    driveError(503, { retryable: true }),
  ]) {
    const { store, drive, library } = await fixture();
    await library.saveAsset(drive.addFile("file"));
    drive.getErrors.set("file", error);
    await assert.rejects(library.refresh(), (cause) => cause === error);
    assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 1);
  }
});

test("a file renamed without its extension keeps its canonical supported MIME type", async () => {
  const { drive, library } = await fixture();
  const original = await library.saveAsset(drive.addFile("renamed", "%PDF-1.7", {
    name: "report.pdf", mimeType: "application/pdf",
  }));
  for (const name of ["Quarterly report", "report.other-extension"]) {
    drive.remote.get("renamed").name = name;
    const [refreshed] = await library.refresh();
    assert.equal(refreshed.assetId, original.assetId);
    assert.equal(refreshed.name, name);
    assert.equal(refreshed.mimeType, "application/pdf");
  }
});

test("an unsupported remote MIME type cannot abort refreshing the remaining library", async () => {
  const { store, drive, library } = await fixture();
  await library.saveAsset(drive.addFile("unsupported"));
  const expected = await library.saveAsset(drive.addFile("available"));
  const stale = await store.get("assets", ACCOUNT_A.id, "unsupported");
  await store.put("assets", ACCOUNT_A.id, "unsupported", {
    ...stale, processingStatus: "extracted", extraction: { text: "Old extracted text" },
  });
  drive.remote.get("unsupported").mimeType = "application/vnd.google-apps.document";
  const visible = await library.refresh();
  assert.deepEqual(visible.map((asset) => asset.assetId), [expected.assetId]);
  assert.ok(await store.get("assets", ACCOUNT_A.id, "available"));
  assert.equal(await store.get("assets", ACCOUNT_A.id, "unsupported"), undefined,
    "A later UI reload of stored records must not resurrect unsupported files or their text");
  assert.equal(drive.uploads.length, 0);
  assert.equal(drive.downloads.length, 0);
});

test("remote version changes invalidate a locally computed hash when Drive supplies no checksum", async () => {
  const { drive, library } = await fixture();
  const metadata = drive.addFile("file", "original", { sha256Checksum: undefined });
  const first = await library.saveAsset(metadata, { sha256: "local-hash" });
  const unchanged = await library.saveAsset(metadata);
  assert.equal(unchanged.sha256, "local-hash");
  drive.remote.get("file").modifiedTime = "2026-02-01T00:00:00.000Z";
  const [changed] = await library.refresh();
  assert.equal(changed.sha256, null);
  assert.equal(changed.assetId, first.assetId);
});

test("recovery rejects a remote checksum mismatch and retains the operation for attention", async () => {
  const { store, drive, library } = await fixture();
  store.failNextPut = "assets";
  await assert.rejects(library.upload(file("original")), /commit failure/);
  const [pending] = await store.list("operations", ACCOUNT_A.id);
  drive.remote.get(pending.driveFileId).sha256Checksum = hash(Buffer.from("modified"));
  const [unresolved] = await library.recover();
  assert.equal(unresolved.operationId, pending.operationId);
  assert.match(unresolved.error, /differs from the interrupted upload/);
  assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 0);
  assert.equal(drive.generated.length, 1);
});

test("retry also rejects a same-size remote checksum mismatch instead of accepting changed content", async () => {
  const { store, drive, library } = await fixture();
  store.failNextPut = "assets";
  const original = file("original");
  await assert.rejects(library.upload(original), /commit failure/);
  const [pending] = await store.list("operations", ACCOUNT_A.id);
  drive.remote.get(pending.driveFileId).sha256Checksum = hash(Buffer.from("modified"));
  await assert.rejects(library.upload(original, { operationId: pending.operationId }), /differs|match|changed/i);
  assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 0);
  assert.equal((await store.list("operations", ACCOUNT_A.id)).length, 1);
  assert.equal(drive.generated.length, 1);
});

test("recovery leaves missing or inaccessible uploads pending without creating replacements", async () => {
  for (const status of [403, 404]) {
    const { store, drive, library } = await fixture();
    drive.nextUploadError = new Error("Offline");
    await assert.rejects(library.upload(file()), /Offline/);
    const [pending] = await store.list("operations", ACCOUNT_A.id);
    drive.getErrors.set(pending.driveFileId, driveError(status));
    const unresolved = await library.recover();
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].driveFileId, pending.driveFileId);
    assert.equal(drive.generated.length, 1);
    assert.equal(drive.uploads.length, 1);
  }
});

test("retrieval rechecks permissions and returns the preserved download", async () => {
  const { drive, library } = await fixture();
  const metadata = drive.addFile("file", "unaltered original");
  const asset = await library.saveAsset(metadata);
  assert.equal(await library.access(asset.assetId), "https://drive.google.com/file/d/file/view");
  const result = await library.access(asset.assetId, { download: true });
  assert.equal(result.name, metadata.name);
  assert.equal(await result.blob.text(), "unaltered original");
  assert.deepEqual(drive.downloads, ["file"]);
});

test("retrieval denies missing, inaccessible, trashed, non-downloadable and other-account files", async () => {
  const { store, drive, auth, library, makeLibrary } = await fixture();
  const asset = await library.saveAsset(drive.addFile("file"));
  await assert.rejects(library.access("unknown"), /not found in this account/);
  drive.getErrors.set("file", driveError(403));
  await assert.rejects(library.access(asset.assetId), (error) => error.status === 403);
  drive.getErrors.set("file", driveError(404));
  await assert.rejects(library.access(asset.assetId), (error) => error.status === 404);
  drive.getErrors.delete("file");
  drive.remote.get("file").trashed = true;
  await assert.rejects(library.access(asset.assetId), /trash/);
  drive.remote.get("file").trashed = false;
  drive.remote.get("file").capabilities.canDownload = false;
  await assert.rejects(library.access(asset.assetId, { download: true }), /does not permit downloading/);
  auth.active = clone(ACCOUNT_B);
  await assert.rejects(makeLibrary(ACCOUNT_B).access(asset.assetId), /not found in this account/);
  assert.equal(drive.downloads.length, 0);
  assert.equal((await store.list("assets", ACCOUNT_A.id)).length, 1);
});

test("a session switch during download does not return the previous account's bytes", async () => {
  const { drive, auth, library } = await fixture();
  const asset = await library.saveAsset(drive.addFile("file"));
  drive.onDownload = () => { auth.active = clone(ACCOUNT_B); };
  await assert.rejects(library.access(asset.assetId, { download: true }), /account changed/);
});

test("a session switch during destination lookup does not expose the previous account's folder", async () => {
  const { drive, auth, library } = await fixture();
  drive.onGet = () => { auth.active = clone(ACCOUNT_B); };
  await assert.rejects(library.destination(), /account changed/);
});

test("a session switch during destination commit does not return a stale folder to the UI", async () => {
  const { store, auth, library } = await fixture();
  store.onPut = (name, accountId, id) => {
    if (name === "settings" && id === "destination") auth.active = clone(ACCOUNT_B);
  };
  await assert.rejects(library.setDestination("chosen-folder"), /account changed/);
  assert.equal(await store.get("settings", ACCOUNT_B.id, "destination"), undefined);
});

function useExtractor(library, callback = async () => {}) {
  library.extractor = { extract: async (blob, asset) => {
    await callback(blob, asset);
    return { schema_version: 1, source_name: asset.name, file_type: "txt", status: "extracted",
      text: await blob.text(), parts: [], ocr_pages: [], error: null };
  } };
}

test("extraction stores text under the correct account and survives refresh", async () => {
  const { library, drive, store, auth, makeLibrary } = await fixture();
  useExtractor(library);
  const uploaded = await library.upload(file("Invoice: INR 250"));
  const processed = await library.extract(uploaded.assetId);
  assert.equal(processed.processingStatus, "extracted");
  assert.equal(processed.extraction.text, "Invoice: INR 250");
  assert.equal(drive.uploads.length, 1);
  assert.deepEqual((await library.refresh())[0].extraction, processed.extraction);
  assert.deepEqual(await library.extractionResult(uploaded.assetId), processed.extraction);
  auth.active = clone(ACCOUNT_B);
  await assert.rejects(makeLibrary(ACCOUNT_B).extractionResult(uploaded.assetId), /not found/);
  assert.deepEqual(await store.list("assets", ACCOUNT_B.id), []);
});

test("service unavailable is retryable without another Drive upload or pending journal", async () => {
  const { library, drive, store } = await fixture();
  useExtractor(library, async () => { throw new Error("Start local extraction service"); });
  const asset = await library.upload(file());
  const failed = await library.extract(asset.assetId);
  assert.equal(failed.processingStatus, "failed");
  assert.match(failed.processingError, /Start local/);
  assert.equal(failed.extraction, null);
  assert.deepEqual(await store.list("operations", ACCOUNT_A.id), []);
  useExtractor(library);
  assert.equal((await library.extract(asset.assetId)).processingStatus, "extracted");
  assert.equal(drive.uploads.length, 1);
});

test("imported Drive files can be extracted without creating copies", async () => {
  const { library, drive } = await fixture();
  useExtractor(library);
  drive.addFile("report", "Imported report");
  await library.importFiles(["report"]);
  const [asset] = await library.refresh();
  assert.equal((await library.extract(asset.assetId)).extraction.text, "Imported report");
  assert.equal(drive.uploads.length, 0);
});

test("a remote modification or rename invalidates the stored extraction", async () => {
  for (const change of [
    remote => { remote.modifiedTime = "2026-03-01T00:00:00Z"; },
    remote => { remote.name = "changed.txt"; },
    remote => { remote.sha256Checksum = hash(Buffer.from("changed")); },
  ]) {
    const { library, drive } = await fixture();
    useExtractor(library);
    const asset = await library.upload(file());
    await library.extract(asset.assetId);
    change(drive.remote.get(asset.driveFileId));
    await assert.rejects(library.extractionResult(asset.assetId), /No current extraction/);
    const [refreshed] = await library.refresh();
    assert.equal(refreshed.extraction, null);
    assert.equal(refreshed.processingStatus, "not_processed");
  }
});

test("account changes during download or extraction cannot persist or return text", async () => {
  for (const step of ["download", "extract"]) {
    const { library, drive, store, auth } = await fixture();
    const asset = await library.upload(file());
    useExtractor(library, async () => { if (step === "extract") auth.active = clone(ACCOUNT_B); });
    if (step === "download") drive.onDownload = () => { auth.active = clone(ACCOUNT_B); };
    await assert.rejects(library.extract(asset.assetId), /account changed/);
    assert.equal((await store.get("assets", ACCOUNT_A.id, asset.driveFileId)).extraction, null);
    assert.deepEqual(await store.list("assets", ACCOUNT_B.id), []);
  }
});

test("changed bytes and a changed version during parsing are not accepted", async () => {
  for (const step of ["download", "extract"]) {
    const { library, drive, store } = await fixture();
    const asset = await library.upload(file("original"));
    let called = false;
    useExtractor(library, async () => {
      called = true;
      if (step === "extract") drive.remote.get(asset.driveFileId).modifiedTime = "2026-03-01T00:00:00Z";
    });
    if (step === "download") {
      drive.bytes.set(asset.driveFileId, Buffer.from("modified"));
      assert.equal((await library.extract(asset.assetId)).processingStatus, "failed");
      assert.equal(called, false);
    } else await assert.rejects(library.extract(asset.assetId), /changed during extraction/);
    assert.equal((await store.get("assets", ACCOUNT_A.id, asset.driveFileId)).extraction, null);
  }
});

test("revoked download permission clears text and blocks preview and extraction", async () => {
  const { library, drive, store } = await fixture();
  useExtractor(library);
  const asset = await library.upload(file());
  await library.extract(asset.assetId);
  drive.remote.get(asset.driveFileId).capabilities.canDownload = false;
  await assert.rejects(library.extractionResult(asset.assetId), /does not permit/);
  await assert.rejects(library.extract(asset.assetId), /does not permit/);
  assert.equal((await store.get("assets", ACCOUNT_A.id, asset.driveFileId)).extraction, null);
  assert.equal(drive.downloads.length, 1);
});

test("OCR and empty results retain their distinct processing statuses", async () => {
  for (const status of ["needs_ocr", "empty", "failed"]) {
    const { library, drive } = await fixture();
    const asset = await library.saveAsset(drive.addFile("report"));
    library.extractor = { extract: async () => ({ status, text: "", ocr_pages: status === "needs_ocr" ? [1] : [], error: status === "failed" ? "Corrupt" : null }) };
    const processed = await library.extract(asset.assetId);
    assert.equal(processed.processingStatus, status);
    assert.equal((await library.refresh())[0].processingStatus, status);
  }
});

test("refresh in another tab waits for extraction and preserves the committed text", async () => {
  const { library, makeLibrary } = await fixture();
  const anotherTab = makeLibrary();
  let tail = Promise.resolve();
  const locks = { request: (_name, operation) => {
    const current = tail.then(operation);
    tail = current.catch(() => {});
    return current;
  } };
  library.locks = anotherTab.locks = locks;
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  useExtractor(library, async () => { entered(); await finish; });
  const asset = await library.upload(file("Keep this extracted text"));
  const extracting = library.extract(asset.assetId);
  await started;
  const refreshing = anotherTab.refresh();
  release();
  await extracting;
  assert.equal((await refreshing)[0].extraction.text, "Keep this extracted text");
});

test("permission revocation during parsing discards the completed result", async () => {
  const { library, drive, store } = await fixture();
  const asset = await library.upload(file());
  useExtractor(library, async () => { drive.getErrors.set(asset.driveFileId, driveError(404)); });
  await assert.rejects(library.extract(asset.assetId), /404/);
  assert.equal(await store.get("assets", ACCOUNT_A.id, asset.driveFileId), undefined);
});
