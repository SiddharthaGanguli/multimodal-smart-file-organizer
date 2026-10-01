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

## Milestone 1 — File upload and storage
- [ ] Define supported MIME types and size limits
- [ ] Add upload endpoint
- [ ] Validate files safely
- [ ] Generate internal asset IDs and storage paths
- [ ] Preserve originals
- [ ] Calculate SHA-256
- [ ] Extract metadata
- [ ] Persist asset records
- [ ] Add authorized file retrieval

## Milestone 2 — Document extraction
- [ ] TXT extraction
- [ ] DOCX extraction
- [ ] Text-based PDF extraction
- [ ] Detect OCR-required PDFs/pages
- [ ] Store extraction status and provenance

## Milestone 3 — OCR
- [ ] Integrate Tesseract/pytesseract
- [ ] OCR images
- [ ] OCR scanned PDF pages
- [ ] Store OCR text and page references
- [ ] Handle unreadable inputs safely

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

## Milestone 11 — Google Drive
- [ ] OAuth setup
- [ ] Secure token storage design
- [ ] App-managed Drive destination
- [ ] One-way upload
- [ ] Local ↔ Drive mapping
- [ ] Retry/resumable behavior
- [ ] Reconcile uncertain outcomes

## Milestone 12 — Frontend
- [ ] React foundation
- [ ] Upload UI
- [ ] Processing-state UI
- [ ] File list
- [ ] Gallery
- [ ] Unified search
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
