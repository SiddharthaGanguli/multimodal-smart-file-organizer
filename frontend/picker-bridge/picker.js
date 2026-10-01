import { ALLOWED_EXTENSION_ORIGINS } from "./config.js";

// A normal web origin isolates this page from extension APIs without making
// Google's nested Picker frame opaque. Never add a sandbox attribute/ancestor.
let initialized = false;
window.addEventListener("message", (event) => {
  if (initialized || event.source !== parent ||
      !ALLOWED_EXTENSION_ORIGINS.includes(event.origin) ||
      event.data?.type !== "filewise-picker-init" || !event.ports[0]) return;
  initialized = true;
  const port = event.ports[0];
  const { token, apiKey, projectNumber, mode } = event.data;
  const send = (value) => port.postMessage(value);
  const fail = () => {
    document.getElementById("status").textContent = "Google Picker could not load. Check your connection and application configuration.";
    send({ type: "error", message: "Google Picker could not load. Check the Picker API key, project and network connection." });
  };
  if (typeof token !== "string" || !token || typeof apiKey !== "string" || !apiKey ||
      !/^\d+$/.test(projectNumber) || !["files", "folder"].includes(mode)) { fail(); return; }
  const script = document.createElement("script");
  script.src = "https://apis.google.com/js/api.js";
  script.onerror = fail;
  script.onload = () => {
    gapi.load("picker", { callback: () => {
      try {
        const folderMode = mode === "folder";
        const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
        view.setMode(google.picker.DocsViewMode.LIST);
        view.setIncludeFolders(true);
        if (folderMode) {
          view.setSelectFolderEnabled(true);
          view.setMimeTypes("application/vnd.google-apps.folder");
        } else {
          view.setSelectFolderEnabled(false);
          view.setMimeTypes("application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/jpeg,image/png");
        }
        const builder = new google.picker.PickerBuilder()
          .setDeveloperKey(apiKey).setAppId(projectNumber).setOAuthToken(token)
          .setOrigin(event.origin).addView(view)
          .setSize(Math.max(320, innerWidth - 24), Math.max(350, innerHeight - 24))
          .setCallback((data) => {
            if (data.action === google.picker.Action.PICKED) {
              send({ type: "selected", ids: (data.docs || []).map((doc) => doc.id) });
            } else if (data.action === google.picker.Action.CANCEL) send({ type: "cancel" });
          });
        if (!folderMode) builder.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
        document.getElementById("status").hidden = true;
        builder.build().setVisible(true);
      } catch { fail(); }
    }, onerror: fail, timeout: 15000, ontimeout: fail });
  };
  document.head.append(script);
});

if (parent === window) {
  document.getElementById("status").textContent = "Open this file picker from the Filewise extension.";
} else {
  for (const origin of ALLOWED_EXTENSION_ORIGINS) {
    parent.postMessage({ type: "filewise-picker-ready" }, origin);
  }
}
