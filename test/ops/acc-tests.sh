#!/usr/bin/env bash
# ACC1–ACC5: Version 2.0 Phase B (onboarding design Rev 2, R4 and R5): every
# read and write needs a real account (email and password). An old anonymous
# guest may only find its own groups and delete itself, until it sets an email
# and password on the SAME account. Nothing here touches the live project.
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

reset
read -r O  TO  <<<"$(new_user)"   # owner of G1 (email account)
read -r A  TA  <<<"$(anon_user)"  # an old anonymous guest: member of G1, golfer gA
read -r E  TE  <<<"$(new_user)"   # a regular member of G1 with email and password, golfer gE
read -r N  TN  <<<"$(new_user)"   # a new email account in no group yet
put "associations/G1" "{\"name\":\"Group one\",\"ownerUid\":\"${O}\"}"
put "associations/G1/members/${O}" "{\"uid\":\"${O}\",\"role\":\"owner\"}"
put "associations/G1/members/${A}" "{\"uid\":\"${A}\",\"role\":\"member\",\"golferId\":\"gA\"}"
put "associations/G1/members/${E}" "{\"uid\":\"${E}\",\"role\":\"member\",\"golferId\":\"gE\"}"
put "userGroups/${A}/groups/G1" '{"assocId":"G1"}'
put "golfers/gA" "{\"name\":\"Alice Guest\",\"linkedUid\":\"${A}\",\"groups\":[\"G1\"]}"
put "golfers/gE" "{\"name\":\"Eve Member\",\"linkedUid\":\"${E}\",\"groups\":[\"G1\"]}"
put "golfers/gU" '{"name":"Una Unclaimed","linkedUid":null,"groups":["G1"]}'
put "golferNames/alice-guest" '{"golferId":"gA","name":"Alice Guest"}'
put "associations/G1/roster/gA" '{"golferId":"gA"}'
put "associations/G1/invites/gU" "{\"golferId\":\"gU\",\"role\":\"member\"}"
put "associations/G1/rounds/rA" '{"golferId":"gA","assocId":"G1","date":"2026-09-01"}'
put "associations/G1/rounds/rE" '{"golferId":"gE","assocId":"G1","date":"2026-09-02"}'
put "associations/G1/directory/gA" '{"golferId":"gA","displayName":"Alice Guest","handicapIndex":"12.3"}'
put "courses/c1" "{\"name\":\"Test Links\",\"createdBy\":\"${O}\"}"
put "joinCodes/ABC123" '{"assocId":"G1"}'

echo "== ACC1 an anonymous session is refused everywhere else, even as a member"
refused "ACC1 anonymous cannot read its group"                               get_as "${TA}" "associations/G1"
refused "ACC1 anonymous cannot read its own round"                           get_as "${TA}" "associations/G1/rounds/rA"
refused "ACC1 anonymous cannot query its own rounds"                         query_as "${TA}" "associations/G1" rounds false golferId EQUAL gA
refused "ACC1 anonymous cannot list the directory"                           query_as "${TA}" "associations/G1" directory false
refused "ACC1 anonymous cannot read its own golfer directly"                 get_as "${TA}" "golfers/gA"
refused "ACC1 anonymous cannot read an unclaimed golfer"                     get_as "${TA}" "golfers/gU"
refused "ACC1 anonymous cannot read an invitation"                           get_as "${TA}" "associations/G1/invites/gU"
refused "ACC1 anonymous cannot read courses"                                 get_as "${TA}" "courses/c1"
refused "ACC1 anonymous cannot read a join code"                             get_as "${TA}" "joinCodes/ABC123"
refused "ACC1 anonymous cannot look up a golfer name"                        get_as "${TA}" "golferNames/alice-guest"
refused "ACC1 anonymous cannot post a round"                                 write_as "${TA}" "associations/G1/rounds/rNew" '{"golferId":"gA","assocId":"G1"}'
refused "ACC1 anonymous cannot create a group"                               write_as "${TA}" "associations/Gnew" "{\"name\":\"Mine\",\"ownerUid\":\"${A}\"}"
refused "ACC1 anonymous cannot create a golfer"                              write_as "${TA}" "golfers/gNew" '{"name":"New Person","linkedUid":null}'
refused "ACC1 anonymous cannot add a group to its own group list"            write_as "${TA}" "userGroups/${A}/groups/G9" '{"assocId":"G9"}'
refused "ACC1 anonymous cannot change its own directory entry"               write_as "${TA}" "associations/G1/directory/gA" '{"golferId":"gA","displayName":"Alice Guest","handicapIndex":"1.0"}'

