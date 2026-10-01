#!/usr/bin/env node
/* The Scorecard — Version 2.0 go-live, the DATA part (run by go2.txt / cnt.txt
 * in Google Cloud Shell, with Willy's own Google access; tested against the
 * Firebase emulators by test/ops/golive-tests.sh).
 *
 *   node golive.mjs count      read only: groups, members, guests, admins without email
 *   node golive.mjs plan       read only: what "apply" would change
 *   node golive.mjs apply      makes the changes below, saving what it replaces first
 *   node golive.mjs verify     read only: checks every change is in place
 *   node golive.mjs rollback   puts back what "apply" replaced (the admin codes)
 *   node golive.mjs status     read only: the migration marker (how far go-live got)
 *   node golive.mjs mark STATE records a stage in the marker (used by go2.txt)
 *
 * The migration marker (go-live fix 3) is the document migrations/v2, which
 * no app can read or write: its stage (data-started, data-failed, data-done,
 * rules-published, verified, rolled-back), when, and a copy of every admin
 * code before it moved — so a rollback works even if this computer's copy is
 * lost. Every step can be run again: it only writes what is still missing.
 *
 * What "apply" does, every step safe to repeat:
 *   1. groupCreators/{owner uid}: the owner is the only account that may create groups.
 *   2. The PUBLIC group, owned by the owner, if it does not exist yet.
 *   3. Each group's admin invitation code moves from the group document (which
 *      every member can read) to associations/{id}/secrets/admin (owner only).
 *   4. Each golfer on a roster lists that group in `groups` (at most 10), which
 *      is how the new rules let a group's admins read the golfer.
 *   5. Each group's directory: name and handicap index of every rostered golfer.
 *   6. Each membership records its golfer (golferId) when the golfer is linked.
 *   7. Each game lists who played (participantGolferIds) and its result sheet.
 *   8. Each invitation already sent to a golfer who has not joined gets its
 *      invitation record (go-live fix 1), so the link still greets them.
 * Rounds, golfers' names and handicaps, and memberships are never deleted.
 *
 * Settings (environment):
 *   ACCESS_TOKEN (required) — a Google access token, or "owner" for the emulators
 *   OWNER_EMAIL  (required) — the owner's sign-in email
 *   PROJECT      default scorecard-f41b8
 *   FS_BASE      default https://firestore.googleapis.com/v1
 *   AUTH_BASE    default https://identitytoolkit.googleapis.com/v1
 *   STATE_DIR    where the "before" copy is kept (default ./scorecard-go2-backup)
 *   MODEL        path of model.js saved as .mjs (default ./model.mjs)
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MODE = process.argv[2] || "count";
const TOKEN = process.env.ACCESS_TOKEN;
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || "").trim().toLowerCase();
const PROJECT = process.env.PROJECT || "scorecard-f41b8";
const FS = process.env.FS_BASE || "https://firestore.googleapis.com/v1";
const AUTH = process.env.AUTH_BASE || "https://identitytoolkit.googleapis.com/v1";
const STATE = path.resolve(process.env.STATE_DIR || "scorecard-go2-backup");
const MODEL = path.resolve(process.env.MODEL || "model.mjs");
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const PUBLIC_ID = "PUBLIC";
const PUBLIC_NAME = "Public group";

const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
/* Any unexpected failure (a dropped connection, say) ends with one plain
   line instead of a stack trace. Exit code 1, so go2.txt recovers. */
