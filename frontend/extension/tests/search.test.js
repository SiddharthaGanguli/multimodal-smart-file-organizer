import test from "node:test";
import assert from "node:assert/strict";
import { SearchClient, searchOrigin } from "../src/search/client.js";
import { SearchLibrary, searchParts, toSource } from "../src/search/library.js";
import { OCR_VERSION } from "../src/ocr/pipeline.js";
import { sourceVersion } from "../src/ocr/library.js";

const asset = () => ({ assetId: "local-1", driveFileId: "drive-1", name: "Report.txt", mimeType: "text/plain",
  size: 100, modifiedTime: "2026-10-02T00:00:00Z", sha256: "a".repeat(64),
  extraction: { status: "extracted", text: "Travel reimbursement", parts: [
    { text: "Travel reimbursement", location: "page 1", page_number: 1 },
  ] } });
function fixture() {
  const records = new Map(), calls = [], current = asset();
  const store = {
    get: async (table, owner, id) => records.get(`${table}:${owner}:${id}`),
    put: async (table, owner, id, value) => records.set(`${table}:${owner}:${id}`, value),
    delete: async (table, owner, id) => records.delete(`${table}:${owner}:${id}`),
    list: async (table, owner) => table === "assets" && owner === "A" ? [current] : [],
  };
  const library = { session: { id: "A" }, guard: async () => {}, checkedAsset: async () => current };
  const client = { origin: "https://search.example.test", request: async (...args) => { calls.push(args); return {}; } };
  return { records, calls, current, store, library, client, search: new SearchLibrary({ store, library, client }) };
}

test("hosted search accepts only exact HTTPS origins", () => {
  assert.equal(searchOrigin("https://search.example.test/"), "https://search.example.test");
  for (const url of ["http://example.test", "https://user@example.test", "https://example.test/v1", "https://example.test?q=x", "https://example.test:444"])
    assert.throws(() => searchOrigin(url));
});

test("search authenticates fixed POST endpoints without cookies or redirects", async () => {
  let call, guards = 0;
  const client = new SearchClient({ baseUrl: "https://search.example.test", session: { id: "A" },
    auth: { assert: async () => guards++, tokenFor: async () => "ephemeral" },
    fetchImpl: async (...args) => { call = args; return Response.json({ results: [] }); } });
  await client.request("query", { query: "trip costs" });
  assert.equal(call[0], "https://search.example.test/v1/search/query");
  assert.equal(call[1].headers.Authorization, "Bearer ephemeral");
  assert.equal(call[1].redirect, "error"); assert.equal(call[1].credentials, "omit");
  assert.deepEqual(JSON.parse(call[1].body), { query: "trip costs" });
  assert.equal(guards, 3);
  await assert.rejects(client.request("https://evil.test"), /Unknown/);
});

test("account switches while a hosted response is pending discard the response", async () => {
  let changed = false;
  const client = new SearchClient({ baseUrl: "https://search.example.test", session: { id: "A" },
    auth: { assert: async () => { if (changed) throw new Error("account changed"); }, tokenFor: async () => "token" },
    fetchImpl: async () => { changed = true; return Response.json({ results: [{ snippet: "private" }] }); } });
  await assert.rejects(client.request("query", { query: "x" }), /account changed/);
});

test("expired hosted credentials are removed and unavailable search fails clearly", async () => {
  let invalidated;
  const options = { baseUrl: "https://search.example.test", session: { id: "A" },
    auth: { assert: async () => {}, tokenFor: async () => "token", invalidate: async token => { invalidated = token; } } };
  const client = new SearchClient({ ...options, fetchImpl: async () => Response.json({ detail: "Reconnect" }, { status: 401 }) });
  await assert.rejects(client.request("status"), /Reconnect/); assert.equal(invalidated, "token");
  const offline = new SearchClient({ ...options, fetchImpl: async () => { throw new TypeError("offline"); } });
  await assert.rejects(offline.request("status"), /filename search still work/);
});

test("text parts prefer embedded text and retain only current OCR with review markers", () => {
  const current = asset();
  const ocr = { engineVersion: OCR_VERSION, sourceVersion: sourceVersion(current), status: "partial", pages: [
    { pageNumber: 1, text: "duplicate", status: "complete" },
    { pageNumber: 2, text: "scanned page", status: "needs_review" },
    { pageNumber: 3, text: "failed", status: "failed" },
  ] };
  const parts = searchParts(current, ocr);
  assert.equal(parts.length, 2); assert.equal(parts[1].needs_review, true); assert.equal(parts[1].page_number, 2);
  ocr.sourceVersion = "stale"; assert.equal(searchParts(current, ocr).length, 1);
  current.extraction = null; assert.throws(() => searchParts(current, ocr), /Extract text/);
  current.extraction = { status: "extracted", text: "x".repeat(200001) };
  assert.throws(() => searchParts(current), /200,000/);
});

test("opt-in is required and scoped to both account and service", async () => {
  const f = fixture();
  await assert.rejects(f.search.index("local-1"), /Enable hosted search/);
  await assert.rejects(f.search.query("travel"), /Enable hosted search/); assert.equal(f.calls.length, 0);
  await f.search.enable(); await f.search.index("local-1");
  assert.equal(f.calls[0][1].file_id, "drive-1"); assert.equal(f.calls[0][1].owner_id, undefined);
  assert.deepEqual(f.calls[0][1].source, toSource(f.current));
  f.library.session = { id: "B" }; assert.equal(await f.search.enabled(), false);
  f.library.session = { id: "A" }; f.client.origin = "https://new.example.test";
  assert.equal(await f.search.enabled(), false);
});

test("results must belong to the local library and still match canonical Drive metadata", async () => {
  const f = fixture(); await f.search.enable();
  const valid = { file_id: "drive-1", source: toSource(f.current), snippet: "trip costs", location: "page 1" };
  f.client.request = async () => ({ results: [valid, { ...valid, file_id: "unknown" },
    { ...valid, source: { ...valid.source, modified_time: "old" } }] });
  const response = await f.search.query("travel"); assert.equal(response.results.length, 1);
  assert.equal(response.results[0].assetId, "local-1");
  f.library.checkedAsset = async () => { throw new Error("permission denied"); };
  assert.equal((await f.search.query("travel")).results.length, 0);
});

test("deleting the hosted index clears consent only after a successful server deletion", async () => {
  const f = fixture(); await f.search.enable();
  f.client.request = async () => { throw new Error("offline"); };
  await assert.rejects(f.search.forget(), /offline/); assert.equal(await f.search.enabled(), true);
  f.client.request = async operation => { assert.equal(operation, "forget"); return { deleted: 1 }; };
  await f.search.forget(); assert.equal(await f.search.enabled(), false);
  assert.equal((await f.store.list("assets", "A")).length, 1);
});
