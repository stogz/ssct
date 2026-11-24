// Cloud backup and sync with Firebase (email/password accounts + Firestore).
//
// The app always works on this device's copy (js/db.js). While someone is signed in, this module
//  - uploads local changes (records marked dirty), and
//  - listens for changes made on their other devices and saves them here.
// When the same thing was changed in two places, the newer edit wins.
//
// Firestore layout: users/{uid}/foods/{id}, users/{uid}/entries/{id} and users/{uid}/settings/main.
// Every document also gets `syncedAt` (server time), so a device can ask for "everything changed since X".
import { firebaseConfig } from './firebase-config.js';
import { db, settings, localChanges, STORES } from './db.js';
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut as firebaseSignOut,
  connectAuthEmulator, initializeFirestore, memoryLocalCache, connectFirestoreEmulator,
  collection, doc, query, where, orderBy, onSnapshot, runTransaction, serverTimestamp, Timestamp,
} from './vendor/firebase.js';

// With `?emulator` on localhost the app talks to the Firebase emulators instead (see README).
const EMULATOR_CONFIG = { apiKey: 'demo-key', authDomain: 'demo-ssct.firebaseapp.com', projectId: 'demo-ssct', appId: 'demo' };

// Which account this device last synced, and the server time it has downloaded changes up to.
const SYNC_KEY = 'ssct-sync';
const readSyncState = () => {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { return {}; }
};
const writeSyncState = (s) => {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(s)); } catch { /* private mode */ }
};

const BATCH = 100; // documents per upload transaction (Firestore allows 500)

const MESSAGES = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/invalid-login-credentials': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'No account with that email. Tap "Create account" to make one.',
  'auth/email-already-in-use': 'There is already an account with that email. Tap "Sign in" instead.',
  'auth/weak-password': 'Use a password with at least 6 characters.',
  'auth/invalid-email': "That email address doesn't look right.",
  'auth/missing-password': 'Enter your password.',
  'auth/missing-email': 'Enter your email address.',
  'auth/network-request-failed': "Can't reach the server. Check your connection.",
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/operation-not-allowed': 'Email sign-in is turned off in this Firebase project (see the README).',
  'auth/configuration-not-found': "Email sign-in isn't set up in this Firebase project yet (see the README).",
  'permission-denied': "The account's data is locked. Check the Firestore security rules (see the README).",
  unavailable: "Can't reach the server right now.",
};

function friendly(err) {
  const e = new Error(MESSAGES[err?.code] || err?.message || String(err));
  e.code = err?.code;
  return e;
}

