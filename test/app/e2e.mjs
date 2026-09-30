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
  await waitForText(ivy, /You have been invited to a group/);
  await ivy.fill('[name="email"]', "ivy@example.com");
  await ivy.fill('[name="password"]', "ivy-pass-1");
  await ivy.fill('[name="password-again"]', "ivy-pass-1");
  await ivy.locator('[data-act="create-account"]').click();
  await waitForText(ivy, /Ivy Invitee/);
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
  await ada.locator('[data-close="1"]').first().click();
  if (/Start another group/.test(await switcherText(ada))) throw new Error("an admin is offered Start another group");
});
await check("E13", "an admin removes a regular member of their group, and has no button for the owner", async () => {
  await tab(ada, "admin");
  await waitForText(ada, /Rex Regular/);
  if (await ada.locator(`[data-drop-member="${W.uid}"]`).count()) throw new Error("a remove button for the owner");
  await ada.locator(`[data-drop-member="${R1.uid}"]`).click();
  await waitForText(ada, /no longer have access/);
  if (await getDoc(`associations/G1/members/${R1.uid}`)) throw new Error("Rex is still a member");
  if (ada.errors.length) throw new Error(ada.errors.join(" | "));
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

await browser.close();
server.kill();
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
