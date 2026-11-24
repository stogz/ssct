// Tiny IndexedDB wrapper. Everything stays on this device.
const DB_NAME = 'ssct';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('foods')) {
        db.createObjectStore('foods', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
  }));
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const db = {
  allFoods: () => run('foods', 'readonly', (s) => s.getAll()),
  putFood: (food) => run('foods', 'readwrite', (s) => s.put(food)).then(() => food),
  deleteFood: (id) => run('foods', 'readwrite', (s) => s.delete(id)),

  entriesOn: (date) => run('entries', 'readonly', (s) => s.index('date').getAll(date)),
  allEntries: () => run('entries', 'readonly', (s) => s.getAll()),
  putEntry: (entry) => run('entries', 'readwrite', (s) => s.put(entry)).then(() => entry),
  deleteEntry: (id) => run('entries', 'readwrite', (s) => s.delete(id)),

  async exportAll() {
    return { app: 'ssct', version: 1, exportedAt: new Date().toISOString(), foods: await db.allFoods(), entries: await db.allEntries() };
  },
  async importAll(data) {
    if (!data || !Array.isArray(data.foods) || !Array.isArray(data.entries)) throw new Error('Not a valid backup file');
    await run('foods', 'readwrite', (s) => data.foods.forEach((f) => s.put(f)));
    await run('entries', 'readwrite', (s) => data.entries.forEach((e) => s.put(e)));
  },
};
