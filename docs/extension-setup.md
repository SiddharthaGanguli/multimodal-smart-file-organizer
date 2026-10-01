# Chrome extension setup and verification

The extension is in `frontend/extension`. Users' originals live in their own Google Drive.
Only file metadata and an upload recovery journal are stored in the extension's IndexedDB.
A connected build uses the small HTTPS-hosted Picker helper at
<https://siddharthaganguli.github.io/multimodal-smart-file-organizer/>. End users do not install
Python, a database, Node, or a local server. The helper files have been published to the
`gh-pages` branch and GitHub Pages is enabled. All three hosted files returned HTTP 200 and
matched the reviewed source byte for byte. The user reports the end-to-end workflow,
including hosted file/folder selection and uploads, working. Developers
can optionally use the loopback helper and need Node 22 or newer for it and the automated tests.

## One-time maintainer setup

1. Create a Google Cloud project. Enable **Google Drive API** and **Google Picker API**.
2. Configure the OAuth consent screen. While the app is in testing, add the Google accounts
   that will test it. Request only `https://www.googleapis.com/auth/drive.file`.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
   this repository's `frontend/extension` directory. Copy the extension ID.
4. Create an OAuth client with application type **Chrome Extension** (called Chrome App
   in some versions of the console), using that exact extension ID. Put its public client ID
   in `frontend/extension/manifest.json` under `oauth2.client_id`.
5. Create a Google Picker API key in the same project. Restrict the key to the Google Picker
   and Drive APIs. Put the key and the numeric project number in `frontend/extension/config.js`.
   These are public application identifiers. Never put a client secret, password, refresh
   token, or access token into the extension or the repository.
6. Check `ALLOWED_EXTENSION_ORIGINS` in `frontend/picker-bridge/config.js`: it must include
   the exact `chrome-extension://<extension-id>` origin from step 3. This is a public origin
   allowlist, not a place for credentials. Configure the helper as described below.
7. Reload the extension and click its toolbar button. Choose **Connect Google Drive**.
   Test accounts must consent to the requested per-file access.

For a stable ID across developer machines/builds, use the public extension key from your
Chrome Web Store developer dashboard as the manifest's `key` before registering OAuth.
Changing the extension ID requires updating the OAuth client's registered extension ID and
the Picker helper's extension-origin allowlist.
For local testing, keeping the unpacked directory fixed keeps the local ID consistent.

Google's API key website restrictions must allow Picker's `https://docs.google.com/*`
requests and the actual helper website, such as `https://siddharthaganguli.github.io/*`.
For local development, the helper is `http://127.0.0.1:8765/`. Verify restrictions with a real
Picker session using the configured URL. Keep the key restricted to the Picker and Drive APIs.
The key is visible in the distributed extension; it is not a substitute for the user's OAuth grant.

Sources: [Chrome OAuth](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Google Picker setup](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample).

## Optional local development helper

The hosted helper does not need this process. To work on the helper locally, set
`googlePickerBridgeUrl` in `frontend/extension/config.js` to
`http://127.0.0.1:8765/picker.html`, then start the server below. Restore the hosted URL
when finished testing locally.

On Windows, double-click `frontend/picker-bridge/Start-PickerBridge.cmd`, or run this
from the repository root:

```powershell
.\frontend\picker-bridge\Start-PickerBridge.cmd
```

The launcher starts Node in a hidden background process and checks the helper's health.
Starting it again reuses the same instance. It does not install a service or configure
automatic startup; run it again after restarting Windows. Its PowerShell execution-policy
option applies only to that launcher process, without changing your system policy.
Logs and process metadata are under the ignored `.pr-reviews/picker-helper` directory.
To stop the instance created by the launcher:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\frontend\picker-bridge\Stop-PickerBridge.ps1
```

The stop script checks the recorded PID, start time, executable and script path before
stopping the process; it refuses to stop a different process if a PID has been reused.

Alternatively, run the helper in a terminal:

```powershell
node frontend/picker-bridge/serve.mjs
```

Keep that terminal running when using the direct Node command. Closing it stops the helper.
The background launcher does not require keeping a terminal open.
Reload the unpacked extension from `chrome://extensions` after changing its configuration,
then open it again and retry Picker. Opening the helper directly only displays an instruction
to open it through Filewise; credentials are supplied by the connected extension.

