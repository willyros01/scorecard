/* model.js — the domain, with no Firebase in it.
 *
 * Everything here is a pure function. That is deliberate: it can be unit tested
 * without a network, a browser or a Firebase project, and the same code runs
 * unchanged if the storage layer is ever replaced.
 *
 * Nothing in this file reads or writes anything.
 */

/* ---------------- ids ---------------- */

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* Join codes are read aloud and typed by people, so the alphabet excludes
   characters that are confused in speech or print: I, O, 0, 1, S, 5. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
export function newJoinCode(length = 6) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}
export const normalizeJoinCode = (code) =>
  String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/* ---------------- handicap math (World Handicap System) ---------------- */

const round1 = (n) => Math.round(n * 10) / 10;

export const differential = (adjustedGross, courseRating, slopeRating) =>
  round1((113 / Number(slopeRating)) * (Number(adjustedGross) - Number(courseRating)));

/* Rule 5.2a — how many of the lowest differentials count, and the adjustment,
   when fewer than 20 rounds have been posted. */
const SCALE = {
  3: [1, -2], 4: [1, -1], 5: [1, 0], 6: [2, -1], 7: [2, 0], 8: [2, 0],
  9: [3, 0], 10: [3, 0], 11: [3, 0], 12: [4, 0], 13: [4, 0], 14: [4, 0],
  15: [5, 0], 16: [5, 0], 17: [6, 0], 18: [6, 0], 19: [7, 0], 20: [8, 0],
};

/* Takes differentials in chronological order. Returns null below three rounds,
   which is the point at which an index cannot yet be established. */
export function handicapIndex(differentialsChronological) {
  const recent = differentialsChronological.slice(-20);
  if (recent.length < 3) return null;
  const [count, adjustment] = SCALE[Math.min(recent.length, 20)];
  const lowest = [...recent].sort((a, b) => a - b).slice(0, count);
  const average = lowest.reduce((a, b) => a + b, 0) / count;
  return Math.min(54, round1(average + adjustment));
}

export const courseHandicap = (index, slopeRating, courseRating, par) =>
  Math.round(Number(index) * (Number(slopeRating) / 113) + (Number(courseRating) - Number(par)));

/* ---------------- the recent-differential window ---------------- */

/* Each golfer document carries its own window of the 20 most recent
   differentials, so posting a round never has to query a round history.
   Entries are { roundId, date, differential }, held newest first. */

/* Entries carry their group. A rebuild triggered in one group replaces only
   that group's entries and leaves the rest alone — without this, editing a
   round in group one would silently drop every round played in group two. */
export function insertIntoWindow(window, entry, limit = 20) {
  const without = (window || []).filter((e) => e.roundId !== entry.roundId);
  const merged = [...without, entry].sort(
    (a, b) => b.date.localeCompare(a.date) || String(b.roundId).localeCompare(String(a.roundId))
  );
  return merged.slice(0, limit);
}

export function removeFromWindow(window, roundId) {
  return (window || []).filter((e) => e.roundId !== roundId);
}

/* The window is newest-first; the index calculation wants oldest-first. */
export const windowFromOtherGroups = (window, assocId) =>
  (window || []).filter((e) => e.assocId && e.assocId !== assocId);

export function mergeWindow(kept, fresh, limit = 20) {
  const merged = [...kept, ...fresh].sort(
    (a, b) => b.date.localeCompare(a.date) || String(b.roundId).localeCompare(String(a.roundId))
  );
  return merged.slice(0, limit);
}

export const windowToChronological = (window) =>
  [...(window || [])].sort((a, b) => a.date.localeCompare(b.date)).map((e) => e.differential);

export const indexFromWindow = (window) => handicapIndex(windowToChronological(window));

/* Guards against a window holding entries whose rounds no longer exist.
 *
 * This produced negative indexes: rounds deleted from a group that later became
 * unreachable left their differentials in the window forever, and the fewer-
 * than-20 adjustment (minus 2.0 at three rounds) was then applied to a handful
 * of stale numbers. An index can also never be negative in the World Handicap
 * System — the scale runs from +54 downward to 0 for a scratch player, and
 * better than scratch is written as a plus handicap, which this app does not
 * model. So anything below zero is a bug, not a very good golfer. */
export function sanitizeWindow(window, knownRoundIds) {
  const known = knownRoundIds instanceof Set ? knownRoundIds : new Set(knownRoundIds || []);
  return (window || []).filter((e) =>
    e && e.roundId && known.has(e.roundId)
    && Number.isFinite(Number(e.differential))
    && typeof e.date === "string" && e.date.length >= 10
  );
}

/* The number shown to people. Null until three rounds exist, and never below
   zero. Use this rather than indexFromWindow anywhere it reaches a screen. */
export function displayIndex(window) {
  const list = window || [];
  if (list.length < 3) return null;
  const value = indexFromWindow(list);
  if (value == null) return null;
  return value < 0 ? 0 : value;
}

/* A round older than every entry in a full window cannot affect the index —
   worth knowing, because it means a backdated round is often a no-op. */
