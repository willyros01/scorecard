#!/usr/bin/env bash
# SEC1–SEC5: proves a forged deletion request cannot harm anyone else's data,
# and that the completion job does its real job. Runs against the Firebase
# emulators (see test/ops/run.sh). Nothing here touches the live project.
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
JOB="${HERE}/../../.github/scripts/finish-deletions.sh"
P="${PROJECT:-demo-scorecard}"
FS="${FS_BASE:-http://127.0.0.1:8080/v1}"
AUTHROOT="${AUTH_ROOT:-http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1}"
FS_ADMIN="${FS_ADMIN:-http://127.0.0.1:8080/emulator/v1}"
AUTH_ADMIN="${AUTH_ADMIN:-http://127.0.0.1:9099/emulator/v1}"
DB="projects/${P}/databases/(default)/documents"
H=(-H "Authorization: Bearer owner")

pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }

reset(){
  curl -g -sS --fail -X DELETE "${H[@]}" "${FS_ADMIN}/projects/${P}/databases/(default)/documents" >/dev/null
  curl -g -sS --fail -X DELETE "${H[@]}" "${AUTH_ADMIN}/projects/${P}/accounts" >/dev/null
}
new_user(){ curl -g -sS --fail -H 'Content-Type: application/json' -d '{"returnSecureToken":true}' \
  "${AUTHROOT}/accounts:signUp?key=fake-api-key" | jq -r .localId; }
user_exists(){ jq -n --arg u "$1" '{localId:[$u]}' | curl -g -sS --fail "${H[@]}" -H 'Content-Type: application/json' \
  --data-binary @- "${AUTHROOT}/projects/${P}/accounts:lookup" | jq -e '(.users // []) | length > 0' >/dev/null; }
user_gone(){ ! user_exists "$1"; }

