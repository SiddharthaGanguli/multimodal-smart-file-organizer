import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runOcr, selectPages, OCR_LIMITS, OCR_VERSION, ocrError } from "../src/ocr/pipeline.js";
import { imageDimensions } from "../src/ocr/browser.js";
import { OcrLibrary, sourceVersion } from "../src/ocr/library.js";

const input = new Blob(["image fixture"], { type: "image/png" });
function adapterFixture({ count = 2, recognize, render, engine, open } = {}) {
  const calls = { pages: [], closed: 0, rasters: 0, engines: 0 };
  const adapters = {
    open: open || (async (blob, { register }) => {
      register(() => calls.closed++);
      return { pageCount: count, render: render || (async page => {
        calls.pages.push(page);
        return { bytes: new Uint8Array([page]), width: 100, height: 80, close: () => calls.rasters++ };
      }) };
    }),
    engine: engine || (async ({ register }) => {
      calls.engines++; register(() => calls.closed++);
      return { recognize: recognize || (async bytes => ({ text: `Page ${bytes[0]}`, confidence: 90 })) };
    }),
  };
  return { calls, adapters };
}
test("selected OCR pages retain source references and dispose all resources", async () => {
  const { calls, adapters } = adapterFixture({ count: 5 });
  const result = await runOcr(input, { adapters, pageNumbers: [5, 2, 2] });
  assert.equal(result.status, "complete"); assert.deepEqual(calls.pages, [2, 5]);
  assert.deepEqual(result.pages.map(p => p.pageNumber), [2, 5]);
  assert.equal(result.text, "Page 2\n\nPage 5"); assert.equal(result.engineVersion, OCR_VERSION);
  assert.equal(calls.closed, 2); assert.equal(calls.rasters, 2);
});
test("page selection rejects invalid numbers and unbounded default jobs", () => {
  for (const pages of [[], [0], [3], [1.5], ["1"], Array(26).fill(1)]) assert.throws(() => selectPages(2, pages));
  assert.throws(() => selectPages(26), { code: "pageLimit" });
  assert.deepEqual(selectPages(1000, [999]), [999]);
});
for (const [name, data, status] of [
  ["blank", { text: "  \n", confidence: 95 }, "empty"],
  ["degraded", { text: "fuzzy", confidence: 35 }, "needs_review"],
  ["missing confidence", { text: "fuzzy" }, "needs_review"],
]) test(`${name} output receives ${status} state`, async () => {
  const { adapters } = adapterFixture({ recognize: async () => data });
  const result = await runOcr(input, { adapters });
  assert.equal(result.status, status); assert.ok(result.pages.every(page => page.status === status));
});
test("a failed page preserves successful text without claiming completeness", async () => {
  const { adapters } = adapterFixture({ render: async n => {
    if (n === 2) throw ocrError("renderFailed", "Page could not render.");
    return { bytes: new Uint8Array([n]) };
  } });
  const result = await runOcr(input, { adapters });
  assert.equal(result.status, "partial"); assert.equal(result.pages[1].status, "failed");
  assert.equal(result.pages[1].pageNumber, 2); assert.equal(result.text, "Page 1");
});
test("engine failure stops processing and captures failure provenance", async () => {
  const { adapters, calls } = adapterFixture({ recognize: async () => { throw ocrError("engineFailed", "Recognition stopped."); } });
  const result = await runOcr(input, { adapters });
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "engineFailed");
  assert.deepEqual(calls.pages, [1]); assert.equal(calls.closed, 2);
});
test("PDF page limit fails before loading recognition model", async () => {
  const { adapters, calls } = adapterFixture({ count: 26 });
  const result = await runOcr(input, { adapters });
  assert.equal(result.error.code, "pageLimit"); assert.equal(calls.engines, 0); assert.equal(calls.closed, 1);
});
test("input type and byte limits fail before opening any parser", async () => {
  const { adapters, calls } = adapterFixture();
  for (const [blob, code] of [[new Blob(["x"], { type: "text/plain" }), "unsupportedType"], [new Blob([], { type: "image/png" }), "sizeLimit"]]) {
    assert.equal((await runOcr(blob, { adapters })).error.code, code);
  }
  assert.equal(calls.closed, 0);
  assert.equal((await runOcr(input, { adapters, limits: { ...OCR_LIMITS, maxBytes: 2 } })).error.code, "sizeLimit");
});
test("bounded output retains only pages within the text budget", async () => {
  const { adapters, calls } = adapterFixture();
  const result = await runOcr(input, { adapters, limits: { ...OCR_LIMITS, maxText: 8 } });
  assert.equal(result.status, "partial"); assert.equal(result.error.code, "textLimit");
  assert.equal(result.text, "Page 1"); assert.equal(calls.closed, 2);
});
test("page deadline terminates a hung recognition worker", async () => {
  const { adapters, calls } = adapterFixture({ recognize: () => new Promise(() => {}) });
  const result = await runOcr(input, { adapters, limits: { ...OCR_LIMITS, pageTimeoutMs: 15 } });
  assert.equal(result.error.code, "timeout"); assert.equal(calls.closed, 2); assert.equal(calls.rasters, 1);
});
test("job deadline covers hung engine initialization", async () => {
  const { adapters, calls } = adapterFixture({ engine: ({ register }) => {
    register(() => calls.closed++); return new Promise(() => {});
  } });
  const result = await runOcr(input, { adapters, limits: { ...OCR_LIMITS, jobTimeoutMs: 15 } });
  assert.equal(result.error.code, "timeout"); assert.equal(calls.closed, 2);
});
test("cancellation drops incomplete output and tears down worker", async () => {
  const controller = new AbortController();
  const { adapters, calls } = adapterFixture({ recognize: async () => { controller.abort(); return { text: "discard", confidence: 90 }; } });
  const result = await runOcr(input, { adapters, signal: controller.signal });
  assert.equal(result.status, "cancelled"); assert.deepEqual(result.pages, []); assert.equal(result.text, "");
  assert.equal(calls.closed, 2);
});
test("already cancelled jobs never start a parser", async () => {
  const { adapters, calls } = adapterFixture();
  assert.equal((await runOcr(input, { adapters, signal: AbortSignal.abort() })).status, "cancelled");
  assert.equal(calls.closed, 0);
});
test("late allocated parser resources after cancellation are closed", async () => {
  let release; let closed = false;
  const controller = new AbortController();
  const { adapters } = adapterFixture({ open: async (blob, { register }) => {
    await new Promise(resolve => { release = resolve; }); register(() => { closed = true; }); return { pageCount: 1 };
  } });
  const running = runOcr(input, { adapters, signal: controller.signal });
  controller.abort(); assert.equal((await running).status, "cancelled");
  release(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(closed, true);
});
test("PNG/JPEG headers expose dimensions before image allocation", () => {
  const png = new Uint8Array(24); png.set([137,80,78,71,13,10,26,10]);
  const view = new DataView(png.buffer); view.setUint32(12, 0x49484452); view.setUint32(16, 1200); view.setUint32(20, 800);
  assert.deepEqual(imageDimensions(png, "image/png"), { width: 1200, height: 800 });
  const jpeg = new Uint8Array([255,216,255,192,0,8,8,3,32,4,176,3]);
  assert.deepEqual(imageDimensions(jpeg, "image/jpeg"), { width: 1200, height: 800 });
  assert.throws(() => imageDimensions(new Uint8Array([1,2]), "image/png"), { code: "invalidFile" });
  assert.throws(() => imageDimensions(jpeg.subarray(0, 7), "image/jpeg"), { code: "invalidFile" });
});

class MemoryStore {
  data = new Map();
  key(name, account, id) { return JSON.stringify([name, account, id]); }
  async get(name, account, id) { return structuredClone(this.data.get(this.key(name, account, id))); }
  async put(name, account, id, value) { const record = { ...structuredClone(value), accountId: account, id }; this.data.set(this.key(name, account, id), record); return record; }
  async list(name, account) { return [...this.data.entries()].filter(([key]) => { const k = JSON.parse(key); return k[0] === name && k[1] === account; }).map(([, value]) => structuredClone(value)); }
  async delete(name, account, id) { this.data.delete(this.key(name, account, id)); }
}
async function libraryFixture() {
  const store = new MemoryStore();
  const session = { id: "A", epoch: "one" };
  const auth = { active: session, async assert(bound) { if (this.active.id !== bound.id || this.active.epoch !== bound.epoch) throw Object.assign(new Error("Account changed"), { code: "accountChanged" }); }, async sessionLock(fn) { return fn(); } };
  const file = { id: "scan", name: "scan.png", mimeType: "image/png", modifiedTime: "v1", size: input.size, capabilities: { canDownload: true }, sha256Checksum: createHash("sha256").update(Buffer.from(await input.arrayBuffer())).digest("hex") };
  const drive = { gets: 0, downloads: 0, async getFile() { this.gets++; return structuredClone(file); }, async download() { this.downloads++; return input; } };
  const asset = { ...file, assetId: "asset-a", driveFileId: file.id, sha256: file.sha256Checksum };
  await store.put("assets", "A", file.id, asset);
  const calls = { recognition: 0 };
  const recognize = async () => { calls.recognition++; return { status: "complete", engineVersion: OCR_VERSION, pages: [{ pageNumber: 1, text: "private text A", confidence: 95 }], text: "private text A" }; };
  const library = new OcrLibrary({ store, auth, session, drive, recognize, locks: null });
  return { store, auth, session, file, drive, asset, calls, library };
}
test("cache persists text/provenance but rechecks Drive access on every read", async () => {
  const f = await libraryFixture(); const first = await f.library.read("asset-a");
  assert.equal(first.accountId, "A"); assert.equal(first.driveFileId, "scan");
  assert.equal(first.sourceVersion, sourceVersion(f.file));
  assert.equal((await f.library.read("asset-a")).text, "private text A");
  assert.equal(f.drive.gets, 3); assert.equal(f.drive.downloads, 1); assert.equal(f.calls.recognition, 1);
  assert.equal((await f.library.summaries([f.asset]))["asset-a"], "complete");
  await f.library.read("asset-a", { force: true }); assert.equal(f.calls.recognition, 2);
});
test("processing updates rerun older cached OCR and remove stale ready summaries", async () => {
  const f = await libraryFixture();
  const previous = await f.library.read("asset-a");
  previous.engineVersion = "tesseract.js-7.0.0/eng-best-int-1.0.0/pdfjs-6.3.289";
  previous.text = "old mixed columns";
  await f.store.put("ocrResults", "A", "scan", previous);
  const refreshed = await f.library.read("asset-a");
  assert.equal(f.calls.recognition, 2);
  assert.equal(refreshed.engineVersion, OCR_VERSION);
  assert.equal(refreshed.text, "private text A");
  await f.store.put("ocrResults", "A", "scan", previous);
  assert.deepEqual(Object.keys(await f.library.summaries([f.asset])), []);
  assert.equal(await f.store.get("ocrResults", "A", "scan"), undefined);
});
test("another account cannot read the same asset ID or cached text", async () => {
  const f = await libraryFixture(); await f.library.read("asset-a");
  f.auth.active = { id: "B", epoch: "two" };
  const other = new OcrLibrary({ ...f, session: f.auth.active, recognize: f.library.recognize, locks: null });
  await assert.rejects(other.read("asset-a"), /no longer in/);
  assert.deepEqual(Object.keys(await other.summaries([])), []);
  assert.equal(f.drive.downloads, 1);
});
test("permission loss prevents returning previously recognized text", async () => {
  const f = await libraryFixture(); await f.library.read("asset-a"); f.file.capabilities.canDownload = false;
  await assert.rejects(f.library.read("asset-a"), /sharing permissions/);
  assert.equal(await f.store.get("ocrResults", "A", "scan"), undefined);
});
test("remote change invalidates cache; changes during recognition never commit", async () => {
  const f = await libraryFixture(); await f.library.read("asset-a"); f.file.modifiedTime = "v2";
  await f.library.read("asset-a"); assert.equal(f.calls.recognition, 2);
  f.library.recognize = async () => { f.file.modifiedTime = "v3"; return { status: "complete", text: "stale" }; };
  await assert.rejects(f.library.read("asset-a", { force: true }), /changed while reading/);
  assert.equal(await f.store.get("ocrResults", "A", "scan"), undefined);
});
test("account changes during recognition discard results instead of committing", async () => {
  const f = await libraryFixture();
  f.library.recognize = async () => { f.auth.active = { id: "B", epoch: "two" }; return { text: "private text A" }; };
  await assert.rejects(f.library.read("asset-a"), { code: "accountChanged" });
  assert.equal((await f.store.list("ocrResults", "A")).length, 0);
  assert.equal((await f.store.list("ocrResults", "B")).length, 0);
});
test("download integrity failure prevents invoking OCR", async () => {
  const f = await libraryFixture(); f.drive.download = async () => new Blob(["X".repeat(input.size)]);
  await assert.rejects(f.library.read("asset-a"), /changed during download/); assert.equal(f.calls.recognition, 0);
});
test("failed IndexedDB commits are not reported as successful OCR", async () => {
  const f = await libraryFixture(); f.store.put = async () => { throw new Error("Quota exceeded"); };
  await assert.rejects(f.library.read("asset-a"), /Quota exceeded/);
});
test("refresh prunes removed and changed files without touching another account", async () => {
  const f = await libraryFixture(); const result = await f.library.read("asset-a");
  await f.store.put("ocrResults", "B", "scan", result);
  assert.deepEqual(Object.keys(await f.library.summaries([{ ...f.asset, modifiedTime: "v2" }])), []);
  assert.equal(await f.store.get("ocrResults", "A", "scan"), undefined);
  assert.ok(await f.store.get("ocrResults", "B", "scan"));
});
test("bundled OCR assets match the pinned integrity inventory", async () => {
  const inventory = JSON.parse(await readFile(new URL("../vendor/inventory.json", import.meta.url)));
  assert.equal(inventory.length, 4);
  for (const packageInfo of inventory) for (const file of packageInfo.files) {
    const data = await readFile(new URL(`../vendor/${file.path}`, import.meta.url));
    assert.equal(data.length, file.bytes, file.path);
    assert.equal(createHash("sha256").update(data).digest("hex"), file.sha256, file.path);
  }
});
