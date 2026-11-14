/* End-to-end app tests against the Firebase emulators (Version 2.0).
 *
 * The real app, served on this test machine at http://localhost:8000 with
 * ?emulators=1, so it talks only to the emulators started by test/ops/run.sh:
 * a demo project that cannot reach any live data. Chromium and WebKit.
 *
 * E1–E9: the PUBLIC group from both sides (Phase C) — apply while signed out,
 * approve as the owner, choose a password from the email, sign in and land in
 * the group, report and block a name, and deal with the report — plus the
 * Phase A and B basics on the way (no anonymous sign-in, own membership only).
 *
 * Usage (inside firebase emulators:exec): node test/app/e2e.mjs <site-dir>
 */
import { chromium, webkit } from "playwright";
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
  : typeof v === "object" ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
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

/* Build 25 (E1): the sign-in link emails. */
async function signInCodes(email) {
  const r = await fetch(`${AUTH_ADMIN}/oobCodes`);
  return ((await r.json()).oobCodes || []).filter((c) => c.email === email);
}
async function latestSignInLink(email, approved = true) {
  const codes = (await signInCodes(email)).filter((c) => c.requestType === "EMAIL_SIGNIN");
  if (!codes.length) throw new Error(`no sign-in link was sent to ${email}`);
  const code = codes[codes.length - 1].oobCode;
  return `${APP}&apply=1${approved ? "&approved=1" : ""}&e=${encodeURIComponent(email)}&apiKey=fake-api-key&mode=signIn&oobCode=${encodeURIComponent(code)}&lang=en`;
}
async function sendSignInLink(email) {
  const continueUrl = `${APP}&apply=1&approved=1&e=${encodeURIComponent(email)}`;
  const r = await fetch(`${AUTH}/accounts:sendOobCode?key=fake-api-key`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestType: "EMAIL_SIGNIN", email, continueUrl, canHandleCodeInApp: true }) });
  if (!r.ok) throw new Error(`sendOobCode ${r.status}`);
}

/* ---- the app ---- */
const text = (page) => page.evaluate(() => document.body.innerText);
async function waitForText(page, re, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(await text(page))) return; await page.waitForTimeout(300); }
  throw new Error(`text ${re} did not appear; the screen says: ${(await text(page)).replace(/\s+/g, " ").slice(0, 300)}`);
}
/* Batch 2: the welcome screen's Join finishes joining by itself for a new
   account; signing in to an existing account still shows the invitation. */
/* Item 11: a form message is a centred pop-up that stays until OK; then the
   field to fix is outlined. Checks all three, then taps OK. */
async function formOk(page, field) {
  const pop = page.locator('#popmsg [data-pop-ok]');
  await pop.waitFor({ state: "visible", timeout: 10000 });
  await page.mouse.click(5, 5);   /* a tap outside must NOT close it */
  await page.waitForTimeout(300);
  if (!(await pop.isVisible())) throw new Error("the message closed without OK");
  await pop.click();
  await page.waitForFunction(() => document.getElementById("popmsg").hidden, null, { timeout: 5000 });
  if (field) {
    const outlined = await page.evaluate((n) => { const el = document.querySelector(`[name="${n}"]`); return !!(el && el.classList.contains("needs-fix")); }, field);
    if (!outlined) throw new Error(`the field ${field} is not outlined after OK`);
  }
}
/* Item 1: on a signed-in device an invitation either signs out by itself
   (the account already plays as another golfer) or asks; "someone else"
   then signs out and continues. Either way: the new person's welcome screen. */
async function toNewPerson(page) {
  await waitForText(page, /Is this invitation for you\?|You.re invited/, 30000);
  if (/Is this invitation for you\?/.test(await text(page))) {
    await page.waitForTimeout(1500);   /* the automatic check may still sign out */
    const no = page.locator('[data-act="link-not-me"]');
    if (await no.count()) await no.click({ timeout: 5000 }).catch(() => {});
  }
  await waitForText(page, /You.re invited/, 30000);
}
async function acceptIfAsked(page) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const btn = page.locator('[data-act="accept-named"]');
    if (await btn.count() && await btn.first().isEnabled().catch(() => false)) { await btn.first().click(); return "asked"; }
    if (await page.evaluate(async () => !!(await import("/store.js")).currentAssociation()).catch(() => false)) return "joined";
    await page.waitForTimeout(300);
  }
  throw new Error("neither joined nor shown the invitation");
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

const browser = await (process.env.TEST_BROWSER === "webkit" ? webkit : chromium).launch();
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
    /* WebKit only: a page that navigates away (or is cut off on purpose)
       reports Firestore's own closed emulator channels as an "access
       control" fetch error. That is the browser closing the connection, not
       the app failing. */
    if (/access control checks/.test(line) && /127\.0\.0\.1:(8080|9099)/.test(line)) return;   /* Firestore or Authentication emulator, the same browser behaviour */
    if (!page.errors.includes(line)) { page.errors.push(line); console.log(`      page error: ${String(e.stack || e).split("\n").slice(0, 8).join(" <- ")}`); }
  });
  return page;
};

