# Issue #2 implementation verification

Verified locally on 2026-10-01, on branch `feat/issue-2-drive-extension`.
This implements the revised Chrome-extension / per-user Google Drive design.
The existing backend-local upload PR #17 was not merged.

## Results

| Check | Result |
|---|---|
| Node unit/integration tests (Node 24.19.0) | 113 passed, 0 failed, including the shared-identity regression |
| Browser smoke with real DOM and IndexedDB | 12 checks passed, no page errors |
| Existing Python backend health test | 1 passed |
| JavaScript syntax and Git whitespace checks | Passed |
| Actual unpacked extension in fresh headless Edge profile | Manifest, worker and app loaded |
| Original sandbox Picker probe | SDK shell loaded; insufficient to validate the nested Google app |
| Local normal-origin static helper | HTML/JS return 200; nonpublic routes and writes rejected |
| Fresh Chromium with actual extension and helper | Helper origin is loopback; Google iframe origin is docs.google.com; no CSP errors with dummy OAuth |
| Live Google OAuth, upload and filename search | User reports working with their configured Google project |
| Picker after extension reload | User reported it working; later hosted-helper checks are recorded below |
| Later broken-frame recurrence | Local helper was stopped; no listener on 8765. Restarted with background launcher |
| Windows helper lifecycle | Start twice reuses one PID; stop and repeated stop pass; helper remains reachable after launcher exits |
| Published HTTPS helper | GitHub Pages deployment succeeded; all three public files return 200 and match the reviewed source byte-for-byte |
| Hosted configuration | Version 0.1.2 uses the HTTPS helper; the local helper was stopped and its health endpoint confirmed unreachable |
| Actual extension with the hosted helper | Trusted HTTPS handshake and Google SDK loaded; normal Google origin, no CSP violations and no localhost requests; dummy OAuth only |
| Live hosted Add from Drive | User reports working after the version 0.1.2 reload and file-selection instructions |
| Live persistence, search, and download | User reports the file remains listed/searchable after closing and reopening Filewise, and the downloaded file opens correctly; exact-byte comparison not confirmed |
| Live folder selection and upload destination | User replied "now all working" after the folder-selection/upload check and requested a PR for issue #2 on 2026-10-01 |
| Shared identity, version 0.1.3 | Actual Chromium installs in two different folders and fresh profiles both report `llobmhbiebleflpmbfdobhbkecbgefab`; configuration checks pass |
| Shared Google OAuth client | New public client ID supplied by the maintainer and configured; user confirmed the shared build works on the second device and requested merging PR #19 |
| Published shared-ID helper allowlist | Hosted `config.js` returns HTTP 200 and includes both the original and shared extension IDs |

## Cross-device identity correction

After PR #18 merged, the user reported `Bad client id` on another computer and confirmed
its extension ID differed from the original. Version 0.1.3 pins a public RSA key in the
manifest and uses the new OAuth client supplied after the maintainer registered that shared
ID. The Picker allowlist retains the original ID and adds the shared ID.

All 113 Node tests pass. Two actual installed-extension probes, using separate copied folders
and fresh Chromium profiles, independently return the same shared ID and configured state.
The report is `.pr-reviews/shared-id-check-1790853901309/report.json` in the original workspace.
These probes do not authorize a real Google account. The user subsequently confirmed
"done working" on the other device and requested merging PR #19 on 2026-10-01.
See [shared identity setup](shared-extension-id.md) for rollout steps and verification details.

The browser workflow uses mocked Chrome Identity and Drive responses. It verifies uploads
and downloads preserve bytes, metadata survives reload, accounts are isolated, imports are
idempotent references, filename search preserves totals, hostile filenames render as text,
pending journals expose retry, revoked/missing files disappear on refresh, and desktop/mobile
layouts fit. It exposed a real browser fetch-receiver bug that was fixed before the passing run.