process.on("uncaughtException", (e) => die(`${(e && e.message) || e}${e && e.cause ? ` (${e.cause.message || e.cause})` : ""}`));
process.on("unhandledRejection", (e) => die(`${(e && e.message) || e}${e && e.cause ? ` (${e.cause.message || e.cause})` : ""}`));
if (!TOKEN) die("ACCESS_TOKEN is missing.");
if (!OWNER_EMAIL) die("OWNER_EMAIL is missing.");
if (!["count", "plan", "apply", "verify", "rollback", "status", "mark"].includes(MODE)) die(`unknown mode ${MODE}`);
/* Tests only: write in small batches and fail on purpose after N of them. */
const BATCH = Number(process.env.BATCH_SIZE || 400);
const FAIL_AFTER = process.env.FAIL_AFTER_COMMITS ? Number(process.env.FAIL_AFTER_COMMITS) : -1;
const model = await import(pathToFileURL(MODEL).href);

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
if (TOKEN !== "owner") headers["x-goog-user-project"] = PROJECT;
async function call(method, url, body) {
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url.replace(/key=[^&]+/, "")} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/* ---- Firestore values ---- */
function fromValue(v) {
  if (!v || "nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return { __timestamp: v.timestampValue };
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  if ("referenceValue" in v) return v.referenceValue;
  return null;
}
const fromFields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fromValue(v)]));
function toValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === "string") return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toValue) } };
  if (x.__timestamp) return { timestampValue: x.__timestamp };
  return { mapValue: { fields: toFields(x) } };
}
const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)]));
const docName = (p) => `${DB}/${p}`;

