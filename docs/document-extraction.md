# Milestone 2: document extraction

This milestone extracts text from TXT, DOCX, and PDF files with status and provenance.
Filewise uses a local Python companion and stores the result on the account's library asset.
The separate CLI writes JSON files. Start with `app/extractors/service.py` to follow the parsers.

## Small, predictable structure

```text
app/
  main.py                  FastAPI routes and extension-origin CORS
  api/extraction.py        Bounded temporary uploads and extraction response
  core/config.py           Environment settings, including STORAGE_DIR
  extractors/
    __init__.py            Public imports
    __main__.py            Command-line entry point
    models.py              Shared result fields and statuses
    service.py             Select format, handle failures, save JSON
    txt.py                 TXT decoding
    docx.py                DOCX paragraphs and tables
    pdf.py                 PDF pages and OCR detection
tests/
  test_extraction.py       Extraction and command-line tests
  test_extraction_api.py   API permissions, real documents, limits and cleanup
  test_health.py           Existing API health test
frontend/extension/src/
  extraction.js            Local companion client, no Google credentials
  library.js               Account checks, Drive download, result persistence
storage/extractions/       CLI-generated JSON only (ignored by Git)
```

The other backend packages retain their planned responsibilities. They are
placeholders for later work; you do not need to edit them for this milestone.
There are no base classes, plugin registries, or separate repository layers here.

## Setup and run on Windows

From the repository directory, using Python 3.11–3.13:

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
.venv\Scripts\python.exe -m app.extractors "C:\documents\invoice.pdf"
```

Try the included sample immediately:

```powershell
.venv\Scripts\python.exe -m app.extractors examples/invoice.txt
```

If `.venv` is already installed, only run the last command. Alternatively use
`uv venv --python 3.12 .venv` and `uv pip install --python .venv\Scripts\python.exe -e ".[dev]"`.

The command prints the status and the saved JSON path. By default, results go to
`STORAGE_DIR/extractions` (`storage/extractions` relative to the current working
directory). Choose another directory with `--output-dir "C:\private\results"`.
Every run creates a new file, including failed extraction attempts. Original
files are opened only for reading. Exit code is 1 for a failed extraction or a
save error; `needs_ocr` and `empty` are valid results with exit code 0.

## Use extraction in Filewise

After installing the Python dependencies, run this from the repository root:

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Keep the terminal open while extracting. Reload Filewise at `chrome://extensions` after
updating its manifest, then reopen the extension tab. Version 0.2.0 keeps the shared
extension ID `llobmhbiebleflpmbfdobhbkecbgefab`.

- New TXT, DOCX and PDF uploads or imports trigger extraction automatically.
- Existing library files have **Extract text**; **View text** opens the saved result.
- If the service is stopped, the original stays in Drive. Start it and select **Retry extraction**.
- Scanned PDF pages show **OCR needed**; actual OCR is not implemented yet.

The extension downloads the authorized Drive file and sends its bytes to the companion.
The companion deletes the temporary original after parsing and returns schema-1 JSON.
It does not save API results or receive Google tokens. Filewise stores results in
account-scoped IndexedDB, clears stale results when the Drive version changes, and checks
current download permission before showing text. Drive storage works without the companion.

The API accepts `POST /extractions?filename=<basename>` with a raw body,
`Content-Type: application/octet-stream` and `X-Filewise-Request: extraction-v1`.
Its allowed browser origin is the shared Filewise extension. Uploads are limited to 20 MiB;
DOCX archives are also limited to 100 MiB expanded and 2,000 entries. Filenames are metadata,
not server paths. The API accepts no remote URL or arbitrary local-file input.

## Python entry points

```python
from app.extractors import extract_document, extract_and_store

result = extract_document("invoice.pdf")  # Return a result without saving it.
print(result.status, result.text, result.ocr_pages)

result, json_path = extract_and_store("invoice.pdf")  # Also save the result.
```

The HTTP companion calls `extract_document`; the CLI calls `extract_and_store`.
CLI JSON persistence is separate from Filewise's account-scoped IndexedDB records and
does not replace Drive originals.

## Result format

| Field | Meaning |
|---|---|
| `schema_version` | Version of this JSON layout |
| `source_name`, `file_type` | Original filename and format |
| `extractor`, `extractor_version` | Parser name and installed version |
| `extracted_at` | UTC timestamp for this extraction attempt |
| `status` | `extracted`, `empty`, `needs_ocr`, or `failed` |
| `text` | Combined extracted text |
| `parts` | Text with page/body-block locations and OCR flags |
| `ocr_pages` | One-based PDF page numbers needing OCR review |
| `encoding` | Decoding used for TXT; otherwise null |
| `error` | Safe failure summary; otherwise null |

