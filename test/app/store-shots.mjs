/* App Store pictures for The Scorecard 2.31.0 (step 26, Willy 31 Oct 2026):
 * made-up golfers only — never real group members, handicaps or emails.
 *
 * The real app, served here against the Firebase emulators (a demo project
 * that cannot reach live data), with a made-up group, courses, rounds, a game
 * and Marker rounds. Pictures at Apple's sizes:
 *   iPhone 6.9" 1320 x 2868 (440 x 956 at 3x) and iPad 13" 2064 x 2752 (1032 x 1376 at 2x).
 *
 * Usage (inside firebase emulators:exec): node test/app/store-shots.mjs <site-dir> <out-dir>
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const SITE = path.resolve(process.argv[2] || ".");
const OUT = path.resolve(process.argv[3] || "store-shots");
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8010;
const APP = `http://localhost:${PORT}/?emulators=1`;
const P = "demo-scorecard";
const FS = `http://127.0.0.1:8080/v1/projects/${P}/databases/(default)/documents`;
const FS_ADMIN = `http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const AUTH_ADMIN = `http://127.0.0.1:9099/emulator/v1/projects/${P}`;
const OWNER = { Authorization: "Bearer owner" };

const value = (v) => v === null ? { nullValue: null }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
  : typeof v === "object" ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
  : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === "boolean" ? { booleanValue: v }
  : { stringValue: String(v) };
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));
async function put(docPath, data) {
  const r = await fetch(`${FS}:commit`, { method: "POST", headers: { ...OWNER, "Content-Type": "application/json" },
    body: JSON.stringify({ writes: [{ update: { name: `projects/${P}/databases/(default)/documents/${docPath}`, fields: fields(data) } }] }) });
  if (!r.ok) throw new Error(`seed ${docPath}: ${r.status} ${await r.text()}`);
}
async function signUp(email, password) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake-api-key`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json();
  if (!j.localId) throw new Error(`sign-up ${email}: ${JSON.stringify(j)}`);
  return j.localId;
}

/* ---- the made-up world ---- */
await fetch(FS_ADMIN, { method: "DELETE", headers: OWNER });
await fetch(`${AUTH_ADMIN}/accounts`, { method: "DELETE", headers: OWNER });

const G = "CLUB1";
const ME = { email: "alex.morgan@example.com", password: "alex-pass-1", name: "Alex Morgan", id: "gAlex" };
ME.uid = await signUp(ME.email, ME.password);
/* Alex is a regular member (what most golfers see); the club has its own organiser. */
const BOSS = await signUp("organiser@example.com", "organiser-pass-1");
await put(`associations/${G}`, { name: "Saturday Club", ownerUid: BOSS, joinCode: "CLUB01", settings: { minRoundsForRanking: 3 } });
await put(`associations/${G}/members/${BOSS}`, { uid: BOSS, role: "owner", displayName: "Club Organiser" });
await put(`associations/${G}/members/${ME.uid}`, { uid: ME.uid, role: "member", displayName: ME.name, golferId: ME.id });
await put(`userGroups/${ME.uid}/groups/${G}`, { assocId: G, name: "Saturday Club" });

const tee = (id, name, rating, slope, par = 72) => ({ id, name, rating, slope, par });
const COURSES = [
  { id: "cMaple", name: "Maple Ridge Golf Club", where: "Ontario", tees: [tee("w", "White", 70.4, 126), tee("b", "Blue", 72.1, 131)] },
  { id: "cHarbour", name: "Harbour Point Links", where: "Ontario", tees: [tee("w", "White", 69.8, 122)] },
  { id: "cCedar", name: "Cedar Valley Golf Course", where: "Ontario", tees: [tee("w", "White", 71.2, 128)] },
];
for (const c of COURSES) await put(`courses/${c.id}`, { ...c, createdBy: ME.uid });

const PEOPLE = [
  ["gAlex", "Alex Morgan", 12.4], ["gJordan", "Jordan Lee", 8.1], ["gPriya", "Priya Shah", 15.7], ["gSam", "Sam Carter", 18.2],
  ["gMaria", "Maria Santos", 21.0], ["gDev", "Dev Patel", 6.5], ["gTess", "Tess O'Neill", 10.9], ["gKen", "Ken Ito", 24.3],
];
const PAR = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 5, 4, 4, 4, 3, 4, 5];
const SI = [7, 3, 15, 1, 11, 5, 17, 9, 13, 8, 16, 2, 10, 4, 12, 18, 6, 14];
let seed = 7;
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
/* A season of Saturdays, May to October (the 6-month trend needs the spring). */
const dates = [];
for (let t = Date.UTC(2026, 4, 2); t <= Date.UTC(2026, 9, 31); t += 7 * 86400000) dates.push(new Date(t).toISOString().slice(0, 10));
const round1 = (x) => Math.round(x * 10) / 10;

const gameId = "gmFinal";
await put(`associations/${G}/games/${gameId}`, { id: gameId, assocId: G, date: "2026-10-31", endDate: null, courseId: "cMaple", name: "Club Championship", createdBy: BOSS,
  participantGolferIds: PEOPLE.map((x) => x[0]) });

