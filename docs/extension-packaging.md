# Extension distribution and size budget

The distributable extension must stay within **10,000,000 bytes (10 MB)**, both as
a ZIP and as the sum of its unpacked file sizes. This is a source/package budget,
not a cap on Chrome memory, filesystem allocation or stored user text.

## Build and install

From the repository root, using Python 3.11+ (standard library only):

```sh
python frontend/extension/tools/package_extension.py
```

The result is `dist/filewise-0.2.2.zip`. Share this extension-only ZIP. Unzip it into
a permanent folder, open `chrome://extensions`, enable Developer mode, choose
**Load unpacked**, and select the folder containing `manifest.json`. Existing users
can replace their extension files with the ZIP contents, close Filewise tabs, and
click **Reload**. The shared extension ID and Google configuration are unchanged.

This package contains the extension and local OCR. TXT/DOCX/embedded-PDF extraction
still requires the separately installed Python companion; see the
[extraction guide](document-extraction.md). Packaging does not publish a Chrome Web
Store release or start the companion.

## Enforced checks

`python frontend/extension/tools/package_extension.py --check` validates without
saving a ZIP. The packaging workflow runs on pull requests and pushes to `main`,
and can be started manually. It uploads the clean ZIP as a workflow artifact only
after both size checks pass. Maintainers should require the **Extension size budget /
package** check in branch rules to prevent merging a failing build.

The builder includes explicit entry files, runtime JavaScript under `src/`, and
inventoried vendor assets with licenses and notices. It verifies vendor hashes,
including decompressed WASM provenance, and rejects unexpected vendor files. Tests,
browser profiles, screenshots, development tools, Python environments and Git history
are excluded. ZIP paths and timestamps are deterministic; project text uses LF
line endings so Windows checkouts match Linux CI. Vendor bytes remain untouched.

Browser runners write to `tmp/extension-tests/` outside the extension. The local
300+ MB measurement was primarily test profiles and screenshots; GitHub source ZIPs
do not include those ignored files. Existing test output was preserved outside the
extension, not deleted.

## Runtime reduction

Version 0.2.2 replaces three embedded OCR cores with one standard-SIMD core and its
losslessly compressed WASM binary, and removes an unused Tesseract facade. It keeps
the same English best-int model, PDF rendering assets and on-device processing.
See the [vendor inventory](../frontend/extension/vendor/README.md) for reproduction.

Any dependency or runtime change must pass the size check and the installed-extension
OCR tests. To test the actual ZIP, unzip into a temporary folder outside the extension,
set `FILEWISE_EXTENSION_ROOT` to that folder, and run
`node frontend/extension/tests/ocr-browser.mjs`. No recognition assets are fetched
from the internet during this test.
