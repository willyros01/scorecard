/* Seeds the emulators for test/ops/cl5-tests.sh: Willy's four real groups and
 * the kinds of orphan the v1 -> v2 migration left behind. */
const P = process.env.PROJECT || "scorecard-f41b8";
const FS = "http://127.0.0.1:8080/v1";
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const DB = `projects/${P}/databases/(default)/documents`;
const H = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const enc = (x) => x == null ? { nullValue: null } : typeof x === "boolean" ? { booleanValue: x }
  : typeof x === "number" ? (Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x })
  : typeof x === "string" ? { stringValue: x } : Array.isArray(x) ? { arrayValue: { values: x.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, enc(v)])) } };
const docs = [];
const put = (path, data) => docs.push({ update: { name: `${DB}/${path}`, fields: enc(data).mapValue.fields } });
const extra = process.argv[2] || "";
const DUMP = process.env.CL5_DUMP || "";   /* write a backup file instead (page test) */
const ACCOUNTS = [["W", "willy@example.com"], ["UA", "ana@example.com"], ["UE", "eve@example.com"], ["UX", null]];

if (!DUMP) for (const [uid, email] of ACCOUNTS) {
  await fetch(`${AUTH}/projects/${P}/accounts`, { method: "POST", headers: H, body: JSON.stringify(email ? { localId: uid, email, password: `pass-${uid}-123` } : { localId: uid }) });
}
const round = (id, assocId, golferId, date, gross, extraFields = {}) => ({ id, assocId, golferId, gameId: null, date, courseName: "Glen Abbey", teeName: "Blue",
  rating: 72.1, slope: 131, par: 72, gross, adjusted: gross, differential: Math.round(((gross - 72.1) * 113 / 131) * 10) / 10, enteredBy: "W", ...extraFields });
const win = (roundId, assocId, date, gross) => ({ roundId, assocId, date, differential: Math.round(((gross - 72.1) * 113 / 131) * 10) / 10 });

put("groupCreators/W", { at: 1 });
/* the four real groups */
put("associations/PUBLIC", { name: "Public group", ownerUid: "W" });
put("associations/PUBLIC/members/W", { uid: "W", role: "owner", displayName: "Willy" });
put("associations/PUBLIC/roster/gP1", { golferId: "gP1" });
put("associations/RR1", { name: "Ronnie Rosales’ Memorial Tournament", ownerUid: "W", joinCode: "RRRRRR" });
put("associations/RR1/members/W", { uid: "W", role: "owner", displayName: "Willy" });
put("associations/PG1", { name: "Philippine Golfers", ownerUid: "W", joinCode: "PPPPPP" });
put("associations/PG1/members/W", { uid: "W", role: "owner", displayName: "Willy" });
put("associations/GB1", { name: "Golfing Buddies", ownerUid: "W", joinCode: "GGGGGG" });
put("associations/GB1/members/W", { uid: "W", role: "owner", displayName: "Willy" });
put("associations/GB1/roster/gB", { golferId: "gB" });
put("associations/GB1/rounds/v1-round-1", round("v1-round-1", "GB1", "gB", "2026-05-01", 90));
put("associations/GB1/rounds/rB2", round("rB2", "GB1", "gB", "2026-05-08", 88));
put("joinCodes/GGGGGG", { assocId: "GB1" });
/* orphans */
put("associations/GB2", { name: "Golfing Buddies", ownerUid: "W", joinCode: "XXXXXX" });
put("associations/GB2/members/UE", { uid: "UE", role: "member", displayName: "Eve Only" });
put("associations/GB2/roster/gB", { golferId: "gB" });
put("associations/GB2/roster/gA", { golferId: "gA" });
put("associations/GB2/directory/gA", { golferId: "gA", displayName: "Ana Orphan", handicapIndex: 12 });
put("associations/GB2/invitations/gA", { golferId: "gA", name: "Ana Orphan" });
put("associations/GB2/games/gm1", { name: "Spring game", createdBy: "W" });
put("associations/GB2/rounds/v1-round-1", round("v1-round-1", "GB2", "gB", "2026-05-01", 90));
put("associations/GB2/rounds/rB3", round("rB3", "GB2", "gB", "2026-05-15", 95));
put("associations/GB2/rounds/rA1", round("rA1", "GB2", "gA", "2026-04-01", 85));
put("associations/GB2/rounds/rA2", round("rA2", "GB2", "gA", "2026-04-01", 85));
put("associations/OLD1", { name: "Golf v1 import", ownerUid: "W", joinCode: "ABC123" });
put("associations/OLD1/members/UA", { uid: "UA", role: "member", displayName: "Ana", golferId: "gA" });
put("associations/OLD1/rounds/rA3", round("rA3", "OLD1", "gA", "2026-04-10", 87, { gameId: "gm1" }));
put("associations/OLD1/rounds/rX", round("rX", "OLD1", "gZ", "2026-04-11", 99));
put("joinCodes/ABC123", { assocId: "OLD1" });
put("userGroups/UA/groups/OLD1", { assocId: "OLD1", name: "Golf v1 import" });
put("userGroups/W/groups/GB1", { assocId: "GB1", name: "Golfing Buddies" });
put("associations/GHOST/rounds/rG", round("rG", "GHOST", "gA", "2026-04-20", 86));
/* golfers */
put("golfers/gA", { name: "Ana Orphan", linkedUid: "UA", groups: ["GB2", "OLD1"], handicapIndex: 11.5, roundCount: 4,
  recentWindow: [win("rG", "GHOST", "2026-04-20", 86), win("rA3", "OLD1", "2026-04-10", 87), win("rA2", "GB2", "2026-04-01", 85), win("rA1", "GB2", "2026-04-01", 85)] });
