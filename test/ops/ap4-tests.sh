#!/usr/bin/env bash
# AP1–AP8: build/ap4.txt itself (beta.4: the cockpit and the applications
# switch), end to end with its recovery. Google Cloud is played by the
# stand-ins in test/ops/go2-fakes (gcloud, and curl for GitHub, the Rules API
# and Firebase's sign-in setting); the data step (build/ap4.mjs) runs for real
# against the Firestore and Auth emulators. Nothing here touches the live project.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
CURL="$(command -v curl)"
P="scorecard-f41b8"
FS="http://127.0.0.1:8080/v1"
DB="projects/${P}/databases/(default)/documents"
AUTH="http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1"
H=(-H "Authorization: Bearer owner" -H "Content-Type: application/json")
LIVE_COMMIT="747678bf321754269dd962343ec0a2ed4a312a66"

pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }

"${CURL}" -sS -X DELETE "${H[@]}" "http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents" >/dev/null
"${CURL}" -sS -X DELETE "${H[@]}" "http://127.0.0.1:9099/emulator/v1/projects/${P}/accounts" >/dev/null
"${CURL}" -sS "${H[@]}" -d '{"email":"Golfer.One@Example.com","password":"golfer-pass-1"}' "${AUTH}/projects/${P}/accounts" >/dev/null
doc_exists(){ [[ "$("${CURL}" -sS -o /dev/null -w '%{http_code}' "${H[@]}" "${FS}/${DB}/$1")" == 200 ]]; }
field(){ "${CURL}" -sS "${H[@]}" "${FS}/${DB}/$1" | jq -r --arg f "$2" '.fields[$f] | if . == null then "MISSING" else (.stringValue // .integerValue // "x") end'; }

FAKE="$(mktemp -d)"; RUN="$(mktemp -d)"
echo "rules_version = '2'; /* the rules rq3.txt published (stand-in) */" > "${FAKE}/old-rules.txt"
mkdir -p "${FAKE}/rulesets" "${FAKE}/raw/${LIVE_COMMIT}"
cp "${FAKE}/old-rules.txt" "${FAKE}/rulesets/r0.txt"
cp "${FAKE}/old-rules.txt" "${FAKE}/raw/${LIVE_COMMIT}/firestore.rules"
echo "projects/${P}/rulesets/r0" > "${FAKE}/release.txt"
live(){ cat "${FAKE}/rulesets/$(basename "$(cat "${FAKE}/release.txt")").txt"; }
live_is_old(){ [[ "$(live)" == "$(cat "${FAKE}/old-rules.txt")" ]]; }
live_is_new(){ diff -q <(live) "${REPO}/firestore.rules" >/dev/null; }
auth_val(){ jq -r "$1" "${FAKE}/auth-config.json" 2>/dev/null || echo "none"; }
auth_original(){ [[ ! -f "${FAKE}/auth-config.json" ]] || [[ "$(auth_val '.signIn.email.passwordRequired')" == true && "$(auth_val '.authorizedDomains|join(",")')" == "localhost,scorecard-f41b8.firebaseapp.com" ]]; }
auth_on(){ [[ "$(auth_val '.signIn.email.passwordRequired')" == false && "$(auth_val '.authorizedDomains|index("www.cuberoot-systems.com") != null')" == true ]]; }
ap4(){ ( cd "${RUN}" && printf 'yes\n' | PATH="${HERE}/go2-fakes:${PATH}" FAKE_DIR="${FAKE}" REPO_DIR="${REPO}" \
  FS_BASE="${FS}" AUTH_BASE="${AUTH}" bash "${REPO}/build/ap4.txt" ${AP4_MODE:-} ) > "${RUN}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${RUN}/out.txt" | tail -n "${1:-8}"; }

check "AP0 the new rules carry the beta.4 header"                          grep -q "COCKPIT AND AUTO APPLICATIONS (beta.4)" "${REPO}/firestore.rules"

echo "== AP1 switching on email link sign-in fails: everything is put back"
touch "${FAKE}/fail-auth"
code="$(ap4)"; show
check "AP1 ap4.txt stops (exit 1)"                                          [ "${code}" = 1 ]
check "AP1 it names the step"                                               grep -q "Something failed during switching on email link sign-in" "${RUN}/out.txt"
check "AP1 the earlier rules are live"                                      live_is_old
check "AP1 the sign-in setting is as it was"                                auth_original

echo "== AP2 running it again goes live"
code="$(ap4)"; show 6
check "AP2 succeeds (exit 0)"                                               [ "${code}" = 0 ]
check "AP2 the beta.4 rules are live"                                       live_is_new
check "AP2 email link sign-in is on and the Cuberoot address allowed"       auth_on
check "AP2 password sign-in stays on"                                       [ "$(auth_val '.signIn.email.enabled')" = true ]
check "AP2 the account's email is recorded (lower case)"                    doc_exists "accountEmails/golfer.one@example.com"
check "AP2 the switch starts on Manual, 20 a day"                           [ "$(field settings/publicApplications mode)/$(field settings/publicApplications dailyLimit)" = "manual/20" ]
check "AP2 throwaway domains are blocked"                                   doc_exists "blockedDomains/mailinator.com"

echo "== AP3 once more only checks"
code="$(ap4)"
check "AP3 exit 0"                                                          [ "${code}" = 0 ]
check "AP3 ... and says it is already live"                                 grep -q "already live" "${RUN}/out.txt"
code="$(AP4_MODE=verify ap4)"; show 4
check "AP4 verify says OK"                                                  [ "${code}" = 0 ]

echo "== AP5 the manual rollback"
code="$(AP4_MODE=rollback ap4)"; show 4
check "AP5 rollback succeeds (exit 0)"                                      [ "${code}" = 0 ]
check "AP5 the earlier rules are live"                                      live_is_old
check "AP5 the sign-in setting is back as it was"                           auth_original

echo "== AP6 publishing the rules fails: everything is put back"
touch "${FAKE}/fail-patch"
code="$(ap4)"; show
check "AP6 ap4.txt stops (exit 1)"                                          [ "${code}" = 1 ]
check "AP6 it names the step"                                               grep -q "Something failed during publishing the rules" "${RUN}/out.txt"
check "AP6 the earlier rules are live"                                      live_is_old
check "AP6 the sign-in setting is back as it was"                           auth_original

echo "== AP7 the check after publishing fails: everything is put back"
echo 2 > "${FAKE}/fail-verify"
code="$(ap4)"; show
check "AP7 ap4.txt stops (exit 1)"                                          [ "${code}" = 1 ]
check "AP7 it names the step"                                               grep -q "Something failed during checking the published rules" "${RUN}/out.txt"
check "AP7 the earlier rules are live"                                      live_is_old
check "AP7 the sign-in setting is back as it was"                           auth_original
rm -f "${FAKE}/fail-verify"

echo "== AP8 the live rules are not the expected ones: nothing is changed"
rm -rf "${RUN}/scorecard-ap4-backup"
echo "rules_version = '2'; /* something else */" > "${FAKE}/rulesets/rX.txt"
echo "projects/${P}/rulesets/rX" > "${FAKE}/release.txt"
code="$(ap4)"; show 3
check "AP8 ap4.txt refuses (exit 1)"                                        [ "${code}" = 1 ]
check "AP8 it says why"                                                     grep -q "not the ones rq3.txt published" "${RUN}/out.txt"
check "AP8 nothing was published"                                           [ "$(live)" = "rules_version = '2'; /* something else */" ]

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
