/* Automated web tests for the ios branch (spec D2, Phase 2 and 3).
 *
 * Runs by itself in GitHub Actions on every push to ios, in two automated
 * browsers: WebKit (the engine inside Safari) and Chromium. The app is served
 * at http://localhost:8000 on GitHub's own test machine; nothing is published.
 *
 * It talks to the real Firebase project only as throwaway test sessions
 * (anonymous ones made by v2.21.9, and webtest-… email accounts made by the
 * Version 2.0 account screens), which are deleted again at the end of each test. Tests that need the test
 * owner account run only when TEST_OWNER_EMAIL and TEST_OWNER_PASSWORD are set.
 *
 * Usage: node test/web/run.mjs <new-site-dir> <old-site-dir>
 *   new-site-dir: the ios branch's files; old-site-dir: v2.21.9-live.
 */
import { chromium, webkit } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [NEW_DIR, OLD_DIR] = process.argv.slice(2).map((d) => path.resolve(d));
const PORT = 8000;
const BASE = `http://localhost:${PORT}`;
const API_KEY = (fs.readFileSync(path.join(NEW_DIR, "firebase-config.js"), "utf8").match(/apiKey:\s*"([^"]+)"/) || [])[1];
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL || "";
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD || "";
const JOIN_BASE = "https://www.cuberoot-systems.com/scorecard/join/";

let passed = 0, failed = 0, skipped = 0;
const pass = (id, what) => { passed++; console.log(`PASS  ${id}  ${what}`); };
const fail = (id, what, why) => { failed++; console.log(`FAIL  ${id}  ${what}${why ? `  —  ${why}` : ""}`); };
const skip = (id, what, why) => { skipped++; console.log(`SKIP  ${id}  ${what}  —  ${why}`); };
async function check(id, what, fn) {
  try { const r = await fn(); if (r === false) fail(id, what); else pass(id, what); }
  catch (e) { fail(id, what, String(e && e.message || e).split("\n")[0]); }
}

/* The site folder is a link we can repoint, so the same address can serve
   v2.21.9 and then the ios branch — exactly what happens at the merge. */
const SITE = path.resolve("web-test-site");
function serve(dir) {
  try { fs.unlinkSync(SITE); } catch {}
  fs.symlinkSync(dir, SITE, "dir");
}
serve(NEW_DIR);
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", SITE], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

/* The signed-in Firebase user, read from where Firebase keeps it.
   Careful: this must never create Firebase's database (an empty one would
   break Firebase) and must always close its connection (an open one would
   block Firebase's own upgrade and hang the page). */
async function authUser(page) {
  return page.evaluate(() => Promise.race([
    new Promise((resolve) => {
      const open = indexedDB.open("firebaseLocalStorageDb");
      open.onupgradeneeded = () => { try { open.transaction.abort(); } catch {} };   // not created yet: leave it alone
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        const done = (value) => { try { db.close(); } catch {} resolve(value); };
        if (!db.objectStoreNames.contains("firebaseLocalStorage")) return done(null);
        const all = db.transaction("firebaseLocalStorage").objectStore("firebaseLocalStorage").getAll();
        all.onsuccess = () => {
          const row = (all.result || []).find((r) => String(r.fbase_key || "").startsWith("firebase:authUser:"));
          done(row ? row.value : null);
        };
        all.onerror = () => done(null);
      };
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]));
}
async function waitForUser(page, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const u = await authUser(page); if (u && u.uid) return u; await page.waitForTimeout(500); }
  throw new Error("no Firebase sign-in within 30 s");
}
/* Nobody signed in: wait a moment to be sure no sign-in happens by itself. */
async function expectNoUser(page, ms = 6000) {
  await page.waitForTimeout(ms);
  const u = await authUser(page);
  if (u && u.uid) throw new Error(`a sign-in happened by itself (${u.isAnonymous ? "anonymous" : u.email})`);
}
const TEST_EMAIL = () => `webtest-${Date.now()}-${Math.floor(Math.random() * 1e6)}@accounts.cuberoot-systems.com`;
/* Remove a test account again (an account may delete itself): anonymous
   sessions, and the webtest-… email accounts this file creates. Never any
   other account. */
