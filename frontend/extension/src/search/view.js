export function createSearchView({ onEnable, onIndex, onQuery, onForget, onClose }) {
  const find = id => document.getElementById(id);
  const dialog = find("search-dialog");
  const unconfiguredMessage = find("search-unconfigured").textContent;
  let enabled = false;
  let busy = false;
  function controls() {
    for (const id of ["search-update", "search-submit", "search-forget"]) find(id).disabled = busy || !enabled;
    find("search-enable").disabled = busy;
    find("search-query").disabled = busy || !enabled;
  }
  find("search-close").addEventListener("click", () => { onClose(); dialog.close(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); onClose(); dialog.close(); });
  find("search-enable").addEventListener("click", onEnable);
  find("search-update").addEventListener("click", onIndex);
  find("search-forget").addEventListener("click", onForget);
  find("search-form").addEventListener("submit", event => {
    event.preventDefault();
    if (enabled && !busy) onQuery(find("search-query").value);
  });
  return {
    open({ configured, origin, consent, configurationError }) {
      enabled = consent;
      find("search-unconfigured").hidden = configured;
      find("search-unconfigured").textContent = configurationError || unconfiguredMessage;
      find("search-consent").hidden = !configured || enabled;
      find("search-workspace").hidden = !configured || !enabled;
      find("search-origin").textContent = origin || "";
      controls();
      if (!dialog.open) dialog.showModal();
    },
    busy(value, message = "") {
      busy = value; controls();
      find("search-status").textContent = message;
    },
    results(response) {
      const nodes = response.results.map(hit => {
        const article = document.createElement("article"); article.className = "search-hit";
        const title = document.createElement("h3"); title.textContent = hit.name;
        const reference = document.createElement("p"); reference.className = "search-reference";
        reference.textContent = `${hit.location} · ${hit.method === "ocr" ? "Recognized text" : "Extracted text"}${hit.needs_review ? " · Check against original" : ""}`;
        const snippet = document.createElement("p"); snippet.className = "search-snippet"; snippet.textContent = hit.snippet;
        const open = document.createElement("button"); open.className = "button button-small button-outline";
        open.textContent = "Open in Drive"; open.dataset.action = "open"; open.dataset.id = hit.assetId;
        article.append(title, reference, snippet, open); return article;
      });
      find("search-results").replaceChildren(...nodes);
      find("search-status").textContent = nodes.length ? `${nodes.length} matching file${nodes.length === 1 ? "" : "s"}.${response.partial ? " Some access checks timed out; try again for more results." : ""}`
        : "No matching indexed text. Try another phrase, or extract/OCR your files and update the search index.";
    },
    clearResults() { find("search-results").replaceChildren(); },
    clear() {
      enabled = false; busy = false; dialog.close(); controls();
      find("search-query").value = ""; find("search-results").replaceChildren(); find("search-status").textContent = "";
      find("search-origin").textContent = "";
    },
  };
}
