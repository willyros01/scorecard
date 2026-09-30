#!/usr/bin/env bash
# PUB1–PUB8: Version 2.0 Phase C, the PUBLIC group (onboarding design Rev 2,
# R1–R3, R11, R12): applications made without signing in, approvals read by
# the confirmed email, joining, member-list privacy, reports and blocks.
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
  elif (.value|type) == "number" then {doubleValue:.value}
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

reset
read -r W  TW  <<<"$(new_user)"   # owner of the PUBLIC group (Willy)
read -r R  TR  <<<"$(new_user)"   # a reviewer: admin of PUBLIC
read -r M  TM  <<<"$(new_user)"   # a regular member of PUBLIC, golfer gM
read -r X  TX  <<<"$(new_user)"   # an outsider with an account, in no group
read -r O  TO  <<<"$(new_user)"   # owner of the private group G1
read -r E  TE  <<<"$(new_user)"   # regular member of G1
put "associations/PUBLIC" "{\"name\":\"PUBLIC\",\"ownerUid\":\"${W}\",\"joinCode\":\"PUB123\"}"
put "associations/PUBLIC/members/${W}" "{\"uid\":\"${W}\",\"role\":\"owner\"}"
put "associations/PUBLIC/members/${R}" "{\"uid\":\"${R}\",\"role\":\"admin\"}"
put "associations/PUBLIC/members/${M}" "{\"uid\":\"${M}\",\"role\":\"member\",\"golferId\":\"gM\"}"
put "associations/PUBLIC/roster/gM" '{"golferId":"gM"}'
put "associations/PUBLIC/directory/gM" '{"golferId":"gM","displayName":"Mia Member","handicapIndex":"10.0"}'
put "golfers/gM" "{\"name\":\"Mia Member\",\"linkedUid\":\"${M}\",\"groups\":[\"PUBLIC\"]}"
put "associations/G1" "{\"name\":\"Group one\",\"ownerUid\":\"${O}\",\"joinCode\":\"G1CODE\"}"
put "associations/G1/members/${O}" "{\"uid\":\"${O}\",\"role\":\"owner\"}"
put "associations/G1/members/${E}" "{\"uid\":\"${E}\",\"role\":\"member\",\"golferId\":\"gE\"}"