The dependency-free server listens only on `127.0.0.1:8765`. It serves an explicit list of
the helper's HTML, JavaScript, and public origin configuration, rather than the repository
directory. It does not receive upload bodies or serve as an application backend. Stop it
with Ctrl+C when using the direct Node command, or the stop script for a background instance.
Upload, download, and filename search do not
use this helper; Google Picker does.

## Hosted helper and future deployments

The public helper address is
<https://siddharthaganguli.github.io/multimodal-smart-file-organizer/>. The `gh-pages` branch
contains only `index.html` (copied from `picker.html`), `picker.js`, and `config.js`.
GitHub Pages was enabled when that branch was published. All three HTTPS files have been
verified to return HTTP 200 and match the reviewed source byte for byte. A fresh Chromium
profile loaded extension version 0.1.2, the hosted helper, and Google's SDK with the local
server stopped. The handshake and frame origins passed, with no CSP violations or localhost
requests. That probe used dummy OAuth. The user subsequently reported hosted Add from Drive
working, then confirmed the workflow works after the folder-selection/upload check.

Publish only `frontend/picker-bridge/picker.html`, `picker.js`, and `config.js` to a trusted
static HTTPS host, keeping their relative paths intact. Do not publish `serve.mjs`, the
Windows launchers, extension configuration, or the whole repository as the helper site. No backend or runtime
server process is required for the hosted version.

For a fresh deployment, or to maintain this repository's GitHub Pages copy:

1. Prepare a dedicated publishing branch, such as `gh-pages`, containing only the helper
   files. Copy `picker.html` as `index.html` at its root, alongside `picker.js` and `config.js`.
2. Check repository **Settings → Pages**. If the publishing source is not already configured,
   select **Deploy from a branch**, then that publishing branch and **/(root)**. Ensure
   **Enforce HTTPS** is enabled.
3. After deployment, verify the site and both JavaScript files at
   `https://siddharthaganguli.github.io/multimodal-smart-file-organizer/`.
4. Set `googlePickerBridgeUrl` in `frontend/extension/config.js` to the deployed address.
   The extension's `frame-src` already allows `https://siddharthaganguli.github.io`; add an
   exact host to that directive if using a different HTTPS host. Remove the loopback
   allowance from a distribution build once local testing is no longer needed.
5. Check the hosted `config.js` extension-origin allowlist and the API key website
   restrictions, reload the extension, and perform the live Picker checks below.

Publication of the helper was authorized and the publishing branch has been created. The
extension implementation has not been merged into `main`. Repeat hosted-file verification
after changes and complete the live acceptance checks before distributing the extension.