export function affectsWindow(window, date, limit = 20) {
  const list = window || [];
  if (list.length < limit) return true;
  const oldest = list[list.length - 1];
  return !oldest || date.localeCompare(oldest.date) >= 0;
}

/* ---------------- document shapes ---------------- */

/* Course and tee details are copied onto every round on purpose. When a course
   is re-rated, rounds already played must keep the rating that applied on the
   day — a round is a record of what happened, not a live lookup. */
export function buildRound({
  assocId, golferId, gameId = null, date, course, tee,
  gross, adjusted, notes = "", enteredBy, handicapIndexAtEntry = null, id = newId(),
}) {
  const adjustedGross = Number(adjusted || gross);
  const rating = Number(tee.rating);
  const slope = Number(tee.slope);
  const par = Number(tee.par);
  return {
    id,
    assocId,
    golferId,
    gameId,
    date,
    courseId: course.id,
    courseName: course.name,
    teeId: tee.id,
    teeName: tee.name,
    rating, slope, par,
    gross: Number(gross),
    adjusted: adjustedGross,
    differential: differential(adjustedGross, rating, slope),
    /* Frozen at entry so a result never changes retrospectively when a late
       round shifts somebody's index. */
    courseHandicap:
      handicapIndexAtEntry == null ? null : courseHandicap(handicapIndexAtEntry, slope, rating, par),
    indexAtEntry: handicapIndexAtEntry,
    notes: String(notes || "").trim(),
    enteredBy,
    /* enteredAt is set by the server on write — the 24-hour edit window is
       enforced against it in the security rules, so a device clock cannot
       be used to extend it. */
  };
}

/* A golfer is a person, not a group member.
 *
 * One record, one handicap index, however many groups they play in. This is
 * not a convenience: the World Handicap System defines an index over a
 * player's last twenty rounds, full stop. Splitting those rounds across groups
 * and averaging each pile separately produces two indexes, neither of which is
 * the player's handicap. It would look tidy and be wrong.
 */
export const buildGolfer = ({ name, linkedUid = null, id = newId() }) => ({
  id,
  name: String(name).trim(),
  nameKey: nameKey(name),
  linkedUid,
  handicapIndex: null,
  roundCount: 0,
  recentWindow: [],
});

/* Names are matched on this, so "Willy  Rosales" and "willy rosales" are the
   same person. It is also the key of the uniqueness index. */
