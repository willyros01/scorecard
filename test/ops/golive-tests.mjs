/* GO1–GO6: the go-live data step (build/golive.mjs) against the Firebase
 * emulators, on data shaped like today's live database (2.21.9): a group whose
 * admin code sits on the group document, golfers with no groups list, no
 * directory, memberships without golferId, a game without its players.
 * Then the Version 2.0 rules are checked on the result, and the rollback.
 * Nothing here touches the live project.
 *
 * Usage (inside firebase emulators:exec, from test/ops): node golive-tests.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const P = "demo-scorecard";
const FS = "http://127.0.0.1:8080/v1";
const DBP = `projects/${P}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const ROOT = path.resolve("../..");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`PASS  ${m}`); };
const bad = (m) => { fail++; console.log(`FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const value = (v) => v === null ? { nullValue: null }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === "boolean" ? { booleanValue: v }
  : typeof v === "object" ? { mapValue: { fields: fields(v) } }
  : { stringValue: String(v) };
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));
const plain = (v) => !v || "nullValue" in v ? null : "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue)
  : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue
  : "arrayValue" in v ? (v.arrayValue.values || []).map(plain) : "mapValue" in v ? unpack(v.mapValue.fields) : null;
const unpack = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, plain(v)]));

async function put(p, data) {
  const r = await fetch(`${FS}/${DBP}:commit`, { method: "POST", headers: OWNER,
    body: JSON.stringify({ writes: [{ update: { name: `${DBP}/${p}`, fields: fields(data) } }] }) });
  if (!r.ok) throw new Error(`seed ${p}: ${r.status}`);
}
async function get(p) {
  const r = await fetch(`${FS}/${DBP}/${p}`, { headers: OWNER });
  return r.status === 200 ? unpack((await r.json()).fields) : null;
}
async function signUp(body) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake-api-key`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, returnSecureToken: true }) });
  const j = await r.json();
  return { uid: j.localId, token: j.idToken };
}
async function as(token, method, url, body) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  return r.status;
}
const query = (token, parent, coll, field, val) => as(token, "POST", `${FS}/${DBP}${parent ? `/${parent}` : ""}:runQuery`,
  { structuredQuery: { from: [{ collectionId: coll }], where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: val } } } } });

/* ---- today's shape of the data ---- */
await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents`, { method: "DELETE", headers: OWNER });
await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts`, { method: "DELETE", headers: OWNER });
const W = await signUp({ email: "willy@example.com", password: "owner-pass-1" });
const A = await signUp({ email: "admin@example.com", password: "admin-pass-1" });
const M = await signUp({ email: "member@example.com", password: "member-pass-1" });
const G = await signUp({});   // an old guest
const win = [{ roundId: "r1", date: "2026-08-01", differential: 10 }, { roundId: "r3", date: "2026-08-03", differential: 12 }, { roundId: "r4", date: "2026-08-04", differential: 11 }];
await put("associations/G1", { id: "G1", name: "Saturday Group", ownerUid: W.uid, joinCode: "JOIN01", adminCode: "LEG001" });
await put(`associations/G1/members/${W.uid}`, { uid: W.uid, role: "owner", displayName: "Willy Rosales" });
await put(`associations/G1/members/${A.uid}`, { uid: A.uid, role: "admin", displayName: "Ada Admin" });
await put(`associations/G1/members/${M.uid}`, { uid: M.uid, role: "member", displayName: "Max Member" });
await put(`associations/G1/members/${G.uid}`, { uid: G.uid, role: "member", displayName: "Gus Guest" });
await put("golfers/gM", { name: "Max Member", nameKey: "max-member", linkedUid: M.uid, recentWindow: win, roundCount: 3 });
await put("golfers/gG", { name: "Gus Guest", nameKey: "gus-guest", linkedUid: G.uid });
await put("golfers/gX", { name: "Xena Unjoined", nameKey: "xena-unjoined", linkedUid: null, manualIndex: 18 });
for (const id of ["gM", "gG", "gX"]) await put(`associations/G1/roster/${id}`, { golferId: id });
await put("associations/G1/rounds/r1", { id: "r1", golferId: "gM", assocId: "G1", date: "2026-08-01", gross: 85, gameId: "game1", courseHandicap: 14 });
await put("associations/G1/rounds/r2", { id: "r2", golferId: "gG", assocId: "G1", date: "2026-08-01", gross: 99, gameId: "game1", courseHandicap: 25 });
await put("associations/G1/rounds/r3", { id: "r3", golferId: "gM", assocId: "G1", date: "2026-08-03", gross: 88 });
await put("associations/G1/games/game1", { name: "August Cup", date: "2026-08-01", createdBy: W.uid });

