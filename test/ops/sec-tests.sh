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

# ---- The Public group (Willy, 13 Nov 2026): deleted for good there ----
# raw WRITES-JSON-ARRAY : one atomic commit, as the app's writeBatch does.
raw(){ jq -nc --argjson w "$1" '{writes:$w}' \
  | curl -g -sS --fail "${H[@]}" -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit" >/dev/null; }
del_auth(){ jq -n --arg u "$1" '{localId:$u}' | curl -g -sS --fail "${H[@]}" -H 'Content-Type: application/json' \
  --data-binary @- "${AUTHROOT}/projects/${P}/accounts:delete" >/dev/null; }
backups_of(){ curl -g -sS --fail "${H[@]}" "${FS}/${DB}/deletionBackups?pageSize=300" \
  | jq -r --arg g "$1" '[.documents[]? | select(.fields.golferId.stringValue == $g)] | length'; }
backup_rounds(){ curl -g -sS --fail "${H[@]}" "${FS}/${DB}/deletionBackups?pageSize=300" \
  | jq -r --arg g "$1" '[.documents[]? | select(.fields.golferId.stringValue == $g)][0].fields.rounds.arrayValue.values | length'; }
seed_public(){
  Pp="$(new_user)"; Q="$(new_user)"
  put "associations/PUBLIC" "{\"name\":\"Public\",\"ownerUid\":\"${O}\"}"
  put "associations/PUBLIC/members/${O}" "{\"uid\":\"${O}\",\"role\":\"owner\"}"
  put "associations/PUBLIC/members/${Q}" "{\"uid\":\"${Q}\",\"role\":\"member\",\"golferId\":\"gQ\"}"
  put "associations/PUBLIC/roster/gP" '{"golferId":"gP"}'
  put "associations/PUBLIC/directory/gP" '{"golferId":"gP","displayName":"Pat Public"}'
  put "associations/PUBLIC/rounds/pr1" "{\"golferId\":\"gP\",\"enteredBy\":\"${Pp}\"}"
  put "associations/PUBLIC/rounds/pr2" "{\"golferId\":\"gP\",\"enteredBy\":\"${Pp}\"}"
  put "golfers/gP" "{\"name\":\"Pat Public\",\"nameKey\":\"pat-public\",\"linkedUid\":\"${Pp}\"}"
  put "golferNames/pat-public" '{"golferId":"gP"}'
  put "associations/PUBLIC/roster/gZ" '{"golferId":"gZ"}'
  put "associations/PUBLIC/directory/gZ" '{"golferId":"gZ","displayName":"Zoe Bystander"}'
  put "associations/PUBLIC/rounds/pz1" '{"golferId":"gZ"}'
  put "golfers/gZ" '{"name":"Zoe Bystander","nameKey":"zoe-bystander","linkedUid":null}'
  put "golferNames/zoe-bystander" '{"golferId":"gZ"}'
  put "associations/PUBLIC/roster/gQ" '{"golferId":"gQ"}'
  put "associations/PUBLIC/directory/gQ" '{"golferId":"gQ","displayName":"Quinn Both"}'
  put "associations/PUBLIC/rounds/qr1" "{\"golferId\":\"gQ\",\"enteredBy\":\"${Q}\"}"
  put "associations/G1/roster/gQ" '{"golferId":"gQ"}'
  put "associations/G1/members/${Q}" "{\"uid\":\"${Q}\",\"role\":\"member\",\"golferId\":\"gQ\"}"
  put "associations/G1/rounds/qr2" "{\"golferId\":\"gQ\",\"enteredBy\":\"${Q}\"}"
  put "golfers/gQ" "{\"name\":\"Quinn Both\",\"nameKey\":\"quinn-both\",\"linkedUid\":\"${Q}\"}"
  put "golferNames/quinn-both" '{"golferId":"gQ"}'
}

echo "== Scenario 5 (PUB-DEL1): Pat plays only in the Public group; the app finished its part"
reset; seed; seed_public
put "accountDeletions/${Pp}" '{"stage":"requested"}'
# The app's last commit: unlink its golfer AND mark the request, together.
# The request also names Zoe's golfer: a hint the job must not trust.
raw "$(jq -nc --arg g "${DB}/golfers/gP" --arg r "${DB}/accountDeletions/${Pp}" '[
  {update:{name:$g,fields:{linkedUid:{nullValue:null}}},updateMask:{fieldPaths:["linkedUid"]}},
  {update:{name:$r,fields:{stage:{stringValue:"auth-deleting"},
     golferIds:{arrayValue:{values:[{stringValue:"gP"},{stringValue:"gZ"}]}}}},updateMask:{fieldPaths:["stage","golferIds"]}}]')"
del_auth "${Pp}"
if run_job; then ok "job finished"; else bad "job finished"; fi
check "PUB-DEL1 Pat's golfer deleted for good"          missing "golfers/gP"
check "PUB-DEL1 Pat off the Public list"                missing "associations/PUBLIC/roster/gP"
check "PUB-DEL1 Pat's name gone from the ranking"       missing "associations/PUBLIC/directory/gP"
check "PUB-DEL1 Pat's Public rounds deleted"            bash -c "! curl -g -sf -o /dev/null -H 'Authorization: Bearer owner' '${FS}/${DB}/associations/PUBLIC/rounds/pr1' && ! curl -g -sf -o /dev/null -H 'Authorization: Bearer owner' '${FS}/${DB}/associations/PUBLIC/rounds/pr2'"
check "PUB-DEL1 Pat's name free again"                  missing "golferNames/pat-public"
check "PUB-DEL1 one backup, with both rounds"           test "$(backups_of gP)/$(backup_rounds gP)" == "1/2"
check "PUB-DEL1 Zoe (named in the request) untouched"   exists "golfers/gZ"
check "PUB-DEL1 Zoe still on the Public list"           exists "associations/PUBLIC/roster/gZ"
check "PUB-DEL1 Zoe's round untouched"                  exists "associations/PUBLIC/rounds/pz1"
check "PUB-DEL1 Zoe's name claim untouched"             exists "golferNames/zoe-bystander"
check "PUB-DEL1 no backup of Zoe"                       test "$(backups_of gZ)" == "0"
check "PUB-DEL1 request removed"                        missing "accountDeletions/${Pp}"

