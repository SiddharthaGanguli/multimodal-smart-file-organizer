// Optional integration check against the running local Python service.
// npm install --no-save --package-lock=false playwright
// Set BROWSER_EXE to a Chromium/Edge executable supporting --load-extension.
// node tests/extraction-extension-smoke.mjs [directory containing verification.json]
// Generate fictional fixtures with: python examples/check_reports.py
// Uses a new isolated browser profile. No Google sign-in or real Drive requests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = resolve(process.argv[2] || process.env.FILEWISE_FIXTURES || join(extension, "../../storage/report-checks"));
const output = resolve(extension, "../../tmp/extension-tests", `extension-extraction-${Date.now()}`);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")
  .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
assert.equal(extensionId, "llobmhbiebleflpmbfdobhbkecbgefab");
const extensionOrigin = `chrome-extension://${extensionId}`;
const runtime = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(runtime ? pathToFileURL(resolve(runtime)).href : "playwright");
const checks = JSON.parse(await readFile(join(fixtures, "verification.json"), "utf8"));
const types = { ".txt": "text/plain", ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
const report = { extensionId, passed: [], requests: [], errors: [], limitations: ["Real extension and local extraction API; Google Drive and OAuth are not exercised."] };
const requestChecks = [];
let context;
let page;

try {
  context = await chromium.launchPersistentContext(join(output, "profile"), {
    executablePath: process.env.BROWSER_EXE || undefined,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.protocol === "chrome-extension:" && url.hostname === extensionId) return route.continue();
    if (url.origin === "http://127.0.0.1:8000") return route.continue();
    return route.abort("blockedbyclient");
  });
  context.on("request", request => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:8000") return;
    requestChecks.push((async () => {
      const headers = await request.allHeaders();
      const record = { url: request.url(), method: request.method(), origin: headers.origin, authorizationPresent: Boolean(headers.authorization) };
      report.requests.push(record);
      assert.equal(headers.authorization, undefined, "No Google token may reach the companion");
      if (request.method() === "POST") {
        assert.equal(headers.origin, extensionOrigin, "Real browser sends the installed extension Origin");
        assert.equal(headers["x-filewise-request"], "extraction-v1");
      }
    })());
  });
  page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  try {
    await page.goto(`${extensionOrigin}/app.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch (error) {
    throw new Error(`Unpacked extension did not load in this browser. Use a Chromium or Edge build that permits --load-extension. ${error.message}`);
  }
  assert.equal(await page.evaluate(() => chrome.runtime.id), extensionId);
  assert.equal(await page.locator("#connection-label").textContent(), "Drive not connected");
  await page.evaluate(() => {
    window.__extractionCspViolations = [];
    document.addEventListener("securitypolicyviolation", event => {
      window.__extractionCspViolations.push({ directive: event.violatedDirective, blockedUri: event.blockedURI });
    });
  });
  for (const check of checks) {
    const name = basename(check.source.replaceAll("\\", "/"));
    const source = join(fixtures, name);
    const original = await readFile(source);
    const mimeType = types[extname(name)];
    assert.ok(mimeType, `Known fixture type for ${name}`);
    const result = await page.evaluate(async ({ name, mimeType, base64 }) => {
      const { LocalExtractor } = await import("./src/extraction.js");
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      return new LocalExtractor().extract(new Blob([bytes], { type: mimeType }), { name, mimeType });
    }, { name, mimeType, base64: original.toString("base64") });
    assert.equal(result.schema_version, 1);
    assert.equal(result.source_name, name);
    assert.equal(result.status, check.expected_status);
    assert.deepEqual(result.ocr_pages, check.expected_ocr_pages);
    if (extname(name) === ".pdf") {
      assert.deepEqual(result.text.trim().split(/\s+/u), check.expected_text.trim().split(/\s+/u));
    } else assert.equal(result.text, check.expected_text);
    assert.deepEqual(await readFile(source), original, "Original fixture remains unchanged");
    await writeFile(join(output, `${name}.json`), JSON.stringify(result, null, 2));
    report.passed.push(`${name}: ${result.status}, expected text and OCR pages`);
    console.log(`PASS ${report.passed.at(-1)}`);
    if (result.ocr_pages.length) {
      // Exercise the integration boundary using real companion output and packaged OCR.
      const recognized = await page.evaluate(async ({ base64, result }) => {
        const { recognize } = await import("./src/ocr/browser.js");
        const { createView } = await import("./src/view.js");
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const view = createView();
        const asset = { assetId: "mixed-scan", name: result.source_name, mimeType: "application/pdf",
          size: bytes.length, processingStatus: result.status, extraction: result };
        view.render({ configured: true, connected: true, assets: [asset], ocr: {}, pending: [] });
        view.showExtraction(result);
        window.__combinedView = view;
        return recognize(new Blob([bytes], { type: asset.mimeType }), {
          mimeType: asset.mimeType, pageNumbers: result.ocr_pages,
        });
      }, { base64: original.toString("base64"), result });
      assert.equal(recognized.status, "complete");
      assert.deepEqual(recognized.pages.map(item => item.pageNumber), [2]);
      assert.match(recognized.text, /Scanned invoice: INR 300/i);
      assert.match(await page.locator("#extraction-hint").textContent(), /Read scan/);
      assert.equal(await page.locator('[data-action="ocr"]').textContent(), "Read scan");
      assert.equal(await page.locator('[data-action="view-text"]').textContent(), "View text");
      assert.equal(await page.locator("#extraction-text").textContent(), result.text);
      await page.evaluate(() => window.__combinedView.closeExtraction());
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(output, "combined-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      assert.deepEqual(await readFile(source), original);
      report.passed.push("Mixed PDF: companion identifies page 2; local OCR reads it; both actions and previews coexist");
      console.log(`PASS ${report.passed.at(-1)}`);
    }
  }
  await Promise.all(requestChecks);
  assert.equal(report.requests.filter(request => request.method === "POST").length, checks.length);
  assert.deepEqual(await page.evaluate(() => window.__extractionCspViolations), [], "No CSP violations");
  assert.deepEqual(report.errors, [], "No page errors");
  await page.screenshot({ path: join(output, "installed-extension.png"), fullPage: true });
  console.log(`PASS ${checks.length} actual-extension extraction checks; real browser Origin, no Authorization or CSP violations`);
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  if (page) await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  // Observe all asynchronous header checks even when a preceding test fails.
  const results = await Promise.allSettled(requestChecks);
  for (const result of results) {
    if (result.status === "rejected") {
      report.errors.push(result.reason.message);
      process.exitCode = 1;
    }
  }
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Artifacts: ${output}`);
  await context?.close();
}
