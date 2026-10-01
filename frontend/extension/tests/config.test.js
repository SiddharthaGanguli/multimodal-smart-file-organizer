import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CONFIG, getPickerBridgeUrl, isConfigured } from "../config.js";
import { validateSelection } from "../src/picker.js";

const configuredManifest = { oauth2: { client_id: "test-client.apps.googleusercontent.com" } };
const unconfiguredManifest = { oauth2: { client_id: "" } };
const configuredConfig = {
  googleProjectNumber: "123456789", googlePickerApiKey: "test-public-picker-key",
  googlePickerBridgeUrl: "http://127.0.0.1:8765/picker.html",
  maxUploadBytes: 20 * 1024 * 1024, uploadFolderName: "Filewise test uploads",
};
const unconfiguredConfig = { ...configuredConfig, googleProjectNumber: "", googlePickerApiKey: "" };

test("unconfigured builds cannot start OAuth and configured public values enable setup", () => {
  assert.equal(isConfigured(configuredManifest, unconfiguredConfig), false);
  assert.equal(isConfigured(unconfiguredManifest, configuredConfig), false);
  assert.equal(isConfigured(configuredManifest, configuredConfig), true);
  assert.equal(isConfigured({}, configuredConfig), false);
});

test("placeholder and malformed configuration fixtures remain disabled", () => {
  assert.equal(isConfigured({ oauth2: { client_id: "REPLACE_WITH_CLIENT.apps.googleusercontent.com" } }, configuredConfig), false);
  assert.equal(isConfigured({ oauth2: { client_id: "invalid-client" } }, configuredConfig), false);
  assert.equal(isConfigured(configuredManifest, { ...configuredConfig, googleProjectNumber: "not-a-number" }), false);
  assert.equal(isConfigured(configuredManifest, { ...configuredConfig, googlePickerApiKey: "REPLACE_WITH_PICKER_API_KEY" }), false);
  assert.equal(isConfigured(configuredManifest, { ...configuredConfig, googlePickerBridgeUrl: "http://untrusted.test/picker.html" }), false);
});

test("Picker bridge allows HTTPS hosting and the exact local development origin", () => {
  for (const value of ["https://picker.example.test/picker.html", "http://127.0.0.1:8765/picker.html"]) {
    const bridge = getPickerBridgeUrl(value);
    assert.ok(bridge instanceof URL);
    assert.equal(bridge.href, value);
    assert.equal(isConfigured(configuredManifest, { ...configuredConfig, googlePickerBridgeUrl: value }), true);
  }
});

test("Picker bridge rejects unsafe schemes, credentials, URL payloads, and other HTTP hosts", () => {
  for (const value of [
    undefined, "", "/picker.html", "not-a-url", "javascript:alert(1)", "data:text/html,hello",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/picker.html",
    "http://picker.example.test/picker.html", "http://localhost:8765/picker.html",
    "http://127.0.0.1:9999/picker.html", "http://127.0.0.1/picker.html",
    "http://127.0.0.1.evil.test:8765/picker.html", "http://[::1]:8765/picker.html",
    "https://user:password@picker.example.test/picker.html", "https://user@picker.example.test/picker.html",
    "https://picker.example.test/picker.html?token=dummy", "https://picker.example.test/picker.html#dummy",
  ]) {
    assert.throws(() => getPickerBridgeUrl(value), `Reject ${String(value)}`);
    assert.equal(isConfigured(configuredManifest, { ...configuredConfig, googlePickerBridgeUrl: value }), false);
  }
});

test("extension requests per-file access without content scripts or broad Drive scopes", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.oauth2.scopes, ["https://www.googleapis.com/auth/drive.file"]);
  assert.deepEqual(manifest.permissions, ["identity", "storage"]);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.sandbox, undefined, "Picker must have its normal web origin, not an inherited opaque sandbox");
  assert.equal(manifest.content_security_policy.sandbox, undefined);
  assert.ok(!manifest.content_security_policy.extension_pages.includes("unsafe"));
  const frameSources = manifest.content_security_policy.extension_pages.match(/(?:^|;)\s*frame-src\s+([^;]+)/)?.[1].split(/\s+/) || [];
  assert.ok(frameSources.includes("http://127.0.0.1:8765"));
  assert.ok(frameSources.includes(getPickerBridgeUrl(CONFIG.googlePickerBridgeUrl).origin), "Configured helper origin must be allowed by the extension CSP");
  assert.ok(!frameSources.some(source => source.includes("*")), "Picker frame origins must be explicit");
});

test("Picker selection is bounded and rejects URLs or malformed IDs", () => {
  assert.deepEqual(validateSelection(["abc", "abc", "DEF_123-"], "files"), ["abc", "DEF_123-"]);
  for (const ids of [[], ["https://evil.test"], [null], new Array(101).fill("id")]) {
    assert.throws(() => validateSelection(ids, "files"));
  }
  assert.throws(() => validateSelection(["folder1", "folder2"], "folder"));
});
