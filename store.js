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
  /* A batch is several documents that must land together. Queued as one item,
     so an offline device replays it as one all-or-nothing write rather than
     as pieces that could half succeed. */
  if (op.type === "batch") return commitTogether(op.writes, op.opId);

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
     offline, and the owner needs the id back immediately.

     The group has to exist before the membership, because the rule that
     authorises an owner membership reads ownerUid off the group document. */
  /* Deliberately NOT one batch, and this is the exception that proves the rule.
   *
   * Firestore evaluates every write in a batch against the database as it
   * stands BEFORE the batch. The membership rule reads the group document to
   * check who owns it — so batching the two together meant the rule looked for
   * a group that did not exist yet and refused the whole thing. Group creation
   * silently failed for exactly this reason.
   *
   * So the group is written first and allowed to settle, then the membership
   * and the code index go together. If the second step fails, the first is
   * rolled back rather than left as an orphan nobody can open. */
  const { deleteDoc } = fb.mod.store;

  await setDoc(ref("associations", association.id), {
    ...association,
    createdAt: serverTimestamp(),
  });

  try {
    await commitTogether([
      {
        op: "set",
        path: ["associations", association.id, "members", uid],
        data: {
          ...model.buildMember({ uid, displayName, role: "owner", joinCode: association.joinCode }),
          joinedAt: { __serverTimestamp: true },
        },
      },
      {
        op: "set",
        path: ["joinCodes", association.joinCode],
        data: { assocId: association.id },
      },
    ], "finish creating the group");
  } catch (e) {
    /* Undo the group rather than leave one nobody can join. */
    try { await deleteDoc(ref("associations", association.id)); } catch {}
    setError("The group could not be created",
      "Firebase refused part of the setup, usually because the rules in the console are older than this version. Nothing was left behind — publish the latest firestore.rules and try again.");
    throw e;
  }

  assocId = association.id;
  rememberAssociation(association.id);
  rememberGroup(association.id, association.name);
  await rememberGroupForAccount(association.id, association.name);
  return association;
}

/* Turns a code into the group it belongs to. Returns null when no such code
   exists, which is what a typo looks like. */
export async function findAssociationByCode(code) {
  if (!fb) return null;
  const { getDoc } = fb.mod.store;
  const tidy = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!tidy) return null;
  try {
    const snap = await getDoc(ref("joinCodes", tidy));
    return snap.exists() ? snap.data().assocId : null;
  } catch { return null; }
}

/* The code is checked by the security rules, not here. This request simply
   fails if it does not match, which is what makes editing the app pointless. */
/* Works out which role a code unlocks, so joining does not have to guess.
   The rules verify it again server-side; this only decides what to ask for. */
export async function roleForCode(associationId, code) {
  if (!fb) return "member";
  try {
    const { getDoc } = fb.mod.store;
    const snap = await getDoc(ref("associations", associationId));
    if (!snap.exists()) return "member";
    const data = snap.data() || {};
    return data.adminCode && code === data.adminCode ? "admin" : "member";
  } catch {
    /* Cannot read it — ask for the ordinary role, which always works. */
    return "member";
  }
}

