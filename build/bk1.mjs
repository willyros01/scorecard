#!/usr/bin/env node
/* The Scorecard — COMPLETE BACKUP (read only). Run by bk1.txt in Google Cloud
 * Shell with Willy's own Google access, and by the nightly backup job.
 *
 *   node bk1.mjs <output file>
 *
 * Saves EVERY document in the database, every subcollection included (groups,
 * memberships, rosters, rounds, games, golfers, courses, applications, ...),
 * exactly as Firestore holds it, so anything can be put back later; plus the
 * list of sign-in accounts (uid, email, created, last sign-in — never
 * passwords). Documents that exist only as a parent of subcollections are
 * included too. Nothing is written to the database.
 *
 * Settings (environment): ACCESS_TOKEN (required; "owner" for the emulators),
 * PROJECT (default scorecard-f41b8), FS_BASE, AUTH_BASE.
 */
import fs from "node:fs";

const OUT = process.argv[2];
const TOKEN = process.env.ACCESS_TOKEN;
const PROJECT = process.env.PROJECT || "scorecard-f41b8";
const FS = process.env.FS_BASE || "https://firestore.googleapis.com/v1";
const AUTH = process.env.AUTH_BASE || "https://identitytoolkit.googleapis.com/v1";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;

const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
process.on("uncaughtException", (e) => die(`${(e && e.message) || e}`));
process.on("unhandledRejection", (e) => die(`${(e && e.message) || e}`));
if (!TOKEN) die("ACCESS_TOKEN is missing.");
if (!OUT) die("Say where to save the backup.");

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
if (TOKEN !== "owner") headers["x-goog-user-project"] = PROJECT;
/* Document ids may hold spaces and other characters a web address cannot,
   so every part of a path is encoded. */
const at = (name) => name.split("/").map(encodeURIComponent).join("/");
/* At most a few requests at once, and a dropped connection is tried again:
   Oct 1, Willy's first run stopped with "fetch failed" — too many at once. */
let active = 0; const waiting = [];
const slot = () => (active < 6 ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const free = () => { const next = waiting.shift(); if (next) next(); else active--; };
async function call(method, url, body, tries = 5) {
  for (let i = 1; ; i++) {
    await slot();
    let r, text;
    try {
      r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      text = await r.text();
    } catch (e) {
      free();
      const why = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e;
      if (i >= tries) throw new Error(`${method} ${url} → ${why}`);
      await new Promise((res) => setTimeout(res, 1500 * i));
      continue;
    }
    free();
    if (r.ok) return text ? JSON.parse(text) : {};
    if (i >= tries || (r.status < 500 && r.status !== 429)) throw new Error(`${method} ${url} → HTTP ${r.status}: ${text.slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 1500 * i));
  }
}

async function collectionIds(parent) {
  const out = [];
  let pageToken = "";
  do {
    const r = await call("POST", `${FS}/${at(parent)}:listCollectionIds`, { pageSize: 300, ...(pageToken ? { pageToken } : {}) });
    out.push(...(r.collectionIds || []));
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function documents(parent, collection) {
  const out = [];
  let pageToken = "";
  do {
    const r = await call("GET", `${FS}/${at(parent)}/${encodeURIComponent(collection)}?pageSize=300&showMissing=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    out.push(...(r.documents || []));
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  return out;
}

/* Walk the whole tree: one list of places still to read, a few readers. */
const docs = [];
const counts = {};
async function readOne(parent, depth, queue) {
  for (const c of await collectionIds(parent)) {
    const list = await documents(parent, c);
    const label = depth === 0 ? c : `…/${c}`;
    counts[label] = (counts[label] || 0) + list.length;
    for (const d of list) {
      const rel = d.name.slice(ROOT.length + 1);
      docs.push({ path: rel, fields: d.fields || null, missing: !d.fields && !d.createTime, createTime: d.createTime || null, updateTime: d.updateTime || null });
      queue.push([d.name, depth + 1]);
    }
  }
}
async function walk(root) {
  const queue = [[root, 0]];
  let busy = 0;
  await new Promise((resolve, reject) => {
    const pump = () => {
      if (!queue.length && !busy) return resolve();
      while (queue.length && busy < 6) {
        const [parent, depth] = queue.shift();
        busy++;
        readOne(parent, depth, queue).then(() => { busy--; pump(); }, reject);
      }
    };
    pump();
  });
}

console.log("Reading the whole database (read only) ...");
await walk(ROOT);

let accounts = [];
let accountsNote = "";
try {
  let next = "";
  do {
    const r = await call("GET", `${AUTH}/projects/${PROJECT}/accounts:batchGet?maxResults=500${next ? `&nextPageToken=${encodeURIComponent(next)}` : ""}`);
    for (const u of r.users || []) {
      accounts.push({ uid: u.localId, email: u.email || null, emailVerified: !!u.emailVerified, disabled: !!u.disabled,
        createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null,
        providers: (u.providerUserInfo || []).map((p) => p.providerId) });
    }
    next = r.nextPageToken || "";
  } while (next);
} catch (e) { accountsNote = `accounts not read: ${e.message}`; accounts = null; }

const backup = { kind: "scorecard-full-backup", version: 1, project: PROJECT, savedAt: new Date().toISOString(),
  counts, documents: docs, accounts, ...(accountsNote ? { accountsNote } : {}) };
fs.writeFileSync(OUT, JSON.stringify(backup));
const groups = docs.filter((d) => /^associations\/[^/]+$/.test(d.path)).length;
const rounds = docs.filter((d) => /^associations\/[^/]+\/rounds\/[^/]+$/.test(d.path)).length;
const golfers = docs.filter((d) => /^golfers\/[^/]+$/.test(d.path)).length;
console.log(`Saved ${docs.length} documents: ${groups} groups, ${golfers} golfers, ${rounds} rounds${accounts ? `, ${accounts.length} accounts` : ""}.`);
console.log(`File: ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
console.log("BACKUP DONE.");
