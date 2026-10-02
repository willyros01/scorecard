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
async function getDocQuick(docPath) { try { return await getDoc(docPath); } catch { return null; } }
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
/* beta.4: the Admin tab's own tabs (Cockpit, Applications, Members, Settings). */
async function subtab(page, id) { await page.locator(`[data-act="admin-tab"][data-id="${id}"]`).first().click(); await page.waitForTimeout(400); }

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

/* Phase D: Willy is the only group creator, and owns a private group G1 with
   an admin, a regular member, and two golfers not yet joined. */
const A1 = { email: "admin1@example.com", password: "admin1-pass-1" };
const R1 = { email: "rex@example.com", password: "rex-pass-1" };
A1.uid = await signUp(A1.email, A1.password);
R1.uid = await signUp(R1.email, R1.password);
await put(`groupCreators/${W.uid}`, { note: "set by the setup script" });
await put("associations/G1", { name: "Saturday Group", ownerUid: W.uid, joinCode: "PRIV01" });
await put("associations/G1/secrets/admin", { adminCode: "ADM001" });
await put(`associations/G1/members/${W.uid}`, { uid: W.uid, role: "owner", displayName: "Owner" });
await put(`associations/G1/members/${A1.uid}`, { uid: A1.uid, role: "admin", displayName: "Ada Admin" });
await put(`associations/G1/members/${R1.uid}`, { uid: R1.uid, role: "member", displayName: "Rex Regular", golferId: "gR" });
await put(`userGroups/${A1.uid}/groups/G1`, { assocId: "G1", name: "Saturday Group" });
/* Go-live fix 1: the named invitation for Ivy, as the owner's app writes it. */
await put("associations/G1/invitations/gI", { golferId: "gI", name: "Ivy Invitee", handicapIndex: null, groupName: "Saturday Group", role: "member", sentBy: W.uid });
/* Go-live fix 2: a second reviewer of the public group. */
const R2 = { email: "reviewer2@example.com", password: "reviewer2-pass-1" };
R2.uid = await signUp(R2.email, R2.password);
await put(`associations/PUBLIC/members/${R2.uid}`, { uid: R2.uid, role: "admin", displayName: "Rita Reviewer" });
await put(`userGroups/${R2.uid}/groups/PUBLIC`, { assocId: "PUBLIC", name: "PUBLIC" });
/* For Tidy (E14): one person recorded twice in G1, and one unused golfer. */
await put("golfers/gD1", { name: "Dup Person", nameKey: "dup-person", linkedUid: null, groups: ["G1"], roundCount: 0 });
await put("golfers/gD2", { name: "Dup Person", nameKey: "dup-person", linkedUid: null, groups: ["G1"], roundCount: 0 });
await put("golferNames/dup-person", { golferId: "gD1", name: "Dup Person" });
await put("associations/G1/roster/gD1", { golferId: "gD1" });
await put("associations/G1/roster/gD2", { golferId: "gD2" });
await put("associations/G1/rounds/rD1", { id: "rD1", golferId: "gD1", assocId: "G1", date: "2026-09-01", differential: 10.0, gross: 85 });
await put("associations/G1/rounds/rD2", { id: "rD2", golferId: "gD1", assocId: "G1", date: "2026-09-02", differential: 12.0, gross: 87 });
await put("associations/G1/rounds/rD3", { id: "rD3", golferId: "gD2", assocId: "G1", date: "2026-09-03", differential: 11.0, gross: 86 });
await put("golfers/gU", { name: "Una Unused", nameKey: "una-unused", linkedUid: null, groups: ["G1"] });
await put("golferNames/una-unused", { golferId: "gU", name: "Una Unused" });
for (const [id, name, linked] of [["gR", "Rex Regular", R1.uid], ["gI", "Ivy Invitee", null], ["gJ", "Jay Unjoined", null]]) {
  await put(`golfers/${id}`, { name, nameKey: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), linkedUid: linked, groups: ["G1"] });
  await put(`golferNames/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, { golferId: id, name });
  await put(`associations/G1/roster/${id}`, { golferId: id });
  await put(`associations/G1/directory/${id}`, { golferId: id, displayName: name, handicapIndex: null });
}

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", SITE], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
setTimeout(() => { console.log("FAIL  WATCHDOG  the app tests took longer than 10 minutes"); server.kill(); process.exit(1); }, 10 * 60 * 1000).unref();

const browser = await chromium.launch();
/* beta.5: every test device has accepted the Terms of Use, except where a test
   sets globalThis.__termsFresh to see the first-open screen itself (E24). */
{
  const _newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => {
    const c = await _newContext(...a);
    if (!globalThis.__termsFresh) await c.addInitScript(() => { try { if (!localStorage.getItem("golf:terms")) localStorage.setItem("golf:terms", JSON.stringify({ version: 1, at: 1 })); } catch {} });
    return c;
  };
}
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
await check("E1", "signed out: Sign in, I have a code, Become a member or start a group; no sign-in happens by itself", async () => {
  await waitForText(pat, /Become a member or start a group/);
  if (!/I have a code/.test(await text(pat))) throw new Error("no I have a code button");
  await pat.waitForTimeout(2000);
  const signedIn = await pat.evaluate(async () => (await import("/store.js")).hasUser());
  if (signedIn) throw new Error("somebody is signed in");
});
await check("E2", "the applicant applies with full name and email; the application is stored as pending", async () => {
  await pat.locator('[data-act="show-choose"]').click();
  await pat.locator('[data-act="show-apply"]').click();
  await waitForText(pat, /What happens next/);
  await pat.fill('[name="apply-name"]', APPLICANT.name);
  await pat.fill('[name="apply-email"]', APPLICANT.email);
  await pat.locator('[data-act="submit-application"]').click();
  await waitForText(pat, /Tick the box to agree/);
  if (await getDoc(`publicApplications/${APPLICANT.email}`)) throw new Error("sent without agreeing to the conditions");
  await pat.fill('[name="apply-name"]', APPLICANT.name);
  await pat.fill('[name="apply-email"]', APPLICANT.email);
  await pat.locator('[name="ap-agree"]').check();
  await pat.locator('[data-act="submit-application"]').click();
  try { await waitForText(pat, /Application sent/); }
  catch (e) {
    const why = await pat.evaluate(async (em) => { const db = await import("/store.js"); const has = await db.emailHasAccount(em); return `has=${has} error=${db.accountCheckError()}`; }, APPLICANT.email);
    throw new Error(`${e.message} | check: ${why}`);
  }
  const a = await getDoc(`publicApplications/${APPLICANT.email}`);
  if (!a || a.status !== "pending" || a.fullName !== APPLICANT.name) throw new Error(JSON.stringify(a));
  if (await accountByEmail(APPLICANT.email)) throw new Error("an account was created before approval");
});
await check("E2b", "a second application for the same email is refused with a clear message", async () => {
  await pat.locator('[data-act="hide-apply"]').click();
  await pat.locator('[data-act="show-choose"]').click();
  await pat.locator('[data-act="show-apply"]').click();
  await pat.fill('[name="apply-name"]', "Someone Else");
  await pat.fill('[name="apply-email"]', APPLICANT.email);
  await pat.locator('[name="ap-agree"]').check();
  await pat.locator('[data-act="submit-application"]').click();
  await waitForText(pat, /already an application for that email/);
  await pat.locator('[data-act="show-choose"]').click();
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
  await subtab(owner, "applications");
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
  await owner.locator('[data-act="review-application"][data-id="second@example.com"]').click();
  /* beta.4 (Willy, Oct 1): the next free number is filled in for a taken name. */
  const end = Date.now() + 10000;
  let v = "";
  while (Date.now() < end && (v = await owner.inputValue('[name="approve-name"]')) !== "Mia Member 1") await owner.waitForTimeout(300);
  if (v !== "Mia Member 1") throw new Error(`the name offered is "${v}", not "Mia Member 1"`);
  /* Typing the taken name back is still refused, as before. */
  await owner.fill('[name="approve-name"]', "Mia Member");
  await owner.locator('[data-pc="approve"]').click();
  await waitForText(owner, /already used/);
  if (await accountByEmail("second@example.com")) throw new Error("an account was made for a refused approval");
  await owner.locator('[data-close="1"]').first().click().catch(() => {});
});

/* E4c–E4d: go-live fix 2 — retry, and two reviewers at once */
await check("E4c", "an approval interrupted part-way is finished by the same reviewer, with the same golfer", async () => {
  await put("publicApplications/retry@example.com", { fullName: "Ray Retry", email: "retry@example.com", status: "approving",
    reviewedBy: W.uid, golferId: "gRetry", golferName: "Ray Retry" });
  await waitForText(owner, /approval not finished/);
  await owner.locator('[data-act="review-application"][data-id="retry@example.com"]').click();
  await owner.locator('[data-pc="approve"]').click();
  await waitForText(owner, /Ray Retry is approved/);
  const app = await getDoc("publicApplications/retry@example.com");
  if (app.status !== "approved" || app.golferId !== "gRetry") throw new Error(JSON.stringify(app));
  if ((await getDoc("golfers/gRetry")).name !== "Ray Retry") throw new Error("the claimed golfer was not used");
  if ((await getDoc("publicApprovals/retry@example.com")).golferId !== "gRetry") throw new Error("approval names another golfer");
  if (!(await accountByEmail("retry@example.com"))) throw new Error("no account");
});
const rita = await newPage();
await rita.goto(APP, { waitUntil: "load" });
await check("E4d", "two reviewers approving the same application at once: exactly one approval, one golfer, one account", async () => {
  await waitForText(rita, /Sign in/);
  await signIn(rita, R2.email, R2.password);
  await waitForText(rita, /Admin/);
  await tab(rita, "admin");
  await subtab(rita, "applications");
  await put("publicApplications/both@example.com", { fullName: "Bo Both", email: "both@example.com", status: "pending" });
  await waitForText(owner, /both@example\.com/);
  await waitForText(rita, /both@example\.com/);
  for (const p of [owner, rita]) await p.locator('[data-act="review-application"][data-id="both@example.com"]').click();
  /* Every message each page shows, kept, since a message stays only 3 seconds. */
  for (const p of [owner, rita]) await p.evaluate(() => {
    window.__seen = [];
    new MutationObserver(() => window.__seen.push(document.body.innerText.slice(0, 400))).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await Promise.all([owner, rita].map((p) => p.locator('[data-pc="approve"]').click()));
  const said = async (p) => { const end = Date.now() + 25000;
    while (Date.now() < end) {
      const seen = (await p.evaluate(() => window.__seen.join("\n"))) + (await text(p));
      const m = seen.match(/Bo Both is approved|already approved|Another reviewer is approving|did not finish[^\n]*/);
      if (m) return m[0];
      await p.waitForTimeout(300);
    }
    return "nothing"; };
  const messages = await Promise.all([owner, rita].map(said));
  if (messages.some((m) => !/Bo Both is approved|already approved|Another reviewer is approving/.test(m))) throw new Error(`messages: ${messages.join(" / ")}`);
  const app = await getDoc("publicApplications/both@example.com");
  if (app.status !== "approved") throw new Error(`application is ${app.status}`);
  const golfers = (await list("golfers")).filter((g) => g.name === "Bo Both");
  if (golfers.length !== 1 || golfers[0].id !== app.golferId) throw new Error(`${golfers.length} golfer record(s) for Bo Both`);
  if ((await getDoc("publicApprovals/both@example.com")).golferId !== app.golferId) throw new Error("approval names another golfer");
  if (owner.errors.length || rita.errors.length) throw new Error([...owner.errors, ...rita.errors].join(" | "));
});

/* E5: the applicant chooses a password from the email and signs in */
await check("E5", "the applicant chooses a password from the email, signs in and is in the PUBLIC group", async () => {
  await usePasswordEmail(APPLICANT.email, APPLICANT.password);
  await waitForText(pat, /Sign in/);
  await signIn(pat, APPLICANT.email, APPLICANT.password);
  const uid = (await accountByEmail(APPLICANT.email)).localId;
  /* The welcome message is brief; what matters is that the app is in the group. */
  const end = Date.now() + 20000;
  while (Date.now() < end && (await pat.evaluate(async () => (await import("/store.js")).currentAssociation())) !== "PUBLIC") await pat.waitForTimeout(300);
  if ((await pat.evaluate(async () => (await import("/store.js")).currentAssociation())) !== "PUBLIC") throw new Error("the app is not in the PUBLIC group");
  await waitForText(pat, /Enter/);
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
  await subtab(owner, "applications");
  await waitForText(owner, /Test report/);
  await owner.locator('[data-act="dismiss-report"]').first().click();
  await waitForText(owner, /Report dismissed/);
  if ((await list("associations/PUBLIC/reports")).length) throw new Error("the report is still there");
  if (owner.errors.length) throw new Error(owner.errors.join(" | "));
});

/* E10: group creation is Willy's alone */
async function switcherText(page) {
  await page.locator("#brandSub").click();
  await page.waitForTimeout(600);
  const t = await text(page);
  await page.locator('[data-close="1"]').first().click().catch(() => {});
  return t;
}
await check("E10", "only the group creator is offered Start another group", async () => {
  if (!/Start another group/.test(await switcherText(owner))) throw new Error("Willy is not offered it");
  if (/Start another group/.test(await switcherText(pat))) throw new Error("a public-group member is offered it");
});

/* E11: Phase D — a private invitation while signed out needs an account first */
const ivy = await newPage();
await ivy.goto(`${APP}&join=G1.PRIV01.gI`, { waitUntil: "load" });
await check("E11", "a named private invitation: create an account, then join as the invited golfer", async () => {
  await waitForText(ivy, /You.re invited/);
  await ivy.fill('[name="email"]', "ivy@example.com");
  await ivy.fill('[name="password"]', "ivy-pass-1");
  await ivy.fill('[name="password-again"]', "ivy-pass-1");
  await ivy.locator('[data-act="create-account"]').click();
  await waitForText(ivy, /Ivy Invitee/);
  if (!/Saturday Group/i.test(await text(ivy))) throw new Error("the group name is not shown on the invitation");
  const blocked = await ivy.evaluate(async () => {
    const db = await import("/store.js");
    return db.invitationFor("G1", "gJ").then((x) => x === null);
  });
  if (!blocked) throw new Error("an invitation record exists for a golfer never invited");
  await ivy.locator('[data-act="accept-named"]').click();
  const end = Date.now() + 20000;
  while (Date.now() < end && (await ivy.evaluate(async () => (await import("/store.js")).currentAssociation())) !== "G1") await ivy.waitForTimeout(300);
  const uid = (await accountByEmail("ivy@example.com")).localId;
  const member = await getDoc(`associations/G1/members/${uid}`);
  if (!member || member.role !== "member") throw new Error(`membership: ${JSON.stringify(member)}`);
  const golfer = await getDoc("golfers/gI");
  if (golfer.linkedUid !== uid) throw new Error("the golfer is not linked to the new account");
  if (ivy.errors.length) throw new Error(ivy.errors.join(" | "));
});

/* E12–E13: an admin (not the owner) */
const ada = await newPage();
await ada.goto(APP, { waitUntil: "load" });
await check("E12", "an admin invites regular members only: no Admin choice on the invitation", async () => {
  await waitForText(ada, /Sign in/);
  await signIn(ada, A1.email, A1.password);
  await waitForText(ada, /Saturday Group/i);
  await tab(ada, "manage");
  await ada.locator('[data-invite-golfer="gJ"]').first().click();
  await waitForText(ada, /Invite Jay Unjoined/);
  if (await ada.locator('[name="invite-role"][value="admin"]').count()) throw new Error("the admin choice is offered to an admin");
  await ada.locator('[data-invite="send"]').click();
  /* Go-live fix 1: sending writes the invitation record the invitee is greeted from. */
  const end = Date.now() + 15000;
  let inv = null;
  while (Date.now() < end && !(inv = await getDoc("associations/G1/invitations/gJ"))) await ada.waitForTimeout(400);
  if (!inv || inv.name !== "Jay Unjoined" || inv.role !== "member" || inv.groupName !== "Saturday Group") throw new Error(`invitation record: ${JSON.stringify(inv)}`);
  await ada.locator('[data-close="1"]').first().click().catch(() => {});
  if (/Start another group/.test(await switcherText(ada))) throw new Error("an admin is offered Start another group");
});
await check("E13", "an admin removes a regular member of their group, and has no button for the owner", async () => {
  await tab(ada, "admin");
  await subtab(ada, "members");
  await waitForText(ada, /Rex Regular/);
  if (await ada.locator(`[data-drop-member="${W.uid}"]`).count()) throw new Error("a remove button for the owner");
  await ada.locator(`[data-drop-member="${R1.uid}"]`).click();
  await waitForText(ada, /no longer have access/);
  if (await getDoc(`associations/G1/members/${R1.uid}`)) throw new Error("Rex is still a member");
  if (ada.errors.length) throw new Error(ada.errors.join(" | "));
});

/* E15–E17: beta.3, a request for a private group, approved by Willy */
const ORG = { name: "Olga Organiser", email: "olga@example.com", password: "olga-pass-1", group: "Tuesday Golfers" };
const olga = await newPage();
await olga.goto(APP, { waitUntil: "load" });
await check("E15", "signed out: Start your own group sends a request (only after agreeing to the conditions)", async () => {
  await waitForText(olga, /Become a member or start a group/);
  await olga.locator('[data-act="show-choose"]').click();
  await olga.locator('[data-act="show-request"]').click();
  await waitForText(olga, /Start your own group/);
  const fill = async () => {
    await olga.fill('[name="rq-name"]', ORG.name);
    await olga.fill('[name="rq-email"]', ORG.email);
    await olga.fill('[name="rq-group"]', ORG.group);
    await olga.fill('[name="rq-size"]', "20");
    await olga.fill('[name="rq-where"]', "Glen Abbey");
  };
  await fill();
  await olga.locator('[data-act="submit-request"]').click();
  await waitForText(olga, /Tick the box to agree/);
  if (await getDoc(`groupRequests/${ORG.email}`)) throw new Error("sent without agreeing to the conditions");
  await fill();
  await olga.locator('[name="rq-agree"]').check();
  await olga.locator('[data-act="submit-request"]').click();
  await waitForText(olga, /Request sent/);
  const r = await getDoc(`groupRequests/${ORG.email}`);
  if (!r || r.status !== "pending" || r.groupName !== ORG.group || r.golfers !== "20" || r.where !== "Glen Abbey") throw new Error(JSON.stringify(r));
  if (await accountByEmail(ORG.email)) throw new Error("an account was created by the request");
  await olga.locator('[data-act="hide-apply"]').click();
  await olga.locator('[data-act="show-choose"]').click();
  await olga.locator('[data-act="show-request"]').click();
  await fill();
  await olga.locator('[name="rq-agree"]').check();
  await olga.locator('[data-act="submit-request"]').click();
  await waitForText(olga, /already a request for that email/);
  if (olga.errors.length) throw new Error(olga.errors.join(" | "));
});

const wil = await newPage();
await wil.goto(APP, { waitUntil: "load" });
let adminLink = "";
await check("E16", "Willy approves: the group is created with him as owner, the request is approved, and an admin invitation is ready to email to the organiser", async () => {
  await waitForText(wil, /Sign in/);
  await signIn(wil, W.email, W.password);
  await waitForText(wil, /Admin/);
  await tab(wil, "admin");
  await subtab(wil, "applications");
  await waitForText(wil, /Group requests/);
  await waitForText(wil, new RegExp(ORG.group));
  await wil.locator('[data-act="approve-request"]').first().click();
  await waitForText(wil, /Your private group is approved/, 30000);
  const r = await getDoc(`groupRequests/${ORG.email}`);
  if (!r || r.status !== "approved" || !r.groupId) throw new Error(`request: ${JSON.stringify(r)}`);
  const g = await getDoc(`associations/${r.groupId}`);
  if (!g || g.name !== ORG.group || g.ownerUid !== W.uid) throw new Error(`group: ${JSON.stringify(g)}`);
  const m = await getDoc(`associations/${r.groupId}/members/${W.uid}`);
  if (!m || m.role !== "owner") throw new Error(`Willy's membership: ${JSON.stringify(m)}`);
  if (await getDoc(`associations/${r.groupId}/roster/${W.uid}`)) throw new Error("Willy was put on the roster");
  const to = await wil.evaluate(() => (document.querySelector("[data-to]") || {}).dataset ? document.querySelector("[data-to]").dataset.to : "");
  if (to !== ORG.email) throw new Error(`the email is addressed to "${to}"`);
  const msg = await wil.evaluate(() => (document.querySelector("pre.msg") || {}).innerText || "");
  const found = /join=([A-Za-z0-9._-]+)&as=admin/.exec(msg);
  if (!found || !found[1].startsWith(`${r.groupId}.`)) throw new Error(`no admin invitation link in: ${msg.slice(0, 300)}`);
  adminLink = `${APP}&join=${found[1]}&as=admin`;
  await wil.locator('[data-close="1"]').first().click().catch(() => {});
  if (wil.errors.length) throw new Error(wil.errors.join(" | "));
});

