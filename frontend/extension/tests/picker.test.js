import test from "node:test";
import assert from "node:assert/strict";
import { createPicker } from "../src/picker.js";

const CONFIG = {
  googlePickerBridgeUrl: "https://picker.example.test/picker.html",
  googlePickerApiKey: "dummy-test-key", googleProjectNumber: "123456789",
};
const TOKEN = "dummy-test-token";

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, values = {}) {
    const event = { type, preventDefault() {}, ...values };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    this[`on${type}`]?.(event);
  }
  count(type) { return this.listeners.get(type)?.size || 0; }
  total() { return [...this.listeners.values()].reduce((sum, value) => sum + value.size, 0); }
}

function setup() {
  const windowObject = new Events();
  const dialog = new Events();
  dialog.open = false;
  dialog.closeCount = 0;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.closeCount++; };
  const iframe = new Events();
  iframe.src = "";
  const loadingStatus = { hidden: true };
  iframe.removeAttribute = name => { if (name === "src") iframe.src = ""; };
  const posted = [];
  iframe.contentWindow = { postMessage: (...args) => posted.push(args) };
  const channels = [];
  const makePort = () => ({ closed: false, onmessage: null, close() { this.closed = true; }, start() {} });
  const channelFactory = () => {
    const channel = { port1: makePort(), port2: makePort() };
    channels.push(channel);
    return channel;
  };
  let nextTimer = 0;
  const pendingTimers = new Map();
  const timers = {
    setTimeout(callback, delay) { const id = ++nextTimer; pendingTimers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { pendingTimers.delete(id); },
  };
  const picker = createPicker({ dialog, iframe, loadingStatus, windowObject, channelFactory, timers });
  const ready = (overrides = {}) => windowObject.emit("message", {
    source: iframe.contentWindow, origin: "https://picker.example.test",
    data: { type: "filewise-picker-ready" }, ...overrides,
  });
  const reply = data => channels.at(-1).port1.onmessage?.({ data });
  const expire = delay => {
    const entry = [...pendingTimers.entries()].find(([, value]) => value.delay === delay);
    assert.ok(entry, `Expected active ${delay}ms timer`);
    pendingTimers.delete(entry[0]);
    entry[1].callback();
  };
  const clean = () => {
    assert.equal(dialog.open, false);
    assert.equal(iframe.src, "");
    assert.equal(iframe.hidden, true);
    assert.equal(loadingStatus.hidden, true);
    assert.equal(windowObject.total(), 0);
    assert.equal(dialog.total(), 0);
    assert.equal(iframe.total(), 0);
    assert.equal(iframe.onload ?? null, null);
    assert.equal(iframe.onerror ?? null, null);
    assert.equal(pendingTimers.size, 0);
    for (const channel of channels) {
      assert.equal(channel.port1.closed, true);
      assert.equal(channel.port2.closed, true);
    }
  };
  return { picker, windowObject, dialog, iframe, loadingStatus, posted, channels, pendingTimers, ready, reply, expire, clean };
}

