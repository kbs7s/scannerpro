// IndexedDB persistence layer.
// Stores: docs (document metadata), pages (page edit state), blobs (image data),
//         presets (custom enhancement presets), kv (settings, session, misc).
const DB_NAME = 'smart-scanner-pro';
const DB_VERSION = 1;
let dbp = null;

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('IndexedDB is not supported in this browser')); return; }
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('docs')) {
        const s = db.createObjectStore('docs', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Database upgrade blocked by another open tab'));
  });
  return dbp;
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(storeName, key) { return req((await store(storeName)).get(key)); }
export async function getAll(storeName) { return req((await store(storeName)).getAll()); }
export async function put(storeName, value) {
  try { return await req((await store(storeName, 'readwrite')).put(value)); }
  catch (e) { throw quotaAware(e); }
}
export async function del(storeName, key) { return req((await store(storeName, 'readwrite')).delete(key)); }
export async function clear(storeName) { return req((await store(storeName, 'readwrite')).clear()); }

export async function byIndex(storeName, index, value) {
  return req((await store(storeName)).index(index).getAll(value));
}

// Multi-store transaction helper: fn(tx) performs puts/deletes; resolves when committed.
export async function tx(storeNames, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(storeNames, 'readwrite');
    let out;
    t.oncomplete = () => res(out);
    t.onerror = () => rej(quotaAware(t.error));
    t.onabort = () => rej(quotaAware(t.error || new Error('Transaction aborted')));
    try { out = fn((n) => t.objectStore(n)); } catch (e) { try { t.abort(); } catch (_) { /* */ } rej(e); }
  });
}

function quotaAware(e) {
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
    const err = new Error('QUOTA'); err.quota = true; err.cause = e; return err;
  }
  return e;
}

// Blobs
export async function putBlob(id, blob) { if (!blob) return null; await put('blobs', { id, blob, size: blob.size, type: blob.type }); return id; }
export async function getBlob(id) { if (!id) return null; const r = await get('blobs', id); return r ? r.blob : null; }
export async function delBlob(id) { if (id) await del('blobs', id); }

// Key/value
export async function kvGet(key, def = null) { const r = await get('kv', key); return r ? r.value : def; }
export async function kvSet(key, value) { return put('kv', { key, value }); }

export async function selfTest() {
  const key = '__selftest__';
  const v = Date.now();
  await kvSet(key, v);
  const r = await kvGet(key);
  await del('kv', key);
  return r === v;
}

export async function deleteEverything() {
  for (const s of ['docs', 'pages', 'blobs', 'presets', 'kv']) await clear(s);
}
