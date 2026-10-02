/* The Scorecard — ONE-TIME GROUP CLEAN-UP: the plan (Willy, Oct 1, 2026).
 *
 * Shared, word for word, by the page that SHOWS the plan (groups-check.html,
 * which reads a backup file on the device and writes nothing) and by the
 * script that CARRIES IT OUT (build/cl5.mjs, run by cl5.txt in Cloud Shell).
 * Both read the same backup format (build/bk1.mjs), so what Willy sees is
 * exactly what the script does.
 *
 * Willy's rules:
 *   - Only four groups are real: the PUBLIC group, Ronnie Rosales' Memorial
 *     Tournament, Philippine Golfers and Golfing Buddies. Every other group is
 *     an orphan left by the version 1 to version 2 migration.
 *   - Nothing in the four is removed or changed. Philippine Golfers (his test
 *     group) only RECEIVES golfers.
 *   - No golfer and no account may be left with no group:
 *       a golfer found only in orphan groups moves to Philippine Golfers
 *       (roster, directory, the golfer's own list of groups, and their
 *       account's membership), and their rounds move with them, so their
 *       handicap stays the same (Willy's answer A);
 *       an account that belongs only to orphan groups joins Philippine Golfers.
 *   - Then the orphan groups are removed with everything in them (Willy's
 *     answer: remove). A round that is a copy of one already in a real group
 *     is removed and the handicap is pointed at the real copy.
 */
import * as model from "../model.js";

