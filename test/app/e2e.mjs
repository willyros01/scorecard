/* End-to-end app tests against the Firebase emulators (Version 2.0).
 *
 * The real app, served on this test machine at http://localhost:8000 with
 * ?emulators=1, so it talks only to the emulators started by test/ops/run.sh:
 * a demo project that cannot reach any live data. Chromium only.
 *
 * E1–E9: the PUBLIC group from both sides (Phase C) — apply while signed out,
 * approve as the owner, choose a password from the email, sign in and land in
 * the group, report and block a name, and deal with the report — plus the
 * Phase A and B basics on the way (no anonymous sign-in, own membership only).
 *
 * Usage (inside firebase emulators:exec): node test/app/e2e.mjs <site-dir>
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";

const SITE = path.resolve(process.argv[2] || ".");
const PORT = 8000;
const APP = `http://localhost:${PORT}/?emulators=1`;
const P = "demo-scorecard";
const FS = `http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents`;
const FS_ADMIN = `http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const AUTH_ADMIN = `http://127.0.0.1:9099/emulator/v1/projects/${P}`;
const OWNER = { Authorization: "Bearer owner" };   // the emulator's rules-bypassing token, for seeding and checking only

let passed = 0, failed = 0;
const pass = (id, what) => { passed++; console.log(`PASS  ${id}  ${what}`); };
const fail = (id, what, why) => { failed++; console.log(`FAIL  ${id}  ${what}${why ? `  —  ${why}` : ""}`); };
async function check(id, what, fn) {
  try { const r = await fn(); if (r === false) fail(id, what); else pass(id, what); }
  catch (e) { fail(id, what, String(e && e.message || e).split("\n")[0]); }
}

/* ---- the emulators, directly ---- */
const value = (v) => v === null ? { nullValue: null }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : typeof v === "number" ? { doubleValue: v }
  : typeof v === "boolean" ? { booleanValue: v }
  : { stringValue: String(v) };
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));
async function put(docPath, data) {
  const r = await fetch(`${FS}:commit`, { method: "POST", headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify({ writes: [{ update: { name: `projects/${P}/databases/(default)/documents/${docPath}`, fields: fields(data) } }] }) });
  if (!r.ok) throw new Error(`seed ${docPath}: ${r.status}`);
}
async function getDoc(docPath) {
  const r = await fetch(`${FS}/${docPath}`, { headers: OWNER });
  if (r.status === 404) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, Object.values(v)[0]]));
}
async function list(collPath) {
  const r = await fetch(`${FS}/${collPath}?pageSize=300`, { headers: OWNER });
  const j = await r.json();
  return (j.documents || []).map((d) => ({ id: d.name.split("/").pop(),
    ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, Object.values(v)[0]])) }));
}
async function signUp(email, password) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake-api-key`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json();
  if (!j.localId) throw new Error(`sign-up ${email}: ${JSON.stringify(j)}`);
  return j.localId;
}
async function accountByEmail(email) {
  const r = await fetch(`${AUTH}/projects/${P}/accounts:lookup`, { method: "POST", headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify({ email: [email] }) });
  const j = await r.json();
  return (j.users || [])[0] || null;
}
/* What the applicant does with the approval email: open the link, choose a password. */
async function usePasswordEmail(email, newPassword) {
  const r = await fetch(`${AUTH_ADMIN}/oobCodes`);
  const codes = ((await r.json()).oobCodes || []).filter((c) => c.email === email && c.requestType === "PASSWORD_RESET");
  if (!codes.length) throw new Error("no password email was sent");
  const code = codes[codes.length - 1].oobCode;
  const done = await fetch(`${AUTH}/accounts:resetPassword?key=fake-api-key`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oobCode: code, newPassword }) });
  if (!done.ok) throw new Error(`resetPassword ${done.status}`);
}

/* ---- the app ---- */
const text = (page) => page.evaluate(() => document.body.innerText);
async function waitForText(page, re, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(await text(page))) return; await page.waitForTimeout(300); }
  throw new Error(`text ${re} did not appear; the screen says: ${(await text(page)).replace(/\s+/g, " ").slice(0, 300)}`);
}
async function signIn(page, email, password) {
  await page.fill('[name="email"]', email);
  await page.fill('[name="password"]', password);
  await page.locator('[data-act="sign-in"]').first().click();
}
async function tab(page, id) { await page.locator(`button[data-tab="${id}"]`).click(); await page.waitForTimeout(400); }

/* ---- seed: the PUBLIC group, run by Willy's stand-in, with one member ---- */
const W = { email: "owner@example.com", password: "owner-pass-1" };
const M = { email: "mia@example.com", password: "mia-pass-1" };
const APPLICANT = { name: "Pat Applicant", email: "pat.applicant@example.com", password: "pat-chosen-1" };
/* A clean emulator: the rules tests before this leave their data behind. */
await fetch(`${FS_ADMIN}`, { method: "DELETE", headers: OWNER });
await fetch(`${AUTH_ADMIN}/accounts`, { method: "DELETE", headers: OWNER });
W.uid = await signUp(W.email, W.password);
M.uid = await signUp(M.email, M.password);
await put("associations/PUBLIC", { name: "PUBLIC", ownerUid: W.uid });
await put(`associations/PUBLIC/members/${W.uid}`, { uid: W.uid, role: "owner", displayName: "Owner" });
await put(`associations/PUBLIC/members/${M.uid}`, { uid: M.uid, role: "member", displayName: "Mia Member", golferId: "gM" });
await put(`userGroups/${W.uid}/groups/PUBLIC`, { assocId: "PUBLIC", name: "PUBLIC" });
await put(`userGroups/${M.uid}/groups/PUBLIC`, { assocId: "PUBLIC", name: "PUBLIC" });
await put("golfers/gM", { name: "Mia Member", nameKey: "mia-member", linkedUid: M.uid, groups: ["PUBLIC"], handicapIndex: 10.0 });
await put("golferNames/mia-member", { golferId: "gM", name: "Mia Member" });
await put("associations/PUBLIC/roster/gM", { golferId: "gM" });
await put("associations/PUBLIC/directory/gM", { golferId: "gM", displayName: "Mia Member", handicapIndex: 10.0 });

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", SITE], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
setTimeout(() => { console.log("FAIL  WATCHDOG  the app tests took longer than 10 minutes"); server.kill(); process.exit(1); }, 10 * 60 * 1000).unref();

const browser = await chromium.launch();
const newPage = async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => {
    /* The first of each error with where it happened, so a failure here says
       what to fix. */
    const line = String(e.message || e);
    if (!page.errors.includes(line)) { page.errors.push(line); console.log(`      page error: ${String(e.stack || e).split("\n").slice(0, 8).join(" <- ")}`); }
  });
  return page;
};

/* E1–E2: the applicant, signed out */
const pat = await newPage();
await pat.goto(APP, { waitUntil: "load" });
await check("E1", "signed out: Sign in and Apply, and no sign-in happens by itself", async () => {
  await waitForText(pat, /Apply to join the public group/);
  await pat.waitForTimeout(2000);
  const signedIn = await pat.evaluate(async () => (await import("/store.js")).hasUser());
  if (signedIn) throw new Error("somebody is signed in");
});
await check("E2", "the applicant applies with full name and email; the application is stored as pending", async () => {
  await pat.locator('[data-act="show-apply"]').click();
  await pat.fill('[name="apply-name"]', APPLICANT.name);
  await pat.fill('[name="apply-email"]', APPLICANT.email);
  await pat.locator('[data-act="submit-application"]').click();
  await waitForText(pat, /Application sent/);
  const a = await getDoc(`publicApplications/${APPLICANT.email}`);
  if (!a || a.status !== "pending" || a.fullName !== APPLICANT.name) throw new Error(JSON.stringify(a));
  if (await accountByEmail(APPLICANT.email)) throw new Error("an account was created before approval");
});
await check("E2b", "a second application for the same email is refused with a clear message", async () => {
  await pat.locator('[data-act="hide-apply"]').click();
  await pat.locator('[data-act="show-apply"]').click();
  await pat.fill('[name="apply-name"]', "Someone Else");
  await pat.fill('[name="apply-email"]', APPLICANT.email);
  await pat.locator('[data-act="submit-application"]').click();
  await waitForText(pat, /already an application for that email/);
  await pat.locator('[data-act="hide-apply"]').click();
});

/* E3–E4: the owner reviews */
const owner = await newPage();
await owner.goto(APP, { waitUntil: "load" });
await check("E3", "the owner signs in, lands in PUBLIC and sees the application on the Admin tab", async () => {
  await waitForText(owner, /Sign in/);
  await signIn(owner, W.email, W.password);
  await waitForText(owner, /Admin \(1\)/);
  await tab(owner, "admin");
  await waitForText(owner, new RegExp(APPLICANT.name));
});
await check("E4", "approving creates the account, the golfer, the directory entry and the approval, and sends the password email", async () => {
  await owner.locator('[data-act="review-application"]').first().click();
  await owner.fill('[name="approve-name"]', APPLICANT.name);
  await owner.locator('[data-pc="approve"]').click();
  await waitForText(owner, /is approved/);
  const account = await accountByEmail(APPLICANT.email);
  if (!account) throw new Error("no account was created");
  const approval = await getDoc(`publicApprovals/${APPLICANT.email}`);
  if (!approval || !approval.golferId) throw new Error("no approval");
  const golfer = await getDoc(`golfers/${approval.golferId}`);
  if (!golfer || golfer.name !== APPLICANT.name) throw new Error("no golfer");
  if (!(await getDoc(`associations/PUBLIC/directory/${approval.golferId}`))) throw new Error("no directory entry");
  if (!(await getDoc(`associations/PUBLIC/roster/${approval.golferId}`))) throw new Error("not on the roster");
  const app = await getDoc(`publicApplications/${APPLICANT.email}`);
  if (app.status !== "approved") throw new Error(`application is ${app.status}`);
  const signedInAs = await owner.evaluate(async () => (await import("/store.js")).currentEmail());
  if (signedInAs !== W.email) throw new Error(`the owner's device is now signed in as ${signedInAs}`);
});
await check("E4b", "a name already in use is refused and the owner is asked to change it", async () => {
  await put("publicApplications/second@example.com", { fullName: "Mia Member", email: "second@example.com", status: "pending" });
  await waitForText(owner, /second@example\.com/);
  await owner.locator('[data-act="review-application"]').first().click();
  await owner.locator('[data-pc="approve"]').click();
  await waitForText(owner, /already used/);
  if (await accountByEmail("second@example.com")) throw new Error("an account was made for a refused approval");
  await owner.locator('[data-close="1"]').first().click().catch(() => {});
});

