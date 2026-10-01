import test from "node:test";
import assert from "node:assert/strict";

let clicked;
let contexts = [];
let events = [];
globalThis.chrome = {
  action: { onClicked: { addListener(callback) { clicked = callback; } } },
  runtime: {
    getURL: (path) => `chrome-extension://example/${path}`,
    getContexts: async (filter) => {
      assert.deepEqual(filter, { contextTypes: ["TAB"], documentUrls: ["chrome-extension://example/app.html"] });
      return contexts;
    },
  },
  tabs: {
    create: async (options) => events.push(["create", options]),
    update: async (id, options) => events.push(["update", id, options]),
  },
  windows: { update: async (id, options) => events.push(["window", id, options]) },
};
await import("../src/background.js");

test("toolbar opens an extension tab without browser-history permissions", async () => {
  contexts = [];
  events = [];
  await clicked();
  assert.deepEqual(events, [["create", { url: "chrome-extension://example/app.html" }]]);
});

test("toolbar focuses an existing extension context instead of duplicating upload tabs", async () => {
  contexts = [{ tabId: 3, windowId: 4 }];
  events = [];
  await clicked();
  assert.deepEqual(events, [["update", 3, { active: true }], ["window", 4, { focused: true }]]);
});