export async function joinAssociation({ associationId, code, displayName }) {
  const { setDoc, serverTimestamp } = fb.mod.store;
  const member = model.buildMember({
    uid, displayName, role: "member", joinCode: model.normalizeJoinCode(code),
  });
  try {
    /* Membership and the pointer on your account go together. Written apart,
       a failure on the second left somebody a member of a group their other
       devices could never find. */
    const group = await loadAssociation(associationId);
    const name = group ? group.name : "Group";

    /* Safe to batch: the association already exists, so the membership rule
       can read it. Compare with createAssociation, where it does not yet. */
    await commitTogether([
      {
        op: "set",
        path: ["associations", associationId, "members", uid],
        data: { ...member, joinedAt: { __serverTimestamp: true } },
      },
      {
        op: "set",
        path: ["userGroups", uid, "groups", associationId],
        data: { assocId: associationId, name, at: Date.now() },
      },
    ], "join group");

    assocId = associationId;
    rememberAssociation(associationId);
    rememberGroup(associationId, name);
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
  /* Guarded rather than taken as read: a stored index can be stale or, before
     this release, negative — and it gets frozen onto the round permanently. */
  /* A starting figure counts here too — otherwise a tournament player with a
     known handicap and no rounds yet would post with no course handicap. */
  const indexNow = model.effectiveIndex(golfer).index;

  const round = model.buildRound({
    assocId, golferId: golfer.id, gameId, date, course, tee,
    gross, adjusted, notes, enteredBy: uid,
    handicapIndexAtEntry: indexNow,
  });

  const window = model.insertIntoWindow(golfer.recentWindow, {
    roundId: round.id, date: round.date, differential: round.differential, assocId,
  });

  /* One queued item holding both documents. The round and the golfer's index
     describe the same event, so they are written together or not at all —
     previously a failure between them left an index counting a round that was
     never saved. */
  outbox.enqueue({
    type: "batch",
    writes: [
      {
        op: "set",
        path: ["associations", assocId, "rounds", round.id],
        data: { ...round, enteredAt: { __serverTimestamp: true } },
      },
      {
        op: "update",
        path: ["golfers", golfer.id],
        data: {
          recentWindow: window,
          handicapIndex: model.displayIndex(window),
          roundCount: (golfer.roundCount || 0) + 1,
        },
      },
    ],
    opId: `round-create-${round.id}`,
  });

  flush();
  return { round, window, handicapIndex: model.indexFromWindow(window) };
}

/* Editing or deleting is rarer, and correctness matters more than avoiding a
   read, so the window is rebuilt from the golfer's last twenty rounds. */
/* Rebuilds after an edit or deletion.
 *
 * Only this group's rounds are readable from here, so entries belonging to the
 * player's other groups are kept as they are and merged back. Without that,
 * correcting a score in one group would quietly wipe half of somebody's
 * handicap history. */
export async function rebuildGolferIndex(golferId) {
  const { getDoc, getDocs, query, where, orderBy, limit } = fb.mod.store;

  let kept = [];
  try {
    const person = await getDoc(ref("golfers", golferId));
    if (person.exists()) kept = model.windowFromOtherGroups(person.data().recentWindow, assocId);
  } catch { /* nothing kept; the fresh scan below still runs */ }

  /* Entries from other groups are kept — a golfer's handicap spans all of them.
     But an entry whose group no longer exists can never be rescanned, so a
     deleted round's differential would sit there feeding the index forever.
     That is what produced the negative numbers. Drop anything unreachable. */
  if (kept.length) {
    const reachable = new Set(knownGroups().map((g) => g.id));
    reachable.add(assocId);
    kept = kept.filter((e) => e.assocId && reachable.has(e.assocId));
  }

  /* Deliberately no orderBy here. Combining a filter with a sort makes
     Firestore demand a composite index, which failed for the user with
     "The query requires an index". Sorting the handful of results in memory
     costs nothing and needs no index at all. */
  const snapshot = await getDocs(
    query(col("associations", assocId, "rounds"), where("golferId", "==", golferId))
  );
  const fresh = [];
  snapshot.forEach((d) => {
    const r = d.data();
    fresh.push({ roundId: r.id, date: r.date, differential: r.differential, assocId });
  });
  fresh.sort((a, b) => b.date.localeCompare(a.date));
  fresh.length = Math.min(fresh.length, 20);

  const window = model.mergeWindow(kept, fresh);
  outbox.enqueue({ type: "update", path: ["golfers", golferId],
    data: {
      recentWindow: window,
      handicapIndex: model.displayIndex(window),
      /* Recounted here too, so deleting a round finally brings the number down. */
      roundCount: fresh.length + kept.length,
    },
    opId: `golfer-rebuild-${golferId}-${Date.now()}` });
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

/* Deleting and rebuilding in one call, so a caller cannot do half of it and
   leave the golfer's index quietly wrong. */
export async function deleteRoundAndRebuild(round) {
  deleteRound(round.id);
  await flush();
  if (round.golferId) await rebuildGolferIndex(round.golferId);
}

/* ---------------- roster, courses, games ---------------- */

/* Adds a golfer to THIS group.
 *
 * If that person already exists — because they play in another of your groups —
 * the same record is reused rather than a second one created. That is the whole
 * point: one person, one handicap, however many groups.
 *
 * Returns { golfer, reused } so the interface can say which happened.
 */
export async function addGolfer({ name }) {
  const key = model.nameKey(name);
  if (!key) throw new Error("A golfer needs a name.");

  /* The name index is checked BEFORE anything is written.
   *
   * It always existed, but nothing consulted it at the moment of creation — so
   * repeated taps each created another person with the same name and a split
   * handicap. Four copies of one golfer came from exactly this. */

  const { getDoc, setDoc } = fb.mod.store;
  let golfer = null;
  let reused = false;

  /* The name index is what enforces uniqueness across every group. */
  try {
    const claimed = await getDoc(ref("golferNames", key));
    if (claimed.exists()) {
      const found = await getDoc(ref("golfers", claimed.data().golferId));
      if (found.exists()) { golfer = found.data(); reused = true; }
    }
  } catch { /* offline: fall through and create, the index will reconcile */ }

  /* The person, the claim on their name, and their place on this roster are
     three documents describing one act. Written together, so a failure can
     never leave a golfer with no name claim — which is what allowed duplicates
     — or a name claimed by a golfer who does not exist. */
  const writes = [];
  if (!golfer) {
    /* Nothing matched, so this really is somebody new. */
    golfer = model.buildGolfer({ name });
    writes.push({ op: "set", path: ["golfers", golfer.id], data: golfer });
    writes.push({ op: "set", path: ["golferNames", key], data: { golferId: golfer.id, name: golfer.name } });
  }
  writes.push({
    op: "set",
    path: ["associations", assocId, "roster", golfer.id],
    data: { golferId: golfer.id, addedAt: Date.now() },
  });

  await commitTogether(writes, "add golfer");
  return { golfer, reused };
}

/* Takes them off this group's roster. The person and their rounds elsewhere
   are untouched — they simply no longer play here. */
/* One document only, so no batch is needed. The golfer, their rounds and their
   handicap are deliberately untouched — taking somebody off a roster must never
   reach beyond that group. */
export function removeFromRoster(golferId) {
  outbox.enqueue({ type: "delete", path: ["associations", assocId, "roster", golferId],
    opId: `roster-remove-${assocId}-${golferId}-${Date.now()}` });
  flush();
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

export function addGame({ date, endDate = null, courseId, name }) {
  const game = model.buildGame({ assocId, date, endDate, courseId, name, createdBy: uid });
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

/* Every golfer in the whole system. Their index lives here, so it is the same
   number no matter which group you are looking at. */
export function watchGolfers(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = onSnapshot(col("golfers"),
    (snap) => { clearError(); callback(snap.docs.map((d) => d.data())); },
    (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

/* Which of them play in this group. */
export function watchRoster(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = onSnapshot(col("associations", assocId, "roster"),
    (snap) => callback(snap.docs.map((d) => d.id)),
    (e) => report(e));
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

/* Signing in with an email and a password.
 *
 * This is the fix for the problem that broke version 2: on iOS, Safari and an
 * app opened from the home screen have completely separate storage. An
 * anonymous account therefore differs between them, so the same person looked
 * like two people, each with their own group, each opening on a different
 * screen.
 *
 * Email and password is the only sign-in that works in both — it needs no
 * pop-up and no trip to another site, so nothing Apple does can block it.
 */
export async function signInWithEmail({ email, password }) {
  if (!fb) throw new Error("Firebase has not loaded yet.");
  const { EmailAuthProvider, linkWithCredential, signInWithEmailAndPassword, createUserWithEmailAndPassword } = fb.mod.auth;
  const address = String(email || "").trim();
  const secret = String(password || "");
  if (!address) throw new Error("auth/invalid-email");
  if (secret.length < 6) throw new Error("auth/weak-password");

  const current = fb.auth.currentUser;
  const hasPassword = !!(current && current.providerData
    && current.providerData.some((p) => p.providerId === "password"));

  try {
    if (current && current.isAnonymous) {
      /* Upgrade this device's anonymous account so anything already on it
         comes along rather than being stranded. */
      await linkWithCredential(current, EmailAuthProvider.credential(address, secret));
      uid = fb.auth.currentUser.uid;
      clearError();
      return { ok: true, outcome: "created" };
    }

    /* Already signed in with Google and no password yet.
     *
     * This matters more than it looks. Version 1 data belongs to the Google
     * account that created it. Signing in with a fresh email would make a
     * DIFFERENT account, and that data would be invisible — present in the
     * database, unreachable by the app. So the password is attached to the
     * account that already exists, keeping one identity and one set of data. */
    if (current && !hasPassword) {
      const owned = String(current.email || "").toLowerCase();
      if (owned && owned !== address.toLowerCase()) {
        throw new Error(`auth/wrong-email:${current.email}`);
      }
      await linkWithCredential(current, EmailAuthProvider.credential(current.email || address, secret));
      /* providerData is a snapshot. Without this reload the app still believes
         there is no password and shows the same panel again, which looks like
         the button did nothing. */
      try { await fb.auth.currentUser.reload(); } catch {}
      uid = fb.auth.currentUser.uid;
      clearError();
      emit();
      return { ok: true, outcome: "password-added", email: current.email };
    }
    await signInWithEmailAndPassword(fb.auth, address, secret);
    uid = fb.auth.currentUser.uid;
    clearError();
    return { ok: true, outcome: "signed-in" };
  } catch (e) {
    const code = String((e && (e.code || e.message)) || "");
    if (code.includes("email-already-in-use") || code.includes("credential-already-in-use")) {
      await signInWithEmailAndPassword(fb.auth, address, secret);
      uid = fb.auth.currentUser.uid;
      clearError();
      return { ok: true, outcome: "signed-in" };
    }
    if (code.includes("user-not-found")) {
      await createUserWithEmailAndPassword(fb.auth, address, secret);
      uid = fb.auth.currentUser.uid;
      clearError();
      return { ok: true, outcome: "created" };
    }
    report(e);
    throw e;
  }
}

export async function sendPasswordReset(email) {
  if (!fb) throw new Error("Firebase has not loaded yet.");
  await fb.mod.auth.sendPasswordResetEmail(fb.auth, String(email || "").trim());
}

/* Whether this account can already be signed into with a password. A Google
   account cannot, until one is added — which is the whole point of the panel
   that uses this. */
export const hasPassword = () => {
  const user = fb && fb.auth && fb.auth.currentUser;
  return !!(user && user.providerData
    && user.providerData.some((p) => p.providerId === "password"));
};

export const isSignedIn = () => {
  const user = fb && fb.auth && fb.auth.currentUser;
  return !!(user && !user.isAnonymous);
};

export async function signOutEverywhere() {
  /* Live listeners must go first. Left running, they keep firing against
     collections this account can no longer read, which produces permission
     errors on the way out and a half-empty screen on the way back in. */
  stopWatching();

  if (fb) { try { await fb.mod.auth.signOut(fb.auth); } catch {} }
  try {
    localStorage.removeItem(ASSOC_KEY);
    localStorage.removeItem(GROUPS_KEY);
  } catch {}
  assocId = null;
  myMember = null;
  uid = null;
  location.reload();
}

/* The signed-in email, or empty for an anonymous device. Used only to show
   whether Google sign-in has been used — it grants nothing on its own. */
export const currentEmail = () => {
  const user = fb && fb.auth && fb.auth.currentUser;
  return user && !user.isAnonymous ? (user.email || "") : "";
};

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

/* The group document as last read, so an invitation link can be built without
   a round trip. Filled by loadAssociation and kept current by
   watchAssociation. Declared up here with the rest of the module state — it
   was previously below its first use, which is the kind of ordering fault that
   silently breaks a whole feature. */
let cachedAssociation = null;
const currentAssociationDoc = () => cachedAssociation;
export const myRole = () => (myMember ? myMember.role : null);
export const canManage = () => ["owner", "admin"].includes(myRole());
export const isOwner = () => myRole() === "owner";

export async function loadMembership(id) {
  const { getDoc } = fb.mod.store;
  try {
    const snap = await getDoc(ref("associations", id, "members", uid));
    myMember = snap.exists() ? snap.data() : null;
    if (myMember) {
      assocId = id;
      rememberAssociation(id);
      /* Record it against the account every time, not only when the group was
         first created. A group made before this existed would otherwise stay
         invisible to a second device forever. */
      const group = await loadAssociation(id);
      rememberGroup(id, group ? group.name : "Group");
      rememberGroupForAccount(id, group ? group.name : "Group");
    }
    return myMember;
  } catch (e) { report(e); return null; }
}

export async function loadAssociation(id) {
  const { getDoc } = fb.mod.store;
  try {
    const snap = await getDoc(ref("associations", id));
    if (!snap.exists()) return null;
    const group = { ...snap.data(), id: snap.id };
    /* Filled here as well as in the watcher, so an invitation can be built
       before any snapshot has arrived. */
    if (id === assocId) cachedAssociation = group;
    return group;
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

/* An invitation for a specific role.
 *
 * The link carries whichever secret matches the role, so the rules can VERIFY
 * the role rather than trust a label. An admin link holds a different code
 * entirely, which is why a guest cannot edit their own link into an admin one. */
export function inviteLink(role = "member", golferId = null) {
  const group = currentAssociationDoc();
  if (!group) return "";
  const code = role === "admin" ? group.adminCode : group.joinCode;
  if (!code) return "";
  /* A named invitation carries the golfer, so the person joining never types
     their name and cannot misspell it into a second record with a split
     handicap. It also links them to their EXISTING roster entry, rounds and
     index included. */
  const named = golferId ? `.${golferId}` : "";
  return `${location.origin}${location.pathname}?join=${group.id}.${code}${named}`;
}

/* Groups created before admin invitations existed have no admin code. One is
   generated and saved the first time an admin invitation is sent, so older
   groups gain the feature without anybody having to do anything. */
export async function ensureAdminCode() {
  const group = currentAssociationDoc();
  if (!group) return "";
  if (group.adminCode) return group.adminCode;

  const code = model.newJoinCode();
  await commitTogether([
    { op: "set", path: ["associations", group.id], data: { adminCode: code } },
  ], "add admin code");
  cachedAssociation = { ...group, adminCode: code };
  return code;
}

export function readJoinLink() {
  try {
    const value = new URLSearchParams(location.search).get("join");
    if (!value) return null;

    /* group.code            — an open invitation, they type their name
       group.code.golferId   — a named one, for a specific person on the roster */
    const parts = value.split(".");
    if (parts.length < 2) return null;
    return {
      associationId: parts[0],
      code: parts[1],
      golferId: parts.length > 2 ? parts.slice(2).join(".") : null,
    };
  } catch { return null; }
}

/* The golfer a named invitation points at, read straight from the database so
   the screen shows their real name rather than one carried in the link — a URL
   can be edited, a document cannot. */
export async function golferNamedInLink(golferId) {
  if (!fb || !golferId) return null;
  try {
    const { getDoc } = fb.mod.store;
    const snap = await getDoc(ref("golfers", golferId));
    return snap.exists() ? { ...snap.data(), id: snap.id } : null;
  } catch { return null; }
}

/* Accepting a named invitation.
 *
 * The link is single use for admins and locked to the first account for
 * guests. Both are enforced by a claim written alongside the membership: it
 * records which account accepted, so a forwarded link cannot be used by
 * somebody else. */
const serverTimestampValue = () => fb.mod.store.serverTimestamp();

export async function acceptNamedInvite({ associationId, code, golferId, role }) {
  const { getDoc } = fb.mod.store;

  const claimRef = ref("associations", associationId, "invites", golferId);
  let claim = null;
  try {
    const snap = await getDoc(claimRef);
    if (snap.exists()) claim = snap.data();
  } catch { /* unreadable; the rules decide below */ }

  if (claim && claim.acceptedBy && claim.acceptedBy !== uid) {
    return {
      ok: false,
      reason: role === "admin" ? "USED" : "TAKEN",
    };
  }

  const member = model.buildMember({
    uid,
    displayName: (await golferNamedInLink(golferId) || {}).name || "",
    role: role === "admin" ? "admin" : "member",
    joinCode: code,
  });

  const group = await loadAssociation(associationId);
  const name = group ? group.name : "Group";

  /* TWO STEPS, and the order matters — the same rule that broke group
     creation. The roster rule asks "is this account a member?", and inside a
     single batch the answer is still no, because the membership is in that
     same batch and Firestore evaluates every write against the state BEFORE
     it. So the membership is written first and allowed to land, and only then
     does everything that depends on it go together. */
  const { setDoc } = fb.mod.store;

  await setDoc(ref("associations", associationId, "members", uid), {
    ...member,
    golferId,
    joinedAt: serverTimestampValue(),
  });

  try {
    await commitTogether([
    {
      op: "set",
      path: ["associations", associationId, "invites", golferId],
      data: { acceptedBy: uid, role, at: Date.now() },
    },
    {
      op: "set",
      path: ["userGroups", uid, "groups", associationId],
      data: { assocId: associationId, name, at: Date.now() },
    },
    /* Tie the account to the golfer they were invited as. */
    { op: "update", path: ["golfers", golferId], data: { linkedUid: uid } },
    {
      op: "set",
      path: ["associations", associationId, "roster", golferId],
      data: { golferId, addedAt: Date.now() },
    },
    ], "accept invitation");
  } catch (e) {
    setError("Joining did not finish",
      "Your membership was created, but the rest could not be written — usually because the rules in the console are older than this version. Tap the link again once they are published.");
    throw e;
  }

  assocId = associationId;
  rememberAssociation(associationId);
  rememberGroup(associationId, name);
  clearError();
  return { ok: true, role };
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

/* Editing a round changes the golfer's index too, so both move together.
   Use this rather than updateRound followed by a rebuild — that pairing could
   leave a corrected score with an index still reflecting the old one. */
export async function updateRoundAndRebuild(roundId, data, golferId) {
  updateRound(roundId, data);
  await flush();
  if (golferId) await rebuildGolferIndex(golferId);
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

/* Renaming changes the person everywhere, in every group. Rounds are unaffected
   because they reference the golfer by id, not by name.
   Returns false if the new name already belongs to somebody else. */
export async function renameGolfer(golferId, name) {
  const { getDoc, setDoc, deleteDoc } = fb.mod.store;
  const tidy = String(name).trim();
  const key = model.nameKey(tidy);
  if (!key) return { ok: false, reason: "EMPTY" };

  const existing = await getDoc(ref("golfers", golferId));
  if (!existing.exists()) return { ok: false, reason: "MISSING" };
  const before = existing.data() || {};

  /* Golfers imported from version 1, or written before nameKey existed, have no
     key at all. Work it out from the name they do have rather than trusting the
     field to be there — this is what crashed the rename. */
  const beforeKey = before.nameKey || model.nameKey(before.name);

  if (beforeKey === key) {
    await setDoc(ref("golfers", golferId), { name: tidy }, { merge: true });
    return { ok: true };
  }

  const claimed = await getDoc(ref("golferNames", key));
  if (claimed.exists() && claimed.data().golferId !== golferId) {
    return { ok: false, reason: "TAKEN" };
  }

  /* Rename, claim the new name, release the old one — together. Separately, a
     failure in the middle left a name claimed by nobody, so it could never be
     used again. */
  const writes = [
    { op: "set", path: ["golfers", golferId], data: { name: tidy, nameKey: key } },
    { op: "set", path: ["golferNames", key], data: { golferId, name: tidy } },
  ];
  if (beforeKey) writes.push({ op: "delete", path: ["golferNames", beforeKey] });

  await commitTogether(writes, "rename golfer");
  return { ok: true };
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
    (snap) => {
      if (!snap.exists()) return;
      /* Keep the cached copy current. inviteLink() and ensureAdminCode() read
         it rather than making a round trip — and while nothing filled it,
         inviteLink returned an empty string and the invitation button did
         nothing at all. */
      cachedAssociation = { ...snap.data(), id: snap.id };
      callback(cachedAssociation);
    },
    (e) => report(e));
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
/* Restoring is all-or-nothing per batch, and the order is chosen so that a
   failure part-way leaves readable data rather than orphans: courses and
   golfers first, then the roster, then the rounds that reference them. */
export async function restoreBackup({ golfers = [], courses = [], rounds = [] }) {
  const writes = [];

  for (const course of courses) {
    writes.push({ op: "set", path: ["courses", course.id],
      data: { ...course, createdBy: course.createdBy || uid } });
  }
  for (const golfer of golfers) {
    writes.push({ op: "set", path: ["golfers", golfer.id], data: golfer });
    if (golfer.nameKey) {
      writes.push({ op: "set", path: ["golferNames", golfer.nameKey],
        data: { golferId: golfer.id, name: golfer.name } });
    }
    writes.push({ op: "set", path: ["associations", assocId, "roster", golfer.id],
      data: { golferId: golfer.id, addedAt: Date.now() } });
  }
  for (const round of rounds) {
    writes.push({ op: "set", path: ["associations", assocId, "rounds", round.id],
      data: { ...round, assocId, enteredBy: uid, enteredAt: { __serverTimestamp: true } } });
  }

  await commitTogether(writes, "restore backup");
  return { queued: writes.length };
}

/* Ties the signed-in person to their golfer record, creating it if needed.
 *
 * Lost in the same refactor as myGolferId, and called in four places —
 * joining a group, joining by code, and creating one. addGolfer already reuses
 * an existing person when the name matches, so somebody joining a second group
 * keeps their handicap rather than starting again. */
export async function linkGolferForMember(displayName) {
  const name = String(displayName || "").trim();
  if (!name) return null;

  const { golfer } = await addGolfer({ name });

  if (golfer && !golfer.linkedUid) {
    outbox.enqueue({
      type: "update",
      path: ["golfers", golfer.id],
      data: { linkedUid: uid },
      opId: `golfer-link-${golfer.id}`,
    });
    flush();
  }
  return golfer;
}

/* The golfer record belonging to whoever is signed in.
 *
 * This went missing during a refactor and History called it anyway, so the
 * screen died on its first line every time. It returns "" rather than null so
 * a comparison against it can never accidentally match a golfer with no id. */
export const myGolferId = (golfers) => {
  const mine = (golfers || []).find((g) => g && g.linkedUid && g.linkedUid === uid);
  return mine ? mine.id : "";
};

/* ---------------- the groups this person belongs to ---------------- */

/* Firestore cannot ask "which groups am I in" directly without a collection
   group query and an index, so membership is remembered on the device as it
   happens. It is a convenience list, not a source of truth — the rules still
   decide what can actually be read. */
const GROUPS_KEY = "golf:v2:groups";

/* Also filed against the account, so signing in on a second device finds your
   groups. Remembering them only on the device was why the icon app could not
   see a group created in Safari. */
async function rememberGroupForAccount(id, name) {
  if (!fb || !uid) return;
  try {
    const { setDoc } = fb.mod.store;
    await setDoc(ref("userGroups", uid, "groups", id), { assocId: id, name, at: Date.now() });
  } catch { /* offline; the local list still works */ }
}

/* Every group this account belongs to, read from Firebase. */
export async function loadMyGroups() {
  if (!fb || !uid) return knownGroups();
  try {
    const { getDocs, getDoc } = fb.mod.store;
    const snap = await getDocs(col("userGroups", uid, "groups"));
    const hidden = hiddenGroups();
    const listed = snap.docs
      .map((d) => ({ id: d.id, name: (d.data() || {}).name || "Group" }))
      .filter((g) => !hidden.includes(g.id));

    /* NOTHING IS DELETED HERE.
     *
     * An earlier version removed a pointer whenever it could not confirm the
     * group existed — and a dropped connection was enough to trigger it, which
     * is how a live group vanished from an account. Cannot confirm is not the
     * same as gone. Groups that no longer exist are simply left out of what is
     * returned; the pointer stays until something with certainty removes it. */
    const alive = [];
    const missing = [];
    for (const group of listed) {
      try {
        const exists = await getDoc(ref("associations", group.id));
        if (exists.exists()) alive.push(group);
        else missing.push(group);
      } catch {
        alive.push(group);   /* unreadable — assume it is fine */
      }
    }

    /* Only cache when the answer looks trustworthy. If everything came back
       missing, that is far more likely to be a bad connection than every group
       being deleted at once, so the old list is kept. */
    if (alive.length || !listed.length) {
      try { localStorage.setItem(GROUPS_KEY, JSON.stringify(alive)); } catch {}
      return alive;
    }
    return knownGroups();
  } catch {
    return knownGroups();
  }
}

/* Whether this account is actually a member of a group — used to detect a
   device still pointing at a group left behind by an old identity. */
export async function amMemberOf(id) {
  if (!fb || !uid) return false;
  try {
    const { getDoc } = fb.mod.store;
    const snap = await getDoc(ref("associations", id, "members", uid));
    return snap.exists();
  } catch { return false; }
}

export function rememberGroup(id, name) {
  try {
    const list = JSON.parse(localStorage.getItem(GROUPS_KEY) || "[]");
    const without = list.filter((g) => g.id !== id);
    localStorage.setItem(GROUPS_KEY, JSON.stringify([...without, { id, name }]));
  } catch {}
}

export function knownGroups() {
  try {
    const hidden = hiddenGroups();
    return JSON.parse(localStorage.getItem(GROUPS_KEY) || "[]").filter((g) => !hidden.includes(g.id));
  } catch { return []; }
}

/* Removes a group from this account and this device, permanently.
 *
 * The stale entry kept returning after every sign-in because the account's copy
 * in Firestore was never cleared — the device forgot, then read it back. This
 * clears both, and cannot fail in a way that matters: if Firestore refuses, the
 * local list is still cleared and the entry is added to a suppression list that
 * loadMyGroups always filters out. It never touches the group itself. */
export async function forgetGroupEverywhere(id) {
  forgetGroup(id);

  try {
    const hidden = JSON.parse(localStorage.getItem("golf:v2:hidden") || "[]");
    if (!hidden.includes(id)) hidden.push(id);
    localStorage.setItem("golf:v2:hidden", JSON.stringify(hidden));
  } catch {}

  if (fb && uid) {
    try {
      const { deleteDoc, doc } = fb.mod.store;
      await deleteDoc(doc(fb.db, "userGroups", uid, "groups", id));
    } catch { /* the suppression list still holds */ }
  }

  if (id === assocId) {
    stopWatching();
    assocId = null;
    myMember = null;
    try { localStorage.removeItem(ASSOC_KEY); } catch {}
  }
  return true;
}

const hiddenGroups = () => {
  try { return JSON.parse(localStorage.getItem("golf:v2:hidden") || "[]"); } catch { return []; }
};

export function forgetGroup(id) {
  try {
    const list = JSON.parse(localStorage.getItem(GROUPS_KEY) || "[]");
    localStorage.setItem(GROUPS_KEY, JSON.stringify(list.filter((g) => g.id !== id)));
  } catch {}
}

/* Starting a second or third group, once you already belong to one. */
export async function createAnotherGroup({ name, displayName, addToRoster = true }) {
  const created = await createAssociation({ name, displayName });
  if (addToRoster) await linkGolferForMember(displayName);
  return created;
}


/* Brings a version 1 scorecard into the group you are already in. */
/* Names already in use are reused rather than duplicated — this is what gave
   the user two "Willy Rosales" and eighteen golfers instead of seventeen. */
export async function importLegacyIntoCurrentGroup({ v1 }) {
  const migrate = await import("./migrate.js");

  /* Look up who already exists before writing anything. */
  const existingByNameKey = {};
  try {
    const { getDocs, collection } = fb.mod.store;
    const snap = await getDocs(collection(fb.db, "golfers"));
    snap.forEach((d) => { const g = d.data(); if (g.nameKey) existingByNameKey[g.nameKey] = g; });
  } catch { /* none found; the import creates them */ }

  const written = await migrate.runInto({ db: fb.db, mod: fb.mod.store, uid, v1, assocId, existingByNameKey });
  const check = await migrate.verify({ db: fb.db, mod: fb.mod.store, assocId,
    expected: { golfers: (v1.golfers || []).length, rounds: (v1.rounds || []).length } });
  return { written, check };
}


/* ---------------- writing several documents as one ---------------- */

/* Firestore batches: every write lands, or none of them do.
 *
 * This exists because writing related documents one at a time is what has been
 * corrupting data. A round and the golfer's index are two documents describing
 * one event — write them separately and any failure in between leaves a round
 * with no index, or an index counting a round that was never saved. Deleting a
 * group was worse still: members went first, which removed the very permission
 * needed to finish, so the group survived while its contents did not.
 *
 * Nothing that touches more than one document may be written any other way.
 */
async function commitTogether(writes, what) {
  const { writeBatch, doc } = fb.mod.store;

  /* 500 is Firestore's hard limit per batch. Splitting is unavoidable above
     that, so the caller is told, and the order is chosen so that a failure
     between chunks leaves something readable rather than something broken. */
  for (let i = 0; i < writes.length; i += 400) {
    const batch = writeBatch(fb.db);
    for (const write of writes.slice(i, i + 400)) {
      const target = doc(fb.db, ...write.path);
      if (write.op === "delete") batch.delete(target);
      else if (write.op === "update") batch.update(target, hydrate(write.data));
      else batch.set(target, hydrate(write.data), { merge: write.merge !== false });
    }
    await batch.commit();
  }
  return { ok: true, count: writes.length, what };
}

/* ---------------- deleting a group ---------------- */

/* Removes a group and everything filed under it. Golfers are NOT deleted —
   they are people who may play in your other groups, and their handicap is
   built from rounds across all of them.
 *
 * Owner only, and the rules enforce it rather than the button being hidden. */
/* Deleting a group, safely.
 *
 * The hard-won lesson: rounds live INSIDE a group, so deleting one used to
 * take its rounds with it — that is how a season's golf was lost. Golfers and
 * courses were never at risk, because they live above every group.
 *
 * So this now takes a full backup of the rounds FIRST and hands it back to the
 * caller, which stores it where it can be restored from. Nothing is deleted
 * until that copy exists. If the backup cannot be made, the deletion does not
 * happen at all.
 */
export async function deleteGroup(targetId) {
  const { collection, getDocs } = fb.mod.store;
  const id = targetId || assocId;

  /* 1. Copy everything that only exists inside this group. */
  const rescued = { rounds: [], games: [], roster: [] };
  for (const part of ["rounds", "games", "roster"]) {
    try {
      (await getDocs(collection(fb.db, "associations", id, part)))
        .forEach((d) => rescued[part].push({ ...d.data(), id: d.id }));
    } catch (e) {
      /* Cannot read it means cannot safely delete it. Stop here. */
      setError("The group was not deleted",
        "Its rounds could not be read, so there was no way to keep a copy first. Nothing was changed.");
      throw e;
    }
  }

  /* 2. Keep that copy on the device before anything is removed, so even a
        failure halfway leaves a way back. */
  try {
    localStorage.setItem(`golf:v2:deleted:${id}`, JSON.stringify({
      deletedAt: new Date().toISOString(),
      groupId: id,
      groupName: (cachedAssociation && cachedAssociation.id === id ? cachedAssociation.name : "") || "",
      ...rescued,
    }));
  } catch { /* out of space; the copy in memory is still returned below */ }

  if (id === assocId) stopWatching();

  const counts = {};
  for (const part of ["rounds", "games", "roster", "members"]) {
    try {
      const snap = await getDocs(collection(fb.db, "associations", id, part));
      const writes = snap.docs.map((d) => ({ op: "delete", path: ["associations", id, part, d.id] }));
      if (writes.length) await commitTogether(writes, `clear ${part}`);
      counts[part] = writes.length;
    } catch { counts[part] = -1; }
  }

  try {
    await commitTogether([
      { op: "delete", path: ["associations", id] },
      { op: "delete", path: ["userGroups", uid, "groups", id] },
    ], "delete group");
    counts.group = 1;
  } catch { counts.group = -1; }

  forgetGroup(id);
  if (id === assocId) {
    assocId = null;
    myMember = null;
    try { localStorage.removeItem(ASSOC_KEY); } catch {}
  }

  /* Handed back so the caller can offer it as a file immediately. */
  return { ...counts, rescued };
}

/* Backups taken automatically when a group was deleted. */
export function deletedGroupBackups() {
  const found = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("golf:v2:deleted:")) {
        try { found.push(JSON.parse(localStorage.getItem(key))); } catch {}
      }
    }
  } catch {}
  return found.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

/* Editing a game after it exists — its name, its dates, its course.
 *
 * Widening the range only makes more rounds eligible to be added; it never
 * pulls any in by itself, and never removes one already in the game. Narrowing
 * it likewise leaves existing rounds alone, so a date change cannot silently
 * drop somebody's score out of a tournament. */
export async function updateGameDetails(gameId, { name, date, endDate, courseId }) {
  const clean = {
    name: String(name || "").trim(),
    date,
    endDate: endDate && endDate > date ? endDate : null,
  };
  if (courseId) clean.courseId = courseId;

  await commitTogether([
    { op: "update", path: ["associations", assocId, "games", gameId], data: clean },
  ], "update game");
  return clean;
}

/* Re-freezes the course handicap on every round in ONE game.
 *
 * A round stores the handicap that applied when it was posted, which is what
 * stops old results shifting. But an index set AFTERWARDS — a starting figure
 * typed in once a tournament is already under way — never reaches back into
 * rounds already posted, so their net scores stay blank or wrong.
 *
 * Deliberately scoped to a single game. A blanket sweep would rewrite results
 * that have already been shared, which is the opposite of what freezing is for.
 */
export async function recalculateGameHandicaps(gameId, { preview = false } = {}) {
  const { getDocs, query, where, getDoc } = fb.mod.store;

  const snap = await getDocs(
    query(col("associations", assocId, "rounds"), where("gameId", "==", gameId))
  );

  const changes = [];
  const seen = new Map();

  for (const d of snap.docs) {
    const r = d.data();
    if (!r || !r.golferId) continue;
    if (!Number.isFinite(+r.slope) || !Number.isFinite(+r.rating)) continue;

    let golfer = seen.get(r.golferId);
    if (golfer === undefined) {
      try {
        const found = await getDoc(ref("golfers", r.golferId));
        golfer = found.exists() ? found.data() : null;
      } catch { golfer = null; }
      seen.set(r.golferId, golfer);
    }
    if (!golfer) continue;

    const { index } = model.effectiveIndex(golfer);
    if (index == null) continue;

    const right = model.courseHandicap(index, +r.slope, +r.rating, +r.par);
    if (!Number.isFinite(right)) continue;
    if (r.courseHandicap === right) continue;

    changes.push({
      roundId: d.id,
      name: golfer.name || "Unknown",
      date: r.date,
      was: r.courseHandicap,
      now: right,
      index,
    });
  }

  if (preview || !changes.length) return { changes, applied: 0 };

  await commitTogether(changes.map((c) => ({
    op: "update",
    path: ["associations", assocId, "rounds", c.roundId],
    data: { courseHandicap: c.now, indexAtEntry: c.index },
  })), "recalculate game handicaps");

  return { changes, applied: changes.length };
}

/* A starting handicap for somebody with no rounds here yet. Passing null
   clears it. Real rounds always take precedence once there are three. */
export function setManualIndex(golferId, index) {
  outbox.enqueue({
    type: "update",
    path: ["golfers", golferId],
    data: { manualIndex: index == null ? null : model.clampIndex(index) },
    opId: `golfer-manual-${golferId}-${Date.now()}`,
  });
  flush();
}

/* ---------------- building a roster from your other groups ---------------- */

/* Everyone on the rosters of your OTHER groups, with the group they play in.
 *
 * This is how a tournament roster gets assembled without retyping seventeen
 * names — retyping is what creates duplicate people with split handicaps. */
export async function golfersInMyOtherGroups() {
  if (!fb || !uid) return [];
  const { getDocs } = fb.mod.store;

  const groups = (await loadMyGroups()).filter((g) => g.id !== assocId);
  const here = new Set();
  try {
    (await getDocs(col("associations", assocId, "roster"))).forEach((d) => here.add(d.id));
  } catch {}

  const seen = new Map();
  for (const group of groups) {
    let ids = [];
    try {
      (await getDocs(col("associations", group.id, "roster"))).forEach((d) => ids.push(d.id));
    } catch { continue; }

    for (const id of ids) {
      if (here.has(id)) continue;              /* already plays here */
      if (seen.has(id)) { seen.get(id).groups.push(group.name); continue; }
      try {
        const person = await getDoc_(id);
        if (person) seen.set(id, { ...person, groups: [group.name] });
      } catch {}
    }
  }
  return [...seen.values()].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || "")));
}

async function getDoc_(golferId) {
  const { getDoc } = fb.mod.store;
  const snap = await getDoc(ref("golfers", golferId));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

/* Adds several existing golfers to this group's roster in ONE batch — all of
   them or none, so a half-built roster is impossible. Creates nobody: these are
   people who already exist, keeping their rounds and their handicap. */
export async function addExistingToRoster(golferIds) {
  const ids = [...new Set((golferIds || []).filter(Boolean))];
  if (!ids.length) return { added: 0 };

  await commitTogether(ids.map((id) => ({
    op: "set",
    path: ["associations", assocId, "roster", id],
    data: { golferId: id, addedAt: Date.now() },
  })), "add existing golfers");

  return { added: ids.length };
}

/* ---------------- who is in a game ---------------- */

/* Attaches rounds to a game, or detaches them, in one batch. The game's line-up
   is simply which rounds carry its id, so editing the line-up is editing those
   rounds — there is no second list to fall out of step with. */
export async function setGameRounds({ gameId, addRoundIds = [], removeRoundIds = [] }) {
  const writes = [
    ...addRoundIds.map((id) => ({
      op: "update", path: ["associations", assocId, "rounds", id], data: { gameId },
    })),
    ...removeRoundIds.map((id) => ({
      op: "update", path: ["associations", assocId, "rounds", id], data: { gameId: null },
    })),
  ];
  if (!writes.length) return { changed: 0 };
  await commitTogether(writes, "set game line-up");
  return { changed: writes.length };
}