async function deleteTestAccount(user) {
  if (!user || !user.stsTokenManager) return;
  if (!user.isAnonymous && !/^webtest-.*@accounts\.cuberoot-systems\.com$/.test(String(user.email || ""))) return;
  try {
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json", Referer: `${BASE}/` },
      body: JSON.stringify({ idToken: user.stsTokenManager.accessToken }),
    });
  } catch { /* best effort */ }
}
const bodyText = (page) => page.evaluate(() => document.body.innerText);
async function waitForText(page, re, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(await bodyText(page))) return true; await page.waitForTimeout(400); }
  throw new Error(`text ${re} did not appear`);
}

/* A stand-in for the iPhone app's native bridge, for app-only behaviour. */
const APP_STUB = (launchUrl) => `
  window.__linkListeners = [];
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        getLaunchUrl: async () => (${JSON.stringify(launchUrl || "")} ? { url: ${JSON.stringify(launchUrl || "")} } : undefined),
        addListener: (name, fn) => { if (name === "appUrlOpen") window.__linkListeners.push(fn); return { remove() {} }; },
      },
    },
  };`;

/* ---------------- the test owner rehearsal (R1o, R2, R3, R4) ---------------- */

const OWNER_TESTS = [
  ["R1o", "rehearsal — the test owner stays signed in across the switch"],
  ["R2", "rehearsal — a round queued offline on v2.21.9 uploads once after the switch"],
  ["R3", "rehearsal — the remembered group opens straight away after the switch"],
  ["R4", "rehearsal — after the switch: no Google button, Delete my account present"],
];
const PROJECT_ID = (fs.readFileSync(path.join(NEW_DIR, "firebase-config.js"), "utf8").match(/projectId:\s*"([^"]+)"/) || [])[1];

async function waitForOwner(page, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const u = await authUser(page);
    if (u && !u.isAnonymous && String(u.email || "").toLowerCase() === OWNER_EMAIL.toLowerCase()) return u;
    await page.waitForTimeout(500);
  }
  throw new Error("the test owner was not signed in within 45 s");
}

/* Rounds in a group carrying the given note, read from the server as the owner. */
async function roundsWithNote(token, assoc, note) {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/associations/${encodeURIComponent(assoc)}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "rounds" }],
      where: { fieldFilter: { field: { fieldPath: "notes" }, op: "EQUAL", value: { stringValue: note } } },
    } }),
  });
  if (!res.ok) throw new Error(`the round query was refused (HTTP ${res.status})`);
  return (await res.json()).filter((row) => row.document).map((row) => row.document.name.split("/").pop());
}

