# Hosted text semantic search

Issue #7 adds English meaning-based search over extracted and OCR text. It is
independent of the classifier in issue #6. The maintainer selected hosted search
on 2026-10-02 so extension users do not start a local search server. The extension
ZIP and unpacked runtime must remain below 10,000,000 bytes.

## Implementation plan

1. Normalize existing extraction parts and OCR pages into a common text format.
   Prefer embedded PDF text when present; fill missing pages from current OCR.
   Preserve page or block references and mark partial or uncertain OCR.
2. Run `sentence-transformers/all-MiniLM-L6-v2` on the server using ONNX Runtime.
   Pin revision `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`, model/tokenizer hashes,
   masked mean pooling, normalization and a versioned chunking configuration.
   Use up to 224 content tokens per chunk with 32-token overlap, within the model's
   256-token limit. Preserve original text spans rather than decoded token text.
3. Store 384-dimensional vectors, passage text and source provenance in pgvector.
   Replace a file's index transactionally and make unchanged indexing idempotent.
   Separate embedding versions; never compare vectors from incompatible models.
4. Authenticate search requests using the active Google Drive access token. Derive
   account identity on the server, never from an account ID in a request body.
   Verify canonical Drive metadata before and after indexing and before returning
   passages. Filter database queries by account and recheck file version, trash
   state and download permission. Tokens remain transient and are not logged or saved.
5. Add an explicit hosted-search opt-in, an index/update action and a contents-search
   view. Show readiness/errors, source snippets and page references. Keep filename
   search usable when hosted search is unavailable. Clear results on account changes
   and ignore late responses. Provide deletion of the hosted search index.
6. Verify token boundaries, source replacement, account isolation, permission loss,
   real pgvector persistence and retrieval quality. Use permitted synthetic fixtures
   with paraphrases and irrelevant queries; report Recall@5 and MRR@5 alongside a
   filename baseline. Re-run extension/browser regression and size checks.

## Hosting and data boundaries

Recommended initial deployment: Render web service plus Neon PostgreSQL/pgvector.
Render's free service is for demos and sleeps after 15 idle minutes; production
capacity must be selected after measuring memory, latency and usage. Provisioning,
the actual HTTPS service URL and production credentials are not yet configured.
The service must use a dedicated database role and HTTPS for public access.

Users explicitly enable hosted search before their derived text is uploaded.
The service stores indexed passages and embeddings; originals remain in Drive.
Search authentication forwards a short-lived Google token only to the configured
maintainer-owned service. The existing local extraction route remains separate.
No third-party embedding inference API receives document text.

Search only covers text already extracted or recognized. This milestone does not
make the local extraction companion hosted, perform visual image search, or train
the document classifier. Classifier labels can later be optional metadata filters.

## Acceptance and release

The feature is ready for review when real-model retrieval and database integration
pass, cross-account and revoked-file tests return no unauthorized passages, browser
tests pass and the package remains within budget. A merged PR alone does not make
hosted search live: deploy the API/database and configure its exact HTTPS origin
in the distributed extension before a live-account smoke test.

## Maintainer deployment: Render + Neon

This is a one-time maintainer setup. Users will install the configured extension,
connect Drive, enable hosted search, and update their index. They do not create
database accounts, download embedding weights, or configure OAuth IDs.

1. Create a Neon PostgreSQL project in a region near the Render service. Use a
   separate database for Filewise. Keep the administrator connection URL private.
   In Neon's SQL editor, create a runtime role with a generated strong password:

   ```sql
   CREATE ROLE filewise_search LOGIN NOSUPERUSER NOBYPASSRLS
     PASSWORD 'REPLACE_WITH_A_GENERATED_PASSWORD';
   ```

   Create this role with SQL rather than assuming a dashboard-created role lacks
   elevated memberships. Do not grant it the administrator role or table ownership.

2. From this repository install `pip install '.[search]'`. Set
   `SEARCH_MIGRATION_URL` privately in the current terminal to the **administrator**
   URL, with TLS enabled, then run `python -m app.retrieval.migrate`. This enables
   pgvector, creates tables and forced row-security policies, and grants the runtime
   role access. Remove that environment variable after migration. Do not commit
   credentials or paste them into an issue. A schema migration is repeatable.

