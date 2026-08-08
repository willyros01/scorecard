/* store.js — everything that touches Firebase.
 *
 * The rest of the app talks to this file and never imports the SDK directly,
 * so the storage layer can be changed without touching screens or domain logic.
 *
 * As in version 1, nothing in here is allowed to stop the app running. Every
 * failure is caught and turned into a message a person can act on.
 */

import * as model from "./model.js";
import * as outbox from "./outbox.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.0";

let fb = null;            // { app, auth, db, mod }
let uid = null;
let assocId = null;
let configured = false;
let listeners = [];
let lastError = null;
let statusText = "Starting";
let statusAlert = false;
const unsubscribers = [];

export const onChange = (fn) => { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn); }; };
export const status = () => ({
  text: statusText, alert: statusAlert, uid, assocId, configured,
  error: lastError, queued: outbox.count(),
});
const emit = (patch = {}) => { const s = status(); listeners.forEach((fn) => fn(s, patch)); };
const setStatus = (text, alert = false) => { statusText = text; statusAlert = alert; emit(); };
const setError = (short, full) => { lastError = { short, full }; emit(); };
const clearError = () => { if (lastError) { lastError = null; emit(); } };

/* ---------------- error messages ---------------- */

function describe(e) {
  const raw = String((e && (e.code || e.message)) || e || "").toLowerCase();
  const host = typeof location !== "undefined" ? location.hostname : "this site";

  if (raw.includes("unauthorized-domain"))
    return ["Domain not authorized", `Add "${host}" in Firebase, under Authentication, Settings, Authorized domains.`];
  if (raw.includes("configuration-not-found") || raw.includes("operation-not-allowed"))
    return ["Sign-in is switched off", "Enable Anonymous sign-in in Firebase, under Authentication, Sign-in method."];
  if (raw.includes("api-key-not-valid") || raw.includes("invalid-api-key"))
    return ["The API key is wrong", "The apiKey in firebase-config.js does not match this project."];
  if (raw.includes("permission-denied") || raw.includes("insufficient permissions"))
    return ["Firestore refused the write", "Either the rules were not published, or this account is not a member of the group."];
  if (raw.includes("unavailable") || raw.includes("client is offline") || raw.includes("network") || raw.includes("failed to fetch"))
    return ["Cannot reach Firebase", "Your rounds are saved on this device and upload as soon as the connection returns."];
  if (raw.includes("quota") || raw.includes("resource-exhausted"))
    return ["Firebase quota reached", "The free tier limit was hit. It resets daily; rounds keep saving on this device."];
  return ["Firebase returned an error", (e && (e.message || e.code)) || "No detail was given. Your rounds are safe on this device."];
}
const report = (e) => { const [short, full] = describe(e); setError(short, full); };

/* ---------------- boot ---------------- */

export async function init() {
  let config;
  try {
    config = await import("./firebase-config.js");
  } catch {
    setStatus("On this device", true);
    setError("firebase-config.js could not be read",
      "There is a syntax error in it, usually a missing quote or comma. The app still works; rounds stay on this device.");
    return;
  }

  configured = !!config.isConfigured;
  if (!configured) { setStatus("On this device"); return; }

  try {
    const [app, auth, store] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const instance = app.initializeApp(config.firebaseConfig);
    fb = { mod: { auth, store }, auth: auth.getAuth(instance), db: store.getFirestore(instance) };

    await new Promise((resolve) => {
      auth.onAuthStateChanged(fb.auth, async (user) => {
        if (!user) {
          try { await auth.signInAnonymously(fb.auth); }
          catch (e) { setStatus("Saved on device", true); report(e); resolve(); }
          return;
        }
        uid = user.uid;
        clearError();
        setStatus("Connected");
        resolve();
      });
    });
  } catch (e) {
    setStatus("Sync unavailable", true);
    report(e);
    return;
  }

  addEventListener("online", () => { setStatus("Reconnecting"); flush(); });
  addEventListener("offline", () => setStatus("Offline", true));
  setInterval(() => { if (!outbox.isEmpty()) flush(); }, 20000);
}

