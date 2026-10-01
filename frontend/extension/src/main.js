import { CONFIG, isConfigured } from "../config.js";
import { ChromeAuth } from "./auth.js";
import { DriveClient } from "./drive.js";
import { LibraryStore } from "./store.js";
import { Library } from "./library.js";
import { createPicker } from "./picker.js";
import { createView } from "./view.js";
import { OcrLibrary } from "./ocr/library.js";
import { recognize } from "./ocr/browser.js";
import { createOcrView } from "./ocr/view.js";
import { LocalExtractor, canExtract } from "./extraction.js";

const view = createView();
const auth = new ChromeAuth();
const store = new LibraryStore();
const extractor = new LocalExtractor({ baseUrl: CONFIG.extractionApiUrl });
const picker = createPicker({
  dialog: document.getElementById("picker-dialog"),
  iframe: document.getElementById("picker-frame"),
  loadingStatus: document.getElementById("picker-loading"),
});
let session = null;
let library = null;
let ocrLibrary = null;
let ocrController = null;
const ocrView = createOcrView({ onCancel: () => ocrController?.abort(), onRetry: id => readText(id, true) });
let allAssets = [];
let busy = false;
const state = {
  configured: isConfigured(chrome.runtime.getManifest()), connected: false,
  account: null, assets: [], pending: [], folder: null, busy: false, ocr: {},
};

function render() {
  state.assets = allAssets;
  state.busy = busy;
  view.render(state);
}

function clearAccount() {
  ocrController?.abort();
  ocrView.clear();
  ocrLibrary = null;
  state.ocr = {};
  picker.close();
  view.closeExtraction();
  session = null;
  library = null;
  allAssets = [];
  state.account = null;
  state.connected = false;
  state.pending = [];
  state.folder = null;
  render();
}

async function loadLibrary() {
  if (!library) return;
  const activeLibrary = library;
  const pending = await activeLibrary.recover();
  const assets = await activeLibrary.refresh();
  const ocr = ocrLibrary ? await ocrLibrary.summaries(assets) : {};
  let folder = null;
  try { folder = await activeLibrary.destination(); } catch (error) {
    view.notify(error.message, "error");
  }
  await activeLibrary.guard();
  if (library !== activeLibrary) return;
  state.pending = pending;
  allAssets = assets;
  state.ocr = ocr;
  state.folder = folder;
  render();
}

async function connect(interactive = true) {
  if (!state.configured) throw new Error("Complete the Google Cloud setup in manifest.json and config.js first.");
  const previous = interactive ? null : await auth.current();
  clearAccount();
  await auth.token(interactive);
  const initialDrive = new DriveClient({ getToken: () => auth.token(false), invalidateToken: (token) => auth.invalidate(token) });
  const account = await initialDrive.getAccount();
  if (previous && previous.id === account.id) {
    await auth.assert(previous);
    session = previous;
  } else session = await auth.activate(account);
  const boundSession = session;
  const drive = new DriveClient({
    getToken: () => auth.tokenFor(boundSession), invalidateToken: (token) => auth.invalidate(token),
  });
  library = new Library({ store, drive, auth, session: boundSession, config: CONFIG, extractor });
  ocrLibrary = new OcrLibrary({ store, drive, auth, session: boundSession, recognize });
  state.account = account;
  state.connected = true;
  await loadLibrary();
  view.notify(`Connected to ${account.email || account.name || "your Google Drive"}.`, "success");
}

async function perform(message, action) {
  if (busy) return;
  busy = true;
  const operationSession = session;
  render();
  view.setBusy(true, message);
  try {
    await action();
  } catch (error) {
    if (error.code === "authRequired" || error.status === 401) {
      const affected = operationSession || session;
      clearAccount();
      if (affected) await auth.disconnect(affected).catch(() => {});
    }
    if (error.code === "accountChanged") clearAccount();
    view.notify(error.message || "Something went wrong. Please try again.", "error");
    // Reflect the persisted recovery journal even after a failed remote/local operation.
    if (session && library) {
      const current = session;
      try {
        const pending = await store.list("operations", current.id);
        await auth.assert(current);
        state.pending = pending;
      } catch { /* A different account may now be active. */ }
    }
  } finally {
    busy = false;
    view.setBusy(false);
    render();
  }
}

view.on("connect", () => perform("Connecting to Google Drive…", () => connect()));
view.on("disconnect", () => perform("Disconnecting…", async () => {
  clearAccount();
  await auth.disconnect();
  view.notify("Disconnected. Your originals remain in Google Drive.");
}));
view.on("switch", () => perform("Switching account…", async () => {
  clearAccount();
  await auth.disconnect();
  await connect();
}));
view.on("search", render);
function readText(id, force = false) {
  return perform("Reading text on this device…", async () => {
    const active = ocrLibrary;
    const asset = allAssets.find(item => item.assetId === id);
    if (!active || !asset) throw new Error("Connect Drive and choose a file first.");
    const controller = new AbortController();
    ocrController = controller;
    ocrView.start(asset);
    try {
      const result = await active.read(id, { force, signal: controller.signal, onProgress: value => {
        if (ocrLibrary === active) ocrView.progress(value);
      } });
      await active.guard();
      if (ocrLibrary === active) {
        ocrView.show(result);
        await loadLibrary();
      }
    } catch (error) {
      if (ocrLibrary === active) ocrView.error(error.code === "cancelled" || error.name === "AbortError" ? "Reading cancelled. You can try again." : error.message);
      try {
        const summaries = await active.summaries(allAssets);
        if (ocrLibrary === active) state.ocr = summaries;
      } catch { /* The account may have changed while the operation was running. */ }
      if (error.code !== "cancelled" && error.name !== "AbortError") throw error;
    } finally { if (ocrController === controller) ocrController = null; }
  });
}
view.on("ocr", ({ id }) => readText(id));
view.on("refresh", () => perform("Checking your Drive files…", loadLibrary));
view.on("close-picker", () => picker.close());

