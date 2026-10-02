#!/usr/bin/env node
/* The Scorecard — ONE-TIME GROUP CLEAN-UP: carries out the plan in
 * build/cl5-plan.mjs (the same plan groups-check.html shows). Run by cl5.txt
 * in Google Cloud Shell with Willy's own Google access, right after a complete
 * backup; tested against the Firebase emulators by test/ops/cl5-tests.sh.
 *
 *   node cl5.mjs apply  <backup file>   shows the plan, waits for "yes", does it
 *   node cl5.mjs verify <backup file>   read only: nothing is left to do
 *
 * Safe to run again: each golfer's move is written together, the golfer's own
 * record last, and anything already done is recognised and not repeated.
 *
 * Settings (environment): ACCESS_TOKEN (required; "owner" for the emulators),
 * PROJECT (default scorecard-f41b8), FS_BASE, CL5_STOP_AFTER (tests only).
 */
import fs from "node:fs";
import readline from "node:readline";
import { makePlan } from "./cl5-plan.mjs";

const [MODE, FILE] = process.argv.slice(2);
const TOKEN = process.env.ACCESS_TOKEN;
const PROJECT = process.env.PROJECT || "scorecard-f41b8";
const FS = process.env.FS_BASE || "https://firestore.googleapis.com/v1";
const DB = `projects/${PROJECT}/databases/(default)/documents`;
const STOP_AFTER = Number(process.env.CL5_STOP_AFTER || 0);

const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
process.on("uncaughtException", (e) => die(`${(e && e.message) || e}`));
process.on("unhandledRejection", (e) => die(`${(e && e.message) || e}`));
if (!["apply", "verify"].includes(MODE)) die("Use: node cl5.mjs apply <backup>  or  node cl5.mjs verify <backup>");
if (!FILE || !fs.existsSync(FILE)) die("The backup file was not found.");
if (MODE === "apply" && !TOKEN) die("ACCESS_TOKEN is missing.");

const backup = JSON.parse(fs.readFileSync(FILE, "utf8"));
if (backup.project && backup.project !== PROJECT) die(`The backup is of ${backup.project}, not ${PROJECT}.`);
const plan = makePlan(backup);
const n = (x) => String(x);

function summary() {
  console.log("");
  console.log("KEPT, NOT TOUCHED:");
  for (const g of plan.protected) console.log(`  ${g.name}  (${g.roster} golfers, ${g.members} members, ${g.rounds} rounds)`);
  console.log("");
  console.log(`ORPHAN GROUPS TO REMOVE: ${plan.orphans.length}`);
  for (const g of plan.orphans) console.log(`  ${g.name}  [${g.id}]  rounds ${g.counts.rounds || 0}, members ${g.counts.members || 0}, roster ${g.counts.roster || 0}`);
  console.log("");
  console.log(`GOLFERS MOVING TO ${plan.philippine ? plan.philippine.name.toUpperCase() : "PHILIPPINE GOLFERS"}: ${plan.movedGolfers.length}`);
  for (const g of plan.movedGolfers) console.log(`  ${g.name}  (${g.rounds} rounds move with them)`);
  console.log(`ACCOUNTS JOINING PHILIPPINE GOLFERS: ${plan.newMembers.length}`);
  console.log(`LEFT AS THEY ARE: ${plan.copies.length} leftover golfer copies with no rounds, ${plan.skippedAccounts.length} old sign-ins with no email.`);
  for (const g of plan.copies) console.log(`  ${g.name}  (copy, no rounds)`);
  console.log("");
  console.log(`ROUNDS: ${plan.rounds.move} move, ${plan.rounds.copy} removed as copies of rounds already in your groups,`);
  console.log(`        ${plan.rounds.staying} removed belonging to golfers who stay in your groups (${plan.rounds.stayingInHandicap} of them count in a handicap now),`);
  console.log(`        ${plan.rounds.noGolfer} removed with no golfer.`);
  console.log(`GOLFER RECORDS UPDATED: ${plan.golferRecords}.  HANDICAPS THAT CHANGE: ${plan.handicapChanges.length}.`);
  console.log(`DOCUMENTS REMOVED IN ALL: ${plan.removals}.`);
  console.log("");
}

if (MODE === "verify") {
  if (plan.stops.length) die(plan.stops.join(" "));
  const left = plan.steps.reduce((t, s) => t + s.writes.length, 0);
  if (plan.orphans.length || left) die(`not finished: ${plan.orphans.length} orphan group(s), ${left} change(s) still to do. Run bash cl5.txt again.`);
  console.log(`OK: only your ${plan.protected.length} groups remain, and every golfer and account is in one of them.`);
  process.exit(0);
}

/* apply */
if (plan.stops.length) { summary(); die(`Nothing was changed. ${plan.stops.join(" ")}`); }
if (!plan.steps.length) { console.log("OK: there is nothing to clean up."); process.exit(0); }
summary();
const answer = await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Type yes to clean up: ", (a) => { rl.close(); resolve(String(a || "").trim()); });
});
if (answer !== "yes") die("Stopped. Nothing was changed.");

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
if (TOKEN !== "owner") headers["x-goog-user-project"] = PROJECT;
const toRest = (w) => {
  const name = `${DB}/${w.path}`;
  if (w.op === "delete") return { delete: name };
  if (w.op === "create") return { update: { name, fields: w.fields }, currentDocument: { exists: false } };
  if (w.op === "set") return { update: { name, fields: w.fields } };
  return { update: { name, fields: w.fields }, updateMask: { fieldPaths: w.mask }, currentDocument: { updateTime: w.updateTime } };
};
let done = 0;
for (const [i, step] of plan.steps.entries()) {
  if (STOP_AFTER && done >= STOP_AFTER) die(`stopped on purpose after ${done} steps (test).`);
  const r = await fetch(`${FS}/${DB}:commit`, { method: "POST", headers, body: JSON.stringify({ writes: step.writes.map(toRest) }) });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 300);
    console.error("");
    console.error(`Step ${i + 1} of ${plan.steps.length} (${step.label}) was refused: HTTP ${r.status} ${text}`);
    console.error("Nothing in that step was written; every step before it is complete.");
    die("Run bash cl5.txt again: it takes a new backup and carries on from here.");
  }
  done++;
  console.log(`  ${n(i + 1)}/${plan.steps.length}  ${step.label}`);
}
console.log("CLEAN-UP DONE.");
