#!/usr/bin/env bash
# CL1–CL8: build/cl5.txt (the one-time group clean-up) end to end, against the
# Firestore and Auth emulators. Google Cloud is played by the stand-ins in
# test/ops/go2-fakes (gcloud, and curl for the GitHub downloads). Also checks
# that groups-check.html shows the same plan. Nothing touches the live project.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
CURL="$(command -v curl)"
P="scorecard-f41b8"
FS="http://127.0.0.1:8080/v1"
DB="projects/${P}/databases/(default)/documents"
AUTH="http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1"
H=(-H "Authorization: Bearer owner" -H "Content-Type: application/json")
pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }

reset(){
  "${CURL}" -sS -X DELETE "${H[@]}" "http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents" >/dev/null
  "${CURL}" -sS -X DELETE "${H[@]}" "http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts" >/dev/null
  PROJECT="${P}" node "${HERE}/cl5-seed.mjs" "$@" >/dev/null
}
FAKE="$(mktemp -d)"; RUN="$(mktemp -d)"
cl5(){ ( cd "${RUN}" && printf '%s\n' "${ANSWER:-yes}" | PATH="${HERE}/go2-fakes:${PATH}" FAKE_DIR="${FAKE}" REPO_DIR="${REPO}" \
  FS_BASE="${FS}" AUTH_BASE="${AUTH}" bash "${REPO}/build/cl5.txt" "$@" ) > "${RUN}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${RUN}/out.txt" | tail -n "${1:-10}"; }
snap(){ ACCESS_TOKEN=owner PROJECT="${P}" FS_BASE="${FS}" AUTH_BASE="${AUTH}" node "${REPO}/build/bk1.mjs" "$1" >/dev/null; }
has(){ jq -e --arg p "$2" '.documents | map(select(.missing | not) | .path) | index($p) != null' "$1" >/dev/null; }
f(){ jq -c --arg p "$2" ".documents[] | select(.path == \$p) | .fields$3" "$1"; }
# Everything in Willy's four groups except what Philippine Golfers receives, plus the golfers not involved.
eq(){ [ "$1" = "$2" ]; }
absent(){ ! has "$1" "$2"; }
kept(){ jq -S '[.documents[] | select(.path | test("^associations/(PUBLIC|RR1|GB1)(/|$)|^associations/PG1$|^associations/PG1/members/W$|^golfers/(gP1|gN|gZ)$|^joinCodes/GGGGGG$|^userGroups/W/")) | {path, fields}] | sort_by(.path)' "$1"; }

echo "== CL1 two groups could be the real Golfing Buddies: it stops, nothing changes"
reset ambiguous; snap "${RUN}/b0.json"
code="$(cl5)"; show 4
check "CL1 stops (exit 1)"                                                   [ "${code}" = 1 ]
check "CL1 says why"                                                         grep -q 'groups are called "golfing buddies"' "${RUN}/out.txt"
snap "${RUN}/b1.json"
check "CL1 nothing changed"                                                  diff -q <(jq -S '[.documents[]|{path,fields}]|sort_by(.path)' "${RUN}/b0.json") <(jq -S '[.documents[]|{path,fields}]|sort_by(.path)' "${RUN}/b1.json")

echo "== CL2 answering no changes nothing"
reset; snap "${RUN}/b0.json"
code="$(ANSWER=no cl5)"; show 3
check "CL2 stops (exit 1)"                                                   [ "${code}" = 1 ]
snap "${RUN}/b1.json"
check "CL2 nothing changed"                                                  diff -q <(jq -S '[.documents[]|{path,fields}]|sort_by(.path)' "${RUN}/b0.json") <(jq -S '[.documents[]|{path,fields}]|sort_by(.path)' "${RUN}/b1.json")
check "CL2 the backup before was taken"                                      ls "${RUN}"/scorecard-backup-before-cleanup-*.json

echo "== CL3 interrupted after its first step, then run again"
reset; snap "${RUN}/before.json"
code="$(CL5_STOP_AFTER=1 cl5)"; show 3
check "CL3 the interrupted run stops (exit 1)"                               [ "${code}" = 1 ]
code="$(cl5)"; show 12
check "CL3 the second run finishes (exit 0)"                                 [ "${code}" = 0 ]
check "CL3 it checks itself"                                                 grep -q "OK: only your 4 groups remain" "${RUN}/out.txt"
snap "${RUN}/after.json"
A="${RUN}/after.json"; B="${RUN}/before.json"

