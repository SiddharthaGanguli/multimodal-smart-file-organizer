import test from "node:test";
import assert from "node:assert/strict";
import { DriveClient, DriveError, MAX_FILE_BYTES, FILE_FIELDS } from "../src/drive.js";

const session = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-one";
const meta = { id: "file-123", name: "notes.txt", mimeType: "text/plain", size: "6", parents: ["folder-1"],
  createdTime: "2026-10-01T00:00:00Z", modifiedTime: "2026-10-01T00:00:00Z", trashed: false,
  webViewLink: "https://drive.google.com/file/d/file-123/view", sha256Checksum: "checksum",
  capabilities: { canDownload: true } };
const folder = { id: "folder-1", name: "Smart Organizer", mimeType: "application/vnd.google-apps.folder",
  appProperties: { smartOrganizer: "root" }, capabilities: { canAddChildren: true }, trashed: false };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", ...headers },
});
const failure = (status, reason = "error", headers = {}) => json({ error: { errors: [{ reason }] } }, status, headers);
const notFound = () => failure(404, "notFound");
const start = (url = session) => new Response(null, { status: 200, headers: { location: url } });
const incomplete = range => new Response(null, { status: 308, headers: range ? { range } : {} });
const request = extra => ({ id: meta.id, name: meta.name, mimeType: meta.mimeType, parentId: "folder-1", file: new Blob(["abcdef"], { type: "text/plain" }), ...extra });

function setup(steps, options = {}) {
  const calls = [];
  const sleeps = [];
  const remaining = [...steps];
  const client = new DriveClient({ getToken: async () => "test-token", sleep: async ms => sleeps.push(ms),
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.ok(remaining.length, `Unexpected request: ${init.method || "GET"} ${url}`);
      const step = remaining.shift();
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(new URL(url), init) : step;
    }, ...options });
  return { client, calls, sleeps, done: () => assert.equal(remaining.length, 0, "Unused mock requests") };
}

test("account identity comes from about.user and only Drive REST scope is needed", async () => {
  const { client, done } = setup([(url, init) => {
    assert.equal(url.pathname, "/drive/v3/about");
    assert.equal(url.searchParams.get("fields"), "user,storageQuota");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    return json({ user: { permissionId: "stable-id", emailAddress: "person@example.test", displayName: "Person" }, storageQuota: { limit: "42" } });
  }]);
  assert.deepEqual(await client.getAccount(), { id: "stable-id", email: "person@example.test", name: "Person" });
  done();
});

test("getFile requests the complete canonical metadata and generateId requests one reusable ID", async () => {
  const { client, done } = setup([(url) => {
    assert.equal(url.pathname, "/drive/v3/files/file-123");
    assert.equal(url.searchParams.get("fields"), FILE_FIELDS);
    return json(meta);
  }, (url) => {
    assert.equal(url.pathname, "/drive/v3/files/generateIds");
    assert.equal(url.searchParams.get("count"), "1");
    assert.equal(url.searchParams.get("space"), "drive");
    assert.equal(url.searchParams.get("type"), "files");
    return json({ ids: ["pre-generated"] });
  }]);
  assert.deepEqual(await client.getFile(meta.id), meta);
  assert.equal(await client.generateId(), "pre-generated");
  done();
});

test("root creation marks its app property and uses the caller's ID", async () => {
  const { client, done } = setup([(url, init) => {
    assert.equal(url.pathname, "/drive/v3/files");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { id: folder.id, name: folder.name, mimeType: folder.mimeType, appProperties: folder.appProperties });
    return json(folder);
  }]);
  assert.deepEqual(await client.createFolder({ id: folder.id, name: folder.name }), folder);
  done();
});

for (const outcome of ["network", "conflict"]) {
  test(`root creation reconciles ${outcome} without making another folder`, async () => {
    const { client, calls, done } = setup([outcome === "network" ? new TypeError("offline") : failure(409), json(folder)]);
    assert.deepEqual(await client.createFolder({ id: folder.id, name: folder.name }), folder);
    assert.equal(calls.filter(call => call.init.method === "POST").length, 1);
    done();
  });
}

test("root retry retains its ID after a failed request and absent reconciliation", async () => {
  const { client, calls, done } = setup([failure(503), notFound(), json(folder)]);
  await client.createFolder({ id: folder.id, name: folder.name });
  assert.deepEqual(calls.filter(call => call.init.method === "POST").map(call => JSON.parse(call.init.body).id), [folder.id, folder.id]);
  done();
});