/* E5: the applicant chooses a password from the email and signs in */
await check("E5", "the applicant chooses a password from the email, signs in and is in the PUBLIC group", async () => {
  await usePasswordEmail(APPLICANT.email, APPLICANT.password);
  await waitForText(pat, /Sign in/);
  await signIn(pat, APPLICANT.email, APPLICANT.password);
  await waitForText(pat, /Welcome to the public group/);
  const uid = (await accountByEmail(APPLICANT.email)).localId;
  const member = await getDoc(`associations/PUBLIC/members/${uid}`);
  if (!member || member.role !== "member") throw new Error("no membership");
  if (await getDoc(`publicApprovals/${APPLICANT.email}`)) throw new Error("the approval was not removed");
  const golfer = await getDoc(`golfers/${member.golferId}`);
  if (golfer.linkedUid !== uid) throw new Error("the golfer is not linked");
});

console.log(`      after E5 the member's screen says: ${(await text(pat)).replace(/\s+/g, " ").slice(0, 400)}`);

/* E6–E8: the new member reports and blocks */
await check("E6", "the member sees the group ranking with Report or block beside other golfers", async () => {
  await tab(pat, "summary");
  await waitForText(pat, /Group ranking/);
  await waitForText(pat, /Mia Member/);
  if (!(await pat.locator('[data-act="golfer-actions"][data-id="gM"]').count())) throw new Error("no Report or block for Mia");
});
await check("E7", "reporting a name reaches the reviewers", async () => {
  await pat.locator('[data-act="golfer-actions"][data-id="gM"]').click();
  await pat.fill('[name="report-reason"]', "Test report");
  await pat.locator('[data-pc="report"]').click();
  await waitForText(pat, /Report sent/);
  const reports = await list("associations/PUBLIC/reports");
  if (reports.length !== 1 || reports[0].golferId !== "gM" || reports[0].reason !== "Test report") throw new Error(JSON.stringify(reports));
});
await check("E8", "blocking hides the golfer from the member's ranking; unblocking brings them back", async () => {
  await pat.locator('[data-act="golfer-actions"][data-id="gM"]').click();
  await pat.locator('[data-pc="block"]').click();
  await waitForText(pat, /Golfers you blocked/);
  if (await pat.locator('[data-act="golfer-actions"][data-id="gM"]').count()) throw new Error("still in the ranking");
  await pat.locator('[data-act="unblock"]').click();
  await waitForText(pat, /Unblocked/);
  await pat.waitForTimeout(800);
  if (!(await pat.locator('[data-act="golfer-actions"][data-id="gM"]').count())) throw new Error("did not come back");
});
await check("E8b", "a regular member reads only their own membership, and no errors appeared", async () => {
  const n = await pat.evaluate(() => new Promise((resolve) => {
    import("/store.js").then((db) => { const stop = db.watchMembers((list) => { resolve(list.length); }); });
  }));
  if (n !== 1) throw new Error(`the member list has ${n} entries`);
  if (/Firestore refused|Firebase returned an error/.test(await text(pat))) throw new Error("an error is on screen");
  if (pat.errors.length) throw new Error(pat.errors.join(" | "));
});

/* E9: the owner deals with the report */
await check("E9", "the owner sees the report and dismisses it", async () => {
  await tab(owner, "admin");
  await waitForText(owner, /Test report/);
  await owner.locator('[data-act="dismiss-report"]').first().click();
  await waitForText(owner, /Report dismissed/);
  if ((await list("associations/PUBLIC/reports")).length) throw new Error("the report is still there");
  if (owner.errors.length) throw new Error(owner.errors.join(" | "));
});

await browser.close();
server.kill();
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