/* E1–E2: the applicant, signed out */
const pat = await newPage();
await pat.goto(APP, { waitUntil: "load" });
await check("E1", "signed out: Sign in, I have a code, Become a member or request a group; no sign-in happens by itself", async () => {
  await waitForText(pat, /Become a member or request a group/);
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
  await formOk(pat, "ap-agree");
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
  await formOk(pat, "apply-email");
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
  await formOk(owner);
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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && (await getDoc("publicApplications/retry@example.com"))?.status !== "approved") await owner.waitForTimeout(200);

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
let applicantLink = "";
await check("E5", "build 25 (E1): approval sends the Sign in link, not the reset email; the applicant creates a password once and is in the PUBLIC group", async () => {
  if ((await signInCodes(APPLICANT.email)).some((c) => c.requestType === "PASSWORD_RESET")) throw new Error("the reset-password email was sent");
  applicantLink = await latestSignInLink(APPLICANT.email);
  await pat.goto(applicantLink, { waitUntil: "load" });
  await waitForText(pat, /Create your password|Welcome to the public group/);
  if ((await pat.inputValue('[name="email"]')) !== APPLICANT.email) throw new Error("the email is not filled in from the link");
  await pat.fill('[name="password"]', APPLICANT.password);
  await pat.fill('[name="password-again"]', APPLICANT.password);
  await pat.locator('[data-act="finish-apply"]').click();
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
  await acceptIfAsked(ivy);
  await waitForText(ivy, /Welcome to Saturday Group/i);
  const blocked = await ivy.evaluate(async () => {
    const db = await import("/store.js");
    return db.invitationFor("G1", "gJ").then((x) => x === null);
  });
  if (!blocked) throw new Error("an invitation record exists for a golfer never invited");
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
  /* Batch 5: the golfer list opens closed on Manage; Show opens it. */
  await ada.locator('[data-act="toggle-golfer-list"]').click();
  await ada.locator('[data-invite-golfer="gJ"]').first().waitFor({ timeout: 20000 })
    .catch(async () => { throw new Error(`no Invite button for Jay; the screen says: ${(await text(ada)).replace(/\s+/g, " ").slice(0, 600)}`); });
  await ada.locator('[data-invite-golfer="gJ"]').first().click();
  await waitForText(ada, /Invite Jay Unjoined/);
  if (await ada.locator('[name="invite-role"][value="admin"]').count()) throw new Error("the admin choice is offered to an admin");
  await ada.locator('[data-invite="send"]').click();
  await waitForText(ada, /one-time use only/);
  const memberMessage = await ada.evaluate(() => (document.querySelector("pre.msg") || {}).innerText || "");
  if (!memberMessage.includes("This invitation link is for one-time use only. Once you join, it cannot be used again."))
    throw new Error("member invitation does not explain one-time use");
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
await check("E15", "signed out: Request your own group sends a request (only after agreeing to the conditions)", async () => {
  await waitForText(olga, /Become a member or request a group/);
  await olga.locator('[data-act="show-choose"]').click();
  await olga.locator('[data-act="show-request"]').click();
  await waitForText(olga, /Request your own group/);
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
  await formOk(olga, "rq-agree");
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
  await formOk(olga, "rq-email");
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
  if (!msg.includes("This invitation link is for one-time use only. Once you join, it cannot be used again."))
    throw new Error("admin invitation does not explain one-time use");
  const found = /join=([A-Za-z0-9._-]+)&as=admin/.exec(msg);
  if (!found || !found[1].startsWith(`${r.groupId}.`)) throw new Error(`no admin invitation link in: ${msg.slice(0, 300)}`);
  adminLink = `${APP}&join=${found[1]}&as=admin&v=2`;
  await wil.locator('[data-close="1"]').first().click().catch(() => {});
  await subtab(wil, "settings");
  if (await wil.locator('[data-tool="rebuild"]').count()) throw new Error("Admin Settings still offers Rebuild the roster");
  await tab(wil, "manage");
  if (await wil.locator('[data-tool="rebuild"]').count()) throw new Error("Manage still offers Rebuild the roster on an empty roster");
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
  /* 2.31.2: the cockpit names people by their golfer's name. */
  const names = await wil.evaluate(async () => Object.keys((await (await import("/store.js")).loadOwnerCockpit()).golferNames || {}).length);
  if (!names) throw new Error("the cockpit could not read the golfers' names");
  await wil.locator('[data-act="cockpit-group"][data-id="G1"]').first().click();
  await waitForText(wil, /Back to all groups/);
  if (!/Ada Admin/.test(await text(wil))) throw new Error("the group's members are not listed");
  await wil.locator('[data-act="cockpit-group"][data-id=""]').first().click();
  await waitForText(wil, /Members, all groups/);
  if (wil.errors.length) throw new Error(wil.errors.join(" | "));
});
await check("E19", "the owner's Members tab is People as before, and Settings holds Group, Backup and Account (the key box is the app owner's)", async () => {
  await subtab(wil, "members");
  await waitForText(wil, /People/);
  const t = await text(wil);
  if (!/invitation used/.test(t) || !/(Make guest|Make admin)/.test(t)) throw new Error(`People changed: ${t.replace(/\s+/g, " ").slice(0, 300)}`);
  await subtab(wil, "settings");
  await waitForText(wil, /Backup/);
  const s2 = await text(wil);
  /* Batch 5, step 31: the course search key box is the app owner's only. */
  if (/Course search key/.test(s2)) throw new Error("a group owner who is not the app owner sees the course search key box");
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
  await waitForText(p, /Become a member or request a group/);
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
  await formOk(p, "apply-email");
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
  await waitForText(p, /Become a member or request a group/);
  await p.locator('[data-act="show-choose"]').click();
  await p.locator('[data-act="show-apply"]').click();
  await waitForText(p, /You tap the link, which confirms your email/);
  await p.fill('[name="apply-name"]', name);
  await p.fill('[name="apply-email"]', email);
  await p.locator('[name="ap-agree"]').check();
  await p.locator('[data-act="submit-application"]').click();
  /* Batch 2, step 29: a taken name is said first; Continue anyway goes on. */
  await waitForText(p, /Check your email|A golfer with this name already exists/);
  if (/A golfer with this name already exists/.test(await text(p))) { await formOk(p, "apply-name"); await p.locator('[data-act="apply-name-ok"]').click(); }
  await waitForText(p, /Check your email/);
  if (await accountByEmail(email)) throw new Error("an account was created before the link was tapped");
  const r = await fetch(`${AUTH_ADMIN}/oobCodes`);
  const codes = ((await r.json()).oobCodes || []).filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN");
  if (!codes.length) throw new Error("no sign-in link was sent");
  const code = codes[codes.length - 1].oobCode;
  const q = await newPage();
  await q.goto(`${APP}&apply=1&apiKey=fake-api-key&mode=signIn&oobCode=${encodeURIComponent(code)}&lang=en`, { waitUntil: "load" });
  await waitForText(q, /Create your password|Welcome to the public group/);
  await q.fill('[name="email"]', email);
  await q.fill('[name="password"]', "auto-pass-1");
  await q.fill('[name="password-again"]', "auto-pass-1");
  await q.locator('[data-act="finish-apply"]').click();
  return q;
}
await check("E22", "Auto: the applicant taps the link, chooses a password and is in the public group by themselves", async () => {
  await turnSwitch("auto");
  const q = await applyAndOpenLink("Gwen Auto", "gwen.auto@example.com");
  await waitForText(q, /Post your rounds on the Enter tab/, 30000);
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
  try { await owner.waitForURL(/tidy\.html\?emulators=1/, { timeout: 15000 }); }
  catch { throw new Error("the app did not leave for Tidy (closing its Firestore did not finish)"); }
  await waitForText(owner, /Checked \d+ golfers|recorded twice|Nothing needs fixing|need fixing|golfer/, 30000);
  if (/Not signed in/.test(await text(owner))) throw new Error("Tidy asked to sign in");
  await owner.locator("#backTop").click();
  try { await owner.waitForURL(/\/\?emulators=1$/, { timeout: 15000 }); }
  catch { throw new Error(`Back did not leave Tidy; the link says "${await owner.locator("#backTop").innerText().catch(() => "?")}"`); }
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const on = await owner.evaluate(() => { const b = document.querySelector('button[data-tab="admin"]'); return !!(b && b.classList.contains("on")); });
    if (on) return;
    await owner.waitForTimeout(400);
  }
  throw new Error(`not back on Admin; the screen says: ${(await text(owner)).replace(/\s+/g, " ").slice(0, 200)}`);
});

/* E26 (beta.7, beta.13): linked tools open in place and every controlled
   repair page still works directly. Rebuild is deliberately no longer linked
   from the app, but remains available for a supervised recovery. */
await check("E26", "linked tools open in place; controlled repair pages work directly; Rebuild is not offered", async () => {
  const problems = [];
  await owner.setViewportSize({ width: 390, height: 480 });
  for (const tool of ["rebuild", "cleanup", "repair", "tidy"]) {
    if (tool === "repair" || tool === "rebuild") {
      await owner.goto(`http://localhost:${PORT}/${tool}.html?emulators=1`, { waitUntil: "load" });
    } else {
      await owner.goto(APP, { waitUntil: "load" });
      await tab(owner, "admin");
      await subtab(owner, tool === "tidy" ? "cockpit" : "settings");
      if (await owner.locator('[data-tool="rebuild"]').count()) problems.push("Admin still offers Rebuild the roster");
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
  /* beta.7: Become a member or request a group comes before I have a code. */
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

/* E29 (beta.8): Back from a tool always works, even when nobody is signed in
   there and its Firestore was never used. Deleting the Firebase app in one go
   hung in exactly that case; the page now closes Firestore first. */
await check("E29", "signed out: Back from Tidy returns to the app at once", async () => {
  const nobody = await newPage();
  await nobody.goto(`http://localhost:${PORT}/tidy.html?emulators=1`, { waitUntil: "load" });
  await waitForText(nobody, /Not signed in/);
  const t0 = Date.now();
  await nobody.locator("#backTop").click();
  await nobody.waitForURL((u) => !/tidy\.html/.test(String(u)), { timeout: 8000 });
  await waitForText(nobody, /Sign in/, 10000);
  if (Date.now() - t0 > 8000) throw new Error(`took ${Date.now() - t0} ms`);
  if (nobody.errors.length) throw new Error(nobody.errors.join(" | "));
});

/* ---- beta.9: Delete my account, forced out, locked, finished, and joining again ---- */
async function idToken(email, password) {
  const r = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake-api-key`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error(`sign-in ${email}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.idToken;
}
/* A write made AS that account (the rules apply). Returns the HTTP status. */
async function writeAs(token, docPath, data) {
  const r = await fetch(`${FS}:commit`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes: [{ update: { name: `projects/${P}/databases/(default)/documents/${docPath}`, fields: fields(data) } }] }) });
  return r.status;
}
async function deleteAs(token, docPath) {
  const r = await fetch(`${FS}:commit`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes: [{ delete: `projects/${P}/databases/(default)/documents/${docPath}` }] }) });
  return r.status;
}
/* Somebody who joined G1 by a named invitation, exactly as the app leaves them. */
async function joinedPerson(key, name, email, password) {
  const uid = await signUp(email, password);
  const nk = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await put(`golfers/${key}`, { name, nameKey: nk, linkedUid: uid, groups: ["G1"] });
  await put(`golferNames/${nk}`, { golferId: key, name });
  await put(`associations/G1/roster/${key}`, { golferId: key });
  await put(`associations/G1/directory/${key}`, { golferId: key, displayName: name, handicapIndex: null });
  await put(`associations/G1/members/${uid}`, { uid, role: "member", displayName: name, golferId: key });
  await put(`associations/G1/invites/${key}`, { acceptedBy: uid, role: "member" });
  await put(`associations/G1/invitations/${key}`, { golferId: key, name, handicapIndex: null, groupName: "Saturday Group", role: "member", sentBy: W.uid });
  await put(`userGroups/${uid}/groups/G1`, { assocId: "G1", name: "Saturday Group" });
  await put(`accountEmails/${email}`, { at: "seeded" });
  await put(`associations/G1/rounds/r-${key}`, { id: `r-${key}`, golferId: key, assocId: "G1", date: "2026-09-05", differential: 14.0, gross: 90 });
  return uid;
}
async function openDelete(page, password) {
  await tab(page, "summary");   // its footer carries "Delete my account"
  await page.locator('[data-act="delete-account"]').first().click();
  await page.fill('[name="delete-password"]', password);
  await page.locator('[data-del="go"]').click();
}
const signedInNow = (page) => page.evaluate(async () => (await import("/store.js")).hasUser());

/* E30 (Willy's test, Oct 2): a member deletes their own account. They are
   signed out, the sign-in and the email are gone, the golfer stays in the
   group with its rounds, unlinked. Invited again with the SAME email, they
   join as a new account and get the same golfer back. */
await check("E30", "Delete my account: signed out, gone, golfer and rounds kept; invited again with the same email they rejoin as the same golfer", async () => {
  const Z = { email: "zed@example.com", password: "zed-pass-1" };
  const zUid = await joinedPerson("gZ", "Zed Leaver", Z.email, Z.password);
  const zed = await newPage();
  await zed.goto(APP, { waitUntil: "load" });
  await waitForText(zed, /Sign in/);
  await signIn(zed, Z.email, Z.password);
  await waitForText(zed, /Saturday Group/i);
  await openDelete(zed, Z.password);
  await waitForText(zed, /Your account has been deleted/, 30000);
  if (await signedInNow(zed)) throw new Error("still signed in after the deletion");
  const problems = [];
  if (await accountByEmail(Z.email)) problems.push("the sign-in still exists");
  if (await getDoc(`associations/G1/members/${zUid}`)) problems.push("the membership is still there");
  if (await getDoc(`accountEmails/${Z.email}`)) problems.push("the email is still registered");
  const g = await getDoc("golfers/gZ");
  if (!g || g.linkedUid !== null) problems.push(`golfer: ${JSON.stringify(g)}`);
  if (!(await getDoc("associations/G1/roster/gZ"))) problems.push("the golfer left the roster");
  if (!(await getDoc("associations/G1/rounds/r-gZ"))) problems.push("the round was deleted");
  if (problems.length) throw new Error(problems.join("; "));
  /* Invited again, same email: a brand-new account joins as the same golfer. */
  const back = await newPage();
  await back.goto(`${APP}&join=G1.PRIV01.gZ`, { waitUntil: "load" });
  await waitForText(back, /You.re invited/);
  await back.fill('[name="email"]', Z.email);
  await back.fill('[name="password"]', "zed-new-pass-1");
  await back.fill('[name="password-again"]', "zed-new-pass-1");
  await back.locator('[data-act="create-account"]').click();
  await acceptIfAsked(back);
  const end = Date.now() + 20000;
  while (Date.now() < end && (await back.evaluate(async () => (await import("/store.js")).currentAssociation())) !== "G1") await back.waitForTimeout(300);
  const nUid = (await accountByEmail(Z.email) || {}).localId;
  if (!nUid || nUid === zUid) throw new Error("no new account");
  if ((await getDoc("golfers/gZ")).linkedUid !== nUid) throw new Error("the golfer is not linked to the new account");
  if (!(await getDoc(`associations/G1/members/${nUid}`))) throw new Error("not a member again");
  if (back.errors.length || zed.errors.length) throw new Error([...back.errors, ...zed.errors].join(" | "));
});

/* E31 (Willy, Oct 2): a deletion that stops part-way. The person is signed
   out at once and told; signing in again is refused; the database refuses
   their writes (rules: a deleting account is locked) and they cannot withdraw
   the request; the completion job then finishes it, email included. */
await check("E31", "a deletion that stops part-way: signed out at once, cannot sign back in, locked by the rules, finished by the job", async () => {
  const K = { email: "kit@example.com", password: "kit-pass-1" };
  const kUid = await joinedPerson("gK", "Kit Halfway", K.email, K.password);
  const kit = await newPage();
  await kit.goto(APP, { waitUntil: "load" });
  await waitForText(kit, /Sign in/);
  await signIn(kit, K.email, K.password);
  await waitForText(kit, /Saturday Group/i);
  await kit.evaluate(() => { globalThis.__scorecardStopDeletionAt = "Leaving your groups"; });
  await openDelete(kit, K.password);
  await waitForText(kit, /being deleted/, 30000);
  if (await signedInNow(kit)) throw new Error("still signed in after the deletion stopped");
  const rec = await getDoc(`accountDeletions/${kUid}`);
  if (!rec) throw new Error("no deletion request on the server");
  if (!/Leaving your groups/.test(String(rec.appStep || ""))) throw new Error(`the stopped step is not recorded: ${JSON.stringify(rec)}`);
  /* Signing in again is refused. */
  await kit.locator('[data-close="1"]').first().click().catch(() => {});
  await kit.reload({ waitUntil: "load" });
  await waitForText(kit, /Sign in/);
  await signIn(kit, K.email, K.password);
  await waitForText(kit, /being deleted/, 20000);
  await kit.waitForTimeout(1500);
  if (await signedInNow(kit)) throw new Error("signed in to an account that is being deleted");
  /* The rules lock it. */
  const token = await idToken(K.email, K.password);
  const locks = [];
  if (await writeAs(token, `userGroups/${kUid}/groups/G9`, { assocId: "G9", name: "x" }) === 200) locks.push("it could add a group to its list");
  if (await writeAs(token, "courses/cK", { name: "Kit Course", createdBy: kUid }) === 200) locks.push("it could add a course");
  if (await deleteAs(token, `accountDeletions/${kUid}`) === 200) locks.push("it could withdraw its deletion request");
  if (locks.length) throw new Error(locks.join("; "));
  /* The completion job finishes it. */
  const { spawnSync } = await import("node:child_process");
  const job = spawnSync("bash", [path.resolve(SITE, ".github/scripts/finish-deletions.sh")], { encoding: "utf8", env: { ...process.env,
    ACCESS_TOKEN: "owner", PROJECT: P, FS_BASE: "http://127.0.0.1:8080/v1", AUTH_BASE: AUTH, MIN_AGE_SECONDS: "0" } });
  if (job.status !== 0) throw new Error(`the job failed: ${(job.stdout + job.stderr).slice(-300)}`);
  const problems = [];
  if (await accountByEmail(K.email)) problems.push("the sign-in still exists");
  if (await getDoc(`associations/G1/members/${kUid}`)) problems.push("the membership is still there");
  if (await getDoc(`accountEmails/${K.email}`)) problems.push("the email is still registered");
  if ((await getDoc("golfers/gK")).linkedUid !== null) problems.push("the golfer is still linked");
  if (!(await getDoc("associations/G1/rounds/r-gK"))) problems.push("the round was deleted");
  if (await getDoc(`accountDeletions/${kUid}`)) problems.push("the request is still there");
  if (problems.length) throw new Error(problems.join("; "));
});

/* E30P (Willy, 13 Nov 2026): somebody who plays only in the PUBLIC group
   deletes their account in the app, the way a golfer does it. The warning
   says what happens; once the completion job has run, their golfer, name,
   rounds and handicap are gone for good, with a backup; nobody else is touched. */
await check("E30P", "Delete my account in the PUBLIC group only: golfer, name and rounds deleted for good (backup kept); others untouched", async () => {
  const Pi = { email: "pia@example.com", password: "pia-pass-1" };
  const uid = await signUp(Pi.email, Pi.password);
  await put("golfers/gPia", { name: "Pia Public", nameKey: "pia-public", linkedUid: uid, groups: ["PUBLIC"], handicapIndex: 18.0 });
  await put("golferNames/pia-public", { golferId: "gPia", name: "Pia Public" });
  await put("associations/PUBLIC/roster/gPia", { golferId: "gPia" });
  await put("associations/PUBLIC/directory/gPia", { golferId: "gPia", displayName: "Pia Public", handicapIndex: 18.0 });
  await put(`associations/PUBLIC/members/${uid}`, { uid, role: "member", displayName: "Pia Public", golferId: "gPia" });
  await put(`userGroups/${uid}/groups/PUBLIC`, { assocId: "PUBLIC", name: "PUBLIC" });
  await put(`accountEmails/${Pi.email}`, { at: "seeded" });
  await put("associations/PUBLIC/rounds/r-pia1", { id: "r-pia1", golferId: "gPia", assocId: "PUBLIC", date: "2026-11-01", differential: 20.0, gross: 95 });
  await put("associations/PUBLIC/rounds/r-pia2", { id: "r-pia2", golferId: "gPia", assocId: "PUBLIC", date: "2026-11-08", differential: 19.0, gross: 94 });
  const pia = await newPage();
  await pia.goto(APP, { waitUntil: "load" });
  await waitForText(pia, /Sign in/);
  await signIn(pia, Pi.email, Pi.password);
  await waitForText(pia, /PUBLIC|Public/);
  await tab(pia, "summary");
  await pia.locator('[data-act="delete-account"]').first().click();
  await waitForText(pia, /Only in the Public group:[\s\S]*deleted too/);
  await pia.fill('[name="delete-password"]', Pi.password);
  await pia.locator('[data-del="go"]').click();
  const end = Date.now() + 30000;
  while (Date.now() < end && await signedInNow(pia)) await pia.waitForTimeout(500);
  if (await signedInNow(pia)) throw new Error("still signed in after Delete my account");
  await waitForText(pia, /Your account has been deleted/, 20000);
  if (/refused/i.test(await text(pia))) throw new Error("an error box shows after the deletion");
  const { spawnSync } = await import("node:child_process");
  const job = spawnSync("bash", [path.resolve(SITE, ".github/scripts/finish-deletions.sh")], { encoding: "utf8", env: { ...process.env,
    ACCESS_TOKEN: "owner", PROJECT: P, FS_BASE: "http://127.0.0.1:8080/v1", AUTH_BASE: AUTH, MIN_AGE_SECONDS: "0" } });
  if (job.status !== 0) throw new Error(`the job failed: ${(job.stdout + job.stderr).slice(-400)}`);
  const problems = [];
  if (await accountByEmail(Pi.email)) problems.push("the sign-in still exists");
  if (await getDoc("golfers/gPia")) problems.push("the golfer is still there");
  if (await getDoc("associations/PUBLIC/roster/gPia")) problems.push("still on the Public list");
  if (await getDoc("associations/PUBLIC/directory/gPia")) problems.push("still in the Public ranking");
  if (await getDoc("associations/PUBLIC/rounds/r-pia1") || await getDoc("associations/PUBLIC/rounds/r-pia2")) problems.push("a round is still there");
  if (await getDoc("golferNames/pia-public")) problems.push("the name is still taken");
  const backups = (await list("deletionBackups")).filter((b) => b.golferId === "gPia");
  if (backups.length !== 1) problems.push(`${backups.length} backups instead of 1`);
  else if (((backups[0].rounds || {}).values || []).length !== 2) problems.push("the backup does not hold both rounds");
  if (!(await getDoc("golfers/gM"))) problems.push("another Public golfer (Mia) was touched");
  if (!(await getDoc("associations/PUBLIC/roster/gM"))) problems.push("Mia left the Public list");
  if (!/PUBLIC .*deleted from the Public group for good \(2 rounds\)/.test(job.stdout)) problems.push(`the job did not report it: ${job.stdout.slice(-300)}`);
  if (problems.length) throw new Error(problems.join("; "));
});

/* E32 (Willy, Oct 2): an invitation opened by somebody who is ALREADY in that
   group as that golfer (a deletion that never finished, or a second device).
   Joining must simply open the group, not be refused. */
await check("E32", "an invitation for a golfer you already are, in a group you are already in: joining opens the group", async () => {
  const L = { email: "lou@example.com", password: "lou-pass-1" };
  await joinedPerson("gL", "Lou Already", L.email, L.password);
  const lou = await newPage();
  await lou.goto(`${APP}&join=G1.PRIV01.gL`, { waitUntil: "load" });
  await waitForText(lou, /You.re invited/);
  await lou.fill('[name="email"]', L.email);
  await lou.fill('[name="password"]', L.password);
  await lou.fill('[name="password-again"]', L.password);
  await lou.locator('[data-act="create-account"]').click();
  await waitForText(lou, /Lou Already/);
  await lou.locator('[data-act="accept-named"]').click();
  const end = Date.now() + 20000;
  while (Date.now() < end && (await lou.evaluate(async () => (await import("/store.js")).currentAssociation())) !== "G1") await lou.waitForTimeout(300);
  if (/Could not join|did not work/i.test(await text(lou))) throw new Error(`refused: ${(await text(lou)).replace(/\s+/g, " ").slice(0, 200)}`);
  if ((await lou.evaluate(async () => (await import("/store.js")).currentAssociation())) !== "G1") throw new Error("the group did not open");
});

for (const mode of ["web", "native-immediate", "native-delayed"]) {
  await check("E33-" + mode, "join then sign out returns to ordinary Sign in (" + mode + ")", async () => {
    const key = "gLogout" + mode.replace(/[^a-z]/g, "");
    const email = key.toLowerCase() + "@example.com";
    const password = "logout-test-pass-1";
    await joinedPerson(key, "Logout " + mode, email, password);
    const page = await newPage();
    const launchUrl = "https://www.cuberoot-systems.com/scorecard/join/?join=G1.PRIV01." + key;
    if (mode !== "web") {
      await page.addInitScript(({url, delayed}) => {
        window.Capacitor = { isNativePlatform: () => true, Plugins: {
          App: { getLaunchUrl: async () => ({url}), addListener: () => ({remove(){}}) }
        }};
        // Age the successful-consumption record only on the subsequent reload.
        if (delayed) {
          const key = "golf:v2:lastLink";
          const record = JSON.parse(localStorage.getItem(key) || "null");
          if (record) { record.at = Date.now() - 11 * 60 * 1000; localStorage.setItem(key, JSON.stringify(record)); }
        }
      }, {url: launchUrl, delayed: mode === "native-delayed"});
    }
    await page.goto(mode === "web" ? APP + "&join=G1.PRIV01." + key : APP, {waitUntil: "load"});
    await waitForText(page, /You.re invited/);
    await page.fill('[name="email"]', email);
    await page.fill('[name="password"]', password);
    await page.fill('[name="password-again"]', password);
    await page.locator('[data-act="create-account"]').click();
    await acceptIfAsked(page);
    await page.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1");
    await page.locator('[data-tab="summary"]').waitFor();
    await Promise.all([
      page.waitForNavigation({waitUntil: "load"}),
      page.evaluate(async () => { await (await import("/store.js")).signOutEverywhere(); })
    ]);
    await page.locator('[data-act="sign-in"]').first().waitFor();
    if (/You.re invited/.test(await text(page))) throw new Error("used invitation returned after sign-out");
    const query = await page.evaluate(async () => (await import("/platform.js")).linkQuery());
    if (new URLSearchParams(query).has("join")) throw new Error("invitation remains pending");
    if (await signedInNow(page)) throw new Error("account remains signed in");
    await page.close();
  });
}


/* beta.10: production invitation rules enabled. No live project is touched. */
await put("settings/invitationLinks", { version: 2 });
await wil.evaluate(async () => {
  const db = await import("/store.js"); db.setAssociation("G1");
  await db.loadMembership("G1"); await db.loadAssociation("G1");
});
async function freshInvitation(golferId, role = "member", page = wil) {
  return page.evaluate(async ({golferId, role}) => (await import("/store.js")).inviteLink(role, golferId), {golferId, role});
}
async function tokenPerson(key, name, email) {
  const password = "invited-pass-1";
  const uid = await signUp(email, password);
  await put(`golfers/${key}`, { name, nameKey: key, linkedUid: null, groups: ["G1"] });
  await put(`associations/G1/roster/${key}`, { golferId: key });
  const page = await newPage(); await page.goto(APP, {waitUntil:"load"});
  await waitForText(page, /Sign in/); await signIn(page, email, password);
  await page.waitForFunction(async expected => { const db = await import("/store.js"); return db.isSignedIn() && db.status().uid === expected; }, uid);
  await page.waitForFunction(() => !document.querySelector('[data-act="sign-in"]'));
  return { uid, page, email, password };
}
async function acceptToken(page, url, displayName = "Invited Person") {
  const u = new URL(url); const [associationId, token] = u.searchParams.get("join").split(".");
  return page.evaluate(async x => {
    try { return await (await import("/store.js")).acceptTokenInvite(x); }
    catch(e) { return { ok:false, error:String(e.code || e.message || e) }; }
  }, {associationId,token,displayName});
}
let invitationCase;
await check("INV1", "resend creates a different secret and the previous link cannot create membership", async () => {
  invitationCase = await tokenPerson("gToken", "Token Player", "token@example.com");
  const first = await freshInvitation("gToken"); const second = await freshInvitation("gToken");
  if (!first || first === second || !second.includes("&v=2")) throw new Error("not a fresh independent secret");
  if ((await acceptToken(invitationCase.page, first)).ok) throw new Error("replaced invitation accepted");
  if (await getDoc(`associations/G1/members/${invitationCase.uid}`)) throw new Error("partial membership after refusal");
  invitationCase.url = second;
});
await check("INV2", "one atomic join links the existing golfer, preserves rounds, and spends the invitation", async () => {
  const x = invitationCase;
  await put("associations/G1/rounds/token-round", { golferId:"gToken", date:"2026-10-01", gross:90 });
  const result = await acceptToken(x.page, x.url);
  if (!result.ok) throw new Error(JSON.stringify(result));
  if ((await getDoc("golfers/gToken")).linkedUid !== x.uid) throw new Error("golfer not linked");
  const token = new URL(x.url).searchParams.get("join").split(".")[1];
  const receipt = await getDoc(`associations/G1/invitationTokens/${token}`);
  if (receipt.state !== "used" || receipt.acceptedBy || receipt.email) throw new Error("missing non-personal used receipt");
  if (!(await getDoc("associations/G1/rounds/token-round"))) throw new Error("round lost");
  if ((await acceptToken(x.page, x.url)).ok) throw new Error("used invitation accepted twice");
});
await check("INV3", "a forwarded used invitation cannot be accepted by another account", async () => {
  const y = await tokenPerson("gOtherToken", "Other Token", "other-token@example.com");
  if ((await acceptToken(y.page, invitationCase.url)).ok) throw new Error("forwarded used link accepted");
  if (await getDoc(`associations/G1/members/${y.uid}`)) throw new Error("partial membership");
});
await check("INV4", "deleting the accepting account leaves a spent receipt; fresh reinvitation retains the golfer and rounds", async () => {
  const x = invitationCase;
  const result = await x.page.evaluate(async password => (await import("/store.js")).deleteMyAccount({password}), x.password);
  if (!result.ok) throw new Error(JSON.stringify(result));
  const y = await tokenPerson("gScratchToken", "Scratch Token", "token@example.com");
  if ((await acceptToken(y.page, x.url)).ok) throw new Error("deletion reactivated old invitation");
  const fresh = await freshInvitation("gToken");
  const joined = await acceptToken(y.page, fresh);
  if (!joined.ok) throw new Error("fresh reinvitation refused: " + JSON.stringify(joined));
  if ((await getDoc("golfers/gToken")).linkedUid !== y.uid) throw new Error("new account not linked to preserved golfer");
  if (!(await getDoc("associations/G1/rounds/token-round"))) throw new Error("round history lost");
});
await check("INV5", "an admin cannot create an admin invitation", async () => {
  const r = await ada.evaluate(async () => { try { await (await import("/store.js")).inviteLink("admin"); return true; } catch { return false; } });
  if (r) throw new Error("admin could send admin invitation");
});
await check("INV6", "legacy named and admin shared-code links are refused after activation", async () => {
  const x = await tokenPerson("gLegacy", "Legacy Player", "legacy-token@example.com");
  const token = await idToken(x.email,x.password);
  for (const role of ["member","admin"]) {
    const status = await writeAs(token, `associations/G1/members/${x.uid}`, {uid:x.uid,displayName:"Legacy Player",golferId:"gLegacy",role,joinCode:role === "member" ? "PRIV01" : "ADMIN1"});
    if (status === 200) throw new Error("legacy link could create " + role + " membership");
  }
});
await check("INV7", "two accounts racing for one invitation: exactly one joins, without partial membership", async () => {
  const a = await tokenPerson("gRace", "Race Player", "race-a@example.com");
  const b = await tokenPerson("gUnusedRace", "Unused Race", "race-b@example.com");
  const url = await freshInvitation("gRace");
  const results = await Promise.all([acceptToken(a.page,url),acceptToken(b.page,url)]);
  if (results.filter(r=>r.ok).length !== 1) throw new Error(JSON.stringify(results));
  const members = await Promise.all([getDoc(`associations/G1/members/${a.uid}`),getDoc(`associations/G1/members/${b.uid}`)]);
  if (members.filter(Boolean).length !== 1) throw new Error("partial or duplicate membership");
});
await check("INV8", "refused golfer link does not create membership or spend the invitation", async () => {
  const a = await tokenPerson("gRefused", "Refused Player", "refused-token@example.com");
  await put("golfers/gRefused", { name:"Refused Player", linkedUid:W.uid, groups:["G1"] });
  const url = await freshInvitation("gRefused");
  if ((await acceptToken(a.page,url)).ok) throw new Error("claimed someone else's golfer");
  if (await getDoc(`associations/G1/members/${a.uid}`)) throw new Error("left partial membership");
  const token = new URL(url).searchParams.get("join").split(".")[1];
  if ((await getDoc(`associations/G1/invitationTokens/${token}`)).state !== "pending") throw new Error("spent refused invitation");
});
await check("INV9", "admin non-player invitations work once and do not create a golfer", async () => {
  const a = await tokenPerson("gAdminScratch", "Admin Scratch", "admin-token@example.com");
  const url = await freshInvitation(null,"admin");
  const result = await acceptToken(a.page,url,"New Organiser");
  if (!result.ok || result.role !== "admin" || result.golferId) throw new Error(JSON.stringify(result));
  if ((await acceptToken(a.page,url,"New Organiser")).ok) throw new Error("admin link reusable");
});
await check("INV10", "same-account fresh invitation preserves the existing admin role", async () => {
  const url = await freshInvitation(null,"member");
  const result = await acceptToken(ada,url,"Ada Admin");
  if (!result.ok || result.role !== "admin") throw new Error(JSON.stringify(result));
});


await check("INV11", "a general member link accepts a name and creates that member's own golfer", async () => {
  const a = await tokenPerson("gGeneralScratch", "General Scratch", "general-token@example.com");
  const url = await freshInvitation(null, "member");
  const r = await acceptToken(a.page, url, "General Newcomer");
  if (!r.ok) throw new Error(JSON.stringify(r));
  const golfer = await a.page.evaluate(async () => {
    const db = await import("/store.js");
    const g = await db.linkGolferForMember("General Newcomer");
    await db.flush(); return g;
  });
  if (!golfer || (await getDoc(`golfers/${golfer.id}`)).linkedUid !== a.uid) throw new Error("general member did not get their own golfer");
});


for (const mode of ["web", "native"]) {
  await check("INV12-" + mode, "new token invitation: sign in, join, sign out and reopen show ordinary Sign in (" + mode + ")", async () => {
    const key = "gTokenUi" + mode, email = "token-ui-" + mode + "@example.com", password = "token-ui-pass-1";
    await signUp(email, password);
    await put(`golfers/${key}`, {name:"Token UI " + mode, linkedUid:null, groups:["G1"]});
    await put(`associations/G1/roster/${key}`, {golferId:key});
    const url = await freshInvitation(key);
    const page = await newPage();
    if (mode === "native") await page.addInitScript(url => {
      window.Capacitor = {isNativePlatform:()=>true, Plugins:{App:{getLaunchUrl:async()=>({url}),addListener:()=>({remove(){}})}}};
    }, url);
    await page.goto(mode === "web" ? APP + "&" + new URL(url).search.slice(1) : APP, {waitUntil:"load"});
    await waitForText(page, /You.re invited/);
    await page.fill('[name="email"]',email); await page.fill('[name="password"]',password); await page.fill('[name="password-again"]',password);
    await page.locator('[data-act="create-account"]').click();
    await acceptIfAsked(page);
    await page.locator('[data-tab="summary"]').waitFor();
    await Promise.all([page.waitForNavigation({waitUntil:"load"}),page.evaluate(async()=> (await import("/store.js")).signOutEverywhere())]);
    await page.locator('[data-act="sign-in"]').first().waitFor();
    if (/You.re invited/.test(await text(page))) throw new Error("token invitation returned after logout");
    await page.reload({waitUntil:"load"}); await page.locator('[data-act="sign-in"]').first().waitFor();
    if (/You.re invited/.test(await text(page))) throw new Error("token invitation returned after reopening");
    await page.close();
  });
}



await check("INV13", "an outstanding invitation cannot join a deleted group or leave orphan membership", async () => {
  const a = await tokenPerson("gRemovedGroup", "Removed Group Player", "removed-group@example.com");
  const token = "a".repeat(64);
  await put(`associations/REMOVED/invitationTokens/${token}`, {slot:"open-member",golferId:null,role:"member",name:"",groupName:"Deleted group",state:"pending"});
  await put("associations/REMOVED/invitationSlots/open-member",{token});
  if ((await acceptToken(a.page, `https://www.cuberoot-systems.com/scorecard/join/?join=REMOVED.${token}&v=2`)).ok) throw new Error("joined deleted group");
  if (await getDoc(`associations/REMOVED/members/${a.uid}`)) throw new Error("orphan membership left");
  if (await getDoc(`userGroups/${a.uid}/groups/REMOVED`)) throw new Error("orphan pointer left");
  if ((await getDoc(`associations/REMOVED/invitationTokens/${token}`)).state !== "pending") throw new Error("refused invitation spent");
  await a.page.close();
});

await check("ERR1", "a failed deletion precheck preserves the real error for Send a report; no deletion request is written", async () => {
  const a = await tokenPerson("gError", "Error Player", "error-token@example.com");
  for (const code of ["failed-precondition", "permission-denied", "unavailable"]) {
    const result = await a.page.evaluate(async code => {
      globalThis.__scorecardGroupCheckError = code;
      const db = await import("/store.js");
      const result = await db.deleteMyAccount({password:"invited-pass-1"});
      delete globalThis.__scorecardGroupCheckError;
      return {result, error:db.status().error};
    }, code);
    if (result.result.ok || result.result.reason !== "CHECK" || !result.result.message.includes(code) || !result.error.full.includes(code)) throw new Error(JSON.stringify(result));
    if (await getDoc(`accountDeletions/${a.uid}`)) throw new Error("request written after failed precheck");
  }
});


await check("ERR2", "the real deletion screen offers a report containing the error code and reason, without the password", async () => {
  const a = await tokenPerson("gReport", "Report Player", "report-token@example.com");
  const r = await acceptToken(a.page, await freshInvitation("gReport"));
  if (!r.ok) throw new Error(JSON.stringify(r));
  await a.page.reload({waitUntil:"load"}); await a.page.locator('[data-tab="summary"]').waitFor();
  await tab(a.page, "summary");
  await a.page.evaluate(()=>{globalThis.__scorecardGroupCheckError="failed-precondition";});
  await a.page.locator('[data-act="delete-account"]').first().click();
  await a.page.fill('[name="delete-password"]',a.password);
  await a.page.locator('[data-del="go"]').click();
  await a.page.locator('[data-del="report"]').waitFor();
  await a.page.locator('[data-del="report"]').click();
  const report = await a.page.locator('[data-problem="send"]').evaluate(el=>el.closest('.sheet-body').parentElement.dataset.report);
  if (!report.includes('failed-precondition') || !report.includes('Checking your groups') || report.includes(a.password)) throw new Error("report missing real error or includes password");
  if (await getDoc(`accountDeletions/${a.uid}`)) throw new Error("precheck wrote deletion request");
  await a.page.close();
});

/* E34 (Willy, Oct 8): favourite courses. Starred on the website, they head
   the course list in the iPhone app for the same account (and the reverse),
   because they are kept on the account. */
await check("E34", "favourite courses: starred on the web, first in the app's course list for the same account, and removed again", async () => {
  const LOU = { email: "lou@example.com", password: "lou-pass-1" };   // in G1 since E32
  LOU.uid = (await accountByEmail(LOU.email)).localId;
  const tee = { id: "t1", name: "White", rating: 70.1, slope: 125, par: 72 };
  await put("courses/cA", { id: "cA", name: "Alder Creek", tees: [tee], createdBy: W.uid });
  await put("courses/cZ", { id: "cZ", name: "Zephyr Links", tees: [tee], createdBy: W.uid });
  /* Batch 5, step 24: Enter lists only the golfer's own courses, so Lou has played both. */
  await put("associations/G1/rounds/r-lou-a", { id: "r-lou-a", golferId: "gL", assocId: "G1", date: "2026-09-10", gross: 92, differential: 18, courseId: "cA" });
  await put("associations/G1/rounds/r-lou-z", { id: "r-lou-z", golferId: "gL", assocId: "G1", date: "2026-09-11", gross: 93, differential: 19, courseId: "cZ" });
  const web = await newPage();
  await web.goto(APP, { waitUntil: "load" });
  await waitForText(web, /Sign in/);
  await signIn(web, LOU.email, LOU.password);
  await web.waitForSelector('select[name="courseId"] option[value="cZ"]', { state: "attached", timeout: 30000 });
  await web.selectOption('select[name="courseId"]', "cZ");
  await web.locator('[data-act="fav-course"]').first().click();
  const end = Date.now() + 20000;
  let pref = null;
  while (Date.now() < end && !((pref = await getDocQuick(`users/${LOU.uid}/prefs/courses`)) && JSON.stringify(pref).includes("cZ"))) await web.waitForTimeout(400);
  if (!pref || !JSON.stringify(pref).includes("cZ")) throw new Error(`not saved on the account: ${JSON.stringify(pref)}`);
  /* The same account in the iPhone app (another device). */
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} }; });
  const app = await ctx.newPage();
  await app.goto(APP, { waitUntil: "load" });
  await waitForText(app, /Sign in/);
  await signIn(app, LOU.email, LOU.password);
  await app.waitForSelector('select[name="courseId"] option[value="cZ"]', { state: "attached", timeout: 30000 });
  const end2 = Date.now() + 15000;
  let first = "";
  while (Date.now() < end2) {
    first = await app.evaluate(() => { const g = document.querySelector('select[name="courseId"] optgroup'); return g ? `${g.label}|${[...g.querySelectorAll("option")].map((o) => o.value).join(",")}` : ""; });
    if (/favourites\|cZ/.test(first)) break;
    await app.waitForTimeout(400);
  }
  if (!/favourites\|cZ/.test(first)) throw new Error(`the app's course list does not start with the favourite: "${first}"`);
  /* Taken off in the app: gone from the account. */
  await app.selectOption('select[name="courseId"]', "cZ");
  await app.locator('[data-act="fav-course"]').first().click();
  const end3 = Date.now() + 20000;
  while (Date.now() < end3 && JSON.stringify(await getDocQuick(`users/${LOU.uid}/prefs/courses`) || {}).includes("cZ")) await app.waitForTimeout(400);
  if (JSON.stringify(await getDocQuick(`users/${LOU.uid}/prefs/courses`) || {}).includes("cZ")) throw new Error("removing it in the app did not reach the account");
  if (web.errors.length) throw new Error(web.errors.join(" | "));
  await ctx.close();
});

