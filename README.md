# Multimodal Smart File Organizer

A Chrome extension for a personal file library backed by **each user's own Google Drive**.
Original photos, documents and reports stay in that account. The extension records metadata
and extracted document text locally, reads text from scans/images, and provides a foundation
for classification, automatic Drive folders and content-aware search.

## Current implementation: Drive library, extraction, OCR and text search

`frontend/extension` is a Manifest V3 extension with:

- Google account connection using Chrome Identity and per-file `drive.file` access.
- Direct uploads of PDF, DOCX, TXT, JPG/JPEG and PNG originals (20 MB maximum).
- Selection of existing files through Google Picker, without copying or moving them.
- An app-managed upload folder or an explicitly chosen writable Drive folder.
- UUID asset IDs, canonical Drive metadata, and SHA-256 for uploaded originals.
- Account-scoped IndexedDB records and an upload recovery journal.
- Resumable transfer and reconciliation using a preallocated Drive file ID.
- Filename search, metadata refresh, authorized open and original download.
- Local English OCR for scanned PDFs and images, with page references, saved results,
  confidence/review states, cancellation, and retry. See [OCR usage and integration](docs/ocr-pipeline.md).
- TXT, DOCX and PDF text extraction through a local Python companion, with retry and text preview.
- Opt-in hosted English semantic search over extracted/OCR text, with source snippets,
  page references and permission checks. **Deployment is required**; the default build has
  no hosted endpoint. See [search architecture and deployment](docs/semantic-search.md).

Drive storage and on-demand OCR work without Python, a database or a local server. **TXT, DOCX and embedded PDF text extraction need
the local Python companion** described below. Google Cloud OAuth must be configured for a
connected build. The static Picker helper is published through GitHub Pages
at <https://siddharthaganguli.github.io/multimodal-smart-file-organizer/>. All three hosted
files returned HTTP 200 and matched the reviewed source byte for byte. Browser checks passed
for the hosted integration, and the user reports the end-to-end Drive workflow working.

**Start here: [extension setup and live acceptance checklist](docs/extension-setup.md).**
For distribution, build the clean extension-only ZIP with
`python frontend/extension/tools/package_extension.py`; both ZIP and unpacked files
must fit within 10 MB. See [packaging and installation](docs/extension-packaging.md).
Developers can also load `frontend/extension` through `chrome://extensions`.
Version 0.3.0 retains the shared ID `llobmhbiebleflpmbfdobhbkecbgefab` so GitHub downloads can
use the same OAuth registration on every device. Users do not configure IDs themselves.
See [shared identity and installation](docs/shared-extension-id.md) for setup and migration.
Use the hosted helper for **Add from Drive** and folder selection. A loopback helper is
available for optional local development; see the setup guide for its configuration and
launcher. See the setup guide for Google configuration and additional live failure/recovery
checks. The Drive library and shared identity were merged in PRs #18 and #19.
The extension has not been released through the Chrome Web Store.

## Storage model

| Data | Location |
|---|---|
| Original file bytes | The connected user's Google Drive |
| Asset metadata and interrupted-upload journal | Chrome IndexedDB, keyed by account and file/operation |
| Extracted text, status and provenance | Chrome IndexedDB, on the corresponding account's asset |
| Active account | Chrome session storage |
| OAuth tokens | Chrome Identity's managed cache and temporary memory |
| OCR text, page references and provenance | Chrome IndexedDB, keyed by account and Drive file |
| Semantic text index (after opt-in) | Hosted PostgreSQL/pgvector, separated by verified account |
| Classifier labels | Issue #6, independent work |

Local metadata is specific to the Chrome profile and is not automatically synchronized
across devices. Register existing files explicitly; choosing a folder is an upload-destination
choice, not permission to crawl all its existing children.

## Development and tests

The extension uses plain JavaScript modules with no install/build step. Pinned OCR
libraries and models ship in `frontend/extension/vendor`; users need no extra setup.
With Node 22 or newer:

```sh
cd frontend/extension
npm test
```

Tests cover validation, account isolation, resumable Drive REST behavior, failure recovery,
and persistence orchestration with mocked Google responses. The optional browser smoke
runner tests the real DOM and IndexedDB with a mocked Google API; see its header for setup.

Install the Python companion and its development tests with:

```sh
python -m venv .venv
# Activate .venv using your shell's activation command.
python -m pip install -e ".[dev]"
python -m pytest
```

It is only required for text extraction and does not retain uploaded originals or API results.
The previous backend-local upload PR #17 is not the implementation of the revised issue #2.

## Document extraction in Filewise (Milestone 2)

From the repository root, start the companion and keep the terminal open:

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Reload Filewise at `chrome://extensions` after updating to 0.2.1, then reopen its tab.
New TXT, DOCX and PDF uploads/imports are extracted automatically. For existing library
files, choose **Extract text**, then **View text**. If the companion is stopped, the file
stays saved in Drive; start it and choose **Retry extraction**.

The companion receives document bytes, never Google tokens. It deletes temporary uploads
and returns results to the extension's account-scoped IndexedDB. Changed Drive versions
invalidate old results, and viewing text rechecks Drive permissions. For scans choose
**Read scan** (PDF) or **Read text** (image). OCR runs separately on this device without Python.
The document extraction workflow was merged in PR #20.

The separate CLI still saves JSON: `python -m app.extractors path/to/document.pdf`.
See the [extraction guide](docs/document-extraction.md) for the small module layout and limits.

## Dataset (Milestone 4)

The `filewise-v1` dataset is versioned with DVC and uploaded to the
[Google Drive DVC folder](https://drive.google.com/drive/folders/1xmPY69LZ07IWkmCHA9e0nyMddMIHlYW8).
It contains synthetic starter examples across eight document types, plus separate
OCR test images and public receipt references. See the [dataset guide](training/README.md)
for contents, limitations, DVC installation, and Google authorization setup.

After setup, download the dataset from the repository root:

```powershell
.venv-dvc\Scripts\dvc.exe pull storage/datasets/filewise-v1.dvc
```

Your Google account needs access to the Drive folder. DVC restores the original
filenames and folders from the hash-named objects stored there.

## Later milestones

1. Connect automatic OCR fallback to document extraction results.
2. Expand the starter dataset with real labeled documents and train a TF-IDF + logistic-regression classifier.
3. Deploy hosted text search, then add image embeddings and visual search.
4. Use reviewed categories to organize authorized files into Drive subfolders.
5. Add worker processing, synchronization, richer extension views, feedback, and monitoring.

Filename search, on-demand OCR and hosted text-search code are implemented now. Automatic
categorization/subfolders and visual search remain future work. Hosted text search still needs
deployment and a configured service URL. OCR does not automatically process every upload.
The original proof of concept remains: find both a digital invoice and its photographed
counterpart when searching for an invoice, and find a beach photo by its visual content.

See [architecture](docs/architecture.md), [roadmap](TODO.md), and
[issue #2](https://github.com/SiddharthaGanguli/multimodal-smart-file-organizer/issues/2).
