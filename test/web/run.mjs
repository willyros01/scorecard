/* Automated web tests for the ios branch (spec D2, Phase 2 and 3).
 *
 * Runs by itself in GitHub Actions on every push to ios, in two automated
 * browsers: WebKit (the engine inside Safari) and Chromium. The app is served
 * at http://localhost:8000 on GitHub's own test machine; nothing is published.
 *
 * It talks to the real Firebase project only as anonymous test sessions,
 * which are deleted again at the end of each test. Tests that need the test
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

/* The signed-in Firebase user, read from where Firebase keeps it. */
async function authUser(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open("firebaseLocalStorageDb");
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("firebaseLocalStorage")) return resolve(null);
      const all = db.transaction("firebaseLocalStorage").objectStore("firebaseLocalStorage").getAll();
      all.onsuccess = () => {
        const row = (all.result || []).find((r) => String(r.fbase_key || "").startsWith("firebase:authUser:"));
        resolve(row ? row.value : null);
      };
      all.onerror = () => resolve(null);
    };
  }));
}
async function waitForUser(page, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const u = await authUser(page); if (u && u.uid) return u; await page.waitForTimeout(500); }
  throw new Error("no Firebase sign-in within 30 s");
}
/* Remove the anonymous test account again (an account may delete itself). */
async function deleteTestAccount(user) {
  if (!user || !user.isAnonymous || !user.stsTokenManager) return;
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

const browsers = [["webkit", webkit], ["chromium", chromium]];
for (const [name, type] of browsers) {
  const browser = await type.launch();
  const tag = name === "webkit" ? "WK" : "CH";

  /* ---- the web app as web users will get it after the merge ---- */
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    let user = null;
    await check(`W1-${tag}`, `${name}: the app starts and signs in anonymously`, async () => {
      user = await waitForUser(page);
      await waitForText(page, /Sign in|Create the group|Start your group/);
    });
    await check(`W2-${tag}`, `${name}: no uncaught errors while starting`, async () => {
      if (errors.length) throw new Error(errors.join(" | "));
    });
    await check(`C6-${tag}`, `${name}: no Google sign-in anywhere on the first screen`, async () => !/google/i.test(await bodyText(page)));
    await check(`W3-${tag}`, `${name}: "Delete my account" is at the foot of the screen`, async () => /Delete my account/.test(await bodyText(page)));
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
      user = await waitForUser(page);
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
    await check(`C9-${tag}`, `${name} (app): first screen uses the app wording and links to the moving guide`, async () => {
      user = await waitForUser(page);
      await waitForText(page, /same person on every device/);
      if (!/Used The Scorecard in Safari\? Read this first/.test(await bodyText(page))) throw new Error("no moving-guide link");
    });
    await deleteTestAccount(user);
    await context.close();
  }

  /* ---- merge rehearsal R1: an anonymous session survives the switch
         from v2.21.9 to the ios branch at the same address (D3) ---- */
  {
    serve(OLD_DIR);
    const context = await browser.newContext();
    const page = await context.newPage();
    let before = null, after = null;
    await check(`R1-${tag}`, `${name}: rehearsal — the same anonymous account before and after the switch`, async () => {
      await page.goto(`${BASE}/`, { waitUntil: "load" });
      before = await waitForUser(page);
      serve(NEW_DIR);
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(3000);
      after = await waitForUser(page);
      const version = await page.evaluate(() => self.APP_VERSION);
      if (version === "2.21.9") throw new Error("the page still ran v2.21.9 after the switch");
      if (!before || !after || before.uid !== after.uid) throw new Error(`before ${before && before.uid}, after ${after && after.uid}`);
    });
    serve(NEW_DIR);
    await deleteTestAccount(after || before);
    await context.close();
  }

  /* ---- tests that need the test owner account ---- */
  for (const [id, what] of [
    ["R1o", "rehearsal — the test owner stays signed in across the switch"],
    ["R2", "rehearsal — a round queued offline uploads once after the switch"],
    ["R3", "rehearsal — the remembered group opens straight away"],
    ["R4", "rehearsal — after the switch: no Google button, Delete my account present"],
  ]) {
    if (!OWNER_EMAIL || !OWNER_PASSWORD) skip(`${id}-${tag}`, `${name}: ${what}`, "TEST_OWNER_EMAIL / TEST_OWNER_PASSWORD not set yet");
    else skip(`${id}-${tag}`, `${name}: ${what}`, "written once the test owner and Test group exist");
  }

  await browser.close();
}

server.kill();
try { fs.unlinkSync(SITE); } catch {}
console.log(`\nRESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