await check("E17", "the organiser taps the link, creates an account and joins the new group as its admin", async () => {
  if (!adminLink) throw new Error("no link from E16");
  const r = await getDoc(`groupRequests/${ORG.email}`);
  const org = await newPage();
  await org.goto(adminLink, { waitUntil: "load" });
  await waitForText(org, /invited to help run a group/);
  await org.fill('[name="email"]', ORG.email);
  await org.fill('[name="password"]', ORG.password);
  await org.fill('[name="password-again"]', ORG.password);
  await org.locator('[data-act="create-account"]').click();
  await waitForText(org, /invited to help run the group/);
  await org.fill('[name="join-name"]', ORG.name);
  await org.locator('[data-act="accept-invite"]').click();
  const uid = (await accountByEmail(ORG.email)).localId;
  const end = Date.now() + 20000;
  let m = null;
  while (Date.now() < end && !(m = await getDoc(`associations/${r.groupId}/members/${uid}`))) await org.waitForTimeout(400);
  if (!m || m.role !== "admin") throw new Error(`membership: ${JSON.stringify(m)}`);
  if (org.errors.length) throw new Error(org.errors.join(" | "));
});

/* E18–E24: beta.4, the cockpit, Admin's tabs and the applications switch */
await check("E18", "the owner cockpit counts every group, and the owner's last seen is stamped", async () => {
  await tab(wil, "admin");
  await subtab(wil, "cockpit");
  await waitForText(wil, /Members, all groups/, 30000);
  const t = await text(wil);
  for (const name of ["Saturday Group", "Tuesday Golfers", "Public group"]) if (!t.includes(name)) throw new Error(`group ${name} missing from the cockpit`);
  if (!/Waiting for you/.test(t) || !/Housekeeping/.test(t)) throw new Error("a cockpit section is missing");
  const gid = await wil.evaluate(async () => (await import("/store.js")).currentAssociation());
  const end = Date.now() + 15000;
  let m = null;
  while (Date.now() < end && !((m = await getDocQuick(`associations/${gid}/members/${W.uid}`)) && m.lastSeenAt)) await wil.waitForTimeout(400);
  if (!m || !m.lastSeenAt) throw new Error("last seen was not stamped");
  await wil.locator('[data-act="cockpit-group"][data-id="G1"]').first().click();
  await waitForText(wil, /Back to all groups/);
  if (!/Ada Admin/.test(await text(wil))) throw new Error("the group's members are not listed");
  await wil.locator('[data-act="cockpit-group"][data-id=""]').first().click();
  await waitForText(wil, /Members, all groups/);
  if (wil.errors.length) throw new Error(wil.errors.join(" | "));
});
await check("E19", "the owner's Members tab is People as before, and Settings holds Group, Backup, Course lookup and Account", async () => {
  await subtab(wil, "members");
  await waitForText(wil, /People/);
  const t = await text(wil);
  if (!/invitation used/.test(t) || !/(Make guest|Make admin)/.test(t)) throw new Error(`People changed: ${t.replace(/\s+/g, " ").slice(0, 300)}`);
  await subtab(wil, "settings");
  await waitForText(wil, /Backup/);
  const s2 = await text(wil);
  if (!/Course lookup/.test(s2)) throw new Error("Course lookup is missing from Settings");
  if (await wil.locator('[data-act="admin-tab"]').count() !== 4) throw new Error("the owner should see four tabs");
});
await check("E20", "a group admin sees the mini cockpit of their own group, and two tabs only", async () => {
  await tab(ada, "admin");
  await subtab(ada, "cockpit");
  await waitForText(ada, /This group only/);
  const t = await text(ada);
  if (!/Last seen/.test(t) || !/Rounds this month/.test(t)) throw new Error("a mini cockpit section is missing");
  if (/Members, all groups/.test(t)) throw new Error("an admin sees the owner cockpit");
  if (await ada.locator('[data-act="admin-tab"]').count() !== 2) throw new Error("an admin should see Cockpit and Members only");
});
await check("E21", "an email that already has an account is stopped on screen; nothing is saved", async () => {
  const end = Date.now() + 15000;
  while (Date.now() < end && !(await getDocQuick(`accountEmails/${W.email}`))) await new Promise((r) => setTimeout(r, 400));
  if (!(await getDocQuick(`accountEmails/${W.email}`))) throw new Error("the owner's email was not recorded");
  const p = await newPage();
  await p.goto(APP, { waitUntil: "load" });
  await waitForText(p, /Become a member or start a group/);
  await p.locator('[data-act="show-choose"]').click();
  await p.locator('[data-act="show-apply"]').click();
  await waitForText(p, /What happens next/);
  await p.fill('[name="apply-name"]', "Someone Willy");
  await p.fill('[name="apply-email"]', W.email);
  await p.locator('[name="ap-agree"]').check();
  await p.locator('[data-act="submit-application"]').click();
  try { await waitForText(p, /This email already has an account/); }
  catch (e) {
    const why = await p.evaluate(async (em) => { const db = await import("/store.js"); const has = await db.emailHasAccount(em); return `has=${has} error=${db.accountCheckError()}`; }, W.email);
    throw new Error(`${e.message} | check: ${why}`);
  }
  if (await getDocQuick(`publicApplications/${W.email}`)) throw new Error("an application was saved");
});
async function turnSwitch(mode) {
  await tab(owner, "admin");
  await subtab(owner, "applications");
  await waitForText(owner, /Public group applications/);
  await owner.waitForSelector(".seg-b.on", { timeout: 15000 });
  await owner.locator(`[data-act="set-switch"][data-id="${mode}"]`).click();
  const end = Date.now() + 15000;
  let s = null;
  while (Date.now() < end && !((s = await getDocQuick("settings/publicApplications")) && s.mode === mode)) await owner.waitForTimeout(400);
  if (!s || s.mode !== mode) throw new Error(`the switch did not change to ${mode}: ${JSON.stringify(s)}`);
}
async function applyAndOpenLink(name, email) {
  const p = await newPage();
  await p.goto(APP, { waitUntil: "load" });
  await waitForText(p, /Become a member or start a group/);
  await p.locator('[data-act="show-choose"]').click();
  await p.locator('[data-act="show-apply"]').click();
  await waitForText(p, /You tap the link, which confirms your email/);
  await p.fill('[name="apply-name"]', name);
  await p.fill('[name="apply-email"]', email);
  await p.locator('[name="ap-agree"]').check();
  await p.locator('[data-act="submit-application"]').click();
  await waitForText(p, /Check your email/);
  if (await accountByEmail(email)) throw new Error("an account was created before the link was tapped");
  const r = await fetch(`${AUTH_ADMIN}/oobCodes`);
  const codes = ((await r.json()).oobCodes || []).filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN");
  if (!codes.length) throw new Error("no sign-in link was sent");
  const code = codes[codes.length - 1].oobCode;
  const q = await newPage();
  await q.goto(`${APP}&apply=1&apiKey=fake-api-key&mode=signIn&oobCode=${encodeURIComponent(code)}&lang=en`, { waitUntil: "load" });
  await waitForText(q, /Finish joining/);
  await q.fill('[name="email"]', email);
  await q.fill('[name="password"]', "auto-pass-1");
  await q.fill('[name="password-again"]', "auto-pass-1");
  await q.locator('[data-act="finish-apply"]').click();
  return q;
}
await check("E22", "Auto: the applicant taps the link, chooses a password and is in the public group by themselves", async () => {
  await turnSwitch("auto");
  const q = await applyAndOpenLink("Gwen Auto", "gwen.auto@example.com");
  await waitForText(q, /Welcome to the public group/, 30000);
  const acct = await accountByEmail("gwen.auto@example.com");
  if (!acct || !acct.emailVerified) throw new Error("no confirmed account");
  const uid = acct.localId;
  const m = await getDoc(`associations/PUBLIC/members/${uid}`);
  if (!m || m.role !== "member" || !m.golferId) throw new Error(`membership: ${JSON.stringify(m)}`);
  const g = await getDoc(`golfers/${m.golferId}`);
  if (!g || g.linkedUid !== uid || g.name !== "Gwen Auto") throw new Error(`golfer: ${JSON.stringify(g)}`);
  const end = Date.now() + 15000;
  let a = null;
  while (Date.now() < end && !((a = await getDoc("publicApplications/gwen.auto@example.com")) && a.status === "approved")) await q.waitForTimeout(400);
  if (!a || a.status !== "approved" || a.auto !== true) throw new Error(`application: ${JSON.stringify(a)}`);
  if (!(await getDoc(`associations/PUBLIC/roster/${m.golferId}`))) throw new Error("not on the public roster");
  if (!(await getDoc(`associations/PUBLIC/directory/${m.golferId}`))) throw new Error("not in the public directory");
  if (!(await getDoc("golferNames/gwen-auto"))) throw new Error("the name was not claimed");
  if (q.errors.length) throw new Error(q.errors.join(" | "));
});
await check("E23", "Auto: a name already taken waits for a reviewer, who sees the next number filled in", async () => {
  const q = await applyAndOpenLink("Mia Member", "mia.two@example.com");
  await waitForText(q, /waits for a person to review it/, 30000);
  const a = await getDoc("publicApplications/mia.two@example.com");
  if (!a || a.status !== "pending") throw new Error(`application: ${JSON.stringify(a)}`);
  const acct = await accountByEmail("mia.two@example.com");
  if (await getDoc(`associations/PUBLIC/members/${acct.localId}`)) throw new Error("joined although the name is taken");
  await tab(owner, "admin");
  await subtab(owner, "applications");
  await waitForText(owner, /mia\.two@example\.com/);
  const row = owner.locator('[data-act="review-application"][data-id="mia.two@example.com"]');
  await row.click();
  const end = Date.now() + 10000;
  let v = "";
  while (Date.now() < end && (v = await owner.inputValue('[name="approve-name"]')) !== "Mia Member 1") await owner.waitForTimeout(300);
  if (v !== "Mia Member 1") throw new Error(`the name offered is "${v}", not "Mia Member 1"`);
  await owner.locator('[data-close="1"]').first().click().catch(() => {});
  await turnSwitch("manual");
});