The original separate real-extension probe used deliberately invalid Google credentials.
Google's loader and Picker module returned HTTP 200, but the Picker iframe returned HTTP 403.
This only verified the shell. The user's subsequent authenticated run exposed a real bug:
the sandbox restriction propagated into Google's iframe, and its own module requests failed
CORS because their origin was `null`. The fix removes that sandbox ancestor and uses a normal
web-origin helper at `frontend/picker-bridge`, isolated by the browser's same-origin policy.
Credentials transfer only after a readiness message from the exact helper origin/window;
selection results return through a private MessagePort. An isolated Chromium probe confirmed
the intended origins and successful Google SDK requests, but a deliberately invalid OAuth token
produced Google's 403 page. It cannot establish successful authenticated file selection.
The user's follow-up "This content is blocked" message came from the old manifest's
`frame-src 'self'` restriction. They later confirmed Picker worked after reloading build
0.1.1. A subsequent recurrence showed a stopped loopback helper, confirmed by failed HTTP
and no listener on port 8765. Windows background start/stop scripts now provide health
checks and PID/start-time/executable safeguards. The frame remains hidden until the trusted
helper is ready, and localhost failure shows an actionable error within three seconds.
The loopback server is now only an optional development tool. Version 0.1.2 points to
the [published HTTPS helper](https://siddharthaganguli.github.io/multimodal-smart-file-organizer/).
Only `index.html`, `picker.js`, and the public extension-origin allowlist in `config.js`
were published on `gh-pages` at commit `be60bed808736480ec2f42476e5464442aded07b`.
The [Pages deployment](https://github.com/SiddharthaGanguli/multimodal-smart-file-organizer/actions/runs/36850748330)
completed successfully. `.pr-reviews/published-picker-assets.json` records the verified
HTTP status, content type, and SHA-256 for each asset. The site files contain no API key
or OAuth token. The main branch and issue #2 implementation were not merged.

With the local server stopped, a fresh Chromium profile loaded the actual unpacked
extension (ID `mcbofcbjijijdhliapclkdjakggafkmi`) and the hosted helper. The probe confirmed
the exact source/origin READY check, a transferred MessagePort, the helper's HTTPS origin,
and Google's own `https://docs.google.com` origin. All three helper assets and Google's
SDK modules returned 200; there were no CSP violations or localhost requests.
`.pr-reviews/published-picker-1790851502267/report.json` and its screenshot record this
check. The deliberately invalid OAuth token produced a Google 403 error page, so this
probe does not establish successful authenticated file selection.

The latest mock browser report is
`frontend/extension/test-results/browser-1790852121499/report.json` (12 passing checks).
The additional browser regression blocks the mock helper, checks the loading/error/busy
states, then restores a mock helper and verifies the real MessageChannel handshake and
clean cancellation. It never contacts the user's running helper or real Google accounts.

## Regression coverage

- Complete UTF-8 validation across sampling/chunk boundaries and rejection of binary tails.
- Empty/oversized files, signatures and corrupt/encrypted/structurally invalid DOCX ZIPs.
- Preserved bytes and SHA-256; bounded downloads.
- Resumable offsets, expired sessions, lost responses and fixed-ID reconciliation.
- Failed metadata commits retain the journal for recovery without duplicate uploads.
- Quota errors retain existing file registrations.
- Account changes during token verification, uploads, downloads and metadata commits.
- Concurrent token checks cannot borrow another request's verified identity.
- Stale failures cannot disconnect a newly active account.
- Picker IDs and upload-session destinations are validated before authenticated access.
- Picker readiness checks source and origin before sending credentials; timeouts,
  cancellation, malformed selections and replacements clean up ports/listeners.
- Google Picker runs outside a manifest sandbox, with an explicitly allowed frame origin.

## Reproduction and remaining work

Run `npm test` from `frontend/extension` with Node 22+. The optional
`tests/browser-smoke.mjs` header documents its Playwright setup. Test outputs are local
and ignored under `frontend/extension/test-results/`.

See [Google configuration and the live acceptance checklist](extension-setup.md) for
reproduction and additional checks. The user confirmed the end-to-end workflow is working
and requested a PR for issue #2. Exact-byte download comparison, account switching,
upload recovery, and quota/revocation scenarios have not been individually confirmed live;
their automated coverage uses mocked Google responses.
Hosted Add from Drive, sign-in, upload, filename search, persistence after reopening, and
opening a downloaded file, plus folder selection/upload, are user-reported rather than
independently observed. The static helper is published; the extension has not been released
to the Chrome Web Store, and the issue #2 implementation has not been merged.

OCR, automatic category folders and semantic search remain later milestones; this version
implements file storage/registration and filename search.
