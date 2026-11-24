// Firebase project settings for accounts and cloud backup. Leave as null to keep all data on the device only.
//
// To turn sync on, replace null with the config from the Firebase console
// (Project settings → General → Your apps → Web app → "SDK setup and configuration" → Config):
//
// export const firebaseConfig = {
//   apiKey: '...',
//   authDomain: 'your-project.firebaseapp.com',
//   projectId: 'your-project',
//   storageBucket: 'your-project.firebasestorage.app',
//   messagingSenderId: '...',
//   appId: '...',
// };
//
// These values aren't secret: they only identify the project, and every visitor's browser gets them.
// What keeps each person's data private is the security rules in firestore.rules.
export const firebaseConfig = null;
