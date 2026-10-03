/** Minimal promise wrapper over IndexedDB (no dependency). Shared with the service worker by name/version. */
const DB = 'mishrin';
const VERSION = 1;
export type StoreName = 'games' | 'files' | 'saves';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ['games', 'files', 'saves']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
}

function req<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(db => new Promise<T>((res, rej) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => res(r.result as T);
    tx.onerror = tx.onabort = () => rej(tx.error);
  }));
}

export const idb = {
  get: <T>(s: StoreName, k: string) => req<T | undefined>(s, 'readonly', o => o.get(k)),
  put: (s: StoreName, k: string, v: unknown) => req<void>(s, 'readwrite', o => o.put(v, k)),
  del: (s: StoreName, k: string) => req<void>(s, 'readwrite', o => o.delete(k)),
  all: <T>(s: StoreName) => req<T[]>(s, 'readonly', o => o.getAll()),
  keys: (s: StoreName) => req<string[]>(s, 'readonly', o => o.getAllKeys()),
  clear: (s: StoreName) => req<void>(s, 'readwrite', o => o.clear()),
};
