const LABELS = { complete: "Text ready", needs_review: "Check the recognized text", empty: "No text found",
  partial: "Some pages could not be read", failed: "Could not read this file", cancelled: "Reading cancelled" };

export function createOcrView({ onCancel, onRetry }) {
  const dialog = document.getElementById("ocr-dialog");
  const title = document.getElementById("ocr-title");
  const status = document.getElementById("ocr-status");
  const progress = document.getElementById("ocr-progress");
  const pages = document.getElementById("ocr-pages");
  const cancel = document.getElementById("ocr-cancel");
  const retry = document.getElementById("ocr-retry");
  let assetId;
  function clear() { dialog.close(); pages.replaceChildren(); title.textContent = "Read text"; status.textContent = ""; assetId = null; }
  document.getElementById("ocr-close").addEventListener("click", () => { onCancel(); clear(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); onCancel(); clear(); });
  cancel.addEventListener("click", () => { cancel.disabled = true; status.textContent = "Cancelling…"; onCancel(); });
  retry.addEventListener("click", () => onRetry(assetId));
  function finished() { progress.hidden = true; cancel.hidden = true; retry.hidden = false; }
  return {
    clear,
    start(asset) {
      assetId = asset.assetId;
      title.textContent = asset.name;
      pages.replaceChildren();
      status.textContent = "Checking Drive access…";
      progress.hidden = false; progress.removeAttribute("value");
      cancel.hidden = false; cancel.disabled = false; retry.hidden = true;
      if (!dialog.open) dialog.showModal();
    },
    progress(value) {
      if (!assetId || cancel.disabled) return;
      status.textContent = value.pageNumber ? `Reading page ${value.pageNumber}…` : value.message || "Preparing text recognition…";
      if (Number.isFinite(value.fraction)) progress.value = value.fraction;
      else progress.removeAttribute("value");
    },
    error(message) { if (assetId) { finished(); status.textContent = message; } },
    show(result) {
      if (!assetId) return;
      finished();
      status.textContent = `${LABELS[result.status] || "Reading finished"}.${result.error ? ` ${result.error.message}` : ""}`;
      pages.replaceChildren();
      for (const page of result.pages) {
        const section = document.createElement("section");
        section.className = "ocr-page";
        const heading = document.createElement("h3");
        heading.textContent = `Page ${page.pageNumber}${page.text ? ` · ${Math.round(page.confidence)}% confidence` : ""}`;
        const text = document.createElement("pre");
        text.textContent = page.text || page.error?.message || "No text found on this page. Try a clearer, upright scan.";
        section.append(heading, text);
        if (page.status === "needs_review") {
          const note = document.createElement("p"); note.className = "ocr-review";
          note.textContent = "Low confidence. Compare this text with the original.";
          section.append(note);
        }
        pages.append(section);
      }
    },
  };
}