echo "== ACC2 an anonymous session may still find its own groups and delete itself"
allowed "ACC2 anonymous lists its own group list"                            query_as "${TA}" "userGroups/${A}" groups false
allowed "ACC2 anonymous finds its own memberships (collection group, uid == self)" query_as "${TA}" "" members true uid EQUAL "${A}"
allowed "ACC2 anonymous asks which groups it owns (ownerUid == self)"        query_as "${TA}" "" associations false ownerUid EQUAL "${A}"
allowed "ACC2 anonymous finds its own golfer (linkedUid == self)"            query_as "${TA}" "" golfers false linkedUid EQUAL "${A}"
allowed "ACC2 anonymous records its own deletion request"                    write_as "${TA}" "accountDeletions/${A}" '{"stage":"requested","kind":"anonymous"}'
allowed "ACC2 anonymous reads its own deletion request"                      get_as "${TA}" "accountDeletions/${A}"
refused "ACC2 anonymous cannot read another account's deletion request"      get_as "${TA}" "accountDeletions/${E}"
refused "ACC2 anonymous cannot list another account's group list"            query_as "${TA}" "userGroups/${E}" groups false
refused "ACC2 anonymous cannot find another account's golfer"                query_as "${TA}" "" golfers false linkedUid EQUAL "${E}"
allowed "ACC2 anonymous withdraws its own deletion request"                  delete_as "${TA}" "accountDeletions/${A}"

echo "== ACC3 email accounts work as before"
allowed "ACC3 an email member finds its own memberships (collection group, uid == self — the app's query)" query_as "${TE}" "" members true uid EQUAL "${E}"
refused "ACC3 an email member cannot find another account's memberships"     query_as "${TE}" "" members true uid EQUAL "${O}"
allowed "ACC3 an email member reads the group"                               get_as "${TE}" "associations/G1"
allowed "ACC3 an email member reads its own round"                           get_as "${TE}" "associations/G1/rounds/rE"
allowed "ACC3 an email member lists the directory"                           query_as "${TE}" "associations/G1" directory false
allowed "ACC3 a new email account reads courses"                             get_as "${TN}" "courses/c1"
allowed "ACC3 a new email account reads an invitation (to accept it)"         get_as "${TN}" "associations/G1/invites/gU"
allowed "ACC3 a new email account greets itself by an unclaimed golfer name" get_as "${TN}" "golfers/gU"
allowed "ACC3 a new email account creates its own group"                     write_as "${TN}" "associations/GN" "{\"name\":\"New group\",\"ownerUid\":\"${N}\"}"
allowed "ACC3 a new email account adds it to its own group list"             write_as "${TN}" "userGroups/${N}/groups/GN" '{"assocId":"GN"}'

echo "== ACC4 the guest sets an email and password on the SAME account and is let back in"
TA2="$(link_email "${TA}" "alice.guest@example.com")"
[[ -n "${TA2}" && "${TA2}" != null ]] && ok "ACC4 the email and password are attached to the guest's own account" \
  || bad "ACC4 the email and password are attached to the guest's own account"
allowed "ACC4 now reads its group"                                           get_as "${TA2}" "associations/G1"
allowed "ACC4 now reads its own round"                                       get_as "${TA2}" "associations/G1/rounds/rA"
allowed "ACC4 now queries its own rounds"                                    query_as "${TA2}" "associations/G1" rounds false golferId EQUAL gA
allowed "ACC4 now lists the directory"                                       query_as "${TA2}" "associations/G1" directory false
allowed "ACC4 now reads its own golfer"                                      get_as "${TA2}" "golfers/gA"
refused "ACC4 still cannot read another member's round"                      get_as "${TA2}" "associations/G1/rounds/rE"

echo "== ACC5 a fresh anonymous sign-in (a stranger) gets nothing at all"
read -r S TS <<<"$(anon_user)"
refused "ACC5 a stranger's anonymous session cannot read the group"          get_as "${TS}" "associations/G1"
refused "ACC5 a stranger's anonymous session cannot read an invitation"      get_as "${TS}" "associations/G1/invites/gU"
refused "ACC5 a stranger's anonymous session cannot create a group"          write_as "${TS}" "associations/GS" "{\"name\":\"Spam\",\"ownerUid\":\"${S}\"}"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
