/* Classic worker entry point: local, losslessly compressed Tesseract WASM. */
(() => {
  // importScripts resolves against the Tesseract worker's URL, not this script.
  const core = new URL("../tesseract-core/", self.location.href);
  importScripts(new URL("tesseract-core-simd-lstm.js", core).href);
  const createCore = self.TesseractCore;
  self.TesseractCore = async options => {
    const response = await fetch(new URL("tesseract-core-simd-lstm.wasm.gz", core));
    if (!response.ok || !response.body) throw new Error("The packaged OCR engine could not be loaded.");
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    const wasmBinary = new Uint8Array(await new Response(stream).arrayBuffer());
    return createCore({ ...options, wasmBinary });
  };
})();
