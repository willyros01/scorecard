#!/usr/bin/env bash
# BK1–BK3: build/bk1.mjs (the complete backup) reads EVERYTHING, every
# subcollection included, even under a parent document that has no fields,
# and writes nothing. Against the emulators. Nothing touches the live project.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
P="demo-scorecard"
FS="http://127.0.0.1:8080/v1"
DB="projects/${P}/databases/(default)/documents"
AUTH="http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1"
H=(-H "Authorization: Bearer owner" -H "Content-Type: application/json")
pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }
curl -sS -X DELETE "${H[@]}" "http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents" >/dev/null
curl -sS -X DELETE "${H[@]}" "http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts" >/dev/null
curl -sS "${H[@]}" -d '{"email":"one@example.com","password":"pass-one-1"}' "${AUTH}/projects/${P}/accounts" >/dev/null
put(){ curl -sS --fail "${H[@]}" -d "{\"writes\":[{\"update\":{\"name\":\"${DB}/$1\",\"fields\":{\"v\":{\"stringValue\":\"$2\"}}}}]}" "${FS}/${DB}:commit" >/dev/null; }
put "associations/G1" "group"
put "associations/G1/rounds/r1" "round"
put "associations/G1/members/m1" "member"
put "associations/GHOST/rounds/r9" "orphan round under a group document that does not exist"
put "golfers/g1" "golfer"
put "associations/odd id 3/rounds/r 1" "ids with spaces"
for i in $(seq 1 30); do put "associations/W${i}" "group"; put "associations/W${i}/rounds/r1" "round"; put "associations/W${i}/members/m1" "member"; done
OUT="$(mktemp -d)/backup.json"
ACCESS_TOKEN=owner PROJECT="${P}" FS_BASE="${FS}" AUTH_BASE="${AUTH}" node "${REPO}/build/bk1.mjs" "${OUT}" > "${OUT}.log" 2>&1
code=$?; sed 's/^/      | /' "${OUT}.log"
check "BK1 the backup finishes (exit 0)"                                    [ "${code}" = 0 ]
has(){ jq -e --arg p "$1" '.documents | map(.path) | index($p) != null' "${OUT}" >/dev/null; }
check "BK1 a group is saved"                                                has "associations/G1"
check "BK1 its rounds are saved"                                            has "associations/G1/rounds/r1"
check "BK1 its members are saved"                                           has "associations/G1/members/m1"
check "BK1 a golfer is saved"                                               has "golfers/g1"
check "BK2 a round under a group document that no longer exists is saved"   has "associations/GHOST/rounds/r9"
check "BK2 the accounts are listed, without passwords"                      jq -e '(.accounts | length == 1) and (.accounts[0].email == "one@example.com") and ((tostring | test("passwordHash")) | not)' "${OUT}"
check "BK2 the round's value is saved exactly"                              jq -e '.documents[] | select(.path == "associations/G1/rounds/r1") | .fields.v.stringValue == "round"' "${OUT}"
check "BK3 ids with spaces are read"                                        has "associations/odd id 3/rounds/r 1"
check "BK3 a wide tree is read in full (31 groups)"                         jq -e '[.documents[] | select((.missing | not) and (.path | test("^associations/[^/]+$")))] | length == 31' "${OUT}"
echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