test("root reconciliation refuses unmarked or trashed folders", async () => {
  for (const bad of [{ ...folder, appProperties: {} }, { ...folder, trashed: true }, { ...folder, mimeType: "text/plain" }]) {
    const { client } = setup([failure(409), json(bad)]);
    await assert.rejects(client.createFolder({ id: folder.id, name: folder.name }), { code: "conflictingFile" });
  }
});

test("folder discovery queries only app-managed nontrashed roots and follows pagination", async () => {
  const { client, done } = setup([(url) => {
    const query = url.searchParams.get("q");
    assert.match(query, /trashed = false/);
    assert.match(query, /mimeType = 'application\/vnd.google-apps.folder'/);
    assert.match(query, /appProperties has \{ key='smartOrganizer' and value='root' \}/);
    assert.equal(url.searchParams.get("spaces"), "drive");
    return json({ files: [folder], nextPageToken: "next-page" });
  }, url => {
    assert.equal(url.searchParams.get("pageToken"), "next-page");
    return json({ files: [{ ...folder, id: "folder-2" }] });
  }]);
  assert.deepEqual((await client.findFolders()).map(file => file.id), ["folder-1", "folder-2"]);
  done();
});

test("successful upload sends metadata then bytes, persists session, and returns canonical metadata", async () => {
  const events = [];
  const progress = [];
  const { client, done } = setup([notFound(), (url, init) => {
    assert.equal(url.pathname, "/upload/drive/v3/files");
    assert.equal(url.searchParams.get("uploadType"), "resumable");
    assert.equal(url.searchParams.get("fields"), FILE_FIELDS);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-Upload-Content-Length"], "6");
    assert.equal(init.headers["X-Upload-Content-Type"], "text/plain");
    assert.deepEqual(JSON.parse(init.body), { id: meta.id, name: meta.name, mimeType: meta.mimeType, parents: ["folder-1"] });
    return start();
  }, async (url, init) => {
    assert.equal(url.href, session);
    assert.equal(init.method, "PUT");
    assert.equal(init.headers["Content-Range"], "bytes 0-5/6");
    assert.equal(await init.body.text(), "abcdef");
    assert.deepEqual(events, [session]);
    return json(meta, 201);
  }]);
  assert.deepEqual(await client.upload(request({ onSession: async url => events.push(url), onProgress: value => progress.push(value) })), meta);
  assert.deepEqual(progress, [0, 1]);
  done();
});

test("an existing committed upload returns metadata without writing bytes again", async () => {
  const { client, calls, done } = setup([json(meta)]);
  assert.deepEqual(await client.upload(request()), meta);
  assert.equal(calls.length, 1);
  done();
});

test("size mismatch and missing parent are never accepted as this upload", async () => {
  for (const changed of [{ size: "5" }, { parents: ["other-parent"] }, { trashed: true }]) {
    const { client, calls } = setup([json({ ...meta, ...changed })]);
    await assert.rejects(client.upload(request()), { code: "conflictingFile" });
    assert.equal(calls.length, 1);
  }
});

test("same-size files with a different checksum or MIME are not accepted", async () => {
  const wrongHash = setup([json({ ...meta, sha256Checksum: "def" })]);
  await assert.rejects(wrongHash.client.upload(request({ sha256: "abc" })), { code: "conflictingFile" });
  const wrongType = setup([json({ ...meta, mimeType: "image/png" })]);
  await assert.rejects(wrongType.client.upload(request()), { code: "conflictingFile" });
  const sameHash = setup([json({ ...meta, sha256Checksum: "ABC" })]);
  assert.equal((await sameHash.client.upload(request({ sha256: "abc" }))).sha256Checksum, "ABC");
});

test("lost completion response is reconciled by ID without a second upload", async () => {
  const { client, calls, done } = setup([notFound(), start(), new TypeError("connection lost"), json(meta)]);
  assert.deepEqual(await client.upload(request()), meta);
  assert.equal(calls.filter(call => call.init.method === "PUT").length, 1);
  done();
});

test("initiation network failure reconciles and retries with the same generated ID", async () => {
  const { client, calls, done } = setup([notFound(), new TypeError("interrupted"), notFound(), start(), json(meta)]);
  assert.deepEqual(await client.upload(request()), meta);
  assert.deepEqual(calls.filter(call => call.init.method === "POST").map(call => JSON.parse(call.init.body).id), [meta.id, meta.id]);
  done();
});