put("golfers/gB", { name: "Ben Buddy", linkedUid: null, groups: ["GB1", "GB2"], handicapIndex: 15.2, roundCount: 3,
  recentWindow: [win("rB3", "GB2", "2026-05-15", 95), win("rB2", "GB1", "2026-05-08", 88), win("v1-round-1", "GB2", "2026-05-01", 90)] });
put("golfers/gZ", { name: "Zed Merged", archived: true, mergedInto: "gB", groups: ["OLD1"] });
put("golfers/gP1", { name: "Pat Public", linkedUid: "W", groups: ["PUBLIC"] });
put("golfers/gN", { name: "Nobody Anywhere", groups: [] });
/* Willy's answer A: a leftover copy (no rounds, same name as a golfer in a
   real group) stays as it is; an old sign-in with no email is not added. */
put("golfers/gBc", { name: "Ben  buddy", linkedUid: "UX", groups: ["GB2"] });
put("associations/GB2/roster/gBc", { golferId: "gBc" });
put("associations/OLD1/members/UX", { uid: "UX", role: "member", displayName: "Ben", golferId: "gBc" });
/* an orphan-only golfer with no rounds and a name of their own still moves */
put("golfers/gQ", { name: "Quinn Quiet", groups: ["OLD1"] });
put("associations/OLD1/roster/gQ", { golferId: "gQ" });
if (extra === "ambiguous") {
  put("associations/GB3", { name: "Golfing  buddies", ownerUid: "W" });
  put("associations/GB3/members/W", { uid: "W", role: "owner", displayName: "Willy" });
}
if (DUMP) {
  const fs = await import("node:fs");
  const t = "2026-10-01T12:00:00.000000Z";
  fs.writeFileSync(DUMP, JSON.stringify({ kind: "scorecard-full-backup", version: 1, project: P, savedAt: t,
    documents: docs.map((w) => ({ path: w.update.name.slice(DB.length + 1), fields: w.update.fields, missing: false, createTime: t, updateTime: t })),
    accounts: ACCOUNTS.map(([uid, email]) => ({ uid, email })) }));
  console.log(`wrote ${docs.length} documents to ${DUMP}`);
  process.exit(0);
}
const r = await fetch(`${FS}/${DB}:commit`, { method: "POST", headers: H, body: JSON.stringify({ writes: docs }) });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
console.log(`seeded ${docs.length} documents`);
