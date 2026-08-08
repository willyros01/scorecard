/* Storage engine — Cloud Firestore.
 *
 * Online : Firestore document  users/{uid}/data/scorecard
 * Offline: localStorage key    golf:pending      (deleted the moment it lands in Firestore)
 * Always : localStorage key    golf:cache        (read cache so the app opens with no signal)
 *
 * Nothing in here is allowed to stop the app running. Every failure is caught,
 * turned into a message a person can act on, and handed to the UI.
 */

const SDK = "https://www.gstatic.com/firebasejs/10.12.0";
const CACHE_KEY = "golf:cache";
const PENDING_KEY = "golf:pending";
const EMPTY = { golfers: [], courses: [], rounds: [], updatedAt: 0 };

let fb = null;
let uid = null;
let configured = false;
let listeners = [];
let statusText = "Starting";
let statusAlert = false;
let lastError = null;      // { short, full, fatal }
let unsubscribeDoc = null;

export const onChange = (fn) => listeners.push(fn);
export const status = () => ({ text: statusText, alert: statusAlert, uid, configured, error: lastError });
const emit = () => { const s = status(); listeners.forEach((fn) => fn(readCache(), s)); };

function setStatus(text, alert = false) { statusText = text; statusAlert = alert; emit(); }
function setError(short, full) { lastError = { short, full }; emit(); }
function clearError() { if (lastError) { lastError = null; emit(); } }

/* ---------- localStorage (also guarded: private mode can throw) ---------- */
const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
function writeJSON(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) {
    setError("This browser won't let the app save",
      "Local storage is full or blocked — private browsing on iOS does this. Your rounds are only held in memory until you close the tab.");
    return false;
  }
}
export const readCache = () => readJSON(CACHE_KEY) || readJSON(PENDING_KEY) || { ...EMPTY };
export const hasPending = () => !!readJSON(PENDING_KEY);

/* ---------- turn Firebase codes into something actionable ---------- */
function describe(e) {
  const raw = String((e && (e.code || e.message)) || e || "").toLowerCase();
  const host = location.hostname;

  if (raw.includes("unauthorized-domain"))
    return ["Domain not authorized", `Add "${host}" in Firebase → Authentication → Settings → Authorized domains, then reload.`];
  if (raw.includes("configuration-not-found") || raw.includes("admin-restricted-operation") || raw.includes("operation-not-allowed"))
    return ["Sign-in isn't switched on", "Enable Anonymous in Firebase → Authentication → Sign-in method. Until then this device stores rounds locally."];
  if (raw.includes("api-key-not-valid") || raw.includes("invalid-api-key"))
    return ["The API key is wrong", "The apiKey in firebase-config.js doesn't match this project. Recopy it from Project settings → Your apps."];
  if (raw.includes("permission-denied") || raw.includes("insufficient permissions"))
    return ["Firestore refused the write", "The rules were never published. Paste firestore.rules into Firebase → Firestore → Rules and press Publish."];
  if (raw.includes("not-found") || raw.includes("no document to update"))
    return ["Project or database not found", "Check projectId in firebase-config.js, and that the database ID is (default)."];
  if (raw.includes("unavailable") || raw.includes("client is offline") || raw.includes("network") || raw.includes("failed to fetch") || raw.includes("offline"))
    return ["Can't reach Firebase", "Your rounds are saved on this device and upload as soon as the connection returns."];
  if (raw.includes("quota") || raw.includes("resource-exhausted"))
    return ["Firebase quota reached", "The free tier limit was hit. It resets daily; rounds keep saving on this device meanwhile."];
  if (raw.includes("popup-blocked"))
    return ["The sign-in window was blocked", "Allow pop-ups for this site and try again."];
  if (raw.includes("popup-closed") || raw.includes("cancelled-popup"))
    return ["Sign-in was cancelled", "Nothing changed. Try again whenever you like."];
  return ["Firebase returned an error", (e && (e.message || e.code)) || "No detail was given. Your rounds are safe on this device."];
}
const report = (e) => { const [s, f] = describe(e); setError(s, f); };

/* ---------- boot ---------- */
export async function init() {
  emit();

  // The config file is imported dynamically so a typo in it can't stop the app.
  let cfg;
  try {
    cfg = await import("./firebase-config.js");
  } catch (e) {
    setStatus("On this device", true);
    setError("firebase-config.js couldn't be read",
      "There's a syntax error in it — nearly always a missing quote or comma. The app still works; rounds just stay on this device.");
    return;
  }

  configured = !!cfg.isConfigured;
  if (!configured) {
    setStatus("On this device");
    return;   // not an error: running local-only on purpose
  }

  try {
    const [app, auth, store] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const instance = app.initializeApp(cfg.firebaseConfig);
    fb = { mod: { auth, store }, auth: auth.getAuth(instance), db: store.getFirestore(instance) };

    /* Coming back from a redirect sign-in. This has to run before anything
       else touches auth, or the result is discarded. */
    try {
      const returned = await auth.getRedirectResult(fb.auth);
      if (returned && returned.user) clearError();
    } catch (e) {
      const code = String((e && e.code) || "");
      if (code.includes("credential-already-in-use")) {
        setError("That Google account already has a scorecard",
          "Signing in switched you to it. Your rounds on this device are still here — use Backup text on the storage panel if you need to move them across.");
      } else if (code) report(e);
    }

    auth.onAuthStateChanged(fb.auth, async (user) => {
      if (!user) {
        try { await auth.signInAnonymously(fb.auth); }
        catch (e) { setStatus("Saved on device", true); report(e); }
        return;
      }
      uid = user.uid;
      clearError();
      watch();
      await flush();
    });
  } catch (e) {
    setStatus(navigator.onLine ? "Sync unavailable" : "Offline", true);
    if (navigator.onLine) report(e);
  }

  addEventListener("online", () => { setStatus("Reconnecting"); flush(); });
  addEventListener("offline", () => setStatus("Offline", true));
  setInterval(() => { if (hasPending()) flush(); }, 20000);
}

