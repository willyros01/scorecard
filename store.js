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
import * as platform from "./platform.js";

/* Firebase is bundled into the app's own files (spec Change 3): built from
   the firebase npm package at exactly 10.12.0 by build/firebase-entry.js.
   Nothing is downloaded at run time. */
const FIREBASE_BUNDLE = "./vendor/firebase/firebase-10.12.0.js";

/* ---------------- offline-aware reads (spec Change 3, Part C) ----------------
   With data kept on the device, an offline read of something never
   downloaded comes back EMPTY, not as an error. "Empty" must then mean
   "unknown, offline" — never "you belong to no group" or "not found". */
let cacheMiss = false;
function noteRead(snap, found) {
  const fromCache = !!(snap && snap.metadata && snap.metadata.fromCache);
  if (fromCache && !found) cacheMiss = true;
  else if (!fromCache) cacheMiss = false;
}
export const readsOffline = () => cacheMiss || (typeof navigator !== "undefined" && navigator.onLine === false);
let persistentCacheOff = false;
let closing = false;   /* beta.8: set by shutDown() before a page change */
export const offlineCopyUnavailable = () => persistentCacheOff;

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
  error: lastError, queued: outbox.count(), accountStatusUnknown: deletionCheckUnknown,
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

/* Automated tests only. On this machine's own address (localhost) with
   ?emulators=1, the app talks to the Firebase emulators running beside the
   tests — a demo project that cannot reach any live data. Anywhere else,
   including the published site and the iPhone app, this is always false. */
