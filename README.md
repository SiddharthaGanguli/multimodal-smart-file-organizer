# Multimodal Smart File Organizer

A Chrome extension for a personal file library backed by **each user's own Google Drive**.
Original photos, documents and reports stay in that account. The extension records metadata
locally and provides a foundation for later OCR, classification, automatic Drive folders,
and content-aware search.

## Current implementation: issue #2

`frontend/extension` is a Manifest V3 extension with:

- Google account connection using Chrome Identity and per-file `drive.file` access.
- Direct uploads of PDF, DOCX, TXT, JPG/JPEG and PNG originals (20 MB maximum).
- Selection of existing files through Google Picker, without copying or moving them.
- An app-managed upload folder or an explicitly chosen writable Drive folder.
- UUID asset IDs, canonical Drive metadata, and SHA-256 for uploaded originals.
- Account-scoped IndexedDB records and an upload recovery journal.
- Resumable transfer and reconciliation using a preallocated Drive file ID.
- Filename search, metadata refresh, authorized open and original download.

Users do **not** install a database, Python or a local server. Google Cloud OAuth must be
configured for a connected build. The static Picker helper is published through GitHub Pages
at <https://siddharthaganguli.github.io/multimodal-smart-file-organizer/>. All three hosted
files returned HTTP 200 and matched the reviewed source byte for byte. Browser checks passed
for the hosted integration, and the user reports the end-to-end Drive workflow working.

**Start here: [extension setup and live acceptance checklist](docs/extension-setup.md).**
Load `frontend/extension` as an unpacked extension through `chrome://extensions`.
Version 0.1.3 pins the shared ID `llobmhbiebleflpmbfdobhbkecbgefab` so GitHub downloads can
use the same OAuth registration on every device. Users do not configure IDs themselves.
See [shared identity and installation](docs/shared-extension-id.md) for setup and migration.
Use the hosted helper for **Add from Drive** and folder selection. A loopback helper is
available for optional local development; see the setup guide for its configuration and
launcher. See the setup guide for Google configuration and additional live failure/recovery
checks. The extension implementation has not been merged into `main` or released through
the Chrome Web Store.

## Storage model

| Data | Location |
|---|---|
| Original file bytes | The connected user's Google Drive |
| Asset metadata and interrupted-upload journal | Chrome IndexedDB, keyed by account and file/operation |
| Active account | Chrome session storage |
| OAuth tokens | Chrome Identity's managed cache and temporary memory |
| Future OCR, labels and semantic index | To be implemented in later milestones |

Local metadata is specific to the Chrome profile and is not automatically synchronized
across devices. Register existing files explicitly; choosing a folder is an upload-destination
choice, not permission to crawl all its existing children.

## Development and tests

The extension uses plain JavaScript modules with no runtime package dependencies or build step.
With Node 22 or newer:

```sh
cd frontend/extension
npm test
```

Tests cover validation, account isolation, resumable Drive REST behavior, failure recovery,
and persistence orchestration with mocked Google responses. The optional browser smoke
runner tests the real DOM and IndexedDB with a mocked Google API; see its header for setup.

The Python/FastAPI foundation remains available for future server-side processing:

```sh
python -m venv .venv
# Activate .venv using your shell's activation command.
python -m pip install -e ".[dev]"
python -m pytest
```

It is not required to run the extension and does not store extension users' originals.
The previous backend-local upload PR #17 is not the implementation of the revised issue #2.

## Later milestones

1. Extract text from documents and OCR scans/images.
2. Build a labeled dataset and train a TF-IDF + logistic-regression classifier.
3. Add pretrained text and image embeddings and permission-aware semantic search.
4. Use reviewed categories to organize authorized files into Drive subfolders.
5. Add worker processing, synchronization, richer extension views, feedback, and monitoring.

Filename search is implemented now. OCR, automatic categorization/subfolders, and semantic
search are not yet implemented. The UI does not claim new uploads have been content-processed.
The original proof of concept remains: find both a digital invoice and its photographed
counterpart when searching for an invoice, and find a beach photo by its visual content.

See [architecture](docs/architecture.md), [roadmap](TODO.md), and
[issue #2](https://github.com/SiddharthaGanguli/multimodal-smart-file-organizer/issues/2).
