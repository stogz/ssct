// This device's copy of everything, in IndexedDB. The app only ever reads and writes here;
// js/sync.js (when Firebase is set up) uploads local changes and downloads changes from other devices.
//
// Every record has `updatedAt` (ms) and `dirty` (1 = not uploaded yet). Deleting leaves a
// `deleted: true` marker, so the delete reaches other devices too. The newest edit wins.
const DB_NAME = 'ssct';
const DB_VERSION = 3;
// weights: one record per day, keyed by its date (YYYY-MM-DD), weight in kg.
export const STORES = ['foods', 'entries', 'weights'];
let dbPromise;

// Fired after every local change (not for changes downloaded from the account).
export const localChanges = new EventTarget();
const announce = () => localChanges.dispatchEvent(new Event('change'));

// Strictly increasing, so two quick edits never share a timestamp.
let lastStamp = 0;
const now = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const idb = req.result;
      const store = (name) => (idb.objectStoreNames.contains(name)
        ? req.transaction.objectStore(name)
        : idb.createObjectStore(name, { keyPath: 'id' }));
      const foods = store('foods');
      const entries = store('entries');
      const weights = store('weights'); // v3
      if (!entries.indexNames.contains('date')) entries.createIndex('date', 'date');
      // v2: records waiting to be uploaded have dirty = 1.
      for (const s of [foods, entries, weights]) if (!s.indexNames.contains('dirty')) s.createIndex('dirty', 'dirty');
    };
    req.onsuccess = () => {
      const idb = req.result;
      idb.onversionchange = () => idb.close(); // let a newer version of the app upgrade the database
      resolve(idb);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Runs fn(transaction) and resolves, once committed, with the value of the getter fn returns.
function run(names, mode, fn) {
  return open().then((idb) => new Promise((resolve, reject) => {
    const t = idb.transaction(names, mode);
    const getResult = fn(t);
    t.oncomplete = () => resolve(getResult ? getResult() : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function getAll(store, index, key) {
  return run(store, 'readonly', (t) => {
    const s = t.objectStore(store);
    const r = index ? s.index(index).getAll(key) : s.getAll();
    return () => r.result;
  });
}

const live = (records) => records.filter((r) => !r.deleted);

// A local change: stamped and marked for upload.
function save(store, record) {
  const r = { ...record, updatedAt: now(), dirty: 1 };
  return run(store, 'readwrite', (t) => { t.objectStore(store).put(r); }).then(() => { announce(); return r; });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const db = {
  allFoods: () => getAll('foods').then(live),
  putFood: (food) => save('foods', food),
  deleteFood: (id) => save('foods', { id, deleted: true }),

  entriesOn: (date) => getAll('entries', 'date', date).then(live),
  allEntries: () => getAll('entries').then(live),
  putEntry: (entry) => save('entries', entry),
  deleteEntry: (id) => save('entries', { id, deleted: true }),

  // Oldest first.
  allWeights: () => getAll('weights').then(live).then((ws) => ws.sort((a, b) => (a.date < b.date ? -1 : 1))),
  putWeight: ({ date, kg, bodyFat }) => save('weights', { id: date, date, kg, bodyFat: bodyFat || null }),
  deleteWeight: (date) => save('weights', { id: date, deleted: true }),

  async exportAll() {
    const clean = (records) => records.map(({ dirty, ...r }) => r);
    return {
      app: 'ssct',
      version: 3,
      exportedAt: new Date().toISOString(),
      foods: clean(await db.allFoods()),
      entries: clean(await db.allEntries()),
      weights: clean(await db.allWeights()),
    };
  },

  async importAll(data) {
    if (!data || !Array.isArray(data.foods) || !Array.isArray(data.entries)) throw new Error('Not a valid backup file');
    const stamp = (records) => (Array.isArray(records) ? records : [])
      .filter((r) => r && r.id).map((r) => ({ ...r, updatedAt: now(), dirty: 1 }));
    await run(STORES, 'readwrite', (t) => {
      stamp(data.foods).forEach((f) => t.objectStore('foods').put(f));
      stamp(data.entries).forEach((e) => t.objectStore('entries').put(e));
      stamp(data.weights).forEach((w) => t.objectStore('weights').put(w)); // older backups have none
    });
    announce();
  },

  // ----- used by sync -----

  dirty: (store) => getAll(store, 'dirty', 1),

  pendingCount() {
    return run(STORES, 'readonly', (t) => {
      const counts = STORES.map((s) => t.objectStore(s).index('dirty').count(1));
      return () => counts.reduce((n, r) => n + r.result, 0);
    });
  },

  // Uploaded: clear the flag, unless the record was edited again in the meantime.
  markClean(store, records) {
    return run(store, 'readwrite', (t) => {
      const s = t.objectStore(store);
      for (const r of records) {
        const get = s.get(r.id);
        get.onsuccess = () => {
          const cur = get.result;
          if (cur && cur.dirty && cur.updatedAt === r.updatedAt) s.put({ ...cur, dirty: 0 });
        };
      }
    });
  },

  // Records from the account: keep whichever version is newer. Resolves with how many changed here.
  applyRemote(store, records) {
    let changed = 0;
    return run(store, 'readwrite', (t) => {
      const s = t.objectStore(store);
      for (const remote of records) {
        const get = s.get(remote.id);
        get.onsuccess = () => {
          const local = get.result;
          if (local && !(remote.updatedAt > local.updatedAt)) return;
          s.put({ ...remote, dirty: 0 });
          changed++;
        };
      }
      return () => changed;
    });
  },

  // First sign-in on this device: everything already here gets uploaded into the account.
  markAllDirty() {
    return run(STORES, 'readwrite', (t) => {
      for (const name of STORES) {
        const cursorReq = t.objectStore(name).openCursor();
        cursorReq.onsuccess = () => {
          const c = cursorReq.result;
          if (!c) return;
          c.update({ ...c.value, updatedAt: c.value.updatedAt || c.value.createdAt || 1, dirty: 1 });
          c.continue();
        };
      }
    });
  },

  // Sign-out: remove this device's copy (it's safe in the account).
  clear() {
    return run(STORES, 'readwrite', (t) => { STORES.forEach((s) => t.objectStore(s).clear()); });
  },
};

// ---------- settings (nutrition goals, profile, weight goal) ----------
// Small, so it lives in localStorage. Like records, it has updatedAt/dirty for sync.
const SETTINGS_KEY = 'ssct-settings';
// The parts that sync to the account (as one document; the newest wins).
export const SYNCED_SETTINGS = ['goals', 'profile', 'weightGoal', 'extras'];

function writeSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
  return s;
}

export const settings = {
  get() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
  },
  // A local change: stamped and marked for upload.
  set(patch) {
    const next = writeSettings({ ...settings.get(), ...patch, updatedAt: now(), dirty: 1 });
    announce();
    return next;
  },
  // Settings from the account: keep whichever is newer. Returns true if they changed here.
  applyRemote(remote) {
    const local = settings.get();
    if (local.updatedAt && !(remote.updatedAt > local.updatedAt)) return false;
    const next = { ...local, updatedAt: remote.updatedAt, dirty: 0 };
    for (const key of SYNCED_SETTINGS) next[key] = remote[key] ?? undefined;
    writeSettings(next);
    return true;
  },
  markClean(updatedAt) {
    const s = settings.get();
    if (s.dirty && s.updatedAt === updatedAt) writeSettings({ ...s, dirty: 0 });
  },
  // First sign-in: settings made on this device count, but lose to newer ones already in the account.
  markDirtyIfSet() {
    const s = settings.get();
    if (SYNCED_SETTINGS.some((k) => s[k]) && !s.dirty) writeSettings({ ...s, updatedAt: s.updatedAt || 1, dirty: 1 });
  },
  clear() {
    try { localStorage.removeItem(SETTINGS_KEY); } catch { /* private mode */ }
  },
};