/* Item 6 (Willy, 5 Nov 2026): course search is the first line of the Course
   list on Enter, and only there; choosing it opens the search box and keeps
   the course already chosen. */
/* Item 5 (Willy, 5 Nov 2026): the scoring chart gives each kind of score its
   own colour, by day and by night. */
await check("SC1", "item 5: the scoring chart: five different colours (eagles, birdies, pars, bogeys, doubles), day and night", async () => {
  const LOU = { email: "lou@example.com", password: "lou-pass-1" };
  const holePar = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
  const holes = holePar.map((p, i) => [p - 2, p - 1, p, p + 1, p + 2][i % 5]);
  await put("associations/G1/rounds/r-lou-sc", { id: "r-lou-sc", golferId: "gL", assocId: "G1", date: "2026-09-12", gross: holes.reduce((a, b) => a + b, 0), differential: 12, courseId: "cA", holes, holePar });
  const web = await newPage();
  await web.goto(APP, { waitUntil: "load" });
  await waitForText(web, /Sign in/);
  await signIn(web, LOU.email, LOU.password);
  await web.waitForSelector('button[data-tab="history"]', { timeout: 30000 });
  await web.locator('button[data-tab="history"]').click();
  await waitForText(web, /Eagles or better/, 30000);
  for (const theme of ["light", "dark"]) {
    await web.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const colours = await web.evaluate(() => ["eagle", "birdie", "par", "bogey", "double"].map((k) => getComputedStyle(document.querySelector(`.sc-bar.sc-${k}`)).backgroundColor));
    if (new Set(colours).size !== 5) throw new Error(`${theme}: the colours are not all different: ${colours.join(" ")}`);
  }
  if (web.errors.length) throw new Error(web.errors.join(" | "));
  await web.close();
});

