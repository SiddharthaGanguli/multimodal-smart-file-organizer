// Optional browser suite: npm install --no-save --package-lock=false playwright
// Then: npx playwright install chromium; node tests/browser-smoke.mjs
// BROWSER_EXE may select a local browser; PLAYWRIGHT_MODULE may select an ESM entry.
// Google requests and Chrome Identity are mocked; no real account is accessed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isConfigured, getPickerBridgeUrl } from "../config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(runtime ? pathToFileURL(resolve(runtime)).href : "playwright");
const output = join(root, "test-results", `browser-${Date.now()}`);
await mkdir(output, { recursive: true });
const report = { passed: [], errors: [], limitations: ["OAuth and Google Drive responses are mocked; no real accounts or Drive files are accessed.", "Google Picker SDK and installed-extension CSP are not verified by this localhost smoke test."] };
const mimeTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
// Serve explicit fixtures, never the developer's configured API key or OAuth client.
const fixtureConfig = {
  googleProjectNumber: "123456789", googlePickerApiKey: "test-public-picker-key",
  googlePickerBridgeUrl: "http://127.0.0.1:8765/picker.html",
  extractionApiUrl: "http://127.0.0.1:8000",
  maxUploadBytes: 20 * 1024 * 1024, uploadFolderName: "Filewise test uploads",
};
const fixtures = {
  configured: { clientId: "test-client.apps.googleusercontent.com", config: fixtureConfig },
  unconfigured: { clientId: "", config: { ...fixtureConfig, googleProjectNumber: "", googlePickerApiKey: "" } },
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const configured = url.pathname.startsWith("/configured/");
    const pathname = configured ? url.pathname.slice("/configured".length) : url.pathname;
    const path = resolve(root, `.${pathname === "/" ? "/app.html" : pathname}`);
    if (!path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) throw new Error("Out of root");
    const fixture = configured ? fixtures.configured : fixtures.unconfigured;
    let body;
    if (pathname === "/config.js") {
      // Exercise the real validator against isolated public test values.
      body = `export const CONFIG = Object.freeze(${JSON.stringify(fixture.config)});\nexport ${getPickerBridgeUrl.toString()}\nexport ${isConfigured.toString()}\n`;
    } else if (pathname === "/manifest.json") {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.oauth2.client_id = fixture.clientId;
      body = JSON.stringify(manifest);
    } else {
      body = await readFile(path);
    }
    response.writeHead(200, { "Content-Type": mimeTypes[extname(path)] || "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
let page;
const remote = new Map();
const sessions = new Map();
let counter = 0;
let pickerFixture = "unavailable";
let pickerRequests = 0;
let extractionOffline = false;
let uploadRequests = 0;
const extractionRequests = [];
const bytes = Buffer.from('Filewise browser smoke: original UTF-8 bytes.\n<img src=x onerror="window.__extractionXss=1">\n');
const file = (id, name, body = bytes) => ({ id, name, mimeType: "text/plain", size: String(body.length), parents: ["folder-A"], createdTime: "2026-01-01T00:00:00Z", modifiedTime: "2026-01-01T00:00:00Z", capabilities: { canDownload: true }, sha256Checksum: createHash("sha256").update(body).digest("hex"), _body: body });
const canonical = data => { const { _body, ...publicData } = data; return publicData; };
async function check(name, operation) {
  await operation();
  report.passed.push(name);
  console.log(`PASS ${name}`);
}
async function idle() {
  await page.waitForFunction(() => document.querySelector("#busy-indicator").hidden);
}
try {
  context = await chromium.launchPersistentContext(join(output, "profile"), {
    executablePath: process.env.BROWSER_EXE || undefined,
    headless: true, viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  });
  await context.addInitScript(({ configuredClientId, unconfiguredClientId }) => {
    const listeners = [];
    const getState = () => JSON.parse(localStorage.getItem("mockChromeSession") || "{}");
    const change = (changes) => listeners.forEach(listener => listener(changes, "session"));
    const configured = location.pathname.startsWith("/configured/");
    window.chrome = {
      runtime: {
        getManifest: () => ({ oauth2: { client_id: configured ? configuredClientId : unconfiguredClientId } }),
        getURL: path => `${location.origin}${configured ? "/configured/" : "/"}${path}`,
      },
      identity: {
        getAuthToken: async () => ({ token: `mock-token-${localStorage.getItem("mockAccount") || "A"}`, grantedScopes: ["https://www.googleapis.com/auth/drive.file"] }),
        removeCachedAuthToken: async () => {}, clearAllCachedAuthTokens: async () => {},
      },
      storage: {
        session: {
          get: async key => ({ [key]: getState()[key] }),
          set: async values => { const data = getState(); const changes = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: value }; data[key] = value; } localStorage.setItem("mockChromeSession", JSON.stringify(data)); change(changes); },
          remove: async key => { const data = getState(); const oldValue = data[key]; delete data[key]; localStorage.setItem("mockChromeSession", JSON.stringify(data)); change({ [key]: { oldValue } }); },
        },
        onChanged: { addListener: listener => listeners.push(listener) },
      },
      tabs: { create: async ({ url }) => { window.__openedUrl = url; } },
    };
  }, { configuredClientId: fixtures.configured.clientId, unconfiguredClientId: fixtures.unconfigured.clientId });
  // Only the local fixture server and the mock below can receive browser traffic.
  // An accidental Picker/external resource load cannot contact a real Google API.
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    return route.abort("blockedbyclient");
  });
  await context.route("https://www.googleapis.com/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const account = request.headers().authorization?.endsWith("B") ? "B" : "A";
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-upload-content-type,x-upload-content-length,content-range", "access-control-expose-headers": "location,content-length" };
    const send = (body, status = 200, extra = {}) => route.fulfill({ status, headers: { ...headers, "content-type": "application/json", ...extra }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (url.pathname.endsWith("/about")) return send({ user: { permissionId: account, displayName: account === "A" ? "Alice Example" : "Bob Example", emailAddress: `${account.toLowerCase()}@example.test` } });
    if (url.pathname.endsWith("/generateIds")) return send({ ids: [`generated-${account}-${++counter}`] });
    if (url.pathname === "/upload/drive/v3/files") {
      if (request.method() === "POST") {
        const metadata = request.postDataJSON();
        sessions.set(metadata.id, { ...metadata, account });
        return send({}, 200, { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${metadata.id}` });
      }
      const metadata = sessions.get(url.searchParams.get("upload_id"));
      assert.ok(metadata, "known mocked upload session");
      uploadRequests++;
      const body = request.postDataBuffer();
      const saved = { ...file(metadata.id, metadata.name, body), mimeType: metadata.mimeType, parents: metadata.parents };
      remote.set(`${account}:${saved.id}`, saved);
      return send(canonical(saved));
    }
    if (url.pathname === "/drive/v3/files" && request.method() === "POST") {
      const metadata = request.postDataJSON();
      const folder = { ...metadata, capabilities: { canAddChildren: true } };
      remote.set(`${account}:${folder.id}`, folder);
      return send(folder);
    }
    if (url.pathname === "/drive/v3/files") return send({ files: [...remote.entries()].filter(([key, data]) => key.startsWith(`${account}:`) && data.mimeType.includes("folder")).map(([, data]) => canonical(data)) });
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    const data = remote.get(`${account}:${id}`);
    if (!data) return send({ error: { errors: [{ reason: "notFound" }] } }, 404);
    if (url.searchParams.get("alt") === "media") return send(data._body, 200, { "content-type": data.mimeType, "content-length": String(data._body.length) });
    return send(canonical(data));
  });
  // Never contact a real companion service. Exercise raw-byte requests and CORS
  // with an isolated schema-1 fixture; Google tokens must stay in the extension.
  await context.route("http://127.0.0.1:8000/extractions?*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.pathname, "/extractions");
    assert.equal(request.headers().authorization, undefined);
    const headers = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-filewise-request",
      "content-type": "application/json",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    assert.equal(request.method(), "POST");
    assert.equal(request.headers()["x-filewise-request"], "extraction-v1");
    assert.equal(request.headers()["content-type"], "application/octet-stream");
    const body = request.postDataBuffer();
    extractionRequests.push({ filename: url.searchParams.get("filename"), body });
    if (extractionOffline) return route.abort("connectionrefused");
    const text = body.toString("utf8");
    return route.fulfill({ status: 200, headers, body: JSON.stringify({
      schema_version: 1, source_name: url.searchParams.get("filename"), file_type: "txt",
      extractor: "python", extractor_version: "test", extracted_at: "2026-01-01T00:00:00Z",
      status: "extracted", text, parts: [{ location: "document", text, page_number: null, needs_ocr: false }],
      ocr_pages: [], encoding: "utf-8", error: null,
    }) });
  });
  // This route never falls through to the user's real helper listening on 8765.
  // The retry uses a real cross-origin frame and MessageChannel without Google's SDK.
  await context.route("http://127.0.0.1:8765/**", async route => {
    pickerRequests++;
    if (pickerFixture === "unavailable") return route.abort("connectionrefused");
    return route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <title>Isolated Picker fixture</title><p id="fixture-status">Waiting for a trusted connection</p>
      <script>
        const parentOrigin = ${JSON.stringify(origin)};
        window.__fixtureInit = null;
        window.__sendReady = () => parent.postMessage({ type: "filewise-picker-ready" }, parentOrigin);
        addEventListener("message", event => {
          if (event.source !== parent || event.origin !== parentOrigin ||
              event.data?.type !== "filewise-picker-init" || !event.ports[0]) return;
          window.__fixturePort = event.ports[0];
          window.__fixtureInit = {
            trustedOrigin: event.origin === parentOrigin,
            trustedSource: event.source === parent,
            hasRealPort: event.ports[0] instanceof MessagePort,
            tokenIsFixture: event.data.token === "mock-token-A",
            keyIsFixture: event.data.apiKey === "test-public-picker-key",
            projectIsFixture: event.data.projectNumber === "123456789",
            mode: event.data.mode,
          };
          document.querySelector("#fixture-status").textContent = "Connected to the test message channel";
        });
      </script>` });
  });
  page = context.pages()[0];
  page.setDefaultTimeout(12000);
  page.on("requestfailed", request => console.log("REQUEST FAILED", request.url(), request.failure()?.errorText));
  page.on("console", message => { if (message.type() === "error") console.log("BROWSER", message.text()); });
  page.on("pageerror", error => report.errors.push(error.message));
  await check("Unconfigured setup disables connection and upload", async () => {
    await page.goto(`${origin}/app.html`);
    assert.equal(await page.evaluate(async () => {
      const { CONFIG } = await import("./config.js");
      return CONFIG.googlePickerApiKey === "" && CONFIG.googleProjectNumber === "" &&
        chrome.runtime.getManifest().oauth2.client_id === "";
    }), true, "Unconfigured UI uses only explicit test configuration");
    await page.waitForFunction(() => document.querySelector("#status-title").textContent.includes("setup"));
    assert.equal(await page.locator("#connect-button").isDisabled(), true);
    assert.equal(await page.locator("#upload-button").isDisabled(), true);
    await page.locator("#status-action").click();
    assert.equal(await page.locator("#setup-details").getAttribute("open"), "");
  });
  await check("Configured account A connects through UI", async () => {
    await page.goto(`${origin}/configured/app.html`);
    assert.equal(await page.evaluate(async () => {
      const { CONFIG } = await import("./config.js");
      return CONFIG.googlePickerApiKey === "test-public-picker-key" &&
        CONFIG.googleProjectNumber === "123456789" &&
        chrome.runtime.getManifest().oauth2.client_id === "test-client.apps.googleusercontent.com";
    }), true, "Configured UI uses only explicit test configuration");
    await page.locator("#connect-button").click();
    await page.waitForFunction(() => document.querySelector("#sidebar-account-name").textContent === "Alice Example");
    await idle();
  });
  await check("Unavailable local Picker stays hidden, clears busy, and retries through a trusted channel", async () => {
    const filesBefore = await page.locator(".file-name").count();
    const started = Date.now();
    await page.locator("#import-button").click();
    await page.waitForFunction(() => document.querySelector("#picker-dialog").open);
    assert.equal(await page.locator("#picker-frame").evaluate(frame => frame.hidden), true);
    assert.equal(await page.locator("#picker-loading").isVisible(), true);
    assert.equal(await page.locator("#busy-indicator").isVisible(), true);
    await page.waitForFunction(() => !document.querySelector("#picker-dialog").open, null, { timeout: 6000 });
    await idle();
    assert.ok(Date.now() - started < 7000, "Local failure must not wait for the HTTPS 20-second deadline");
    assert.equal(pickerRequests, 1, "Failed helper navigation was isolated by Playwright");
    assert.equal(await page.locator("#picker-frame").evaluate(frame => frame.hidden), true);
    assert.equal(await page.locator("#picker-frame").getAttribute("src"), null);
    assert.equal(await page.locator("#picker-loading").isVisible(), false);
    const errorToast = page.locator(".toast.error").last();
    assert.match(await errorToast.textContent(), /local Google Picker helper could not be reached/i);
    assert.match(await errorToast.textContent(), /Start-PickerBridge\.cmd/i);
    assert.equal(await page.locator("#import-button").isEnabled(), true);
    await errorToast.getByRole("button", { name: "Dismiss notification" }).click();

    pickerFixture = "ready";
    await page.locator("#import-button").click();
    await page.waitForFunction(() => document.querySelector("#picker-dialog").open);
    const frame = await (await page.locator("#picker-frame").elementHandle()).contentFrame();
    await frame.waitForFunction(() => typeof window.__sendReady === "function");
    // An unrelated window cannot reveal the frame or receive the token/MessagePort.
    await page.evaluate(() => window.postMessage({ type: "filewise-picker-ready" }, location.origin));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await frame.evaluate(() => window.__fixtureInit), null);
    assert.equal(await page.locator("#picker-frame").evaluate(frame => frame.hidden), true);
    await frame.evaluate(() => window.__sendReady());
    await frame.waitForFunction(() => window.__fixtureInit !== null);
    assert.deepEqual(await frame.evaluate(() => window.__fixtureInit), {
      trustedOrigin: true, trustedSource: true, hasRealPort: true,
      tokenIsFixture: true, keyIsFixture: true, projectIsFixture: true, mode: "files",
    });
    assert.equal(await page.locator("#picker-frame").isVisible(), true);
    assert.equal(await page.locator("#picker-loading").isVisible(), false);
    await frame.evaluate(() => window.__fixturePort.postMessage({ type: "cancel" }));
    await page.waitForFunction(() => !document.querySelector("#picker-dialog").open);
    await idle();
    assert.equal(await page.locator("#picker-frame").evaluate(frame => frame.hidden), true);
    assert.equal(await page.locator("#picker-frame").getAttribute("src"), null);
    assert.equal(await page.locator("#import-button").isEnabled(), true);
    assert.equal(await page.locator(".file-name").count(), filesBefore, "Picker cancellation adds no assets");
    assert.equal(pickerRequests, 2, "Retry used only the isolated helper fixture");
  });
  await check("TXT upload preserves original bytes and automatically extracts text", async () => {
    await page.locator("#upload-input").setInputFiles({ name: "meeting-notes.txt", mimeType: "text/plain", buffer: bytes });
    await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "meeting-notes.txt");
    await idle();
    assert.equal(await page.locator(".file-table .status-badge").textContent(), "Extracted");
    const data = [...remote.values()].find(item => item.name === "meeting-notes.txt");
    assert.deepEqual(data._body, bytes);
    assert.equal(extractionRequests.length, 1);
    assert.equal(extractionRequests[0].filename, "meeting-notes.txt");
    assert.deepEqual(extractionRequests[0].body, bytes);
  });
  await check("Text preview renders document markup as plain text", async () => {
    await page.locator('[data-action="view-text"]').click();
    await page.waitForFunction(() => document.querySelector("#extraction-dialog").open);
    await idle();
    assert.equal(await page.locator("#extraction-filename").textContent(), "meeting-notes.txt");
    assert.equal(await page.locator("#extraction-status").textContent(), "Extracted");
    assert.equal(await page.locator("#extraction-text").textContent(), bytes.toString("utf8"));
    assert.equal(await page.locator("#extraction-text img").count(), 0);
    assert.equal(await page.evaluate(() => window.__extractionXss), undefined);
    await page.screenshot({ path: join(output, "extraction-preview.png"), fullPage: true });
    await page.locator('[data-action="close-extraction"]').click();
    assert.equal(await page.locator("#extraction-dialog").evaluate(dialog => dialog.open), false);
  });
  await check("Filename search updates visible totals without losing records", async () => {
    await page.locator("#file-search").fill("unmatched-name");
    assert.equal(await page.locator("#visible-count").textContent(), "0");
    assert.match(await page.locator("#library-footer-count").textContent(), /0 of 1/);
    await page.locator("#file-search").fill("meeting");
    assert.equal(await page.locator(".file-name").count(), 1);
    await page.locator("#file-search").fill("");
  });
  await check("Reload restores extracted text from IndexedDB without extracting again", async () => {
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "meeting-notes.txt");
    await idle();
    assert.equal(await page.locator(".file-table .status-badge").textContent(), "Extracted");
    await page.locator('[data-action="view-text"]').click();
    await page.waitForFunction(() => document.querySelector("#extraction-dialog").open);
    await idle();
    assert.equal(await page.locator("#extraction-text").textContent(), bytes.toString("utf8"));
    assert.equal(extractionRequests.length, 1);
    await page.locator('[data-action="close-extraction"]').click();
  });
  await check("Download returns the original byte-for-byte", async () => {
    const waiting = page.waitForEvent("download");
    await page.locator('[data-action="download"]').click();
    const download = await waiting;
    const target = join(output, "downloaded-original.txt");
    await download.saveAs(target);
    assert.deepEqual(await readFile(target), bytes);
    assert.equal(download.suggestedFilename(), "meeting-notes.txt");
    await idle();
  });
  await check("Account change closes and clears text preview; B cannot see A records", async () => {
    await page.locator('[data-action="view-text"]').click();
    await page.waitForFunction(() => document.querySelector("#extraction-dialog").open);
    await idle();
    // A different extension tab can change the session while this modal is open.
    await page.evaluate(async () => {
      localStorage.setItem("mockAccount", "B");
      await chrome.storage.session.set({ activeAccount: { id: "B", epoch: "changed-in-another-tab" } });
    });
    assert.equal(await page.locator("#extraction-dialog").evaluate(dialog => dialog.open), false);
    assert.equal(await page.locator("#extraction-text").textContent(), "");
    assert.equal(await page.locator("#extraction-filename").textContent(), "");
    await page.locator("#connect-button").click();
    await page.waitForFunction(() => document.querySelector("#sidebar-account-name").textContent === "Bob Example");
    await idle();
    assert.equal(await page.locator(".file-name").count(), 0);
    assert.equal(await page.locator('[data-action="view-text"]').count(), 0);
    await page.evaluate(() => localStorage.setItem("mockAccount", "A"));
    await page.locator("#switch-button").click();
    await page.waitForFunction(() => document.querySelector(".file-name")?.textContent === "meeting-notes.txt");
    await idle();
  });
  await check("Offline extraction keeps the Drive upload and retries without uploading again", async () => {
    extractionOffline = true;
    const offlineBytes = Buffer.from("Saved in Drive even if the extraction service is stopped.\n");
    const uploadsBefore = uploadRequests;
    await page.locator("#upload-input").setInputFiles({ name: "offline-notes.txt", mimeType: "text/plain", buffer: offlineBytes });
    await page.locator(".file-name", { hasText: "offline-notes.txt" }).waitFor();
    await idle();
    const row = page.locator(".file-table tbody tr").filter({ hasText: "offline-notes.txt" });
    assert.equal(await row.locator(".status-badge").textContent(), "Extraction failed");
    assert.match(await row.locator(".status-badge").getAttribute("title"), /local extraction service/i);
    assert.equal(await row.getByRole("button", { name: "Retry extraction for offline-notes.txt" }).isEnabled(), true);
    assert.equal(await page.locator("#pending-section").isVisible(), false, "Successful Drive upload is not an interrupted upload");
    const remoteFile = [...remote.values()].find(item => item.name === "offline-notes.txt");
    assert.deepEqual(remoteFile._body, offlineBytes);
    assert.equal(uploadRequests, uploadsBefore + 1);
    extractionOffline = false;
    await row.getByRole("button", { name: "Retry extraction for offline-notes.txt" }).click();
    await idle();
    assert.equal(await row.locator(".status-badge").textContent(), "Extracted");
    assert.equal(uploadRequests, uploadsBefore + 1, "Retry extracts the already-saved Drive file");
    assert.equal([...remote.values()].filter(item => item.name === "offline-notes.txt").length, 1);
    await row.locator('[data-action="view-text"]').click();
    await page.waitForFunction(() => document.querySelector("#extraction-dialog").open);
    await idle();
    assert.equal(await page.locator("#extraction-text").textContent(), offlineBytes.toString("utf8"));
    await page.locator('[data-action="close-extraction"]').click();
  });
  await check("Canonical import deduplicates and safely renders hostile filenames", async () => {
    remote.set("A:imported-xss", file("imported-xss", '<img src=x onerror="window.__xss=1">.txt'));
    const count = await page.evaluate(async () => {
      const [{ Library }, { LibraryStore }, { ChromeAuth }, { DriveClient }, { CONFIG }] = await Promise.all([import("./src/library.js"), import("./src/store.js"), import("./src/auth.js"), import("./src/drive.js"), import("./config.js")]);
      const auth = new ChromeAuth(); const session = await auth.current();
      const library = new Library({ store: new LibraryStore(), auth, session, drive: new DriveClient({ getToken: () => auth.tokenFor(session) }), config: CONFIG });
      return library.importFiles(["imported-xss", "imported-xss"]);
    });
    assert.equal(count, 1);
    await page.locator("#refresh-button").click(); await idle();
    assert.equal(await page.locator(".file-name").count(), 3);
    assert.equal(await page.locator("#library-content img").count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  });
  await check("Pending journal survives reload and exposes original-file retry", async () => {
    await page.evaluate(async () => {
      const { LibraryStore } = await import("./src/store.js");
      await new LibraryStore().put("operations", "A", "pending-smoke", { operationId: "pending-smoke", driveFileId: "missing-upload", name: "unfinished.txt", status: "needs_attention", error: "Simulated interruption; choose the original file to resume.", size: 10 });
    });
    await page.reload();
    await page.locator('[data-action="retry"]').waitFor(); await idle();
    assert.match(await page.locator("#pending-list").textContent(), /unfinished\.txt/);
    assert.equal(await page.locator('[data-action="forget"]').count(), 0);
    const waiting = page.waitForEvent("filechooser");
    await page.locator('[data-action="retry"]').click();
    assert.equal((await waiting).isMultiple(), false);
  });
  await check("Desktop and mobile layouts fit their viewport", async () => {
    await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check("Unsupported remote replacement stays removed after another text preview", async () => {
    const entry = [...remote.entries()].find(([, value]) => value.name === "offline-notes.txt");
    const original = Buffer.from(entry[1]._body);
    const staleRow = page.locator(".file-table tbody tr").filter({ hasText: "offline-notes.txt" });
    assert.equal(await staleRow.locator(".status-badge").textContent(), "Extracted");
    // The same Drive ID now represents a type Filewise does not support.
    Object.assign(entry[1], { name: "offline-notes.bin", mimeType: "application/octet-stream", modifiedTime: "2026-02-01T00:00:00Z" });
    await page.locator("#refresh-button").click();
    await idle();
    assert.equal(await page.locator(".file-name").count(), 2);
    assert.equal(await page.locator(".file-name", { hasText: "offline-notes" }).count(), 0);
    const supportedRow = page.locator(".file-table tbody tr").filter({ hasText: "meeting-notes.txt" });
    await supportedRow.locator('[data-action="view-text"]').click();
    await page.waitForFunction(() => document.querySelector("#extraction-dialog").open);
    await idle();
    assert.equal(await page.locator("#extraction-text").textContent(), bytes.toString("utf8"));
    await page.locator('[data-action="close-extraction"]').click();
    assert.equal(await page.locator(".file-name").count(), 2, "Preview must not restore the stale cached asset");
    assert.equal(await page.locator(".file-name", { hasText: "offline-notes" }).count(), 0);
    assert.equal(remote.get(entry[0]).name, "offline-notes.bin", "Unsupported original stays in Drive");
    assert.deepEqual(remote.get(entry[0])._body, original);
  });
  await check("Refresh removes files when Google returns permission/missing 404", async () => {
    const entry = [...remote.entries()].find(([, value]) => value.name === "meeting-notes.txt");
    remote.delete(entry[0]);
    await page.locator("#refresh-button").click(); await idle();
    assert.equal(await page.locator(".file-name").count(), 1);
    assert.equal(await page.locator('.file-name', { hasText: "meeting-notes.txt" }).count(), 0);
  });
  assert.deepEqual(report.errors, [], "No browser JavaScript errors");
  console.log(`PASS ${report.passed.length} browser smoke checks; no page errors`);
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  if (page) await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Artifacts: ${output}`);
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
