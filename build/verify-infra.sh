#!/usr/bin/env bash
# Phase 1 infrastructure gate: I1-I5 from the approved iOS migration spec.
# Read-only. It changes no repository, website, Firebase or Apple setting.

set -Eeuo pipefail

for command in curl jq node git; do
  command -v "${command}" >/dev/null || {
    echo "FAIL: ${command} is required." >&2
    exit 1
  }
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

SITE="https://www.cuberoot-systems.com"
APP_ID="VXMLKHF72B.io.github.willyros01.scorecard"
pass=0

ok() {
  pass=$((pass + 1))
  printf 'PASS %s\n' "$*"
}

fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

status() {
  curl --silent --show-error --max-time 30 --output /dev/null \
    --write-out '%{http_code}' "$1"
}

# I1: the origin file has no redirect, is valid JSON, identifies this app,
# and Apple's copy is the same JSON.
curl --silent --show-error --max-time 30 \
  --dump-header "${WORK}/aasa.headers" --output "${WORK}/aasa.origin" \
  "${SITE}/.well-known/apple-app-site-association"
grep -Eq '^HTTP/[0-9.]+ 200([[:space:]]|$)' "${WORK}/aasa.headers" \
  || fail "I1: association file did not answer 200."
! grep -Eqi '^location:' "${WORK}/aasa.headers" \
  || fail "I1: association file redirected."
jq -e --arg app "${APP_ID}" \
  '.applinks.details[]?.appIDs[]? == $app' "${WORK}/aasa.origin" >/dev/null \
  || fail "I1: Team ID or bundle ID is wrong."
curl --silent --show-error --fail --max-time 30 \
  "https://app-site-association.cdn-apple.com/a/v1/www.cuberoot-systems.com" \
  > "${WORK}/aasa.apple"
jq -S -c . "${WORK}/aasa.origin" > "${WORK}/aasa.origin.normalized"
jq -S -c . "${WORK}/aasa.apple" > "${WORK}/aasa.apple.normalized"
cmp -s "${WORK}/aasa.origin.normalized" "${WORK}/aasa.apple.normalized" \
  || fail "I1: Apple's cached association file does not match the origin."
ok "I1 Apple association file and Apple CDN copy match."

# I2: run the live forwarding JavaScript in a small browser-like sandbox and
# prove that it preserves the exact invitation query.
curl --silent --show-error --fail --max-time 30 \
  "${SITE}/scorecard/join/forward.js" > "${WORK}/forward.js"
node - "${WORK}/forward.js" <<'NODE'
const fs = require('fs');
const vm = require('vm');
let replaced = '';
const context = {
  URL,
  window: { location: { search: '?join=TEST.CODE', replace: value => { replaced = value; } } },
  document: { querySelector: () => ({ href: '', hidden: true }) }
};
vm.runInNewContext(fs.readFileSync(process.argv[2], 'utf8'), context);
if (replaced !== 'https://willyros01.github.io/scorecard/?join=TEST.CODE') {
  console.error(`Unexpected destination: ${replaced}`);
  process.exit(1);
}
NODE
ok "I2 invitation query is preserved by the live forwarding script."

# I3: public pages and PDF are live over HTTPS. HTTP must redirect to the same
# HTTPS address. The policy must state D1 and D5 explicitly.
for path in scorecard/privacy/ scorecard/support/ scorecard/guide/; do
  [[ "$(status "${SITE}/${path}")" == 200 ]] \
    || fail "I3: HTTPS ${path} did not answer 200."
  location="$(curl --silent --show-error --max-time 30 --head \
    "http://www.cuberoot-systems.com/${path}" \
    | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
  [[ "${location}" == "${SITE}/${path}" ]] \
    || fail "I3: HTTP ${path} did not redirect to HTTPS."
done
[[ "$(status "${SITE}/guides/the-scorecard/the-scorecard-user-guide.pdf")" == 200 ]] \
  || fail "I3: PDF guide did not answer 200."
curl --silent --show-error --fail --max-time 30 \
  "${SITE}/scorecard/privacy/" > "${WORK}/privacy.html"
grep -Fqi 'golfer name' "${WORK}/privacy.html" \
  || fail "I3: privacy policy does not state that the golfer name remains."
grep -Fqi 'within one day' "${WORK}/privacy.html" \
  || fail "I3: privacy policy does not state the one-day completion promise."
ok "I3 privacy, support, guide and PDF are live with required policy text."

# I4: main may differ from the known-good tag only by the two approved job
# files. No file loaded by the live web app may differ.
git -C "${ROOT}" fetch --quiet origin main \
  refs/tags/v2.21.9-live:refs/tags/v2.21.9-live
mapfile -t main_changes < <(git -C "${ROOT}" diff --name-only \
  v2.21.9-live..origin/main | sort)
expected=(
  '.github/scripts/finish-deletions.sh'
  '.github/workflows/finish-deletions.yml'
)
[[ "${main_changes[*]}" == "${expected[*]}" ]] \
  || fail "I4: main differs from v2.21.9-live outside the two approved deletion-job files."
ok "I4 live web application files remain identical to v2.21.9-live."

# I5: every pre-Phase-1 Cuberoot page still answers 200.
existing=(
  '/'
  '/admin/'
  '/archive.html'
  '/docs.html'
  '/library.html'
  '/privacy.html'
  '/then-and-now.html'
  '/view.html'
)
for path in "${existing[@]}"; do
  [[ "$(status "${SITE}${path}")" == 200 ]] \
    || fail "I5: existing page ${path} did not answer 200."
done
ok "I5 every pre-Phase-1 Cuberoot page still answers 200."

printf '\nSUCCESS: Phase 1 infrastructure gate passed (%d/5).\n' "${pass}"