export function startSync({ emulator = false, onState, onRemoteChange }) {
  const app = initializeApp(emulator ? EMULATOR_CONFIG : firebaseConfig);
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  const fs = initializeFirestore(app, { localCache: memoryLocalCache(), ignoreUndefinedProperties: true });
  if (emulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(fs, '127.0.0.1', 8080);
  }

  let user = null;
  let authReady = false;
  let unsubscribers = [];
  let pushing = false;
  let pushAgain = false;
  let offline = false;
  let lastError = '';
  let pushTimer = null;
  let retryTimer = null;
  let retryDelay = 5000;

  async function report() {
    let pending = 0;
    try { pending = (await db.pendingCount()) + (settings.get().dirty ? 1 : 0); } catch { /* database busy */ }
    let status = 'synced';
    if (!user) status = 'signedOut';
    else if (lastError) status = 'error';
    else if (pending && (offline || !navigator.onLine)) status = 'offline';
    else if (pending || pushing) status = 'syncing';
    onState({ ready: authReady, user: user && { email: user.email }, status, pending, error: lastError });
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!user) return;
      if (lastError) {
        lastError = '';
        listen(user.uid); // listeners stop after an error
      }
      push();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5 * 60 * 1000);
  }

  // ----- download: changes from the account (other devices) -----
  function stopListening() {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    unsubscribers = [];
  }

  function onListenError(err) {
    console.error('Sync listener failed', err);
    lastError = friendly(err).message;
    report();
    scheduleRetry();
  }

  function listen(uidNow) {
    stopListening();
    const pulled = readSyncState().pulled || {};
    for (const name of STORES) {
      const since = Timestamp.fromMillis(pulled[name] || 0);
      const q = query(collection(fs, 'users', uidNow, name), where('syncedAt', '>', since), orderBy('syncedAt'));
      unsubscribers.push(onSnapshot(q, async (snap) => {
        const records = [];
        let newest = 0;
        for (const change of snap.docChanges()) {
          if (change.type === 'removed' || change.doc.metadata.hasPendingWrites) continue;
          const { syncedAt, ...data } = change.doc.data();
          newest = Math.max(newest, syncedAt?.toMillis?.() || 0);
          records.push({ ...data, id: change.doc.id });
        }
        if (!records.length) return;
        if (await db.applyRemote(name, records)) onRemoteChange();
        const s = readSyncState();
        if (user?.uid === uidNow && s.uid === uidNow) {
          writeSyncState({ ...s, pulled: { ...s.pulled, [name]: Math.max(newest, s.pulled?.[name] || 0) } });
        }
        report();
      }, onListenError));
    }
    unsubscribers.push(onSnapshot(doc(fs, 'users', uidNow, 'settings', 'main'), (snap) => {
      if (!snap.exists() || snap.metadata.hasPendingWrites) return;
      const { goals, updatedAt } = snap.data();
      if (settings.applyRemote({ goals, updatedAt })) onRemoteChange();
      report();
    }, onListenError));
  }

  // ----- upload: local changes -----
  const toRemote = ({ dirty, ...record }) => ({ ...record, syncedAt: serverTimestamp() });
  const fromRemote = (snap) => {
    const { syncedAt, ...data } = snap.data();
    return { ...data, id: snap.id };
  };

  async function pushStore(uidNow, name) {
    const dirty = await db.dirty(name);
    for (let i = 0; i < dirty.length; i += BATCH) {
      const chunk = dirty.slice(i, i + BATCH);
      let newer = [];
      // A transaction, so an older edit from this device never overwrites a newer one in the account.
      await runTransaction(fs, async (t) => {
        newer = [];
        const refs = chunk.map((r) => doc(fs, 'users', uidNow, name, r.id));
        const snaps = await Promise.all(refs.map((ref) => t.get(ref)));
        snaps.forEach((snap, k) => {
          if (snap.exists() && snap.data().updatedAt >= chunk[k].updatedAt) newer.push(fromRemote(snap));
          else t.set(refs[k], toRemote(chunk[k]));
        });
      });
      if (newer.length && await db.applyRemote(name, newer)) onRemoteChange();
      await db.markClean(name, chunk);
    }
  }

  async function pushSettings(uidNow) {
    const local = settings.get();
    if (!local.dirty) return;
    const ref = doc(fs, 'users', uidNow, 'settings', 'main');
    let newer = null;
    await runTransaction(fs, async (t) => {
      newer = null;
      const snap = await t.get(ref);
      if (snap.exists() && snap.data().updatedAt >= local.updatedAt) newer = snap.data();
      else t.set(ref, { goals: local.goals ?? null, updatedAt: local.updatedAt, syncedAt: serverTimestamp() });
    });
    if (newer && settings.applyRemote(newer)) onRemoteChange();
    settings.markClean(local.updatedAt);
  }

  async function push() {
    clearTimeout(pushTimer);
    if (!user) return;
    if (pushing) {
      pushAgain = true;
      return;
    }
    pushing = true;
    const uidNow = user.uid;
    report();
    try {
      do {
        pushAgain = false;
        for (const name of STORES) await pushStore(uidNow, name);
        await pushSettings(uidNow);
      } while (pushAgain && user?.uid === uidNow);
      offline = false;
      lastError = '';
      retryDelay = 5000;
    } catch (err) {
      if (err?.code === 'unavailable' || !navigator.onLine) {
        offline = true; // try again when the connection is back
      } else {
        console.error('Sync upload failed', err);
        lastError = friendly(err).message;
      }
      scheduleRetry();
    } finally {
      pushing = false;
      report();
    }
  }

  // ----- wiring -----
  localChanges.addEventListener('change', () => {
    report();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 1000);
  });
  window.addEventListener('online', () => { offline = false; push(); });
  window.addEventListener('offline', () => report());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') push();
  });

  onAuthStateChanged(auth, async (u) => {
    stopListening();
    user = u;
    authReady = true;
    lastError = '';
    if (u) {
      const state = readSyncState();
      if (state.uid !== u.uid) {
        if (state.uid) {
          // Left over from a different account: not this person's data.
          await db.clear();
          settings.clear();
          onRemoteChange();
        }
        // First sync for this account on this device: upload what's here, download everything.
        await db.markAllDirty();
        settings.markDirtyIfSet();
        writeSyncState({ uid: u.uid, pulled: {} });
      }
      listen(u.uid);
      push();
    }
    report();
  });

  const run = async (fn) => {
    try { return await fn(); } catch (err) { throw friendly(err); }
  };

  return {
    signIn: (email, password) => run(() => signInWithEmailAndPassword(auth, email, password)),
    signUp: (email, password) => run(() => createUserWithEmailAndPassword(auth, email, password)),
    resetPassword: (email) => run(() => sendPasswordResetEmail(auth, email)),
    // Removes this device's copy too: it's safe in the account, and the next person to sign in here
    // shouldn't see it. Unsynced changes are lost, so the app warns first.
    signOut: () => run(async () => {
      stopListening();
      await firebaseSignOut(auth);
      await db.clear();
      settings.clear();
      try { localStorage.removeItem(SYNC_KEY); } catch { /* private mode */ }
      onRemoteChange();
    }),
  };
}
