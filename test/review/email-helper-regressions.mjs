/* 2.31.5 (Willy, 13 Nov 2026): the sign-in emails go through The Marker's
 * Cloudflare helper, with Firebase's own email as the fallback. These checks
 * keep that wiring from being lost. */
import fs from "node:fs";
const s = fs.readFileSync(new URL("../../store.js", import.meta.url), "utf8");
let bad = 0;
const check = (ok, name) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) bad++; };
const calls = s.match(/sendSignInLinkToEmail\(/g) || [];
check(calls.length === 1, "EH1 Firebase's own sign-in email is sent in one place only: the fallback");
const fn = s.slice(s.indexOf("async function sendSignInEmail"), s.indexOf("export async function sendApplicationLink"));
check(/\/send-link/.test(fn) && /data\.sent === true\) return;/.test(fn), "EH2 the helper is asked first; only its confirmed send stops the fallback");
check(/catch \{ \/\* Firebase sends it below \*\/ \}/.test(fn) && /await fb\.mod\.auth\.sendSignInLinkToEmail\(fb\.auth, address, settings\);\s*\}$/.test(fn.trim()), "EH3 any failure of the helper falls back to Firebase's email");
check(/!EMULATORS/.test(fn), "EH4 tests against the emulators never call the live helper");
check(/const HELPER_URL = "https:\/\/marker\.willyros01\.workers\.dev";/.test(s), "EH5 the helper's address is known without a sign-in (applicants have none)");
for (const f of ["sendPasswordReset", "sendApplicationLink", "sendApprovalLink"]) {
  const body = s.slice(s.indexOf(`export async function ${f}`), s.indexOf("\n}", s.indexOf(`export async function ${f}`)));
  check(/sendSignInEmail\(/.test(body), `EH6 ${f} sends through the helper`);
}
check(/url: `\$\{settings\.url\}&reset=1`/.test(s), "EH7 Forgot password keeps reset=1, so its email is titled as a password change");
console.log(`RESULT: ${bad ? "FAILED" : "all passed"}`);
process.exit(bad ? 1 : 0);