/* ---- the data step, exactly as go2.txt runs it ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golive-"));
fs.copyFileSync(path.join(ROOT, "model.js"), path.join(tmp, "model.mjs"));
fs.copyFileSync(path.join(ROOT, "build/golive.mjs"), path.join(tmp, "golive.mjs"));
const env = { ...process.env, ACCESS_TOKEN: "owner", OWNER_EMAIL: "Willy@Example.com", PROJECT: P,
  FS_BASE: FS, AUTH_BASE: AUTH, STATE_DIR: path.join(tmp, "backup"), MODEL: path.join(tmp, "model.mjs") };
const run = (mode) => { try { return { ok: true, out: execFileSync("node", [path.join(tmp, "golive.mjs"), mode], { env, encoding: "utf8" }) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` }; } };

const counted = run("count");
console.log(counted.out.split("\n").map((l) => `      | ${l}`).join("\n"));
check(counted.ok && /guest \(no email\)/.test(counted.out) && /memberships held by guests \(no email\): 1/.test(counted.out), "GO1 count lists the members and finds the one guest");
check(counted.ok && /Nothing was changed/.test(counted.out) && (await get("associations/G1")).adminCode === "LEG001", "GO1 count changes nothing");

const planned = run("plan");
check(planned.ok && /admin codes moved to the owner's secret: 1/.test(planned.out), "GO2 plan shows the changes and changes nothing");
check(!(await get(`groupCreators/${W.uid}`)), "GO2 nothing written by plan");

const applied = run("apply");
console.log(applied.out.split("\n").map((l) => `      | ${l}`).join("\n"));
check(applied.ok && /OK: everything is in place/.test(applied.out), "GO3 apply finishes and checks itself");
check(!!(await get(`groupCreators/${W.uid}`)), "GO3 the owner is the group creator");
const pub = await get("associations/PUBLIC");
check(pub && pub.ownerUid === W.uid && (await get(`associations/PUBLIC/members/${W.uid}`))?.role === "owner", "GO3 the public group exists, owned by the owner");
check((await get("associations/G1")).adminCode == null && (await get("associations/G1/secrets/admin"))?.adminCode === "LEG001", "GO3 the admin code moved to the owner's secret");
check(JSON.stringify((await get("golfers/gM")).groups) === '["G1"]' && JSON.stringify((await get("golfers/gX")).groups) === '["G1"]', "GO3 golfers list their group");
const dM = await get("associations/G1/directory/gM"), dX = await get("associations/G1/directory/gX");
check(dM && dM.displayName === "Max Member" && typeof dM.handicapIndex === "number" && dX && dX.handicapIndex === 18, "GO3 the directory has names and indexes (from rounds, or the typed-in index)");
check((await get(`associations/G1/members/${M.uid}`)).golferId === "gM" && (await get(`associations/G1/members/${G.uid}`)).golferId === "gG", "GO3 memberships record their golfer");
const game = await get("associations/G1/games/game1");
check(JSON.stringify([...game.participantGolferIds].sort()) === '["gG","gM"]' && game.results.length === 2, "GO3 the game lists who played and its result sheet");
check((await get("golfers/gM")).name === "Max Member" && !!(await get("associations/G1/rounds/r3")), "GO3 names and rounds untouched");

const again = run("apply");
check(again.ok && /Applied 0 change/.test(again.out), "GO4 running apply again changes nothing");
check(run("verify").ok, "GO4 verify agrees");

/* The Version 2.0 rules on the result (loaded by run.sh) */
check(await query(M.token, "associations/G1", "rounds", "golferId", "gM") === 200, "GO5 a member reads their own rounds");
check(await query(M.token, "associations/G1", "rounds", "golferId", "gG") === 403, "GO5 ... and not anybody else's");
check(await as(M.token, "GET", `${FS}/${DBP}/associations/G1/games/game1`) === 200, "GO5 a member reads a game they played in");
check(await as(M.token, "POST", `${FS}/${DBP}/associations/G1:runQuery`, { structuredQuery: { from: [{ collectionId: "directory" }] } }) === 200, "GO5 a member reads the directory");
check(await as(A.token, "GET", `${FS}/${DBP}/golfers/gX`) === 200, "GO5 the admin reads an unjoined golfer of the group");
check(await as(A.token, "GET", `${FS}/${DBP}/associations/G1/secrets/admin`) === 403, "GO5 the admin cannot read the admin secret");
const N = await signUp({ email: "newadmin@example.com", password: "new-pass-1" });
check(await as(N.token, "POST", `${FS}/${DBP}:commit`, { writes: [{ update: { name: `${DBP}/associations/G1/members/${N.uid}`,
  fields: fields({ uid: N.uid, role: "admin", joinCode: "LEG001" }) } }] }) === 200, "GO5 an admin invitation sent before go-live still works");
