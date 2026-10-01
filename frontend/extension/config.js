// Public application configuration, never a client secret or an access token.
// Use the same Google Cloud project as manifest.json's Chrome OAuth client.
export const CONFIG = Object.freeze({
  googleProjectNumber: "305934899702",
  // Hosted helper: normal use does not require a local server.
  googlePickerBridgeUrl: "https://siddharthaganguli.github.io/multimodal-smart-file-organizer/",
  googlePickerApiKey: "AIzaSyAoIfDg3j8gfbHVjlXtB8AsUDHCBE2bZ0I",
  maxUploadBytes: 20 * 1024 * 1024,
  uploadFolderName: "Filewise uploads",
});

export function isConfigured(manifest, config = CONFIG) {
  try { getPickerBridgeUrl(config.googlePickerBridgeUrl); } catch { return false; }
  return Boolean(
    manifest?.oauth2?.client_id?.endsWith(".apps.googleusercontent.com") &&
    !manifest.oauth2.client_id.includes("REPLACE_") &&
    /^\d+$/.test(config.googleProjectNumber) &&
    config.googlePickerApiKey && !config.googlePickerApiKey.includes("REPLACE_")
  );
}

export function getPickerBridgeUrl(value) {
  const url = new URL(value);
  const localDevelopment = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "8765";
  if ((url.protocol !== "https:" && !localDevelopment) || url.username || url.password || url.search || url.hash) {
    throw new Error("Configure an HTTPS Google Picker helper, or the local development helper on 127.0.0.1:8765.");
  }
  return url;
}