/* E14: Tidy, run by Willy, under the Version 2.0 rules */
await check("E14", "Tidy finds and fixes duplicates and unused golfers across Willy's groups", async () => {
  await owner.goto(`http://localhost:${PORT}/tidy.html?emulators=1`, { waitUntil: "load" });
  await waitForText(owner, /recorded twice or more/, 30000);
  const found = await text(owner);
  if (!/in no group, with no rounds/.test(found)) throw new Error(`the unused golfer was not found: ${found.replace(/\s+/g, " ").slice(0, 400)}`);
  await owner.locator("#fix").click();
  await waitForText(owner, /Done\. \d+ fixed/, 30000);
  const log = (await owner.evaluate(() => document.getElementById("log").innerText)).replace(/\s+/g, " ");
  const problems = [];
  if ((await getDoc("associations/G1/rounds/rD3")).golferId !== "gD1") problems.push("the duplicate's round was not moved");
  if (!(await getDoc("golfers/gD2")).archived) problems.push("the duplicate record was not archived");
  if (!(await getDoc("golfers/gU")).archived) problems.push("the unused golfer was not archived");
  const kept = await getDoc("golferNames/dup-person");
  if (!kept || kept.golferId !== "gD1") problems.push("the kept golfer's name claim was freed");
  if (await getDoc("golferNames/una-unused")) problems.push("the unused golfer's name was not freed");
  if (problems.length) {
    /* Say exactly what the rules answered for the same write. */
    const signed = await (await fetch(`${AUTH}/accounts:signInWithPassword?key=fake-api-key`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: W.email, password: W.password, returnSecureToken: true }) })).json();
    const probe = await fetch(`${FS}:commit`, { method: "POST", headers: { Authorization: `Bearer ${signed.idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes: [{ update: { name: `projects/${P}/databases/(default)/documents/golfers/gU`,
        fields: fields({ archived: true, archivedAt: Date.now(), nameKey: null, editedIn: "G1" }) },
        updateMask: { fieldPaths: ["archived", "archivedAt", "nameKey", "editedIn"] } }] }) });
    throw new Error(`${problems.join("; ")}. Tidy's log: ${log.slice(0, 400)} | the same write by Willy: HTTP ${probe.status} ${(await probe.text()).slice(0, 400)}`);
  }
});

