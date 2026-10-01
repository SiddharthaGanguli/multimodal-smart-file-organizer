// Real packaged workers + installed MV3 CSP. No Google account or service used.
// Run like browser-smoke.mjs with optional PLAYWRIGHT_MODULE and BROWSER_EXE.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const output = join(root, "test-results", `ocr-${Date.now()}`);
await mkdir(output, { recursive: true });
const report = { passed: [], results: {}, errors: [], externalRequests: [] };
const context = await chromium.launchPersistentContext(join(output, "profile"), {
  executablePath: process.env.BROWSER_EXE || undefined, headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1280, height: 900 },
});
try {
  await context.route(/^https?:/, route => { report.externalRequests.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", msg => { if (msg.type() === "error") console.log("BROWSER", msg.text().slice(0, 300)); });
  await page.goto("chrome-extension://llobmhbiebleflpmbfdobhbkecbgefab/app.html");
  await page.evaluate(async () => {
    window.ocr = await import("./src/ocr/browser.js");
    window.fixture = async ({ blank = false, degraded = false, jpeg = false, text = "FILEWISE INVOICE 2026", width = 1200 } = {}) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = 420;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
      if (!blank) {
        context.fillStyle = degraded ? "#929292" : "#111";
        context.font = "bold 52px Arial";
        if (degraded) context.filter = "blur(1.2px)";
        context.fillText(text, 45, 110); context.font = "38px Arial";
        context.fillText("Payment received. Total 1250 dollars.", 45, 200);
        context.fillText("Thank you for your order.", 45, 275);
      }
      const blob = await new Promise(resolve => canvas.toBlob(resolve, jpeg ? "image/jpeg" : "image/png", degraded ? 0.6 : 0.95));
      canvas.width = canvas.height = 0;
      return blob;
    };
    window.columnFixture = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 1800; canvas.height = 1200;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "black"; ctx.font = "28px Georgia";
      const columns = [
        ["LEFT COLUMN START", "This paper describes a personal file library.", "Users keep their original documents in Drive.",
          "Each account has separate records and settings.", "The application reads the selected image locally.",
          "Text recognition helps people find their files.", "A clear scan gives better results than a blur.",
          "The original page number stays with the text.", "Readers can check each result against its source.",
          "This section explains the first part of the work.", "A second section follows after this conclusion.", "LEFT COLUMN FINISH"],
        ["RIGHT COLUMN START", "The next section describes the proposed tests.", "Each test uses a file with known text and layout.",
          "A document can contain more than one column.", "Reading across both columns changes the meaning.",
          "The correct order follows each column downward.", "Headings and paragraphs help organize the page.",
          "Images and tables require additional attention.", "Confidence alone cannot prove the reading order.",
          "The reviewer compares the output with the source.", "These checks improve the quality of stored text.", "RIGHT COLUMN FINISH"],
      ];
      columns.forEach((lines, column) => lines.forEach((line, row) => ctx.fillText(line, 70 + column * 890, 90 + row * 62)));
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.95));
      canvas.width = canvas.height = 0;
      return blob;
    };
    // Image-only PDF, with no embedded text operators; validates actual OCR.
    window.scanPdf = async (columns = false) => {
      const encoder = new TextEncoder(); const chunks = []; let position = 0; const offsets = [0];
      const append = chunk => { const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk; chunks.push(bytes); position += bytes.length; };
      const object = (n, value) => { offsets[n] = position; append(`${n} 0 obj\n${value}\nendobj\n`); };
      append("%PDF-1.4\n");
      object(1, "<< /Type /Catalog /Pages 2 0 R >>");
      object(2, "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>");
      for (const [n, label] of [[3, "FILEWISE INVOICE 2026"], [6, "SECOND PAGE RECEIPT"]]) {
        const width = columns ? 1800 : 1200; const height = columns ? 1200 : 420;
        const blob = columns ? await window.columnFixture() : await window.fixture({ jpeg: true, text: label });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width / 2} ${height / 2}] /Resources << /XObject << /Scan ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>`);
        offsets[n + 1] = position;
        append(`${n + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
        append(bytes); append("\nendstream\nendobj\n");
        const content = `q ${width / 2} 0 0 ${height / 2} 0 0 cm /Scan Do Q`;
        object(n + 2, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      }
      const xref = position;
      append("xref\n0 9\n0000000000 65535 f \n");
      for (let i = 1; i < 9; i++) append(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
      append(`trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
      return new Blob(chunks, { type: "application/pdf" });
    };
  });
  async function check(name, run) { await run(); report.passed.push(name); console.log(`PASS ${name}`); }
  for (const [name, options] of [["clear PNG", {}], ["degraded JPEG", { jpeg: true, degraded: true }]]) {
    await check(name, async () => {
      const result = await page.evaluate(async options => ocr.recognize(await fixture(options)), options);
      report.results[name] = result;
      assert.match(result.text, /FILEWISE INVOICE 2026/i, JSON.stringify(result));
      assert.ok(["complete", "needs_review"].includes(result.status));
      assert.equal(result.pages[0].pageNumber, 1);
    });
  }
  await check("scanned PDF with original page references", async () => {
    const result = await page.evaluate(async () => ocr.recognize(await scanPdf()));
    report.results.pdf = result;
    assert.match(result.pages[0]?.text || "", /FILEWISE INVOICE/i, JSON.stringify(result));
    assert.match(result.pages[1]?.text || "", /SECOND PAGE RECEIPT/i, JSON.stringify(result));
    assert.deepEqual(result.pages.map(p => p.pageNumber), [1, 2]);
  });
  await check("selected PDF page preserves source number", async () => {
    const result = await page.evaluate(async () => ocr.recognize(await scanPdf(), { pageNumbers: [2] }));
    assert.deepEqual(result.pages.map(p => p.pageNumber), [2]); assert.match(result.text, /SECOND PAGE/);
  });
  for (const type of ["image", "PDF"]) await check(`two-column ${type} keeps left column before right column`, async () => {
    const result = await page.evaluate(async type => ocr.recognize(type === "PDF" ? await scanPdf(true) : await columnFixture(), { pageNumbers: [1] }), type);
    report.results[`columns-${type}`] = result;
    for (const phrase of ["LEFT COLUMN START", "LEFT COLUMN FINISH", "RIGHT COLUMN START", "RIGHT COLUMN FINISH"]) assert.ok(result.text.includes(phrase), JSON.stringify(result));
    assert.ok(result.text.indexOf("LEFT COLUMN FINISH") < result.text.indexOf("RIGHT COLUMN START"), "Columns must not be merged line by line");
  });
  await check("blank image has an explicit empty state", async () => {
    const result = await page.evaluate(async () => ocr.recognize(await fixture({ blank: true })));
    assert.equal(result.status, "empty"); assert.equal(result.text, "");
  });
  await check("damaged image and PDF have failure states", async () => {
    for (const type of ["image/png", "application/pdf"]) {
      const result = await page.evaluate(type => ocr.recognize(new Blob(["broken data"], { type })), type);
      assert.equal(result.status, "failed"); assert.equal(result.text, "");
    }
  });
  await check("cancel during worker startup finishes promptly", async () => {
    const result = await page.evaluate(async () => {
      const controller = new AbortController();
      return ocr.recognize(await fixture(), { signal: controller.signal, onProgress: p => { if (p.stage === "loading") setTimeout(() => controller.abort(), 10); } });
    });
    assert.equal(result.status, "cancelled"); assert.equal(result.text, "");
    await page.waitForTimeout(150);
    assert.equal(page.workers().length, 0, "all PDF/Tesseract workers terminated");
  });
  await check("result dialog displays literal text and fits mobile", async () => {
    await page.evaluate(async result => {
      const { createOcrView } = await import("./src/ocr/view.js");
      const view = createOcrView({ onCancel() {}, onRetry() {} });
      view.start({ assetId: "fixture", name: "Invoice scan.pdf" });
      result.pages[0].text += '\n<img src=x onerror="window.xss=true">';
      view.show(result);
    }, report.results.pdf);
    assert.equal(await page.locator("#ocr-pages img").count(), 0);
    await page.screenshot({ path: join(output, "ocr-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(output, "ocr-mobile.png") });
  });
  assert.deepEqual(report.externalRequests, [], "no runtime external downloads");
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await context.close();
  console.log(`Report: ${output}`);
}
