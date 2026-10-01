#!/usr/bin/env bash
# CK1–CK9: beta.4 (Oct 1, approved by Willy): the cockpit (the group
# creator reads every group, memberships and rounds; last seen on your own
# membership), the applications switch, block lists, account emails, and an
# Auto approval made by the applicant, with every Level 1 check enforced.
# Against the real firestore.rules in the Firebase emulator. Nothing here
# touches the live project.
set -Eeuo pipefail

P="${PROJECT:-demo-scorecard}"
FS="${FS_BASE:-http://127.0.0.1:8080/v1}"
AUTHROOT="${AUTH_ROOT:-http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1}"
FS_ADMIN="${FS_ADMIN:-http://127.0.0.1:8080/emulator/v1}"
AUTH_ADMIN="${AUTH_ADMIN:-http://127.0.0.1:9099/emulator/v1}"
DB="projects/${P}/databases/(default)/documents"
ADMIN=(-H "Authorization: Bearer owner")

pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }

reset(){
  curl -g -sS --fail -X DELETE "${ADMIN[@]}" "${FS_ADMIN}/projects/${P}/databases/(default)/documents" >/dev/null
  curl -g -sS --fail -X DELETE "${ADMIN[@]}" "${AUTH_ADMIN}/projects/${P}/accounts" >/dev/null
}
# Phase B: every account has an email and a password (anonymous sign-ins are refused).
new_user(){ jq -nc --arg e "u$(date +%s%N)${RANDOM}@example.com" '{email:$e,password:"test-password-1",returnSecureToken:true}' \
  | curl -g -sS --fail -H 'Content-Type: application/json' --data-binary @- \
  "${AUTHROOT}/accounts:signUp?key=fake-api-key" | jq -r '"\(.localId) \(.idToken)"'; }
# An old-style guest: anonymous, no email → "uid token"
anon_user(){ curl -g -sS --fail -H 'Content-Type: application/json' -d '{"returnSecureToken":true}' \
  "${AUTHROOT}/accounts:signUp?key=fake-api-key" | jq -r '"\(.localId) \(.idToken)"'; }
# link_email TOKEN EMAIL → new token for the SAME account, now with an email and password
link_email(){ jq -nc --arg t "$1" --arg e "$2" '{idToken:$t,email:$e,password:"test-password-1",returnSecureToken:true}' \
  | curl -g -sS --fail -H 'Content-Type: application/json' --data-binary @- \
  "${AUTHROOT}/accounts:update?key=fake-api-key" | jq -r .idToken; }

# Values: strings, null, or JSON arrays of strings.
fields(){ jq -c 'with_entries(.value = (
  if .value == null then {nullValue:null}
  elif (.value|type) == "array" then {arrayValue:{values:(.value|map({stringValue:.}))}}
  elif (.value|type) == "number" then (if (.value|floor) == .value then {integerValue:(.value|tostring)} else {doubleValue:.value} end)
  elif (.value|type) == "boolean" then {booleanValue:.value}
  else {stringValue:.value} end))' <<<"$1"; }
