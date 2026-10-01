# Frontend

The current user interface is the Chrome extension in `extension/`.
See [setup instructions](../docs/extension-setup.md) and the root README.

It uses plain JavaScript modules with no package dependencies or build step.
Google OAuth/Picker configuration is required for a connected build.

Google Picker's helper source lives in `picker-bridge/`. Its hosted address is
<https://siddharthaganguli.github.io/multimodal-smart-file-organizer/>. The three static files
are published on `gh-pages`; all returned HTTP 200 and matched the reviewed source byte for
byte. Browser verification of the hosted integration passed. Users
of the hosted helper need no local server, Node, Python, or database.

For optional local helper development, set `googlePickerBridgeUrl` in `extension/config.js`
to `http://127.0.0.1:8765/picker.html`. On Windows, double-click
`picker-bridge/Start-PickerBridge.cmd` to run it in the background, or run the following
from the repository root and keep that terminal open while using Picker:

```powershell
node frontend/picker-bridge/serve.mjs
```

The server requires Node 22 or newer, binds only to `127.0.0.1:8765`, and serves a fixed list
of helper files. Check the public extension-origin allowlist in the helper's `config.js`,
then reload the unpacked extension. Restore the hosted URL when finished testing locally.

The publishing branch contains only `index.html` (from `picker.html`), `picker.js`, and the
public origin configuration `config.js`. The helper runs as a normal cross-origin iframe, not an opaque
extension sandbox; the latter caused confirmed origin-`null` CORS failures in Google's Picker.
Credentials travel through validated browser messaging, never helper URLs or persistent storage.
See the setup guide for GitHub Pages maintenance instructions. The extension implementation
has not been merged into `main`; publishing its helper does not release the extension.

The user has reported working OAuth, upload, filename search, persistence, downloads, and
hosted file/folder selection. Additional live failure/recovery checks are listed in the setup
guide. OCR, automatic category folders, and content-aware search are later milestones.