test("bridge receives no token until its exact window and origin announce readiness", async () => {
  const env = setup();
  const selected = env.picker.choose({ token: TOKEN, config: CONFIG });
  assert.equal(env.dialog.open, true);
  assert.equal(env.iframe.hidden, true);
  assert.equal(env.loadingStatus.hidden, false);
  assert.equal(env.iframe.src, CONFIG.googlePickerBridgeUrl);
  assert.equal(new URL(env.iframe.src).search, "");
  assert.equal(new URL(env.iframe.src).hash, "");
  assert.ok(!env.iframe.src.includes(TOKEN));
  assert.ok(!env.iframe.src.includes(CONFIG.googlePickerApiKey));
  assert.equal(env.posted.length, 0);
  env.iframe.emit("load");
  assert.equal(env.posted.length, 0, "Frame load alone must not transmit a token");
  env.ready({ origin: "https://evil.test" });
  env.ready({ origin: "null" });
  env.ready({ origin: "https://picker.example.test.evil.test" });
  env.ready({ source: {} });
  env.ready({ data: { type: "selected", ids: ["injected-id"] } });
  assert.equal(env.posted.length, 0);
  assert.equal(env.iframe.hidden, true, "Untrusted messages must not reveal a failed frame");
  env.ready();
  assert.equal(env.iframe.hidden, false);
  assert.equal(env.loadingStatus.hidden, true);
  assert.equal(env.posted.length, 1);
  const [payload, targetOrigin, ports] = env.posted[0];
  assert.equal(targetOrigin, "https://picker.example.test");
  assert.deepEqual(payload, {
    type: "filewise-picker-init", token: TOKEN, mode: "files",
    apiKey: CONFIG.googlePickerApiKey, projectNumber: CONFIG.googleProjectNumber,
  });
  assert.deepEqual(ports, [env.channels[0].port2]);
  assert.equal(env.windowObject.count("message"), 0);
  assert.deepEqual([...env.pendingTimers.values()].map(timer => timer.delay), [300000]);
  env.ready();
  assert.equal(env.posted.length, 1, "Repeated readiness cannot retransmit the token");
  env.reply({ type: "selected", ids: ["file-a", "file-a", "file_B-2"] });
  assert.deepEqual(await selected, ["file-a", "file_B-2"]);
  env.clean();
});

test("local development bridge receives initialization at its exact loopback origin", async () => {
  const env = setup();
  const config = { ...CONFIG, googlePickerBridgeUrl: "http://127.0.0.1:8765/picker.html" };
  const selected = env.picker.choose({ token: TOKEN, config, mode: "folder" });
  assert.deepEqual([...env.pendingTimers.values()].map(timer => timer.delay), [3000]);
  env.ready({ origin: "http://127.0.0.1:8765" });
  assert.equal(env.posted[0][1], "http://127.0.0.1:8765");
  assert.equal(env.posted[0][0].mode, "folder");
  env.reply({ type: "selected", ids: ["folder-1"] });
  assert.deepEqual(await selected, ["folder-1"]);
  env.clean();
});

test("unsafe bridge configuration fails before opening a frame or sending credentials", async () => {
  for (const googlePickerBridgeUrl of ["http://evil.test/picker.html", "https://picker.example.test/picker.html?token=oops"]) {
    const env = setup();
    await assert.rejects(async () => env.picker.choose({ token: TOKEN, config: { ...CONFIG, googlePickerBridgeUrl } }));
    assert.equal(env.posted.length, 0);
    env.clean();
  }
});

test("controller close cancels before the helper is ready and removes its listeners", async () => {
  const env = setup();
  const selected = env.picker.choose({ token: TOKEN, config: CONFIG });
  env.picker.close();
  assert.deepEqual(await selected, []);
  env.ready();
  assert.equal(env.posted.length, 0);
  env.clean();
});

test("dialog cancellation after readiness closes the private channel", async () => {
  const env = setup();
  const selected = env.picker.choose({ token: TOKEN, config: CONFIG });
  env.ready();
  env.dialog.emit("cancel");
  assert.deepEqual(await selected, []);
  env.clean();
});

test("private-port cancel completes without importing files", async () => {
  const env = setup();
  const selected = env.picker.choose({ token: TOKEN, config: CONFIG });
  env.ready();
  env.reply({ type: "cancel" });
  assert.deepEqual(await selected, []);
  env.clean();
});

test("helper errors reject promptly and clean up instead of leaving the UI busy", async () => {
  const env = setup();
  const selected = env.picker.choose({ token: TOKEN, config: CONFIG });
  const rejected = assert.rejects(selected, /Picker unavailable/);
  env.ready();
  env.reply({ type: "error", message: "Picker unavailable" });
  await rejected;
  env.clean();
});

