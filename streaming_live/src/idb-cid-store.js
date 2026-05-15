const DB_NAME = "lumen-live-v2-cids";
const STORE_NAME = "payloads";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "cid" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
  }).catch((error) => {
    console.warn("CID IndexedDB unavailable", error);
    return null;
  });
  return dbPromise;
}

export async function putCidPayload(cid, payload) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ cid, payload, updatedAt: Date.now() });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

export async function getCidPayload(cid) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(cid);
    request.onsuccess = () => resolve(request.result?.payload || null);
    request.onerror = () => resolve(null);
  });
}
