// Paste the config object from Firebase console → Project settings → Your apps → Web app.
// These values are public by design; your data is protected by the rules in firestore.rules.
// Leave the placeholders in place to run the app in local-only mode (no sync).
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

export const isConfigured = !String(firebaseConfig.apiKey).startsWith("PASTE_");