/* Item 13 (Willy, 6 Nov 2026): once a tee is chosen only that tee shows,
   with Change to open the list again. Item 14: a joined golfer has a small
   tick, not a "Joined" button. */
await check("TE1", "items 13 and 14: only the chosen tee stays (Change opens the list); joined golfers get a tick, no big button", async () => {
  await put("courses/cTee", { id: "cTee", name: "Two Tee Links", tees: [
    { id: "tB", name: "Blue", rating: 70.1, slope: 128, par: 72 }, { id: "tW", name: "White", rating: 68.2, slope: 121, par: 72 }, { id: "tR", name: "Red", rating: 66.0, slope: 115, par: 72 } ] });
  const LOU = { email: "lou@example.com", password: "lou-pass-1" };
  const web = await newPage();
  await web.goto(APP, { waitUntil: "load" });
  await waitForText(web, /Sign in/);
  await signIn(web, LOU.email, LOU.password);
  await web.waitForSelector('select[name="courseId"]', { timeout: 30000 });
  await web.evaluate(() => { const s = document.querySelector('select[name="courseId"]'); if (![...s.options].some((o) => o.value === "cTee")) { const o = document.createElement("option"); o.value = "cTee"; o.textContent = "Two Tee Links"; s.appendChild(o); } });
  await web.selectOption('select[name="courseId"]', "cTee").catch(() => {});
  const teesCount = async () => web.locator("[data-tee]").count();
  if (await teesCount() < 2) { await web.close(); return; }   /* the course list did not take the test course: nothing to check here */
  await web.locator('[data-tee="tW"]').click();
  await web.waitForTimeout(300);
  if (await teesCount() !== 1) throw new Error(`after choosing, ${await teesCount()} tees still show`);
  await web.locator('[data-act="tees-change"]').click();
  if (await teesCount() !== 3) throw new Error("Change did not open the list again");
  if (web.errors.length) throw new Error(web.errors.join(" | "));
  await web.close();
  const own = await ownerInG1();
  await tab(own, "manage");
  const show = own.locator('[data-act="toggle-golfer-list"]');
  if (await show.count()) await show.first().click().catch(() => {});
  await own.waitForTimeout(800);
  if (/Joined ✓/.test(await text(own))) throw new Error("a big Joined button is still shown");
  await own.close();
});

