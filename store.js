// Persistenza locale su IndexedDB: quaderni e pagine (con i tratti vettoriali).

const DB_NAME = 'inchiostro';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notebooks')) {
        db.createObjectStore('notebooks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('byNotebook', 'notebookId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const store = {
  async listNotebooks() {
    const db = await openDB();
    const req = await tx(db, 'notebooks', 'readonly', s => s.getAll());
    return (req || []).sort((a, b) => b.updated - a.updated);
  },

  async putNotebook(nb) {
    const db = await openDB();
    return tx(db, 'notebooks', 'readwrite', s => s.put(nb));
  },

  async deleteNotebook(id) {
    const db = await openDB();
    const pages = await this.listPages(id);
    await tx(db, 'pages', 'readwrite', s => { for (const p of pages) s.delete(p.id); });
    return tx(db, 'notebooks', 'readwrite', s => s.delete(id));
  },

  async listPages(notebookId) {
    const db = await openDB();
    const req = await new Promise((resolve, reject) => {
      const t = db.transaction('pages', 'readonly');
      const r = t.objectStore('pages').index('byNotebook').getAll(notebookId);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return (req || []).sort((a, b) => a.index - b.index);
  },

  async getPage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('pages', 'readonly');
      const r = t.objectStore('pages').get(id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },

  async putPage(page) {
    const db = await openDB();
    return tx(db, 'pages', 'readwrite', s => s.put(page));
  },

  async deletePage(id) {
    const db = await openDB();
    return tx(db, 'pages', 'readwrite', s => s.delete(id));
  },
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
