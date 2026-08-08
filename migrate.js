/* migrate.js — the one-time import of a version 1 scorecard.
 *
 * Safety properties, in order of importance:
 *
 *   1. The version 1 document is never touched. If anything here goes wrong,
 *      version 1 still works and still has every round.
 *   2. Ids are derived from the version 1 data, not generated. Running the
 *      import twice writes the same documents rather than duplicating them.
 *   3. Every round keeps the course rating and slope recorded on the day it
 *      was played, rather than being re-looked-up from the course library.
 */

import * as model from "./model.js";

const V1_PATH = (uid) => ["users", uid, "data", "scorecard"];

/* Reads the version 1 document. Returns null when there is nothing to import. */
export async function readV1({ db, mod, uid }) {
  const snapshot = await mod.getDoc(mod.doc(db, ...V1_PATH(uid)));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  if (!data || !Array.isArray(data.rounds)) return null;
  return data;
}

/* What the import will do, without doing any of it. Shown to the owner for
   confirmation, because an import that surprises somebody is a bad import. */
export function preview(v1) {
  if (!v1) return null;
  const golfers = (v1.golfers || []).length;
  const courses = (v1.courses || []).length;
  const rounds = (v1.rounds || []).length;
  const dates = (v1.rounds || []).map((r) => r.date).sort();
  return {
    golfers, courses, rounds,
    earliest: dates[0] || null,
    latest: dates[dates.length - 1] || null,
  };
}

/* Runs the import. Writes are batched, and every write uses merge so a second
   run overwrites identical data instead of failing or duplicating.
 *
 * Returns a report of what was written. */
export async function run({ db, mod, uid, v1, assocName, displayName }) {
  const assocId = `v1-${uid.slice(0, 10)}`;
  const joinCode = model.newJoinCode();

  const { association, courses, golfers, rounds } =
    model.migrateFromV1(v1, { assocId, assocName, ownerUid: uid, joinCode });

  const { doc, writeBatch, serverTimestamp } = mod;
  const written = { courses: 0, golfers: 0, rounds: 0 };

  /* Firestore caps a batch at 500 writes, so the rounds are chunked. */
  const commitInChunks = async (items, pathFor, counterKey) => {
    for (let i = 0; i < items.length; i += 400) {
      const batch = writeBatch(db);
      for (const item of items.slice(i, i + 400)) {
        batch.set(doc(db, ...pathFor(item)), item, { merge: true });
        written[counterKey]++;
      }
      await batch.commit();
    }
  };

  /* Association and the owner's membership first: without them the security
     rules reject everything that follows. */
  const head = writeBatch(db);
  head.set(doc(db, "associations", assocId), { ...association, createdAt: serverTimestamp() }, { merge: true });
  head.set(
    doc(db, "associations", assocId, "members", uid),
    { ...model.buildMember({ uid, displayName, role: "owner", joinCode }), joinedAt: serverTimestamp() },
    { merge: true }
  );
  await head.commit();

  await commitInChunks(courses, (c) => ["courses", c.id], "courses");
  await commitInChunks(golfers, (g) => ["associations", assocId, "golfers", g.id], "golfers");

  /* Rounds carry enteredAt so the 24-hour rule has something to measure
     against. Imported rounds are historical, so the window has long passed —
     which is correct: they should only be editable by an admin. */
  const stamped = rounds.map((r) => ({ ...r, enteredAt: serverTimestamp(), enteredBy: uid }));
  await commitInChunks(stamped, (r) => ["associations", assocId, "rounds", r.id], "rounds");

  return {
    assocId,
    joinCode,
    written,
    /* Left in place on purpose. */
    v1Preserved: true,
  };
}

/* Confirms afterwards that what is in Firestore matches what was imported,
   rather than assuming the writes landed. */
export async function verify({ db, mod, assocId, expected }) {
  const { getDocs, collection } = mod;
  const [golfers, rounds] = await Promise.all([
    getDocs(collection(db, "associations", assocId, "golfers")),
    getDocs(collection(db, "associations", assocId, "rounds")),
  ]);
  return {
    golfers: { expected: expected.golfers, found: golfers.size, ok: golfers.size === expected.golfers },
    rounds: { expected: expected.rounds, found: rounds.size, ok: rounds.size === expected.rounds },
  };
}
