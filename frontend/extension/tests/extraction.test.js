import assert from "node:assert/strict";
import test from "node:test";
import { LocalExtractor, canExtract } from "../src/extraction.js";
import { CONFIG } from "../config.js";
import { readFile } from "node:fs/promises";

const asset = { name: "invoice.txt", mimeType: "text/plain" };
const result = { schema_version: 1, file_type: "txt", status: "extracted", text: "Invoice 250", parts: [], ocr_pages: [], error: null };

test("extraction sends exact bytes only to loopback without credentials", async () => {
  const bytes = new Blob(["Invoice 250"]);
  const client = new LocalExtractor({ fetchImpl: async (url, options) => {
    assert.equal(new URL(url).origin, "http://127.0.0.1:8000");
    assert.equal(new URL(url).searchParams.get("filename"), "invoice.txt");
    assert.equal(options.body, bytes);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { "Content-Type": "application/octet-stream", "X-Filewise-Request": "extraction-v1" });
    return Response.json(result);
  } });
  assert.deepEqual(await client.extract(bytes, asset), { ...result, source_name: asset.name });
  assert.throws(() => new LocalExtractor({ baseUrl: "https://remote.example" }), /local/);
});

test("transport filename handles Drive renames and preserves original provenance", async () => {
  const name = 'Q3: report / <review> "draft" ' + "x".repeat(260);
  const client = new LocalExtractor({ fetchImpl: async url => {
    const filename = new URL(url).searchParams.get("filename");
    assert.ok(filename.length <= 255);
    assert.ok(filename.endsWith(".txt"));
    assert.doesNotMatch(filename, /[<>:"\\/|?*\x00-\x1f]/);
    return Response.json(result);
  } });
  assert.equal((await client.extract(new Blob(["Invoice 250"]), { ...asset, name })).source_name, name);
});

test("service failures offer retry and parser failures preserve structured status", async () => {
  for (const [fetchImpl, message] of [
    [async () => { throw new TypeError("fetch failed"); }, /Start the local extraction service/],
    [async () => { throw new DOMException("late", "TimeoutError"); }, /timed out/],
    [async () => Response.json({ detail: "Document too large" }, { status: 413 }), /Document too large/],
    [async () => Response.json({ status: "extracted", text: "untrusted" }), /invalid result/],
  ]) {
    await assert.rejects(new LocalExtractor({ fetchImpl }).extract(new Blob(["x"]), asset), message);
  }
  const failed = { ...result, status: "failed", error: "Corrupt document", text: "" };
  assert.equal((await new LocalExtractor({ fetchImpl: async () => Response.json(failed) }).extract(new Blob(), asset)).status, "failed");
});

test("images and oversized files never reach the extraction service", async () => {
  const client = new LocalExtractor({ fetchImpl: () => { throw new Error("Must not call"); } });
  assert.equal(canExtract({ mimeType: "image/png", name: "scan.pdf" }), false);
  await assert.rejects(client.extract(new Blob(), { mimeType: "image/png" }), /supports PDF/);
  await assert.rejects(client.extract({ size: 20 * 1024 * 1024 + 1 }, asset), /20 MB/);
});

test("manifest allows only the loopback extraction destination in addition to Drive", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url)));
  assert.equal(CONFIG.extractionApiUrl, "http://127.0.0.1:8000");
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1/*"));
  const sources = manifest.content_security_policy.extension_pages.match(/connect-src\s+([^;]+)/)[1].split(/\s+/);
  assert.deepEqual(sources, ["'self'", "https://www.googleapis.com", CONFIG.extractionApiUrl]);
});
