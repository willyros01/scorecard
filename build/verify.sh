#!/usr/bin/env bash
# Build checks V1–V6 (spec Change 3, Part A). Any failure stops the build.
# Runs in CI before the web tests and before every iPhone build.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

ok(){ echo "OK    $*"; }
fail(){ echo "FAIL  $*"; exit 1; }

# V1 — the lockfile must match package.json exactly.
[[ -f package-lock.json ]] || fail "V1 package-lock.json is missing"
npm ci --no-audit --no-fund > "${TMPDIR:-/tmp}/npm-ci.log" 2>&1 || { tail -n 40 "${TMPDIR:-/tmp}/npm-ci.log"; fail "V1 npm ci refused (the npm output above says why)"; }
ok "V1 npm ci succeeded from the committed lockfile"

# V2 — installed versions equal the approved list, and nothing is a range.
node - <<'NODE' || fail "V2 versions differ from build/approved-versions.json"
const approved = require("./build/approved-versions.json");
const pkg = require("./package.json");
const { execSync } = require("child_process");
const tree = JSON.parse(execSync("npm ls --json --depth=0", { encoding: "utf8" }));
const bad = [];
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
for (const [name, version] of Object.entries(declared)) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) bad.push(`${name}: "${version}" is not an exact version`);
  if (approved[name] !== version) bad.push(`${name}: package.json ${version}, approved ${approved[name]}`);
}
for (const [name, version] of Object.entries(approved)) {
  const got = tree.dependencies && tree.dependencies[name] && tree.dependencies[name].version;
  if (got !== version) bad.push(`${name}: approved ${version}, installed ${got}`);
  if (!(name in declared)) bad.push(`${name}: approved but not in package.json`);
}
if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
NODE
ok "V2 every package is exactly the approved version"

# V3 — rebuilding the Firebase bundle gives a byte-identical file.
BUNDLE=vendor/firebase/firebase-10.12.0.js
[[ -f "${BUNDLE}" ]] || fail "V3 ${BUNDLE} is missing"
TMP="$(mktemp -d)"
cp "${BUNDLE}" "${TMP}/committed.js"
npm run -s bundle >/dev/null
cmp -s "${TMP}/committed.js" "${BUNDLE}" || { cp "${TMP}/committed.js" "${BUNDLE}"; fail "V3 the committed bundle differs from a fresh build"; }
ok "V3 the committed bundle is identical to a fresh build"

# V4 — nothing packaged fetches code from the internet.
FILES=()
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"
  [[ -n "${line}" ]] || continue
  if [[ "${line}" == */ ]]; then while IFS= read -r f; do FILES+=("$f"); done < <(find "${line%/}" -type f | sort)
  else FILES+=("${line}"); fi
done < build/www-files.txt
for f in "${FILES[@]}"; do [[ -f "$f" ]] || fail "V4 packaged file missing: $f"; done
PATTERN='gstatic\.com|apis\.google\.com/js|recaptcha/api\.js|import\(\s*["'"'"'`]https?:|from\s*["'"'"']https?:|<script[^>]+src=["'"'"']https?:'
if grep -EnH "${PATTERN}" "${FILES[@]}" > "${TMP}/remote.txt"; then
  cut -c1-200 "${TMP}/remote.txt"
  fail "V4 packaged files load code from the internet"
fi
ok "V4 no remote code in the ${#FILES[@]} packaged files"

# V5 — Capacitor JS and native versions all 8.5.2.
node - <<'NODE' || fail "V5 Capacitor versions do not all match"
const { execSync } = require("child_process");
const tree = JSON.parse(execSync("npm ls --json --depth=0", { encoding: "utf8" })).dependencies || {};
const want = "8.5.2";
const bad = ["@capacitor/core", "@capacitor/cli", "@capacitor/ios"]
  .filter((n) => !tree[n] || tree[n].version !== want)
  .map((n) => `${n}: ${tree[n] && tree[n].version}`);
if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
NODE
if [[ -d ios ]]; then
  NATIVE="$(grep -rhoE 'capacitor-swift-pm[^0-9]*[0-9]+\.[0-9]+\.[0-9]+' ios 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -u || true)"
  [[ -z "${NATIVE}" || "${NATIVE}" == "8.5.2" ]] || fail "V5 native Capacitor is ${NATIVE}, not 8.5.2"
fi
ok "V5 Capacitor core, cli and ios are 8.5.2"

# V6 — links are not built from the page address, and the bundle exports
# every Firebase function store.js uses.
if grep -n "location\.origin" app.js store.js; then fail "V6 location.origin is still used"; fi
node - <<'NODE' || fail "V6 store.js uses a Firebase function the bundle does not export"
const fs = require("fs");
const s = fs.readFileSync("store.js", "utf8");
const e = fs.readFileSync("build/firebase-entry.js", "utf8");
const used = { auth: new Set(), store: new Set() };
for (const m of s.matchAll(/const\s*\{([^}]*)\}\s*=\s*fb\.mod\.(auth|store)/g))
  m[1].split(",").map((x) => x.trim().split(":")[0].trim()).filter(Boolean).forEach((n) => used[m[2]].add(n));
for (const m of s.matchAll(/fb\.mod\.(auth|store)\.(\w+)/g)) used[m[1]].add(m[2]);
const init = s.slice(s.indexOf("export async function init"), s.indexOf("export async function init") + 4000);
for (const m of init.matchAll(/\b(auth|store)\.(\w+)\b/g)) used[m[1]].add(m[2]);
const missing = [];
for (const k of ["auth", "store"]) {
  const block = (e.match(new RegExp(`export const ${k} = \\{([^}]*)\\}`)) || [])[1] || "";
  const have = new Set(block.split(",").map((x) => x.trim()).filter(Boolean));
  for (const n of used[k]) if (!have.has(n)) missing.push(`${k}.${n}`);
}
if (missing.length) { console.log(missing.join("\n")); process.exit(1); }
NODE
ok "V6 no location.origin; the bundle exports everything store.js uses"

echo "verify.sh: all checks passed"
