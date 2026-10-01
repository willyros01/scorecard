#!/usr/bin/env node
/* The Scorecard — beta.4 data step (run by ap4.txt in Google Cloud Shell with
 * Willy's own Google access; tested against the Firebase emulators by
 * test/ops/ap4-tests.sh).
 *
 *   node ap4.mjs apply    adds what is missing (safe to run again):
 *                         1. accountEmails/{email} for every account that has
 *                            an email (the "already has an account" message);
 *                         2. settings/publicApplications = Manual, 20 a day,
 *                            if it does not exist yet (Willy, Oct 1);
 *                         3. common throwaway-email domains on the block list;
 *                         4. the database index for the cockpit's rounds count
 *                            (rounds by date across all groups).
 *   node ap4.mjs verify   read only: checks all four are in place.
 *
 * Nothing is deleted or changed that already exists.
 *
 * Settings (environment): ACCESS_TOKEN (required; "owner" for the emulators),
 * PROJECT (default scorecard-f41b8), FS_BASE, AUTH_BASE, ADMIN_BASE.
 */
const MODE = process.argv[2] || "verify";
const TOKEN = process.env.ACCESS_TOKEN;
const PROJECT = process.env.PROJECT || "scorecard-f41b8";
const FS = process.env.FS_BASE || "https://firestore.googleapis.com/v1";
const AUTH = process.env.AUTH_BASE || "https://identitytoolkit.googleapis.com/v1";
const ADMIN = process.env.ADMIN_BASE || "https://firestore.googleapis.com/v1";
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const EMULATED = TOKEN === "owner";

const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
process.on("uncaughtException", (e) => die(`${(e && e.message) || e}`));
process.on("unhandledRejection", (e) => die(`${(e && e.message) || e}`));
if (!TOKEN) die("ACCESS_TOKEN is missing.");
if (!["apply", "verify"].includes(MODE)) die(`unknown mode ${MODE}`);

export const THROWAWAY_DOMAINS = [
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org",
  "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com",
  "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mintemail.com",
];

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
if (!EMULATED) headers["x-goog-user-project"] = PROJECT;
async function call(method, url, body) {
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const now = () => ({ timestampValue: new Date().toISOString() });
const str = (s) => ({ stringValue: s });

async function listIds(collection) {
  const out = [];
  let token = "";
  do {
    const page = await call("GET", `${FS}/${DB}/${collection}?pageSize=300&mask.fieldPaths=__name__${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    for (const d of page.documents || []) out.push(decodeURIComponent(d.name.split("/").pop()));
    token = page.nextPageToken || "";
  } while (token);
  return out;
}
async function exists(p) {
  try { await call("GET", `${FS}/${DB}/${p}`); return true; }
  catch (e) { if (/HTTP 404/.test(e.message)) return false; throw e; }
}
async function createMany(writes) {
  for (let i = 0; i < writes.length; i += 300) await call("POST", `${FS}/${DB}:commit`, { writes: writes.slice(i, i + 300) });
}
const createDoc = (p, fields) => ({ update: { name: `${DB}/${p}`, fields }, currentDocument: { exists: false } });

async function accountEmails() {
  const out = new Set();
  let next = "";
  do {
    const r = await call("GET", `${AUTH}/projects/${PROJECT}/accounts:batchGet?maxResults=500${next ? `&nextPageToken=${encodeURIComponent(next)}` : ""}`);
    for (const u of r.users || []) {
      const e = String(u.email || "").trim().toLowerCase();
      if (e && !e.startsWith("delete-") && !e.includes("/")) out.add(e);
    }
    next = r.nextPageToken || "";
  } while (next);
  return [...out];
}

const INDEX_URL = `${ADMIN}/projects/${PROJECT}/databases/(default)/collectionGroups/rounds/fields/date`;
async function indexReady() {
  if (EMULATED) return true;
  const f = await call("GET", INDEX_URL);
  const idx = (f.indexConfig && f.indexConfig.indexes) || [];
  return idx.some((i) => i.queryScope === "COLLECTION_GROUP" && (i.fields || []).some((x) => x.order === "ASCENDING"));
}

async function plan() {
  const emails = await accountEmails();
  const have = new Set(await listIds("accountEmails"));
  const missingEmails = emails.filter((e) => !have.has(e));
  const settings = await exists("settings/publicApplications");
  const haveDomains = new Set(await listIds("blockedDomains"));
  const missingDomains = THROWAWAY_DOMAINS.filter((d) => !haveDomains.has(d));
  const index = await indexReady();
  return { emails, missingEmails, settings, missingDomains, index };
}

const p = await plan();
if (MODE === "verify") {
  const problems = [];
  if (p.missingEmails.length) problems.push(`${p.missingEmails.length} account email(s) not recorded`);
  if (!p.settings) problems.push("the applications switch is not set up");
  if (p.missingDomains.length) problems.push(`${p.missingDomains.length} throwaway domain(s) not blocked`);
  if (!p.index) problems.push("the rounds index is not set up");
  if (problems.length) die(`not complete: ${problems.join("; ")}`);
  console.log(`OK: ${p.emails.length} account emails recorded, the switch is set up, ${THROWAWAY_DOMAINS.length} throwaway domains blocked, the rounds index is in place.`);
  process.exit(0);
}

/* apply */
console.log(`Account emails to record: ${p.missingEmails.length} of ${p.emails.length}.`);
await createMany(p.missingEmails.map((e) => createDoc(`accountEmails/${e}`, { at: now() })));
if (!p.settings) {
  await createMany([createDoc("settings/publicApplications", {
    mode: str("manual"), dailyLimit: { integerValue: "20" }, updatedBy: str("setup"), updatedAt: now() })]);
  console.log("Applications switch set up: Manual, 20 a day.");
}
await createMany(p.missingDomains.map((d) => createDoc(`blockedDomains/${d}`, { addedBy: str("setup"), addedAt: now() })));
console.log(`Throwaway domains blocked: ${p.missingDomains.length} added.`);
if (EMULATED) {
  console.log("Rounds index: not needed on the emulators.");
} else if (!p.index) {
  await call("PATCH", `${INDEX_URL}?updateMask=indexConfig`, { indexConfig: { indexes: [
    { queryScope: "COLLECTION", fields: [{ fieldPath: "date", order: "ASCENDING" }] },
    { queryScope: "COLLECTION", fields: [{ fieldPath: "date", order: "DESCENDING" }] },
    { queryScope: "COLLECTION", fields: [{ fieldPath: "date", arrayConfig: "CONTAINS" }] },
    { queryScope: "COLLECTION_GROUP", fields: [{ fieldPath: "date", order: "ASCENDING" }] },
  ] } });
  console.log("Rounds index requested. Google builds it in a few minutes; the cockpit's rounds count appears once it is ready.");
} else {
  console.log("Rounds index already in place.");
}
console.log("DATA DONE.");
