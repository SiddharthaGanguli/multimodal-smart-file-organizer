import assert from "node:assert/strict";
import test from "node:test";

import { ChromeAuth, DRIVE_SCOPE } from "../src/auth.js";
import { DriveClient } from "../src/drive.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const SESSION_A = { id: "account-a", email: "a@example.test", epoch: "epoch-a" };
const SESSION_B = { id: "account-b", email: "b@example.test", epoch: "epoch-b" };
const response = (id, status = 200) => new Response(JSON.stringify({ user: { permissionId: id } }), { status });

function fixture() {
  const state = {
    session: clone(SESSION_A), tokens: ["token-a"], tokenCalls: [], invalidated: [],
    clearCalls: 0, requests: [], replies: [() => response(SESSION_A.id)],
  };
  const chromeApi = {
    identity: {
      async getAuthToken(options) {
        state.tokenCalls.push(options);
        const token = state.tokens.length > 1 ? state.tokens.shift() : state.tokens[0];
        return typeof token === "string" ? { token, grantedScopes: [DRIVE_SCOPE] } : token;
      },
      async removeCachedAuthToken({ token }) { state.invalidated.push(token); },
      async clearAllCachedAuthTokens() {
        state.clearCalls++;
        assert.equal(state.session, undefined, "the local session must be invalidated before token clearing");
        if (state.clearError) throw state.clearError;
      },
    },
    storage: {
      session: {
        async get() {
          if (state.onGetSession) await state.onGetSession();
          return { activeAccount: clone(state.session) };
        },
        async set({ activeAccount }) { state.session = clone(activeAccount); },
        async remove(key) { assert.equal(key, "activeAccount"); state.session = undefined; },
      },
    },
  };
  const fetchImpl = async (url, options) => {
    state.requests.push({ url, options });
    const reply = state.replies.length > 1 ? state.replies.shift() : state.replies[0];
    return reply(url, options);
  };
  return { state, auth: new ChromeAuth(chromeApi, fetchImpl) };
}

test("tokenFor verifies Google account identity and reuses verification for the same token", async () => {
  const { state, auth } = fixture();
  assert.equal(await auth.tokenFor(SESSION_A), "token-a");
  assert.equal(await auth.tokenFor(SESSION_A), "token-a");
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].url, "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)");
  assert.equal(state.requests[0].options.headers.Authorization, "Bearer token-a");
  assert.equal(state.requests[0].options.cache, "no-store");
  assert.equal(state.tokenCalls.every((options) => options.interactive === false), true);
});

test("tokenFor rejects a token for a different Google account", async () => {
  const { state, auth } = fixture();
  state.replies = [() => response(SESSION_B.id)];
  await assert.rejects(auth.tokenFor(SESSION_A), /different account/);
});

test("a newly returned token is verified again even when a previous token was trusted", async () => {
  const { state, auth } = fixture();
  assert.equal(await auth.tokenFor(SESSION_A), "token-a");
  state.tokens = ["token-b"];
  state.replies = [() => response(SESSION_B.id)];
  await assert.rejects(auth.tokenFor(SESSION_A), /different account/);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[1].options.headers.Authorization, "Bearer token-b");
});

test("401 invalidates the expired token and verifies one refreshed token", async () => {
  const { state, auth } = fixture();
  state.tokens = ["expired", "fresh"];
  state.replies = [() => response(null, 401), () => response(SESSION_A.id)];
  assert.equal(await auth.tokenFor(SESSION_A), "fresh");
  assert.deepEqual(state.invalidated, ["expired"]);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[1].options.headers.Authorization, "Bearer fresh");
});

test("refresh does not accept a token belonging to another account", async () => {
  const { state, auth } = fixture();
  state.tokens = ["expired", "other-account"];
  state.replies = [() => response(null, 401), () => response(SESSION_B.id)];
  await assert.rejects(auth.tokenFor(SESSION_A), /different account/);
  assert.deepEqual(state.invalidated, ["expired"]);
});

test("repeated 401 and unavailable verification fail without returning a token", async () => {
  for (const status of [401, 403, 503]) {
    const { state, auth } = fixture();
    state.replies = [() => response(null, status)];
    await assert.rejects(auth.tokenFor(SESSION_A), /expired or is unavailable/);
    assert.equal(state.requests.length, status === 401 ? 2 : 1);
  }
});

test("missing Drive scope or missing token is rejected before account verification", async () => {
  for (const token of [{ token: "token-a", grantedScopes: ["profile"] }, { token: "", grantedScopes: [DRIVE_SCOPE] }]) {
    const { state, auth } = fixture();
    state.tokens = [token];
    await assert.rejects(auth.tokenFor(SESSION_A), /allow access to files you choose/);
    assert.equal(state.requests.length, 0);
  }
});