async function listDocs(p) {
  const out = [];
  let token = "";
  do {
    const page = await call("GET", `${FS}/${DB}/${p}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    for (const d of page.documents || []) out.push({ id: d.name.split("/").pop(), ...fromFields(d.fields) });
    token = page.nextPageToken || "";
  } while (token);
  return out;
}
async function getOne(p) {
  try { const d = await call("GET", `${FS}/${DB}/${p}`); return { id: d.name.split("/").pop(), ...fromFields(d.fields) }; }
  catch (e) { if (/HTTP 404/.test(e.message)) return null; throw e; }
}
let commits = 0;
async function commit(writes) {
  for (let i = 0; i < writes.length; i += BATCH) {
    if (FAIL_AFTER >= 0 && commits >= FAIL_AFTER) throw new Error(`stopped on purpose after ${commits} batch(es) (test)`);
    await call("POST", `${FS}/${DB}:commit`, { writes: writes.slice(i, i + BATCH) });
    commits++;
  }
}
const MARKER = "migrations/v2";
async function mark(state, extra = {}) {
  await call("POST", `${FS}/${DB}:commit`, { writes: [setFields(MARKER, { state, at: new Date().toISOString(), ...extra })] });
}
/* Merge the given fields into a document (it may or may not exist). */
const setFields = (p, data) => ({ update: { name: docName(p), fields: toFields(data) }, updateMask: { fieldPaths: Object.keys(data) } });
/* Create a document only if it does not exist yet. */
const create = (p, data) => ({ update: { name: docName(p), fields: toFields(data) }, currentDocument: { exists: false } });
/* Remove one field from an existing document. */
const removeField = (p, field) => ({ update: { name: docName(p), fields: {} }, updateMask: { fieldPaths: [field] }, currentDocument: { exists: true } });

/* ---- accounts ---- */
async function lookup(body) {
  const r = await call("POST", `${AUTH}/projects/${PROJECT}/accounts:lookup`, body);
  return r.users || [];
}
async function accountsById(uids) {
  const map = new Map();
  const list = [...new Set(uids)].filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    for (const u of await lookup({ localId: list.slice(i, i + 100) })) map.set(u.localId, u);
  }
  return map;
}
async function allAccounts() {
  const out = [];
  let next = "";
  try {
    do {
      const r = await call("GET", `${AUTH}/projects/${PROJECT}/accounts:batchGet?maxResults=500${next ? `&nextPageToken=${encodeURIComponent(next)}` : ""}`);
      out.push(...(r.users || []));
      next = r.nextPageToken || "";
    } while (next);
    return out;
  } catch { return null; }
}
const kind = (a) => !a ? "no sign-in (deleted)" : a.email ? (a.email.startsWith("delete-") ? "being deleted" : "email") : "guest (no email)";
const lastSeen = (a) => a && a.lastLoginAt ? new Date(Number(a.lastLoginAt)).toISOString().slice(0, 10) : "never";

/* ---- read everything once ---- */
async function readAll() {
  const owners = await lookup({ email: [OWNER_EMAIL] });
  if (!owners.length) die(`no account has the email ${OWNER_EMAIL}. Nothing was changed.`);
  const owner = owners[0];
  const groups = await listDocs("associations");
  for (const g of groups) {
    g.members = await listDocs(`associations/${g.id}/members`);
    g.roster = (await listDocs(`associations/${g.id}/roster`)).map((r) => r.id);
    g.games = await listDocs(`associations/${g.id}/games`);
    g.rounds = await listDocs(`associations/${g.id}/rounds`);
    g.directory = await listDocs(`associations/${g.id}/directory`);
    g.secret = await getOne(`associations/${g.id}/secrets/admin`);
    g.invitations = (await listDocs(`associations/${g.id}/invitations`)).map((x) => x.id);
  }
  const golfers = new Map((await listDocs("golfers")).map((x) => [x.id, x]));
  const creator = await getOne(`groupCreators/${owner.localId}`);
  return { owner, groups, golfers, creator };
}

/* ---- what apply changes ---- */
function makePlan({ owner, groups, golfers, creator }) {
  const writes = [];
  const notes = [];
  const count = { creator: 0, public: 0, secrets: 0, golferGroups: 0, directory: 0, memberGolfer: 0, games: 0, invitations: 0 };
  const now = Date.now();

  if (!creator) { writes.push(setFields(`groupCreators/${owner.localId}`, { email: owner.email || OWNER_EMAIL, setAt: now })); count.creator = 1; }

  if (!groups.some((g) => g.id === PUBLIC_ID)) {
    const name = groups.flatMap((g) => g.members).find((m) => m.id === owner.localId && m.displayName)?.displayName || "Owner";
    writes.push(create(`associations/${PUBLIC_ID}`, { id: PUBLIC_ID, name: PUBLIC_NAME, ownerUid: owner.localId,
      settings: { minRoundsForRanking: 3 }, createdAt: { __timestamp: new Date(now).toISOString() } }));
    writes.push(create(`associations/${PUBLIC_ID}/members/${owner.localId}`, { uid: owner.localId, role: "owner",
      displayName: name, joinedAt: { __timestamp: new Date(now).toISOString() } }));
    writes.push(setFields(`userGroups/${owner.localId}/groups/${PUBLIC_ID}`, { assocId: PUBLIC_ID, name: PUBLIC_NAME, at: now }));
    count.public = 1;
  }

  for (const g of groups) {
    if (g.adminCode) {
      if (!g.secret || !g.secret.adminCode) writes.push(setFields(`associations/${g.id}/secrets/admin`, { adminCode: g.adminCode }));
      writes.push(removeField(`associations/${g.id}`, "adminCode"));
      count.secrets++;
    }
  }

  /* golfers.groups */
  const wanted = new Map();
  for (const g of groups) for (const id of g.roster) {
    if (!wanted.has(id)) wanted.set(id, new Set());
    wanted.get(id).add(g.id);
  }
  for (const [id, set] of wanted) {
    const golfer = golfers.get(id);
    if (!golfer) continue;
    const have = Array.isArray(golfer.groups) ? golfer.groups : [];
    const merged = [...new Set([...have, ...set])];
    if (merged.length > 10) notes.push(`${golfer.name || id} plays in ${merged.length} groups; only 10 can be listed (admins of the others cannot read the record).`);
    const next = merged.slice(0, 10);
    if (next.length !== have.length || next.some((x, i) => x !== have[i])) {
      writes.push(setFields(`golfers/${id}`, { groups: next }));
      golfer.groups = next;
      count.golferGroups++;
    }
  }

  for (const g of groups) {
    const dir = new Map(g.directory.map((d) => [d.id, d]));
    for (const id of g.roster) {
      const golfer = golfers.get(id);
      if (!golfer || golfer.archived) continue;
      const index = model.effectiveIndex(golfer).index;
      const entry = { golferId: id, displayName: golfer.name || "", handicapIndex: index == null ? null : index };
      const old = dir.get(id);
      if (!old || old.displayName !== entry.displayName || (old.handicapIndex ?? null) !== entry.handicapIndex) {
        writes.push(setFields(`associations/${g.id}/directory/${id}`, { ...entry, updatedAt: now }));
        count.directory++;
      }
    }

    const rostered = g.roster.map((id) => golfers.get(id)).filter((x) => x && !x.archived);
    for (const m of g.members) {
      if (m.golferId) continue;
      const mine = rostered.find((x) => x.linkedUid === m.id);
      if (mine) { writes.push(setFields(`associations/${g.id}/members/${m.id}`, { golferId: mine.id })); count.memberGolfer++; }
    }

    for (const game of g.games) {
      if (Array.isArray(game.participantGolferIds)) continue;
      const played = g.rounds.filter((r) => r.gameId === game.id);
      const results = played.map((r) => ({
        id: r.id, golferId: r.golferId || "", name: (golfers.get(r.golferId) || {}).name || "",
        date: r.date || "", gross: r.gross ?? null, adjusted: r.adjusted ?? null,
        courseHandicap: r.courseHandicap ?? null, teeName: r.teeName || "", estimated: false,
      })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      writes.push(setFields(`associations/${g.id}/games/${game.id}`, {
        participantGolferIds: [...new Set(played.map((r) => r.golferId).filter(Boolean))], results }));
      count.games++;
    }

    /* Invitations already sent and not yet used: the greeting record. */
    for (const golfer of rostered) {
      if (golfer.linkedUid || !golfer.invitedAt || g.invitations.includes(golfer.id) || g.id === PUBLIC_ID) continue;
      const index = model.effectiveIndex(golfer).index;
      writes.push(create(`associations/${g.id}/invitations/${golfer.id}`, {
        golferId: golfer.id, name: String(golfer.name || "").slice(0, 120), handicapIndex: index == null ? null : index,
        groupName: String(g.name || "").slice(0, 120), role: golfer.invitedAs === "admin" ? "admin" : "member",
        sentBy: g.ownerUid, sentAt: { __timestamp: new Date(Number(golfer.invitedAt) || now).toISOString() } }));
      g.invitations.push(golfer.id);
      count.invitations++;
    }
  }
  return { writes, notes, count };
}

function printPlan({ count, notes }) {
  console.log("What apply changes:");
  console.log(`  owner listed as the only group creator : ${count.creator ? "yes" : "already"}`);
  console.log(`  public group created                   : ${count.public ? "yes" : "already exists"}`);
  console.log(`  admin codes moved to the owner's secret: ${count.secrets}`);
  console.log(`  golfers given their groups list        : ${count.golferGroups}`);
  console.log(`  directory entries written              : ${count.directory}`);
  console.log(`  memberships given their golfer         : ${count.memberGolfer}`);
  console.log(`  games given players and result sheet   : ${count.games}`);
  console.log(`  invitation records for unused links    : ${count.invitations}`);
  for (const n of notes) console.log(`  NOTE: ${n}`);
}

/* ---- modes ---- */
if (MODE === "status") {
  const m = await getOne(MARKER);
  console.log(m ? `Migration marker: ${m.state} (${m.at})${m.error ? ` — ${m.error}` : ""}` : "Migration marker: none (go-live has not started).");
  process.exit(0);
}
if (MODE === "mark") {
  const state = process.argv[3];
  if (!["rules-published", "verified", "rolled-back", "failed"].includes(state)) die(`unknown stage ${state}`);
  await mark(state, process.argv[4] ? { error: String(process.argv[4]).slice(0, 300) } : {});
  console.log(`Marker: ${state}.`);
  process.exit(0);
}
const data = await readAll();
const { owner, groups } = data;
console.log(`Owner: ${owner.email} — owns ${groups.filter((g) => g.ownerUid === owner.localId).length} of ${groups.length} group(s).`);
if (!groups.some((g) => g.ownerUid === owner.localId)) die(`${OWNER_EMAIL} owns no group — is this the right email? Nothing was changed.`);

if (MODE === "count") {
  const uids = groups.flatMap((g) => g.members.map((m) => m.id));
  const acc = await accountsById(uids);
  let guests = 0, adminsNoEmail = 0;
  for (const g of groups) {
    const ownerAcc = acc.get(g.ownerUid);
    console.log(`\n== ${g.name || g.id}  (owner: ${ownerAcc ? ownerAcc.email || "guest" : "unknown"}; ${g.members.length} member(s))`);
    for (const m of [...g.members].sort((a, b) => String(a.role).localeCompare(String(b.role)))) {
      const a = acc.get(m.id);
      const k = kind(a);
      if (k.startsWith("guest")) guests++;
      if (k.startsWith("guest") && (m.role === "admin" || m.role === "owner")) adminsNoEmail++;
      console.log(`   ${String(m.role || "").padEnd(6)} ${String(m.displayName || "(no name)").padEnd(24)} ${k.padEnd(18)} ${a && a.email ? a.email : ""}  last sign-in ${lastSeen(a)}`);
    }
  }
  const everyone = await allAccounts();
  console.log("\n== Summary");
  console.log(`   memberships held by guests (no email): ${guests}`);
  console.log(`   admins or owners with no email       : ${adminsNoEmail}`);
  if (everyone) {
    const inGroup = new Set(uids);
    const loose = everyone.filter((a) => !a.email && !inGroup.has(a.localId));
    console.log(`   sign-ins in total                    : ${everyone.length}`);
    console.log(`   guest sign-ins in no group           : ${loose.length}`);
  }
  console.log("\nNothing was changed.");
  process.exit(0);
}

if (MODE === "plan" || MODE === "apply") {
  const plan = makePlan(data);
  printPlan(plan);
  if (MODE === "plan") { console.log("\nNothing was changed."); process.exit(0); }
  /* The copy of what is replaced, BEFORE anything is written. Kept if it
     already exists, so a second run never overwrites the original. */
  fs.mkdirSync(STATE, { recursive: true });
  const before = path.join(STATE, "before.json");
  const codes = groups.filter((g) => g.adminCode).map((g) => ({ id: g.id, adminCode: g.adminCode }));
  if (!fs.existsSync(before)) {
    fs.writeFileSync(before, JSON.stringify({ at: new Date().toISOString(), owner: owner.localId, adminCodes: codes }, null, 1));
  }
  /* The marker, with the admin codes, BEFORE the first change. On a re-run
     the codes already saved are kept and any still on a group are added. */
  const old = await getOne(MARKER);
  const saved = new Map(((old && old.adminCodes) || []).map((x) => [x.id, x]));
  for (const c of codes) if (!saved.has(c.id)) saved.set(c.id, c);
  await mark("data-started", { adminCodes: [...saved.values()], error: null });
  try {
    await commit(plan.writes);
  } catch (e) {
    try { await mark("data-failed", { error: String(e.message || e).slice(0, 300) }); } catch {}
    die(`the data step stopped part-way: ${e.message || e}. Nothing is lost; run it again to continue, or roll back.`);
  }
  console.log(`\nApplied ${plan.writes.length} change(s).`);
  const again = makePlan(await readAll());
  if (again.writes.length) {
    try { await mark("data-failed", { error: `${again.writes.length} change(s) did not take` }); } catch {}
    die(`${again.writes.length} change(s) did not take. Run it again, or send a screenshot to Claude.`);
  }
  await mark("data-done");
  console.log("OK: everything is in place.");
  process.exit(0);
}

if (MODE === "verify") {
  const left = makePlan(data);
  if (left.writes.length) { printPlan(left); die("not everything is in place (see above)."); }
  console.log("OK: every data change is in place.");
  process.exit(0);
}

if (MODE === "rollback") {
  /* The admin codes from the marker (kept in the database), else this
     computer's copy. */
  const m = await getOne(MARKER);
  const before = path.join(STATE, "before.json");
  const codes = (m && Array.isArray(m.adminCodes) && m.adminCodes.length) ? m.adminCodes
    : fs.existsSync(before) ? JSON.parse(fs.readFileSync(before, "utf8")).adminCodes : null;
  if (!codes) die("no saved copy to go back to.");
  await commit(codes.map((x) => setFields(`associations/${x.id}`, { adminCode: x.adminCode })));
  await mark("rolled-back");
  console.log(`OK: ${codes.length} admin code(s) put back on their groups. The other additions are harmless under the old rules and are left in place.`);
  process.exit(0);
}