test("invalid selected IDs and multiple folder selections reject without partial results", async () => {
  for (const [mode, ids] of [["files", ["https://evil.test"]], ["files", []], ["folder", ["one", "two"]]]) {
    const env = setup();
    const selected = env.picker.choose({ token: TOKEN, config: CONFIG, mode });
    const rejected = assert.rejects(selected, /invalid file selection/);
    env.ready();
    env.reply({ type: "selected", ids });
    await rejected;
    env.clean();
  }
});

test("unresponsive HTTPS helper retains its twenty-second startup timeout", async () => {
  const env = setup();
  const selected = env.picker.choose({ token: TOKEN, config: CONFIG });
  const rejected = assert.rejects(selected, /load|reach|ready|start|connect/i);
  env.expire(20000);
  await rejected;
  assert.equal(env.posted.length, 0);
  env.clean();
});

test("stopped local helper stays hidden and fails in three seconds with its Start command", async () => {
  const env = setup();
  const config = { ...CONFIG, googlePickerBridgeUrl: "http://127.0.0.1:8765/picker.html" };
  const selected = env.picker.choose({ token: TOKEN, config });
  const rejected = assert.rejects(selected, error => {
    assert.ok(error.message.includes(".\\frontend\\picker-bridge\\Start-PickerBridge.cmd"));
    return true;
  });
  // Browsers can emit load, without error, for an unreachable iframe document.
  env.iframe.emit("load");
  assert.equal(env.iframe.hidden, true);
  assert.equal(env.loadingStatus.hidden, false);
  assert.equal(env.posted.length, 0);
  env.expire(3000);
  await rejected;
  env.ready({ origin: "http://127.0.0.1:8765" });
  assert.equal(env.posted.length, 0, "Late readiness after failure must not receive credentials");
  env.clean();

  // A restart followed by another click creates a fresh, usable selection.
  const reopened = env.picker.choose({ token: TOKEN, config });
  assert.equal(env.iframe.hidden, true);
  assert.equal(env.loadingStatus.hidden, false);
  env.ready({ origin: "http://127.0.0.1:8765" });
  assert.equal(env.iframe.hidden, false);
  assert.equal(env.loadingStatus.hidden, true);
  env.reply({ type: "selected", ids: ["after-restart"] });
  assert.deepEqual(await reopened, ["after-restart"]);
  env.clean();
});

test("selection timeout starts after ready and cleans up the transferred ports", async () => {
  const env = setup();
  const selected = env.picker.choose({ token: TOKEN, config: CONFIG });
  const rejected = assert.rejects(selected, /timed out/i);
  env.ready();
  env.expire(300000);
  await rejected;
  env.clean();
});

test("opening another selection cancels the old one and ignores old-port results", async () => {
  const env = setup();
  const first = env.picker.choose({ token: TOKEN, config: CONFIG });
  env.ready();
  const oldHandler = env.channels[0].port1.onmessage;
  const second = env.picker.choose({ token: "dummy-second-token", config: CONFIG });
  assert.equal(env.iframe.hidden, true);
  assert.equal(env.loadingStatus.hidden, false);
  assert.deepEqual(await first, []);
  assert.equal(env.channels[0].port1.closed, true);
  assert.equal(env.channels[0].port2.closed, true);
  oldHandler?.({ data: { type: "selected", ids: ["stale-file"] } });
  env.ready();
  assert.equal(env.posted.at(-1)[0].token, "dummy-second-token");
  env.reply({ type: "selected", ids: ["current-file"] });
  assert.deepEqual(await second, ["current-file"]);
  env.clean();
});

test("frame load failure rejects and cleans up before the handshake", async () => {
  const env = setup();
  const selected = env.picker.choose({ token: TOKEN, config: CONFIG });
  const rejected = assert.rejects(selected, /load|reach|connect/i);
  env.iframe.emit("error");
  await rejected;
  assert.equal(env.posted.length, 0);
  env.clean();
});