async function ownerRehearsal(browser, name, tag) {
  const label = Object.fromEntries(OWNER_TESTS);
  const MARK = `R2 automated rehearsal ${tag} ${Date.now()} - removed by the test`;
  let setupError = "";
  let anon = null, ownerBefore = null, assocBefore = "", queued = null;

  serve(OLD_DIR);
  const context = await browser.newContext();
  let page = await context.newPage();
  try {
    /* 1. v2.21.9: sign the test owner in from the first screen. */
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    anon = await waitForUser(page);
    await page.waitForSelector('[name="email"]');
    await page.fill('[name="email"]', OWNER_EMAIL);
    await page.fill('[name="password"]', OWNER_PASSWORD);
    await page.click('[data-act="sign-in"]');
    ownerBefore = await waitForOwner(page);
    await page.waitForSelector('button[data-tab="enter"]');
    assocBefore = await page.evaluate(() => localStorage.getItem("golf:v2:assoc") || "");
    if (!assocBefore) throw new Error("v2.21.9 did not remember the group");

    /* 2. v2.21.9: pick the owner's golfer and a course while online. */
    await page.evaluate(async (ownerUid) => {
      const db = await import("/store.js");
      const once = (watch) => new Promise((resolve, reject) => {
        let stop = null, done = false;
        const timer = setTimeout(() => reject(new Error("the group's data did not load within 20 s")), 20000);
        stop = watch((value) => {
          if (done) return;
          done = true; clearTimeout(timer); resolve(value);
          setTimeout(() => { try { stop && stop(); } catch {} }, 0);
        });
      });
      const golfers = await once((cb) => db.watchGolfers(cb));
      const roster = await once((cb) => db.watchRoster(cb));
      const courses = await once((cb) => db.watchCourses(cb));
      const onRoster = golfers.filter((g) => roster.includes(g.id));
      const golfer = onRoster.find((g) => g.linkedUid === ownerUid) || onRoster[0];
      const course = courses.find((c) => c && Array.isArray(c.tees) && c.tees.some((t) => t && t.rating && t.slope));
      if (!golfer) throw new Error("the Test group has no golfer on its roster");
      if (!course) throw new Error("the Test group has no course with a rated tee");
      window.__r2 = { golfer, course, tee: course.tees.find((t) => t && t.rating && t.slope) };
    }, ownerBefore.uid);

    /* 3. v2.21.9, offline: post the round. It must wait in the queue. */
    await context.setOffline(true);
    queued = await page.evaluate(async (note) => {
      const db = await import("/store.js");
      const { golfer, course, tee } = window.__r2;
      const { round } = db.postRound({ golfer, course, tee, date: new Date().toISOString().slice(0, 10), gross: "99", adjusted: "", notes: note });
      await new Promise((r) => setTimeout(r, 2000));
      const queue = JSON.parse(localStorage.getItem("golf:v2:outbox") || "[]");
      return { id: round.id, golferId: golfer.id, waiting: queue.some((op) => JSON.stringify(op).includes(round.id)) };
    }, MARK);
    if (!queued.waiting) throw new Error("the offline round was not waiting in v2.21.9's queue");

    /* 4. Close v2.21.9 while still offline, swap in the ios branch, reopen online. */
    await page.close();
    serve(NEW_DIR);
    await context.setOffline(false);
    page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    try { await waitForText(page, /Delete my account/, 45000); }
    catch { throw new Error("the page still ran v2.21.9 after the switch"); }
  } catch (e) {
    setupError = String((e && e.message) || e).split("\n")[0];
  }
  /* The anonymous session the first screen made is not the owner: remove it
     (never when it became the owner's account). */
  if (anon && anon.isAnonymous && ownerBefore && anon.uid !== ownerBefore.uid) await deleteTestAccount(anon);

  const owner = !setupError;
  await check(`R1o-${tag}`, `${name}: ${label.R1o}`, async () => {
    if (!owner) throw new Error(setupError);
    const after = await waitForOwner(page);
    if (after.uid !== ownerBefore.uid) throw new Error(`before ${ownerBefore.uid}, after ${after.uid}`);
  });
  await check(`R3-${tag}`, `${name}: ${label.R3}`, async () => {
    if (!owner) throw new Error(setupError);
    await page.waitForSelector('button[data-tab="enter"]', { timeout: 30000 });
    const assoc = await page.evaluate(() => localStorage.getItem("golf:v2:assoc") || "");
    if (assoc !== assocBefore) throw new Error(`remembered group was ${assocBefore}, now ${assoc || "none"}`);
    if (/Create the group/.test(await bodyText(page))) throw new Error("the first screen was shown instead of the group");
  });
  await check(`R2-${tag}`, `${name}: ${label.R2}`, async () => {
    if (!owner) throw new Error(setupError);
    const end = Date.now() + 60000;
    for (;;) {
      const still = await page.evaluate((id) => (localStorage.getItem("golf:v2:outbox") || "").includes(id), queued.id);
      if (!still) break;
      if (Date.now() > end) throw new Error("the queued round was still waiting 60 s after going online");
      await page.waitForTimeout(1000);
    }
    const token = (await authUser(page)).stsTokenManager.accessToken;
    const ids = await roundsWithNote(token, assocBefore, MARK);
    if (ids.length !== 1 || ids[0] !== queued.id) throw new Error(`expected the one round ${queued.id}, found ${ids.length}: ${ids.join(", ")}`);
  });
  await check(`R4-${tag}`, `${name}: ${label.R4}`, async () => {
    if (!owner) throw new Error(setupError);
    const googleHere = async () => (await page.locator('[data-act="google"]').count()) > 0 || /Sign in with Google/.test(await bodyText(page));
    if (!/Delete my account/.test(await bodyText(page))) throw new Error("no Delete my account link");
    if (await googleHere()) throw new Error("a Google button is on the first screen");
    const adminTab = page.locator('button[data-tab="admin"]');
    if (await adminTab.count()) { await adminTab.first().click(); await page.waitForTimeout(1500); }
    if (await googleHere()) throw new Error("a Google button is on the Admin tab");
  });

  /* Leave the Test group as it was: delete the test round and rebuild the
     golfer's handicap, through the app's own code. */
  if (queued && queued.id) {
    await check(`R2c-${tag}`, `${name}: clean-up — the test round removed and the handicap rebuilt`, async () => {
      if (page.isClosed()) { serve(NEW_DIR); await context.setOffline(false); page = await context.newPage(); await page.goto(`${BASE}/`, { waitUntil: "load" }); await waitForOwner(page); }
      await page.evaluate(async (round) => { const db = await import("/store.js"); await db.deleteRoundAndRebuild(round); }, { id: queued.id, golferId: queued.golferId });
      const token = (await authUser(page)).stsTokenManager.accessToken;
      const left = await roundsWithNote(token, assocBefore, MARK);
      if (left.length) throw new Error(`still there: ${left.join(", ")} — delete it in the Test group's History`);
    });
  }
  serve(NEW_DIR);
  await context.close();
}

