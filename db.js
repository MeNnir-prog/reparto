// db.js — Almacenamiento local en IndexedDB (queda solo en este iPhone, dentro de Safari/la app).
const DB_NAME = 'reparto-reportes';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('dayId', 'dayId');
      }
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción abortada'));
  });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---- meta / ajustes ---- */
export async function getMeta(key, def = null) {
  const r = await tx(['meta'], 'readonly', t => wrap(t.objectStore('meta').get(key)));
  return r ? r.value : def;
}
export function setMeta(key, value) {
  return tx(['meta'], 'readwrite', t => wrap(t.objectStore('meta').put({ key, value })));
}

/* ---- jornadas ---- */
export function listDays() {
  return tx(['days'], 'readonly', t => wrap(t.objectStore('days').getAll()))
    .then(d => d.sort((a, b) => b.createdAt - a.createdAt));
}
export function getDay(id) { return tx(['days'], 'readonly', t => wrap(t.objectStore('days').get(id))); }
export function putDay(day) { return tx(['days'], 'readwrite', t => wrap(t.objectStore('days').put(day))); }

export async function deleteDay(dayId) {
  return tx(['days', 'items', 'photos'], 'readwrite', async t => {
    const items = await wrap(t.objectStore('items').index('dayId').getAll(dayId));
    for (const it of items) {
      if (it.photoId) t.objectStore('photos').delete(it.photoId);
      t.objectStore('items').delete(it.id);
    }
    t.objectStore('days').delete(dayId);
  });
}

export async function deleteEverything() {
  return tx(['days', 'items', 'photos'], 'readwrite', t => {
    t.objectStore('days').clear(); t.objectStore('items').clear(); t.objectStore('photos').clear();
  });
}

/* ---- registros (direcciones/paquetes) ---- */
export function itemsOfDay(dayId) {
  return tx(['items'], 'readonly', t => wrap(t.objectStore('items').index('dayId').getAll(dayId)))
    .then(list => list.sort((a, b) => a.order - b.order));
}
export function getItem(id) { return tx(['items'], 'readonly', t => wrap(t.objectStore('items').get(id))); }
export function putItem(item) {
  item.updatedAt = Date.now();
  return tx(['items'], 'readwrite', t => wrap(t.objectStore('items').put(item)));
}
export function putItems(items) {
  return tx(['items'], 'readwrite', t => { for (const it of items) { it.updatedAt = Date.now(); t.objectStore('items').put(it); } });
}
export async function deleteItem(id) {
  return tx(['items', 'photos'], 'readwrite', async t => {
    const it = await wrap(t.objectStore('items').get(id));
    if (it?.photoId) t.objectStore('photos').delete(it.photoId);
    t.objectStore('items').delete(id);
  });
}

/* ---- fotos (Blob JPEG) ---- */
export function putPhoto(id, blob) { return tx(['photos'], 'readwrite', t => wrap(t.objectStore('photos').put({ id, blob, createdAt: Date.now() }))); }
export function getPhoto(id) { return tx(['photos'], 'readonly', t => wrap(t.objectStore('photos').get(id))).then(r => r?.blob || null); }
export function deletePhoto(id) { return tx(['photos'], 'readwrite', t => wrap(t.objectStore('photos').delete(id))); }