/* E24 (beta.5): Tidy opens in the same window, already signed in, and Back
   returns to the Admin screen it was opened from. */
await check("E24", "Tidy opens from Admin already signed in; Back returns to the Admin cockpit", async () => {
  await owner.goto(APP, { waitUntil: "load" });
  await tab(owner, "admin");
  await subtab(owner, "cockpit");
  await owner.locator('[data-act="open-tool"][data-tool="tidy"]').first().click();
  await owner.waitForURL(/tidy\.html\?emulators=1/, { timeout: 15000 });
  await waitForText(owner, /Checked \d+ golfers|recorded twice|Nothing needs fixing|need fixing|golfer/, 30000);
  if (/Not signed in/.test(await text(owner))) throw new Error("Tidy asked to sign in");
  await owner.locator("#backTop").click();
  await owner.waitForURL(/\/\?emulators=1$/, { timeout: 15000 });
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const on = await owner.evaluate(() => { const b = document.querySelector('button[data-tab="admin"]'); return !!(b && b.classList.contains("on")); });
    if (on) return;
    await owner.waitForTimeout(400);
  }
  throw new Error(`not back on Admin; the screen says: ${(await text(owner)).replace(/\s+/g, " ").slice(0, 200)}`);
});

/* E26 (beta.7): every tool opens in the same window from Admin, already
   signed in, and the page itself scrolls (the shared stylesheet used to lock it). */
