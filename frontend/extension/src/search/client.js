export function searchOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || url.port) throw new Error("Search requires a configured HTTPS service origin.");
  return url.origin;
}

export class SearchClient {
  constructor({ baseUrl, auth, session, fetchImpl = (...args) => fetch(...args) }) {
    this.origin = searchOrigin(baseUrl);
    Object.assign(this, { auth, session, fetchImpl });
  }

  async request(operation, body = {}, signal) {
    if (!["index", "query", "status", "forget"].includes(operation)) throw new Error("Unknown search operation.");
    await this.auth.assert(this.session);
    const token = await this.auth.tokenFor(this.session);
    await this.auth.assert(this.session);
    let response;
    try {
      response = await this.fetchImpl(`${this.origin}/v1/search/${operation}`, {
        method: "POST", body: JSON.stringify(body), credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Filewise-Request": "search-v1" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      });
    } catch (error) {
      await this.auth.assert(this.session);
      if (signal?.aborted) throw signal.reason;
      throw new Error(error.name === "TimeoutError" ? "Hosted search timed out. The service may be starting; try again."
        : "Hosted search is unavailable. Your Drive files and filename search still work.");
    }
    await this.auth.assert(this.session);
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) await this.auth.invalidate(token);
      const error = new Error(typeof result?.detail === "string" ? result.detail.slice(0, 300) : "Hosted search could not complete the request.");
      error.status = response.status;
      throw error;
    }
    if (!result || typeof result !== "object") throw new Error("Search returned an invalid response.");
    return result;
  }
}