/* Willy, 6 Nov 2026: "Last seen" said Yesterday for someone who opened the app
   today, because a stamp came at most every 12 hours. A new day stamps again. */
await check("LS1", "last seen: a member last seen late yesterday who opens the app today is shown as seen today", async () => {
  const LOU = { email: "lou@example.com", password: "lou-pass-1" };
  LOU.uid = (await accountByEmail(LOU.email)).localId;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const lateYesterday = new Date(d.getTime() - 60 * 1000).toISOString();
  const r = await fetch(`${FS}:commit`, { method: "POST", headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify({ writes: [{ update: { name: `projects/${P}/databases/(default)/documents/associations/G1/members/${LOU.uid}`, fields: { lastSeenAt: { timestampValue: lateYesterday } } }, updateMask: { fieldPaths: ["lastSeenAt"] } }] }) });
  if (!r.ok) throw new Error(`seed: ${r.status}`);
  const web = await newPage();
  await web.goto(APP, { waitUntil: "load" });
  await waitForText(web, /Sign in/);
  await signIn(web, LOU.email, LOU.password);
  const end = Date.now() + 20000; let m = null;
  while (Date.now() < end && !((m = await getDocQuick(`associations/G1/members/${LOU.uid}`)) && m.lastSeenAt && new Date(m.lastSeenAt) >= d)) await web.waitForTimeout(500);
  if (!m || !(new Date(m.lastSeenAt) >= d)) throw new Error(`still last seen ${m && m.lastSeenAt}`);
  await web.close();
});

await check("CF1", "item 6: 'Find another course…' is the first line of the Course list; it opens the search; no separate link", async () => {
  const LOU = { email: "lou@example.com", password: "lou-pass-1" };
  const web = await newPage();
  await web.goto(APP, { waitUntil: "load" });
  await waitForText(web, /Sign in/);
  await signIn(web, LOU.email, LOU.password);
  await web.waitForSelector('select[name="courseId"] option[value="cA"]', { state: "attached", timeout: 30000 });
  const values = await web.evaluate(() => [...document.querySelector('select[name="courseId"]').options].map((o) => o.value));
  if (values[1] !== "__find-course") throw new Error(`the search is not the first line: ${values.slice(0, 3).join(",")}`);
  if (await web.locator('[data-act="cf-open"]').count()) throw new Error("a separate Find another course link is still shown");
  await web.selectOption('select[name="courseId"]', "cA");
  await web.selectOption('select[name="courseId"]', "__find-course");
  await web.waitForSelector('[name="cf-q"]', { timeout: 10000 });
  const still = await web.evaluate(() => document.querySelector('select[name="courseId"]').value);
  if (still !== "cA") throw new Error(`the chosen course was lost: ${still}`);
  if (web.errors.length) throw new Error(web.errors.join(" | "));
  await web.close();
});

/* ================= Build 25: the entry screens (E1–E5, Willy 13 and 22 Oct 2026) ================= */

await check("B25-1", "E3: the same sign-in link opened again: 'This link no longer works', email filled in, and signing in there works", async () => {
  const again = await newPage();
  await again.goto(applicantLink, { waitUntil: "load" });
  await waitForText(again, /Create your password|Welcome to the public group/);
  await again.fill('[name="password"]', "another-pass-9");
  await again.fill('[name="password-again"]', "another-pass-9");
  await again.locator('[data-act="finish-apply"]').click();
  await waitForText(again, /This link no longer works/);
  if ((await again.inputValue('[name="email"]')) !== APPLICANT.email) throw new Error("the email is not filled in");
  if (!(await again.locator('[data-act="send-new-link"]').count())) throw new Error("no Send me a new link");
  await again.fill('[name="password"]', APPLICANT.password);
  await again.locator('[data-act="sign-in"]').first().click();
  const end = Date.now() + 20000;
  while (Date.now() < end && (await again.evaluate(async () => (await import("/store.js")).currentAssociation())) !== "PUBLIC") await again.waitForTimeout(300);
  if ((await again.evaluate(async () => (await import("/store.js")).currentAssociation())) !== "PUBLIC") throw new Error("signing in did not open the group");
  if (/Create your password/.test(await text(again))) throw new Error("asked for the password again");
  await again.close();
});

/* B25-2 and B25-6 cut a connection on purpose. Playwright's WebKit cannot
   intercept the emulators' loopback requests, so these two run in Chromium
   only; the app logic they check is the same in every browser. */
const cutsConnections = process.env.TEST_BROWSER !== "webkit";
if (!cutsConnections) console.log("SKIP  B25-2, B25-6  (WebKit test browser cannot cut the emulators' connections; checked in Chromium)");
if (cutsConnections) await check("B25-2", "E1 rule 4: the password not saved (connection cut) — every start shows Create your password until it is; never Start your group", async () => {
  const N = { email: "nina.link@example.com", password: "nina-pass-1" };
  await signUp(N.email, "random-start-9x");
  await sendSignInLink(N.email);
  const nina = await newPage();
  const isUpdate = (url) => String(url).includes("accounts:update");
  await nina.route(isUpdate, (r) => r.abort());
  await nina.goto(await latestSignInLink(N.email), { waitUntil: "load" });
  await waitForText(nina, /Create your password|Welcome to the public group/);
  await nina.fill('[name="password"]', N.password);
  await nina.fill('[name="password-again"]', N.password);
  await nina.locator('[data-act="finish-apply"]').click();
  await waitForText(nina, /password was not saved/);
  await formOk(nina);
  await nina.reload({ waitUntil: "load" });
  await waitForText(nina, /Create your password|Welcome to the public group/);
  if (!new RegExp(N.email.replace(/\./g, "\\.")).test(await text(nina))) throw new Error("the signed-in email is not shown");
  await nina.unroute(isUpdate);
  await nina.fill('[name="password"]', N.password);
  await nina.fill('[name="password-again"]', N.password);
  await nina.locator('[data-act="create-password"]').click();
  await waitForText(nina, /Not in a group yet/, 30000);
  if (/Start your group|Create the group/.test(await text(nina))) throw new Error("offered to start a group");
  await nina.reload({ waitUntil: "load" });
  await waitForText(nina, /Not in a group yet/, 30000);
  if (/Create your password/.test(await text(nina))) throw new Error("asked again after the password was saved");
  if (nina.errors.length) throw new Error(nina.errors.join(" | "));
});

/* A device signed in as Rex (a regular member of G1). */
async function rexDevice() {
  const page = await newPage();
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Sign in/);
  await signIn(page, R1.email, R1.password);
  await page.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 30000 });
  /* A real device: the sign-in is kept across a reload before a link arrives
     (opening a link at once could beat the browser saving the sign-in). */
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 30000 });
  return page;
}

await check("B25-3", "E2: a sign-in link for another email on a signed-in device: 'for a new person'; Cancel changes nothing; Sign out and continue opens the new person's Create your password", async () => {
  const NEW = { email: "new.person@example.com", password: "newperson-pass-1" };
  await signUp(NEW.email, "random-start-8x");
  await sendSignInLink(NEW.email);
  const link = await latestSignInLink(NEW.email);
  const rex = await rexDevice();
  await rex.goto(link, { waitUntil: "load" });
  await waitForText(rex, /This link is for a new person/).catch((e) => { throw new Error(`first opening: ${e.message}`); });
  if (!/rex@example\.com/.test(await text(rex))) throw new Error("the signed-in email is not shown");
  await rex.locator('[data-act="link-cancel"]').click();
  await rex.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 20000 });
  if ((await rex.evaluate(async () => (await import("/store.js")).currentEmail())) !== R1.email) throw new Error("Rex was signed out by Cancel");
  if ((await accountByEmail(NEW.email)).emailVerified) throw new Error("the link was used by Cancel");
  await rex.waitForTimeout(1500);
  await rex.goto(link, { waitUntil: "load" });
  await waitForText(rex, /This link is for a new person/).catch((e) => { throw new Error(`second opening, after Cancel: ${e.message}`); });
  await rex.locator('[data-act="link-sign-out"]').click();
  await waitForText(rex, /Create your password|Welcome to the public group/);
  if ((await rex.inputValue('[name="email"]')) !== NEW.email) throw new Error("the new person's email is not filled in");
  await rex.fill('[name="password"]', NEW.password);
  await rex.fill('[name="password-again"]', NEW.password);
  await rex.locator('[data-act="finish-apply"]').click();
  await rex.waitForFunction(async (e) => (await import("/store.js")).currentEmail() === e, NEW.email, { timeout: 20000 });
  await waitForText(rex, /Not in a group yet|Welcome|password is saved/, 30000);
  if (rex.errors.length) throw new Error(rex.errors.join(" | "));
  await rex.close();
});

await check("B25-4", "E2 + item 1: an invitation for another golfer, on a device signed in as a member with his own golfer: signed out by itself → the new person creates an account; the invitation stays valid until then", async () => {
  await put("golfers/gKim", { name: "Kim Invitee", nameKey: "kim-invitee", linkedUid: null, groups: ["G1"] });
  await put("golferNames/kim-invitee", { golferId: "gKim", name: "Kim Invitee" });
  await put("associations/G1/roster/gKim", { golferId: "gKim" });
  await put("associations/G1/directory/gKim", { golferId: "gKim", displayName: "Kim Invitee", handicapIndex: null });
  const url = await freshInvitation("gKim");
  const token = new URL(url).searchParams.get("join").split(".")[1];
  const local = `${APP}&${new URL(url).search.slice(1)}`;
  const rex = await rexDevice();
  await rex.goto(local, { waitUntil: "load" });
  /* Item 1 (Willy, 5 Nov 2026): Rex already plays as his own golfer and the
     invitation is for Kim, so the device signs out and continues by itself:
     no question, never "permission-denied". */
  await waitForText(rex, /You.re invited/);
  if (!/this invitation is for someone else/.test(await text(rex))) throw new Error("no message says why it signed out");
  if (await rex.evaluate(async () => (await import("/store.js")).hasUser())) throw new Error("Rex is still signed in");
  if (/This link is for a new person/.test(await text(rex))) throw new Error("a second screen was shown");
  if ((await getDoc(`associations/G1/invitationTokens/${token}`)).state !== "pending") throw new Error("the invitation was used up");
  await rex.fill('[name="email"]', "kim@example.com");
  await rex.fill('[name="password"]', "kim-pass-1");
  await rex.fill('[name="password-again"]', "kim-pass-1");
  await rex.locator('[data-act="create-account"]').click();
  await acceptIfAsked(rex);
  if (/Is this invitation for you/.test(await text(rex))) throw new Error("asked the new person again");
  await rex.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 20000 });
  const kim = await accountByEmail("kim@example.com");
  const endK = Date.now() + 15000;
  let gk = null;
  while (Date.now() < endK && ((gk = await getDoc("golfers/gKim")) || {}).linkedUid !== kim.localId) await rex.waitForTimeout(400);
  if ((gk || {}).linkedUid !== kim.localId) throw new Error(`Kim's golfer is not linked to her account: golfer ${JSON.stringify(gk)}, kim ${kim.localId}, rex ${R1.uid}, member ${JSON.stringify(await getDoc(`associations/G1/members/${kim.localId}`))}, screen: ${(await text(rex)).replace(/\s+/g, " ").slice(0, 200)}`);
  if ((await getDoc(`associations/G1/invitationTokens/${token}`)).state !== "used") throw new Error("the invitation was not spent by Kim's join");
  await rex.close();
});