test("stale account or session epoch is rejected before requesting credentials", async () => {
  for (const active of [SESSION_B, { ...SESSION_A, epoch: "new-epoch" }, null]) {
    const { state, auth } = fixture();
    state.session = clone(active);
    await assert.rejects(auth.tokenFor(SESSION_A), /account changed/);
    assert.equal(state.tokenCalls.length, 0);
  }
});

test("switching accounts while verification is pending prevents token disclosure", async () => {
  const { state, auth } = fixture();
  state.replies = [() => {
    state.session = clone(SESSION_B);
    return response(SESSION_A.id);
  }];
  await assert.rejects(auth.tokenFor(SESSION_A), /account changed/);
});

test("activate creates a new epoch so old sessions cannot act after reconnect", async () => {
  const { state, auth } = fixture();
  const first = await auth.activate({ id: SESSION_A.id, email: SESSION_A.email });
  const second = await auth.activate({ id: SESSION_A.id, email: SESSION_A.email });
  assert.notEqual(first.epoch, second.epoch);
  assert.deepEqual(await auth.current(), second);
  assert.deepEqual(state.session, second);
  await assert.rejects(auth.assert(first), /account changed/);
  await auth.assert(second);
});

test("disconnect clears the session and all cached tokens, including verification", async () => {
  const { state, auth } = fixture();
  await auth.tokenFor(SESSION_A);
  await auth.disconnect();
  assert.equal(await auth.current(), null);
  assert.equal(auth.verified, null);
  assert.equal(state.clearCalls, 1);
  await assert.rejects(auth.tokenFor(SESSION_A), /account changed/);
});

test("sign-out leaves the local session invalidated even when Chrome token clearing fails", async () => {
  const { state, auth } = fixture();
  await auth.tokenFor(SESSION_A);
  state.clearError = new Error("Chrome cache unavailable");
  await assert.rejects(auth.disconnect(), /Chrome cache unavailable/);
  assert.equal(await auth.current(), null);
  assert.equal(auth.verified, null);
  assert.equal(state.clearCalls, 1);
});

test("conditional disconnect cannot clear a newly active account or its verified token", async () => {
  const { state, auth } = fixture();
  state.session = clone(SESSION_B);
  state.tokens = ["token-b"];
  state.replies = [() => response(SESSION_B.id)];
  assert.equal(await auth.tokenFor(SESSION_B), "token-b");
  await auth.disconnect(SESSION_A);
  assert.deepEqual(await auth.current(), SESSION_B);
  assert.equal(state.clearCalls, 0);
  assert.equal(await auth.tokenFor(SESSION_B), "token-b");
  assert.equal(state.requests.length, 1);
});

test("conditional disconnect cannot clear a newer session for the same Google account", async () => {
  const { state, auth } = fixture();
  const reconnected = await auth.activate({ id: SESSION_A.id, email: SESSION_A.email });
  await auth.disconnect(SESSION_A);
  assert.deepEqual(await auth.current(), reconnected);
  assert.equal(state.clearCalls, 0);
});

test("conditional disconnect clears tokens when the expected session remains active", async () => {
  const { state, auth } = fixture();
  await auth.disconnect(SESSION_A);
  assert.equal(await auth.current(), null);
  assert.equal(state.clearCalls, 1);
});

test("Drive requests preserve stale-session errors instead of converting them into sign-out errors", async () => {
  const { state, auth } = fixture();
  state.session = clone(SESSION_B);
  let networkCalls = 0;
  const drive = new DriveClient({
    getToken: () => auth.tokenFor(SESSION_A),
    fetchImpl: async () => { networkCalls++; throw new Error("A stale session must not reach Drive"); },
    maxRetries: 0,
  });
  await assert.rejects(drive.getFile("selected-file"), (error) => {
    assert.equal(error.code, "accountChanged");
    assert.match(error.message, /account changed/);
    return true;
  });
  assert.equal(networkCalls, 0);
  assert.equal(state.tokenCalls.length, 0);
  assert.equal(state.clearCalls, 0);
  assert.deepEqual(await auth.current(), SESSION_B);
});

test("concurrent token verification cannot let another call's identity authorize the wrong token", async () => {
  const { state, auth } = fixture();
  state.tokens = ["token-b", "token-a"];
  let releaseWrongAccountCheck;
  let wrongCheckPaused;
  const paused = new Promise((resolve) => { wrongCheckPaused = resolve; });
  const release = new Promise((resolve) => { releaseWrongAccountCheck = resolve; });
  let held = false;
  state.onGetSession = async () => {
    if (!held && auth.verified?.token === "token-b") {
      held = true;
      wrongCheckPaused();
      await release;
    }
  };
  state.replies = [
    () => response(SESSION_B.id),
    () => response(SESSION_A.id),
  ];
  const wrongTokenResult = auth.tokenFor(SESSION_A).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await paused;
  assert.equal(await auth.tokenFor(SESSION_A), "token-a");
  releaseWrongAccountCheck();
  const result = await wrongTokenResult;
  assert.ok(result.error, `A token for account B was returned to account A: ${result.value}`);
  assert.match(result.error.message, /different account/);
});