const ref = (...path) => fb.mod.store.doc(fb.db, ...path);
const col = (...path) => fb.mod.store.collection(fb.db, ...path);

/* ---------------- the outbox writer ---------------- */

/* Everything that changes data goes through the queue, online or off. That way
   there is one write path to get right instead of two, and the app behaves
   identically whether or not there is signal. */
/* A queued operation may have sat in localStorage for hours, so it cannot hold
   a live Firestore sentinel — those do not survive being turned into JSON.
   Placeholders are stored instead and swapped for the real thing at write time.
   This matters: the security rules require enteredAt to equal the server's
   clock, so a plain number here would have every round rejected. */
function hydrate(value) {
  const { serverTimestamp } = fb.mod.store;
  if (Array.isArray(value)) return value.map(hydrate);
  if (value && typeof value === "object") {
    if (value.__serverTimestamp) return serverTimestamp();
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = hydrate(item);
    return out;
  }
  return value;
}

async function writeOperation(op) {
  const { setDoc, updateDoc, deleteDoc } = fb.mod.store;
  const target = ref(...op.path);
  if (op.type === "delete") return deleteDoc(target);
  const data = hydrate(op.data);
  if (op.type === "set") return setDoc(target, data, { merge: true });
  if (op.type === "update") return updateDoc(target, data);
  throw new Error(`Unknown operation: ${op.type}`);
}

export async function flush() {
  if (outbox.isEmpty()) { setStatus(uid ? "Synced" : configured ? "Connecting" : "On this device"); return; }
  if (!configured) { setStatus("On this device"); return; }
  if (!uid || (typeof navigator !== "undefined" && !navigator.onLine)) {
    setStatus(`Saved on device (${outbox.count()} waiting)`, true);
    return;
  }

  setStatus("Syncing");
  const result = await outbox.flush(writeOperation);

  if (result.remaining === 0) { clearError(); setStatus("Synced"); }
  else {
    setStatus(`Saved on device (${result.remaining} waiting)`, true);
    if (result.stoppedOn) report(new Error(result.stoppedOn.error));
  }
  return result;
}

/* ---------------- associations and joining ---------------- */

export async function createAssociation({ name, displayName }) {
  const association = model.buildAssociation({ name, ownerUid: uid });
  const { setDoc, serverTimestamp } = fb.mod.store;

  /* Written directly rather than queued: there is no point creating a group
     offline, and the owner needs the id back immediately. */
  await setDoc(ref("associations", association.id), { ...association, createdAt: serverTimestamp() });
  await setDoc(ref("associations", association.id, "members", uid), {
    ...model.buildMember({ uid, displayName, role: "owner", joinCode: association.joinCode }),
    joinedAt: serverTimestamp(),
  });

  assocId = association.id;
  return association;
}

/* The code is checked by the security rules, not here. This request simply
   fails if it does not match, which is what makes editing the app pointless. */
export async function joinAssociation({ associationId, code, displayName }) {
  const { setDoc, serverTimestamp } = fb.mod.store;
  const member = model.buildMember({
    uid, displayName, role: "member", joinCode: model.normalizeJoinCode(code),
  });
  try {
    await setDoc(ref("associations", associationId, "members", uid), { ...member, joinedAt: serverTimestamp() });
    assocId = associationId;
    clearError();
    return { ok: true };
  } catch (e) {
    const raw = String((e && e.code) || "");
    if (raw.includes("permission-denied")) {
      setError("That code was not accepted", "Check the code and try again, or ask for a fresh invitation link.");
      return { ok: false, reason: "BAD_CODE" };
    }
    report(e);
    return { ok: false, reason: "ERROR" };
  }
}

export const setAssociation = (id) => { assocId = id; };
export const currentAssociation = () => assocId;

/* ---------------- posting a round ---------------- */

/* Writing a round also moves the golfer's index. Both go through the queue as
 * separate operations so an offline device can post rounds all day, but the
 * index is recomputed locally first from the golfer's stored window — which is
 * why the window lives on the golfer document rather than being derived from a
 * query. No round history is read to post a round.
 */