PDF locations are `page/1`, `page/2`, and so on. DOCX locations such as
`body/table/2` refer to the second body block, not the second table. DOCX has no
reliable page numbering without a layout engine, so its page numbers stay null.
TXT uses a single `document` part. Source filenames are provenance, not unique asset IDs;
Filewise attaches each result to its account-scoped Drive asset record.

## Where to make changes

| Desired change | File to edit |
|---|---|
| TXT encodings | `app/extractors/txt.py` |
| Word body/table extraction | `app/extractors/docx.py` |
| PDF text and OCR detection rule | `app/extractors/pdf.py` |
| Output fields or statuses | `app/extractors/models.py` |
| Format routing or JSON persistence | `app/extractors/service.py` |
| CLI arguments | `app/extractors/__main__.py` |
| Upload limits and API protocol | `app/api/extraction.py` |
| Extension API requests | `frontend/extension/src/extraction.js` |
| Drive access checks and result persistence | `frontend/extension/src/library.js` |
| Default storage directory | `.env`: `STORAGE_DIR` |

## Current boundaries

- TXT supports UTF-8 (with or without BOM) and BOM-marked UTF-16. Unknown or
  invalid encodings fail rather than silently replacing unreadable characters.
- DOCX reads body paragraphs, tables, nested tables, and the stored text inside
  body content controls (including inline and nested controls). Merged table
  cells emit their text once, leaving empty positions for the rest of the span.
  Headers, footers,
  text boxes, tracked changes, and embedded images are outside this first version.
- PDF reads the existing text layer. A page without any alphanumeric extracted
  text is flagged for OCR. A page is also flagged when an image covers at least
  50% of the page and fewer than 50 alphanumeric text characters were extracted.
  This catches scans with a short caption or page number. Blank pages are also
  flagged. Smaller/tiled scans or image content alongside substantial digital text
  can still be missed; large ordinary photos with short captions can be flagged.
  This is a heuristic, not a reliable scan classifier. Mixed PDFs retain text from readable
  pages while listing the other pages for OCR.
- OCR itself is Milestone 3. Password-protected PDFs without an empty user password
  fail; malformed documents produce a failed result. Failed PDF parsing does not
  return partially extracted pages as a successful result.
- JSON files contain document text and should stay in private local storage.
  Saving errors are raised, so callers cannot confuse extraction with persistence.
  Background jobs, crash recovery, and database transactions are later milestones.

## Tests

```powershell
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\ruff.exe check app tests
.venv\Scripts\ruff.exe format --check app/extractors tests/test_extraction.py
```

Tests generate small documents locally; they need no downloads or cloud services.
ReportLab is a development dependency used only to generate PDF test inputs.

### Repeatable report verification

```powershell
.venv\Scripts\python.exe examples/check_reports.py
```

This creates four fictional reports under `storage/report-checks`: a Unicode TXT
expense report, a DOCX sales report with a table, a two-page text PDF, and a PDF
with a scanned second page. It compares the complete expected text (normalizing
PDF whitespace only), status, OCR pages, persisted text, and original file hashes.
Open `storage/report-checks/verification.json` to compare expected and actual text.
The command exits with code 1 if any check fails. The same cases run in pytest.

Regression checks cover horizontal/vertical merged cells, identical values in
distinct cells, block/inline/cell/nested content controls, scanned pages with page
numbers, small logos, and image pages with substantial searchable text. API tests cover
real documents, origin/header rejection, size limits and temporary-file cleanup.
Extension tests use mocked Drive responses for account isolation, retries and stale results.
The health-test dependencies may emit an httpx deprecation warning. These are controlled
fixtures, not a claim of universal accuracy on arbitrary reports; the boundaries above apply.
The user's authenticated Drive extraction/preview still needs live confirmation.

Integration verified on 2026-10-01: 55 Python tests, 128 extension unit/integration tests,
and 15 browser workflow checks passed. An isolated unpacked extension also processed all
four report fixtures through the real Python service, with the expected extension Origin,
no Google authorization header, and no browser CSP errors. Drive/OAuth are mocked in the
workflow checks; the installed-extension probe exercises the real local extraction connection.
The optional runners are `frontend/extension/tests/browser-smoke.mjs` and
`frontend/extension/tests/extraction-extension-smoke.mjs`; their headers document setup.

If Windows denies access to the shared pytest temporary directory, set a private
temporary directory for the current PowerShell session before running tests:

```powershell
New-Item -ItemType Directory -Force tmp | Out-Null
$env:TEMP = (Resolve-Path tmp).Path
$env:TMP = $env:TEMP
.venv\Scripts\python.exe -m pytest -q
```

Parser references: [pdfminer.six page extraction](https://pdfminersix.readthedocs.io/en/latest/tutorial/extract_pages.html)
and [python-docx document API](https://python-docx.readthedocs.io/en/latest/api/document.html).