export const nameKey = (name) => {
  /* Deliberately tolerant. It is handed values from documents written by older
     versions, where the field may be missing entirely — passing null or a
     number here used to throw "null is not an object" and break renaming. */
  if (name == null) return "";
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export const buildCourse = ({ name, club = "", location = "", country = "", tees, createdBy, id = newId() }) => ({
  id,
  name: String(name).trim(),
  club, location, country,
  tees: (tees || []).map((t) => ({
    id: t.id || newId(),
    name: String(t.name).trim(),
    rating: Number(t.rating),
    slope: Number(t.slope),
    par: Number(t.par),
  })),
  createdBy,
});

export const buildGame = ({ assocId, date, courseId, name = "", createdBy, id = newId() }) => ({
  id, assocId, date, courseId, name: String(name).trim(), createdBy,
});

export const buildAssociation = ({ name, ownerUid, joinCode = newJoinCode(), id = newId() }) => ({
  id,
  name: String(name).trim(),
  ownerUid,
  joinCode,
  settings: { minRoundsForRanking: 3 },
});

export const buildMember = ({ uid, displayName, role = "member", joinCode }) => ({
  uid,
  displayName: String(displayName || "").trim(),
  role,
  joinCode,   /* proof of entry, checked by the rules on create */
});

/* ---------------- migrating a version 1 scorecard ---------------- */

/* Version 1 held everything in one document: { golfers: [names], courses: [...],
   rounds: [...] }. This turns that into the version 2 collections.
 *
 * It is deterministic: the same input always produces the same ids, so running
 * the import twice writes the same documents instead of duplicating them.
 */
export function migrateFromV1(v1, { assocId, assocName, ownerUid, joinCode, existingByNameKey = {} }) {
  const stableId = (kind, key) =>
    `v1-${kind}-${String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

  const association = buildAssociation({
    id: assocId, name: assocName, ownerUid, joinCode,
  });

  const courses = (v1.courses || []).map((c) =>
    buildCourse({
      id: stableId("course", c.id || c.name),
      name: c.name,
      tees: (c.tees || []).map((t) => ({
        id: stableId("tee", `${c.name}-${t.name}`),
        name: t.name, rating: t.rating, slope: t.slope, par: t.par,
      })),
      createdBy: ownerUid,
    })
  );
  const courseByOldId = new Map((v1.courses || []).map((c, i) => [c.id, courses[i]]));

  /* If a golfer with this name already exists — because they were added by
     hand, or play in another of your groups — reuse that record rather than
     creating a second person with a second handicap. */
  const golfers = (v1.golfers || []).map((name) => {
    const key = nameKey(name);
    const already = existingByNameKey[key];
    if (already) return { ...already, name: String(name).trim(), nameKey: key };
    return buildGolfer({ id: stableId("golfer", name), name });
  });
  const golferByName = new Map(golfers.map((g) => [g.name, g]));

  /* Chronological, so each golfer's window ends up in the right order. */
  const sourceRounds = [...(v1.rounds || [])].sort((a, b) => a.date.localeCompare(b.date));

  const rounds = sourceRounds.map((r) => {
    const golfer = golferByName.get(r.golfer);
    const course = courseByOldId.get(r.courseId);
    const tee = course && course.tees.find((t) => t.name === r.teeName);
    return {
      id: stableId("round", r.id),
      assocId,
      golferId: golfer ? golfer.id : stableId("golfer", r.golfer),
      gameId: null,
      date: r.date,
      courseId: course ? course.id : stableId("course", r.courseName),
      courseName: r.courseName,
      teeId: tee ? tee.id : stableId("tee", `${r.courseName}-${r.teeName}`),
      teeName: r.teeName,
      /* The rating and slope recorded on the day are kept, not re-looked-up. */
      rating: Number(r.rating),
      slope: Number(r.slope),
      par: Number(r.par),
      gross: Number(r.gross),
      adjusted: Number(r.adjusted),
      differential: Number(r.differential),
      courseHandicap: null,
      indexAtEntry: null,
      notes: r.notes || "",
      enteredBy: ownerUid,
      migratedFromV1: true,
    };
  });

  /* Rebuild each golfer's window and index from the migrated rounds. */
  for (const golfer of golfers) {
    const theirs = rounds.filter((r) => r.golferId === golfer.id);
    let window = [];
    for (const r of theirs) {
      window = insertIntoWindow(window, { roundId: r.id, date: r.date, differential: r.differential, assocId });
    }
    golfer.recentWindow = window;
    golfer.roundCount = theirs.length;
    golfer.handicapIndex = indexFromWindow(window);
  }

  return { association, courses, golfers, rounds };
}

/* ---------------- rankings ---------------- */

/* Net is gross minus the course handicap frozen onto the round when it was
   entered. Using the stored value rather than recomputing means a result never
   changes afterwards because somebody posted a late round and shifted an index.
   That property matters more in a competitive group than it sounds. */
export const netScore = (round) =>
  round.courseHandicap == null ? null : round.gross - round.courseHandicap;

const byName = (golfers) => {
  const map = new Map();
  (golfers || []).forEach((g) => map.set(g.id, g));
  return map;
};

/* One outing. Returns every player with both placings worked out. */
export function gameLeaderboard(rounds, golfers) {
  const lookup = byName(golfers);
  const rows = (rounds || []).map((r) => ({
    roundId: r.id,
    golferId: r.golferId,
    name: (lookup.get(r.golferId) || {}).name || "Unknown",
    gross: r.gross,
    courseHandicap: r.courseHandicap,
    net: netScore(r),
    teeName: r.teeName,
  }));

  const place = (list, key) => {
    const ranked = list.filter((r) => r[key] != null).sort((a, b) => a[key] - b[key]);
    let position = 0, seen = 0, previous = null;
    for (const row of ranked) {
      seen++;
      if (row[key] !== previous) { position = seen; previous = row[key]; }
      row[`${key}Place`] = position;   /* ties share a place, as they should */
    }
  };
  place(rows, "gross");
  place(rows, "net");

  return rows.sort((a, b) => (a.netPlace || 99) - (b.netPlace || 99) || a.gross - b.gross);
}

/* A month or a year. Ranked on average net, because that rewards playing well
   rather than playing often — but rounds played and best net come along so the
   picture is not hidden behind one number. */
export function periodRanking(rounds, golfers, { minRounds = 3 } = {}) {
  const lookup = byName(golfers);
  const grouped = new Map();

  for (const r of rounds || []) {
    if (!grouped.has(r.golferId)) grouped.set(r.golferId, []);
    grouped.get(r.golferId).push(r);
  }

  const rows = [];
  for (const [golferId, theirs] of grouped) {
    const nets = theirs.map(netScore).filter((n) => n != null);
    const golfer = lookup.get(golferId) || {};
    rows.push({
      golferId,
      name: golfer.name || "Unknown",
      handicapIndex: golfer.handicapIndex == null ? null : golfer.handicapIndex,
      played: theirs.length,
      avgGross: round1(theirs.reduce((a, r) => a + r.gross, 0) / theirs.length),
      avgNet: nets.length ? round1(nets.reduce((a, b) => a + b, 0) / nets.length) : null,
      bestNet: nets.length ? Math.min(...nets) : null,
      bestGross: Math.min(...theirs.map((r) => r.gross)),
      /* Below the threshold they still appear, marked, rather than vanishing
         with no explanation. */
      ranked: theirs.length >= minRounds && nets.length > 0,
    });
  }

  const ranked = rows.filter((r) => r.ranked).sort((a, b) => a.avgNet - b.avgNet);
  ranked.forEach((row, i) => { row.place = i + 1; });
  const unranked = rows.filter((r) => !r.ranked).sort((a, b) => b.played - a.played);
  return [...ranked, ...unranked];
}

export const inPeriod = (round, { year, month }) =>
  (!year || round.date.slice(0, 4) === year) && (!month || round.date.slice(5, 7) === month);