const browsers = [["webkit", webkit], ["chromium", chromium]];
setTimeout(() => { console.log("FAIL  WATCHDOG  the web tests took longer than 15 minutes"); server.kill(); process.exit(1); }, 15 * 60 * 1000).unref();
for (const [name, type] of browsers) {
  console.log(`--- ${name} ---`);
  const browser = await type.launch();
  const _newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => { const c = await _newContext(...a); c.setDefaultTimeout(45000); c.setDefaultNavigationTimeout(45000); return c; };
  const tag = name === "webkit" ? "WK" : "CH";

  /* ---- the web app as web users will get it after the merge ---- */
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    let user = null;
    await check(`W1-${tag}`, `${name}: the app starts signed out and shows Sign in (Version 2.0: no anonymous sign-in)`, async () => {
      await waitForText(page, /Sign in/);
      await expectNoUser(page);
      const t = await bodyText(page);
      if (!/I was given a code/.test(t)) throw new Error("no code link");
      if (/Create the group|Start your group/.test(t)) throw new Error("offered a group while signed out");
    });
    await check(`W2-${tag}`, `${name}: no uncaught errors while starting`, async () => {
      if (errors.length) throw new Error(errors.join(" | "));
    });
    await check(`C6-${tag}`, `${name}: no Google sign-in anywhere on the first screen`, async () => !/google/i.test(await bodyText(page)));
    await check(`W3-${tag}`, `${name}: signed out, there is no "Delete my account" (nothing to delete)`, async () => !/Delete my account/.test(await bodyText(page)));
    await check(`B1-${tag}`, `${name}: signed out, "I was given a code" asks for an account first`, async () => {
      await page.locator('[data-act="enter-code"]').first().click();
      await waitForText(page, /Join with a code/);
      const t = await bodyText(page);
      if (!/Create my account/.test(t) || !/I already have an account/.test(t)) throw new Error("no create-account card");
      await page.locator('[data-act="hide-code"]').first().click();
      await waitForText(page, /Sign in/);
    });
    await check(`C5-${tag}`, `${name}: signed out, Apply to join the public group asks for full name and email only`, async () => {
      await page.locator('[data-act="show-apply"]').first().click();
      await waitForText(page, /Apply to join the public group/);
      if (await page.locator('[name="password"]').count()) throw new Error("the application asks for a password");
      if (!(await page.locator('[name="apply-name"]').count()) || !(await page.locator('[name="apply-email"]').count())) throw new Error("no name or email field");
      if (!/see your full name and your handicap index, and nothing else/.test(await bodyText(page))) throw new Error("no privacy note");
      await page.locator('[data-act="submit-application"]').click();
      await waitForText(page, /Type your full name/);
      await expectNoUser(page, 1000);
      await page.locator('[data-act="hide-apply"]').first().click();
      await waitForText(page, /Sign in/);
    });
    await check(`W6-${tag}`, `${name}: User guide, Support and Privacy links at the foot of the screen`, async () => {
      const t = await bodyText(page);
      if (!/User guide/.test(t) || !/Support/.test(t) || !/Privacy/.test(t)) throw new Error("a link is missing");
      const urls = await page.evaluate(async () => { const m = await import("/platform.js"); return [m.guideUrl(), m.supportUrl(), m.privacyUrl()]; });
      if (urls.join(" ") !== "https://www.cuberoot-systems.com/scorecard/guide/ https://www.cuberoot-systems.com/scorecard/support/ https://www.cuberoot-systems.com/scorecard/privacy/") throw new Error(urls.join(" "));
    });
    await check(`C1-${tag}`, `${name}: invitation links use the Cuberoot address (Change 1)`, async () => {
      const link = await page.evaluate(async () => (await import("/store.js")).joinLink({ id: "G1", joinCode: "ABC123" }));
      if (link !== "https://www.cuberoot-systems.com/scorecard/join/?join=G1.ABC123") throw new Error(link);
    });
    await check(`C1b-${tag}`, `${name}: the guide link is the Cuberoot guide`, async () => {
      const guide = await page.evaluate(async () => (await import("/platform.js")).guideUrl());
      if (guide !== "https://www.cuberoot-systems.com/scorecard/guide/") throw new Error(guide);
    });
    await check(`W4-${tag}`, `${name}: a ?join= link in the address bar is read as before`, async () => {
      await page.goto(`${BASE}/?join=G1.ABC123.golferX&as=admin`, { waitUntil: "load" });
      const link = await page.evaluate(async () => (await import("/store.js")).readJoinLink());
      if (!link || link.associationId !== "G1" || link.code !== "ABC123" || link.golferId !== "golferX" || link.role !== "admin")
        throw new Error(JSON.stringify(link));
    });
    if (name === "chromium") {
      await check(`C13w-${tag}`, `${name}: the browser still registers its offline service worker`, async () => {
        await page.waitForTimeout(1500);
        const has = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
        if (!has) throw new Error("no service worker in the browser");
      });
    }
    await deleteTestAccount(user);
    await context.close();
  }

  /* ---- offline first screen (Change 3, Part C) ---- */
  {
    const context = await browser.newContext();
    await context.addInitScript(() => { Object.defineProperty(navigator, "onLine", { get: () => false }); });
    await context.route(/googleapis\.com|firebaseio\.com/, (r) => r.abort());
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await check(`O3w-${tag}`, `${name}: offline, the first screen says so and never offers to create a group`, async () => {
      await waitForText(page, /You're offline|Sync unavailable|Cannot reach Firebase/, 30000);
      const text = await bodyText(page);
      if (/Create the group/.test(text)) throw new Error("offered to create a group while offline");
    });
    await context.close();
  }

  /* ---- the iPhone app's own behaviour, with a stand-in native bridge ---- */
  {
    const launch = `${JOIN_BASE}?join=GAPP.CODE1.golferA`;
    const context = await browser.newContext();
    await context.addInitScript(APP_STUB(launch));
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    let user = null;
    await check(`C2-${tag}`, `${name} (app): the link that opened the app is read (cold start)`, async () => {
      await waitForText(page, /You have been invited/);
      const link = await page.evaluate(async () => (await import("/store.js")).readJoinLink());
      if (!link || link.associationId !== "GAPP" || link.golferId !== "golferA") throw new Error(JSON.stringify(link));
    });
    await check(`C4b-${tag}`, `${name} (app): the same link delivered again is ignored; a new one is taken once`, async () => {
      const r = await page.evaluate(async ({ launch, other }) => {
        const p = await import("/platform.js");
        return [p.takeLink(launch), p.takeLink(other), p.takeLink(other), p.linkQuery()];
      }, { launch, other: `${JOIN_BASE}?join=GAPP2.CODE2` });
      if (r[0] !== false || r[1] !== true || r[2] !== false || r[3] !== "?join=GAPP2.CODE2") throw new Error(JSON.stringify(r));
    });
    await check(`C4-${tag}`, `${name} (app): a link tapped while the app is open is handled`, async () => {
      await page.evaluate((url) => window.__linkListeners.forEach((fn) => fn({ url })), `${JOIN_BASE}?join=GWARM.CODE3`);
      await page.waitForTimeout(800);
      const link = await page.evaluate(async () => (await import("/store.js")).readJoinLink());
      if (!link || link.associationId !== "GWARM") throw new Error(JSON.stringify(link));
    });
    if (name === "chromium") {
      await check(`C13-${tag}`, `${name} (app): no service worker inside the app (Change 9)`, async () => {
        await page.waitForTimeout(1500);
        const has = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
        if (has) throw new Error("a service worker was registered inside the app");
      });
    }
    await deleteTestAccount(user);
    await context.close();
  }
  {
    const context = await browser.newContext();
    await context.addInitScript(APP_STUB(""));
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    let user = null;
    await check(`W5-${tag}`, `${name} (app): first screen uses the app wording and links to the moving guide`, async () => {
      await waitForText(page, /same account on every device/);
      if (!/Used The Scorecard in Safari\? Read this first/.test(await bodyText(page))) throw new Error("no moving-guide link");
    });
    await deleteTestAccount(user);
    await context.close();
  }

  /* ---- Version 2.0 Phase B: an invitation while signed out ---- */
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/?join=GNONE.CODE9`, { waitUntil: "load" });
    let user = null;
    await check(`B2-${tag}`, `${name}: an invitation while signed out asks to create an account first`, async () => {
      await waitForText(page, /You have been invited to a group/);
      const t = await bodyText(page);
      if (!/Create my account/.test(t)) throw new Error("no Create my account button");
      if (/Type the name you play under/.test(t)) throw new Error("the invitation was shown before an account");
    });
    await check(`B3-${tag}`, `${name}: two different passwords are refused before anything is created`, async () => {
      await page.fill('[name="email"]', TEST_EMAIL());
      await page.fill('[name="password"]', "abcdef1");
      await page.fill('[name="password-again"]', "abcdef2");
      await page.locator('[data-act="create-account"]').click();
      await waitForText(page, /two passwords are different/);
      await expectNoUser(page, 1500);
    });
    await check(`B4-${tag}`, `${name}: Create my account makes an email account (not anonymous) and then shows the invitation`, async () => {
      const email = TEST_EMAIL();
      await page.fill('[name="email"]', email);
      await page.fill('[name="password"]', "webtest-pass-1");
      await page.fill('[name="password-again"]', "webtest-pass-1");
      await page.locator('[data-act="create-account"]').click();
      user = await waitForUser(page);
      if (user.isAnonymous || String(user.email).toLowerCase() !== email.toLowerCase()) throw new Error(`signed in as ${user.isAnonymous ? "anonymous" : user.email}`);
      await waitForText(page, /Type the name you play under|Join the group/);
      if (!/Delete my account/.test(await bodyText(page))) throw new Error("no Delete my account once signed in");
    });
    await deleteTestAccount(user || await authUser(page));
    await context.close();
  }

  /* ---- merge rehearsal R1: an anonymous session survives the switch
         from v2.21.9 to the ios branch at the same address (D3) ---- */
  {
    serve(OLD_DIR);
    const context = await browser.newContext();
    const page = await context.newPage();
    let before = null, after = null;
    await check(`R1-${tag}`, `${name}: rehearsal — the same anonymous account before and after the switch, now asked for an email and password`, async () => {
      await page.goto(`${BASE}/`, { waitUntil: "load" });
      before = await waitForUser(page);
      serve(NEW_DIR);
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(3000);
      after = await waitForUser(page);
      /* The new code is running once its footer link is there. */
      try { await waitForText(page, /Delete my account/, 30000); }
      catch { throw new Error("the page still ran v2.21.9 after the switch"); }
      if (!before || !after || before.uid !== after.uid) throw new Error(`before ${before && before.uid}, after ${after && after.uid}`);
      /* Version 2.0 Phase B: the old guest session gets the keep-your-place screen. */
      try { await waitForText(page, /Set your email and password/, 20000); }
      catch { throw new Error("the old guest session was not asked for an email and password"); }
      if (!/Keep my place/.test(await bodyText(page))) throw new Error("no Keep my place button");
    });
    serve(NEW_DIR);
    await deleteTestAccount(after || before);
    await context.close();
  }

  /* ---- merge rehearsal with the test owner: R1o, R2, R3, R4 (D2, D3) ----
     The test owner signs in on v2.21.9 and a round is queued offline; the
     page is closed, the ios branch's files are swapped in at the same address,
     and it is opened again online. The test round is deleted at the end and
     the golfer's handicap rebuilt, so the Test group is left as it was. */
  if (!OWNER_EMAIL || !OWNER_PASSWORD) {
    for (const [id, what] of OWNER_TESTS) skip(`${id}-${tag}`, `${name}: ${what}`, "TEST_OWNER_EMAIL / TEST_OWNER_PASSWORD not set yet");
  } else {
    await ownerRehearsal(browser, name, tag);
  }

  await browser.close();
}

server.kill();
try { fs.unlinkSync(SITE); } catch {}
console.log(`\nRESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