# put PATH JSON-OBJECT-OF-STRINGS   (null values become nullValue)
put(){ local fields
  fields="$(jq -c 'with_entries(.value = (if .value == null then {nullValue:null} else {stringValue:.value} end))' <<<"$2")"
  jq -nc --arg n "${DB}/$1" --argjson f "${fields}" '{writes:[{update:{name:$n,fields:$f}}]}' \
  | curl -g -sS --fail "${H[@]}" -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit" >/dev/null; }
exists(){ [[ "$(curl -g -sS -o /dev/null -w '%{http_code}' "${H[@]}" "${FS}/${DB}/$1")" == 200 ]]; }
missing(){ ! exists "$1"; }
field(){ curl -g -sS --fail "${H[@]}" "${FS}/${DB}/$1" | jq -r --arg f "$2" '.fields[$f] | if has("nullValue") then "null" else .stringValue end'; }
field_is(){ [[ "$(field "$1" "$2")" == "$3" ]]; }
# Everything stored in a group, with update times, sorted — to prove nothing changed.
snapshot(){ local g="$1" c
  for c in "" members invites roster rounds; do
    curl -g -sS --fail "${H[@]}" "${FS}/${DB}/associations${c:+/${g}/${c}}?pageSize=300" \
      | jq -c --arg g "$g" '.documents[]? | select(.name|test("/associations/"+$g+"($|/)")) | [.name,.updateTime,.fields]'
  done | sort; }
run_job(){ ACCESS_TOKEN=owner PROJECT="${P}" FS_BASE="${FS}" AUTH_BASE="${1:-${AUTHROOT}}" \
  MIN_AGE_SECONDS="${2:-0}" bash "${JOB}"; }

seed(){
  A="$(new_user)"; B="$(new_user)"; O="$(new_user)"
  put "associations/G1" "{\"name\":\"Group one\",\"ownerUid\":\"${O}\"}"
  put "associations/G2" "{\"name\":\"Group two\",\"ownerUid\":\"${O}\"}"
  put "associations/G1/members/${O}" "{\"uid\":\"${O}\",\"role\":\"owner\"}"
  put "associations/G1/members/${A}" "{\"uid\":\"${A}\",\"role\":\"member\",\"golferId\":\"gA\"}"
  put "associations/G1/members/${B}" "{\"uid\":\"${B}\",\"role\":\"member\",\"golferId\":\"gB\"}"
  put "associations/G2/members/${O}" "{\"uid\":\"${O}\",\"role\":\"owner\"}"
  put "associations/G2/members/${B}" "{\"uid\":\"${B}\",\"role\":\"member\",\"golferId\":\"gB\"}"
  put "associations/G1/invites/gA" "{\"acceptedBy\":\"${A}\",\"role\":\"member\"}"
  put "associations/G1/invites/gB" "{\"acceptedBy\":\"${B}\",\"role\":\"member\"}"
  put "associations/G2/invites/gB" "{\"acceptedBy\":\"${B}\",\"role\":\"member\"}"
  put "associations/G1/roster/gA" '{"golferId":"gA"}'
  put "associations/G1/roster/gB" '{"golferId":"gB"}'
  put "associations/G2/roster/gB" '{"golferId":"gB"}'
  put "associations/G1/rounds/r1" "{\"golferId\":\"gA\",\"enteredBy\":\"${A}\"}"
  put "golfers/gA" "{\"name\":\"Alice Golfer\",\"linkedUid\":\"${A}\"}"
  put "golfers/gB" "{\"name\":\"Bob Golfer\",\"linkedUid\":\"${B}\"}"
  put "userGroups/${A}/groups/G1" '{"assocId":"G1"}'
  put "userGroups/${B}/groups/G1" '{"assocId":"G1"}'
  put "userGroups/${B}/groups/G2" '{"assocId":"G2"}'
}

echo "== Scenario 1: A's forged request names B's group, golfer and invitations"
reset; seed
put "accountDeletions/${A}" '{"stage":"requested","groups":"G1,G2","golferIds":"gA,gB","note":"forged lists"}'
SNAP_G2="$(snapshot G2)"
if run_job; then ok "job finished"; else bad "job finished"; fi
check "SEC1 B's invitation claim in G1 untouched"      field_is "associations/G1/invites/gB" acceptedBy "${B}"
check "SEC1 B's invitation claim in G2 untouched"      field_is "associations/G2/invites/gB" acceptedBy "${B}"
check "SEC2 B's golfer still linked to B"               field_is "golfers/gB" linkedUid "${B}"
check "SEC3 unrelated group G2 completely unchanged"   test "$(snapshot G2)" == "${SNAP_G2}"
check "SEC3 B's membership in G1 untouched"            exists "associations/G1/members/${B}"
check "SEC3 owner's membership in G1 untouched"        exists "associations/G1/members/${O}"
check "SEC3 B's group list untouched"                  exists "userGroups/${B}/groups/G2"
check "A's own membership removed"                     missing "associations/G1/members/${A}"
check "A's own invitation claim removed"               missing "associations/G1/invites/gA"
check "A's own group list removed"                     missing "userGroups/${A}/groups/G1"
check "A's golfer unlinked"                            field_is "golfers/gA" linkedUid null
check "D1 A's golfer name kept"                        field_is "golfers/gA" name "Alice Golfer"
check "D1 A's round kept"                              exists "associations/G1/rounds/r1"
check "A's sign-in deleted"                            user_gone "${A}"
check "B's sign-in untouched"                          user_exists "${B}"
check "A's request removed after confirmation"         missing "accountDeletions/${A}"

echo "== Scenario 2 (SEC4): the owner of two groups requests deletion"
reset; seed
put "accountDeletions/${O}" '{"stage":"requested","groups":"G1,G2"}'
SNAP_G1="$(snapshot G1)"; SNAP_G2="$(snapshot G2)"
if run_job; then ok "job finished (a blocked request is not a failure)"; else bad "job finished (a blocked request is not a failure)"; fi
check "SEC4 group G1 completely unchanged"             test "$(snapshot G1)" == "${SNAP_G1}"
check "SEC4 group G2 completely unchanged"             test "$(snapshot G2)" == "${SNAP_G2}"
check "SEC4 owner's sign-in NOT deleted"               user_exists "${O}"
check "SEC4 request kept and marked blocked"           field_is "accountDeletions/${O}" jobStatus "blocked-owns-groups"

echo "== Scenario 3 (SEC5): Firebase does not confirm the sign-in is gone"
reset; seed
put "accountDeletions/${A}" '{"stage":"requested"}'
python3 "${HERE}/stuck-auth.py" 9199 & STUCK=$!
sleep 1
if run_job "http://127.0.0.1:9199/v1"; then bad "job reports a problem"; else ok "job reports a problem"; fi
kill "${STUCK}" 2>/dev/null || true
check "SEC5 request kept until the sign-in is confirmed gone" exists "accountDeletions/${A}"
check "SEC5 request marked not confirmed"              field_is "accountDeletions/${A}" jobStatus "auth-not-confirmed"

echo "== Scenario 4: a request younger than one hour is left for the app"
reset; seed
put "accountDeletions/${A}" '{"stage":"requested"}'
if run_job "" 3600; then ok "job finished"; else bad "job finished"; fi
check "young request untouched"                        exists "accountDeletions/${A}"
check "young request: membership untouched"            exists "associations/G1/members/${A}"
check "young request: sign-in untouched"               user_exists "${A}"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
