const STORE_NAMES = ["assets", "operations", "settings", "ocrResults"];

/** Metadata, extracted text and OCR stay local to each account; originals remain in Drive. */
export class LibraryStore {
  constructor(indexedDB = globalThis.indexedDB, name = "filewise-library-v1") {
    this.indexedDB = indexedDB;
    this.name = name;
  }

  async open() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.name, 2);
        request.onupgradeneeded = () => {
          for (const name of STORE_NAMES) {
            if (request.result.objectStoreNames.contains(name)) continue;
            const store = request.result.createObjectStore(name, { keyPath: ["accountId", "id"] });
            store.createIndex("accountId", "accountId");
          }
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); this.dbPromise = null; };
          resolve(request.result);
        };
        request.onerror = () => { this.dbPromise = null; reject(request.error); };
        request.onblocked = () => reject(new Error("Close other Filewise tabs and try again."));
      });
    }
    return this.dbPromise;
  }

  async transaction(name, mode, operation) {
    if (!STORE_NAMES.includes(name)) throw new Error("Unknown metadata store.");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      const request = operation(transaction.objectStore(name));
      // Wait for commit, not only request success: failed commits are never successes.
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onabort = () => reject(transaction.error || new Error("Metadata was not saved."));
      transaction.onerror = () => reject(transaction.error || new Error("Metadata storage failed."));
    });
  }

  account(id) {
    if (typeof id !== "string" || !id) throw new Error("A connected account is required.");
    return id;
  }

  async put(name, accountId, id, value) {
    if (typeof id !== "string" || !id) throw new Error("A record ID is required.");
    const record = { ...value, accountId: this.account(accountId), id };
    await this.transaction(name, "readwrite", (store) => store.put(record));
    return record;
  }

  get(name, accountId, id) {
    return this.transaction(name, "readonly", (store) => store.get([this.account(accountId), id]));
  }

  list(name, accountId) {
    return this.transaction(name, "readonly", (store) =>
      store.index("accountId").getAll(this.account(accountId)));
  }

  delete(name, accountId, id) {
    return this.transaction(name, "readwrite", (store) => store.delete([this.account(accountId), id]));
  }
}