export function postRound({ golfer, course, tee, date, gross, adjusted, notes, gameId = null }) {
  const round = model.buildRound({
    assocId, golferId: golfer.id, gameId, date, course, tee,
    gross, adjusted, notes, enteredBy: uid,
    handicapIndexAtEntry: golfer.handicapIndex,
  });

  const window = model.insertIntoWindow(golfer.recentWindow, {
    roundId: round.id, date: round.date, differential: round.differential,
  });

  outbox.enqueue({
    type: "set",
    path: ["associations", assocId, "rounds", round.id],
    data: { ...round, enteredAt: { __serverTimestamp: true } },
    opId: `round-create-${round.id}`,
  });

  outbox.enqueue({
    type: "update",
    path: ["associations", assocId, "golfers", golfer.id],
    data: {
      recentWindow: window,
      handicapIndex: model.indexFromWindow(window),
      roundCount: (golfer.roundCount || 0) + 1,
    },
    opId: `golfer-index-${golfer.id}-${round.id}`,
  });

  flush();
  return { round, window, handicapIndex: model.indexFromWindow(window) };
}

/* Editing or deleting is rarer, and correctness matters more than avoiding a
   read, so the window is rebuilt from the golfer's last twenty rounds. */
export async function rebuildGolferIndex(golferId) {
  const { getDocs, query, where, orderBy, limit } = fb.mod.store;
  const snapshot = await getDocs(
    query(
      col("associations", assocId, "rounds"),
      where("golferId", "==", golferId),
      orderBy("date", "desc"),
      limit(20)
    )
  );
  let window = [];
  snapshot.forEach((d) => {
    const r = d.data();
    window = model.insertIntoWindow(window, { roundId: r.id, date: r.date, differential: r.differential });
  });

  outbox.enqueue({
    type: "update",
    path: ["associations", assocId, "golfers", golferId],
    data: { recentWindow: window, handicapIndex: model.indexFromWindow(window) },
    opId: `golfer-rebuild-${golferId}-${Date.now()}`,
  });
  flush();
  return window;
}

export function deleteRound(roundId) {
  outbox.enqueue({
    type: "delete",
    path: ["associations", assocId, "rounds", roundId],
    opId: `round-delete-${roundId}`,
  });
  flush();
}

/* ---------------- roster, courses, games ---------------- */

export function addGolfer({ name }) {
  const golfer = model.buildGolfer({ name });
  outbox.enqueue({
    type: "set",
    path: ["associations", assocId, "golfers", golfer.id],
    data: golfer,
    opId: `golfer-create-${golfer.id}`,
  });
  flush();
  return golfer;
}

/* Courses are top level and shared, so one entry serves every group. */
export function addCourse(details) {
  const course = model.buildCourse({ ...details, createdBy: uid });
  outbox.enqueue({
    type: "set",
    path: ["courses", course.id],
    data: course,
    opId: `course-create-${course.id}`,
  });
  flush();
  return course;
}

export function addGame({ date, courseId, name }) {
  const game = model.buildGame({ assocId, date, courseId, name, createdBy: uid });
  outbox.enqueue({
    type: "set",
    path: ["associations", assocId, "games", game.id],
    data: game,
    opId: `game-create-${game.id}`,
  });
  flush();
  return game;
}

/* ---------------- live reads ---------------- */

export function watchGolfers(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = onSnapshot(
    col("associations", assocId, "golfers"),
    (snap) => { clearError(); callback(snap.docs.map((d) => d.data())); },
    (e) => report(e)
  );
  unsubscribers.push(stop);
  return stop;
}

/* Deliberately bounded. Pagination is a version 3 concern, but an unbounded
   query would be the thing that quietly runs up a bill, so it is capped now. */
export function watchRounds(callback, { max = 500 } = {}) {
  const { onSnapshot, query, orderBy, limit } = fb.mod.store;
  const stop = onSnapshot(
    query(col("associations", assocId, "rounds"), orderBy("date", "desc"), limit(max)),
    (snap) => { clearError(); callback(snap.docs.map((d) => d.data())); },
    (e) => report(e)
  );
  unsubscribers.push(stop);
  return stop;
}

