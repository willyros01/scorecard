#!/usr/bin/env node
/* The Scorecard — ARCHIVE LEFTOVER GOLFER COPIES (Willy, Oct 2, 2026).
 * Run by arc.txt in Google Cloud Shell, right after a complete backup;
 * tested against the Firebase emulators by test/ops/arc-tests.sh.
 *
 *   node arc.mjs apply  <backup file>   shows the copies, waits for "yes", archives them
 *   node arc.mjs verify <backup file>   read only: no copies are left
 *
 * A COPY is a golfer record that is
 *   - in no group (on no roster and no membership of any group that exists),
 *   - with no rounds anywhere, and
 *   - named exactly like ONE golfer who IS in a group (the real person).
 * Each copy is ARCHIVED — hidden from every list, never deleted — and marked
 * as merged into the real person, as Tidy does with duplicates. Nothing else
 * is written: not the real golfer, not the name list, not any sign-in.
 *
 * It stops, changing nothing, if a copy is linked to the owner's account, if
 * the name list points at a copy, or if two people in groups share the copy's
 * name. A copy linked to the sign-in of another golfer who is in a group is
 * left as it is and listed.
 *
 * Settings (environment): ACCESS_TOKEN (required for apply; "owner" for the
 * emulators), PROJECT (default scorecard-f41b8), FS_BASE.
 */
import fs from "node:fs";
import readline from "node:readline";
import * as model from "../model.js";
import { decodeFields } from "./cl5-plan.mjs";

export function makeArcPlan(backup, { now = Date.now() } = {}) {
  const stops = [];
  const docs = (backup.documents || []).filter((d) => d && d.path);
  const live = (d) => d && d.fields && !d.missing;
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const liveGroups = new Set(docs.filter((d) => /^associations\/[^/]+$/.test(d.path) && live(d)).map((d) => d.path.split("/")[1]));
  const inGroup = new Set(); const linkedOfReal = new Set(); const rounds = new Map();
  for (const d of docs) {
    const p = d.path.split("/");
    if (p[0] !== "associations" || p.length !== 4 || !live(d)) continue;
    const data = decodeFields(d.fields);
    if (p[2] === "rounds") rounds.set(data.golferId, (rounds.get(data.golferId) || 0) + 1);
    if (!liveGroups.has(p[1])) continue;
    if (p[2] === "roster") inGroup.add(p[3]);
    if (p[2] === "members" && data.golferId) inGroup.add(data.golferId);
  }
  const golfers = new Map();
  for (const d of docs) {
    const m = /^golfers\/([^/]+)$/.exec(d.path);
    if (m && live(d)) golfers.set(m[1], { id: m[1], doc: d, data: decodeFields(d.fields) });
  }
  const creators = new Set(docs.filter((d) => /^groupCreators\/[^/]+$/.test(d.path) && live(d)).map((d) => d.path.split("/")[1]));
  const realByName = new Map();
  for (const g of golfers.values()) {
    if (g.data.archived || !inGroup.has(g.id)) continue;
    if (g.data.linkedUid) linkedOfReal.add(g.data.linkedUid);
    const k = model.nameKey(g.data.name);
    if (!k) continue;
    if (!realByName.has(k)) realByName.set(k, []);
    realByName.get(k).push(g);
  }
  const copies = []; const skipped = [];
  for (const g of golfers.values()) {
    if (g.data.archived || inGroup.has(g.id) || rounds.get(g.id)) continue;
    const k = model.nameKey(g.data.name);
    const real = realByName.get(k) || [];
    if (!real.length) continue;
    const name = String(g.data.name || g.id);
    if (real.length > 1) { stops.push(`${real.length} people in your groups are called "${name}"; nothing can be decided safely.`); continue; }
    const u = g.data.linkedUid;
    if (u && creators.has(u)) { stops.push(`A copy of "${name}" is linked to YOUR account; it is left for Claude to look at.`); continue; }
    if (u && linkedOfReal.has(u)) { skipped.push({ id: g.id, name, why: "linked to the sign-in of a golfer in a group" }); continue; }
    const claim = byPath.get(`golferNames/${k}`);
    if (claim && live(claim) && decodeFields(claim.fields).golferId === g.id) {
      stops.push(`The name "${name}" is registered to a copy, not to the real person; nothing can be decided safely.`); continue;
    }
    copies.push({ id: g.id, name, into: real[0].id, intoName: String(real[0].data.name || real[0].id), linked: !!u, updateTime: g.doc.updateTime });
  }
  const writes = copies.map((c) => ({
    path: `golfers/${c.id}`, updateTime: c.updateTime,
    fields: { archived: { booleanValue: true }, archivedAt: { integerValue: String(now) }, mergedInto: { stringValue: c.into } },
    mask: ["archived", "archivedAt", "mergedInto"],
  }));
  /* Safety: only the copies, only those three fields. */
  const ids = new Set(copies.map((c) => c.id));
  if (writes.some((w) => !ids.has(w.path.split("/")[1]) || w.path.split("/").length !== 2 || w.path.split("/")[0] !== "golfers")) {
    stops.push("Internal check failed. Nothing will be done.");
  }
  const otherNoGroup = [...golfers.values()].filter((g) => !g.data.archived && !inGroup.has(g.id) && !ids.has(g.id)).length - skipped.length;
  return { stops, copies, skipped, writes, otherNoGroup };
}