test("upload creation conflict reconciles its canonical file", async () => {
  const { client, done } = setup([notFound(), failure(409), json(meta)]);
  assert.deepEqual(await client.upload(request()), meta);
  done();
});

test("interrupted PUT probes the session and resumes after the server's Range", async () => {
  const { client, done } = setup([notFound(), start(), failure(503), notFound(), (url, init) => {
    assert.equal(url.href, session);
    assert.equal(init.headers["Content-Range"], "bytes */6");
    assert.equal(init.body.size, 0);
    return incomplete("bytes=0-2");
  }, async (url, init) => {
    assert.equal(init.headers["Content-Range"], "bytes 3-5/6");
    assert.equal(await init.body.text(), "def");
    return json(meta);
  }]);
  assert.deepEqual(await client.upload(request()), meta);
  done();
});

test("saved session is probed before bytes and may already be complete", async () => {
  const { client, done } = setup([notFound(), (url, init) => {
    assert.equal(url.href, session);
    assert.equal(init.headers["Content-Range"], "bytes */6");
    return json(meta);
  }]);
  assert.deepEqual(await client.upload(request({ sessionUrl: session })), meta);
  done();
});

test("308 without Range resumes from byte zero", async () => {
  const { client, done } = setup([notFound(), incomplete(), async (url, init) => {
    assert.equal(init.headers["Content-Range"], "bytes 0-5/6");
    assert.equal(await init.body.text(), "abcdef");
    return json(meta);
  }]);
  await client.upload(request({ sessionUrl: session }));
  done();
});

for (const status of [404, 410]) {
  test(`expired session (${status}) reconciles before restarting with the same ID`, async () => {
    const saved = [];
    const { client, calls, done } = setup([notFound(), failure(status), notFound(), start(), json(meta)]);
    await client.upload(request({ sessionUrl: session, onSession: async value => saved.push(value) }));
    assert.deepEqual(saved, [null, session]);
    assert.equal(JSON.parse(calls.find(call => call.init.method === "POST").init.body).id, meta.id);
    done();
  });
}

test("expired session whose file already committed does not restart", async () => {
  const { client, calls, done } = setup([notFound(), failure(404), json(meta)]);
  assert.deepEqual(await client.upload(request({ sessionUrl: session })), meta);
  assert.equal(calls.filter(call => call.init.method === "POST").length, 0);
  done();
});

test("malformed or out of bounds session offsets stop rather than sending the wrong bytes", async () => {
  for (const range of ["bytes=0-6", "bytes=3-4", "garbage", "bytes=0-999999999999999999999"]) {
    const { client } = setup([notFound(), incomplete(range)]);
    await assert.rejects(client.upload(request({ sessionUrl: session })), { code: "invalidResponse" });
  }
});

test("untrusted saved upload URL is rejected before obtaining a token", async () => {
  for (const url of ["http://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=a",
    "https://evil.test/upload/drive/v3/files?uploadType=resumable&upload_id=a",
    "https://www.googleapis.com.evil.test/upload/drive/v3/files?uploadType=resumable&upload_id=a",
    "https://user@www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=a",
    "https://www.googleapis.com/drive/v3/files?uploadType=resumable&upload_id=a",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    `${session}#fragment`]) {
    const { client } = setup([], { getToken: () => { assert.fail("must not request a token"); } });
    await assert.rejects(client.upload(request({ sessionUrl: url })), { code: "invalidSession" });
  }
});

test("untrusted Location cannot receive file bytes or bearer token", async () => {
  const { client, calls, done } = setup([notFound(), start("https://evil.test/upload")]);
  await assert.rejects(client.upload(request()), { code: "invalidSession" });
  assert.equal(calls.length, 2);
  done();
});

test("empty and oversized uploads are rejected before network access", async () => {
  const { client, calls } = setup([]);
  await assert.rejects(client.upload(request({ file: new Blob([]) })), { code: "emptyFile" });
  await assert.rejects(client.upload(request({ file: new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]) })), { code: "fileTooLarge" });
  assert.equal(calls.length, 0);
});