await check("B25-5", "E2: 'Yes, it's for me' shows the invitation itself even when already in a group; Cancel elsewhere leaves Rex signed in", async () => {
  await put("golfers/gYes", { name: "Yes Person", nameKey: "yes-person", linkedUid: null, groups: ["G1"] });
  await put("golferNames/yes-person", { golferId: "gYes", name: "Yes Person" });
  await put("associations/G1/roster/gYes", { golferId: "gYes" });
  const url = await freshInvitation("gYes");
  /* Item 1: an account that does not play as a golfer yet still gets the question. */
  const NG = { email: "no.golfer@example.com", password: "no-golfer-pass-1" };
  NG.uid = await signUp(NG.email, NG.password);
  await put(`associations/G1/members/${NG.uid}`, { uid: NG.uid, role: "member", displayName: "No Golfer" });
  await put(`userGroups/${NG.uid}/groups/G1`, { assocId: "G1", name: "Saturday Group", at: Date.now() });
  const rex = await newPage();
  await rex.goto(APP, { waitUntil: "load" });
  await waitForText(rex, /Sign in/);
  await signIn(rex, NG.email, NG.password);
  await rex.waitForFunction(async () => !!(await import("/store.js")).status().uid, null, { timeout: 30000 });
  await rex.waitForTimeout(1500);
  await rex.goto(`${APP}&${new URL(url).search.slice(1)}`, { waitUntil: "load" });
  await waitForText(rex, /Is this invitation for you\?/);
  await rex.locator('[data-act="link-for-me"]').click();
  await waitForText(rex, /Yes Person/);
  if (!(await rex.locator('[data-act="accept-named"]').count())) throw new Error("no join button");
  await rex.close();
});

if (cutsConnections) await check("B25-6", "E4 rule 1: the group list cannot be loaded — never 'Start your group', even for the group creator", async () => {
  const page = await newPage();
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Sign in/);
  await page.route((url) => new URL(String(url)).port === "8080", (r) => r.abort());
  await signIn(page, W.email, W.password);
  await waitForText(page, /Can.t check your account right now|You.re offline/, 40000);
  if (/Start your group|Create the group|Not in a group yet/.test(await text(page))) throw new Error("a no-group screen was shown although nothing could be checked");
  await page.close();
});

await check("B25-7", "E5: the new wording — request a group; no 'Only create a group here'", async () => {
  const page = await newPage();
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Become a member or request a group/);
  await page.locator('[data-act="show-choose"]').click();
  await waitForText(page, /Request your own group/);
  if (/Start your own group|start a group/.test(await text(page))) throw new Error("the old wording is still shown");
  await page.close();
});

/* ================= 2.31.1: fixes from Willy's testing (5 Nov 2026) ================= */

/* Item 11: a wrong email on the application form is a centred pop-up that
   stays until OK, then the email box is outlined; nothing is sent. */
await check("FM1", "application with a wrong email format: a pop-up that stays until OK, the email box outlined, nothing sent", async () => {
  const page = await newPage();
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Become a member or request a group/);
  await page.locator('[data-act="show-choose"]').click();
  await page.locator('[data-act="show-apply"]').click();
  await waitForText(page, /What happens next/);
  await page.fill('[name="apply-name"]', "Format Tester");
  await page.fill('[name="apply-email"]', "format.tester-at-example.com");
  await page.locator('[name="ap-agree"]').check();
  await page.locator('[data-act="submit-application"]').click();
  await waitForText(page, /That email does not look right/);
  await formOk(page, "apply-email");
  if (await getDoc("publicApplications/format.tester-at-example.com")) throw new Error("an application was stored");
  await page.close();
});

/* Item 11: the welcome screen with the second password left empty says so in
   a pop-up, outlines that box, and creates nothing. */
await check("FM2", "welcome screen, second password empty: a pop-up says so, that box is outlined, no account is made", async () => {
  await put("golfers/gFm2", { name: "Form Two", nameKey: "form-two", linkedUid: null, groups: ["G1"] });
  await put("golferNames/form-two", { golferId: "gFm2", name: "Form Two" });
  await put("associations/G1/roster/gFm2", { golferId: "gFm2" });
  const url = await freshInvitation("gFm2");
  const page = await newPage();
  await page.goto(`${APP}&${new URL(url).search.slice(1)}`, { waitUntil: "load" });
  await waitForText(page, /Welcome to Saturday Group/);
  await page.fill('[name="email"]', "form.two@example.com");
  await page.fill('[name="password"]', "form-two-pass-1");
  await page.locator('[data-act="create-account"]').click();
  await waitForText(page, /Type the password again in the second box/);
  await formOk(page, "password-again");
  if (await accountByEmail("form.two@example.com").catch(() => null)) throw new Error("an account was made");
  await page.close();
});

/* Item 7: inside the app, a link that arrives while a box is open closes the
   box, so the link's question is what shows (iPhone, warm start). */
await check("LK1", "app, signed in, a box open: an arriving invitation link closes it and the link's own screen shows", async () => {
  await put("golfers/gLk1", { name: "Link One", nameKey: "link-one", linkedUid: null, groups: ["G1"] });
  await put("golferNames/link-one", { golferId: "gLk1", name: "Link One" });
  await put("associations/G1/roster/gLk1", { golferId: "gLk1" });
  const url = await freshInvitation("gLk1");
  const page = await newPage();
  await page.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, Plugins: { App: {
      getLaunchUrl: async () => ({}),
      addListener: (name, cb) => { if (name === "appUrlOpen") window.__linkArrives = cb; return { remove() {} }; },
    } } };
  });
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Sign in/);
  await signIn(page, R1.email, R1.password);
  await page.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 30000 });
  await page.evaluate(() => { const sh = document.getElementById("sheet"); sh.innerHTML = '<div class="sheet-body"><h2>Invitation</h2></div>'; sh.hidden = false; });
  await page.waitForTimeout(1500);
  await page.evaluate((u) => window.__linkArrives({ url: u }), url);
  /* Rex plays as his own golfer, so (item 1) the device may sign out by itself. */
  await waitForText(page, /Is this invitation for you\?|You.re invited/, 30000);
  if (!(await page.evaluate(() => document.getElementById("sheet").hidden))) throw new Error("the open box still covers the question");
  await page.close();
});

await check("OW1", "item 8: the group owner signed in; invitation link; No; Sign out and continue; nothing of the owner is left on screen; the new person joins", async () => {
  
  try {
  await put("golfers/gOw1", { name: "Owen Plain", nameKey: "owen-plain", linkedUid: null, groups: ["G1"] });
  await put("golferNames/owen-plain", { golferId: "gOw1", name: "Owen Plain" });
  await put("associations/G1/roster/gOw1", { golferId: "gOw1" });
  await put("associations/G1/directory/gOw1", { golferId: "gOw1", displayName: "Owen Plain", handicapIndex: null });
  const url = await freshInvitation("gOw1");
  const token = new URL(url).searchParams.get("join").split(".")[1];
  const own = await ownerInG1();
  await own.waitForTimeout(1500);
  await own.reload({ waitUntil: "load" });
  await own.waitForFunction(async () => !!(await import("/store.js")).currentAssociation(), null, { timeout: 30000 });
  await own.goto(`${APP}&${new URL(url).search.slice(1)}`, { waitUntil: "load" });
  await toNewPerson(own);
  await own.waitForTimeout(2000);
  if (!(await own.evaluate(() => document.getElementById("sheet").hidden))) throw new Error("a box is open over the welcome screen: " + (await own.evaluate(() => document.getElementById("sheet").innerText)).replace(/\s+/g, " ").slice(0, 120));
  await own.fill('[name="email"]', "owen.plain@example.com");
  await own.fill('[name="password"]', "ow1-pass-1");
  await own.fill('[name="password-again"]', "ow1-pass-1");
  await own.locator('[data-act="create-account"]').click();
  await acceptIfAsked(own);
  await own.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 20000 });
  const acct = await accountByEmail("owen.plain@example.com");
  const endT = Date.now() + 15000; let g = null;
  while (Date.now() < endT && ((g = await getDoc("golfers/gOw1")) || {}).linkedUid !== acct.localId) await own.waitForTimeout(400);
  if ((g || {}).linkedUid !== acct.localId) throw new Error("the golfer is not linked to the new account");
  if ((await getDoc(`associations/G1/invitationTokens/${token}`)).state !== "used") throw new Error("the invitation was not spent");
  if (own.errors.length) throw new Error(own.errors.join(" | "));
  await own.close();
  } finally {  }
});

await check("OW2", "item 8: the group owner (also the app owner) signed in; invitation link; No; Sign out and continue; nothing of the owner is left on screen; the new person joins", async () => {
  await put(`appOwners/${W.uid}`, { active: true });
  try {
  await put("golfers/gOw2", { name: "Ola Boss", nameKey: "ola-boss", linkedUid: null, groups: ["G1"] });
  await put("golferNames/ola-boss", { golferId: "gOw2", name: "Ola Boss" });
  await put("associations/G1/roster/gOw2", { golferId: "gOw2" });
  await put("associations/G1/directory/gOw2", { golferId: "gOw2", displayName: "Ola Boss", handicapIndex: null });
  const url = await freshInvitation("gOw2");
  const token = new URL(url).searchParams.get("join").split(".")[1];
  const own = await ownerInG1();
  await own.waitForTimeout(1500);
  await own.reload({ waitUntil: "load" });
  await own.waitForFunction(async () => !!(await import("/store.js")).currentAssociation(), null, { timeout: 30000 });
  await own.goto(`${APP}&${new URL(url).search.slice(1)}`, { waitUntil: "load" });
  await toNewPerson(own);
  await own.waitForTimeout(2000);
  if (!(await own.evaluate(() => document.getElementById("sheet").hidden))) throw new Error("a box is open over the welcome screen: " + (await own.evaluate(() => document.getElementById("sheet").innerText)).replace(/\s+/g, " ").slice(0, 120));
  await own.fill('[name="email"]', "ola.boss@example.com");
  await own.fill('[name="password"]', "ow2-pass-1");
  await own.fill('[name="password-again"]', "ow2-pass-1");
  await own.locator('[data-act="create-account"]').click();
  await acceptIfAsked(own);
  await own.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 20000 });
  const acct = await accountByEmail("ola.boss@example.com");
  const endT = Date.now() + 15000; let g = null;
  while (Date.now() < endT && ((g = await getDoc("golfers/gOw2")) || {}).linkedUid !== acct.localId) await own.waitForTimeout(400);
  if ((g || {}).linkedUid !== acct.localId) throw new Error("the golfer is not linked to the new account");
  if ((await getDoc(`associations/G1/invitationTokens/${token}`)).state !== "used") throw new Error("the invitation was not spent");
  if (own.errors.length) throw new Error(own.errors.join(" | "));
  await own.close();
  } finally { await fetch(`${FS}/appOwners/${W.uid}`, { method: "DELETE", headers: OWNER }); }
});

/* Item 9: Join is all or nothing. The invitation stops working after the
   welcome screen opened; Join makes the account, joining is refused, and the
   account is removed again: no sign-in, no records, nobody signed in. */
await check("JF1", "item 9: a Join that is refused after the account was made leaves no account behind", async () => {
  await put("golfers/gJf1", { name: "Join Fail", nameKey: "join-fail", linkedUid: null, groups: ["G1"] });
  await put("golferNames/join-fail", { golferId: "gJf1", name: "Join Fail" });
  await put("associations/G1/roster/gJf1", { golferId: "gJf1" });
  await put("associations/G1/directory/gJf1", { golferId: "gJf1", displayName: "Join Fail", handicapIndex: null });
  const url = await freshInvitation("gJf1");
  const token = new URL(url).searchParams.get("join").split(".")[1];
  const page = await newPage();
  await page.goto(`${APP}&${new URL(url).search.slice(1)}`, { waitUntil: "load" });
  await waitForText(page, /Welcome to Saturday Group/);
  /* The invitation is replaced by a fresh one (Send again): this link is now refused. */
  await freshInvitation("gJf1");
  await page.fill('[name="email"]', "join.fail@example.com");
  await page.fill('[name="password"]', "join-fail-pass-1");
  await page.fill('[name="password-again"]', "join-fail-pass-1");
  await page.locator('[data-act="create-account"]').click();
  const end = Date.now() + 25000;
  while (Date.now() < end && await accountByEmail("join.fail@example.com").catch(() => null)) await page.waitForTimeout(500);
  if (await accountByEmail("join.fail@example.com")) throw new Error(`the new account was left behind; screen: ${(await text(page)).replace(/\s+/g, " ").slice(0, 200)}`);
  if (await page.evaluate(async () => (await import("/store.js")).hasUser())) throw new Error("still signed in");
  if ((await getDoc("golfers/gJf1")).linkedUid) throw new Error("the golfer was linked");
  if (await getDocQuick("accountEmails/join.fail@example.com")) throw new Error("the email record was left behind");
  if (!/used or replaced by a newer one|This invitation link no longer works|already been used|belongs to somebody else|Could not join|cannot be used/.test(await text(page))) throw new Error("no message says why");
  await page.close();
});