/* ---- the command ---- */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const [MODE, FILE] = process.argv.slice(2);
  const TOKEN = process.env.ACCESS_TOKEN;
  const PROJECT = process.env.PROJECT || "scorecard-f41b8";
  const FS = process.env.FS_BASE || "https://firestore.googleapis.com/v1";
  const DB = `projects/${PROJECT}/databases/(default)/documents`;
  const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
  process.on("unhandledRejection", (e) => die(`${(e && e.message) || e}`));
  if (!["apply", "verify"].includes(MODE)) die("Use: node arc.mjs apply <backup>  or  node arc.mjs verify <backup>");
  if (!FILE || !fs.existsSync(FILE)) die("The backup file was not found.");
  const plan = makeArcPlan(JSON.parse(fs.readFileSync(FILE, "utf8")));

  if (MODE === "verify") {
    if (plan.stops.length) die(plan.stops.join(" "));
    if (plan.copies.length) die(`${plan.copies.length} copies are still not archived. Run bash arc.txt again.`);
    console.log("OK: no leftover copies remain in the lists.");
    process.exit(0);
  }
  if (!TOKEN) die("ACCESS_TOKEN is missing.");
  if (plan.stops.length) die(`Nothing was changed. ${plan.stops.join(" ")}`);
  if (!plan.copies.length) { console.log("OK: there are no leftover copies to archive."); process.exit(0); }
  console.log("");
  console.log(`LEFTOVER COPIES TO ARCHIVE: ${plan.copies.length}`);
  for (const c of plan.copies) console.log(`  ${c.name}  (no group, no rounds${c.linked ? ", an old sign-in" : ""})  ->  merged into your ${c.intoName}`);
  console.log("NOT TOUCHED: every golfer in a group, every golfer with rounds, the name list, every sign-in.");
  for (const k of plan.skipped) console.log(`LEFT AS IS: ${k.name} (${k.why}).`);
  if (plan.otherNoGroup) console.log(`Also not touched: ${plan.otherNoGroup} other golfer(s) in no group, whose names match nobody in a group.`);
  console.log("");
  const answer = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Type yes to archive them: ", (a) => { rl.close(); resolve(String(a || "").trim()); });
  });
  if (answer !== "yes") die("Stopped. Nothing was changed.");
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  if (TOKEN !== "owner") headers["x-goog-user-project"] = PROJECT;
  const body = { writes: plan.writes.map((w) => ({ update: { name: `${DB}/${w.path}`, fields: w.fields },
    updateMask: { fieldPaths: w.mask }, currentDocument: { updateTime: w.updateTime } })) };
  const r = await fetch(`${FS}/${DB}:commit`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) die(`Google refused it (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}. Nothing was changed. Run bash arc.txt again.`);
  console.log(`ARCHIVED ${plan.copies.length}, all together in one step.`);
}
