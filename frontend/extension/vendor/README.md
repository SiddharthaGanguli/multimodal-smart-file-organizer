# Bundled OCR runtime

These files ship with the unpacked extension. No CDN, runtime package installation,
or external OCR service is used. Approximately 20 MB of runtime assets are included.

| Directory | Source | Version | License |
|---|---|---|---|
| tesseract | https://github.com/naptha/tesseract.js | 7.0.0 | Apache-2.0; bundled dependency notices alongside the worker |
| tesseract-core | https://github.com/naptha/tesseract.js-core | 7.0.0 | Apache-2.0 |
| tessdata | https://github.com/naptha/tessdata | @tesseract.js-data/eng 1.0.0, 4.0.0_best_int | Upstream traineddata Apache-2.0 (npm metadata labels its packaging MIT) |
| pdfjs | https://github.com/mozilla/pdf.js | pdfjs-dist 6.3.289, legacy build | Apache-2.0; font/codec licenses in their directories |

The vendored JavaScript, fonts, models, and WASM builds are unmodified upstream
files, selected from SHA-512-verified npm archives. LSTM-only scalar, SIMD, and
relaxed-SIMD cores are included. PDF document scripting/QuickJS is not included.
`inventory.json` records each selected file's size and SHA-256, with the language
data license separately attributed to its upstream source.

Maintainers can reproduce these assets from the repository root with:

```sh
python frontend/extension/tools/vendor_ocr.py
```

Run the Node integrity test and installed-extension OCR suite after changing any
dependency. The browser adapter uses the pinned Tesseract worker message protocol
so it can terminate a hung worker even before initialization finishes. Review that
protocol when upgrading. Keep the license/notice files in distributed builds.