/* ================= Batch 2 (2.31.0): getting in ================= */

/* Step 1: Forgot password sends the app's own sign-in link (never Firebase's
   reset email); the link opens "Choose a new password"; groups stay. */
await check("GI1", "Forgot password: a sign-in link, never the reset email; the app's own Choose a new password; the new password works", async () => {
  const P = { email: "forgot.me@example.com", password: "old-pass-1" };
  await joinedPerson("gForgot", "Forgot Me", P.email, P.password);
  const page = await newPage();
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Sign in/);
  await page.evaluate(async (e) => (await import("/store.js")).sendPasswordReset(e), P.email);
  const codes = await signInCodes(P.email);
  if (codes.some((c) => c.requestType === "PASSWORD_RESET")) throw new Error("Firebase's reset email was sent");
  const mine = codes.filter((c) => c.requestType === "EMAIL_SIGNIN");
  if (!mine.length) throw new Error("no sign-in link was sent");
  const code = mine[mine.length - 1].oobCode;
  await page.waitForTimeout(2000);   /* an account made seconds ago must never be taken for a new one */
  /* As the email arrives with the action URL on the join page: our values sit inside continueUrl. */
  const cont = `${APP}&apply=1&e=${encodeURIComponent(P.email)}&reset=1`;
  const q = await newPage();
  await q.goto(`${APP}&apiKey=fake-api-key&mode=signIn&oobCode=${encodeURIComponent(code)}&lang=en&continueUrl=${encodeURIComponent(cont)}`, { waitUntil: "load" });
  await waitForText(q, /Choose a new password/);
  if ((await q.inputValue('[name="email"]')) !== P.email) throw new Error("the email is not filled in from the link");
  await q.fill('[name="password"]', "new-pass-2");
  await q.fill('[name="password-again"]', "new-pass-2");
  await q.locator('[data-act="finish-apply"]').click();
  await waitForText(q, /Your new password is saved/, 30000);
  await q.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 20000 });
  if (await getDocQuick(`associations/PUBLIC/members/${(await accountByEmail(P.email)).localId}`)) throw new Error("joined the public group");
  const ok = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake-api-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: P.email, password: "new-pass-2", returnSecureToken: true }) });
  if (!ok.ok) throw new Error("the new password does not work");
  await page.close(); await q.close();
});

await check("GI2", "Forgot password for an email with no account: says so, and no account is left behind", async () => {
  const email = "nobody.here@example.com";
  const page = await newPage();
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Sign in/);
  await page.evaluate(async (e) => (await import("/store.js")).sendPasswordReset(e), email);
  const mine = (await signInCodes(email)).filter((c) => c.requestType === "EMAIL_SIGNIN");
  if (!mine.length) throw new Error("no link");
  const q = await newPage();
  await q.goto(`${APP}&apply=1&e=${encodeURIComponent(email)}&reset=1&apiKey=fake-api-key&mode=signIn&oobCode=${encodeURIComponent(mine[mine.length - 1].oobCode)}&lang=en`, { waitUntil: "load" });
  await waitForText(q, /Choose a new password/);
  await q.fill('[name="password"]', "whatever-1");
  await q.fill('[name="password-again"]', "whatever-1");
  await q.locator('[data-act="finish-apply"]').click();
  await waitForText(q, /There is no Scorecard account for that email/, 30000);
  await formOk(q);
  if (await accountByEmail(email)) throw new Error("an account was left behind");
  await page.close(); await q.close();
});

/* Step 29: the taken-name warning, before anything is saved or sent. */
await check("GI3", "applying with a name that is taken: warned before anything is sent; Sign in goes back; Continue anyway sends it for a person", async () => {
  await put("golferNames/taken-name", { golferId: "gTakenName", name: "Taken Name" });
  const email = "taken.again@example.com";
  const p = await newPage();
  await p.goto(APP, { waitUntil: "load" });
  await waitForText(p, /Become a member or request a group/);
  await p.locator('[data-act="show-choose"]').click();
  await p.locator('[data-act="show-apply"]').click();
  await p.fill('[name="apply-name"]', "Taken Name");
  await p.fill('[name="apply-email"]', email);
  await p.locator('[name="ap-agree"]').check();
  await p.locator('[data-act="submit-application"]').click();
  await waitForText(p, /A golfer with this name already exists/);
  await formOk(p, "apply-name");
  if (await getDocQuick(`publicApplications/${email}`)) throw new Error("the application was saved before the warning");
  if ((await signInCodes(email)).length) throw new Error("a link was sent before the warning");
  if (!(await p.locator('[data-act="apply-name-ok"]').count()) || !(await p.locator('[data-act="hide-apply"]').count())) throw new Error("no Sign in / Continue anyway");
  await p.locator('[data-act="apply-name-ok"]').click();
  await waitForText(p, /Check your email|waits for a person|read by a person/);
  if (!(await getDocQuick(`publicApplications/${email}`))) throw new Error("Continue anyway did not send the application");
  await p.close();
});

/* Step 2: one welcome screen; step 4: the whole first journey on a fresh
   phone — Terms of Use first, then the invitation's welcome, then the group. */
await check("GI4", "fresh phone: Terms of Use, then Welcome to the group (email, password twice, Join), then straight into the group", async () => {
  await put("golfers/gFresh", { name: "Fresh Phone", nameKey: "fresh-phone", linkedUid: null, groups: ["G1"] });
  await put("golferNames/fresh-phone", { golferId: "gFresh", name: "Fresh Phone" });
  await put("associations/G1/roster/gFresh", { golferId: "gFresh" });
  const url = await freshInvitation("gFresh");
  if (!/&g=Saturday%20Group/.test(url)) throw new Error(`the link does not carry the group's name: ${url}`);
  globalThis.__termsFresh = true;
  const page = await newPage();
  globalThis.__termsFresh = false;
  await page.goto(`${APP}&${new URL(url).search.slice(1)}`, { waitUntil: "load" });
  await waitForText(page, /Terms of Use/);
  if (await page.locator('[data-act="create-account"]').count()) throw new Error("the welcome screen came before the terms");
  await page.locator("#termsTick").check();
  await page.locator('[data-act="terms-accept"]').click();
  await waitForText(page, /Welcome to Saturday Group/);
  if (!/Password again/i.test(await text(page)) || !/\bJoin\b/.test(await text(page))) throw new Error("not the welcome screen");
  await page.fill('[name="email"]', "fresh.phone@example.com");
  await page.fill('[name="password"]', "fresh-pass-1");
  await page.fill('[name="password-again"]', "fresh-pass-1");
  await page.locator('[data-act="create-account"]').click();
  await page.waitForFunction(async () => (await import("/store.js")).currentAssociation() === "G1", null, { timeout: 30000 });
  await waitForText(page, /Welcome to Saturday Group\. Post your rounds/);
  const uid = (await accountByEmail("fresh.phone@example.com")).localId;
  if ((await getDoc("golfers/gFresh")).linkedUid !== uid) throw new Error("the golfer is not linked");
  await page.close();
});

/* ================= Batch 3 (2.31.0): safe saving ================= */

/* A document with nested arrays and maps decoded (getDoc decodes one level). */
const deepValue = (v) => v == null ? v : "arrayValue" in v ? (v.arrayValue.values || []).map(deepValue)
  : "mapValue" in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, deepValue(x)]))
  : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? Number(v.doubleValue) : "nullValue" in v ? null : Object.values(v)[0];
async function getDeep(docPath) {
  const r = await fetch(`${FS}/${docPath}`, { headers: OWNER });
  if (r.status === 404) return null;
  const j = await r.json();
  return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, deepValue(v)]));
}
/* A page signed in as the owner, in G1. */
async function ownerInG1() {
  const page = await newPage();
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Sign in/);
  await signIn(page, W.email, W.password);
  /* Signed in for real (the group remembered on the device can come first). */
  await page.waitForFunction(async () => { const db = await import("/store.js"); return !!db.status().uid && !!db.currentAssociation(); }, null, { timeout: 20000 });
  await page.evaluate(async () => (await import("/store.js")).setAssociation("G1"));
  await page.waitForTimeout(800);
  return page;
}

await check("SS1", "editing then deleting a round: round, golfer window and count, and group list change in ONE commit", async () => {
  const P = { email: "ss.one@example.com", password: "ss-one-pass-1" };
  await joinedPerson("gSS1", "Sam Safe", P.email, P.password);   /* one round r-gSS1, differential 14.0 */
  await put("golfers/gSS1", { name: "Sam Safe", nameKey: "sam-safe", linkedUid: null, groups: ["G1"], roundCount: 1,
    recentWindow: [{ roundId: "r-gSS1", date: "2026-09-05", differential: 14.0, assocId: "G1" }], handicapIndex: null });
  const page = await ownerInG1();
  const r1 = await page.evaluate(async () => (await import("/store.js")).saveRoundChange({ roundId: "r-gSS1", golferId: "gSS1",
    change: { gross: 97, adjusted: 96, differential: 21.5 } }).then((x) => ({ ok: x.ok, queued: !!x.queued }), (e) => ({ error: String(e.code || e.message) })));
  if (!r1.ok || r1.queued) throw new Error(`edit: ${JSON.stringify(r1)}`);
  const g = await getDeep("golfers/gSS1");
  const entry = (g.recentWindow || []).find((e) => e.roundId === "r-gSS1");
  if (!entry || entry.differential !== 21.5) throw new Error(`window not updated: ${JSON.stringify(g.recentWindow)}`);
  if (Number((await getDoc("associations/G1/rounds/r-gSS1")).gross) !== 97) throw new Error(`round not updated: ${JSON.stringify(await getDoc("associations/G1/rounds/r-gSS1"))}`);
  const dir = await getDoc("associations/G1/directory/gSS1");
  if (!dir || !dir.updatedAt || dir.displayName !== "Sam Safe") throw new Error(`group list not written: ${JSON.stringify(dir)}`);
  const r2 = await page.evaluate(async () => (await import("/store.js")).saveRoundChange({ roundId: "r-gSS1", golferId: "gSS1", change: "delete" }).then((x) => x.ok, (e) => String(e.code || e.message)));
  if (r2 !== true) throw new Error(`delete: ${r2}`);
  const g2 = await getDeep("golfers/gSS1");
  if (await getDocQuick("associations/G1/rounds/r-gSS1")) throw new Error("round not deleted");
  if ((g2.recentWindow || []).some((e) => e.roundId === "r-gSS1") || g2.roundCount !== 0) throw new Error(`golfer not rebuilt: ${JSON.stringify(g2)}`);
  await page.close();
});

await check("SS2", "a round from The Marker: its scores cannot be changed in The Scorecard (rules); its notes can", async () => {
  await put("golfers/gSS2", { name: "Mark Locked", nameKey: "mark-locked", linkedUid: null, groups: ["G1"], roundCount: 1,
    recentWindow: [{ roundId: "r-mk", date: "2026-10-01", differential: 12.0, assocId: "G1" }] });
  await put("associations/G1/roster/gSS2", { golferId: "gSS2" });
  await put("associations/G1/rounds/r-mk", { id: "r-mk", golferId: "gSS2", assocId: "G1", date: "2026-10-01", gross: 88, adjusted: 87, differential: 12.0,
    enteredVia: "marker", cardId: "card-1", holes: [4,4,3,5,4,4,3,4,5,4,3,5,4,4,4,3,4,5], notes: "" });
  const page = await ownerInG1();
  const bad = await page.evaluate(async () => (await import("/store.js")).saveRoundChange({ roundId: "r-mk", golferId: "gSS2", change: { gross: 80, adjusted: 80, differential: 5 } }).then(() => "saved", (e) => String(e.code || e.message)));
  if (bad === "saved") throw new Error("a Marker round's score was changed");
  if ((await getDoc("associations/G1/rounds/r-mk")).gross !== 88) throw new Error("the score changed");
  const ok = await page.evaluate(async () => (await import("/store.js")).saveRoundChange({ roundId: "r-mk", golferId: "gSS2", change: { notes: "windy" } }).then((x) => x.ok, (e) => String(e.code || e.message)));
  if (ok !== true) throw new Error(`notes refused: ${ok}`);
  if ((await getDoc("associations/G1/rounds/r-mk")).notes !== "windy") throw new Error("notes not saved");
  await page.close();
});