for (const [id, name, base] of PEOPLE) {
  const window = [];
  let n = 0;
  for (const [k, date] of dates.entries()) {
    if (id !== "gAlex" && rnd() < 0.3) continue;
    const c = COURSES[k % COURSES.length];
    const t = c.tees[0];
    /* Alex's handicap comes down over the season (the trend picture). */
    const trend = id === "gAlex" ? (dates.length - k) * 0.22 : 0;
    const diff = round1(base + trend + (rnd() - 0.5) * 6);
    const adjusted = Math.round(diff * t.slope / 113 + t.rating);
    const rid = `r-${id}-${k}`;
    const lastAtMaple = id === "gAlex" ? k >= dates.length - 4 : date === "2026-10-31";
    const r = { id: rid, golferId: id, assocId: G, date, courseId: c.id, teeId: t.id, courseName: c.name, teeName: t.name, gross: adjusted + (rnd() < 0.3 ? 1 : 0), adjusted,
      differential: diff, rating: t.rating, slope: t.slope, par: t.par, enteredBy: ME.uid, enteredAt: Date.parse(date) };
    if (date === "2026-10-31") r.gameId = gameId;
    if (lastAtMaple && c.id) {
      /* A Marker round: hole by hole, with the pars as played. */
      let left = r.gross - 72;
      const holes = PAR.map((p, i) => {
        const extra = left > 0 ? (rnd() < 0.55 ? 1 : 0) + (rnd() < 0.12 ? 1 : 0) : (rnd() < 0.15 ? -1 : 0);
        const v = Math.max(2, p + extra); left -= (v - p); return v;
      });
      const fix = r.gross - holes.reduce((a, b) => a + b, 0);
      holes[17] = Math.max(2, holes[17] + fix);
      Object.assign(r, { enteredVia: "marker", cardId: `card-${k}`, holes, holePar: PAR, holeSi: SI, courseHandicap: Math.round(base * t.slope / 113 + t.rating - t.par) });
    }
    await put(`associations/${G}/rounds/${rid}`, r);
    window.push({ roundId: rid, date, differential: diff, assocId: G });
    n++;
  }
  window.sort((a, b) => b.date.localeCompare(a.date));
  const last = window.slice(0, 20);
  const best = last.map((w) => w.differential).sort((a, b) => a - b).slice(0, 8);
  const index = best.length >= 3 ? round1(best.reduce((a, b) => a + b, 0) / best.length) : null;
  await put(`golfers/${id}`, { name, nameKey: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), linkedUid: id === "gAlex" ? ME.uid : null, groups: [G], roundCount: n, recentWindow: last, handicapIndex: index });
  await put(`golferNames/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, { golferId: id, name });
  await put(`associations/${G}/roster/${id}`, { golferId: id });
  await put(`associations/${G}/directory/${id}`, { golferId: id, displayName: name, handicapIndex: index, updatedAt: Date.now() });
}

/* ---- the app ---- */
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", SITE], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const browser = await chromium.launch();
const text = (p) => p.evaluate(() => document.body.innerText);
async function waitForText(p, re, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(await text(p))) return; await p.waitForTimeout(300); }
  throw new Error(`text ${re} did not appear: ${(await text(p)).replace(/\s+/g, " ").slice(0, 300)}`);
}
const tab = async (p, id) => { await p.locator(`button[data-tab="${id}"]`).click(); await p.waitForTimeout(900); };

const DEVICES = [
  { key: "iphone", viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { key: "ipad", viewport: { width: 1032, height: 1376 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
let made = 0;
for (const d of DEVICES) {
  for (const night of [false, true]) {
    const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch, colorScheme: night ? "dark" : "light" });
    await ctx.addInitScript((night) => { try { localStorage.setItem("golf:terms", JSON.stringify({ version: 1, at: 1 })); localStorage.setItem("golf:theme", night ? "dark" : "light"); } catch {} }, night);
    const p = await ctx.newPage();
    await p.goto(APP, { waitUntil: "load" });
    await waitForText(p, /Sign in/);
    await p.fill('[name="email"]', ME.email);
    await p.fill('[name="password"]', ME.password);
    await p.locator('[data-act="sign-in"]').first().click();
    await waitForText(p, /Saturday Club/i);
    await p.waitForTimeout(2500);
    /* The signed-in email line is left out of the pictures. */
    await p.waitForFunction(() => !/Signed in as/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const shot = async (name) => { await p.waitForTimeout(600); await p.screenshot({ path: path.join(OUT, `${d.key}-${night ? "night" : "day"}-${name}.png`) }); made++; console.log(`made ${d.key} ${night ? "night" : "day"} ${name}`); };
    if (!night) {
      await tab(p, "enter"); await shot("1-enter");
      await tab(p, "history"); await shot("2-history");
      const card = p.locator('[data-act="show-card"]').first();
      if (await card.count()) { await card.click(); await p.waitForTimeout(800); await shot("3-card"); await p.keyboard.press("Escape").catch(() => {}); await p.locator('[data-close="1"]').first().click().catch(() => {}); }
      await tab(p, "summary"); await shot("4-summary");
      await tab(p, "games");
      const g = p.locator('[data-game]').first();
      if (await g.count()) { await g.click().catch(() => {}); await p.waitForTimeout(800); }
      await shot("5-games");
    } else {
      await tab(p, "summary"); await shot("6-summary");
    }
    await ctx.close();
  }
}
await browser.close();
server.kill();
console.log(`RESULT: ${made} pictures made in ${OUT}`);