await check("E26", "Rebuild, Clean up, Repair and Tidy open in place, signed in, and scroll", async () => {
  const problems = [];
  await owner.setViewportSize({ width: 390, height: 480 });
  for (const tool of ["rebuild", "cleanup", "repair", "tidy"]) {
    if (tool === "repair") {
      await owner.goto(`http://localhost:${PORT}/repair.html?emulators=1`, { waitUntil: "load" });
    } else {
      await owner.goto(APP, { waitUntil: "load" });
      await tab(owner, "admin");
      await subtab(owner, tool === "tidy" ? "cockpit" : "settings");
      await owner.locator(`[data-act="open-tool"][data-tool="${tool}"]`).first().click();
    }
    try { await owner.waitForURL(new RegExp(`${tool}\\.html\\?emulators=1`), { timeout: 15000 }); }
    catch { problems.push(`${tool}: did not open in the same window (${owner.url()})`); continue; }
    await owner.waitForTimeout(4000);
    const t = await text(owner);
    if (/Not signed in/.test(t)) problems.push(`${tool}: asked to sign in`);
    const scrolled = await owner.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      if (el.scrollHeight <= window.innerHeight + 4) return "short";
      window.scrollTo(0, 150);
      return window.scrollY > 0 ? "ok" : "locked";
    });
    if (scrolled === "locked") problems.push(`${tool}: the page does not scroll`);
    if (!(await owner.locator("#backTop").count())) problems.push(`${tool}: no Back to the app at the top`);
  }
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.goto(APP, { waitUntil: "load" });
  if (problems.length) throw new Error(problems.join("; "));
});