test("401 invalidates one token and silently acquires a replacement exactly once", async () => {
  let tokenCalls = 0;
  const invalidated = [];
  const { client, calls, done } = setup([failure(401), json(meta)], {
    getToken: async () => ++tokenCalls === 1 ? "old-token" : "new-token",
    invalidateToken: async token => invalidated.push(token),
  });
  assert.deepEqual(await client.getFile(meta.id), meta);
  assert.deepEqual(invalidated, ["old-token"]);
  assert.deepEqual(calls.map(call => call.init.headers.Authorization), ["Bearer old-token", "Bearer new-token"]);
  done();
  const rejected = setup([failure(401), failure(401)]);
  await assert.rejects(rejected.client.getFile(meta.id), { status: 401, code: "authRequired", retryable: false });
  assert.equal(rejected.calls.length, 2);
});

test("safe GET retries network and 429 with bounded backoff", async () => {
  const { client, sleeps, done } = setup([new TypeError("offline"), failure(429, "rateLimitExceeded", { "retry-after": "1" }), json(meta)]);
  assert.deepEqual(await client.getFile(meta.id), meta);
  assert.deepEqual(sleeps, [500, 1000]);
  done();
});

test("GET gives up after the configured retry count", async () => {
  const { client, calls, done } = setup([failure(503), failure(503), failure(503)]);
  await assert.rejects(client.getFile(meta.id), { status: 503, retryable: true });
  assert.equal(calls.length, 3);
  done();
});

test("upload errors are bounded and reconcile on the final ambiguous failure", async () => {
  const { client, calls, done } = setup([notFound(), failure(503), notFound(), failure(503), notFound()], { maxRetries: 1 });
  await assert.rejects(client.upload(request()), { status: 503, retryable: true });
  assert.equal(calls.filter(call => call.init.method === "POST").length, 2);
  done();
});

test("quota and permission errors have friendly non-retryable messages", async () => {
  for (const [reason, pattern] of [["storageQuotaExceeded", /storage is full/], ["dailyLimitExceeded", /quota/], ["insufficientFilePermissions", /denied access/]]) {
    const { client, calls } = setup([failure(403, reason)]);
    await assert.rejects(client.getFile(meta.id), error => {
      assert.ok(error instanceof DriveError);
      assert.equal(error.status, 403);
      assert.equal(error.code, reason);
      assert.equal(error.retryable, false);
      assert.match(error.message, pattern);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("403 rate limiting can be retried", async () => {
  const { client, done } = setup([failure(403, "userRateLimitExceeded"), json(meta)]);
  assert.deepEqual(await client.getFile(meta.id), meta);
  done();
});

test("download requests original bytes and returns a correctly typed Blob", async () => {
  const { client, done } = setup([json(meta), (url, init) => {
    assert.equal(url.pathname, "/drive/v3/files/file-123");
    assert.equal(url.searchParams.get("alt"), "media");
    assert.equal(init.method, undefined);
    return new Response("abcdef", { headers: { "content-type": "text/plain", "content-length": "6" } });
  }]);
  const blob = await client.download(meta.id);
  assert.equal(blob.type, "text/plain");
  assert.equal(await blob.text(), "abcdef");
  done();
});

test("download rejects oversized metadata before requesting content", async () => {
  const { client, calls, done } = setup([json({ ...meta, size: String(MAX_FILE_BYTES + 1) })]);
  await assert.rejects(client.download(meta.id), { code: "fileTooLarge" });
  assert.equal(calls.length, 1);
  done();
});

test("download rejects oversized headers and streamed bytes even without metadata size", async () => {
  for (const useHeader of [true, false]) {
    let cancelled = false;
    let sent = false;
    const stream = new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new Uint8Array(useHeader ? 1 : MAX_FILE_BYTES + 1)); }
    }, cancel() { cancelled = true; } });
    const { client, done } = setup([json({ ...meta, size: undefined }), new Response(stream, { headers: useHeader ? { "content-length": String(MAX_FILE_BYTES + 1) } : {} })]);
    await assert.rejects(client.download(meta.id), { code: "fileTooLarge" });
    assert.equal(cancelled, true);
    done();
  }
});

test("download retries an incomplete response and preserves original content", async () => {
  const { client, done } = setup([json(meta), new Response("abc"), new Response("abcdef")]);
  assert.equal(await (await client.download(meta.id)).text(), "abcdef");
  done();
});

test("Workspace and download-disabled files are rejected without fetching content", async () => {
  for (const [changed, code] of [[{ mimeType: "application/vnd.google-apps.document" }, "unsupportedDownload"], [{ capabilities: { canDownload: false } }, "downloadDenied"]]) {
    const { client, calls } = setup([json({ ...meta, ...changed })]);
    await assert.rejects(client.download(meta.id), { code });
    assert.equal(calls.length, 1);
  }
});