3. In Render, create a Blueprint from this repository/branch using `render.yaml`.
   It defines one Docker web service on the free demo plan. Set its secret
   `SEARCH_DATABASE_URL` to the Neon connection URL for **filewise_search**, with
   `sslmode=require` (or the provider's stronger TLS settings). Do not give Render
   the administrator URL. No Google client secret or embedding API key is needed.
   The image downloads and verifies the pinned model during the build. Runtime
   startup refuses missing models, missing schema, and elevated database roles.

4. Deploy manually and open `https://YOUR-SERVICE.onrender.com/health`; expect
   `{"status":"ok"}`. Auto-deploy is deliberately off. Keep one worker/instance
   for this first release because rate limits and indexing capacity are in process.
   Only expose the container through the hosting HTTPS proxy; forwarded headers
   are trusted for that deployment. Never set `SEARCH_ALLOW_HTTP=true` in hosting.

5. Configure the real URL in the extension and package it:

   ```text
   python frontend/extension/tools/configure_search.py https://YOUR-SERVICE.onrender.com
   python frontend/extension/tools/package_extension.py
   ```

   This updates `search-config.js`, exact host permissions and `connect-src` together,
   preserving the shared extension identity/OAuth registration. Commit these public
   configuration changes for future builds after the endpoint works. Give users the
   generated `dist/filewise-0.3.0.zip`, not the whole repository. Existing unpacked
   installations must replace their files and click Reload in `chrome://extensions`.

6. Test with your own permitted sample document: extract text/run OCR, open **Search
   contents**, enable hosted search, **Update search index**, then search using a
   paraphrase of its contents. Verify the source reference and **Open in Drive**.
   Repeat with a second account, a modified file and revoked access. Delete the
   hosted index and confirm the original remains in Drive. This live acceptance
   step is still pending; mocked browser checks cannot replace it.

Render Free sleeps after 15 idle minutes and may take about a minute to wake. The
extension allows a 90-second request timeout and explains startup failures. Free
capacity is an experiment, not a production performance promise: measure peak RAM,
indexing time, cold starts and concurrent search before choosing paid capacity.
Neon is separate from Render's expiring free PostgreSQL product. Review provider
storage/backup retention, billing and privacy terms before inviting public users.
Deletion removes active database rows; provider backups follow their retention.

## Contracts and operating limits

The API is `app.search_api:app`, separate from the loopback extraction app.
Every `/v1/search/*` endpoint uses POST JSON, the extension Origin,
`X-Filewise-Request: search-v1`, and a transient `Authorization: Bearer ...`.
Google verifies the token; the account key comes from `about.user.permissionId`.
No owner ID is accepted from a client. CORS is not the authentication boundary.

| Endpoint | Request | Result |
|---|---|---|
| `/v1/search/index` | `file_id`, canonical `source`, `parts` | Indexed or unchanged; chunk count |
| `/v1/search/query` | `query`, optional `limit` (1–20) | One best passage per file, source/page/method/review state |
| `/v1/search/status` | `{}` | Indexed-file count and model key |
| `/v1/search/forget` | `{}` or `file_id` | Delete caller's entire index or one indexed file |

Source fields are `name`, `mime_type`, `size`, `modified_time`, optional `sha256`.
Parts use `text`, `location`, optional `page_number`, `method` (`extraction`/`ocr`)
and `needs_review`. The extension prefers extracted PDF pages and fills missing
pages from current OCR. Classifier work can consume the same text independently;
labels and classification are not prerequisites for indexing.

Limits: 1 MB request body, 200,000 text characters/256 chunks per file, source up
to 20 MiB, 1,000 indexed files/20,000 chunks per account, 10 index requests and 60
other requests per operation/account/minute. Bulk indexing pauses once for a minute
when rate limited and can be cancelled by closing the dialog. One model inference
batch runs at a time; additional indexing requests receive a busy response.
Queries are limited to 1,000 characters and 256 model tokens, with cosine score
at least 0.35. These are initial guardrails, not calibrated confidence probabilities.

Retrieval uses exact cosine distance, filtered by account/model before ranking,
and collapses multiple passages to one result per file. It checks up to five times
the requested result count (maximum 100) with a 20-second access-check budget;
slow checks can return a partial result. There is no approximate vector index yet.
Changed, trashed, unreadable and removed files are hidden and lazily removed from
the index when encountered. Re-extract/OCR changed files and update the index;
there is no automatic background synchronization. Disabled or offline search
does not prevent filename search. Derived text remains indexed until deleted or
invalidated; signing out alone does not delete the hosted index.

## Verification

```text
pip install '.[search,dev]'
python -m app.retrieval.model --download
python -m pytest -q
node --test frontend/extension/tests/*.test.js
python evaluation/check_text_search.py
python frontend/extension/tools/package_extension.py
```

`evaluation/text_search.json` contains 12 synthetic documents, 20 paraphrase
queries and two unrelated queries. The pinned model achieved Recall@5 = 1.0 and
MRR@5 = 1.0; the filename baseline Recall@5 was 0.10. Both unrelated queries had
no result above the threshold. This tiny development fixture is a regression gate,
not a held-out estimate of real-document accuracy. Expand it with permitted real
documents before tuning the threshold. The report is written to ignored
`tmp/semantic-evaluation/report.json` and uploaded by CI.

The `Hosted semantic search` workflow provisions pgvector 0.8.7/PostgreSQL 16,
migrates with an administrator, tests with a non-superuser role, runs the real
model evaluation and builds the Docker image. Local database integration tests
skip unless `SEARCH_TEST_DATABASE_URL` points to an isolated migrated test database
with the runtime role. Never run tests against the production database.
Browser fixtures exercise the real UI with mocked Google/hosted responses; real
ONNX inference and database authorization are tested separately.

Sources: [MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2),
[pgvector](https://github.com/pgvector/pgvector),
[PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html),
[Render free service limits](https://render.com/docs/free),
[Neon vector database](https://neon.com/ai).