const EMULATORS = (() => {
  try {
    return ["localhost", "127.0.0.1"].includes(location.hostname)
      && new URLSearchParams(location.search).has("emulators");
  } catch { return false; }
})();
const EMULATOR_CONFIG = { apiKey: "fake-api-key", projectId: "demo-scorecard", authDomain: "localhost", appId: "demo" };
const AUTH_EMULATOR = "http://127.0.0.1:9099";

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
    const { app, auth, store } = await import(FIREBASE_BUNDLE);
    const firebaseConfig = EMULATORS ? EMULATOR_CONFIG : config.firebaseConfig;
    const instance = app.initializeApp(firebaseConfig);
    /* IndexedDB is where getAuth has always kept the sign-in, so existing web
       sign-ins carry straight over (proved by rehearsal R1). The no-remote-code
       auth build offers IndexedDB only. getAuth itself can hang inside the app. */
    const authInstance = auth.initializeAuth(instance, {
      persistence: [auth.indexedDBLocalPersistence],
    });
    if (EMULATORS) auth.connectAuthEmulator(authInstance, AUTH_EMULATOR, { disableWarnings: true });
    /* Inside the app every document read is kept on the device across
       restarts (Part B). In a browser Firestore stays memory-only, as today. */
    let database;
    if (platform.isApp()) {
      try {
        database = store.initializeFirestore(instance, {
          /* beta.8: no forceOwnership. Every page now closes its saved copy
             cleanly before it is left (shutDown below), so the next page finds
             it free; beta.7's take-over only moved the wait somewhere else. */
          localCache: store.persistentLocalCache({ tabManager: store.persistentSingleTabManager() }),
        });
      } catch {
        persistentCacheOff = true;
        database = store.getFirestore(instance);
      }
    } else {
      database = store.getFirestore(instance);
    }
    if (EMULATORS) store.connectFirestoreEmulator(database, "127.0.0.1", 8080);
    fb = { mod: { app, auth, store }, auth: authInstance, db: database, config: firebaseConfig };

    await new Promise((resolve) => {
      auth.onAuthStateChanged(fb.auth, async (user) => {
        /* Version 2.0 Phase B: no anonymous sign-in. Nobody signed in means the
           first screen asks them to sign in, or to create their account from an
           invitation. The old automatic guest sign-in is gone for good. */
        if (!user) {
          uid = null;
          setStatus("Signed out");
          resolve();
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
/* Every live watcher goes through here, so a saved copy shown while offline is
   labelled as such (Part C). Only when the device is actually offline, so the
   web app never flickers. */
const listen = (target, onNext, onError) => fb.mod.store.onSnapshot(target, (snap) => {
  if (snap && snap.metadata && snap.metadata.fromCache && typeof navigator !== "undefined" && navigator.onLine === false) {
    setStatus("Offline — showing saved copy", true);
  }
  onNext(snap);
}, onError);
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
  if (!fb) return;   /* beta.8: closed for a page change; the next page sends them */
  if (!uid || (typeof navigator !== "undefined" && !navigator.onLine)) {
    setStatus(`Saved on device (${outbox.count()} waiting)`, true);
    return;
  }

  setStatus("Syncing");
  /* beta.8: a write cut off by shutDown() is NOT a refusal. Firestore reports
     it as failed-precondition, which the outbox treats as permanent and would
     set aside; this keeps it queued instead, for the next page to send. */
  const closed = () => new Error("Closed for a page change; sent from the next page.");
  const result = await outbox.flush(async (op) => {
    if (closing) throw closed();
    try { return await writeOperation(op); }
    catch (e) { if (closing) throw closed(); throw e; }
  });

  /* Anything given up on must be SAID. A round that quietly failed to upload
     and then vanished from the queue is the worst outcome there is — worse than
     an error, because nobody knows to re-enter it. */
  if (result.failed) {
    setError(
      `${result.failed} change${result.failed === 1 ? "" : "s"} could not be saved`,
      "The database refused them, usually because the rules in the console are older than this version, or because you no longer have permission for that change. Nothing else was affected — publish the latest firestore.rules and re-enter anything missing."
    );
  }

  if (result.remaining === 0) {
    if (!result.failed) clearError();
    setStatus(result.failed ? "Synced, with problems" : "Synced");
  } else {
    setStatus(`Saved on device (${result.remaining} waiting)`, true);
    if (result.stoppedOn) report(new Error(result.stoppedOn.error));
  }
  return result;
}

/* Writes the queue gave up on, so a screen can show what was lost rather than
   leaving somebody to find a missing round weeks later. */
export const abandonedWrites = () => outbox.abandoned();

/* ---------------- associations and joining ---------------- */

export async function createAssociation({ name, displayName, id = null }) {
  const association = id
    ? model.buildAssociation({ name, ownerUid: uid, id })
    : model.buildAssociation({ name, ownerUid: uid });
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

  /* Phase D: the admin invitation secret, where only the owner can read it.
     Written after the membership, because the rule reads that membership.
     If this one write fails, it is simply made the first time an admin
     invitation is sent (ensureAdminCode). */
  try { await setDoc(ref("associations", association.id, "secrets", "admin"), { adminCode: model.newJoinCode() }); }
  catch { /* made later, on demand */ }

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
/* Which role a code unlocks.
 *
 * Only usable by somebody who can already read the group — that is, an
 * existing member. A person arriving on an invitation cannot, so joining uses
 * the role carried in the link instead and lets the rules verify it. */
export async function roleForCode(associationId, code) {
  if (!fb) return "member";
  try {
    const { getDoc } = fb.mod.store;
    const snap = await getDoc(ref("associations", associationId));
    if (!snap.exists()) return "member";
    const data = snap.data() || {};
    return data.adminCode && code === data.adminCode ? "admin" : "member";
  } catch {
    return "member";
  }
}

export async function joinAssociation({ associationId, code, displayName }) {
  const { setDoc, serverTimestamp } = fb.mod.store;
  /* The role comes from the LINK, not a hardcoded "member".
   *
   * An admin invitation carries the admin code and `as=admin`. Asking for the
   * "member" role while presenting the admin code fails the rules — role
   * member requires the GUEST code — so every non-playing admin invitation was
   * refused with "That code was not accepted". The rules still verify the code
   * against the group, so this is a claim they check, not one they trust. */
  /* ALREADY A MEMBER? Then a code must change NOTHING.
   *
   * A code always asks for the ordinary member role, so writing it over an
   * existing membership demotes an admin to a guest — reported Aug 22. The
   * rules would refuse the write anyway (create only, never self-update), and
   * the refusal was being reported as "That code was not accepted", which is
   * wrong twice over. So look first, and if the membership is already there,
   * simply open the group with the role it already carries. */
  const existing = await loadMembership(associationId);
  if (existing) {
    const g = await loadAssociation(associationId);
    const gname = g ? g.name : "Group";
    try {
      await commitTogether([{
        op: "set",
        path: ["userGroups", uid, "groups", associationId],
        data: { assocId: associationId, name: gname, at: Date.now() },
      }], "heal group pointer");
    } catch { /* The pointer is a convenience; the membership is the truth. */ }
    assocId = associationId;
    rememberAssociation(associationId);
    rememberGroup(associationId, gname);
    clearError();
    return { ok: true, already: true, role: existing.role };
  }

  const fromLink = readJoinLink();
  const role = (fromLink && fromLink.associationId === associationId && fromLink.role === "admin")
    ? "admin"
    : "member";

  const member = model.buildMember({
    uid, displayName, role, joinCode: model.normalizeJoinCode(code),
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
          /* REQUIRED whenever the golfer is not the person signed in.
           *
           * This is a write to a shared, top-level golfer document, so the
           * rules demand editedIn naming a group where the writer is an admin
           * and the golfer is on the roster. It was missing, so posting for
           * ANYBODY ELSE was refused — and because the round and the index go
           * as one batch, the ROUND was refused with it. That is why fast
           * entry appeared to accept scores and save none of them.
           *
           * Posting your own round always passed, which is why this survived:
           * the rules let you edit your own linked golfer with no editedIn at
           * all. Harmless to send in that case. */
          editedIn: assocId,
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
      /* Same reason as postRound: an admin correcting somebody else's round
         rebuilds THEIR golfer document, which the rules refuse without this. */
      editedIn: assocId,
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
    /* groups: the groups this golfer plays in, which lets their admins read
       the record (Phase A rules). */
    writes.push({ op: "set", path: ["golfers", golfer.id], data: { ...golfer, groups: [assocId] } });
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

/* Changing a course that is ALREADY THERE, keeping its id.
 *
 * The id is the whole point. Every round ever posted points at it, and at a
 * tee id inside it. Save a corrected course under a new id and those rounds
 * are cut adrift. So this is an update in place, never a create.
 *
 * Rounds are NOT touched and must never be: each one froze its own rating,
 * slope and par at the moment it was posted, which is both what the handicap
 * system requires and what stops a re-rating rewriting history. */
export function updateCourse(course) {
  const clean = model.buildCourse({ ...course, createdBy: course.createdBy });
  outbox.enqueue({
    type: "update",
    path: ["courses", course.id],
    /* createdBy is deliberately NOT sent. The rules compare it against the
       stored value to decide whether this is allowed, so it must stay as it
       is — and sending it invites a mistake that locks somebody out of their
       own course. */
    data: { name: clean.name, tees: clean.tees },
    opId: `course-update-${course.id}-${Date.now()}`,
  });
  flush();
  return clean;
}

/* Only whoever entered a course may change it — that is the rule in the
   console, not a decision the app can talk its way around. Asked here so a
   screen can hide the button rather than offer one that fails. */
export const canEditCourse = (course) => !!(course && uid && course.createdBy === uid);

/* Hiding is PER GROUP, not global.
 *
 * Courses are shared: the list holds every course anybody has ever entered, so
 * one group's clutter is another group's home track. Marking the course itself
 * hidden would take it off everyone's list. The group document carries the
 * list of ids this group would rather not see, and nothing outside the group
 * is affected. Nothing is ever deleted — the rules forbid it, and rounds point
 * at courses. */
export const hiddenCourses = () =>
  (cachedAssociation && cachedAssociation.hiddenCourses) || [];

export function setCourseHidden(courseId, hidden) {
  const now = hiddenCourses().filter((id) => id !== courseId);
  updateAssociation({ hiddenCourses: hidden ? [...now, courseId] : now });
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

/* The golfers this screen may show (Version 2.0, Phase A privacy).
 *
 * Owners and admins: the full record of every golfer on this group's roster,
 * read one document at a time (nobody may list the whole golfers collection).
 * Regular members: their OWN full record, plus name and handicap index only for
 * everybody else, from the group's directory. A directory entry arrives as a
 * golfer-shaped object with fromDirectory set and directoryIndex holding the
 * published index, so the screens need no second code path to show a name. */
let watchGeneration = 0;
export function watchGolfers(callback) {
  const generation = watchGeneration;
  if (canManage()) return watchRosterGolfers(callback, generation);
  return watchMemberGolfers(callback, generation);
}

function watchRosterGolfers(callback, generation) {
  const { onSnapshot } = fb.mod.store;
  const docs = new Map();      /* golferId -> data */
  const stops = new Map();     /* golferId -> unsubscribe */
  const emit = () => callback([...docs.values()].filter((g) => !g.archived));
  const stopRoster = listen(col("associations", assocId, "roster"), (snap) => {
    const ids = new Set(snap.docs.map((d) => d.id));
    for (const [id, stop] of stops) if (!ids.has(id)) { try { stop(); } catch {} stops.delete(id); docs.delete(id); }
    for (const id of ids) {
      if (stops.has(id)) continue;
      const subscribe = (retried) => listen(ref("golfers", id), (g) => {
        if (g.exists()) docs.set(id, { ...g.data(), id }); else docs.delete(id);
        emit();
      }, () => {
        docs.delete(id); emit();
        /* Refused: the record does not list this group yet (made before
           Phase A). As an admin here, add the group, then read again once. */
        if (!retried) addGroupToGolfer(id).then((done) => {
          if (done && stops.has(id) && generation === watchGeneration) stops.set(id, subscribe(true));
        });
      });
      stops.set(id, subscribe(false));
    }
    emit();
  }, (e) => report(e));
  const stop = () => { try { stopRoster(); } catch {} for (const s2 of stops.values()) { try { s2(); } catch {} } stops.clear(); };
  if (generation === watchGeneration) unsubscribers.push(stop); else stop();
  return stop;
}

function watchMemberGolfers(callback, generation) {
  let mine = null;
  let others = [];
  const emit = () => callback([...(mine ? [mine] : []), ...others.filter((o) => !mine || o.id !== mine.id)]);
  const stops = [];
  stops.push(listen(col("associations", assocId, "directory"), (snap) => {
    others = snap.docs.map((d) => {
      const e = d.data();
      return { id: d.id, name: e.displayName || "Unknown", fromDirectory: true,
               directoryIndex: e.handicapIndex == null ? null : Number(e.handicapIndex) };
    });
    emit();
  }, (e) => report(e)));
  findMyGolfer().then((g) => {
    if (generation !== watchGeneration || !g) return;
    stops.push(listen(ref("golfers", g.id), (snap) => {
      mine = snap.exists() ? { ...snap.data(), id: snap.id } : null;
      emit();
      if (mine) publishOwnDirectoryEntries(mine);
    }, (e) => report(e)));
  });
  const stop = () => { while (stops.length) { try { stops.pop()(); } catch {} } };
  unsubscribers.push(stop);
  return stop;
}

/* Which golfer this account is: the one whose linkedUid is this account.
   Remembered per session; the membership records it too (golferId), which is
   what the games rule reads to decide who played. */
let myGolferCache = null;
export async function findMyGolfer() {
  if (!fb || !uid) return null;
  if (myGolferCache && myGolferCache.linkedUid === uid) return myGolferCache;
  const { query, where, limit, getDocs, updateDoc } = fb.mod.store;
  try {
    const snap = await getDocs(query(col("golfers"), where("linkedUid", "==", uid), limit(5)));
    const found = snap.docs.map((d) => ({ ...d.data(), id: d.id })).filter((g) => !g.archived)[0] || null;
    myGolferCache = found;
    if (found && assocId && myMember && myMember.golferId !== found.id) {
      /* Best effort: the rules allow only this one field, and only for a
         golfer really linked to this account. */
      try { await updateDoc(ref("associations", assocId, "members", uid), { golferId: found.id }); myMember.golferId = found.id; }
      catch { /* older rules: harmless */ }
    }
    return found;
  } catch { return null; }
}
export const myGolferIdNow = () => (myGolferCache ? myGolferCache.id : (myMember && myMember.golferId) || "");

/* ---------------- the directory: name and index only ---------------- */

const directoryEntry = (golfer) => ({
  golferId: golfer.id,
  displayName: golfer.name || "",
  handicapIndex: model.effectiveIndex(golfer).index,
  updatedAt: Date.now(),
});

/* Writes one golfer's entry in one group. Best effort and never queued: the
   entry is a projection of the golfer record, rebuilt whenever it is next
   written, so a failed write loses nothing. */
export async function publishDirectoryEntry(golfer, group = assocId) {
  if (!fb || !golfer || !golfer.id || !group || golfer.fromDirectory) return false;
  try { await fb.mod.store.setDoc(ref("associations", group, "directory", golfer.id), directoryEntry(golfer)); return true; }
  catch { return false; }
}

/* A golfer plays in several groups and their index spans all of them. With no
   server, the golfer's own app keeps their entry current in every group they
   belong to (the rules allow exactly that, and nothing more). */
async function publishOwnDirectoryEntries(golfer) {
  const groups = new Set([...(golfer.groups || []), ...knownGroups().map((g) => g.id)]);
  if (assocId) groups.add(assocId);
  for (const g of groups) await publishDirectoryEntry(golfer, g);
}

/* Owners and admins refresh the whole group's directory when they open it, so
   entries stay right for golfers who never open the app themselves. Only
   entries that differ are written. */
export async function refreshGroupDirectory(golfersOnRoster) {
  if (!fb || !assocId || !canManage()) return 0;
  const { getDocs } = fb.mod.store;
  let current = new Map();
  try { current = new Map((await getDocs(col("associations", assocId, "directory"))).docs.map((d) => [d.id, d.data()])); }
  catch { return 0; }
  let written = 0;
  for (const g of golfersOnRoster || []) {
    const want = directoryEntry(g);
    const have = current.get(g.id);
    if (!have || have.displayName !== want.displayName || (have.handicapIndex ?? null) !== (want.handicapIndex ?? null)) {
      if (await publishDirectoryEntry(g)) written++;
    }
    /* The golfer record lists its groups so admins may read it (rules, R8). */
    if (!(g.groups || []).includes(assocId)) await addGroupToGolfer(g.id);
  }
  /* Somebody taken off the roster leaves the ranking too. */
  const onRoster = new Set((golfersOnRoster || []).map((g) => g.id));
  for (const id of current.keys()) {
    if (!onRoster.has(id)) { try { await fb.mod.store.deleteDoc(ref("associations", assocId, "directory", id)); written++; } catch {} }
  }
  return written;
}

/* Adds this group to a golfer's `groups` list, as an admin of this group
   (editedIn), without reading the record first. */
export async function addGroupToGolfer(golferId, group = assocId) {
  if (!fb || !golferId || !group) return false;
  const { updateDoc, arrayUnion } = fb.mod.store;
  try { await updateDoc(ref("golfers", golferId), { groups: arrayUnion(group), editedIn: group }); return true; }
  catch { return false; }
}

/* Which of them play in this group. */
export function watchRoster(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = listen(col("associations", assocId, "roster"),
    (snap) => callback(snap.docs.map((d) => d.id)),
    (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

/* Deliberately bounded. Pagination is a version 3 concern, but an unbounded
   query would be the thing that quietly runs up a bill, so it is capped now. */
export function watchRounds(callback, { max = 500 } = {}) {
  const { query, orderBy, limit, where } = fb.mod.store;
  const generation = watchGeneration;
  const deliver = (snap) => {
    clearError();
    /* Archived rounds are filtered out HERE, at the single point every screen
       reads from. Hidden, never destroyed. */
    callback(snap.docs
      .map((d) => ({ ...d.data(), id: d.id }))
      .filter((g) => !g.archived)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))));
  };
  if (canManage()) {
    const stop = listen(query(col("associations", assocId, "rounds"), orderBy("date", "desc"), limit(max)), deliver, (e) => report(e));
    unsubscribers.push(stop);
    return stop;
  }
  /* A regular member may read only their own rounds (Phase A rules), so the
     query must say so. No orderBy: a filter plus a sort would need an index. */
  let stop = () => {};
  findMyGolfer().then((g) => {
    if (generation !== watchGeneration) return;
    if (!g) { callback([]); return; }
    stop = listen(query(col("associations", assocId, "rounds"), where("golferId", "==", g.id), limit(max)), deliver, (e) => report(e));
    unsubscribers.push(stop);
  });
  return () => stop();
}

export function watchCourses(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = listen(col("courses"), (snap) => callback(snap.docs.map((d) => d.data())), (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

/* beta.8 — THE CAUSE of "Loading your group" after coming back from a tool.
 *
 * Inside the iPhone app every page shares one window. A page that is left by
 * navigating (to Tidy and back) is not destroyed: WebKit keeps it frozen in
 * memory with its Firestore saved copy (IndexedDB) still open, and any
 * database step it had in flight frozen with it. The next page's database
 * steps queue behind that frozen step until iOS throws the old page away
 * (switching apps, sleep) — exactly what Willy saw. So a page is never left
 * with Firestore open: shutDown() stops every listener and deletes the
 * Firebase app, which ends Firestore (gives the saved copy back and closes
 * IndexedDB) and Auth. Nothing is lost: the saved copy and any waiting
 * writes stay in IndexedDB, and our own outbox is in localStorage.
 * Waits for the close to FINISH; it does not time out — a failure is
 * reported, never hidden. */
export async function shutDown() {
  closing = true;
  stopWatching();
  if (!fb) return;
  const instance = fb.db && fb.db.app;
  const mod = fb.mod;
  const database = fb.db;
  fb = null;   // nothing may reach a closed Firestore (the outbox timer checks fb)
  /* Firestore FIRST, while the sign-in is still alive: deleting the app
     closes both at once, and Firestore then waits for the sign-in it was
     just deprived of — for ever (proved in Chromium; it is what stuck
     Tidy's "Back to the app"). Then the app, which ends the sign-in's
     polling of IndexedDB. */
  if (database) await mod.store.terminate(database);
  if (instance) await mod.app.deleteApp(instance);
}

export function stopWatching() {
  watchGeneration++;
  myGolferCache = null;
  while (unsubscribers.length) {
    const stop = unsubscribers.pop();
    try { stop(); } catch { /* already gone */ }
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
      /* SIGN IN FIRST, and only fall back to linking.
       *
       * This branch used to LINK straight away, which CREATES the account. A
       * fresh browser always starts anonymous, so signing in there with an
       * email that already existed — or one simply mistyped — produced a brand
       * new account belonging to no group, and the "Start your group" screen.
       * That is how somebody nearly ended up with a second empty group beside
       * their real one.
       *
       * So: try to sign in as an existing account. Only if there genuinely is
       * no such account do we upgrade this anonymous session, and only when
       * this device has something worth carrying across. */
      try {
        await signInWithEmailAndPassword(fb.auth, address, secret);
        uid = fb.auth.currentUser.uid;
        clearError();
        return { ok: true, outcome: "signed-in" };
      } catch (first) {
        const why = String((first && (first.code || first.message)) || "").toLowerCase();

        /* A real account whose password is wrong must NEVER be turned into a
           new one — that is exactly how a person loses their group. */
        if (!why.includes("user-not-found")) {
          const wrong = new Error("auth/no-such-account");
          wrong.code = "auth/no-such-account";
          throw wrong;
        }

        /* Genuinely no such account. Only claim this address if the person is
           in the middle of something — a group already open — rather than
           silently minting an identity for a typo on the sign-in screen. */
        if (!assocId) {
          const wrong = new Error("auth/no-such-account");
          wrong.code = "auth/no-such-account";
          throw wrong;
        }

        await linkWithCredential(current, EmailAuthProvider.credential(address, secret));
        await refreshToken();
        uid = fb.auth.currentUser.uid;
        clearError();
        return { ok: true, outcome: "created" };
      }
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
    /* NEVER create an account from the sign-in screen.
     *
     * This used to fall through to createUserWithEmailAndPassword whenever the
     * address was unknown — so a MISTYPED email did not say "no such account",
     * it silently made one. That account belongs to no group, so the person
     * landed on "Start your group" and was one tap from a second, empty group
     * beside their real one. It also produced accounts nobody knew existed.
     *
     * Accounts are created deliberately: by accepting an invitation, or by
     * setting a password on an account that already exists. Not by a typo. */
    if (code.includes("user-not-found") || code.includes("invalid-credential")
        || code.includes("invalid-email") || code.includes("wrong-password")) {
      const wrong = new Error("auth/no-such-account");
      wrong.code = "auth/no-such-account";
      throw wrong;
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
/* An admin or owner running on an anonymous account.
 *
 * Their role is real and the rules granted it properly — but without an account
 * it lives in one browser only. Clear the data and it is gone, and nothing ties
 * those actions to a person rather than a device. Anybody in this state is
 * asked to set a password; their access keeps working meanwhile. */
/* Set or change the password on whatever account this device is using.
 *
 * Three cases, and the app must not have to know which it is in:
 *   anonymous      — link a password so the account survives sign-out
 *   another method — add a password to the SAME account, never make a new one
 *   has one        — replace it
 *
 * The middle case matters most: signing in fresh with an email would create a
 * DIFFERENT account, and everything belonging to the old one — role, groups,
 * rounds — would be invisible. Present but unreachable. */
export async function setMyPassword({ email, password }) {
  if (!fb) throw new Error("Firebase has not loaded yet.");
  const { EmailAuthProvider, linkWithCredential, updatePassword } = fb.mod.auth;

  const address = String(email || "").trim();
  const secret = String(password || "");
  if (!address) throw new Error("auth/invalid-email");
  if (secret.length < 6) throw new Error("auth/weak-password");

  const current = fb.auth.currentUser;
  if (!current) throw new Error("auth/no-current-user");

  if (hasPassword()) {
    await updatePassword(current, secret);
    clearError();
    return { ok: true, outcome: "changed" };
  }

  /* Anonymous, or signed in another way. Either is a link onto the SAME
     account, so nothing is stranded. */
  const owned = String(current.email || "").toLowerCase();
  if (owned && owned !== address.toLowerCase()) {
    throw new Error(`auth/wrong-email:${current.email}`);
  }

  /* The email may ALREADY have an account, from an earlier sign-in or an
     earlier round of testing. Linking then fails with "already in use", and
     signing in afterwards lands on a DIFFERENT account — one that knows
     nothing about the membership just written for the anonymous session. That
     is exactly the "something went wrong, retry, asked again" loop.

     So: sign in to the existing account, then rebuild the membership under it.
     The role is preserved rather than stranded on an account nobody returns
     to. */
  const wasAnonymous = !!current.isAnonymous;
  const previousUid = current.uid;
  const memberBefore = myMember ? { ...myMember } : null;
  const groupBefore = assocId;

  try {
    await linkWithCredential(current, EmailAuthProvider.credential(current.email || address, secret));
  } catch (e) {
    const code = String((e && (e.code || e.message)) || "").toLowerCase();
    const taken = code.includes("already-in-use") || code.includes("email-already");
    if (!taken || !wasAnonymous) throw e;

    const { signInWithEmailAndPassword } = fb.mod.auth;
    await signInWithEmailAndPassword(fb.auth, address, secret);
    uid = fb.auth.currentUser.uid;

    /* Carry the membership across, unless that account already belongs here. */
    if (groupBefore && memberBefore && uid !== previousUid) {
      const { setDoc, getDoc } = fb.mod.store;
      const already = await getDoc(ref("associations", groupBefore, "members", uid));
      if (!already.exists()) {
        await setDoc(ref("associations", groupBefore, "members", uid), {
          ...memberBefore,
          uid,
          joinedAt: serverTimestampValue(),
        });
      }
      await setDoc(ref("userGroups", uid, "groups", groupBefore), {
        assocId: groupBefore, name: (cachedAssociation && cachedAssociation.name) || "Group",
        at: Date.now(),
      });
      myMember = await loadMembership(groupBefore);
    }

    clearError();
    return { ok: true, outcome: "signed-in-existing" };
  }

  try { await fb.auth.currentUser.reload(); } catch {}
  await refreshToken();
  uid = fb.auth.currentUser.uid;
  clearError();
  return { ok: true, outcome: "added" };
}

export const needsPassword = () => canManage() && !hasPassword();

export const hasPassword = () => {
  const user = fb && fb.auth && fb.auth.currentUser;
  return !!(user && user.providerData
    && user.providerData.some((p) => p.providerId === "password"));
};

export const isSignedIn = () => {
  const user = fb && fb.auth && fb.auth.currentUser;
  return !!(user && !user.isAnonymous);
};

/* Any sign-in on this device, including an old anonymous guest session. */
export const hasUser = () => !!(fb && fb.auth && fb.auth.currentUser);

/* An old guest session from before Version 2.0 (Phase B). The rules refuse it
   everything except finding its own groups and deleting itself, so the app
   asks for an email and password — attached to the SAME account, so the
   person keeps their groups, role and rounds. */
export const isAnonymousSession = () => {
  const user = fb && fb.auth && fb.auth.currentUser;
  return !!(user && user.isAnonymous);
};

/* After an email is attached, the token must carry it before the next read,
   or the rules still see an anonymous session. */
async function refreshToken() {
  try { await fb.auth.currentUser.getIdToken(true); } catch {}
}

/* ================= Version 2.0 Phase C: the PUBLIC group ================= */

/* The PUBLIC group's fixed id (the rules reserve it). */
export const PUBLIC_ID = "PUBLIC";
export const isPublicGroup = () => assocId === PUBLIC_ID;
const emailKey = (email) => String(email || "").trim().toLowerCase();

/* An application: full name and email, written WITHOUT signing in (R1, R3).
   It counts only once Firestore confirms it; otherwise the person is told. */
export async function submitApplication({ fullName, email }) {
  if (!fb) throw new Error("The app is still starting. Try again in a moment.");
  const name = String(fullName || "").trim().replace(/\s+/g, " ");
  const address = String(email || "").trim();
  const key = emailKey(address);
  if (name.length < 2 || name.length > 80) { const e = new Error("name"); e.code = "app/name"; throw e; }
  if (!/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(key) || address.length > 254) { const e = new Error("email"); e.code = "app/email"; throw e; }
  /* beta.4: an email that already has an account is stopped here, on screen
     (the rules refuse it too). Nothing is saved and no email goes out. */
  if (await emailHasAccount(address)) { const e = new Error("in use"); e.code = "app/in-use"; throw e; }
  const { setDoc, serverTimestamp } = fb.mod.store;
  try {
    await withTimeout(setDoc(ref("publicApplications", key), {
      fullName: name, email: address, status: "pending", createdAt: serverTimestamp(),
    }), 20000, "Your application");
  } catch (e) {
    const code = String((e && (e.code || e.message)) || "");
    /* The only way a well-formed application is refused is that one already
       exists for this email (applicants can never see or change it). */
    if (code.includes("permission")) { const x = new Error("exists"); x.code = "app/exists"; throw x; }
    throw e;
  }
  return { ok: true };
}

/* Is the signed-in email confirmed? New PUBLIC accounts confirm it by setting
   their password from the approval email; anyone else confirms it with
   Firebase's confirmation email. */
export const emailConfirmed = () => {
  const user = fb && fb.auth && fb.auth.currentUser;
  return !!(user && !user.isAnonymous && user.email && user.emailVerified);
};
export async function sendEmailConfirmation() {
  await fb.mod.auth.sendEmailVerification(fb.auth.currentUser);
}
/* After the person confirms in their email, fetch the new state. */
export async function refreshEmailState() {
  try { await fb.auth.currentUser.reload(); } catch {}
  await refreshToken();
  emit();
  return emailConfirmed();
}

/* The applicant's side of an approval: if one waits for this confirmed email,
   join the PUBLIC group as the golfer the reviewer chose. Returns
   { joined: true } after joining, { joined: false } when there is none, or
   { needsConfirmation: true } when the email is not confirmed yet. */
export async function joinPublicIfApproved() {
  if (!fb || !uid || isAnonymousSession()) return { joined: false };
  if (!emailConfirmed()) return { needsConfirmation: true };
  const { getDoc, getDocFromServer, deleteDoc } = fb.mod.store;
  const key = emailKey(fb.auth.currentUser.email);
  let approval;
  try {
    approval = await getDocFromServer(ref("publicApprovals", key));
  } catch { return { joined: false }; }
  if (!approval.exists()) return { joined: false };
  const a = approval.data();
  const already = await getDoc(ref("associations", PUBLIC_ID, "members", uid)).catch(() => null);
  if (!(already && already.exists())) {
    await commitTogether([
      { op: "set", merge: false, path: ["associations", PUBLIC_ID, "members", uid],
        data: { uid, role: "member", displayName: a.displayName || "", golferId: a.golferId, joinedAt: { __serverTimestamp: true } } },
      { op: "update", path: ["golfers", a.golferId], data: { linkedUid: uid } },
      { op: "set", path: ["userGroups", uid, "groups", PUBLIC_ID], data: { assocId: PUBLIC_ID, name: "PUBLIC", at: Date.now() } },
    ], "join the PUBLIC group");
  }
  rememberGroup(PUBLIC_ID, "PUBLIC");
  try { await deleteDoc(ref("publicApprovals", key)); } catch { /* removed next time */ }
  return { joined: true };
}

/* ---- reviewers (admins of PUBLIC) ---- */

export function watchApplications(callback) {
  const { query, where } = fb.mod.store;
  /* Pending, and approvals in progress (so a stuck one can be finished). */
  const stop = listen(query(col("publicApplications"), where("status", "in", ["pending", "approving"])),
    (snap) => callback(snap.docs.map((d) => ({ key: d.id, ...d.data() }))
      .sort((x, y) => ((x.createdAt && x.createdAt.seconds) || 0) - ((y.createdAt && y.createdAt.seconds) || 0))),
    (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

/* ---------------- private group requests (2.30.0-beta.3) ----------------
   An organiser asks for a private group WITHOUT signing in, like an
   application (groupRequests/{email}). Only the group creator (Willy) reads
   and decides them. Approving is safe to retry: the request is first claimed
   with the new group's id, the group is made with that id (or found, on a
   retry), and only then is the request marked approved. */
export async function submitGroupRequest({ fullName, email, groupName, size, where, note }) {
  if (!fb) throw new Error("The app is still starting. Try again in a moment.");
  const clean = (v, max) => String(v || "").trim().replace(/\s+/g, " ").slice(0, max);
  const name = clean(fullName, 200);
  const address = String(email || "").trim();
  const key = emailKey(address);
  const group = clean(groupName, 200);
  const sizeText = clean(size, 200);
  const whereText = clean(where, 200);
  const noteText = String(note || "").trim().slice(0, 1000);
  if (name.length < 2 || name.length > 80) { const e = new Error("name"); e.code = "app/name"; throw e; }
  if (!/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(key) || address.length > 254) { const e = new Error("email"); e.code = "app/email"; throw e; }
  if (group.length < 2 || group.length > 60) { const e = new Error("group"); e.code = "app/group"; throw e; }
  if (!sizeText || sizeText.length > 20) { const e = new Error("size"); e.code = "app/size"; throw e; }
  if (whereText.length < 2 || whereText.length > 100) { const e = new Error("where"); e.code = "app/where"; throw e; }
  const { setDoc, serverTimestamp } = fb.mod.store;
  try {
    await withTimeout(setDoc(ref("groupRequests", key), {
      fullName: name, email: address, groupName: group, golfers: sizeText, where: whereText, note: noteText,
      status: "pending", createdAt: serverTimestamp(),
    }), 20000, "Your request");
  } catch (e) {
    const code = String((e && (e.code || e.message)) || "");
    if (code.includes("permission")) { const x = new Error("exists"); x.code = "app/exists"; throw x; }
    throw e;
  }
  return { ok: true };
}

export function watchGroupRequests(callback) {
  const { query, where } = fb.mod.store;
  const stop = listen(query(col("groupRequests"), where("status", "in", ["pending", "approving"])),
    (snap) => callback(snap.docs.map((d) => ({ key: d.id, ...d.data() }))
      .sort((x, y) => ((x.createdAt && x.createdAt.seconds) || 0) - ((y.createdAt && y.createdAt.seconds) || 0))),
    /* beta.4: a refused look for group requests (rules not published yet)
       stays quiet: the section simply shows none, and nothing else is
       affected. It used to raise the red "Firestore refused" bar. */
    (e) => { if (!String((e && (e.code || e.message)) || "").includes("permission")) report(e); callback([]); });
  unsubscribers.push(stop);
  return stop;
}

/* Step 1 of approving: claim the request with the new group's id. A retry
   keeps the same id, so a second group is never made. */
export async function claimGroupRequest(key) {
  const { runTransaction, doc, serverTimestamp } = fb.mod.store;
  const reqRef = doc(fb.db, "groupRequests", key);
  return runTransaction(fb.db, async (tx) => {
    const snap = await tx.get(reqRef);
    if (!snap.exists()) { const e = new Error("gone"); e.code = "app/gone"; throw e; }
    const r = snap.data();
    if (r.status === "approved") return { already: true, groupId: r.groupId, request: r };
    if (r.status === "declined") { const e = new Error("declined"); e.code = "app/declined"; throw e; }
    /* A released claim keeps its group id, so a retry never makes a second group. */
    const groupId = r.groupId || model.newId();
    tx.update(reqRef, { status: "approving", reviewedBy: uid, reviewedAt: serverTimestamp(), groupId });
    return { already: false, groupId, request: r };
  });
}

/* Does this group already exist and belong to me? (A retry after the group
   was made but before the request was marked approved.) */
export async function ownGroupExists(id) {
  const { getDoc } = fb.mod.store;
  try {
    const snap = await getDoc(ref("associations", id));
    return snap.exists() && (snap.data() || {}).ownerUid === uid;
  } catch { return false; }
}

export async function finishGroupRequest(key) {
  await commitTogether([{ op: "update", path: ["groupRequests", key],
    data: { status: "approved", reviewedBy: uid, reviewedAt: { __serverTimestamp: true } } }], "mark the request approved");
}

export async function releaseGroupRequest(key) {
  try {
    await commitTogether([{ op: "update", path: ["groupRequests", key],
      data: { status: "pending", reviewedBy: uid, reviewedAt: { __serverTimestamp: true } } }], "release the request");
  } catch {}
}

export async function declineGroupRequest(key) {
  await commitTogether([{ op: "update", path: ["groupRequests", key],
    data: { status: "declined", reviewedBy: uid, reviewedAt: { __serverTimestamp: true } } }], "decline the request");
}

/* ======================= beta.4: the cockpit ======================= */

/* "Last seen": the member's own app stamps its membership, at most once every
   12 hours per group. Quiet if refused (rules not published yet). */
const LAST_SEEN_EVERY_MS = 12 * 3600 * 1000;
export async function stampLastSeen() {
  if (!fb || !uid || !assocId || !myMember || isAnonymousSession()) return;
  const at = myMember.lastSeenAt && typeof myMember.lastSeenAt.toMillis === "function" ? myMember.lastSeenAt.toMillis() : 0;
  if (Date.now() - at < LAST_SEEN_EVERY_MS) return;
  try {
    await commitTogether([{ op: "update", path: ["associations", assocId, "members", uid],
      data: { lastSeenAt: { __serverTimestamp: true } } }], "note last seen");
    myMember = { ...myMember, lastSeenAt: { toMillis: () => Date.now() } };
  } catch { /* harmless: tried again next time */ }
}

/* beta.5: the Terms of Use acceptance, recorded on the account itself — the
   lasting record (users/{uid}/terms/accepted). Written once per version, then
   it counts only once the server has confirmed the write (a batch commit
   resolves only then), and it is read back to be sure. */
export async function recordTermsAcceptance({ version, appVersion, deviceAcceptedAt }) {
  if (!fb || !uid) return false;
  const { getDoc } = fb.mod.store;
  const target = ref("users", uid, "terms", "accepted");
  const before = await getDoc(target).catch(() => null);
  if (before && before.exists() && Number((before.data() || {}).version) >= version) return true;
  await commitTogether([{ op: "set", path: ["users", uid, "terms", "accepted"],
    data: { version, appVersion: String(appVersion || ""), deviceAcceptedAt: Number(deviceAcceptedAt) || null,
      acceptedAt: { __serverTimestamp: true } } }], "record the Terms of Use");
  const after = await getDoc(target);
  if (!after.exists() || Number((after.data() || {}).version) < version) throw new Error("terms not recorded");
  return true;
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const millisOf = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : (t && t.seconds ? t.seconds * 1000 : (typeof t === "number" ? t : 0)));

/* The owner cockpit's raw material, read when it opens (the group creator
   only): every group, every membership, and the rounds of the last 6 months.
   About as many reads as there are memberships plus recent rounds. */
export async function loadOwnerCockpit() {
  const { getDocs, query, where, collectionGroup } = fb.mod.store;
  const since = new Date(); since.setMonth(since.getMonth() - 6); since.setDate(1);
  const groupsSnap = await getDocs(col("associations"));
  const membersSnap = await getDocs(collectionGroup(fb.db, "members"));
  let rounds = [], roundsError = "";
  try {
    const rs = await getDocs(query(collectionGroup(fb.db, "rounds"), where("date", ">=", isoDay(since))));
    rounds = rs.docs.map((d) => {
      const r = d.data() || {};
      return { assocId: (d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id) || r.assocId || "",
        date: String(r.date || ""), golferId: r.golferId || "", courseName: r.courseName || "" };
    });
  } catch (e) { roundsError = String((e && (e.code || e.message)) || "unavailable"); }
  const groups = groupsSnap.docs.map((d) => ({ id: d.id, name: (d.data() || {}).name || d.id, ownerUid: (d.data() || {}).ownerUid || "" }));
  const members = membersSnap.docs.map((d) => {
    const m = d.data() || {};
    return { assocId: (d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id) || "",
      uid: m.uid || d.id, role: m.role || "member", displayName: m.displayName || "",
      lastSeen: millisOf(m.lastSeenAt), joinedAt: millisOf(m.joinedAt) };
  }).filter((m) => m.assocId);
  return { groups, members, rounds, roundsError, since: isoDay(since), me: uid, loadedAt: Date.now() };
}

/* ======================= beta.4: the applications switch ======================= */

const DEFAULT_SETTINGS = { mode: "manual", dailyLimit: 20 };
export async function readApplicationSettings() {
  if (!fb) return { ...DEFAULT_SETTINGS };
  try {
    const snap = await withTimeout(fb.mod.store.getDoc(ref("settings", "publicApplications")), 6000, "The switch");
    if (!snap.exists()) return { ...DEFAULT_SETTINGS };
    const d = snap.data() || {};
    return { mode: d.mode === "auto" ? "auto" : "manual", dailyLimit: Number.isInteger(d.dailyLimit) ? d.dailyLimit : 20 };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export async function saveApplicationSettings({ mode, dailyLimit }) {
  const limit = Math.max(1, Math.min(500, Math.round(Number(dailyLimit) || 20)));
  await commitTogether([{ op: "set", merge: false, path: ["settings", "publicApplications"],
    data: { mode: mode === "auto" ? "auto" : "manual", dailyLimit: limit, updatedBy: uid, updatedAt: { __serverTimestamp: true } } }],
  "change the applications switch");
  return { mode: mode === "auto" ? "auto" : "manual", dailyLimit: limit };
}

/* Does this email already have an account? (One document, by its id.) Read
   from the server: a signed-out device has nothing cached to trust. */
let lastAccountCheckError = "";
export const accountCheckError = () => lastAccountCheckError;
export async function emailHasAccount(email) {
  if (!fb) return false;
  try {
    const snap = await withTimeout(fb.mod.store.getDoc(ref("accountEmails", emailKey(email))), 10000, "The email check");
    lastAccountCheckError = "";
    return snap.exists();
  } catch (e) { lastAccountCheckError = String((e && (e.code || e.message)) || "unknown"); return false; }
}

/* Every signed-in account records its own email once, so the form can tell an
   applicant "this email already has an account". */
export async function ensureAccountEmail() {
  const user = fb && fb.auth && fb.auth.currentUser;
  if (!user || user.isAnonymous || !user.email) return;
  const key = emailKey(user.email);
  try {
    const snap = await fb.mod.store.getDoc(ref("accountEmails", key));
    if (snap.exists()) return;
    await fb.mod.store.setDoc(ref("accountEmails", key), { at: fb.mod.store.serverTimestamp() });
  } catch { /* tried again at the next sign-in */ }
}

export async function removeAccountEmail() {
  const user = fb && fb.auth && fb.auth.currentUser;
  if (!user || !user.email) return;
  try { await fb.mod.store.deleteDoc(ref("accountEmails", emailKey(user.email))); } catch {}
}

/* Block lists (reviewers). kind: "emails" | "domains" | "names". */
const BLOCK_COLLECTION = { emails: "blockedEmails", domains: "blockedDomains", names: "blockedNames" };
export const blockKey = (kind, value) => {
  const v = String(value || "").trim().toLowerCase();
  if (kind === "names") return model.nameKey(v);
  if (kind === "domains") return v.replace(/^.*@/, "").replace(/^\.+|\.+$/g, "");
  return v;
};
export function watchBlockList(callback) {
  const lists = { emails: [], domains: [], names: [] };
  for (const kind of Object.keys(BLOCK_COLLECTION)) {
    const stop = listen(col(BLOCK_COLLECTION[kind]),
      (snap) => { lists[kind] = snap.docs.map((d) => d.id).sort(); callback({ ...lists }); },
      () => { /* not a reviewer, or rules not published yet: show none */ });
    unsubscribers.push(stop);
  }
}
export async function addBlock(kind, value) {
  const key = blockKey(kind, value);
  if (!BLOCK_COLLECTION[kind] || !key || key.includes("/")) { const e = new Error("bad"); e.code = "app/bad"; throw e; }
  await commitTogether([{ op: "set", merge: false, path: [BLOCK_COLLECTION[kind], key],
    data: { addedBy: uid, addedAt: { __serverTimestamp: true } } }], "add to the block list");
  return key;
}
export async function removeBlock(kind, key) {
  await commitTogether([{ op: "delete", path: [BLOCK_COLLECTION[kind], key] }], "remove from the block list");
}

/* Willy's numbering rule (Oct 1): the first golfer keeps the plain name, the
   next is "Name 1", then "Name 2". Returns the first one that is free. */
export async function nextFreeName(name) {
  const base = String(name || "").trim().replace(/\s+/g, " ");
  const { getDoc } = fb.mod.store;
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base} ${n}`;
    const snap = await getDoc(ref("golferNames", model.nameKey(candidate))).catch(() => null);
    if (!(snap && snap.exists())) return candidate;
  }
  return base;
}

/* The Level 1 name check the app can make before anything is sent (the rules
   make it again): two or more words, plain letters, 4-60 characters. */
export const plainName = (name) => /^[A-Za-z][A-Za-z'-]*( [A-Za-z][A-Za-z'-]*)+$/.test(String(name || "")) && String(name).length >= 4 && String(name).length <= 60;

/* Auto: the sign-in link that confirms the email. Nothing is created until it
   is tapped. */
const APPLY_EMAIL_KEY = "golf:v2:applyEmail";
export async function sendApplicationLink(email) {
  const url = EMULATORS ? `${location.protocol}//${location.host}${location.pathname}?emulators=1&apply=1` : `${platform.joinBase()}?apply=1`;
  await fb.mod.auth.sendSignInLinkToEmail(fb.auth, String(email || "").trim(), { url, handleCodeInApp: true });
  try { localStorage.setItem(APPLY_EMAIL_KEY, String(email || "").trim()); } catch {}
}
export const rememberedApplyEmail = () => { try { return localStorage.getItem(APPLY_EMAIL_KEY) || ""; } catch { return ""; } };
export const isApplyLink = () => {
  try { return !!(fb && fb.mod.auth.isSignInWithEmailLink(fb.auth, platform.signInLinkUrl())); } catch { return false; }
};

/* The applicant tapped the link: sign in with it (this creates the account,
   with the email confirmed), then set their chosen password. */
export async function finishApplyLink({ email, password }) {
  const address = String(email || "").trim();
  const cred = await fb.mod.auth.signInWithEmailLink(fb.auth, address, platform.signInLinkUrl());
  /* The link is spent now. If the password cannot be set, carry on (they are
     signed in) and say so: Forgot the password sets one later. */
  let passwordFailed = false;
  try { await fb.mod.auth.updatePassword(cred.user, password); } catch { passwordFailed = true; }
  try { localStorage.removeItem(APPLY_EMAIL_KEY); } catch {}
  try { history.replaceState(null, "", EMULATORS ? `${location.pathname}?emulators=1` : location.pathname); } catch {}
  platform.clearLinkQuery();
  await refreshToken();
  await ensureAccountEmail();
  return { ok: true, passwordFailed };
}

/* Auto: join the public group by yourself. Every Level 1 check is made again
   by the rules; if any fails, nothing is written and the application simply
   waits for a reviewer. Returns { joined } or { waiting, reason }. */
export async function autoJoinPublic() {
  const user = fb && fb.auth && fb.auth.currentUser;
  if (!user || !user.email || !user.emailVerified) return { waiting: true, reason: "email" };
  const { getDoc } = fb.mod.store;
  const key = emailKey(user.email);
  /* Already in (an earlier try stopped part-way): just finish. */
  const already = await getDoc(ref("associations", PUBLIC_ID, "members", uid)).catch(() => null);
  if (already && already.exists()) { await finishPublicJoin(); return { joined: true, already: true }; }
  const settings = await readApplicationSettings();
  if (settings.mode !== "auto") return { waiting: true, reason: "manual" };
  let app;
  try {
    const snap = await getDoc(ref("publicApplications", key));
    if (!snap.exists()) return { waiting: true, reason: "none" };
    app = snap.data() || {};
  } catch { return { waiting: true, reason: "unreadable" }; }
  if (app.status !== "pending") return { waiting: true, reason: app.status || "unknown" };
  if (!plainName(app.fullName)) return { waiting: true, reason: "name" };
  const nk = model.nameKey(app.fullName);
  const taken = await getDoc(ref("golferNames", nk)).catch(() => null);
  if (taken && taken.exists()) return { waiting: true, reason: "name-taken" };
  const day = String(Math.floor(Date.now() / 86400000));
  const counter = await getDoc(ref("autoApprovals", day)).catch(() => null);
  const count = counter && counter.exists() ? Number((counter.data() || {}).count) || 0 : 0;
  if (count + 1 > settings.dailyLimit) return { waiting: true, reason: "limit" };
  const golfer = model.buildGolfer({ name: app.fullName, linkedUid: uid });
  try {
    await commitTogether([
      { op: "set", merge: false, path: ["golfers", golfer.id], data: { ...golfer, linkedUid: uid, groups: [PUBLIC_ID] } },
      { op: "set", merge: false, path: ["golferNames", nk], data: { golferId: golfer.id, name: golfer.name } },
      { op: "set", merge: false, path: ["autoApprovals", day], data: { count: count + 1, lastBy: uid, lastAt: { __serverTimestamp: true } } },
      { op: "set", merge: false, path: ["publicApprovals", key],
        data: { golferId: golfer.id, displayName: golfer.name, nameKey: nk, approvedBy: uid, approvedAt: { __serverTimestamp: true }, auto: true } },
    ], "approve automatically");
  } catch { return { waiting: true, reason: "refused" }; }
  await joinPublicIfApproved();
  await finishPublicJoin();
  return { joined: true };
}

/* After joining by an automatic approval: the roster and directory entries,
   and the application marked approved. Safe to run again. */
export async function finishPublicJoin() {
  const user = fb && fb.auth && fb.auth.currentUser;
  if (!user || !user.email || !user.emailVerified) return;
  const { getDoc } = fb.mod.store;
  const key = emailKey(user.email);
  const member = await getDoc(ref("associations", PUBLIC_ID, "members", uid)).catch(() => null);
  if (!(member && member.exists())) return;
  const golferId = (member.data() || {}).golferId;
  if (!golferId) return;
  const app = await getDoc(ref("publicApplications", key)).catch(() => null);
  if (!(app && app.exists()) || (app.data() || {}).status !== "pending") return;
  const name = (app.data() || {}).fullName || "";
  await commitTogether([
    { op: "set", path: ["associations", PUBLIC_ID, "roster", golferId], data: { golferId, addedAt: Date.now() } },
  ], "add yourself to the public roster");
  await commitTogether([
    { op: "set", merge: false, path: ["associations", PUBLIC_ID, "directory", golferId],
      data: { golferId, displayName: name, handicapIndex: null } },
    { op: "update", path: ["publicApplications", key],
      data: { status: "approved", golferId, golferName: name, reviewedAt: { __serverTimestamp: true }, auto: true } },
  ], "finish joining the public group");
}

/* 24 random characters: the new account's first password, which nobody ever
   sees. The person chooses their own from the approval email. */
function randomPassword() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 56]).join("");
}

/* Approving (R2), go-live fix 2: safe to retry, and two reviewers can never
   approve the same application.
   1. CLAIM, in a transaction: the application goes from pending to approving,
      holding this reviewer's id, the golfer id and the golfer name. A retry by
      the same reviewer keeps the same golfer id. Another reviewer is refused
      (by this code and by the rules) unless the claim is 10 minutes old.
   2. The name must be free (names are unique across the whole database); if
      it is taken, the claim is released so the name can be changed.
   3. The ACCOUNT, through a separate Firebase instance so the reviewer stays
      signed in. An existing account is left as it is (that is also what a
      retry finds).
   4. ONE BATCH, all or nothing: the golfer, the name claim, the PUBLIC roster
      and directory entries, the approval, and the application approved. The
      rules accept the approval only under this reviewer's claim.
   5. Firebase's own password email, the invitation. If only this fails, the
      approval stands and the email can be sent again from the Admin tab.
   Returns { ok, existingAccount, golferId, emailFailed, already }. */
const STALE_CLAIM_MS = 10 * 60 * 1000;
export async function approveApplication({ application, golferName }) {
  const { getDoc, runTransaction, doc, serverTimestamp } = fb.mod.store;
  const name = String(golferName || "").trim().replace(/\s+/g, " ");
  const key = model.nameKey(name);
  if (!key) { const e = new Error("name"); e.code = "app/name"; throw e; }
  const appRef = doc(fb.db, "publicApplications", application.key);

  /* 1. Claim. If two reviewers claim at the same moment, the rules refuse
     the second; that refusal is reported as "busy" or "already approved",
     whichever is now true. */
  const claimed = await runTransaction(fb.db, async (tx) => {
    const snap = await tx.get(appRef);
    if (!snap.exists()) { const e = new Error("gone"); e.code = "app/gone"; throw e; }
    const a = snap.data();
    if (a.status === "approved") return { already: true, golferId: a.golferId };
    if (a.status === "rejected") { const e = new Error("rejected"); e.code = "app/rejected"; throw e; }
    let golferId = model.newId();
    if (a.status === "approving") {
      const at = a.approvingAt && a.approvingAt.toMillis ? a.approvingAt.toMillis() : 0;
      const mine = a.reviewedBy === uid;
      if (!mine && Date.now() - at < STALE_CLAIM_MS) { const e = new Error("busy"); e.code = "app/busy"; throw e; }
      if (mine && a.golferId) golferId = a.golferId;   /* a retry: same golfer */
    }
    tx.update(appRef, { status: "approving", reviewedBy: uid, approvingAt: serverTimestamp(), golferId, golferName: name });
    return { already: false, golferId };
  }).catch(async (e) => {
    if (String((e && e.code) || "").startsWith("app/")) throw e;
    const now = await getDoc(appRef).catch(() => null);
    const a = now && now.exists() ? now.data() : null;
    if (a && a.status === "approved") return { already: true, golferId: a.golferId };
    if (a && a.status === "approving" && a.reviewedBy !== uid) { const b = new Error("busy"); b.code = "app/busy"; throw b; }
    throw e;
  });
  if (claimed.already) return { ok: true, already: true, golferId: claimed.golferId };
  const golferId = claimed.golferId;
  const release = async () => {
    try { await commitTogether([{ op: "update", path: ["publicApplications", application.key], data: { status: "pending", reviewedBy: uid } }], "release the approval"); } catch {}
  };

  /* 2. The name. */
  const nameClaim = await getDoc(ref("golferNames", key));
  if (nameClaim.exists() && (nameClaim.data() || {}).golferId !== golferId) {
    await release();
    const e = new Error("name taken"); e.code = "app/name-taken"; throw e;
  }

  /* 3. The account. */
  let existingAccount = false;
  const second = fb.mod.app.initializeApp(fb.config, `approver-${Date.now()}`);
  try {
    const secondAuth = fb.mod.auth.initializeAuth(second, { persistence: fb.mod.auth.inMemoryPersistence });
    if (EMULATORS) fb.mod.auth.connectAuthEmulator(secondAuth, AUTH_EMULATOR, { disableWarnings: true });
    try {
      await fb.mod.auth.createUserWithEmailAndPassword(secondAuth, application.email, randomPassword());
    } catch (e) {
      const code = String((e && (e.code || e.message)) || "");
      if (!code.includes("email-already-in-use")) throw e;   /* the claim stays: tap Approve again */
      existingAccount = true;
    }
    try { await fb.mod.auth.signOut(secondAuth); } catch {}
  } finally {
    try { await fb.mod.app.deleteApp(second); } catch {}
  }

  /* 4. Everything else, together. */
  const golfer = model.buildGolfer({ name, id: golferId });
  try {
    await commitTogether([
      { op: "set", merge: false, path: ["golfers", golferId], data: { ...golfer, groups: [PUBLIC_ID] } },
      { op: "set", merge: false, path: ["golferNames", key], data: { golferId, name: golfer.name } },
      { op: "set", path: ["associations", PUBLIC_ID, "roster", golferId], data: { golferId, addedAt: Date.now() } },
      { op: "set", merge: false, path: ["associations", PUBLIC_ID, "directory", golferId],
        data: { golferId, displayName: golfer.name, handicapIndex: null } },
      { op: "set", merge: false, path: ["publicApprovals", application.key],
        data: { golferId, displayName: golfer.name, approvedBy: uid, approvedAt: { __serverTimestamp: true } } },
      { op: "update", path: ["publicApplications", application.key],
        data: { status: "approved", reviewedBy: uid, reviewedAt: { __serverTimestamp: true } } },
    ], "approve an application");
  } catch (e) {
    /* Nothing of the batch landed. If the application was approved meanwhile
       (a retry that already finished), that is success. */
    const now = await getDoc(appRef).catch(() => null);
    if (now && now.exists() && now.data().status === "approved") return { ok: true, already: true, golferId };
    throw e;   /* the claim stays: tap Approve again to retry */
  }

  /* 5. The email. */
  let emailFailed = false;
  try { await fb.mod.auth.sendPasswordResetEmail(fb.auth, application.email); }
  catch { emailFailed = true; }
  return { ok: true, existingAccount, golferId, emailFailed };
}

/* Approved, not joined yet (their approval is still waiting for them). */
export function watchApprovals(callback) {
  const stop = listen(col("publicApprovals"),
    (snap) => callback(snap.docs.map((d) => ({ key: d.id, ...d.data() }))), (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

/* The password email again, for an approved applicant. */
export async function resendApprovalEmail(email) {
  await fb.mod.auth.sendPasswordResetEmail(fb.auth, String(email || "").trim());
}

export async function rejectApplication(application) {
  await commitTogether([
    { op: "update", path: ["publicApplications", application.key],
      data: { status: "rejected", reviewedBy: uid, reviewedAt: { __serverTimestamp: true } } },
  ], "reject an application");
}

/* ---- reports and blocks (Apple guideline 1.2) ---- */

export async function reportGolfer({ golferId, displayName, reason }) {
  const { setDoc, serverTimestamp, doc, collection } = fb.mod.store;
  const target = doc(collection(fb.db, "associations", assocId, "reports"));
  await withTimeout(setDoc(target, {
    golferId, displayName: String(displayName || "").slice(0, 120),
    reason: String(reason || "").trim().slice(0, 500), reportedBy: uid, createdAt: serverTimestamp(),
  }), 20000, "Your report");
}

export function watchReports(callback) {
  const stop = listen(col("associations", assocId, "reports"),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}

export async function dismissReport(reportId) {
  await commitTogether([{ op: "delete", path: ["associations", assocId, "reports", reportId] }], "dismiss a report");
}

export function watchBlocks(callback) {
  if (!uid) return () => {};
  const stop = listen(col("userBlocks", uid, "golfers"),
    (snap) => callback(snap.docs.map((d) => ({ golferId: d.id, ...d.data() }))), (e) => report(e));
  unsubscribers.push(stop);
  return stop;
}
export async function blockGolfer({ golferId, name }) {
  await commitTogether([{ op: "set", merge: false, path: ["userBlocks", uid, "golfers", golferId],
    data: { name: String(name || "").slice(0, 120), blockedAt: { __serverTimestamp: true } } }], "block a golfer");
}
export async function unblockGolfer(golferId) {
  await commitTogether([{ op: "delete", path: ["userBlocks", uid, "golfers", golferId] }], "unblock a golfer");
}

/* Creating an account. Only ever from an invitation, a group code, or
   (Phase C) an approved application — never as a side effect of a typo on
   the sign-in screen. */
export async function createAccount({ email, password }) {
  if (!fb) throw new Error("Firebase has not loaded yet.");
  const address = String(email || "").trim();
  const secret = String(password || "");
  if (!address) throw new Error("auth/invalid-email");
  if (secret.length < 6) throw new Error("auth/weak-password");
  if (fb.auth.currentUser) throw new Error("auth/already-signed-in");
  try {
    await fb.mod.auth.createUserWithEmailAndPassword(fb.auth, address, secret);
  } catch (e) {
    const code = String((e && (e.code || e.message)) || "");
    if (code.includes("email-already-in-use")) {
      const taken = new Error("auth/email-already-in-use");
      taken.code = "auth/email-already-in-use";
      throw taken;
    }
    throw e;
  }
  uid = fb.auth.currentUser.uid;
  clearError();
  setStatus("Connected");
  emit();
  return { ok: true, outcome: "created" };
}

export async function signOutEverywhere() {
  /* Live listeners must go first. Left running, they keep firing against
     collections this account can no longer read, which produces permission
     errors on the way out and a half-empty screen on the way back in. */
  stopWatching();
  clearJoinLink();

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
    noteRead(snap, snap.exists());
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
    noteRead(snap, snap.exists());
    if (!snap.exists()) return null;
    const group = { ...snap.data(), id: snap.id };
    /* Filled here as well as in the watcher, so an invitation can be built
       before any snapshot has arrived. */
    if (id === assocId) cachedAssociation = group;
    return group;
  } catch { return null; }
}

export function watchMembers(callback) {
  /* Phase C: only admins may list the members; everybody else reads their
     own membership. */
  if (!canManage()) {
    const stop = listen(ref("associations", assocId, "members", uid),
      (snap) => callback(snap.exists() ? [{ uid: snap.id, ...snap.data() }] : []), (e) => report(e));
    unsubscribers.push(stop);
    return stop;
  }
  const stop = listen(col("associations", assocId, "members"),
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
  `${platform.joinBase()}?join=${association.id}.${association.joinCode}`;

/* An invitation for a specific role.
 *
 * The link carries whichever secret matches the role, so the rules can VERIFY
 * the role rather than trust a label. An admin link holds a different code
 * entirely, which is why a guest cannot edit their own link into an admin one. */
/* Records that an invitation was sent, so the People list can show who is still
   outstanding. Written on the golfer — only the MOST RECENT invitation matters,
   and a list of old ones was impossible to read. */
export function noteInvitation(golferId, role, golfer = null) {
  if (!golferId) return;
  outbox.enqueue({
    type: "update",
    path: ["golfers", golferId],
    data: { invitedAt: Date.now(), invitedAs: role === "admin" ? "admin" : "member",
            editedIn: assocId },
    opId: `golfer-invited-${golferId}`,
  });
  /* Go-live fix 1: what the invitee sees before joining — their name, index
     and the group's name — lives on the invitation record, readable by its id
     alone. The golfer record itself stays private. */
  if (golfer && golfer.name) {
    const index = model.effectiveIndex(golfer).index;
    outbox.enqueue({
      type: "set",
      path: ["associations", assocId, "invitations", golferId],
      data: { golferId, name: String(golfer.name).slice(0, 120), handicapIndex: index == null ? null : index,
              groupName: String((cachedAssociation && cachedAssociation.name) || "").slice(0, 120),
              role: role === "admin" ? "admin" : "member", sentBy: uid, sentAt: { __serverTimestamp: true } },
      opId: `invitation-${assocId}-${golferId}`,
    });
  }
  flush();
}

/* beta.10: independent, one-use invitation secrets. No email is collected.
   The slot pointer replaces any previously sent link for this golfer/role.
   Publishing the link waits for Firebase: an offline queue is not permission. */
export async function inviteLink(role = "member", golferId = null) {
  const group = currentAssociationDoc();
  if (!group || group.id === PUBLIC_ID || !fb || !uid) return "";
  if (role === "admin" && !isOwner()) throw new Error("Only the owner invites admins.");
  if (!canManage()) throw new Error("Only group admins send invitations.");
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  const slot = golferId || `open-${role}`;
  let golfer = null;
  if (golferId) golfer = await getDoc_(golferId);
  const name = golfer ? String(golfer.name || "").slice(0, 120) : "";
  const index = golfer ? model.effectiveIndex(golfer).index : null;
  await commitTogether([
    { op: "set", merge: false, path: ["associations", group.id, "invitationTokens", token],
      data: { slot, golferId: golferId || null, role, name, handicapIndex: index == null ? null : index,
        groupName: String(group.name || "").slice(0, 120), state: "pending", sentAt: { __serverTimestamp: true } } },
    { op: "set", merge: false, path: ["associations", group.id, "invitationSlots", slot], data: { token } },
  ], "prepare one-time invitation");
  return `${platform.joinBase()}?join=${group.id}.${token}${golferId ? `.${golferId}` : ""}${role === "admin" ? "&as=admin" : ""}&v=2`;
}

/* A token is deliberately unreadable by list to invitees; only its random
   address grants a single read. Membership and role still come from rules. */
let loadedInvitation = null;
export async function loadInvitation(link) {
  if (!link || !link.token || !fb || !uid) return null;
  const { getDocFromServer } = fb.mod.store;
  let snap;
  try { snap = await getDocFromServer(ref("associations", link.associationId, "invitationTokens", link.token)); }
  catch (e) { if (String(e.code || "").includes("permission")) return null; throw e; }
  if (!snap.exists()) return null;
  const d = snap.data();
  // Slot reads are admin-only. The slot is checked by security rules at acceptance.
  if (d.state !== "pending") return null;
  loadedInvitation = { ...d, associationId: link.associationId, token: link.token };
  return loadedInvitation;
}

/* The entire join is atomic. A race, interrupted request, or refused golfer
   link leaves no partial membership and does not spend the invitation. */
export async function acceptTokenInvite({ associationId, token, displayName = "" }) {
  if (!fb || !uid || isAnonymousSession()) throw new Error("Sign in first.");
  const { runTransaction, doc, serverTimestamp } = fb.mod.store;
  const db = fb.db;
  const tokenRef = doc(db, "associations", associationId, "invitationTokens", token);
  const memberRef = doc(db, "associations", associationId, "members", uid);
  let result;
  await runTransaction(db, async tx => {
    const inv = await tx.get(tokenRef);
    if (!inv.exists() || inv.data().state !== "pending") { const e = new Error("This invitation was used or cancelled. Ask for a fresh link."); e.code = "join/used"; throw e; }
    const d = inv.data();
    const member = await tx.get(memberRef);
    const old = member.exists() ? member.data() : null;
    if (old && old.golferId && old.golferId !== d.golferId) { const e = new Error("You already play in this group as another golfer."); e.code = "join/other-golfer"; throw e; }
    const name = d.name || displayName.trim();
    if (!name) throw new Error("Type your name.");
    const role = old ? old.role : d.role;
    if (old) tx.update(memberRef, { invitationToken: token, ...(d.golferId ? { golferId: d.golferId } : {}) });
    else tx.set(memberRef, { uid, displayName: name, role, golferId: d.golferId, invitationToken: token, joinedAt: serverTimestamp() });
    tx.update(tokenRef, { state: "used", usedAt: serverTimestamp() }); // no accepted account id retained
    tx.set(doc(db, "userGroups", uid, "groups", associationId), { assocId: associationId, name: d.groupName || "Group", at: Date.now() });
    if (d.golferId) {
      tx.update(doc(db, "golfers", d.golferId), { linkedUid: uid, claimedIn: associationId, claimedToken: token });
      tx.set(doc(db, "associations", associationId, "roster", d.golferId), { golferId: d.golferId, addedAt: Date.now() });
    }
    result = { ok: true, role, already: !!old, name: d.groupName || "Group", golferId: d.golferId };
  });
  assocId = associationId;
  rememberAssociation(associationId);
  rememberGroup(associationId, result.name);
  clearError();
  return result;
}

/* The admin invitation secret (Phase D). The owner only — the rules let
   nobody else read it. Kept in associations/{id}/secrets/admin. A group whose
   secret is still on the group document (made before Phase D) has it moved
   there now: saved in its new place first, then removed from the old one, so
   an admin invitation already sent keeps working. A group with none gets one. */
let adminCodeCache = "";
let adminCodeFor = "";
export async function ensureAdminCode() {
  const group = currentAssociationDoc();
  if (!group || !isOwner()) return "";
  if (adminCodeFor === group.id && adminCodeCache) return adminCodeCache;
  const { getDoc } = fb.mod.store;
  const snap = await getDoc(ref("associations", group.id, "secrets", "admin"));
  let code = snap.exists() ? (snap.data() || {}).adminCode || "" : "";
  if (!code) {
    code = group.adminCode || model.newJoinCode();
    await commitTogether([
      { op: "set", merge: false, path: ["associations", group.id, "secrets", "admin"], data: { adminCode: code } },
    ], "save the admin code");
  }
  if (group.adminCode) {
    await commitTogether([
      { op: "update", path: ["associations", group.id], data: { adminCode: null } },
    ], "move the admin code");
    cachedAssociation = { ...group, adminCode: null };
  }
  adminCodeCache = code;
  adminCodeFor = group.id;
  return code;
}

/* Phase D: whether this account may create groups (Willy's). Read from the
   list the setup script keeps; the rules refuse anybody else anyway. */
let groupCreatorFlag = false;
export const canCreateGroups = () => groupCreatorFlag;
export async function loadGroupCreator() {
  groupCreatorFlag = false;
  if (!fb || !uid || isAnonymousSession()) return false;
  try {
    const snap = await fb.mod.store.getDoc(ref("groupCreators", uid));
    groupCreatorFlag = snap.exists();
  } catch { groupCreatorFlag = false; }
  return groupCreatorFlag;
}

export function readJoinLink() {
  try {
    const value = new URLSearchParams(platform.linkQuery()).get("join");
    if (!value) return null;

    /* group.code            — an open invitation, they type their name
       group.code.golferId   — a named one, for a specific person on the roster */
    const parts = value.split(".");
    if (parts.length < 2) return null;
    const params = new URLSearchParams(platform.linkQuery());
    return {
      associationId: parts[0],
      code: params.get("v") === "2" ? "" : parts[1],
      token: params.get("v") === "2" ? parts[1] : null,
      golferId: params.get("v") === "2" && loadedInvitation && loadedInvitation.token === parts[1]
        ? loadedInvitation.golferId : parts.length > 2 ? parts.slice(2).join(".") : null,
      /* Verified against the group by the rules, never trusted on its own. */
      role: params.get("v") === "2" && loadedInvitation && loadedInvitation.token === parts[1]
        ? loadedInvitation.role : params.get("as") === "admin" ? "admin" : "member",
    };
  } catch { return null; }
}

/* The golfer a named invitation points at, read straight from the database so
   the screen shows their real name rather than one carried in the link — a URL
   can be edited, a document cannot. */
/* Go-live fix 1: the greeting comes from the invitation record written when
   the invitation was sent (name, index, group name), never from the golfer
   record, which is private. Returns { id, name, handicapIndex, groupName }. */
export async function invitationFor(associationId, golferId) {
  if (!fb || !associationId || !golferId) return null;
  try {
    const { getDoc } = fb.mod.store;
    const snap = await getDoc(ref("associations", associationId, "invitations", golferId));
    noteRead(snap, snap.exists());
    if (!snap.exists()) return null;
    const d = snap.data() || {};
    return { id: golferId, name: d.name || "", handicapIndex: d.handicapIndex == null ? null : Number(d.handicapIndex), groupName: d.groupName || "" };
  } catch (e) {
    const code = String((e && (e.code || e.message)) || "");
    if (!code.includes("permission")) cacheMiss = true;
    return null;
  }
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

  /* beta.9 (Willy, Oct 2): ALREADY A MEMBER of this group? Then the
     membership is left exactly as it is (role included) and only the rest is
     written. Writing it again was refused by the rules — a membership is
     created once, never overwritten — and that refusal was reported as "the
     rules are older than this version". It happens whenever somebody comes
     back through an invitation: a second device, a deletion that never
     finished, an admin who sends the link again. */
  const existing = await loadMembership(associationId);
  if (existing && existing.golferId && existing.golferId !== golferId) {
    return { ok: false, reason: "OTHER_GOLFER" };
  }

  const member = model.buildMember({
    uid,
    displayName: (await invitationFor(associationId, golferId) || {}).name || "",
    role: role === "admin" ? "admin" : "member",
    joinCode: code,
  });

  /* Not readable by somebody who has not joined yet, so this is expected to
     come back null on an invitation. The group's real name arrives from the
     watcher the moment membership exists. */
  const group = await loadAssociation(associationId);
  const name = group ? group.name : "Group";

  /* TWO STEPS, and the order matters — the same rule that broke group
     creation. The roster rule asks "is this account a member?", and inside a
     single batch the answer is still no, because the membership is in that
     same batch and Firestore evaluates every write against the state BEFORE
     it. So the membership is written first and allowed to land, and only then
     does everything that depends on it go together. */
  const { setDoc } = fb.mod.store;
  /* Each refusal names its step, so the screen can say what to do. */
  const refused = (e, step) => {
    const raw = String((e && (e.code || e.message)) || "");
    if (!raw.includes("permission")) return e;
    const err = new Error(`join/${step}-refused`);
    err.code = `join/${step}-refused`;
    return err;
  };

  if (!existing) {
    try {
      await setDoc(ref("associations", associationId, "members", uid), {
        ...member,
        golferId,
        joinedAt: serverTimestampValue(),
      });
    } catch (e) { throw refused(e, "membership"); }
  }

  try {
    await commitTogether([
    {
      op: "set",
      path: ["associations", associationId, "invites", golferId],
      /* An admin claim is spent; somebody already in the group keeps the role
         they have, so their claim is an ordinary one. */
      data: { acceptedBy: uid, role: existing ? "member" : role, at: Date.now() },
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
    throw refused(e, "link");
  }

  assocId = associationId;
  rememberAssociation(associationId);
  rememberGroup(associationId, name);
  clearError();
  return { ok: true, role: existing ? existing.role : role, already: !!existing };
}

/* Called only AFTER the join has succeeded — it strips the whole query string,
   including the role, so anything that still needs it must read it first. */
export const clearJoinLink = () => {
  loadedInvitation = null;
  try { history.replaceState(null, "", location.pathname); } catch {}
  platform.clearLinkQuery();
};

/* ---------------- games ---------------- */

export function watchGames(callback, { max = 200 } = {}) {
  const { query, orderBy, limit, where } = fb.mod.store;
  const generation = watchGeneration;
  if (canManage()) {
    const stop = listen(
      query(col("associations", assocId, "games"), orderBy("date", "desc"), limit(max)),
      (snap) => callback(snap.docs.map((d) => d.data())), (e) => report(e));
    unsubscribers.push(stop);
    return stop;
  }
  /* A regular member sees only games they played in, or created (Phase A).
     Two queries, merged; each is one the rules can prove. */
  const played = new Map(), created = new Map();
  const emit = () => callback([...new Map([...created, ...played]).values()]
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))));
  const stops = [];
  stops.push(listen(query(col("associations", assocId, "games"), where("createdBy", "==", uid), limit(max)),
    (snap) => { created.clear(); snap.docs.forEach((d) => created.set(d.id, d.data())); emit(); }, (e) => report(e)));
  findMyGolfer().then((g) => {
    if (generation !== watchGeneration || !g) { emit(); return; }
    stops.push(listen(query(col("associations", assocId, "games"), where("participantGolferIds", "array-contains", g.id), limit(max)),
      (snap) => { played.clear(); snap.docs.forEach((d) => played.set(d.id, d.data())); emit(); }, (e) => report(e)));
  });
  const stop = () => { while (stops.length) { try { stops.pop()(); } catch {} } };
  unsubscribers.push(stop);
  return stop;
}

/* Publishes a game's shared result sheet on the game itself (Phase A): who
   played and the scores needed for the leaderboard, never anybody's round
   history. Written by an owner or admin whenever they look at or change the
   game. participantGolferIds is what lets each player read it. */
export async function publishGameResults(gameId, results) {
  if (!fb || !assocId || !canManage() || !gameId) return false;
  const participantGolferIds = [...new Set((results || []).map((r) => r.golferId).filter(Boolean))].sort();
  const sheet = (results || []).map((r) => ({
    id: String(r.id || ""), golferId: r.golferId || "", name: r.name || "", date: r.date || "",
    gross: r.gross ?? null, adjusted: r.adjusted ?? null, courseHandicap: r.courseHandicap ?? null,
    teeName: r.teeName || "", estimated: !!r.estimated,
  }));
  try {
    await fb.mod.store.updateDoc(ref("associations", assocId, "games", gameId), { participantGolferIds, results: sheet });
    return true;
  } catch { return false; }
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
    /* editedIn is what lets the rules confirm this rename is legitimate —
       see the golfers block in firestore.rules. */
    { op: "set", path: ["golfers", golferId], data: { name: tidy, nameKey: key, editedIn: assocId } },
    { op: "set", path: ["golferNames", key], data: { golferId, name: tidy } },
  ];
  if (beforeKey) writes.push({ op: "delete", path: ["golferNames", beforeKey] });

  await commitTogether(writes, "rename golfer");
  return { ok: true };
}



/* The group document carries settings everybody needs — the course lookup key
   among them. Watched rather than read once, so changing the key reaches every
   device without anybody reloading. */
export function watchAssociation(callback) {
  const { onSnapshot } = fb.mod.store;
  const stop = listen(ref("associations", assocId),
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
      data: { linkedUid: uid, claimedIn: assocId },
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
/* Finds every group this account is a member of, by searching the memberships
 * themselves rather than the pointer list.
 *
 * The pointer at /userGroups/{uid}/groups is a convenience, and it can go
 * missing — it did, for somebody promoted to admin, who then signed in and was
 * told they belonged to nowhere and offered to CREATE a group. That would have
 * produced a second empty group and split the data.
 *
 * The membership document is the truth. This asks for it directly. */
/* Why the last search for groups came up empty, if it FAILED rather than
   genuinely finding none. Declared before use — a `let` assigned above its
   declaration throws, which would have replaced one silent failure with a
   louder one. */
let lastGroupLookupError = "";
export const groupLookupError = () => lastGroupLookupError;

export async function groupsFromMemberships() {
  if (!fb || !uid) return [];
  try {
    const { collectionGroup, query, where, getDocs, getDoc } = fb.mod.store;
    const found = await getDocs(query(
      collectionGroup(fb.db, "members"),
      where("uid", "==", uid)
    ));
    noteRead(found, !found.empty);

    const groups = [];
    for (const d of found.docs) {
      /* .../associations/{assocId}/members/{uid} — the group is the grandparent. */
      const assoc = d.ref.parent && d.ref.parent.parent;
      if (!assoc) continue;
      let name = "Group";
      try {
        const snap = await getDoc(assoc);
        if (snap.exists()) name = (snap.data() || {}).name || "Group";
      } catch { /* unreadable, but the membership proves it is theirs */ }
      groups.push({ id: assoc.id, name });
    }
    return groups;
  } catch (e) {
    /* A collection-group query with a filter needs an index that Firestore does
       NOT create on its own, and the failure was being swallowed — which left
       somebody stuck on a screen offering only to create a second group.
       Report it instead: the error carries a link that creates the index. */
    lastGroupLookupError = String((e && (e.message || e.code)) || e);
    return [];
  }
}


export async function loadMyGroups() {
  if (!fb || !uid) return knownGroups();
  try {
    const { getDocs, getDoc } = fb.mod.store;
    const snap = await getDocs(col("userGroups", uid, "groups"));
    noteRead(snap, !snap.empty);
    if (snap.metadata && snap.metadata.fromCache && snap.empty) return knownGroups();   /* unknown while offline */
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
    /* No pointers at all? Ask the memberships directly before concluding this
       account belongs nowhere. A missing pointer is a bookkeeping failure, not
       evidence — and concluding "no groups" is what offered somebody the
       create-a-group screen and nearly split their data. */
    if (!alive.length) {
      const real = await groupsFromMemberships();
      if (real.length) {
        /* Heal the pointers so this is a one-off rather than every sign-in. */
        for (const group of real) {
          try {
            outbox.enqueue({
              type: "set",
              path: ["userGroups", uid, "groups", group.id],
              data: { assocId: group.id, name: group.name, at: Date.now() },
              opId: `repoint-${uid}-${group.id}`,
            });
          } catch {}
        }
        flush();
        try { localStorage.setItem(GROUPS_KEY, JSON.stringify(real)); } catch {}
        return real;
      }
    }

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
    noteRead(snap, snap.exists());
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

/* Lets an invitation be used again.
 *
 * Signing out of an anonymous account destroys it — there is no password to
 * come back with. If that happens to somebody who joined by a single-use admin
 * link, the claim still names their old account and the link is spent, so they
 * are locked out with no way back. This clears the claim and unlinks the
 * golfer, so a fresh invitation works.
 *
 * Owner only, because it is the ability to re-open somebody else's invitation. */
export async function resetInvitation(golferId) {
  if (!isOwner()) throw new Error("Only the owner can reset an invitation.");

  /* editedIn is REQUIRED here. Clearing linkedUid is a write to a golfer the
     owner is not linked to, so the rules need the group named in order to
     confirm the owner administers a group that golfer plays in. Without it
     Firebase refuses the write and the button appears to do nothing. */
  const writes = [
    { op: "delete", path: ["associations", assocId, "invites", golferId] },
    { op: "update", path: ["golfers", golferId], data: { linkedUid: null, editedIn: assocId } },
  ];
  await commitTogether(writes, "reset invitation");
  return { ok: true };
}

/* A starting handicap for somebody with no rounds here yet. Passing null
   clears it. Real rounds always take precedence once there are three. */
/* Removes superseded membership records — the extra accounts created when one
   person joins from several browsers.
 *
 * A membership is only a sign-in record. Rounds belong to the GOLFER, and the
 * golfer document is untouched, so this loses nothing at all. Owner only, and
 * the rules refuse the owner's own membership regardless. */
/* ---------------- Delete my account (spec Change 7, D5) ----------------
 *
 * The person's sign-in and their links to groups are removed. Their golfer,
 * rounds and handicap stay with the group (D1), exactly as the owner's Remove
 * does today.
 *
 * Order, and why: nothing is deleted before the sign-in has been re-confirmed
 * (step 5) and the request is recorded on the server (step 4).
 *
 * beta.9 (Willy, Oct 2): once the request is recorded, the person is ALWAYS
 * signed out at the end — finished or not. A deletion that stopped part-way
 * used to leave them signed in, with "Later", still an admin; that was wrong.
 * Now whatever is left is finished by the completion job (every 15 minutes),
 * the rules lock the account meanwhile (firestore.rules, deleting()), and
 * signing in to it is refused with a plain message (checkPendingDeletion).
 */

const DELETING_KEY = "golf:v2:deleting";
const THROWAWAY_DOMAIN = "accounts.cuberoot-systems.com";

const deletionNote = () => { try { return JSON.parse(localStorage.getItem(DELETING_KEY) || "null"); } catch { return null; } };
const saveDeletionNote = (note) => { localStorage.setItem(DELETING_KEY, JSON.stringify(note)); };   /* throws if storage refuses: that stops the flow */
const clearDeletionNote = () => { try { localStorage.removeItem(DELETING_KEY); } catch {} };

/* 32 random characters for the throwaway password of an anonymous account.
   Always contains upper, lower, digit and symbol, so any password policy on
   the project accepts it. */
function throwawayPassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "-_.~!"];
  const all = sets.join("");
  const bytes = new Uint32Array(32);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b, i) => (i < sets.length ? sets[i][b % sets[i].length] : all[b % all.length]));
  return chars.join("");
}

/* Waits for a server-confirmed write, but never forever. */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} could not be confirmed. Check the connection.`)), ms)),
  ]);
}

/* Groups this account owns, read from the server. Throws on a failed read. */
async function ownedGroupIds() {
  if (EMULATORS && globalThis.__scorecardGroupCheckError) {
    const code = globalThis.__scorecardGroupCheckError;
    const error = new Error(`Simulated group check failure: ${code}`); error.code = code; throw error;
  }
  const { collection, query, where, getDocsFromServer } = fb.mod.store;
  const snap = await getDocsFromServer(query(collection(fb.db, "associations"), where("ownerUid", "==", uid)));
  return snap.docs.map((d) => d.id);
}

/* Every group this account is linked to: its memberships and its own group
   list. Both read from the server; a failed read throws. */
async function myGroupIdsFromServer() {
  const { collection, collectionGroup, query, where, getDocsFromServer } = fb.mod.store;
  const ids = new Set();
  const members = await getDocsFromServer(query(collectionGroup(fb.db, "members"), where("uid", "==", uid)));
  members.docs.forEach((d) => { const g = d.ref.parent && d.ref.parent.parent; if (g) ids.add(g.id); });
  const pointers = await getDocsFromServer(collection(fb.db, "userGroups", uid, "groups"));
  pointers.docs.forEach((d) => ids.add(d.id));
  return [...ids];
}

/* Whether a deletion was started and has not finished (read from the server
   when possible, otherwise from this device's note). Used at start-up to open
   the "not deleted yet" screen, and to hide Sign out meanwhile. */
let deletionPendingFlag = false;
let deletionCheckUnknown = false;
let deletionRetryTimer = null;
export const deletionPending = () => deletionPendingFlag;
export async function checkPendingDeletion() {
  deletionPendingFlag = false;
  if (!fb || !uid) return false;
  const note = deletionNote();
  if (note && note.uid && note.uid !== uid) clearDeletionNote();   /* a different account now */
  try {
    const { getDocFromServer } = fb.mod.store;
    /* beta.7: never let start-up wait long on this check. */
    const snap = await withTimeout(getDocFromServer(ref("accountDeletions", uid)), 6000, "The deletion check");
    deletionPendingFlag = snap.exists();
    deletionCheckUnknown = false;
    clearTimeout(deletionRetryTimer); deletionRetryTimer = null;
    if (lastError && lastError.short === "Account status not confirmed") clearError();
  } catch {
    deletionPendingFlag = !!(deletionNote() && deletionNote().uid === uid);
    deletionCheckUnknown = !deletionPendingFlag;
    if (deletionCheckUnknown) {
      setError("Account status not confirmed", "The account check has not finished. It will retry automatically; a timeout does not confirm that the account is active.");
      if (!deletionRetryTimer) {
        const checkingUid = uid;
        deletionRetryTimer = setTimeout(async () => {
          deletionRetryTimer = null;
          if (!uid || uid !== checkingUid || !fb) return;
          if (await checkPendingDeletion()) emit({ deletionDetected: true });
        }, 15000);
      }
    }
  }
  return deletionPendingFlag;
}

/* Rounds still waiting, and writes the queue gave up on — both must be dealt
   with before an account is deleted. */
export function deletionBlockers() {
  return { waiting: outbox.count(), abandoned: outbox.abandoned().length };
}
export function dismissAbandoned() {
  try { localStorage.removeItem("golf:v2:abandoned"); } catch {}
}

/* Re-confirm the sign-in so Firebase accepts the deletion.
   Password account: the password typed on the confirmation screen.
   Anonymous account: a throwaway email and password attached to the SAME
   account (the same linkWithCredential call setMyPassword makes), then a
   fresh sign-in with it. The throwaway password stays only in this device's
   note, until the account is gone. */
async function reconfirmSignIn(password) {
  const { EmailAuthProvider, reauthenticateWithCredential, linkWithCredential } = fb.mod.auth;
  const user = fb.auth.currentUser;
  if (!user) throw new Error("Not signed in.");
  const hasPw = user.providerData && user.providerData.some((p) => p.providerId === "password");
  const note = deletionNote() || { uid };

  if (hasPw && !(note.throwawayEmail && user.email === note.throwawayEmail)) {
    if (!password) { const e = new Error("password-needed"); e.code = "password-needed"; throw e; }
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
    return;
  }

  if (!note.throwawayEmail) {
    note.throwawayEmail = `delete-${uid.toLowerCase()}@${THROWAWAY_DOMAIN}`;
    note.throwawayPassword = throwawayPassword();
    saveDeletionNote(note);   /* kept BEFORE linking, so a crash can't strand the account */
  }
  const credential = () => EmailAuthProvider.credential(note.throwawayEmail, note.throwawayPassword);
  if (!hasPw) await linkWithCredential(user, credential());
  await reauthenticateWithCredential(user, credential());
  await refreshToken();   /* the rules need the email on the token from here on */
}

/* The whole flow. Returns { ok: true } once Firebase has confirmed the
   sign-in is deleted, or { ok: false, reason, message } with nothing
   reported as deleted. Reasons: OFFLINE, OWNER, WAITING, ABANDONED,
   PASSWORD, WRONG_PASSWORD, RECORD, CLEANUP, AUTH. */
export async function deleteMyAccount({ password = "", onStep = () => {} } = {}) {
  if (!fb || !uid) return { ok: false, reason: "OFFLINE", message: "Not connected yet." };
  const { setDoc, deleteDoc, collection, query, where, getDocsFromServer } = fb.mod.store;
  const { deleteUser } = fb.mod.auth;
  const recordRef = ref("accountDeletions", uid);
  let recordWritten = false;
  /* beta.9: every step is named, so a stop says exactly where. The test hook
     works only against the emulators (E31 stops it on purpose). */
  let lastStep = "";
  const step = (name) => {
    lastStep = name;
    onStep(name);
    if (EMULATORS && typeof globalThis !== "undefined" && globalThis.__scorecardStopDeletionAt === name) {
      throw new Error(`stopped on purpose at "${name}" (test)`);
    }
  };
  /* Once the request is recorded: note where it stopped on the request,
     sign out, and say so. The rest is finished by the completion job. */
  const stopAndSignOut = async (why) => {
    try {
      await withTimeout(setDoc(recordRef, { stage: "app-stopped", appStep: lastStep || "?", appError: String(why || "").slice(0, 300) }, { merge: true }),
        8000, "Recording where it stopped");
    } catch { /* the job finishes it either way */ }
    await signOutHere();
    return { ok: false, reason: "PENDING", step: lastStep,
      message: `The deletion stopped at "${lastStep || "?"}". You have been signed out, and the rest finishes by itself within 20 minutes.` };
  };

  try {
    /* 1. Ownership and group links, from the server. */
    step("Checking your groups");
    let owned, groups;
    try { owned = await ownedGroupIds(); groups = await myGroupIdsFromServer(); }
    catch (e) {
      const code = String((e && e.code) || "unknown");
      const detail = String((e && e.message) || e || "No detail was given.");
      setError("Your groups could not be checked", `Checking your groups: ${code}: ${detail}`);
      return { ok: false, reason: "CHECK", step: "Checking your groups", code,
        message: `Your groups could not be checked (${code}). ${detail} Nothing was changed.` };
    }
    if (owned.length) return { ok: false, reason: "OWNER", message: "You own a group. Delete the group first (Admin → Delete this group), then delete your account." };

    /* 2. Anything waiting to upload goes first. */
    step("Sending anything waiting");
    await flush();
    if (!outbox.isEmpty()) return { ok: false, reason: "WAITING", message: `${outbox.count()} change${outbox.count() === 1 ? " is" : "s are"} still waiting to upload. Stay online until the status says Synced, then try again. Nothing was changed.` };
    if (outbox.abandoned().length) return { ok: false, reason: "ABANDONED", message: "Some earlier changes could not be saved. Review and dismiss them first. Nothing was changed." };

    const user = fb.auth.currentUser;
    const hasPw = !!(user && user.providerData && user.providerData.some((p) => p.providerId === "password"));
    const note0 = deletionNote();
    const resumingThrowaway = !!(note0 && note0.uid === uid && note0.throwawayEmail && user && user.email === note0.throwawayEmail);
    if (hasPw && !resumingThrowaway && !password) return { ok: false, reason: "PASSWORD", message: "Type your Scorecard password to confirm." };

    /* 4. The request is recorded on the server before anything is deleted. */
    step("Recording your request");
    const golferSnap = await getDocsFromServer(query(collection(fb.db, "golfers"), where("linkedUid", "==", uid)));
    const golferIds = golferSnap.docs.map((d) => d.id);
    saveDeletionNote({ ...(note0 && note0.uid === uid ? note0 : {}), uid, at: Date.now() });
    try {
      await withTimeout(setDoc(recordRef, {
        stage: "requested", kind: hasPw && !resumingThrowaway ? "password" : "anonymous",
        groups, golferIds, startedAt: serverTimestampValue(),
      }, { merge: true }), 20000, "Your request");
      recordWritten = true;
    } catch (e) {
      return { ok: false, reason: "RECORD", message: `${(e && e.message) || "Your request could not be recorded"}. Your account is NOT deleted.` };
    }
    deletionPendingFlag = true;

    /* 5. Re-confirm the sign-in (every account, anonymous included). */
    step("Confirming it's you");
    try { await reconfirmSignIn(password); }
    catch (e) {
      const code = String((e && (e.code || e.message)) || "");
      if (/wrong-password|invalid-credential|invalid-login|user-mismatch/.test(code)) {
        /* Nothing has been deleted: withdraw the request entirely. */
        try { await deleteDoc(recordRef); } catch {}
        clearDeletionNote(); deletionPendingFlag = false;
        return { ok: false, reason: "WRONG_PASSWORD", message: "That password isn't right. Nothing was changed." };
      }
      return await stopAndSignOut(`Your sign-in couldn't be confirmed (${code})`);
    }
    await setDoc(recordRef, { stage: "reauthenticated" }, { merge: true });

    /* 6. Ownership again, now that the sign-in is fresh. Nothing has been
       removed yet, so an owner's request is withdrawn (the rules allow that
       only at this stage) and they stay signed in. */
    let ownsNow;
    try { ownsNow = (await ownedGroupIds()).length > 0; }
    catch (e) { return await stopAndSignOut("Your groups couldn't be checked"); }
    if (ownsNow) {
      try { await deleteDoc(recordRef); } catch {}
      clearDeletionNote(); deletionPendingFlag = false;
      return { ok: false, reason: "OWNER", message: "You own a group. Delete the group first, then delete your account. Nothing was changed." };
    }

    /* beta.4: the email is free again once the account goes. */
    await removeAccountEmail();

    /* 7. Clean-up: one all-or-nothing batch per group, progress recorded in
       the same batch. Each batch has at most 4 writes. */
    step("Leaving your groups");
    groups = await myGroupIdsFromServer();
    for (const gid of groups) {
      const claims = await getDocsFromServer(query(collection(fb.db, "associations", gid, "invites"), where("acceptedBy", "==", uid)));
      const writes = [
        { op: "delete", path: ["associations", gid, "members", uid] },
        { op: "delete", path: ["userGroups", uid, "groups", gid] },
        ...claims.docs.map((d) => ({ op: "delete", path: ["associations", gid, "invites", d.id] })),
        { op: "set", path: ["accountDeletions", uid], data: { stage: "cleaning", lastGroup: gid } },
      ];
      await commitTogether(writes, "leave group for account deletion");
    }
    /* Phase C: this account's own list of blocked golfers goes too. */
    try {
      const blocks = await getDocsFromServer(collection(fb.db, "userBlocks", uid, "golfers"));
      if (!blocks.empty) await commitTogether(blocks.docs.map((d) => ({ op: "delete", path: ["userBlocks", uid, "golfers", d.id] })), "remove blocks for account deletion");
    } catch { /* not worth stopping the deletion for */ }
    const linked = await getDocsFromServer(query(collection(fb.db, "golfers"), where("linkedUid", "==", uid)));
    await commitTogether([
      ...linked.docs.map((d) => ({ op: "update", path: ["golfers", d.id], data: { linkedUid: null } })),
      { op: "set", path: ["accountDeletions", uid], data: { stage: "auth-deleting" } },
    ], "unlink golfer for account deletion");

    /* 8. The sign-in itself. Success only when Firebase says so. */
    step("Deleting your sign-in");
    try {
      await deleteUser(fb.auth.currentUser);
    } catch (e) {
      const code = String((e && (e.code || e.message)) || "");
      if (!code.includes("requires-recent-login")) throw e;
      await reconfirmSignIn(password);            /* once more, never a sign-out */
      await deleteUser(fb.auth.currentUser);
    }

    /* Firebase has confirmed the account is gone. Clear this device. */
    clearDeletionNote();
    deletionPendingFlag = false;
    try {
      Object.keys(localStorage).filter((k) => k.startsWith("golf:v2:")).forEach((k) => localStorage.removeItem(k));
    } catch {}
    return { ok: true };
  } catch (e) {
    report(e);
    const message = (e && (e.message || e.code)) || String(e);
    if (recordWritten) return await stopAndSignOut(message);
    return { ok: false, reason: "CLEANUP", message: `Nothing was changed: ${message}.` };
  }
}

/* beta.9: signs this device out without reloading (the screen then says why).
   Listeners first, as in signOutEverywhere. The device's deletion note stays,
   so this device keeps refusing the account even offline. */
export async function signOutHere() {
  stopWatching();
  try { if (fb) await fb.mod.auth.signOut(fb.auth); } catch {}
  try {
    localStorage.removeItem(ASSOC_KEY);
    localStorage.removeItem(GROUPS_KEY);
  } catch {}
  assocId = null;
  myMember = null;
  uid = null;
  deletionPendingFlag = false;
  setStatus("Signed out");
  emit();
}

export async function removeMemberships(uids) {
  const list = [...new Set((uids || []).filter(Boolean))].filter((u) => u !== uid);
  if (!list.length) return { removed: 0 };

  await commitTogether(
    list.map((memberUid) => ({
      op: "delete",
      path: ["associations", assocId, "members", memberUid],
    })),
    "remove older sign-ins"
  );
  return { removed: list.length };
}

/* Claims an UNLINKED golfer as this account.
 *
 * The rules permit exactly this — "resource.linkedUid == null && the write sets
 * it to me" — so no editedIn is needed. It exists because anyone who joined by
 * CODE never got a link, and without one the rules do not recognise their own
 * rounds as theirs: they could post but not delete. Guarded so it can never
 * overwrite somebody else's link. */
export function claimGolfer(golferId) {
  if (!golferId || !uid) return;
  outbox.enqueue({
    type: "update",
    path: ["golfers", golferId],
    data: { linkedUid: uid, claimedIn: assocId },
    opId: `golfer-claim-${golferId}`,
  });
  flush();
}

export function setManualIndex(golferId, index) {
  outbox.enqueue({
    type: "update",
    path: ["golfers", golferId],
    /* editedIn names the group this change is made on behalf of. The rules
       verify it — that you really are an admin there and that this golfer is
       really on that roster — so it is a claim they can check, not one they
       have to trust. Without it the write is refused. */
    data: {
      manualIndex: index == null ? null : model.clampIndex(index),
      editedIn: assocId,
    },
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
        if (person && !person.archived) seen.set(id, { ...person, groups: [group.name] });
      } catch {}
    }
  }
  /* Golfers who belong to NO group at all.
   *
   * These were invisible here, because the search only walked the rosters of
   * groups you are in — so anybody whose only group was deleted could not be
   * picked up again, even though their record and handicap survived. They are
   * offered under their own heading rather than mixed in, since "no group" is
   * a meaningfully different thing from "plays in Tuesday Fourball". */
  try {
    const everyone = await getDocs(col("golfers"));
    const onSomeRoster = new Set(here);
    for (const group of groups) {
      try {
        (await getDocs(col("associations", group.id, "roster")))
          .forEach((d) => onSomeRoster.add(d.id));
      } catch {}
    }

    everyone.forEach((d) => {
      const person = { ...d.data(), id: d.id };
      if (person.archived) return;
      if (onSomeRoster.has(person.id)) return;
      if (seen.has(person.id)) return;
      seen.set(person.id, { ...person, groups: [], orphaned: true });
    });
  } catch { /* cannot list them all; the rest of the picker still works */ }

  return [...seen.values()].sort((a, b) => {
    /* People who play somewhere first, then the orphans. */
    if (!!a.orphaned !== !!b.orphaned) return a.orphaned ? 1 : -1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
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

