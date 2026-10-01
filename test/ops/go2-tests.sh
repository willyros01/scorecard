#!/usr/bin/env bash
# GL1–GL5: go2.txt itself, end to end, with its failure recovery (go-live fix 3).
# Google Cloud is played by stand-ins (test/ops/go2-fakes: gcloud, and curl for
# GitHub, the Rules API and the Auth config API); the data step runs for real
# against the Firestore and Auth emulators, in a project named like the live
# one. Nothing here touches the live project.
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

"${CURL}" -sS -X DELETE "${H[@]}" "http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents" >/dev/null
"${CURL}" -sS -X DELETE "${H[@]}" "http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts" >/dev/null
W="$("${CURL}" -sS "${H[@]}" -d '{"email":"willyros01@gmail.com","password":"owner-pass-1"}' "${AUTH}/projects/${P}/accounts" | jq -r .localId)"
put(){ jq -nc --arg n "${DB}/$1" --argjson f "$2" '{writes:[{update:{name:$n,fields:$f}}]}' \
  | "${CURL}" -sS --fail "${H[@]}" --data-binary @- "${FS}/${DB}:commit" >/dev/null; }
s(){ printf '{"stringValue":"%s"}' "$1"; }
put "associations/G1" "{\"name\":$(s 'Saturday Group'),\"ownerUid\":$(s "${W}"),\"joinCode\":$(s JOIN01),\"adminCode\":$(s LEG009)}"
put "associations/G1/members/${W}" "{\"uid\":$(s "${W}"),\"role\":$(s owner),\"displayName\":$(s 'Willy Rosales')}"
put "golfers/gZ" "{\"name\":$(s 'Zed Golfer'),\"nameKey\":$(s zed-golfer),\"linkedUid\":{\"nullValue\":null}}"
put "associations/G1/roster/gZ" "{\"golferId\":$(s gZ)}"
field(){ "${CURL}" -sS "${H[@]}" "${FS}/${DB}/$1" | jq -r --arg f "$2" '.fields[$f] | if . == null then "MISSING" else (.stringValue // .nullValue // "x") end'; }

FAKE="$(mktemp -d)"; RUN="$(mktemp -d)"
echo "rules_version = '2'; /* the rules rf1.txt published (stand-in) */" > "${FAKE}/old-rules.txt"
mkdir -p "${FAKE}/rulesets"; cp "${FAKE}/old-rules.txt" "${FAKE}/rulesets/r0.txt"
echo "projects/${P}/rulesets/r0" > "${FAKE}/release.txt"
live(){ cat "${FAKE}/rulesets/$(basename "$(cat "${FAKE}/release.txt")").txt"; }
live_is_old(){ [[ "$(live)" == "$(cat "${FAKE}/old-rules.txt")" ]]; }
live_is_v2(){ diff -q <(live) "${REPO}/firestore.rules" >/dev/null; }
marker(){ field "migrations/v2" state; }
go2(){ ( cd "${RUN}" && printf 'yes\n' | PATH="${HERE}/go2-fakes:${PATH}" FAKE_DIR="${FAKE}" REPO_DIR="${REPO}" \
  FS_BASE="${FS}" AUTH_BASE="${AUTH}" "$@" bash "${REPO}/build/go2.txt" ${GO2_MODE:-} ) > "${RUN}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${RUN}/out.txt" | tail -n "${1:-12}"; }

echo "== GL1 the data step fails part-way: everything is put back by itself"
code="$(go2 env BATCH_SIZE=1 FAIL_AFTER_COMMITS=1)"; show
check "GL1 go2.txt stops (exit 1)"                                         [ "${code}" = 1 ]
check "GL1 it says what failed and that everything is back"               grep -q "Something failed during the data step" "${RUN}/out.txt"
check "GL1 the old rules are still live"                                   live_is_old
check "GL1 the admin code is back on the group"                            [ "$(field associations/G1 adminCode)" = LEG009 ]
check "GL1 the marker says rolled-back"                                    [ "$(marker)" = rolled-back ]

echo "== GL2 publishing the rules fails: the old rules stay, then a second run succeeds"
touch "${FAKE}/fail-patch"
code="$(go2 env)"; show
check "GL2 go2.txt stops (exit 1)"                                         [ "${code}" = 1 ]
check "GL2 it names the step"                                              grep -q "Something failed during publishing the rules" "${RUN}/out.txt"
check "GL2 the old rules are live"                                         live_is_old
check "GL2 the admin code is back"                                         [ "$(field associations/G1 adminCode)" = LEG009 ]
code="$(go2 env)"; show 6
check "GL2 running it again goes live (exit 0)"                            [ "${code}" = 0 ]
check "GL2 the Version 2.0 rules are live"                                 live_is_v2
check "GL2 the marker says verified"                                       [ "$(marker)" = verified ]
check "GL2 the admin code moved off the group"                             [ "$(field associations/G1 adminCode)" = MISSING ]
code="$(go2 env)"
check "GL3 running it once more only checks (exit 0)"                     [ "${code}" = 0 ]
check "GL3 ... and says so"                                                grep -q "already published in an earlier run" "${RUN}/out.txt"

echo "== GL4 the manual rollback"
code="$(GO2_MODE=rollback go2 env)"; show 6
check "GL4 rollback succeeds (exit 0)"                                     [ "${code}" = 0 ]
check "GL4 the old rules are live"                                         live_is_old
check "GL4 the admin code is back"                                         [ "$(field associations/G1 adminCode)" = LEG009 ]

echo "== GL5 the check after publishing fails: the old rules are put back"
echo 2 > "${FAKE}/fail-verify"
code="$(go2 env)"; show
check "GL5 go2.txt stops (exit 1)"                                         [ "${code}" = 1 ]
check "GL5 it names the step"                                              grep -q "Something failed during checking the published rules" "${RUN}/out.txt"
check "GL5 the old rules are live again"                                   live_is_old
check "GL5 the admin code is back"                                         [ "$(field associations/G1 adminCode)" = LEG009 ]
check "GL5 the marker says rolled-back"                                    [ "$(marker)" = rolled-back ]
code="$(GO2_MODE=status go2 env)"
check "GL5 status shows the marker"                                        grep -q "rolled-back" "${RUN}/out.txt"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