function docRef() {
  const { doc } = fb.mod.store;
  return doc(fb.db, "users", uid, "data", "scorecard");
}

function watch() {
  if (unsubscribeDoc) unsubscribeDoc();
  const { onSnapshot } = fb.mod.store;
  unsubscribeDoc = onSnapshot(
    docRef(),
    (snap) => {
      clearError();
      if (hasPending()) return;
      const remote = snap.data();
      if (!remote) { setStatus("Synced"); return; }
      const local = readCache();
      if ((remote.updatedAt || 0) >= (local.updatedAt || 0)) {
        writeJSON(CACHE_KEY, remote);
        setStatus("Synced");
      }
    },
    (e) => { setStatus("Saved on device", true); report(e); }
  );
}

/* ---------- writes ---------- */
export async function save(state) {
  const next = { ...state, updatedAt: Date.now() };
  writeJSON(CACHE_KEY, next);
  writeJSON(PENDING_KEY, next);
  emit();
  await flush();
  return next;
}

export async function flush() {
  const pending = readJSON(PENDING_KEY);
  if (!pending) { setStatus(uid ? "Synced" : configured ? "Connecting" : "On this device"); return; }
  if (!configured) { setStatus("On this device"); return; }
  if (!uid || !navigator.onLine) { setStatus("Saved on device", true); return; }

  setStatus("Syncing");
  try {
    const { setDoc } = fb.mod.store;
    await setDoc(docRef(), pending);
    localStorage.removeItem(PENDING_KEY);   // the offline copy goes once Firebase has it
    writeJSON(CACHE_KEY, pending);
    clearError();
    setStatus("Synced");
  } catch (e) {
    setStatus("Saved on device", true);
    report(e);
  }
}

/* ---------- optional: carry your data across devices ---------- */

/* An app launched from the home screen has no browser chrome and blocks
   pop-ups outright, whatever Safari's own setting says. Sign-in there has to
   leave the page and come back rather than open a window. */
export const isInstalledApp = () => {
  try {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || navigator.standalone === true;
  } catch { return false; }
};
export async function signInWithGoogle() {
  if (!configured) throw new Error("Sync isn't set up — add your Firebase config first.");
  if (!fb) throw new Error("Firebase didn't load. Check your connection and reload.");
  const { GoogleAuthProvider, linkWithPopup, signInWithPopup, linkWithRedirect, signInWithRedirect } = fb.mod.auth;
  const provider = new GoogleAuthProvider();
  const current = fb.auth.currentUser;
  const anonymous = current && current.isAnonymous;

  /* Installed apps go straight to redirect — a pop-up there is always blocked,
     so trying one first would just show an error before working. */
  if (isInstalledApp()) {
    setStatus("Opening Google sign-in");
    if (anonymous) return linkWithRedirect(current, provider);
    return signInWithRedirect(fb.auth, provider);
  }

  try {
    if (anonymous) await linkWithPopup(current, provider);
    else await signInWithPopup(fb.auth, provider);
    clearError();
  } catch (e) {
    const code = String((e && e.code) || "");

    /* A blocked pop-up in an ordinary browser tab: fall back to redirect
       rather than making somebody hunt through Safari settings. */
    if (code.includes("popup-blocked") || code.includes("popup-closed") || code.includes("cancelled-popup")) {
      setStatus("Opening Google sign-in");
      if (anonymous) return linkWithRedirect(current, provider);
      return signInWithRedirect(fb.auth, provider);
    }
    if (code.includes("credential-already-in-use")) {
      try { await signInWithPopup(fb.auth, provider); clearError(); }
      catch (e2) { report(e2); throw e2; }
    } else { report(e); throw e; }
  }
  await flush();
}

/* Used to decide who sees administrative controls. */
export const currentEmail = () => {
  const user = fb && fb.auth.currentUser;
  return user && !user.isAnonymous ? (user.email || "") : "";
};

export async function signOutUser() {
  if (!fb) return;
  try { await fb.mod.auth.signOut(fb.auth); } catch (e) { report(e); return; }
  uid = null;
  if (unsubscribeDoc) unsubscribeDoc();
  setStatus("Signed out", true);
}

export const accountLabel = () => {
  if (!configured) return "Local only — no Firebase config";
  const u = fb && fb.auth.currentUser;
  if (!u) return "Not connected";
  return u.isAnonymous ? "This device only" : u.email || "Google account";
};