echo "== Scenario 5b (PUB-RES1): rgf.txt brings Pat back, exactly as before"
FAKE="$(mktemp -d)"
cat > "${FAKE}/gcloud" <<'G'
#!/usr/bin/env bash
case "$*" in
  "config get-value project") echo scorecard-f41b8 ;;
  "auth print-access-token") echo owner ;;
  *) exit 0 ;;
esac
G
chmod +x "${FAKE}/gcloud"
if printf 'Pat Public\nyes\n' | PATH="${FAKE}:${PATH}" RGF_FS="${FS}" RGF_DB_PROJECT="${P}" bash "${HERE}/rgf.txt" > /tmp/rgf.out 2>&1; then ok "rgf.txt finished"; else bad "rgf.txt finished: $(tail -5 /tmp/rgf.out)"; fi
check "PUB-RES1 Pat's golfer back"                      field_is "golfers/gP" name "Pat Public"
check "PUB-RES1 Pat back on the Public list"            exists "associations/PUBLIC/roster/gP"
check "PUB-RES1 Pat back in the ranking"                exists "associations/PUBLIC/directory/gP"
check "PUB-RES1 both rounds back"                       bash -c "curl -g -sf -o /dev/null -H 'Authorization: Bearer owner' '${FS}/${DB}/associations/PUBLIC/rounds/pr1' && curl -g -sf -o /dev/null -H 'Authorization: Bearer owner' '${FS}/${DB}/associations/PUBLIC/rounds/pr2'"
check "PUB-RES1 Pat's name taken again"                 exists "golferNames/pat-public"
check "PUB-RES1 backup removed"                         test "$(backups_of gP)" == "0"
check "PUB-RES1 says RESTORED"                          grep -q "RESTORED: Pat Public" /tmp/rgf.out

echo "== Scenario 6 (PUB-DEL2): Quinn plays in the Public group AND a club; the app stopped early"
reset; seed; seed_public
put "accountDeletions/${Q}" '{"stage":"requested"}'
if run_job; then ok "job finished"; else bad "job finished"; fi
check "PUB-DEL2 Quinn's golfer kept"                    field_is "golfers/gQ" name "Quinn Both"
check "PUB-DEL2 Quinn's golfer unlinked"                field_is "golfers/gQ" linkedUid null
check "PUB-DEL2 Quinn off the Public list"              missing "associations/PUBLIC/roster/gQ"
check "PUB-DEL2 Quinn gone from the Public ranking"     missing "associations/PUBLIC/directory/gQ"
check "PUB-DEL2 Quinn's Public round kept"              exists "associations/PUBLIC/rounds/qr1"
check "PUB-DEL2 Quinn's club round kept"                exists "associations/G1/rounds/qr2"
check "PUB-DEL2 Quinn still on the club's list"         exists "associations/G1/roster/gQ"
check "PUB-DEL2 Quinn's name claim kept"                exists "golferNames/quinn-both"
check "PUB-DEL2 no backup needed"                       test "$(backups_of gQ)" == "0"
check "PUB-DEL2 Pat (not deleting) untouched"           field_is "golfers/gP" linkedUid "${Pp}"
check "PUB-DEL2 Pat still on the Public list"           exists "associations/PUBLIC/roster/gP"

echo "== Scenario 7 (PUB-DEL3): a request marked auth-deleting on its own proves nothing"
reset; seed; seed_public
put "accountDeletions/${A}" '{"stage":"requested"}'
raw "$(jq -nc --arg r "${DB}/accountDeletions/${A}" '[{update:{name:$r,fields:{stage:{stringValue:"auth-deleting"},
     golferIds:{arrayValue:{values:[{stringValue:"gZ"},{stringValue:"gP"}]}}}},updateMask:{fieldPaths:["stage","golferIds"]}}]')"
put "golfers/gZ" '{"name":"Zoe Bystander","nameKey":"zoe-bystander","linkedUid":null}'
if run_job; then ok "job finished"; else bad "job finished"; fi
check "PUB-DEL3 Zoe untouched"                          exists "golfers/gZ"
check "PUB-DEL3 Zoe still on the Public list"           exists "associations/PUBLIC/roster/gZ"
check "PUB-DEL3 Pat untouched"                          field_is "golfers/gP" linkedUid "${Pp}"

echo "== Scenario 8 (PUB-DEL4): backups older than 30 days are removed; newer ones kept"
reset; seed
raw "$(jq -nc --arg o "${DB}/deletionBackups/old" --arg n "${DB}/deletionBackups/new" '[
  {update:{name:$o,fields:{golferId:{stringValue:"gOld"},expiresAt:{timestampValue:"2020-01-01T00:00:00Z"}}}},
  {update:{name:$n,fields:{golferId:{stringValue:"gNew"},expiresAt:{timestampValue:"2099-01-01T00:00:00Z"}}}}]')"
if run_job; then ok "job finished"; else bad "job finished"; fi
check "PUB-DEL4 expired backup removed"                 missing "deletionBackups/old"
check "PUB-DEL4 recent backup kept"                     exists "deletionBackups/new"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