check(await as(G.token, "GET", `${FS}/${DBP}/associations/G1`) === 403, "GO5 an old guest sign-in is refused until it sets an email");

const back = run("rollback");
check(back.ok && (await get("associations/G1")).adminCode === "LEG001", "GO6 rollback puts the admin code back on the group");
check((await get("migrations/v2"))?.state === "rolled-back", "GO6 the marker says rolled-back");

/* GO7–GO9: go-live fix 3 — a failure part-way, the marker, resume, and a
   rollback that works even when this computer's copy is lost. */
await put("associations/G2", { id: "G2", name: "Sunday Group", ownerUid: W.uid, joinCode: "JOIN02", adminCode: "LEG002" });
await put(`associations/G2/members/${W.uid}`, { uid: W.uid, role: "owner", displayName: "Willy Rosales" });
await put("golfers/gInv", { name: "Ines Invited", nameKey: "ines-invited", linkedUid: null, invitedAt: 1759000000000, invitedAs: "member" });
await put("golfers/gY", { name: "Yuri Golfer", nameKey: "yuri-golfer", linkedUid: null });
for (const id of ["gInv", "gY"]) await put(`associations/G2/roster/${id}`, { golferId: id });
const failing = (() => { try { return { ok: true, out: execFileSync("node", [path.join(tmp, "golive.mjs"), "apply"],
  { env: { ...env, BATCH_SIZE: "1", FAIL_AFTER_COMMITS: "2" }, encoding: "utf8" }) }; }
  catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` }; } })();
check(!failing.ok && /stopped part-way/.test(failing.out), "GO7 a failure part-way stops with a clear message");
const m7 = await get("migrations/v2");
check(m7 && m7.state === "data-failed" && /stopped on purpose/.test(m7.error || ""), "GO7 the marker records data-failed and why");
check(/data-failed/.test(run("status").out), "GO7 status shows how far it got");
const codes7 = (m7.adminCodes || []).map((x) => x.adminCode).sort().join(",");
check(codes7 === "LEG001,LEG002", "GO7 the marker holds every admin code before it moved");
fs.rmSync(path.join(tmp, "backup"), { recursive: true, force: true });   // this computer's copy is lost
const back7 = run("rollback");
check(back7.ok && (await get("associations/G1")).adminCode === "LEG001" && (await get("associations/G2")).adminCode === "LEG002",
  "GO8 rollback from the database marker alone puts both admin codes back");
const resumed = run("apply");
check(resumed.ok && /OK: everything is in place/.test(resumed.out), "GO8 running apply again finishes the job");
check((await get("migrations/v2")).state === "data-done" && run("verify").ok, "GO8 marker data-done and verify agrees");
check((await get("associations/G2")).adminCode == null && (await get("associations/G2/secrets/admin"))?.adminCode === "LEG002", "GO8 G2's admin code moved");
const inv = await get("associations/G2/invitations/gInv");
check(inv && inv.name === "Ines Invited" && inv.groupName === "Sunday Group" && inv.role === "member", "GO9 an invitation already sent gets its greeting record");
check(!(await get("associations/G2/invitations/gY")), "GO9 no record for a golfer never invited");
const invited = await signUp({ email: "ines@example.com", password: "ines-pass-1" });
check(await as(invited.token, "GET", `${FS}/${DBP}/associations/G2/invitations/gInv`) === 200, "GO9 the invitee reads the greeting record");
check(await as(invited.token, "GET", `${FS}/${DBP}/golfers/gInv`) === 403, "GO9 ... but not the golfer record (go-live fix 1)");
check(await as(invited.token, "GET", `${FS}/${DBP}/migrations/v2`) === 403, "GO9 nobody can read the migration marker from an app");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