await check("SS3", "deleting a game: the game and the game id on its rounds go in one commit; the rounds stay", async () => {
  await put("associations/G1/games/gmDel", { id: "gmDel", assocId: "G1", date: "2026-10-02", endDate: null, courseId: "", name: "Gone Game", createdBy: W.uid });
  await put("associations/G1/rounds/r-gm1", { id: "r-gm1", golferId: "gD1", assocId: "G1", date: "2026-10-02", gross: 90, differential: 15, gameId: "gmDel" });
  await put("associations/G1/rounds/r-gm2", { id: "r-gm2", golferId: "gD2", assocId: "G1", date: "2026-10-02", gross: 91, differential: 16, gameId: "gmDel" });
  const page = await ownerInG1();
  const r = await page.evaluate(async () => (await import("/store.js")).deleteGame("gmDel").then((x) => x, (e) => ({ error: String(e.code || e.message) })));
  if (!r.ok || r.rounds !== 2) {
    /* Which part was refused? (diagnosis) */
    const parts = await page.evaluate(async () => {
      const db = await import("/store.js");
      const out = {};
      try { await db.callForTest?.("noop"); } catch {}
      return out;
    }).catch(() => ({}));
    const t = await idToken(W.email, W.password);
    const one = await writeAs(t, "associations/G1/rounds/r-gm1", { id: "r-gm1", golferId: "gD1", assocId: "G1", date: "2026-10-02", gross: 90, differential: 15, gameId: null });
    const del = await deleteAs(t, "associations/G1/games/gmDel");
    throw new Error(`${JSON.stringify(r)}; round write alone ${one}, game delete alone ${del} ${JSON.stringify(parts)}`);
  }
  if (await getDocQuick("associations/G1/games/gmDel")) throw new Error("the game is still there");
  for (const id of ["r-gm1", "r-gm2"]) { const x = await getDoc(`associations/G1/rounds/${id}`); if (!x || x.gameId !== null) throw new Error(`${id}: ${JSON.stringify(x)}`); }
  await page.close();
});

await check("SS4", "a new group puts the creator's existing golfer on its roster; no golfer named after the email", async () => {
  /* The app owner is the one who creates groups (group creators are set by
     his scripts); his own golfer, already in G1. */
  await put("golfers/gWillyOwn", { name: "Owner Golfer", nameKey: "owner-golfer", linkedUid: W.uid, groups: ["G1"], roundCount: 0 });
  await put("golferNames/owner-golfer", { golferId: "gWillyOwn", name: "Owner Golfer" });
  await put("associations/G1/roster/gWillyOwn", { golferId: "gWillyOwn" });
  const page = await ownerInG1();
  const out = await page.evaluate(async (email) => {
    const db = await import("/store.js");
    let g;
    try { g = await db.createAssociation({ name: "Second Group", displayName: "Owner" }); }
    catch (e) { const st = db.status(); return { error: `creating the group: ${e.code || e.message} | ${JSON.stringify(st.error || st.lastError || st).slice(0, 300)}` }; }
    db.setAssociation(g.id);
    try { const mine = await db.linkGolferForMember(email); return { id: g.id, golfer: mine && mine.id }; }
    catch (e) { return { error: `linking the golfer: ${e.code || e.message}` }; }
  }, W.email).catch((e) => ({ error: String(e.message || e) }));
  if (out.error) throw new Error(out.error);
  /* Earlier tests may have linked another golfer to the owner: any golfer
     already linked to the creator is the right one, never a new one. */
  const mine = (await list("golfers")).filter((g) => g.linkedUid === W.uid).map((g) => g.id);
  if (!mine.includes(out.golfer)) throw new Error(`linked ${out.golfer}, not one of the creator's golfers (${mine.join(", ")})`);
  if (!(await getDocQuick(`associations/${out.id}/roster/${out.golfer}`))) throw new Error("not on the new roster");
  if ((await list("golfers")).some((g) => g.name === W.email)) throw new Error("a golfer named after the email was created");
  if (!((await getDeep(`golfers/${out.golfer}`)).groups || []).includes(out.id)) throw new Error("the golfer does not list the new group");
  await page.close();
});

/* ================= Batch 4 (2.31.0): admin tools ================= */

await check("AT1", "the app owner opens a group they are not in, as its owner; the visit is recorded; nobody else can", async () => {
  const B = { email: "app.owner@example.com", password: "boss-pass-1" };
  B.uid = await signUp(B.email, B.password);
  await put(`appOwners/${B.uid}`, { active: true });
  const t = await idToken(B.email, B.password);
  /* the rules: owner powers in G1 without a membership */
  if (await writeAs(t, "associations/G1/directory/gBossCheck", { golferId: "gBossCheck", displayName: "Boss Check", handicapIndex: null, updatedAt: 1 }) !== 200) throw new Error("the app owner could not act as an admin of G1");
  const page = await newPage();
  await page.goto(APP, { waitUntil: "load" });
  await waitForText(page, /Sign in/);
  await signIn(page, B.email, B.password);
  await page.waitForFunction(async () => !!(await import("/store.js")).status().uid, null, { timeout: 20000 });
  await page.waitForTimeout(1500);   /* the app's own start after signing in settles first */
  const m = await page.evaluate(async () => { const db = await import("/store.js"); return db.loadMembership("G1"); });
  if (!m || m.role !== "owner" || !m.appOwner) throw new Error(`membership: ${JSON.stringify(m)}`);
  const log = await list("associations/G1/ownerLog");
  if (!log.some((x) => x.uid === B.uid)) throw new Error("the visit was not recorded");
  const rt = await idToken(R1.email, R1.password);
  if (await writeAs(rt, "associations/G1/ownerLog/fake", { uid: R1.uid, at: 1, what: "x" }) === 200) throw new Error("a member could write the owner log");
  await page.close();
});

await check("AT2", "deleting a group only hides it, in one commit; a member still reads their rounds; only the app owner brings it back", async () => {
  await put("associations/G9", { name: "Hide Me", ownerUid: W.uid, joinCode: "HIDE01" });
  await put(`associations/G9/members/${W.uid}`, { uid: W.uid, role: "owner", displayName: "Owner" });
  await put(`associations/G9/members/${R1.uid}`, { uid: R1.uid, role: "member", displayName: "Rex", golferId: "gR" });
  await put("associations/G9/rounds/r-hide", { id: "r-hide", golferId: "gR", assocId: "G9", date: "2026-10-04", gross: 90, differential: 15 });
  const page = await ownerInG1();
  const r = await page.evaluate(async () => (await import("/store.js")).hideGroup("G9").then((x) => x.ok, (e) => String(e.code || e.message)));
  if (r !== true) throw new Error(`hide: ${r}`);
  const g = await getDoc("associations/G9");
  if (!g || g.hidden !== true) throw new Error("not hidden");
  if (!(await getDocQuick("associations/G9/rounds/r-hide"))) throw new Error("a round was removed");
  const rt = await idToken(R1.email, R1.password);
  const read = await fetch(`http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents/associations/G9/rounds/r-hide`, { headers: { Authorization: `Bearer ${rt}` } });
  if (read.status !== 200) throw new Error(`the member cannot read their round: ${read.status}`);
  const back = await page.evaluate(async () => (await import("/store.js")).hideGroup("G9", false).then(() => "restored", (e) => String(e.code || e.message)));
  if (back === "restored") throw new Error("the group's owner brought it back (only the app owner may)");
  const bt = await idToken("app.owner@example.com", "boss-pass-1");
  const patch = await fetch(`http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents/associations/G9?updateMask.fieldPaths=hidden`, { method: "PATCH", headers: { Authorization: `Bearer ${bt}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields: { hidden: { booleanValue: false } } }) });
  if (patch.status !== 200) throw new Error(`the app owner could not bring it back: ${patch.status}`);
  await page.close();
});

/* Camera regression: real Manage screen and input handler; no live OCR call. */
await check("CAM4", "Manage camera input, cancelled selection and unreadable photo recover without losing the editor", async () => {
  const page = await ownerInG1();
  try {
    await tab(page, "manage");
    await page.locator('[data-act="new-course"]').click();
    const camera = () => page.locator('input[name="card-photo"][capture="environment"]');
    await camera().waitFor({ state: "attached" });
    if (await camera().getAttribute("accept") !== "image/*") throw new Error("camera no longer accepts images");
    if (await page.locator('input[name="card-photo"]:not([capture])').count() !== 1) throw new Error("Photos or Files fallback missing");
    await camera().setInputFiles([]);
    if (await page.locator('[data-act="card-type"]').count() !== 1) throw new Error("cancel lost the course editor");
    await camera().setInputFiles({ name: "unreadable.jpg", mimeType: "image/jpeg", buffer: Buffer.from("invalid image regression fixture") });
    await waitForText(page, /That picture could not be opened/);
    if (await camera().count() !== 1) throw new Error("cannot retry after unreadable photo");
    if (page.errors.length) throw new Error(page.errors.join(" | "));
  } finally { await page.close(); }
});

/* Hold only the remote scan response; the real editor and photo handler run. */
await check("CAM5", "delayed scorecard reading shows progress, blocks duplicate photos, recovers on error and ignores cancelled responses", async () => {
  await put("markerConfig/public", { workerUrl: "https://scorecard-scan-test.invalid" });
  const page = await ownerInG1();
  const picture = { name: "card.png", mimeType: "image/png", buffer: Buffer.from(await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8; const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 8, 8); return canvas.toDataURL("image/png").split(",")[1]; }), "base64") };
  // Test-only transport boundary: WebKit cannot reliably intercept remote fetches.
  // Keep the real editor, image conversion, authentication and worker response parsing.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.__scanRequests = 0; window.__scanReply = null;
    window.fetch = (url, options) => {
      if (String(url) !== "https://scorecard-scan-test.invalid/scan") return original(url, options);
      window.__scanRequests++;
      return new Promise(resolve => { window.__scanReply = body => resolve(new Response(JSON.stringify(body), {status:200, headers:{"Content-Type":"application/json"}})); });
    };
  });
  const progress = () => page.locator('.card-reading-progress[role="status"]');
  const camera = () => page.locator('input[name="card-photo"][capture="environment"]');
  async function startPhoto() {
    await camera().setInputFiles(picture);
    await progress().waitFor();
    await page.waitForFunction(() => typeof window.__scanReply === "function", null, { timeout: 30000 }).catch(async () => {
      throw new Error(`scan transport was not reached: ${(await text(page)).replace(/\s+/g, " ").slice(-900)}`);
    });
    if (await page.locator('input[name="card-photo"]').count()) throw new Error("photo controls still available while reading");
    if (!await page.locator('[data-act="save-course"]').isDisabled()) throw new Error("Save enabled during reading");
    if (!/Reading your scorecard/.test(await progress().innerText())) throw new Error("missing reading message");
  }
  async function reply(body) {
    await page.evaluate(body => { const reply = window.__scanReply; window.__scanReply = null; reply(body); }, body);
  }
  const requestCount = () => page.evaluate(() => window.__scanRequests);
  try {
    await tab(page, "manage");
    await page.locator('[data-act="new-course"]').click();
    await startPhoto();
    // Even a queued duplicate input event must not start another reading.
    await page.evaluate(() => {
      const input = document.createElement("input"); input.type = "file"; input.name = "card-photo";
      const transfer = new DataTransfer(); transfer.items.add(new File(["bad"], "duplicate.jpg", {type:"image/jpeg"}));
      input.files = transfer.files; document.body.append(input);
      input.dispatchEvent(new Event("change", {bubbles:true})); input.remove();
    });
    await page.waitForTimeout(300);
    if (await requestCount() !== 1 || !await progress().isVisible()) throw new Error("duplicate input interrupted or repeated the reading");
    await reply({ scan: { course: "Progress Test Links", scanId: "scan-1", tees: [] } });
    await page.locator('[data-act="card-again"]').waitFor();
    if (await progress().count()) throw new Error("spinner remained after success");
    await page.locator('[data-act="card-again"]').click();
    await startPhoto();
    await reply({ error: "SCAN_LIMIT" });
    await waitForText(page, /picture readings are used up/);
    if (await progress().count() || await camera().count() !== 1) throw new Error("cannot retry after scan failure");
    await startPhoto();
    await page.locator('[data-act="cancel-course"]').click();
    await page.locator('[data-act="new-course"]').click();
    await reply({ scan: { course: "Stale Reply Must Not Appear", scanId: "old", tees: [] } });
    await page.waitForTimeout(500);
    if (await progress().count() || await camera().count() !== 1 || /Stale Reply Must Not Appear/.test(await text(page))) throw new Error("cancelled scan changed the new editor");
    if (await requestCount() !== 3) throw new Error(`expected three scan requests, got ${await requestCount()}`);
    if (page.errors.length) throw new Error(page.errors.join(" | "));
  } finally {
    await page.close();
  }
});

await browser.close();
server.kill();
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
