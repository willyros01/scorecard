/* CL9: groups-check.html, opened in a browser, reads a backup file chosen on
 * the device and shows the clean-up plan (the same plan cl5.mjs carries out).
 *   node test/ops/cl5-page.mjs <backup file>      (from the repository folder) */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FILE = process.argv[2];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
let failed = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  CL9 ${label}`); if (!cond) failed++; };
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = []; const requests = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(`http://127.0.0.1:${port}/groups-check.html`);
  await page.setInputFiles("#file", FILE);
  await page.waitForSelector("text=Orphan groups to remove", { timeout: 15000 });
  const text = await page.innerText("#out");
  check("the plan can go ahead", text.includes("The clean-up can go ahead."));
  check("three orphan groups", /Orphan groups to remove:\s*3/.test(text));
  check("the four groups are listed as kept", ["Public group", "Ronnie Rosales’ Memorial Tournament", "Philippine Golfers", "Golfing Buddies"].every((n) => text.includes(n)));
  check("the golfer who moves is named, with her rounds", /Ana Orphan[\s\S]*3 rounds move with them/.test(text));
  check("two accounts join Philippine Golfers", /Accounts joining Philippine Golfers:\s*2/.test(text));
  check("the staying golfer's round is flagged", /Ben Buddy: 1 round, 1 in the handicap now/.test(text));
  check("no page errors", errors.length === 0);
  check("nothing is sent anywhere", requests.every((u) => u.startsWith(`http://127.0.0.1:${port}/`)));
  if (errors.length) console.log(errors.join("\n"));
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
