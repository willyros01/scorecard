/* App Store Connect API helper for the build (Node, no packages).
 *   node build/asc.mjs preflight   — check the Apple key is accepted
 *   node build/asc.mjs check       — read-only Apple setup check: key, bundle ID,
 *                                    Associated Domains, team, app record
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

  /* Make sure the build reaches the testers, whatever the group settings. */
  if (build.attributes.usesNonExemptEncryption == null) {
    await api("PATCH", `/v1/builds/${build.id}`, { data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } } });
    console.log("Export compliance answered: no non-exempt encryption.");
  } else console.log(`Export compliance already set (usesNonExemptEncryption: ${build.attributes.usesNonExemptEncryption}).`);
  const groups = await api("GET", `/v1/apps/${app.id}/betaGroups?limit=50`);
  const internal = (groups.data || []).filter((g) => g.attributes.isInternalGroup);
  if (!internal.length) console.log("::warning title=No internal group::No internal TestFlight group exists, so no tester receives the build.");
  for (const g of internal) {
    try {
      await api("POST", `/v1/betaGroups/${g.id}/relationships/builds`, { data: [{ type: "builds", id: build.id }] });
      console.log(`Build ${BUILD} added to internal group "${g.attributes.name}".`);
    } catch (e) { console.log(`Group "${g.attributes.name}": ${e.message} (automatic distribution may already have added it).`); }
  }
}

/* Read-only: reports every item, changes nothing. Exit 0 only if the key,
   the bundle ID and Associated Domains are all right (the app record is
   reported but not required, since it is created separately). */
async function check() {
  let bad = 0;
  const ok = (m) => console.log(`OK    ${m}`);
  const no = (m) => { console.log(`FAIL  ${m}`); bad++; };
  const note = (m) => console.log(`NOTE  ${m}`);
  try { await api("GET", "/v1/apps?limit=1"); ok("Apple accepts the key (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8)"); }
  catch (e) { no(`Apple refused the key: ${e.message}`); process.exit(1); }
  const ids = await api("GET", `/v1/bundleIds?filter[identifier]=${BUNDLE_ID}&limit=5`);
  const bid = (ids.data || []).find((b) => b.attributes.identifier === BUNDLE_ID);
  if (!bid) no(`bundle ID ${BUNDLE_ID} is not registered`);
  else {
    ok(`bundle ID ${BUNDLE_ID} is registered as "${bid.attributes.name}" (platform ${bid.attributes.platform})`);
    const team = process.env.APPLE_TEAM_ID || "";
    if (bid.attributes.seedId && team) (bid.attributes.seedId === team ? ok : no)(`bundle ID belongs to team ${bid.attributes.seedId}; APPLE_TEAM_ID is ${team}`);
    const caps = await api("GET", `/v1/bundleIds/${bid.id}/bundleIdCapabilities`);
    const types = (caps.data || []).map((c) => c.attributes.capabilityType);
    note(`capabilities on: ${types.join(", ") || "none"}`);
    types.includes("ASSOCIATED_DOMAINS") ? ok("Associated Domains is on") : no("Associated Domains is NOT on");
  }
  const apps = await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  if (apps.data.length) ok(`App Store Connect app record exists: "${apps.data[0].attributes.name}" (SKU ${apps.data[0].attributes.sku})`);
  else note("no App Store Connect app record yet (Willy creates it; needed before the first TestFlight build)");
  console.log(bad ? `RESULT: ${bad} problem(s)` : "RESULT: Apple setup is ready");
  process.exit(bad ? 1 : 0);
}

const cmd = process.argv[2];
try {
  if (cmd === "preflight") await preflight();
  else if (cmd === "notes") await notes();
  else if (cmd === "check") await check();
  else throw new Error("use preflight, notes or check");
} catch (e) {
  console.error(`App Store Connect: ${e.message}`);
  process.exit(2);
}