APP="pat.applicant@example.com"
echo "== PUB1 applications: made without signing in, one per email, never readable by the applicant"
allowed "PUB1 signed out, an application is accepted"                          ts_write - "publicApplications/${APP}" "{\"fullName\":\"Pat Applicant\",\"email\":\"${APP}\",\"status\":\"pending\"}" createdAt
refused "PUB1 a second application for the same email is refused"             ts_write - "publicApplications/${APP}" "{\"fullName\":\"Someone Else\",\"email\":\"${APP}\",\"status\":\"pending\"}" createdAt
refused "PUB1 an application already approved (status) is refused"            ts_write - "publicApplications/a2@example.com" '{"fullName":"Al Two","email":"a2@example.com","status":"approved"}' createdAt
refused "PUB1 an extra field (a password) is refused"                         ts_write - "publicApplications/a3@example.com" '{"fullName":"Al Three","email":"a3@example.com","status":"pending","password":"x"}' createdAt
refused "PUB1 an email that differs from the document key is refused"         ts_write - "publicApplications/a4@example.com" '{"fullName":"Al Four","email":"other@example.com","status":"pending"}' createdAt
refused "PUB1 an upper-case key is refused (keys are lower case)"             ts_write - "publicApplications/A5@example.com" '{"fullName":"Al Five","email":"A5@example.com","status":"pending"}' createdAt
refused "PUB1 something that is not an email is refused"                      ts_write - "publicApplications/not-an-email" '{"fullName":"Al Six","email":"not-an-email","status":"pending"}' createdAt
refused "PUB1 a name over 80 characters is refused"                           ts_write - "publicApplications/a7@example.com" "{\"fullName\":\"$(printf 'x%.0s' {1..81})\",\"email\":\"a7@example.com\",\"status\":\"pending\"}" createdAt
refused "PUB1 a time set by the device (not the server) is refused"          ts_write - "publicApplications/a8@example.com" '{"fullName":"Al Eight","email":"a8@example.com","status":"pending","createdAt":"2020-01-01"}'
allowed "PUB1 an application with a mixed-case email and lower-case key is accepted" ts_write - "publicApplications/mixed@example.com" '{"fullName":"Mo Mixed","email":"Mixed@Example.com","status":"pending"}' createdAt
refused "PUB1 signed out, an application cannot be read"                      get_any - "publicApplications/${APP}"
refused "PUB1 an outsider cannot read it"                                     get_as "${TX}" "publicApplications/${APP}"
refused "PUB1 a PUBLIC member cannot read it"                                 get_as "${TM}" "publicApplications/${APP}"
refused "PUB1 a PUBLIC member cannot list applications"                       query_as "${TM}" "" publicApplications false
allowed "PUB1 a reviewer reads it"                                            get_as "${TR}" "publicApplications/${APP}"
allowed "PUB1 a reviewer lists applications"                                  query_as "${TR}" "" publicApplications false
allowed "PUB1 the owner lists applications"                                   query_as "${TW}" "" publicApplications false
refused "PUB1 an outsider cannot approve it"                                  write_as "${TX}" "publicApplications/${APP}" "{\"status\":\"approved\",\"reviewedBy\":\"${X}\"}"
refused "PUB1 a reviewer cannot change the applicant's name"                  write_as "${TR}" "publicApplications/${APP}" "{\"fullName\":\"Changed\",\"status\":\"approved\",\"reviewedBy\":\"${R}\"}"
allowed "PUB1 a reviewer marks it approved"                                   write_as "${TR}" "publicApplications/${APP}" "{\"status\":\"approved\",\"reviewedBy\":\"${R}\",\"golferId\":\"gP\"}"
allowed "PUB1 a reviewer deletes a rejected application"                      delete_as "${TR}" "publicApplications/mixed@example.com"

echo "== PUB2 approval: the reviewer makes the account; the set-password email confirms it"
put "golfers/gP" '{"name":"Pat Applicant","linkedUid":null,"groups":["PUBLIC"]}'
refused "PUB2 a PUBLIC member cannot write an approval"                       ts_write "${TM}" "publicApprovals/${APP}" "{\"golferId\":\"gP\",\"displayName\":\"Pat Applicant\",\"approvedBy\":\"${M}\"}" approvedAt
refused "PUB2 a reviewer cannot sign an approval as somebody else"           ts_write "${TR}" "publicApprovals/${APP}" "{\"golferId\":\"gP\",\"displayName\":\"Pat Applicant\",\"approvedBy\":\"${W}\"}" approvedAt
allowed "PUB2 a reviewer writes the approval"                                 ts_write "${TR}" "publicApprovals/${APP}" "{\"golferId\":\"gP\",\"displayName\":\"Pat Applicant\",\"approvedBy\":\"${R}\"}" approvedAt
read -r PA TPA0 <<<"$(user_with "${APP}")"   # what the reviewer's app creates (random password)
[[ "$(token_claim "${TPA0}" email_verified)" != "True" ]] && ok "PUB2 the new account starts with an unconfirmed email" \
  || bad "PUB2 the new account starts with an unconfirmed email"
refused "PUB2 before the email is confirmed, the approval cannot be read"    get_as "${TPA0}" "publicApprovals/${APP}"
refused "PUB2 before the email is confirmed, joining PUBLIC is refused"      ts_write "${TPA0}" "associations/PUBLIC/members/${PA}" "{\"uid\":\"${PA}\",\"role\":\"member\",\"displayName\":\"Pat Applicant\",\"golferId\":\"gP\"}" joinedAt
TPA="$(reset_and_sign_in "${APP}")"
[[ "$(token_claim "${TPA}" email_verified)" == "True" ]] && ok "PUB2 setting the password from the email confirms the email (email_verified)" \
  || bad "PUB2 setting the password from the email confirms the email (email_verified is $(token_claim "${TPA}" email_verified))"