echo "== CL4 the four groups are untouched; Philippine Golfers only receives"
check "CL4 everything kept is exactly as before"                             diff -q <(kept "${B}") <(kept "${A}")
for g in PUBLIC RR1 PG1 GB1; do check "CL4 ${g} still exists"              has "${A}" "associations/${g}"; done

echo "== CL5 the orphans are gone, with everything in them"
check "CL5 no other group remains"                                           jq -e '[.documents[] | select(.missing|not) | .path | select(test("^associations/")) | split("/")[1]] | unique == ["GB1","PG1","PUBLIC","RR1"]' "${A}" >/dev/null
check "CL5 the orphan's join code is gone"                                  absent "${A}" "joinCodes/ABC123"
check "CL5 the real join code is kept"                                       has "${A}" "joinCodes/GGGGGG"
check "CL5 the link to the orphan group is gone"                             absent "${A}" "userGroups/UA/groups/OLD1"

echo "== CL6 the golfer found only in orphans moved, with her rounds"
check "CL6 on the Philippine Golfers roster"                                 has "${A}" "associations/PG1/roster/gA"
check "CL6 in its directory"                                                 has "${A}" "associations/PG1/directory/gA"
check "CL6 her own rounds moved (3), the copy did not"                       jq -e '[.documents[] | select(.path|test("^associations/PG1/rounds/"))|.path] | sort == ["associations/PG1/rounds/rA1","associations/PG1/rounds/rA3","associations/PG1/rounds/rG"]' "${A}" >/dev/null
check "CL6 a moved round belongs to Philippine Golfers, no game"             eq "$(f "${A}" associations/PG1/rounds/rA3 '|[.assocId.stringValue, (.gameId|has("nullValue")), .movedFrom.stringValue, .gross.integerValue]')" '["PG1",true,"OLD1","87"]'
check "CL6 her groups are Philippine Golfers only"                           eq "$(f "${A}" golfers/gA '.groups')" '{"arrayValue":{"values":[{"stringValue":"PG1"}]}}'
check "CL6 her handicap window points at Philippine Golfers, once each"     eq "$(f "${A}" golfers/gA '.recentWindow.arrayValue.values|map(.mapValue.fields|.roundId.stringValue+"@"+.assocId.stringValue)|join(",")')" '"rG@PG1,rA3@PG1,rA1@PG1"'
check "CL6 her account is a member, as her golfer"                           eq "$(f "${A}" associations/PG1/members/UA '|[.role.stringValue,.golferId.stringValue,.uid.stringValue]')" '["member","gA","UA"]'
check "CL6 and finds the group in her list"                                  has "${A}" "userGroups/UA/groups/PG1"

echo "== CL7 nobody is left without a group"
check "CL7 the account found only in an orphan joined Philippine Golfers"    has "${A}" "associations/PG1/members/UE"
check "CL7 the golfer who stays keeps his real group"                        eq "$(f "${A}" golfers/gB '.groups')" '{"arrayValue":{"values":[{"stringValue":"GB1"}]}}'
check "CL7 his handicap points at the real copy of a copied round"           eq "$(f "${A}" golfers/gB '.recentWindow.arrayValue.values|map(.mapValue.fields|.roundId.stringValue+"@"+.assocId.stringValue)|join(",")')" '"rB3@GB2,rB2@GB1,v1-round-1@GB1"'
check "CL7 his handicap number is unchanged"                                 eq "$(f "${A}" golfers/gB '.handicapIndex.doubleValue')" '15.2'

echo "== CL8 running it again does nothing; verify agrees"
code="$(cl5)"; show 2
check "CL8 nothing to clean up (exit 0)"                                     [ "${code}" = 0 ]
check "CL8 says so"                                                          grep -q "nothing to clean up" "${RUN}/out.txt"
code="$(cl5 verify)"; show 2
check "CL8 verify passes"                                                    [ "${code}" = 0 ]

echo "== CL9 the Groups check page shows the same plan, from a backup on the device"
if [ -d "${REPO}/node_modules/playwright" ]; then
  reset; snap "${RUN}/page.json"
  ( cd "${REPO}" && node "${HERE}/cl5-page.mjs" "${RUN}/page.json" ) > "${RUN}/page.txt" 2>&1
  code=$?; sed 's/^/      | /' "${RUN}/page.txt" | tail -n 6
  check "CL9 the page shows the plan"                                        [ "${code}" = 0 ]
else
  echo "SKIP  CL9 (npm ci not run)"
fi

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
