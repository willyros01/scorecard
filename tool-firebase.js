/* tool-firebase.js — the ONE way every tool page (Tidy, Rebuild the roster,
 * Clean up, Repair) connects (2.30.0-beta.7, Willy: "make all the html screens
 * open in the app").
 *
 * - The app's own copy of Firebase (vendor/), never one loaded from the
 *   internet: the pages are packaged inside the iPhone app, where Apple does
 *   not allow downloaded code.
 * - The same sign-in store as the app (IndexedDB), so whoever is signed in to
 *   the app is signed in here; no anonymous sign-in, ever (Version 2.0).
 * - Automated tests only: on this machine's own address with ?emulators=1 the
 *   page talks to the Firebase emulators, exactly as the app does.
 * - "Back to the app" links keep ?emulators=1, so a test lands where it began.
 */
const FIREBASE_BUNDLE = "./vendor/firebase/firebase-10.12.0.js";

export const emulated = (() => {
  try {
    return ["localhost", "127.0.0.1"].includes(location.hostname)
      && new URLSearchParams(location.search).has("emulators");
  } catch { return false; }
})();

/* beta.8: the Firebase app this page opened, so it can be closed before the
   page is left. The iPhone keeps a page it navigates away from frozen in
   memory; one frozen with Firestore or the sign-in store open makes the app
   that comes back wait (see store.js shutDown). */
let opened = null;
async function leave() {
  const mod = opened; opened = null;
  if (mod) await mod.app.deleteApp(mod.instance);
}

/* A page brought back from the iPhone's page cache has closed its Firebase:
   start it afresh. */
addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });

/* Every "Back to the app" link (href="./") keeps the test flag, and closes this
   page's Firebase — waiting until it is closed — before going back. */
export function fixBackLinks() {
  for (const a of document.querySelectorAll('a[href="./"]')) {
    if (emulated) a.href = "./?emulators=1";
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const to = a.href;
      a.textContent = "Going back…";
      try { await leave(); } catch { /* go back regardless; the app's start-up timings (Send a report) would show a slow start */ }
      location.href = to;
    });
  }
}

/* Resolves { db, store, auth, authority, user } — user is null when nobody is
   signed in (or only an old guest session is): the page then says so. */
export async function connectTool() {
  const config = await import("./firebase-config.js");
  if (!config.isConfigured) throw new Error("No Firebase settings found.");
  const { app, auth, store } = await import(FIREBASE_BUNDLE);
  const instance = app.initializeApp(emulated
    ? { apiKey: "fake-api-key", projectId: "demo-scorecard", authDomain: "localhost", appId: "demo" }
    : config.firebaseConfig);
  /* getAuth can hang inside the app; this is what the app itself uses. */
  const authority = auth.initializeAuth(instance, { persistence: [auth.indexedDBLocalPersistence] });
  const db = store.getFirestore(instance);
  if (emulated) {
    auth.connectAuthEmulator(authority, "http://127.0.0.1:9099", { disableWarnings: true });
    store.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
  opened = { app, instance };
  const user = await new Promise((resolve) => {
    const stop = auth.onAuthStateChanged(authority, (u) => { stop(); resolve(u && !u.isAnonymous ? u : null); });
  });
  return { db, store, auth, authority, user };
}

export const NOT_SIGNED_IN = "Not signed in. Open The Scorecard, sign in with your email and password, then open this page again.";