allowed "PUB2 the applicant reads their own approval"                         get_as "${TPA}" "publicApprovals/${APP}"
refused "PUB2 an outsider cannot read it"                                     get_as "${TX}" "publicApprovals/${APP}"
refused "PUB2 the applicant cannot join with another golfer"                  ts_write "${TPA}" "associations/PUBLIC/members/${PA}" "{\"uid\":\"${PA}\",\"role\":\"member\",\"displayName\":\"Pat Applicant\",\"golferId\":\"gM\"}" joinedAt
refused "PUB2 the applicant cannot join as an admin"                          ts_write "${TPA}" "associations/PUBLIC/members/${PA}" "{\"uid\":\"${PA}\",\"role\":\"admin\",\"displayName\":\"Pat Applicant\",\"golferId\":\"gP\"}" joinedAt
refused "PUB2 the applicant cannot remove their approval before joining"      delete_as "${TPA}" "publicApprovals/${APP}"
allowed "PUB2 the applicant joins PUBLIC as the approved golfer"              ts_write "${TPA}" "associations/PUBLIC/members/${PA}" "{\"uid\":\"${PA}\",\"role\":\"member\",\"displayName\":\"Pat Applicant\",\"golferId\":\"gP\"}" joinedAt
allowed "PUB2 the applicant claims the approved golfer"                       write_as "${TPA}" "golfers/gP" "{\"linkedUid\":\"${PA}\"}"
allowed "PUB2 the applicant adds PUBLIC to their own group list"              write_as "${TPA}" "userGroups/${PA}/groups/PUBLIC" '{"assocId":"PUBLIC","name":"PUBLIC"}'
allowed "PUB2 the applicant removes the approval once joined"                 delete_as "${TPA}" "publicApprovals/${APP}"

echo "== PUB3 the PUBLIC group cannot be entered any other way"
refused "PUB3 an outsider cannot join PUBLIC with its code"                   write_as "${TX}" "associations/PUBLIC/members/${X}" "{\"uid\":\"${X}\",\"role\":\"member\",\"joinCode\":\"PUB123\"}"
refused "PUB3 an outsider cannot join PUBLIC with no approval"                ts_write "${TX}" "associations/PUBLIC/members/${X}" "{\"uid\":\"${X}\",\"role\":\"member\",\"golferId\":\"gP\"}" joinedAt
refused "PUB3 nobody can create a group with the id PUBLIC"                   write_as "${TX}" "associations/PUBLIC" "{\"name\":\"Mine\",\"ownerUid\":\"${X}\"}"
refused "PUB3 an account that is not a group creator cannot create a group (Phase D)" write_as "${TX}" "associations/GX" "{\"name\":\"Mine\",\"ownerUid\":\"${X}\"}"
allowed "PUB3 private groups still join by code"                             write_as "${TX}" "associations/G1/members/${X}" "{\"uid\":\"${X}\",\"role\":\"member\",\"joinCode\":\"G1CODE\"}"
refused "PUB3 a PUBLIC member cannot add a golfer to the PUBLIC roster"       write_as "${TM}" "associations/PUBLIC/roster/gZ" '{"golferId":"gZ"}'
allowed "PUB3 a reviewer adds a golfer to the PUBLIC roster"                  write_as "${TR}" "associations/PUBLIC/roster/gP" '{"golferId":"gP"}'
allowed "PUB3 a reviewer writes the directory entry"                          write_as "${TR}" "associations/PUBLIC/directory/gP" '{"golferId":"gP","displayName":"Pat Applicant","handicapIndex":""}'

