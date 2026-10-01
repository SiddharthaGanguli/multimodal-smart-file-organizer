// Google Drive v3 REST contracts:
// https://developers.google.com/workspace/drive/api/guides/manage-uploads
// https://developers.google.com/workspace/drive/api/guides/handle-errors
// https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const FILE_FIELDS = "id,name,mimeType,size,parents,createdTime,modifiedTime," +
  "webViewLink,sha256Checksum,trashed,capabilities(canAddChildren,canDownload),appProperties";

export class DriveError extends Error {
  constructor(message, { status = 0, code = "driveError", retryable = false } = {}) {
    super(message);
    this.name = "DriveError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function invalid(message, code = "invalidInput") {
  return new DriveError(message, { code });
}

function checkId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw invalid("A valid Google Drive file ID is required.");
  }
  return id;
}

function checkName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw invalid("Give the file or folder a name.");
  }
}

function endpoint(path, params = {}) {
  const url = new URL(`${API}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

function checkSession(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid("The upload session is invalid.", "invalidSession"); }
  if (url.protocol !== "https:" || url.hostname !== "www.googleapis.com" ||
      url.port || url.username || url.password || url.hash ||
      url.pathname !== "/upload/drive/v3/files" ||
      url.searchParams.get("uploadType") !== "resumable" || !url.searchParams.get("upload_id")) {
    throw invalid("The upload session is not a trusted Google Drive URL.", "invalidSession");
  }
  return url.href;
}

async function readJSON(response) {
  try { return await response.json(); } catch {
    throw new DriveError("Google Drive returned an unreadable response. Please retry.", {
      status: response.status, code: "invalidResponse", retryable: true,
    });
  }
}

async function responseError(response) {
  let payload;
  try { payload = await response.json(); } catch { /* Some upstream errors are not JSON. */ }
  const reason = payload?.error?.errors?.[0]?.reason;
  const status = response.status;
  const transient = status === 429 || status >= 500 ||
    (status === 403 && ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason));
  let message = "Google Drive could not complete this request. Please try again.";
  let code = reason || `http${status}`;
  if (status === 401) {
    message = "Your Google connection expired. Connect your account again.";
    code = "authRequired";
  } else if (status === 403 && reason === "storageQuotaExceeded") {
    message = "Your Google Drive storage is full. Free some space and retry.";
  } else if (status === 403 && ["dailyLimitExceeded", "activeItemCreationLimitExceeded"].includes(reason)) {
    message = "Google Drive's quota has been reached. Try later or use another account.";
  } else if (transient) {
    message = "Google Drive is temporarily busy. Please retry shortly.";
  } else if (status === 403) {
    message = "Google Drive denied access. Check the selected account and file permissions.";
  } else if (status === 404) {
    message = "This Drive file was deleted, moved out of reach, or is unavailable to this app.";
  } else if (status === 409) {
    message = "This Drive file ID already exists. Its details could not be confirmed.";
  } else if (status === 410) {
    message = "The upload session expired. Please retry the upload.";
  }
  const error = new DriveError(message, { status, code, retryable: transient });
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay)) error.retryAfterMs = Math.min(30000, Math.max(0, delay));
  }
  return error;
}

function tooLarge() {
  return invalid("Files must be 20 MB or smaller.", "fileTooLarge");
}

export class DriveClient {
  constructor({ getToken, invalidateToken = async () => {}, fetchImpl = (...args) => globalThis.fetch(...args),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxRetries = 2 } = {}) {
    if (typeof getToken !== "function" || typeof fetchImpl !== "function") {
      throw invalid("Google Drive requires a token provider and fetch implementation.");
    }
    this.getToken = getToken;
    this.invalidateToken = invalidateToken;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.maxRetries = Math.min(5, Math.max(0, Number.isFinite(maxRetries) ? Math.floor(maxRetries) : 2));
  }

  async _send(url, options = {}, accepted = []) {
    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      let token;
      try { token = await this.getToken(); } catch (error) {
        if (error.code === "accountChanged") throw error;
        throw new DriveError("Connect your Google account to continue.", { code: "authRequired" });
      }
      if (typeof token !== "string" || !token) {
        throw new DriveError("Connect your Google account to continue.", { code: "authRequired" });
      }
      let response;
      try {
        response = await this.fetchImpl(url, {
          ...options,
          headers: { ...options.headers, Authorization: `Bearer ${token}` },
          // Never forward an authenticated request to a redirect destination.
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(120000),
        });
      } catch {
        throw new DriveError("Unable to reach Google Drive. Check your connection and retry.", {
          code: "networkError", retryable: true,
        });
      }
      if (response.status === 401 && authAttempt === 0) {
        await response.body?.cancel();
        try { await this.invalidateToken(token); } catch {
          throw new DriveError("Your Google connection expired. Connect your account again.", {
            status: 401, code: "authRequired",
          });
        }
        continue;
      }
      if (response.ok || accepted.includes(response.status)) return response;
      throw await responseError(response);
    }
  }

  async _delay(attempt, error) {
    await this.sleep(error?.retryAfterMs ?? Math.min(8000, 500 * 2 ** attempt));
  }

  async _request(url, options = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this._send(url, options); } catch (error) {
        if (!error.retryable || attempt >= this.maxRetries) throw error;
        await this._delay(attempt, error);
      }
    }
  }

  async getAccount() {
    const about = await readJSON(await this._request(endpoint("about", { fields: "user,storageQuota" })));
    if (!about?.user?.permissionId) throw invalid("Google Drive did not return an account identity.", "invalidResponse");
    return { id: about.user.permissionId, email: about.user.emailAddress || "", name: about.user.displayName || "" };
  }

  async getFile(id) {
    return readJSON(await this._request(endpoint(`files/${checkId(id)}`, { fields: FILE_FIELDS })));
  }

  async generateId() {
    const result = await readJSON(await this._request(endpoint("files/generateIds", { count: "1", space: "drive", type: "files" })));
    if (!result?.ids?.[0]) throw invalid("Google Drive did not return a file ID.", "invalidResponse");
    return checkId(result.ids[0]);
  }

  async _existing(id) {
    try { return await this.getFile(id); } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  _folder(file, id) {
    if (file?.id !== id || file.mimeType !== FOLDER_MIME || file.trashed ||
        file.appProperties?.smartOrganizer !== "root") {
      throw invalid("The existing Drive item is not this app's destination folder.", "conflictingFile");
    }
    return file;
  }

  async createFolder({ id, name }) {
    checkId(id);
    checkName(name);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this._send(endpoint("files", { fields: FILE_FIELDS }), {
          method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ id, name, mimeType: FOLDER_MIME, appProperties: { smartOrganizer: "root" } }),
        });
        return this._folder(await readJSON(response), id);
      } catch (error) {
        if (!error.retryable && error.status !== 409) throw error;
        const existing = await this._existing(id);
        if (existing) return this._folder(existing, id);
        if (!error.retryable || attempt >= this.maxRetries) throw error;
        await this._delay(attempt, error);
      }
    }
  }

  async findFolders() {
    const files = [];
    let pageToken;
    const seenTokens = new Set();
    do {
      const params = {
        q: `mimeType = '${FOLDER_MIME}' and trashed = false and appProperties has { key='smartOrganizer' and value='root' }`,
        fields: `nextPageToken,files(${FILE_FIELDS})`, spaces: "drive", pageSize: "100",
      };
      if (pageToken) params.pageToken = pageToken;
      const result = await readJSON(await this._request(endpoint("files", params)));
      files.push(...(result.files || []));
      pageToken = result.nextPageToken;
      if (pageToken && seenTokens.has(pageToken)) throw invalid("Google Drive repeated a result page.", "invalidResponse");
      seenTokens.add(pageToken);
    } while (pageToken);
    return files;
  }

  async download(id) {
    const metadata = await this.getFile(id);
    if (Number(metadata.size) > MAX_FILE_BYTES) throw tooLarge();
    if (metadata.trashed || metadata.capabilities?.canDownload === false) {
      throw new DriveError("This Drive file is unavailable for download.", { status: 403, code: "downloadDenied" });
    }
    if (metadata.mimeType?.startsWith("application/vnd.google-apps.")) {
      throw invalid("Choose an original file; Google Workspace documents need an export first.", "unsupportedDownload");
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this._send(endpoint(`files/${checkId(id)}`, { alt: "media" }));
        if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) {
          await response.body?.cancel();
          throw tooLarge();
        }
        const reader = response.body?.getReader();
        if (!reader) throw invalid("Google Drive returned no file content.", "invalidResponse");
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_FILE_BYTES) {
              await reader.cancel();
              throw tooLarge();
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        if (metadata.size != null && size !== Number(metadata.size)) {
          throw new DriveError("The download was incomplete. Please retry.", { code: "incompleteDownload", retryable: true });
        }
        return new Blob(chunks, { type: response.headers.get("content-type") || metadata.mimeType || "application/octet-stream" });
      } catch (cause) {
        const error = cause instanceof DriveError ? cause : new DriveError("The download was interrupted. Please retry.", { code: "networkError", retryable: true });
        if (!error.retryable || attempt >= this.maxRetries) throw error;
        await this._delay(attempt, error);
      }
    }
  }

  _uploaded(metadata, { id, file, parentId, sha256, mimeType }) {
    if (metadata?.id !== id || metadata.trashed || Number(metadata.size) !== file.size ||
        (parentId && !metadata.parents?.includes(parentId)) ||
        (mimeType && metadata.mimeType !== mimeType) ||
        (sha256 && metadata.sha256Checksum && metadata.sha256Checksum.toLowerCase() !== sha256.toLowerCase())) {
      throw invalid("The Drive file does not match this upload. No duplicate was created.", "conflictingFile");
    }
    return metadata;
  }

  async upload({ id, name, mimeType, parentId, file, sha256, onProgress = () => {},
    onSession = async () => {}, sessionUrl }) {
    checkId(id);
    checkId(parentId);
    checkName(name);
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.slice !== "function") {
      throw invalid("Choose a non-empty file to upload.", "emptyFile");
    }
    if (file.size > MAX_FILE_BYTES) throw tooLarge();
    let session = sessionUrl ? checkSession(sessionUrl) : null;
    const type = mimeType || file.type || "application/octet-stream";
    const context = { id, file, parentId, sha256, mimeType: type };
    const complete = metadata => {
      const canonical = this._uploaded(metadata, context);
      onProgress(1);
      return canonical;
    };
    // This also covers a restart after bytes committed but before local state was saved.
    const existing = await this._existing(id);
    if (existing) return complete(existing);
    let offset = 0;
    let probe = Boolean(session);
    let retries = 0;
    let stalled = 0;
    onProgress(0);
    // Limit malformed or perpetually incomplete sessions independently of error retries.
    for (let exchanges = 0; exchanges < 100; exchanges += 1) {
      try {
        if (!session) {
          const url = new URL(UPLOAD_API);
          url.searchParams.set("uploadType", "resumable");
          url.searchParams.set("fields", FILE_FIELDS);
          const response = await this._send(url.href, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": type, "X-Upload-Content-Length": String(file.size) },
            body: JSON.stringify({ id, name, mimeType: type, parents: [parentId] }),
          });
          session = checkSession(response.headers.get("location"));
          await onSession(session);
          offset = 0;
          probe = false;
        }
        const response = await this._send(session, {
          method: "PUT",
          headers: { "Content-Type": type, "Content-Range": probe ? `bytes */${file.size}` : `bytes ${offset}-${file.size - 1}/${file.size}` },
          body: probe ? new Blob([]) : file.slice(offset),
        }, [308]);
        if (response.status !== 308) return complete(await readJSON(response));
        const range = response.headers.get("range");
        const match = range?.match(/^bytes=0-(\d+)$/);
        if (range && !match) throw invalid("Google Drive returned an invalid upload offset.", "invalidResponse");
        const next = match ? Number(match[1]) + 1 : 0;
        if (!Number.isSafeInteger(next) || next < 0 || next > file.size || next < offset) {
          throw invalid("Google Drive returned an invalid upload offset.", "invalidResponse");
        }
        stalled = next === offset ? stalled + 1 : 0;
        if (stalled > this.maxRetries + 1) {
          throw new DriveError("The upload made no progress. Please retry.", { code: "uploadStalled", retryable: true });
        }
        offset = next;
        onProgress(offset / file.size);
        probe = offset === file.size;
      } catch (error) {
        const expired = Boolean(session) && [404, 410].includes(error.status);
        if (!error.retryable && !expired && error.status !== 409) throw error;
        const found = await this._existing(id);
        if (found) return complete(found);
        if ((!error.retryable && !expired) || retries >= this.maxRetries) throw error;
        await this._delay(retries, error);
        retries += 1;
        if (expired) {
          session = null;
          offset = 0;
          await onSession(null);
        }
        probe = Boolean(session);
      }
    }
    throw new DriveError("The upload could not finish. Retry to check its saved progress.", { code: "uploadStalled", retryable: true });
  }
}