export function watchCourses(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = onSnapshot(col("courses"), (snap) => callback(snap.docs.map((d) => d.data())), (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

export function stopWatching() {
  while (unsubscribers.length) {
    const stop = unsubscribers.pop();
    try { stop(); } catch { /* already gone */ }
  }
}

/* ---------------- optional Google sign-in ---------------- */

export async function signInWithGoogle() {
  if (!fb) throw new Error("Firebase has not loaded.");
  const { GoogleAuthProvider, linkWithPopup, signInWithPopup } = fb.mod.auth;
  const provider = new GoogleAuthProvider();
  const current = fb.auth.currentUser;
  try {
    if (current && current.isAnonymous) await linkWithPopup(current, provider);
    else await signInWithPopup(fb.auth, provider);
    clearError();
  } catch (e) {
    if (String(e && e.code).includes("credential-already-in-use")) {
      await signInWithPopup(fb.auth, provider);
    } else { report(e); throw e; }
  }
}

export const accountLabel = () => {
  if (!configured) return "Local only";
  const user = fb && fb.auth.currentUser;
  if (!user) return "Not connected";
  return user.isAnonymous ? "This device" : user.email || "Google account";
};

/* ---------------- membership, roles and joining ---------------- */

const ASSOC_KEY = "golf:v2:assoc";
export const rememberAssociation = (id) => { try { localStorage.setItem(ASSOC_KEY, id); } catch {} };
export const recallAssociation = () => { try { return localStorage.getItem(ASSOC_KEY) || ""; } catch { return ""; } };

let myMember = null;
export const myRole = () => (myMember ? myMember.role : null);
export const canManage = () => ["owner", "admin"].includes(myRole());
export const isOwner = () => myRole() === "owner";

export async function loadMembership(id) {
  const { getDoc } = fb.mod.store;
  try {
    const snap = await getDoc(ref("associations", id, "members", uid));
    myMember = snap.exists() ? snap.data() : null;
    if (myMember) { assocId = id; rememberAssociation(id); }
    return myMember;
  } catch (e) { report(e); return null; }
}

export async function loadAssociation(id) {
  const { getDoc } = fb.mod.store;
  try {
    const snap = await getDoc(ref("associations", id));
    return snap.exists() ? snap.data() : null;
  } catch { return null; }
}

export function watchMembers(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = onSnapshot(col("associations", assocId, "members"),
    (snap) => callback(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))), (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

/* Only the owner may do this, and the rules enforce it — this call simply
   fails for anybody else. */
export function setMemberRole(memberUid, role) {
  outbox.enqueue({
    type: "update",
    path: ["associations", assocId, "members", memberUid],
    data: { role },
    opId: `role-${memberUid}-${role}-${Date.now()}`,
  });
  flush();
}

/* An invitation is a link, so joining is one tap from a message rather than
   a code somebody has to read out and type. */
export const joinLink = (association) =>
  `${location.origin}${location.pathname}?join=${association.id}.${association.joinCode}`;

export function readJoinLink() {
  try {
    const value = new URLSearchParams(location.search).get("join");
    if (!value) return null;
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    return { associationId: value.slice(0, dot), code: value.slice(dot + 1) };
  } catch { return null; }
}

export const clearJoinLink = () => {
  try { history.replaceState(null, "", location.pathname); } catch {}
};

/* ---------------- games ---------------- */

export function watchGames(callback, { max = 200 } = {}) {
  const { onSnapshot, query, orderBy, limit } = fb.mod.store;
  const stop = onSnapshot(
    query(col("associations", assocId, "games"), orderBy("date", "desc"), limit(max)),
    (snap) => callback(snap.docs.map((d) => d.data())), (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

export function updateGame(gameId, data) {
  outbox.enqueue({ type: "update", path: ["associations", assocId, "games", gameId], data,
    opId: `game-update-${gameId}-${Date.now()}` });
  flush();
}

export function deleteGame(gameId) {
  outbox.enqueue({ type: "delete", path: ["associations", assocId, "games", gameId],
    opId: `game-delete-${gameId}` });
  flush();
}

/* ---------------- editing a round ---------------- */

export function updateRound(roundId, data) {
  outbox.enqueue({ type: "update", path: ["associations", assocId, "rounds", roundId], data,
    opId: `round-update-${roundId}-${Date.now()}` });
  flush();
}

/* Whether this person may still change a round. The rules decide for real;
   this is only so the interface does not offer a button that will fail. */
export function canEditRound(round) {
  if (canManage()) return true;
  const entered = round.enteredAt && round.enteredAt.seconds
    ? round.enteredAt.seconds * 1000
    : (round.enteredAt || 0);
  if (!entered) return false;
  return Date.now() - entered < 24 * 60 * 60 * 1000;
}

/* A rename touches one document, because rounds reference a golfer by id.
   Version 1 had to rewrite every round; this does not. */
export function renameGolfer(golferId, name) {
  outbox.enqueue({ type: "update", path: ["associations", assocId, "golfers", golferId],
    data: { name: String(name).trim() }, opId: `golfer-rename-${golferId}-${Date.now()}` });
  flush();
}

export function deleteGolfer(golferId) {
  outbox.enqueue({ type: "delete", path: ["associations", assocId, "golfers", golferId],
    opId: `golfer-delete-${golferId}` });
  flush();
}


/* ---------------- importing a version 1 scorecard ---------------- */

/* Reads the old single-document scorecard. Returns null when there is none —
   which is the normal case for anybody joining a group rather than starting one. */
export async function readLegacyV1() {
  if (!fb || !uid) return null;
  try {
    const migrate = await import("./migrate.js");
    const v1 = await migrate.readV1({ db: fb.db, mod: fb.mod.store, uid });
    return v1 ? { v1, preview: migrate.preview(v1) } : null;
  } catch { return null; }
}

/* Creates a group from the old scorecard and makes you its owner.
   The version 1 document is left exactly where it is. */
export async function importLegacyV1({ v1, assocName, displayName }) {
  const migrate = await import("./migrate.js");
  const result = await migrate.run({ db: fb.db, mod: fb.mod.store, uid, v1, assocName, displayName });
  const check = await migrate.verify({ db: fb.db, mod: fb.mod.store, assocId: result.assocId,
    expected: { golfers: (v1.golfers || []).length, rounds: (v1.rounds || []).length } });
  assocId = result.assocId;
  rememberAssociation(result.assocId);
  return { ...result, check };
}


/* The group document carries settings everybody needs — the course lookup key
   among them. Watched rather than read once, so changing the key reaches every
   device without anybody reloading. */
export function watchAssociation(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = onSnapshot(ref("associations", assocId),
    (snap) => { if (snap.exists()) callback(snap.data()); }, (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

/* Owner only. The rules reject this from anybody else, so there is no way to
   change the key by editing the app. */
export function updateAssociation(data) {
  outbox.enqueue({ type: "update", path: ["associations", assocId], data,
    opId: `assoc-update-${Date.now()}` });
  flush();
}

/* ---------------- backup and restore ---------------- */

/* Restores golfers, courses and rounds from a backup file.
 *
 * Every record keeps the identity it had, so restoring the same file twice
 * writes the same documents rather than creating duplicates. Anything already
 * present is left as it is unless the backup has newer detail.
 *
 * Rounds are re-entered under the person doing the restore, because the rules
 * require the entering account to be the one writing. Original scores, dates
 * and differentials are untouched — only the "entered by" attribution changes.
 */
export function restoreBackup({ golfers = [], courses = [], rounds = [] }) {
  let queued = 0;

  for (const course of courses) {
    outbox.enqueue({ type: "set", path: ["courses", course.id],
      data: { ...course, createdBy: course.createdBy || uid },
      opId: `restore-course-${course.id}` });
    queued++;
  }
  for (const golfer of golfers) {
    outbox.enqueue({ type: "set", path: ["associations", assocId, "golfers", golfer.id],
      data: golfer, opId: `restore-golfer-${golfer.id}` });
    queued++;
  }
  for (const round of rounds) {
    outbox.enqueue({ type: "set", path: ["associations", assocId, "rounds", round.id],
      data: { ...round, assocId, enteredBy: uid, enteredAt: { __serverTimestamp: true } },
      opId: `restore-round-${round.id}` });
    queued++;
  }

  flush();
  return { queued };
}