echo "== PUB4 member lists: your own membership only, unless you are an admin"
refused "PUB4 a PUBLIC member cannot list the members"                        query_as "${TM}" "associations/PUBLIC" members false
allowed "PUB4 a PUBLIC member reads their own membership"                     get_as "${TM}" "associations/PUBLIC/members/${M}"
refused "PUB4 a PUBLIC member cannot read another member's membership"        get_as "${TM}" "associations/PUBLIC/members/${PA}"
allowed "PUB4 a reviewer lists the members"                                   query_as "${TR}" "associations/PUBLIC" members false
allowed "PUB4 a PUBLIC member still lists the directory (name and index)"     query_as "${TM}" "associations/PUBLIC" directory false
refused "PUB4 a private-group member cannot list that group's members either" query_as "${TE}" "associations/G1" members false
allowed "PUB4 the private group's owner lists its members"                    query_as "${TO}" "associations/G1" members false

echo "== PUB5 reports (Apple guideline 1.2)"
allowed "PUB5 a member reports a golfer's name"                               ts_write "${TM}" "associations/PUBLIC/reports/rep1" "{\"golferId\":\"gP\",\"displayName\":\"Pat Applicant\",\"reason\":\"Offensive name\",\"reportedBy\":\"${M}\"}" createdAt
refused "PUB5 a report signed as somebody else is refused"                    ts_write "${TM}" "associations/PUBLIC/reports/rep2" "{\"golferId\":\"gP\",\"reason\":\"x\",\"reportedBy\":\"${R}\"}" createdAt
refused "PUB5 a report over 500 characters is refused"                        ts_write "${TM}" "associations/PUBLIC/reports/rep3" "{\"golferId\":\"gP\",\"reason\":\"$(printf 'y%.0s' {1..501})\",\"reportedBy\":\"${M}\"}" createdAt
refused "PUB5 an outsider cannot report"                                      ts_write "${TX}" "associations/PUBLIC/reports/rep4" "{\"golferId\":\"gP\",\"reason\":\"x\",\"reportedBy\":\"${X}\"}" createdAt
refused "PUB5 a member cannot read reports"                                   query_as "${TM}" "associations/PUBLIC" reports false
allowed "PUB5 a reviewer lists the reports"                                   query_as "${TR}" "associations/PUBLIC" reports false
refused "PUB5 a member cannot change a report"                                write_as "${TM}" "associations/PUBLIC/reports/rep1" '{"reason":"changed"}'
allowed "PUB5 a reviewer dismisses (deletes) a report"                         delete_as "${TR}" "associations/PUBLIC/reports/rep1"

echo "== PUB6 blocks: each account's own list"
allowed "PUB6 a member blocks a golfer"                                       ts_write "${TM}" "userBlocks/${M}/golfers/gP" '{"name":"Pat Applicant"}' blockedAt
allowed "PUB6 the member lists their own blocks"                              query_as "${TM}" "userBlocks/${M}" golfers false
refused "PUB6 nobody else can read that list"                                 query_as "${TR}" "userBlocks/${M}" golfers false
refused "PUB6 nobody can write another account's list"                        ts_write "${TX}" "userBlocks/${M}/golfers/gX" '{"name":"x"}' blockedAt
allowed "PUB6 the member unblocks"                                            delete_as "${TM}" "userBlocks/${M}/golfers/gP"

echo "== PUB7 reviewers remove members"
refused "PUB7 a member cannot remove another member"                          delete_as "${TM}" "associations/PUBLIC/members/${PA}"
refused "PUB7 a reviewer cannot remove the owner"                              delete_as "${TR}" "associations/PUBLIC/members/${W}"
allowed "PUB7 a reviewer removes a regular member"                            delete_as "${TR}" "associations/PUBLIC/members/${PA}"

echo "== PUB8 reviewers are only the admins of PUBLIC"
refused "PUB8 the owner of a private group is not a reviewer"                 query_as "${TO}" "" publicApplications false
refused "PUB8 a private-group owner cannot write an approval"                 ts_write "${TO}" "publicApprovals/x@example.com" "{\"golferId\":\"gE\",\"approvedBy\":\"${O}\"}" approvedAt

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
