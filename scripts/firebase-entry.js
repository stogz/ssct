// The parts of the Firebase SDK the app uses, bundled into js/vendor/firebase.js by `npm run vendor`.
// Bundled into the repo (instead of loaded from Google's CDN) so the app still starts offline.
export { initializeApp } from 'firebase/app';
export {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  connectAuthEmulator,
} from 'firebase/auth';
export {
  initializeFirestore,
  memoryLocalCache,
  connectFirestoreEmulator,
  collection,
  doc,
  query,
  where,
  orderBy,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
