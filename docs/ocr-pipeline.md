# OCR pipeline — issue #4

Filewise 0.2.1 reads English printed text from JPG/JPEG, PNG, and scanned PDFs.
Use Chrome 125 or newer, matching the PDF.js legacy build's
[supported browsers](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported).
It uses Tesseract.js 7 (Tesseract compiled to WebAssembly) and PDF.js rasterization
inside the Chrome extension. Users do not install Python, pytesseract, a server,
or additional software. Recognition assets are bundled, so OCR itself makes no
external requests. Downloading the original and checking Drive access still need
an internet connection.

## Using it

1. Close existing Filewise tabs and reload the extension at `chrome://extensions`.
2. Open Filewise and connect Drive. Upload an image/PDF or add one from Drive.
3. Choose **Read text** beside an image or **Read scan** beside a PDF. Keep the tab open until it finishes.
4. Review the selectable text, original page numbers, and confidence values.
   **View OCR text** reopens saved OCR results; **Read again** reruns recognition.
5. **Cancel reading**, **Close**, or Escape stops the active job. Switching accounts
   in another tab also cancels it and clears displayed text.

English is the only bundled language. Low confidence (below 60) is marked for review;
the score is an engine heuristic, not a measured percentage of correct characters.
Version 0.2.1 explicitly enables automatic page segmentation for column layouts
and renders PDFs at a target of 300 DPI within the existing pixel limits, following
[Tesseract's quality guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html).
The processing version invalidates older saved results so **Read text** uses the
updated settings. Complex tables and layouts still require checking reading order.
Handwriting, skewed/rotated photographs, low contrast, and blur may produce incorrect
or empty output. Auto-rotation is enabled, but this is not a general photo correction
pipeline. Compare important text against the original.

## Limits and failure states

- 20 MB per original; up to 25 PDF pages per UI job. Split larger PDFs first.
- Images are checked before decoding (40 million source pixels maximum).
- Each raster is capped at 12 million pixels and 8192 pixels per side.
- 45 seconds per page and 3 minutes per OCR job, including parser/model startup.
  Drive download has the existing client timeout and byte limit.
- Up to one million recognized characters per job.
- Protected, malformed, empty, oversized, cancelled, and failed inputs have explicit
  states. A failed page can preserve previous successful pages as `partial`.
  Blank pages have `empty` status. Job cancellation discards incomplete text.
- Workers terminate on completion, cancellation, crash, and timeout. Page resources
  are released after each page. Closing/reloading the tab abandons the in-memory job;
  there is no automatic background resume. Start **Read text** again.

## Storage and authorization

IndexedDB database `filewise-library-v1` now uses schema version 2. The upgrade adds
`ocrResults` and preserves assets, upload operations, and settings. Its compound key
is `[accountId, driveFileId]`, following the existing account separation.

Results contain text, per-page status/confidence, source page numbers, engine/model
version, language, timestamps, and a source fingerprint. Originals remain in Drive;
downloaded bytes and rendered images are transient. Recognized text is stored only
in this Chrome profile, not in Drive or a server. Removing extension data/uninstalling
loses these derived results; originals can be registered and read again on another
device. Disconnect hides results but retains that account's local cache.

Every result read rechecks canonical Drive metadata, download permission, and the
current account/session. Downloads are size-checked and compared with the available
SHA-256. A changed source or engine version invalidates cached text. Metadata is
checked again before committing new results; account changes cannot commit or show
stale work. A refresh prunes results for removed or changed files. Concurrent reads
of the same file are serialized with a browser lock. A failed local commit is shown
as a failure, not a successful save.

## Interface for issue #3

Document extraction from issue #3 (PR #20) runs through the local Python companion.
TXT/DOCX and embedded PDF text use **Extract text** / **View text**; image and scanned
PDF OCR use separate actions and need no companion. OCR does not change the asset's
`processingStatus`; OCR state lives in its own store. Automatic OCR fallback and
combining both outputs remain future integration work.

For future automatic fallback in the extension, call the browser entry point with the
authorized original Blob and the source page numbers that need OCR:

```js
import { recognize } from "../ocr/browser.js"; // adjust to the caller's directory

const result = await recognize(originalBlob, {
  mimeType: "application/pdf",
  pageNumbers: [2, 5], // optional; omit to read every page (maximum 25)
  signal: abortController.signal,
  onProgress: ({ stage, pageNumber, fraction }) => { /* update the UI */ },
});
```

Page numbers are one-based, deduplicated, and processed in order. A selected subset
may target a PDF larger than 25 pages, with at most 25 selected pages per call.
Images use page 1. Progress fractions are per engine step/page, not whole-job totals.
The API returns a plain JSON-compatible object:

```js
{
  schemaVersion: 1,
  method: "ocr",
  engineVersion: "tesseract.js-7.0.0/eng-best-int-1.0.0/pdfjs-6.3.289/layout-2",
  language: "eng",
  status: "complete", // needs_review | empty | partial | failed | cancelled
  startedAt: "ISO timestamp", completedAt: "ISO timestamp",
  pageCount: 5, requestedPages: [2, 5],
  pages: [
    { pageNumber: 2, status: "complete", text: "...", confidence: 95,
      width: 1224, height: 1584 },
    { pageNumber: 5, status: "empty", text: "", confidence: 0,
      width: 1224, height: 1584 }
  ],
  text: "..." // non-empty page text joined with two newlines
  // error: { code, message } on job failure/cancellation;
  // failed pages also carry error and have confidence: null
}
```

Consumers must inspect `status` and `requestedPages`; partial/subset output is not
complete document extraction. `recognize` does not authorize or persist anything.
`OcrLibrary.read(assetId, { force, signal, onProgress })` supplies the existing
extension's authorization/cache layer for the all-pages UI workflow.

The Python companion returns `ocr_pages`; a future extension orchestration step can
pass those page numbers to this browser adapter, which needs DOM/Workers and cannot
be imported into Python. No additional backend route or transport is introduced by
issue #4.

## Verification

From `frontend/extension`, run `npm test` (Node 22+) and the optional Playwright
runners. See `tests/browser-smoke.mjs` for installation and executable overrides.

```sh
node tests/browser-smoke.mjs
node tests/ocr-browser.mjs
```

With the Python companion running and `python examples/check_reports.py` fixtures
generated, `node tests/extraction-extension-smoke.mjs` checks TXT/DOCX/PDF extraction
and a mixed PDF whose scanned page is read by the bundled OCR adapter. This verifies
the integration interface; the normal UI still starts OCR on demand.

The first uses real DOM/IndexedDB with mocked Google responses. It checks the upload
to OCR flow, reload persistence, account changes, permission revocation/retry, source
invalidation, and migration from a populated v1 database. The second loads the actual
extension and CSP in isolated Chromium, blocks HTTP(S), and runs real Tesseract on
deterministic clear/blurred images, image-only PDFs, blank/corrupt inputs, and cancellation.
It checks original PDF page references, two-column image/PDF reading order, and
literal result rendering on desktop/mobile. The column-order regression reproduced
line-by-line interleaving before automatic page segmentation was enabled.
Node tests cover state aggregation, deadlines, cleanup, resource limits, ownership,
integrity failures, cache behavior, failed commits, and vendored-file hashes.

On 2026-10-01, the maintainer shared OCR output from all four pages of
`Ai_Automation.pdf` (confidence 85%, 88%, 86%, 91%). This confirms the live PDF reading
flow displayed results, but the output interleaves columns. A subsequent 0.2.1 check
used the actual four-page PDF from Downloads inside an isolated installed extension,
with HTTP(S) blocked. All four pages completed in 26.9 seconds, with confidence
94%, 95%, 94%, 94%. The original file's SHA-256 stayed unchanged. Visual comparison
against Poppler-rendered source pages and section-order checks confirmed that the
body reads down the left column before the right column, and the title is recovered.
Minor symbol/footnote errors and missing diagram labels remain; these confidence
scores are not measured character accuracy. The source has an embedded text layer,
so the issue #3 extraction workflow is preferred for this kind of PDF.

Verification of 0.2.1: 154 Node tests, 10 installed-extension OCR checks, and 19
browser workflow checks passed. After integrating PR #20, 55 Python tests and the
installed-extension companion checks (four documents plus mixed-PDF OCR) also passed.
This local real-document check does not replace
the remaining live Drive/account scenarios below.

Remaining live acceptance with the maintainer's own Drive files:

- [ ] Read a clear image and a scanned PDF through the configured Google project.
- [x] Rerun the actual `Ai_Automation.pdf` with 0.2.1 and compare column order with the original (local installed-extension check).
- [ ] Reopen saved results, cancel a longer scan, and verify originals stay unchanged.
- [ ] Try a real degraded/photographed example and compare OCR with its source.

Dependencies and notices: [vendor inventory](../frontend/extension/vendor/README.md).
The extension enables only the WASM CSP allowance permitted by
[Chrome's extension policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).
It keeps local script/worker sources and does not enable JavaScript `unsafe-eval`.
