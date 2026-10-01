export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function accountChanged(message) {
  return Object.assign(new Error(message), { code: "accountChanged" });
}

export class ChromeAuth {
  constructor(chromeApi = globalThis.chrome, fetchImpl = (...args) => globalThis.fetch(...args)) {
    this.chrome = chromeApi;
    this.fetch = fetchImpl;
    this.verified = null;
  }

  async token(interactive = false) {
    const result = await this.chrome.identity.getAuthToken({ interactive, enableGranularPermissions: true });
    const token = typeof result === "string" ? result : result.token;
    if (!token || (result.grantedScopes && !result.grantedScopes.includes(DRIVE_SCOPE))) {
      throw new Error("Connect Google Drive and allow access to files you choose.");
    }
    return token;
  }

  invalidate(token) { return this.chrome.identity.removeCachedAuthToken({ token }); }

  async tokenFor(session) {
    await this.assert(session);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(false);
      let verified = this.verified;
      if (verified?.token !== token) {
        const response = await this.fetch(
          "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)",
          { headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
            redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30000) },
        );
        if (response.status === 401 && attempt === 0) {
          await this.invalidate(token);
          continue;
        }
        if (!response.ok) throw new Error("Google Drive access expired or is unavailable. Reconnect and try again.");
        verified = { token, id: (await response.json()).user?.permissionId };
        this.verified = verified;
      }
      await this.assert(session);
      if (verified.id !== session.id) {
        throw accountChanged("Google returned a different account. Reconnect before continuing.");
      }
      return token;
    }
    throw new Error("Reconnect Google Drive to continue.");
  }

  async activate(account) {
    return this.sessionLock(async () => {
      const session = { ...account, epoch: crypto.randomUUID() };
      await this.chrome.storage.session.set({ activeAccount: session });
      return session;
    });
  }

  async sessionLock(operation) {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request("filewise:auth-session", operation) : operation();
  }

  async current() {
    return (await this.chrome.storage.session.get("activeAccount")).activeAccount || null;
  }

  async assert(session) {
    const active = await this.current();
    if (!session || active?.id !== session.id || active.epoch !== session.epoch) {
      throw accountChanged("The connected account changed. Reconnect before continuing.");
    }
  }

  async disconnect(expectedSession) {
    // Invalidate the local session first, even if clearing Google's cache fails.
    return this.sessionLock(async () => {
      if (expectedSession && (await this.current())?.epoch !== expectedSession.epoch) return;
      await this.chrome.storage.session.remove("activeAccount");
      this.verified = null;
      await this.chrome.identity.clearAllCachedAuthTokens();
    });
  }
}
