/* App Store Connect API helper for the build (Node, no packages).
 *   node build/asc.mjs preflight   — check the Apple key is accepted
 *   node build/asc.mjs notes       — once Apple has processed the build, fill
 *                                    Test Information and "What to Test"
 * Needs ASC_KEY_ID, ASC_ISSUER_ID and KEY (path of the .p8 file); notes also
 * needs VERSION and BUILD. Never prints the key. */
import crypto from "node:crypto";
import fs from "node:fs";

const BUNDLE_ID = "io.github.willyros01.scorecard";
const FEEDBACK_EMAIL = "willyros01@gmail.com";
const DESCRIPTION = "The Scorecard keeps a golf group's scores and each golfer's World Handicap System index. This TestFlight build is the iPhone and iPad version of the web app; it uses the same account and group data.";

function token() {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ alg: "ES256", kid: process.env.ASC_KEY_ID, typ: "JWT" })}.${enc({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: "appstoreconnect-v1" })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: fs.readFileSync(process.env.KEY), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${unsigned}.${sig}`;
}
async function api(method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const why = (json && json.errors || []).map((e) => `${e.code}: ${e.detail || e.title}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`${method} ${path.split("?")[0]} — ${why}`);
  }
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function preflight() {
  await api("GET", "/v1/apps?limit=1");
  console.log("Apple API preflight passed: the key is accepted.");
  const apps = await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  if (!apps.data.length) {
    console.log(`::error title=No app record::App Store Connect has no app with bundle ID ${BUNDLE_ID}. Create the app record first (open item 2).`);
    process.exit(3);
  }
  console.log(`App record found: ${apps.data[0].attributes.name} (${BUNDLE_ID}).`);
}

async function notes() {
  const { VERSION, BUILD } = process.env;
  const app = (await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`)).data[0];
  if (!app) throw new Error("no app record");

  /* Test Information — once per app, updated every build so it stays right. */
  const locs = await api("GET", `/v1/apps/${app.id}/betaAppLocalizations`);
  const en = locs.data.find((l) => /^en/.test(l.attributes.locale));
  const attrs = { feedbackEmail: FEEDBACK_EMAIL, description: DESCRIPTION };
  if (en) await api("PATCH", `/v1/betaAppLocalizations/${en.id}`, { data: { type: "betaAppLocalizations", id: en.id, attributes: attrs } });
  else await api("POST", "/v1/betaAppLocalizations", { data: { type: "betaAppLocalizations", attributes: { ...attrs, locale: "en-US" }, relationships: { app: { data: { type: "apps", id: app.id } } } } });
  console.log("Test Information filled.");

  /* What to Test — needs the build, which Apple lists only after processing. */
  let build = null;
  for (let i = 0; i < 50 && !build; i++) {
    const found = await api("GET", `/v1/builds?filter[app]=${app.id}&filter[version]=${BUILD}&filter[preReleaseVersion.version]=${VERSION}&limit=1`);
    const b = found.data[0];
    if (b && b.attributes.processingState === "VALID") build = b;
    else { console.log(`Waiting for Apple to process build ${BUILD} (${b ? b.attributes.processingState : "not listed yet"})…`); await sleep(30000); }
  }
  if (!build) throw new Error("Apple had not finished processing the build after 25 minutes");
  const whatsNew = fs.readFileSync("build/what-to-test.txt", "utf8").trim();
  const bl = await api("GET", `/v1/builds/${build.id}/betaBuildLocalizations`);
  const ben = bl.data.find((l) => /^en/.test(l.attributes.locale));
  if (ben) await api("PATCH", `/v1/betaBuildLocalizations/${ben.id}`, { data: { type: "betaBuildLocalizations", id: ben.id, attributes: { whatsNew } } });
  else await api("POST", "/v1/betaBuildLocalizations", { data: { type: "betaBuildLocalizations", attributes: { locale: "en-US", whatsNew }, relationships: { build: { data: { type: "builds", id: build.id } } } } });
  console.log(`"What to Test" filled for build ${BUILD}.`);
}

const cmd = process.argv[2];
try {
  if (cmd === "preflight") await preflight();
  else if (cmd === "notes") await notes();
  else throw new Error("use preflight or notes");
} catch (e) {
  console.error(`App Store Connect: ${e.message}`);
  process.exit(2);
}
