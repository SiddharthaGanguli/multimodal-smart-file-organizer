import { getPickerBridgeUrl } from "../config.js";

export function validateSelection(ids, mode) {
  if (!Array.isArray(ids) || !ids.length || ids.length > (mode === "folder" ? 1 : 100) ||
      ids.some((id) => typeof id !== "string" || !/^[\w-]{1,200}$/.test(id))) {
    throw new Error("Google Picker returned an invalid file selection.");
  }
  return [...new Set(ids)];
}

export function createPicker({
  dialog, iframe, loadingStatus, windowObject = globalThis.window,
  channelFactory = () => new MessageChannel(), timers = globalThis,
}) {
  let cancelCurrent = null;
  iframe.hidden = true;
  if (loadingStatus) loadingStatus.hidden = true;
  return {
    close() { cancelCurrent?.(); },
    choose({ token, config, mode = "files" }) {
      cancelCurrent?.();
      return new Promise((resolve, reject) => {
        const bridge = getPickerBridgeUrl(config.googlePickerBridgeUrl);
        const localHelper = bridge.protocol === "http:";
        const loadError = localHelper
          ? "The local Google Picker helper could not be reached. From the project folder, run .\\frontend\\picker-bridge\\Start-PickerBridge.cmd, then try again."
          : "Google Drive selection could not load. Check your connection and try again.";
        const channel = channelFactory();
        let complete = false;
        let initialized = false;
        let timer;
        const finish = (value, error) => {
          if (complete) return;
          complete = true;
          timers.clearTimeout(timer);
          windowObject.removeEventListener("message", ready);
          channel.port1.close();
          channel.port2.close();
          iframe.onerror = null;
          iframe.hidden = true;
          if (loadingStatus) loadingStatus.hidden = true;
          iframe.removeAttribute("src");
          dialog.removeEventListener("cancel", cancel);
          dialog.close();
          cancelCurrent = null;
          if (error) reject(error); else resolve(value);
        };
        const cancel = () => finish([]);
        const ready = (event) => {
          if (complete || initialized || event.source !== iframe.contentWindow ||
              event.origin !== bridge.origin || event.data?.type !== "filewise-picker-ready") return;
          initialized = true;
          windowObject.removeEventListener("message", ready);
          timers.clearTimeout(timer);
          timer = timers.setTimeout(() => finish(null, new Error("Drive selection timed out. Please try again.")), 5 * 60 * 1000);
          try {
            iframe.hidden = false;
            if (loadingStatus) loadingStatus.hidden = true;
            iframe.contentWindow.postMessage({
              type: "filewise-picker-init", token, mode,
              apiKey: config.googlePickerApiKey, projectNumber: config.googleProjectNumber,
            }, bridge.origin, [channel.port2]);
          } catch { finish(null, new Error("Could not connect to the Google Picker helper. Please try again.")); }
        };
        timer = timers.setTimeout(() => finish(null, new Error(loadError)), localHelper ? 3000 : 20000);
        cancelCurrent = cancel;
        dialog.addEventListener("cancel", cancel);
        windowObject.addEventListener("message", ready);
        channel.port1.onmessage = ({ data }) => {
          if (data?.type === "cancel") finish([]);
          if (data?.type === "error") finish(null, new Error(String(data.message).slice(0, 300)));
          if (data?.type === "selected") {
            try { finish(validateSelection(data.ids, mode)); } catch (error) { finish(null, error); }
          }
        };
        iframe.onerror = () => finish(null, new Error(loadError));
        try {
          // This cross-origin web frame must NOT be sandboxed: Google needs its
          // own origin for its nested frame's scripts and same-origin requests.
          // Failed frame navigations may never emit error; show our loading state
          // until the trusted helper is ready, with a short local startup timeout.
          iframe.hidden = true;
          if (loadingStatus) loadingStatus.hidden = false;
          iframe.src = bridge.href;
          dialog.showModal();
        } catch { finish(null, new Error("Could not open Google Drive selection. Please try again.")); }
      });
    },
  };
}
