/ Firebase config for the scorecard project.
// These values are public by design; firestore.rules is what protects your data.
export const firebaseConfig = {
  apiKey: "AIzaSyA5qWtnz3QHco5YSAlHb7TXmCNg1kUdVhA",
  authDomain: "scorecard-f41b8.firebaseapp.com",
  projectId: "scorecard-f41b8",
  storageBucket: "scorecard-f41b8.firebasestorage.app",
  messagingSenderId: "811267714235",
  appId: "1:811267714235:web:b79fbd330f99e211044d9e",
};

export const isConfigured = !String(firebaseConfig.apiKey).startsWith("PASTE_");