put(){ jq -nc --arg n "${DB}/$1" --argjson f "$(fields "$2")" '{writes:[{update:{name:$n,fields:$f}}]}' \
  | curl -g -sS --fail "${ADMIN[@]}" -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit" >/dev/null; }

# get_as TOKEN PATH -> HTTP status
get_as(){ curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "${FS}/${DB}/$2"; }
# query_as TOKEN PARENT(relative, '' for root) COLLECTION ALLDESC(true/false) [FIELD OP VALUE] -> HTTP status
query_as(){ local tok="$1" parent="$2" coll="$3" all="$4" field="${5:-}" op="${6:-}" val="${7:-}" q url
  if [[ -n "${field}" ]]; then
    q="$(jq -nc --arg c "${coll}" --argjson a "${all}" --arg f "${field}" --arg o "${op}" --arg v "${val}" \
      '{structuredQuery:{from:[{collectionId:$c,allDescendants:$a}],where:{fieldFilter:{field:{fieldPath:$f},op:$o,value:{stringValue:$v}}}}}')"
  else
    q="$(jq -nc --arg c "${coll}" --argjson a "${all}" '{structuredQuery:{from:[{collectionId:$c,allDescendants:$a}]}}')"
  fi
  url="${FS}/${DB}${parent:+/${parent}}:runQuery"
  curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${tok}" -H 'Content-Type: application/json' \
    --data-binary "${q}" "${url}"; }
# write_as TOKEN PATH FIELDS-JSON -> HTTP status (merge on the given fields)
write_as(){ jq -nc --arg n "${DB}/$2" --argjson f "$(fields "$3")" '{writes:[{update:{name:$n,fields:$f},updateMask:{fieldPaths:($f|keys)}}]}' \
  | curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit"; }
delete_as(){ jq -nc --arg n "${DB}/$2" '{writes:[{delete:$n}]}' \
  | curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit"; }

expect(){ local want="$1" label="$2"; shift 2; local got; got="$("$@")"
  [[ "${got}" == "${want}" ]] && ok "${label}" || bad "${label} (HTTP ${got}, expected ${want})"; }
allowed(){ expect 200 "$@"; }
refused(){ expect 403 "$@"; }

# auth_hdr TOKEN → curl header args; "-" means signed out (no header at all)
auth_args(){ if [[ "$1" == "-" ]]; then printf '%s\n' "-H" "X-Signed-Out: 1"; else printf '%s\n' "-H" "Authorization: Bearer $1"; fi; }
# ts_write TOKEN PATH FIELDS-JSON [TIMESTAMP-FIELD] → HTTP status. A plain set
# (whole document), with the timestamp field set to the server's time, as the
# SDK's serverTimestamp() does.
ts_write(){ local tok="$1" path="$2" f="$3" ts="${4:-}" body; mapfile -t H < <(auth_args "${tok}")
  body="$(jq -nc --arg n "${DB}/${path}" --argjson f "$(fields "${f}")" --arg ts "${ts}" \
    '{writes:[({update:{name:$n,fields:$f}} + (if $ts == "" then {} else {updateTransforms:[{fieldPath:$ts,setToServerValue:"REQUEST_TIME"}]} end))]}')"
  curl -g -sS -o /dev/null -w '%{http_code}' "${H[@]}" -H 'Content-Type: application/json' --data-binary "${body}" "${FS}/${DB}:commit"; }
# ts_update TOKEN PATH FIELDS-JSON TIMESTAMP-FIELD → HTTP status. Changes only the
# given fields, plus the timestamp field set to the server's time.
ts_update(){ local tok="$1" path="$2" f="$3" ts="$4" body; mapfile -t H < <(auth_args "${tok}")
  body="$(jq -nc --arg n "${DB}/${path}" --argjson f "$(fields "${f}")" --arg ts "${ts}" \
    '{writes:[{update:{name:$n,fields:$f},updateMask:{fieldPaths:($f|keys)},updateTransforms:[{fieldPath:$ts,setToServerValue:"REQUEST_TIME"}],currentDocument:{exists:true}}]}')"
  curl -g -sS -o /dev/null -w '%{http_code}' "${H[@]}" -H 'Content-Type: application/json' --data-binary "${body}" "${FS}/${DB}:commit"; }
get_any(){ mapfile -t H < <(auth_args "$1"); curl -g -sS -o /dev/null -w '%{http_code}' "${H[@]}" "${FS}/${DB}/$2"; }
# token_claim TOKEN CLAIM → the claim's value from the ID token
token_claim(){ python3 - "$1" "$2" <<'PY'
import sys, json, base64
p = sys.argv[1].split(".")[1]; p += "=" * (-len(p) % 4)
print(json.loads(base64.urlsafe_b64decode(p)).get(sys.argv[2]))
PY
}
# user_with EMAIL → "uid token" for a new email account (unconfirmed email)
user_with(){ jq -nc --arg e "$1" '{email:$e,password:"test-password-1",returnSecureToken:true}' \
  | curl -g -sS --fail -H 'Content-Type: application/json' --data-binary @- \
  "${AUTHROOT}/accounts:signUp?key=fake-api-key" | jq -r '"\(.localId) \(.idToken)"'; }
# The approval flow's "set your password" email, used as Firebase sends it:
# request the reset email, take its link code, set the password, sign in.
# Prints the new ID token.
reset_and_sign_in(){ local email="$1" code
  jq -nc --arg e "${email}" '{requestType:"PASSWORD_RESET",email:$e}' | curl -g -sS --fail -H 'Content-Type: application/json' \
    --data-binary @- "${AUTHROOT}/accounts:sendOobCode?key=fake-api-key" >/dev/null
  code="$(curl -g -sS --fail "${AUTH_ADMIN}/projects/${P}/oobCodes" \
    | jq -r --arg e "${email}" '[.oobCodes[] | select(.email == $e and .requestType == "PASSWORD_RESET")] | last | .oobCode')"
  jq -nc --arg c "${code}" '{oobCode:$c,newPassword:"chosen-password-2"}' | curl -g -sS --fail -H 'Content-Type: application/json' \
    --data-binary @- "${AUTHROOT}/accounts:resetPassword?key=fake-api-key" >/dev/null
  jq -nc --arg e "${email}" '{email:$e,password:"chosen-password-2",returnSecureToken:true}' | curl -g -sS --fail -H 'Content-Type: application/json' \
    --data-binary @- "${AUTHROOT}/accounts:signInWithPassword?key=fake-api-key" | jq -r .idToken; }

# commit_as TOKEN WRITES-JSON → HTTP status (one batch)
commit_as(){ jq -nc --argjson w "$2" '{writes:$w}' | curl -g -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $1" -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit"; }
# Writes for an automatic approval: golfer, name claim, the day's counter, the approval.
# auto_writes EMAILKEY GOLFERID NAME NAMEKEY UID COUNT [COUNTER-EXISTS true|false]
auto_writes(){ local day; day="$(( $(date -u +%s) / 86400 ))"
  jq -nc --arg db "${DB}" --arg ek "$1" --arg g "$2" --arg n "$3" --arg nk "$4" --arg u "$5" --arg c "$6" --arg day "${day}" --arg cx "${7:-false}" '
  [ {update:{name:"\($db)/golfers/\($g)",fields:{name:{stringValue:$n},nameKey:{stringValue:$nk},linkedUid:{stringValue:$u},groups:{arrayValue:{values:[{stringValue:"PUBLIC"}]}}}}},
    {update:{name:"\($db)/golferNames/\($nk)",fields:{golferId:{stringValue:$g},name:{stringValue:$n}}}},
    ({update:{name:"\($db)/autoApprovals/\($day)",fields:{count:{integerValue:$c},lastBy:{stringValue:$u}}},
      updateTransforms:[{fieldPath:"lastAt",setToServerValue:"REQUEST_TIME"}]} + (if $cx == "true" then {currentDocument:{exists:true}} else {} end)),
    {update:{name:"\($db)/publicApprovals/\($ek)",fields:{golferId:{stringValue:$g},displayName:{stringValue:$n},nameKey:{stringValue:$nk},approvedBy:{stringValue:$u},auto:{booleanValue:true}}},
     updateTransforms:[{fieldPath:"approvedAt",setToServerValue:"REQUEST_TIME"}]} ]'; }
# applicant EMAIL NAME → "uid token" for a confirmed account, with a pending application
applicant(){ local email="$1" name="$2" u t
  put "publicApplications/${email}" "$(jq -nc --arg n "${name}" --arg e "${email}" '{fullName:$n,email:$e,status:"pending"}')"
  read -r u _ <<<"$(user_with "${email}")"
  t="$(reset_and_sign_in "${email}")"
  echo "${u} ${t}"; }
DAY="$(( $(date -u +%s) / 86400 ))"

reset
read -r W  TW  <<<"$(new_user)"   # Willy: the group creator
read -r A  TA  <<<"$(new_user)"   # an ordinary owner of group G2
read -r R  TR  <<<"$(new_user)"   # a reviewer (admin of PUBLIC)
read -r O  TO  <<<"$(new_user)"   # an ordinary account
put "groupCreators/${W}" '{"note":"set by the setup script"}'
put "associations/PUBLIC" "{\"name\":\"PUBLIC\",\"ownerUid\":\"${W}\"}"
put "associations/PUBLIC/members/${W}" "{\"uid\":\"${W}\",\"role\":\"owner\"}"
put "associations/PUBLIC/members/${R}" "{\"uid\":\"${R}\",\"role\":\"admin\"}"
put "associations/G2" "{\"name\":\"Other Group\",\"ownerUid\":\"${A}\",\"joinCode\":\"OTHER1\"}"
put "associations/G2/members/${A}" "{\"uid\":\"${A}\",\"role\":\"owner\"}"
put "associations/G2/members/${O}" "{\"uid\":\"${O}\",\"role\":\"member\"}"
put "associations/G2/rounds/r1" '{"id":"r1","golferId":"gx","assocId":"G2","date":"2026-09-20"}'
put "golferNames/taken-name" '{"golferId":"gTaken","name":"Taken Name"}'

echo "== CK1 the group creator reads every group, membership and round (read only)"
allowed "CK1 Willy reads a group he is not in"                                get_as "${TW}" "associations/G2"
allowed "CK1 Willy lists every group"                                         query_as "${TW}" "" associations false
allowed "CK1 Willy lists every membership"                                    query_as "${TW}" "" members true
allowed "CK1 Willy lists every round"                                         query_as "${TW}" "" rounds true
refused "CK1 an ordinary account cannot list every group"                     query_as "${TO}" "" associations false
refused "CK1 an ordinary account cannot list every membership"                query_as "${TO}" "" members true
refused "CK1 an ordinary account cannot list every round"                     query_as "${TO}" "" rounds true
refused "CK1 Willy still cannot change a group he does not own"               write_as "${TW}" "associations/G2" '{"name":"Renamed"}'

echo "== CK2 last seen: your own membership, that field only, the server's time"
allowed "CK2 a member stamps their own last seen"                             ts_update "${TO}" "associations/G2/members/${O}" '{}' lastSeenAt
refused "CK2 nobody stamps another member's last seen"                        ts_update "${TO}" "associations/G2/members/${A}" '{}' lastSeenAt
refused "CK2 last seen must be the server's time"                             write_as "${TO}" "associations/G2/members/${O}" '{"lastSeenAt":"2030-01-01"}'
refused "CK2 nothing else changes with it"                                    ts_update "${TO}" "associations/G2/members/${O}" '{"role":"admin"}' lastSeenAt

echo "== CK3 the applications switch"
refused "CK3 an ordinary account cannot change it"                            ts_write "${TO}" "settings/publicApplications" "{\"mode\":\"auto\",\"dailyLimit\":20,\"updatedBy\":\"${O}\"}" updatedAt
allowed "CK3 a reviewer turns it to Auto"                                     ts_write "${TR}" "settings/publicApplications" "{\"mode\":\"auto\",\"dailyLimit\":20,\"updatedBy\":\"${R}\"}" updatedAt
allowed "CK3 Willy turns it back to Manual"                                   ts_write "${TW}" "settings/publicApplications" "{\"mode\":\"manual\",\"dailyLimit\":20,\"updatedBy\":\"${W}\"}" updatedAt
allowed "CK3 anyone, signed out, reads the switch"                            get_any - "settings/publicApplications"
refused "CK3 only Manual or Auto"                                             ts_write "${TW}" "settings/publicApplications" "{\"mode\":\"always\",\"dailyLimit\":20,\"updatedBy\":\"${W}\"}" updatedAt
refused "CK3 the daily limit is 1 to 500"                                     ts_write "${TW}" "settings/publicApplications" "{\"mode\":\"auto\",\"dailyLimit\":0,\"updatedBy\":\"${W}\"}" updatedAt
refused "CK3 other settings documents are closed"                             get_any - "settings/other"

echo "== CK4 block lists: reviewers only"
allowed "CK4 a reviewer blocks a domain"                                      ts_write "${TR}" "blockedDomains/spam.test" "{\"addedBy\":\"${R}\"}" addedAt
allowed "CK4 a reviewer blocks a name"                                        ts_write "${TR}" "blockedNames/bad-name" "{\"addedBy\":\"${R}\"}" addedAt
refused "CK4 an ordinary account cannot add to it"                            ts_write "${TO}" "blockedEmails/x@example.com" "{\"addedBy\":\"${O}\"}" addedAt
refused "CK4 an ordinary account cannot read it"                              query_as "${TO}" "" blockedDomains false
allowed "CK4 a reviewer reads it"                                             query_as "${TR}" "" blockedDomains false

echo "== CK5 account emails"
EO="$(token_claim "${TO}" email)"
allowed "CK5 an account records its own email"                                ts_write "${TO}" "accountEmails/${EO}" '{}' at
refused "CK5 not somebody else's"                                             ts_write "${TO}" "accountEmails/someone@example.com" '{}' at
allowed "CK5 anyone, signed out, asks about one email"                        get_any - "accountEmails/${EO}"
refused "CK5 nobody can list them"                                            query_as "${TW}" "" accountEmails false
refused "CK5 an email with an account cannot apply"                           ts_write - "publicApplications/${EO}" "{\"fullName\":\"Has Account\",\"email\":\"${EO}\",\"status\":\"pending\"}" createdAt
allowed "CK5 an account removes its own email"                                delete_as "${TO}" "accountEmails/${EO}"

echo "== CK6 Auto: refused while the switch is on Manual"
read -r U1 T1 <<<"$(applicant "ann.auto@example.com" "Ann Auto")"
refused "CK6 Manual: the applicant cannot approve themselves"                 commit_as "${T1}" "$(auto_writes ann.auto@example.com gAnn 'Ann Auto' ann-auto "${U1}" 1)"
put "settings/publicApplications" '{"mode":"auto","dailyLimit":2}'

echo "== CK7 Auto: every check enforced"
read -r U2 T2 <<<"$(applicant "ted.taken@example.com" "Taken Name")"
refused "CK7 a name already taken is refused"                                 commit_as "${T2}" "$(auto_writes ted.taken@example.com gTed 'Taken Name' taken-name "${U2}" 1)"
read -r U3 T3 <<<"$(applicant "sam.odd@example.com" "sam")"
refused "CK7 a one-word name is refused"                                      commit_as "${T3}" "$(auto_writes sam.odd@example.com gSam 'sam' sam "${U3}" 1)"
read -r U4 T4 <<<"$(applicant "bo.blocked@spam.test" "Bo Blocked")"
refused "CK7 a blocked domain is refused"                                     commit_as "${T4}" "$(auto_writes bo.blocked@spam.test gBo 'Bo Blocked' bo-blocked "${U4}" 1)"
read -r U5 T5 <<<"$(applicant "bad.person@example.com" "Bad Name")"
refused "CK7 a blocked name is refused"                                       commit_as "${T5}" "$(auto_writes bad.person@example.com gBad 'Bad Name' bad-name "${U5}" 1)"
read -r U6 _ <<<"$(user_with "nina.new@example.com")"
put "publicApplications/nina.new@example.com" '{"fullName":"Nina New","email":"nina.new@example.com","status":"pending"}'
T6U="$(jq -nc '{email:"nina.new@example.com",password:"test-password-1",returnSecureToken:true}' | curl -g -sS -H 'Content-Type: application/json' --data-binary @- "${AUTHROOT}/accounts:signInWithPassword?key=fake-api-key" | jq -r .idToken)"
refused "CK7 an unconfirmed email is refused"                                 commit_as "${T6U}" "$(auto_writes nina.new@example.com gNina 'Nina New' nina-new "${U6}" 1)"
refused "CK7 a different name from the application is refused"               commit_as "${T1}" "$(auto_writes ann.auto@example.com gAnn 'Ann Other' ann-other "${U1}" 1)"
refused "CK7 without the day's counter it is refused"                         commit_as "${T1}" "$(auto_writes ann.auto@example.com gAnn 'Ann Auto' ann-auto "${U1}" 1 | jq -c 'del(.[2])')"
refused "CK7 the golfer must be linked to the applicant"                      commit_as "${T1}" "$(auto_writes ann.auto@example.com gAnn 'Ann Auto' ann-auto "${O}" 1)"

echo "== CK8 Auto: a clean application is approved by the applicant, then joins"
allowed "CK8 Ann approves herself (all checks pass)"                          commit_as "${T1}" "$(auto_writes ann.auto@example.com gAnn 'Ann Auto' ann-auto "${U1}" 1)"
if [[ "$(curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${T1}" "${FS}/${DB}/publicApprovals/ann.auto@example.com")" != 200 ]]; then
  echo "      why: $(jq -nc --argjson w "$(auto_writes ann.auto@example.com gAnn 'Ann Auto' ann-auto "${U1}" 1)" '{writes:$w}' | curl -g -sS -H "Authorization: Bearer ${T1}" -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit" | tr -s ' \n' ' ' | cut -c1-900)"
fi
refused "CK8 the counter cannot move on its own"                              ts_update "${T1}" "autoApprovals/${DAY}" "{\"count\":2,\"lastBy\":\"${U1}\"}" lastAt
allowed "CK8 she puts her own golfer on the public roster"                    write_as "${T1}" "associations/PUBLIC/roster/gAnn" '{"golferId":"gAnn"}'
refused "CK8 not somebody else's golfer"                                      write_as "${T1}" "associations/PUBLIC/roster/gTaken" '{"golferId":"gTaken"}'
allowed "CK8 she joins the public group with that golfer"                     ts_write "${T1}" "associations/PUBLIC/members/${U1}" "{\"uid\":\"${U1}\",\"role\":\"member\",\"displayName\":\"Ann Auto\",\"golferId\":\"gAnn\"}" joinedAt
allowed "CK8 she marks her application approved"                              ts_update "${T1}" "publicApplications/ann.auto@example.com" '{"status":"approved","golferId":"gAnn","golferName":"Ann Auto","auto":true}' reviewedAt
refused "CK8 a second approval for her is refused"                            commit_as "${T1}" "$(auto_writes ann.auto@example.com gAnn2 'Ann Auto' ann-auto "${U1}" 2 true)"

echo "== CK9 Auto: the daily limit"
read -r U7 T7 <<<"$(applicant "lee.limit@example.com" "Lee Limit")"
allowed "CK9 the second of 2 today passes"                                    commit_as "${T7}" "$(auto_writes lee.limit@example.com gLee 'Lee Limit' lee-limit "${U7}" 2 true)"
read -r U8 T8 <<<"$(applicant "max.over@example.com" "Max Over")"
refused "CK9 the third of 2 today is refused"                                 commit_as "${T8}" "$(auto_writes max.over@example.com gMax 'Max Over' max-over "${U8}" 3 true)"
refused "CK9 ... and so is skipping the count"                                commit_as "${T8}" "$(auto_writes max.over@example.com gMax 'Max Over' max-over "${U8}" 2 true)"
refused "CK9 ... and so is leaving the counter out"                           commit_as "${T8}" "$(auto_writes max.over@example.com gMax 'Max Over' max-over "${U8}" 2 true | jq -c 'del(.[2])')"
put "settings/publicApplications" '{"mode":"auto","dailyLimit":20}'
refused "CK9 under the limit, leaving the counter out is still refused"       commit_as "${T8}" "$(auto_writes max.over@example.com gMax 'Max Over' max-over "${U8}" 3 true | jq -c 'del(.[2])')"
allowed "CK9 under the limit, with the counter, it passes"                    commit_as "${T8}" "$(auto_writes max.over@example.com gMax 'Max Over' max-over "${U8}" 3 true)"
refused "CK9 a reviewer cannot claim an application already approved by Auto" ts_update "${TR}" "publicApplications/max.over@example.com" "{\"status\":\"approving\",\"reviewedBy\":\"${R}\",\"golferId\":\"gX\",\"golferName\":\"Max Over\"}" approvingAt

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