/* E25 (beta.5): a device that has never accepted the Terms of Use sees them
   first; Accept needs the tick; Decline locks; accepting is remembered and
   recorded on the account after sign-in. */
await check("E25", "first open shows the Terms of Use; decline locks; accept is remembered and recorded on the account", async () => {
  const T = { email: "terms.tester@example.com", password: "terms-pass-1" };
  T.uid = await signUp(T.email, T.password);
  globalThis.__termsFresh = true;
  const fresh = await newPage();
  globalThis.__termsFresh = false;
  await fresh.goto(APP, { waitUntil: "load" });
  await waitForText(fresh, /Terms of Use/);
  await waitForText(fresh, /Handicaps are estimates/);
  if (await fresh.locator('[data-act="sign-in"]').count()) throw new Error("sign-in is reachable before accepting");
  if (!(await fresh.locator("#termsAccept").isDisabled())) throw new Error("Accept works without the tick");
  await fresh.locator('[data-act="terms-decline"]').click();
  await waitForText(fresh, /The Scorecard is locked/);
  await fresh.locator('[data-act="terms-again"]').click();
  await fresh.locator("#termsTick").check();
  if (await fresh.locator("#termsAccept").isDisabled()) throw new Error("Accept stays off after the tick");
  await fresh.locator("#termsAccept").click();
  await fresh.waitForSelector('[data-act="sign-in"]', { timeout: 20000 });
  /* beta.7: Become a member or start a group comes before I have a code. */
  const member = await fresh.locator('[data-act="show-choose"]').boundingBox();
  const code = await fresh.locator('[data-act="enter-code"]').boundingBox();
  if (!member || !code || member.y > code.y) throw new Error("Become a member is not above I have a code");
  await fresh.reload({ waitUntil: "load" });
  await fresh.waitForSelector('[data-act="sign-in"]', { timeout: 20000 });
  if (/I have read and agree/.test(await text(fresh))) throw new Error("asked again after a reload");
  await signIn(fresh, T.email, T.password);
  const end = Date.now() + 25000;
  let rec = null;
  while (Date.now() < end && !(rec = await getDocQuick(`users/${T.uid}/terms/accepted`))) await fresh.waitForTimeout(500);
  if (!rec) throw new Error("the acceptance was not recorded on the account");
  if (Number(rec.version) !== 1) throw new Error(`recorded version ${rec.version}`);
  await fresh.locator('[data-act="terms-view"]').first().click();
  await waitForText(fresh, /Effective October 2, 2026/);
  await fresh.locator('[data-act="terms-close"]').click();
});