export const PUBLIC_ID = "PUBLIC";
export const PHILIPPINE = "philippine golfers";
export const PROTECTED_NAMES = ["ronnie rosales' memorial tournament", PHILIPPINE, "golfing buddies"];
export const norm = (s) => String(s == null ? "" : s).toLowerCase()
  .replace(/[‘’‛`´]/g, "'").replace(/\s+/g, " ").trim();

/* ---------- Firestore values ---------- */
export function decode(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
export const decodeFields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, decode(v)]));
export function encode(x) {
  if (x == null) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === "string") return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encode) } };
  if (typeof x === "object") return { mapValue: { fields: encodeFields(x) } };
  return { stringValue: String(x) };
}
export const encodeFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, encode(v)]));
const tsNow = (now) => ({ timestampValue: new Date(now).toISOString() });

/* ---------- the plan ---------- */
export function makePlan(backup, { now = Date.now(), moveStayingRounds = false } = {}) {
  const stops = [];
  if (!backup || backup.kind !== "scorecard-full-backup") {
    return { stops: ["This is not a Scorecard backup file."], orphans: [], steps: [] };
  }
  const docs = (backup.documents || []).filter((d) => d && d.path);
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const live = (d) => d && d.fields && !d.missing;
  const data = (d) => decodeFields(d.fields || {});
  const emailOf = new Map((backup.accounts || []).map((a) => [a.uid, a.email]));

  /* Every group id: a group document, or only things filed under one. */
  const groupIds = new Set();
  const sub = new Map();     /* groupId -> Map(subcollection -> [{id, path, doc}]) */
  for (const d of docs) {
    const p = d.path.split("/");
    if (p[0] !== "associations" || p.length < 2) continue;
    groupIds.add(p[1]);
    if (p.length === 4 && live(d)) {
      if (!sub.has(p[1])) sub.set(p[1], new Map());
      const m = sub.get(p[1]);
      if (!m.has(p[2])) m.set(p[2], []);
      m.get(p[2]).push({ id: p[3], path: d.path, doc: d, data: data(d) });
    }
  }
  const items = (g, c) => (sub.get(g) && sub.get(g).get(c)) || [];
  const groupDoc = (g) => byPath.get(`associations/${g}`);
  const groupName = (g) => (live(groupDoc(g)) ? String(data(groupDoc(g)).name || "") : "");
  const creators = new Set(docs.filter((d) => /^groupCreators\/[^/]+$/.test(d.path) && live(d)).map((d) => d.path.split("/")[1]));
  const memberUid = (m) => String(m.data.uid || m.id);
  const creatorIsMember = (g) => items(g, "members").some((m) => creators.has(memberUid(m)));

  /* ---- the four real groups ---- */
  const protectedIds = [];
  const named = {};
  if (!live(groupDoc(PUBLIC_ID))) stops.push("The PUBLIC group was not found in the backup.");
  else { protectedIds.push(PUBLIC_ID); named.public = PUBLIC_ID; }
  for (const want of PROTECTED_NAMES) {
    let found = [...groupIds].filter((g) => g !== PUBLIC_ID && live(groupDoc(g)) && norm(groupName(g)) === want);
    if (found.length > 1) found = found.filter(creatorIsMember);
    if (found.length === 1) { protectedIds.push(found[0]); named[want] = found[0]; }
    else if (found.length === 0) stops.push(`No group called "${want}" was found that you belong to.`);
    else stops.push(`${found.length} groups are called "${want}" and you belong to more than one of them. Nothing can be decided safely.`);
  }
  const P = new Set(protectedIds);
  const PG = named[PHILIPPINE] || null;
  const O = new Set([...groupIds].filter((g) => !P.has(g)));

  /* ---- golfers and where they appear ---- */
  const golfers = new Map();
  for (const d of docs) {
    const m = /^golfers\/([^/]+)$/.exec(d.path);
    if (m && live(d)) golfers.set(m[1], { id: m[1], doc: d, data: { ...data(d), id: m[1] } });
  }
  const pLink = new Map(); const oLink = new Map();
  const link = (map, gid, g) => { if (!gid) return; if (!map.has(gid)) map.set(gid, new Set()); map.get(gid).add(g); };
  for (const g of groupIds) {
    const target = P.has(g) ? pLink : oLink;
    for (const r of items(g, "roster")) link(target, r.id, g);
    for (const m of items(g, "members")) link(target, m.data.golferId, g);
    if (!P.has(g)) {
      for (const r of items(g, "directory")) link(oLink, r.id, g);
      for (const r of items(g, "rounds")) link(oLink, r.data.golferId, g);
    }
  }
  for (const [gid, g] of golfers) for (const x of g.data.groups || []) if (O.has(x)) link(oLink, gid, x);
  const isActive = (gid) => golfers.has(gid) && !golfers.get(gid).data.archived;
  const moved = new Set([...oLink.keys()].filter((gid) => isActive(gid) && !(pLink.get(gid) || new Set()).size));

  /* ---- rounds ---- */
  const keyOf = (r) => [r.golferId, r.date, r.gross, r.adjusted, norm(r.courseName), norm(r.teeName)].join("|");
  const pById = new Map(); const pByKey = new Map();
  for (const g of P) for (const r of items(g, "rounds")) {
    if (!pById.has(r.id)) pById.set(r.id, { group: g, id: r.id });
    if (!pByKey.has(keyOf(r.data))) pByKey.set(keyOf(r.data), { group: g, id: r.id });
  }
  const roundPlan = [];          /* {group, id, golferId, kind, target, inWindow} */
  const movedById = new Map(); const movedByKey = new Map();
  const windowIds = (gid) => new Set(((golfers.get(gid) || { data: {} }).data.recentWindow || []).map((e) => e && e.roundId));
  const orphanList = [...O].sort();
  for (const g of orphanList) {
    for (const r of [...items(g, "rounds")].sort((a, b) => a.id.localeCompare(b.id))) {
      const gid = r.data.golferId;
      const key = keyOf(r.data);
      const base = { group: g, id: r.id, golferId: gid, date: r.data.date, inWindow: windowIds(gid).has(r.id) };
      const dupe = pById.get(r.id) || pByKey.get(key) || movedById.get(r.id) || movedByKey.get(key);
      if (dupe) { roundPlan.push({ ...base, kind: "copy", target: dupe }); continue; }
      if (!isActive(gid)) { roundPlan.push({ ...base, kind: "noGolfer" }); continue; }
      if (PG && (moved.has(gid) || moveStayingRounds)) {
        const target = { group: PG, id: r.id };
        movedById.set(r.id, target); movedByKey.set(key, target);
        roundPlan.push({ ...base, kind: "move", target, fields: r.doc.fields });
        continue;
      }
      roundPlan.push({ ...base, kind: "staying" });
    }
  }
  const roundFate = new Map(roundPlan.map((r) => [`${r.group}/${r.id}`, r]));
  const fateById = new Map(); for (const r of roundPlan) if (!fateById.has(r.id)) fateById.set(r.id, r);

  /* ---- golfer records: their groups and their handicap window ---- */
  const golferUpdates = new Map();   /* gid -> {mask, fields, groupsAfter, windowAfter, indexBefore, indexAfter, unresolved} */
  for (const [gid, g] of golfers) {
    if (g.data.archived) continue;
    const before = g.data.groups || [];
    let groupsAfter = before.filter((x) => !O.has(x));
    if (moved.has(gid) && PG && !groupsAfter.includes(PG)) groupsAfter = [...groupsAfter, PG];
    const win = Array.isArray(g.data.recentWindow) ? g.data.recentWindow : [];
    const typed = (g.doc.fields.recentWindow && g.doc.fields.recentWindow.arrayValue
      && g.doc.fields.recentWindow.arrayValue.values) || [];
    let changed = false; let unresolved = 0;
    /* Only entries pointed elsewhere are ever dropped, and only when the
       round they now point at is already in the window. */
    const seen = new Set(win.filter((e) => e && !O.has(e.assocId)).map((e) => e.roundId));
    const windowAfter = []; const typedAfter = [];
    win.forEach((e, i) => {
      let entry = e; let tv = typed[i];
      let remapped = false;
      if (e && O.has(e.assocId)) {
        const fate = roundFate.get(`${e.assocId}/${e.roundId}`) || fateById.get(e.roundId);
        if (fate && (fate.kind === "move" || fate.kind === "copy") && fate.target) {
          changed = true;
          entry = { ...e, roundId: fate.target.id, assocId: fate.target.group };
          const f = tv && tv.mapValue ? { ...(tv.mapValue.fields || {}) } : encodeFields(e);
          f.roundId = encode(entry.roundId); f.assocId = encode(entry.assocId);
          tv = { mapValue: { fields: f } };
          remapped = true;
        } else unresolved++;
      }
      if (remapped) {
        if (seen.has(entry.roundId)) return;
        seen.add(entry.roundId);
      }
      windowAfter.push(entry); typedAfter.push(tv || encode(entry));
    });
    const groupsChanged = JSON.stringify(groupsAfter) !== JSON.stringify(before);
    if (!changed && !groupsChanged) {
      if (unresolved) golferUpdates.set(gid, { none: true, unresolved });
      continue;
    }
    const mask = []; const fields = {};
    if (groupsChanged) { mask.push("groups"); fields.groups = encode(groupsAfter); }
    if (changed) { mask.push("recentWindow"); fields.recentWindow = { arrayValue: { values: typedAfter } }; }
    let indexAfter = g.data.handicapIndex == null ? null : g.data.handicapIndex;
    if (windowAfter.length !== win.length) {
      /* A round was counted twice. Count it once and fill the window back up
         from the golfer's other rounds in the real groups (and those moving to
         Philippine Golfers), newest first, as the app does. */
      const have = new Set(windowAfter.map((e) => e && e.roundId));
      const fresh = [];
      for (const pg of P) for (const r of items(pg, "rounds")) {
        if (r.data.golferId === gid && !have.has(r.id)) { have.add(r.id); fresh.push({ roundId: r.id, date: r.data.date, differential: r.data.differential, assocId: pg }); }
      }
      for (const r of roundPlan) {
        if (r.kind === "move" && r.golferId === gid && !have.has(r.id)) {
          have.add(r.id);
          const d = decodeFields(r.fields);
          fresh.push({ roundId: r.id, date: d.date, differential: d.differential, assocId: r.target.group });
        }
      }
      const typedById = new Map(windowAfter.map((e, i) => [e && e.roundId, typedAfter[i]]));
      const merged = model.mergeWindow(windowAfter.filter((e) => e && typeof e.date === "string"), fresh.filter((e) => typeof e.date === "string"));
      windowAfter.length = 0; windowAfter.push(...merged);
      fields.recentWindow = { arrayValue: { values: merged.map((e) => typedById.get(e.roundId) || encode(e)) } };
      indexAfter = model.displayIndex(windowAfter);
      mask.push("handicapIndex"); fields.handicapIndex = encode(indexAfter);
    }
    golferUpdates.set(gid, { mask, fields, groupsAfter, windowAfter, indexBefore: g.data.handicapIndex == null ? null : g.data.handicapIndex, indexAfter, unresolved });
  }

  /* ---- accounts ---- */
  const accountGroups = new Map();
  for (const g of groupIds) for (const m of items(g, "members")) {
    const u = memberUid(m);
    if (!accountGroups.has(u)) accountGroups.set(u, { p: new Set(), o: [], member: m });
    const a = accountGroups.get(u);
    if (P.has(g)) a.p.add(g); else a.o.push({ group: g, member: m });
  }
  const pgMembers = new Set(PG ? items(PG, "members").map(memberUid) : []);
  const newMembers = new Map();   /* uid -> {uid, displayName, golferId, why} */

  /* ---- the steps, in order ---- */
  const steps = [];
  const movedGolfers = [];
  if (PG) for (const gid of [...moved].sort()) {
    const g = golfers.get(gid);
    const theirs = roundPlan.filter((r) => r.kind === "move" && r.golferId === gid);
    const creates = theirs.map((r) => {
      const f = { ...r.fields, assocId: encode(PG), gameId: { nullValue: null }, movedFrom: encode(r.group) };
      return { op: "create", path: `associations/${PG}/rounds/${r.id}`, fields: f };
    });
    for (let i = 0; i < creates.length; i += 400) steps.push({ label: `${g.data.name || gid}: rounds ${i + 1}–${Math.min(i + 400, creates.length)}`, writes: creates.slice(i, i + 400) });
    const up = golferUpdates.get(gid);
    const after = { ...g.data, ...(up && !up.none ? { recentWindow: up.windowAfter, handicapIndex: up.indexAfter } : {}) };
    const last = [];
    if (!byPath.has(`associations/${PG}/roster/${gid}`)) last.push({ op: "set", path: `associations/${PG}/roster/${gid}`, fields: encodeFields({ golferId: gid, addedAt: now, movedFrom: "clean-up" }) });
    last.push({ op: "set", path: `associations/${PG}/directory/${gid}`, fields: encodeFields({ golferId: gid, displayName: String(g.data.name || ""), handicapIndex: model.effectiveIndex(after).index, updatedAt: now }) });
    const u = g.data.linkedUid;
    if (u && !pgMembers.has(u) && !newMembers.has(u)) {
      newMembers.set(u, { uid: u, displayName: String(g.data.name || ""), golferId: gid, why: "their golfer moves" });
    }
    if (up && !up.none) last.push({ op: "update", path: `golfers/${gid}`, fields: up.fields, mask: up.mask, updateTime: g.doc.updateTime });
    steps.push({ label: `${g.data.name || gid}: moves to Philippine Golfers`, writes: last, golfer: gid });
    movedGolfers.push({ id: gid, name: String(g.data.name || gid), from: [...oLink.get(gid)].map((x) => groupName(x) || x),
      rounds: theirs.length, email: u ? emailOf.get(u) || "(account)" : "" });
  }
  /* accounts left in no real group */
  for (const [u, a] of accountGroups) {
    if (a.p.size || !a.o.length || newMembers.has(u) || pgMembers.has(u)) continue;
    const gid = a.o.map((x) => x.member.data.golferId).find((x) => x && isActive(x)) || null;
    newMembers.set(u, { uid: u, displayName: String(a.o[0].member.data.displayName || ""), golferId: gid, why: "belongs only to orphan groups" });
  }
  if (PG) {
    const pgName = groupName(PG);
    const writes = [];
    for (const m of newMembers.values()) {
      const f = { uid: encode(m.uid), role: encode("member"), displayName: encode(m.displayName), joinedAt: tsNow(now) };
      if (m.golferId) f.golferId = encode(m.golferId);
      writes.push({ op: "create", path: `associations/${PG}/members/${m.uid}`, fields: f });
      writes.push({ op: "set", path: `userGroups/${m.uid}/groups/${PG}`, fields: encodeFields({ assocId: PG, name: pgName, at: now }) });
    }
    for (let i = 0; i < writes.length; i += 400) steps.push({ label: "memberships in Philippine Golfers", writes: writes.slice(i, i + 400) });
  }
  /* the other golfers' records (groups list and handicap window) */
  const others = [];
  for (const [gid, up] of golferUpdates) {
    if (moved.has(gid) || up.none) continue;
    others.push({ op: "update", path: `golfers/${gid}`, fields: up.fields, mask: up.mask, updateTime: golfers.get(gid).doc.updateTime });
  }
  for (let i = 0; i < others.length; i += 300) steps.push({ label: "golfer records", writes: others.slice(i, i + 300) });
  /* the removals */
  const deletes = [];
  for (const g of orphanList) {
    for (const d of docs) if (d.path.startsWith(`associations/${g}/`) && live(d)) deletes.push({ op: "delete", path: d.path });
    if (live(groupDoc(g))) deletes.push({ op: "delete", path: `associations/${g}` });
  }
  for (const d of docs) {
    const m = /^userGroups\/([^/]+)\/groups\/([^/]+)$/.exec(d.path);
    if (m && O.has(m[2]) && live(d)) deletes.push({ op: "delete", path: d.path });
    const j = /^joinCodes\/([^/]+)$/.exec(d.path);
    if (j && live(d) && O.has(String(data(d).assocId || ""))) deletes.push({ op: "delete", path: d.path });
  }
  for (let i = 0; i < deletes.length; i += 400) steps.push({ label: `removals ${i + 1}–${Math.min(i + 400, deletes.length)} of ${deletes.length}`, writes: deletes.slice(i, i + 400) });

  /* ---- safety: every write must stay inside what Willy agreed ---- */
  const okWrite = (w) => {
    const p = w.path.split("/");
    if (w.op === "delete") {
      return (p[0] === "associations" && O.has(p[1]))
        || (p[0] === "userGroups" && p[2] === "groups" && O.has(p[3]))
        || p[0] === "joinCodes";
    }
    if (p[0] === "golfers" && p.length === 2) return w.op === "update" && w.mask.every((f) => ["groups", "recentWindow", "handicapIndex"].includes(f));
    if (p[0] === "userGroups" && p.length === 4) return p[3] === PG;
    return p[0] === "associations" && p[1] === PG && p.length === 4 && ["rounds", "roster", "directory", "members"].includes(p[2]);
  };
  const allWrites = steps.flatMap((s) => s.writes);
  if (allWrites.some((w) => !okWrite(w))) stops.push("Internal check failed: a change outside the agreed clean-up. Nothing will be done.");

  /* No golfer and no account may end up with no group. */
  const pgRosterAfter = new Set([...items(PG || "", "roster").map((r) => r.id), ...moved]);
  for (const gid of new Set([...oLink.keys(), ...pLink.keys()])) {
    if (!isActive(gid)) continue;
    const inReal = (pLink.get(gid) || new Set()).size || pgRosterAfter.has(gid);
    if (!inReal) stops.push(`Golfer ${golfers.get(gid).data.name || gid} would be left with no group.`);
  }
  for (const [u, a] of accountGroups) {
    if (!a.p.size && !newMembers.has(u) && !pgMembers.has(u)) stops.push(`Account ${emailOf.get(u) || u} would be left with no group.`);
  }

  const count = (k) => roundPlan.filter((r) => r.kind === k).length;
  const orphans = orphanList.map((g) => {
    const d = groupDoc(g);
    const counts = {};
    for (const [c, list] of (sub.get(g) || new Map())) counts[c] = list.length;
    const owner = live(d) ? data(d).ownerUid : null;
    return { id: g, name: groupName(g) || "(no group record)", hasRecord: live(d), created: (d && d.createTime) || null,
      owner: owner ? emailOf.get(owner) || owner : "", youAreMember: creatorIsMember(g), counts };
  });
  const protectedList = protectedIds.map((g) => ({ id: g, name: groupName(g), roster: items(g, "roster").length,
    members: items(g, "members").length, rounds: items(g, "rounds").length }));
  const stayingRounds = roundPlan.filter((r) => r.kind === "staying");
  const unresolved = [...golferUpdates.entries()].filter(([, u]) => u.unresolved)
    .map(([gid, u]) => ({ id: gid, name: String(golfers.get(gid).data.name || gid), entries: u.unresolved }));
  const noGroupBefore = [...golfers.keys()].filter((gid) => isActive(gid) && !oLink.has(gid) && !pLink.has(gid)).length;

  return {
    stops: [...new Set(stops)],
    protected: protectedList, philippine: PG ? { id: PG, name: groupName(PG) } : null,
    orphans, movedGolfers,
    newMembers: [...newMembers.values()].map((m) => ({ ...m, email: emailOf.get(m.uid) || "" })),
    rounds: {
      move: count("move"), copy: count("copy"), noGolfer: count("noGolfer"), staying: stayingRounds.length,
      stayingInHandicap: stayingRounds.filter((r) => r.inWindow).length,
      stayingGolfers: [...new Set(stayingRounds.map((r) => r.golferId))].map((gid) => ({ id: gid, name: String(golfers.get(gid).data.name || gid),
        rounds: stayingRounds.filter((r) => r.golferId === gid).length, inHandicap: stayingRounds.filter((r) => r.golferId === gid && r.inWindow).length })),
    },
    golferRecords: [...golferUpdates.values()].filter((u) => !u.none).length,
    handicapChanges: [...golferUpdates.entries()].filter(([, u]) => !u.none && u.indexBefore !== u.indexAfter)
      .map(([gid, u]) => ({ id: gid, name: String(golfers.get(gid).data.name || gid), before: u.indexBefore, after: u.indexAfter })),
    unresolved, noGroupBefore,
    removals: deletes.length, pointers: deletes.filter((w) => w.path.startsWith("userGroups/")).length,
    joinCodes: deletes.filter((w) => w.path.startsWith("joinCodes/")).length,
    steps,
  };
}
