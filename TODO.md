# Project TODO

This is the repository-level roadmap. GitHub issues track active milestone work.

## Milestone 0 — Project foundation
- [x] Write project README
- [x] Create package structure
- [x] Add environment template
- [x] Add Python project configuration
- [x] Add FastAPI application skeleton
- [x] Add health endpoint test
- [x] Add Docker foundation
- [x] Add architecture document
- [ ] Run locally and verify tests
- [ ] Add CI after local verification

## Milestone 1 - Per-user Google Drive storage (issue #2)
- [x] Manifest V3 extension and account connection flow
- [x] Per-file Google authorization and normal-origin Picker helper integration code
- [x] Direct Drive uploads and existing-file references
- [x] Supported formats, upload limit, full TXT validation, hashing
- [x] App-managed or user-selected upload folder
- [x] Account-scoped IndexedDB metadata and upload journal
- [x] Resumable upload/reconciliation with stable Drive IDs
- [x] Authorized open/download and filename search
- [x] Automated validation, Drive client and account-isolation tests
- [x] Configure Google Cloud credentials (user reports sign-in and uploads working)
- [x] Confirm hosted Add from Drive works (user-reported after version 0.1.2 reload)
- [x] Confirm library persists after reopening, filename search works, and downloaded file opens (user-reported)
- [x] Validate real folder Picker and upload into the selected folder (user-reported)
- [x] Publish the three static Picker helper files on `gh-pages` and enable GitHub Pages
- [x] Verify the hosted helper's three HTTPS files return HTTP 200 and match the reviewed source
- [x] Verify the extension loads the hosted helper in a browser (dummy OAuth, no local server)
- [x] Confirm the end-to-end Drive workflow works with the configured Google project (user-reported)
- [ ] Complete the additional live failure/recovery checks in docs/extension-setup.md
- [x] Pin a shared public-key extension ID for GitHub installations
- [x] Register the shared ID in Google OAuth and configure its new client ID (maintainer-supplied)
- [x] Publish the updated Picker allowlist and verify both IDs are served over HTTPS
- [x] Distribute the configured shared extension build
- [x] Confirm the shared build works on the second device (user-reported on 2026-10-01)

The hosted helper is at <https://siddharthaganguli.github.io/multimodal-smart-file-organizer/>.
PR #18 merged the extension implementation into `main`. On 2026-10-01, the user reported
that another device receives a different extension ID and Google rejects its OAuth client.
The shared-ID candidate addresses that cause and includes the maintainer's new OAuth client.
The hosted Picker accepts both IDs. The user confirmed the shared build works on the
second device and requested merging PR #19. See docs/shared-extension-id.md. Detailed live failure/recovery checks
remain separate from the original successful workflow confirmation.

## Milestone 2 — Document extraction (issue #3; teammate work merged in PR #20)
- [x] TXT extraction
- [x] DOCX extraction
- [x] Text-based PDF extraction
- [x] Detect OCR-required PDFs/pages
- [x] Store extraction status and provenance
- [x] Connect Filewise uploads/imports to the local Python extraction API
- [x] Add Extract text, Retry extraction, and View text for library assets
- [x] Store results by account and invalidate changed Drive versions
- [x] Recheck Drive permissions before extracting or viewing saved text
- [ ] Confirm extraction and preview using the user's live Google Drive account

Implemented with a loopback Python companion and a separate CLI. Filewise stores extraction
results in account-scoped IndexedDB; the CLI saves JSON. The companion retains no originals
or results and receives no Google tokens. Drive storage works when the companion is stopped;
extraction can be retried after it starts. See [the extraction guide](docs/document-extraction.md)
for setup and OCR-detection limits. On-demand OCR is implemented separately in Milestone 3 below.