/* E27 (beta.8): inside the iPhone app (Firestore's saved copy on), opening a
   tool closes the app's Firestore first — the saved copy's hold is given back
   before the tool page loads — and Back from the tool opens the app again at
   once. beta.7 left the hold behind, and on the iPhone the app then waited on
   "Loading your group" until the frozen page was thrown away. */
await check("E27", "app mode: Tidy opens only after the app's saved copy is released, and Back opens the app at once", async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} }; });
  const app = await context.newPage();
  app.errors = [];
  app.on("pageerror", (e) => { const l = String(e.message || e); if (!app.errors.includes(l)) app.errors.push(l); });
  await app.goto(APP, { waitUntil: "load" });
  await waitForText(app, /Sign in/);
  await signIn(app, W.email, W.password);
  await app.waitForSelector('button[data-tab="admin"]', { timeout: 30000 });
  if (await app.evaluate(async () => (await import("/store.js")).offlineCopyUnavailable())) throw new Error("the saved copy is not on in app mode, so this test proves nothing");
  await tab(app, "admin");
  await subtab(app, "cockpit");
  await app.locator('[data-act="open-tool"][data-tool="tidy"]').first().click();
  await app.waitForURL(/tidy\.html\?emulators=1/, { timeout: 15000 });
  const hold = await app.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => /^firestore\/.*main$/.test(n || ""));
    if (!names.length) return "no saved copy found";
    return new Promise((resolve) => {
      const req = indexedDB.open(names[0]);
      req.onerror = () => resolve(`could not open ${names[0]}`);
      req.onsuccess = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains("owner")) { idb.close(); return resolve("released"); }
        const get = idb.transaction("owner", "readonly").objectStore("owner").get("owner");
        get.onsuccess = () => { idb.close(); resolve(get.result ? `still held by ${get.result.ownerId}` : "released"); };
        get.onerror = () => { idb.close(); resolve("unreadable"); };
      };
    });
  });
  if (hold !== "released") throw new Error(`the app left for Tidy with its saved copy ${hold}`);
  await app.waitForTimeout(3000);
  const t0 = Date.now();
  await app.locator("#backTop").click();
  await app.waitForURL((u) => !/tidy\.html/.test(String(u)), { timeout: 15000 });
  await app.waitForSelector('button[data-tab="enter"]', { timeout: 10000 });
  const took = Date.now() - t0;
  if (took > 8000) throw new Error(`the app took ${took} ms to open after Back`);
  if (app.errors.length) throw new Error(app.errors.join(" | "));
  await context.close();
});