See [GitHub Pages creation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
and [HTTPS settings](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https).

## Why Picker uses a web helper

The earlier implementation embedded Picker inside an extension sandbox. The user's browser
console confirmed that Google's nested Picker frame inherited an opaque origin: requests
for Picker JavaScript and data were sent from origin `null`, and CORS blocked access to
the responses even when the server returned HTTP 200. The visible dialog shell could load
while its file list remained blank. A separate `frame-ancestors` message was report-only.

The replacement loads a normal web iframe directly inside the extension. Do not add a
`sandbox` attribute or a sandboxed ancestor: the helper and Google's nested frame need their
normal web origins. Browser origin checks still prevent the helper from accessing the
extension's DOM or APIs. The extension's own scripts remain packaged locally.

Sources: [Chrome extension sandbox rules](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox),
[sandbox inheritance](https://web.dev/articles/sandboxed-iframes),
[isolated iframe policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements).

## What this version does

- Connect/disconnect Google Drive and switch accounts through Chrome Identity.
- Upload PDF, DOCX, TXT, JPG/JPEG and PNG originals, up to 20 MB per file.
- Use the account's `Filewise uploads` folder, or an explicitly selected writable folder.
- Register existing files selected in Google Picker without copying or moving them.
- Keep account-scoped metadata, SHA-256 for local uploads, and processing state.
- Search registered filenames, refresh permissions/metadata, open files in Drive, and download originals.
- Recover completed-but-unrecorded uploads by their preallocated Drive ID. For unfinished
  uploads, choose Retry and reselect the same original; the checksum must match.

Keep the extension tab open until an upload finishes. It does not persist file contents;
closing the tab can interrupt transfer. The persisted journal and resumable session enable
recovery without replacing the Drive ID. Do not delete the journal to resolve an uncertain upload.

Selecting a folder chooses an upload destination. It does not grant automatic access to every
existing child or recursively import the folder. Pick existing files explicitly. This is the
`drive.file` permission boundary, not an entire-Drive crawler.

Google-native Docs/Sheets/Slides require a later export workflow; this milestone handles
uploaded original file formats. Automatic classification, category subfolders, OCR and
meaning-based search remain later milestones. New records show that content is not processed.

## Where information lives

- Original bytes: the user's Google Drive, using that account's quota.
- Metadata/journal: IndexedDB in this Chrome profile, keyed by Drive account permission ID
  and file/operation ID. Not shared across accounts or automatically synced across devices.
- Active account: `chrome.storage.session`; browser restarts can require reconnecting.
- Access tokens: Chrome Identity's managed cache and temporary memory only. No token in
  IndexedDB, `chrome.storage.local`, logs, file URLs, or a server database.
- Picker: Google's SDK runs in the configured web helper, which has no extension APIs.
  The extension accepts the helper's ready message only from its exact iframe window and
  configured origin. The helper accepts initialization only from its parent and an allowed
  extension origin. An exact-origin initialization message transfers transient Picker
  credentials and a private MessagePort; results return through that port. Credentials are
  never placed in helper URLs or persisted by the helper. Canonical metadata is fetched
  again through the active account before saving an asset.

Disconnect clears the active session and Chrome's cached authorization. It does not delete
Drive originals or the account's local library. Remove app access in Google Account settings
to revoke the grant. Uninstalling/clearing extension data removes the local index and recovery
journal; Drive originals remain. Re-register files with Picker to rebuild the library.

## Automated tests

With Node 22 or newer:

```powershell
cd frontend/extension
npm test
```

The unit/integration suites use fake Drive responses; they never need real credentials or
touch a Google account. Browser smoke tests additionally exercise real IndexedDB and the UI
with a mocked Google API. See `tests/browser-smoke.mjs` for the optional Playwright runner.

## Live acceptance checklist (requires your Google configuration)

The user has reported successful Google OAuth connection, upload, hosted Add from Drive,
filename search, persistence after closing/reopening Filewise, and opening downloaded files
in the real extension. On 2026-10-01, they replied "now all working" after the folder-selection
and upload-destination check, and requested a PR for issue #2. These are user-reported live
results. Exact-byte comparison and the remaining unchecked failure/recovery scenarios have
not been individually confirmed live; automated tests cover them using mocked responses.

- [x] Verify the deployed HTTPS helper loads without enforced CSP errors or origin-`null`
  CORS failures (independent dummy-OAuth probe; user also reports live Add from Drive working).
- [x] Connect account A and use both file and folder Picker modes through the hosted helper (user-reported).
- [x] Choose an upload folder and confirm a new upload appears there in Drive (user-reported).
- [ ] Upload a supported sample; verify the original in A's Drive and its exact bytes after download.
- [x] Download a registered file and confirm it opens correctly (user-reported; not an exact-byte comparison).
- [ ] Register an existing file; verify that its Drive ID, parent and contents are unchanged.
- [x] Close/reopen Filewise and confirm the added file is still listed and searchable (user-reported).
- [ ] Interrupt a transfer and retry the same original; verify exactly one Drive file is created.
- [ ] Disconnect/switch to B; A's files and pending operations must disappear immediately.
- [ ] Revoke app/file access and refresh; stale results must not permit retrieval.
- [ ] Verify useful errors for unsupported/oversized files, quota exhaustion and lost network.
- [ ] Verify Google Picker API key restrictions with the actual web helper and Google frame.
- [ ] For a distribution build, repeat Picker selection with the hosted HTTPS helper and
  no local development server running.

The remaining checks stay unchecked until individually confirmed with the real Google project.
Passing mocked tests alone does not establish live behavior for those scenarios.

## Publication

The current directory is an unpacked development extension. A public release additionally
needs your consent-screen/publication configuration, a privacy policy describing local
metadata and Google access, and Chrome Web Store review. Publishing the static helper does
not publish the extension to the Chrome Web Store or complete the live acceptance checks.