## Milestone 3 — OCR (issue #4)
- [x] Integrate local Tesseract via Tesseract.js/WASM, with bundled English data
- [x] OCR JPG/JPEG and PNG images
- [x] OCR scanned PDF pages with bounded PDF.js rendering
- [x] Store account-scoped OCR text, source versions and original page references
- [x] Handle unreadable, empty, partial, cancelled and failed inputs explicitly
- [x] Verify clear/degraded examples and scanned PDFs with real packaged OCR
- [x] Test cancellation, limits, account isolation, permission changes and database migration
- [x] Document a separate OCR interface for issue #3 integration
- [x] Confirm live PDF OCR displays page results (maintainer shared four-page output on 2026-10-01)
- [x] Verify corrected column order on the actual four-page PDF in the installed extension (0.2.1, 2026-10-01)
- [ ] Complete the remaining live Drive OCR checks (docs/ocr-pipeline.md)

## Milestone 4 — ML dataset
- [ ] Freeze initial category definitions
- [ ] Define labeled dataset schema
- [ ] Collect permitted examples
- [ ] Group related copies/versions
- [ ] Create train/validation/test splits
- [ ] Add leakage checks

## Milestone 5 — Document classifier
- [ ] Train TF-IDF + Logistic Regression baseline
- [ ] Evaluate precision, recall, F1, confusion matrix
- [ ] Add model version metadata
- [ ] Add inference wrapper
- [ ] Define NEEDS_REVIEW policy
- [ ] Test on OCR-derived text

## Milestone 6 — Text semantic search
- [ ] Select and pin embedding model
- [ ] Define tokenizer-aware chunking
- [ ] Enable pgvector
- [ ] Store model-specific vectors
- [ ] Implement semantic retrieval
- [ ] Build retrieval evaluation set

## Milestone 7 — Gallery intelligence
- [ ] Select and pin image-text model
- [ ] Generate image embeddings
- [ ] Implement text-to-image search
- [ ] Implement image similarity
- [ ] Evaluate screenshots, document photos, ordinary photos

## Milestone 8 — Unified multimodal search
- [ ] Keyword retrieval
- [ ] Text semantic retrieval
- [ ] Visual semantic retrieval
- [ ] Metadata/date/type filters
- [ ] Rank fusion
- [ ] Collapse repeated chunk hits
- [ ] Enforce authorization everywhere

## Milestone 9 — Smart organization
- [ ] Tags
- [ ] Virtual collections
- [ ] Recently Added
- [ ] Needs Review
- [ ] Exact duplicate detection
- [ ] Near-duplicate suggestions

## Milestone 10 — Background processing
- [ ] Configure Redis
- [ ] Configure Celery
- [ ] Persistent job records
- [ ] Retries and idempotency
- [ ] Interrupted-job recovery
- [ ] Separate processing from cloud-sync status

## Milestone 11 - Extended Google Drive synchronization
Basic Drive storage and authorization are now part of Milestone 1.
- [ ] Incremental detection of external Drive changes
- [ ] Broader synchronization and reconciliation policies
- [ ] Cross-device index rebuilding/synchronization design
- [ ] Extended quota, conflict and permission-change tests

## Milestone 12 - Richer Chrome extension interface
The basic library, upload, account and filename-search UI is part of Milestone 1.
- [ ] Background processing-state UI
- [ ] Gallery
- [ ] Unified content-aware search
- [ ] Collection views
- [ ] Review/correction UI

## Milestone 13 — Feedback and retraining
- [ ] Record corrections with provenance
- [ ] Build reviewed training-data export
- [ ] Train candidate versions
- [ ] Compare candidate vs deployed model
- [ ] Promotion criteria
- [ ] Rollback process

## Milestone 14 — Security and testing
- [ ] Authentication
- [ ] Authorization/ownership tests
- [ ] Malicious upload tests
- [ ] Corrupted-file tests
- [ ] Worker failure tests
- [ ] Search relevance tests
- [ ] Drive failure tests
- [ ] Audit logging

## Milestone 15 — Deployment and monitoring
- [ ] Production Docker configuration
- [ ] HTTPS/reverse proxy plan
- [ ] Persistent volumes
- [ ] Backup and restore test
- [ ] Logs
- [ ] Queue/job metrics
- [ ] Search and processing latency metrics
- [ ] Deployment runbook