/* E28 (beta.8): an invitation opened by somebody who already has an account.
   Create account with that email signs them in with what they typed and goes
   straight to the invitation — no second screen asking for the same things. A
   password that is not the account's stops on the same screen and says so. */
await check("E28", "invitation, email already has an account: Create account signs in and shows the invitation; a wrong password says so", async () => {
  const J = { email: "jay@example.com", password: "jay-pass-1" };
  const jayUid = await signUp(J.email, J.password);
  const jay = await newPage();
  await jay.goto(`${APP}&join=G1.PRIV01.gJ`, { waitUntil: "load" });
  await waitForText(jay, /You.re invited/);
  const fill = async (pw) => {
    await jay.fill('[name="email"]', J.email);
    await jay.fill('[name="password"]', pw);
    await jay.fill('[name="password-again"]', pw);
    await jay.locator('[data-act="create-account"]').click();
  };
  await fill("not-jays-pass-1");
  await waitForText(jay, /That email already has an account/);
  if (!/not its password/.test(await text(jay))) throw new Error("the wrong password is not explained");
  if (await jay.evaluate(async () => (await import("/store.js")).hasUser())) throw new Error("signed in with a wrong password");
  await jay.locator('[data-close="1"]').first().click();
  await fill(J.password);
  await waitForText(jay, /Jay Unjoined/);
  if (!(await jay.locator('[data-act="accept-named"]').count())) throw new Error("the invitation's join button is not shown");
  if (await jay.locator('[data-act="sign-in"]').count()) throw new Error("a sign-in screen was shown");
  const acct = await accountByEmail(J.email);
  if (!acct || acct.localId !== jayUid) throw new Error("a different account was made");
  if (jay.errors.length) throw new Error(jay.errors.join(" | "));
});

await browser.close();
server.kill();
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