async function select(mode) {
  if (!library || !session) throw new Error("Connect Google Drive first.");
  const current = session;
  const token = await auth.tokenFor(current);
  const ids = await picker.choose({ token, config: CONFIG, mode });
  await auth.assert(current);
  return ids;
}

view.on("import", () => perform("Choose files from Google Drive…", async () => {
  const ids = await select("files");
  if (!ids.length) return;
  const count = await library.importFiles(ids);
  await loadLibrary();
  const currentLibrary = library;
  for (const asset of allAssets.filter(asset => ids.includes(asset.driveFileId))) {
    if (canExtract(asset) && ["not_processed", "failed"].includes(asset.processingStatus)) {
      await processAsset(currentLibrary, asset);
    }
  }
  view.notify(`Added ${count} file${count === 1 ? "" : "s"} to your library. Originals stayed in place.`, "success");
}));
view.on("folder", () => perform("Choose an upload folder…", async () => {
  const ids = await select("folder");
  if (!ids.length) return;
  state.folder = await library.setDestination(ids[0]);
  view.notify(`New uploads will go to ${state.folder.name}.`, "success");
}));

async function uploadFiles(files, operationId) {
  if (!library) throw new Error("Connect Google Drive first.");
  const currentLibrary = library;
  let completed = 0;
  for (const file of Array.from(files || [])) {
    const asset = await currentLibrary.upload(file, {
      operationId,
      onProgress: (fraction) => {
        if (library === currentLibrary) view.setBusy(true, `${file.name} · ${Math.round(fraction * 100)}%`);
      },
    });
    completed++;
    if (canExtract(asset)) await processAsset(currentLibrary, asset);
  }
  await loadLibrary();
  if (completed) view.notify(`Saved ${completed} file${completed === 1 ? "" : "s"} to your Google Drive.`, "success");
}
view.on("upload", ({ files }) => perform("Validating your files…", () => uploadFiles(files)));
view.on("retry", ({ id, files }) => perform("Checking the interrupted upload…", () => uploadFiles(files, id)));

function updateAsset(asset) {
  allAssets = [asset, ...allAssets.filter(record => record.assetId !== asset.assetId)]
    .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  render();
}

async function processAsset(currentLibrary, asset) {
  if (!currentLibrary || currentLibrary !== library) throw new Error("Connect Google Drive first.");
  await currentLibrary.guard();
  updateAsset({ ...asset, processingStatus: "processing" });
  view.setBusy(true, `Extracting text from ${asset.name}…`);
  try {
    const processed = await currentLibrary.extract(asset.assetId);
    await currentLibrary.guard();
    if (currentLibrary !== library) return;
    updateAsset(processed);
    if (processed.processingStatus === "failed") view.notify(processed.processingError || "Text extraction failed. Retry this file.", "error");
  } catch (error) {
    // Replace temporary UI state with authoritative account-scoped records.
    await currentLibrary.guard();
    if (currentLibrary === library) {
      const records = await store.list("assets", currentLibrary.session.id);
      await currentLibrary.guard();
      if (currentLibrary === library) { allAssets = records; render(); }
    }
    throw error;
  }
}

view.on("extract", ({ id }) => perform("Extracting document text…", async () => {
  const asset = allAssets.find(record => record.assetId === id);
  if (!asset) throw new Error("File not found in this account.");
  await processAsset(library, asset);
}));
view.on("view-text", ({ id }) => perform("Checking access to extracted text…", async () => {
  if (!library) throw new Error("Connect Google Drive first.");
  const currentLibrary = library;
  try {
    const result = await currentLibrary.extractionResult(id);
    if (library === currentLibrary) view.showExtraction(result);
  } finally {
    await currentLibrary.guard();
    const records = await store.list("assets", currentLibrary.session.id);
    await currentLibrary.guard();
    if (library === currentLibrary) allAssets = records;
  }
}));

view.on("open", ({ id }) => perform("Checking Drive access…", async () => {
  if (!library) throw new Error("Connect Google Drive first.");
  const url = await library.access(id);
  await chrome.tabs.create({ url });
}));
view.on("download", ({ id }) => perform("Downloading the original…", async () => {
  if (!library) throw new Error("Connect Google Drive first.");
  const { blob, name } = await library.access(id, { download: true });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[\\/]/g, "_");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  view.notify("Original downloaded.", "success");
}));

// Other extension tabs can switch/disconnect too. Immediately discard rendered
// account data and abort the Picker; operation guards stop subsequent requests.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.activeAccount && session &&
      changes.activeAccount.newValue?.epoch !== session.epoch) {
    clearAccount();
    view.notify("The connected account changed in another tab. Connect to continue.");
  }
});

render();
if (state.configured) {
  const previous = await auth.current();
  if (previous) await perform("Restoring your Drive connection…", () => connect(false));
}
