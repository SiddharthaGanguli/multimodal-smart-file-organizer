import { OCR_TYPES } from "./ocr/pipeline.js";
import { canExtract } from "./extraction.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  file: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h4",
  image: "M3 4h18v16H3z M3 17l5-5 4 4 3-3 6 5 M8 8h.01",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 17v4h16v-4",
  search: "M16 16l5 5 M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function icon(name = "file") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name] || ICONS.file);
  svg.append(path);
  return svg;
}

function button(label, action, className = "row-action", id) {
  const node = element("button", className, label);
  node.type = "button";
  node.dataset.action = action;
  if (id !== undefined) node.dataset.id = String(id);
  return node;
}

function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0 || bytes === null || bytes === undefined) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[index]}`;
}

function fileType(asset) {
  const mime = String(asset.mimeType || "");
  const name = String(asset.name || "");
  if (mime.includes("folder")) return { label: "FOLDER", className: "sheet", icon: "file" };
  if (mime.includes("pdf") || /\.pdf$/i.test(name)) return { label: "PDF", className: "pdf", icon: "file" };
  if (mime.startsWith("image/")) return { label: "IMAGE", className: "image", icon: "image" };
  if (/spreadsheet|excel|csv/.test(mime)) return { label: "SHEET", className: "sheet", icon: "file" };
  if (/document|word/.test(mime)) return { label: "DOC", className: "", icon: "file" };
  if (mime.startsWith("text/")) return { label: "TEXT", className: "", icon: "file" };
  const extension = name.includes(".") ? name.split(".").at(-1).slice(0, 8).toUpperCase() : "FILE";
  return { label: extension, className: "", icon: "file" };
}

function statusInfo(value) {
  const status = String(value || "saved").toLowerCase();
  const extractionStates = {
    extracted: { label: "Extracted", className: "" },
    needs_ocr: { label: "OCR needed", className: "pending" },
    empty: { label: "No text", className: "pending" },
    failed: { label: "Extraction failed", className: "error" },
    processing: { label: "Extracting", className: "pending" },
  };
  if (Object.hasOwn(extractionStates, status)) return extractionStates[status];
  if (/error|failed/.test(status)) return { label: "Needs attention", className: "error" };
  if (/pending|processing|queued|uploading|importing/.test(status)) {
    return { label: status === "processing" ? "Processing" : "Pending", className: "pending" };
  }
  if (/not.?processed|unprocessed|stored|saved|uploaded|imported/.test(status)) {
    return { label: "Saved", className: "" };
  }
  if (/ready|complete|processed/.test(status)) return { label: "Ready", className: "" };
  return { label: status.replaceAll("_", " "), className: "" };
}

/** DOM-only renderer. No authentication, network calls, or persistent state. */
export function createView(root = document) {
  const find = (selector) => root.querySelector(selector);
  const handlers = new Map();
  let latestState = { configured: false, connected: false, assets: [], pending: [] };
  let busyOverride = false;
  let retryId;
  const emit = (action, payload = {}) => {
    for (const handler of handlers.get(action) || []) handler(payload);
  };

  root.addEventListener("click", (event) => {
    const target = event.target.closest?.("[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (action === "upload") {
      find("#upload-input").value = "";
      find("#upload-input").click();
      return;
    }
    if (action === "retry") {
      retryId = id;
      find("#retry-input").value = "";
      find("#retry-input").click();
      return;
    }
    if (action === "setup") {
      const details = find("#setup-details");
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "nearest" });
      details.querySelector("summary").focus({ preventScroll: true });
    }
    if (action === "close-picker") find("#picker-dialog").close();
    if (action === "close-extraction") closeExtraction();
    emit(action, id === undefined ? {} : { id });
  });

  find("#upload-input").addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (input.files?.length) emit("upload", { files: input.files });
  });
  find("#retry-input").addEventListener("change", (event) => {
    const input = event.currentTarget;
    if (input.files?.length && retryId) emit("retry", { id: retryId, files: input.files });
    retryId = undefined;
  });
  find("#file-search").addEventListener("input", (event) => {
    emit("search", { query: event.currentTarget.value });
    renderLibrary(latestState);
  });

  function disabledFor(action, state) {
    if (["setup", "close-picker", "close-extraction"].includes(action)) return false;
    if (busyOverride || state.busy) return true;
    if (action === "connect") return !state.configured;
    if (["upload", "import", "folder", "refresh", "switch", "disconnect", "retry", "open", "download", "ocr", "extract", "view-text"].includes(action)) {
      return !state.configured || !state.connected;
    }
    return false;
  }

  function syncControls(state) {
    for (const control of root.querySelectorAll("button[data-action]")) {
      control.disabled = disabledFor(control.dataset.action, state);
    }
    const busy = Boolean(busyOverride || state.busy);
    find("#library").setAttribute("aria-busy", String(busy));
    find("#busy-indicator").hidden = !busy;
    const busyText = typeof state.message === "string" ? state.message : "";
    if (!busyOverride) find("#busy-message").textContent = busyText || "Working…";
  }

  function renderEmpty({ title, description, action, label, loading = false, searching = false }) {
    const container = element("div", `empty-state${loading ? " loading-state" : ""}`);
    if (loading) container.append(element("span", "spinner"));
    else {
      const graphic = element("div", "empty-illustration");
      graphic.setAttribute("aria-hidden", "true");
      graphic.append(icon(searching ? "search" : "file"));
      container.append(graphic);
    }
    container.append(element("h3", "", title), element("p", "", description));
    if (action) container.append(button(label, action, "button button-primary"));
    return container;
  }

  function renderLibrary(state) {
    const allAssets = Array.isArray(state.assets) ? state.assets : [];
    const query = find("#file-search").value.trim().toLocaleLowerCase();
    const assets = allAssets.filter((asset) => String(asset.name || "").toLocaleLowerCase().includes(query));
    find("#visible-count").textContent = String(assets.length);
    find("#library-footer-count").textContent = query
      ? `${assets.length} of ${allAssets.length} files`
      : `${allAssets.length} ${allAssets.length === 1 ? "file" : "files"} in your library`;
    const content = find("#library-content");
    const footerNote = find(".library-footer > span:last-child");
    footerNote.lastChild?.remove();
    footerNote.append(document.createTextNode(state.connected ? "Connected to your Google Drive" : "Files stay in your Google Drive"));
    if (!assets.length) {
      let empty;
      if (query) empty = { title: "No matching filenames", description: "Try another filename or clear your search to see all files.", searching: true };
      else if (state.busy || busyOverride) empty = { title: "Getting things ready", description: "Your library will appear here in a moment.", loading: true };
      else if (!state.configured) empty = { title: "Your library starts here", description: "Finish the extension setup, then connect Google Drive to start adding your files.", action: "setup", label: "View setup instructions" };
      else if (!state.connected) empty = { title: "A home for your Drive files", description: "Connect your Google account to upload files and bring existing Drive files into your library.", action: "connect", label: "Connect Google Drive" };
      else empty = { title: "Room for your next big idea", description: "Upload your first file or choose an existing one from Google Drive. Your library will grow from here.", action: "upload", label: "Upload your first file" };
      content.replaceChildren(renderEmpty(empty));
      syncControls(state);
      return;
    }
    const table = element("table", "file-table");
    const caption = element("caption", "sr-only", "Files in your Drive library");
    const thead = element("thead");
    const header = element("tr");
    for (const label of ["Name", "Type", "Size", "Status", "Actions"]) {
      const th = element("th", "", label);
      th.scope = "col";
      header.append(th);
    }
    thead.append(header);
    const tbody = element("tbody");
    for (const asset of assets) {
      const id = asset.assetId || asset.driveFileId;
      const type = fileType(asset);
      const status = statusInfo(asset.processingStatus);
      const row = element("tr");
      const nameCell = element("td");
      const nameWrap = element("div", "file-name-cell");
      const fileIcon = element("span", `file-icon ${type.className}`);
      fileIcon.append(icon(type.icon));
      const name = element("span", "file-name", asset.name || "Untitled file");
      name.title = String(asset.name || "Untitled file");
      nameWrap.append(fileIcon, name);
      nameCell.append(nameWrap);
      const typeCell = element("td", "file-type", type.label);
      const sizeCell = element("td", "", formatSize(asset.size));
      const statusCell = element("td");
      const badge = element("span", `status-badge ${status.className}`, status.label);
      if (asset.processingError) badge.title = String(asset.processingError);
      statusCell.append(badge);
      const ocrStatus = state.ocr?.[id];
      if (ocrStatus) {
        const label = { complete: "Text ready", needs_review: "Review text", empty: "No text", partial: "Some text", failed: "OCR failed", cancelled: "OCR cancelled" }[ocrStatus];
        statusCell.append(element("span", "ocr-badge", label || ocrStatus));
      }
      const actionCell = element("td");
      const actions = element("div", "row-actions");
      const open = button("Open", "open", "row-action", id);
      open.setAttribute("aria-label", `Open ${asset.name || "file"} in Google Drive`);
      const download = button("", "download", "row-action", id);
      download.title = "Download file";
      download.setAttribute("aria-label", `Download ${asset.name || "file"}`);
      download.append(icon("download"));
      actions.append(open, download);
      if (OCR_TYPES.includes(asset.mimeType)) {
        const read = button(ocrStatus ? "View OCR text" : asset.mimeType === "application/pdf" ? "Read scan" : "Read text", "ocr", "row-action", id);
        read.setAttribute("aria-label", `${ocrStatus ? "View" : "Read"} OCR text in ${asset.name || "file"}`);
        actions.append(read);
      }
      if (canExtract(asset) && (!asset.extraction || asset.processingStatus === "failed")) {
        const label = asset.processingStatus === "failed" ? "Retry extraction" : "Extract text";
        const extract = button(label, "extract", "row-action", id);
        extract.setAttribute("aria-label", `${label} for ${asset.name || "file"}`);
        actions.append(extract);
      }
      if (asset.extraction) {
        const preview = button("View text", "view-text", "row-action", id);
        preview.setAttribute("aria-label", `View extracted text for ${asset.name || "file"}`);
        actions.append(preview);
      }
      actionCell.append(actions);
      row.append(nameCell, typeCell, sizeCell, statusCell, actionCell);
      tbody.append(row);
    }
    table.append(caption, thead, tbody);
    content.replaceChildren(table);
    syncControls(state);
  }

  function renderPending(state) {
    const pending = Array.isArray(state.pending) ? state.pending : [];
    find("#pending-section").hidden = !pending.length;
    const nodes = pending.map((operation) => {
      const row = element("div", "pending-row");
      const graphic = element("span", "file-icon pdf");
      graphic.append(icon());
      const copy = element("div", "pending-copy");
      copy.append(element("strong", "", operation.name || "Unfinished file operation"));
      const error = typeof operation.error === "string" ? operation.error : operation.error?.message;
      copy.append(element("p", "", error || String(operation.status || "Pending").replaceAll("_", " ")));
      const actions = element("div", "row-actions");
      const retry = button("Retry with original file", "retry", "row-action", operation.operationId);
      retry.title = "Choose the same original file to retry this unfinished operation";
      actions.append(retry);
      row.append(graphic, copy, actions);
      return row;
    });
    find("#pending-list").replaceChildren(...nodes);
  }

  function render(state) {
    latestState = { ...state, assets: state.assets || [], pending: state.pending || [] };
    const count = latestState.assets.length;
    const pendingCount = latestState.pending.length;
    find("#nav-count").textContent = String(count);
    find("#file-count").replaceChildren(document.createTextNode(`${count} `), element("small", "", count === 1 ? "file" : "files"));
    find("#pending-count").replaceChildren(document.createTextNode(`${pendingCount} `), element("small", "", pendingCount === 1 ? "item" : "items"));
    find("#pending-caption").textContent = pendingCount ? "CHECK ACTIVITY" : "UP TO DATE";
    find("#folder-name").textContent = state.folder?.name || "Filewise uploads";
    find("#folder-name").title = state.folder?.name || "Created on your first upload";
    const accountName = state.account?.name || state.account?.email || "Personal workspace";
    find("#sidebar-account-name").textContent = state.connected ? accountName : "Personal workspace";
    find("#sidebar-account-state").textContent = state.connected ? (state.account?.email || "Google Drive · connected") : "Google Drive · not connected";
    find("#sidebar-account-state").title = state.account?.email || "";
    find("#sidebar-avatar").textContent = (state.connected ? accountName : "Personal").slice(0, 1).toUpperCase();
    find("#account-dot").classList.toggle("connected", Boolean(state.connected));
    const connectionLabel = find("#connection-label");
    connectionLabel.classList.toggle("connected", Boolean(state.connected));
    connectionLabel.replaceChildren(element("span", "connection-dot"), document.createTextNode(state.connected ? "Drive connected" : "Drive not connected"));
    find("#connect-button").hidden = Boolean(state.connected);
    find("#switch-button").hidden = !state.connected;
    find("#disconnect-button").hidden = !state.connected;
    const banner = find("#status-banner");
    const bannerAction = find("#status-action");
    const errorMessage = state.error || (typeof state.message === "object" && state.message?.kind === "error" ? state.message.text : "");
    banner.classList.toggle("error", Boolean(errorMessage));
    banner.hidden = Boolean(state.configured && state.connected && !errorMessage);
    if (errorMessage) {
      find("#status-title").textContent = "Something needs another try";
      find("#status-description").textContent = String(errorMessage.message || errorMessage);
      bannerAction.textContent = state.connected ? "Refresh" : "View setup";
      bannerAction.dataset.action = state.connected ? "refresh" : "setup";
    } else if (!state.configured) {
      find("#status-title").textContent = "One small setup before you start";
      find("#status-description").textContent = "Add your Google project configuration to enable Drive sign-in and the file picker.";
      bannerAction.textContent = "View setup";
      bannerAction.dataset.action = "setup";
    } else if (!state.connected) {
      find("#status-title").textContent = "Bring your Google Drive along";
      find("#status-description").textContent = "Connect your account to upload, choose files, and keep your library in sync.";
      bannerAction.textContent = "Connect Drive";
      bannerAction.dataset.action = "connect";
    }
    renderPending(latestState);
    renderLibrary(latestState);
    syncControls(latestState);
  }

  function notify(message, kind = "info") {
    const toast = element("div", `toast ${["info", "error", "success"].includes(kind) ? kind : "info"}`);
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    const close = element("button", "", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss notification");
    close.addEventListener("click", () => toast.remove());
    toast.append(element("span", "", message), close);
    find("#toast-stack").append(toast);
    if (kind !== "error") window.setTimeout(() => toast.remove(), 7000);
  }

  function setBusy(value, message = "") {
    busyOverride = Boolean(value);
    find("#busy-message").textContent = message || "Working…";
    renderLibrary(latestState);
    syncControls(latestState);
  }

  function showExtraction(result) {
    const dialog = find("#extraction-dialog");
    find("#extraction-filename").textContent = result.source_name || "Untitled file";
    const status = statusInfo(result.status);
    const badge = find("#extraction-status");
    badge.textContent = status.label;
    badge.className = `status-badge ${status.className}`;
    const ocrPages = Array.isArray(result.ocr_pages) ? result.ocr_pages : [];
    const hint = find("#extraction-hint");
    hint.textContent = result.error
      ? String(result.error)
      : ocrPages.length
        ? `Pages ${ocrPages.join(", ")} need OCR. Text from other pages is shown below. Close this preview and choose Read scan (or View OCR text) to read scanned pages on this device.`
        : result.status === "empty" ? "No text was found in this document." : "Extracted text is stored on this device. PDF table formatting may not be preserved.";
    find("#extraction-text").textContent = result.text || "No extracted text available.";
    if (!dialog.open) dialog.showModal();
  }

  function closeExtraction() {
    const dialog = find("#extraction-dialog");
    if (dialog.open) dialog.close();
    for (const selector of ["#extraction-filename", "#extraction-status", "#extraction-hint", "#extraction-text"]) {
      find(selector).textContent = "";
    }
  }

  return {
    render,
    notify,
    setBusy,
    showExtraction,
    closeExtraction,
    on(action, handler) {
      if (!handlers.has(action)) handlers.set(action, new Set());
      handlers.get(action).add(handler);
      return () => handlers.get(action)?.delete(handler);
    },
  };
}
