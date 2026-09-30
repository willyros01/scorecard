#!/usr/bin/env bash
# GRP1–GRP5: Version 2.0 Phase D (Willy's rules, Sep 30): only group creators
# create groups; only the owner sends admin invitations (the secret lives where
# only the owner can read it) and changes roles; a group's admins remove its
# regular members only. Against the real firestore.rules in the Firebase
# emulator. Nothing here touches the live project.
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
read -r W  TW  <<<"$(new_user)"   # Willy: the group creator, owner of G1
read -r AD TAD <<<"$(new_user)"   # an admin of G1
read -r AD2 TAD2 <<<"$(new_user)" # another admin of G1
read -r M  TM  <<<"$(new_user)"   # a regular member of G1
read -r N  TN  <<<"$(new_user)"   # a new person, about to use an invitation
read -r X  TX  <<<"$(new_user)"   # an admin of another group, G2
put "groupCreators/${W}" '{"note":"set by the setup script"}'
put "associations/G1" "{\"name\":\"Group one\",\"ownerUid\":\"${W}\",\"joinCode\":\"MEMBER1\"}"
put "associations/G1/secrets/admin" '{"adminCode":"ADMIN99"}'
put "associations/G1/members/${W}"   "{\"uid\":\"${W}\",\"role\":\"owner\"}"
put "associations/G1/members/${AD}"  "{\"uid\":\"${AD}\",\"role\":\"admin\"}"
put "associations/G1/members/${AD2}" "{\"uid\":\"${AD2}\",\"role\":\"admin\"}"
put "associations/G1/members/${M}"   "{\"uid\":\"${M}\",\"role\":\"member\"}"
put "associations/G2" "{\"name\":\"Group two\",\"ownerUid\":\"${W}\",\"joinCode\":\"MEMBER2\"}"
put "associations/G2/members/${W}" "{\"uid\":\"${W}\",\"role\":\"owner\"}"
put "associations/G2/members/${X}" "{\"uid\":\"${X}\",\"role\":\"admin\"}"
put "associations/OLD" "{\"name\":\"Older group\",\"ownerUid\":\"${W}\",\"adminCode\":\"LEGACY1\"}"
put "associations/OLD/members/${W}" "{\"uid\":\"${W}\",\"role\":\"owner\"}"

echo "== GRP1 only group creators create groups"
allowed "GRP1 Willy (group creator) creates a group"                          write_as "${TW}" "associations/GW" "{\"name\":\"New group\",\"ownerUid\":\"${W}\",\"joinCode\":\"NEW111\"}"
allowed "GRP1 Willy becomes its owner"                                        write_as "${TW}" "associations/GW/members/${W}" "{\"uid\":\"${W}\",\"role\":\"owner\"}"
refused "GRP1 an admin cannot create a group"                                 write_as "${TAD}" "associations/GA" "{\"name\":\"Mine\",\"ownerUid\":\"${AD}\"}"
refused "GRP1 a regular member cannot create a group"                         write_as "${TM}" "associations/GM" "{\"name\":\"Mine\",\"ownerUid\":\"${M}\"}"
refused "GRP1 a brand-new account cannot create a group"                      write_as "${TN}" "associations/GNEW" "{\"name\":\"Mine\",\"ownerUid\":\"${N}\"}"
refused "GRP1 nobody can create a group in Willy's name"                      write_as "${TN}" "associations/GFAKE" "{\"name\":\"Mine\",\"ownerUid\":\"${W}\"}"
refused "GRP1 even Willy cannot put the admin secret on a new group document" write_as "${TW}" "associations/GW2" "{\"name\":\"Two\",\"ownerUid\":\"${W}\",\"adminCode\":\"X1\"}"
allowed "GRP1 Willy checks his own group-creator entry"                       get_as "${TW}" "groupCreators/${W}"
refused "GRP1 nobody else can read it"                                        get_as "${TN}" "groupCreators/${W}"
refused "GRP1 nobody can list the group creators"                             query_as "${TW}" "" groupCreators false
refused "GRP1 nobody can add themselves as a group creator"                   write_as "${TN}" "groupCreators/${N}" '{"note":"me"}'
refused "GRP1 not even Willy, from the app"                                   write_as "${TW}" "groupCreators/${M}" '{"note":"x"}'

put "golfers/gAny" '{"name":"Anybody","linkedUid":null,"groups":["G2"]}'
allowed "GRP1 Willy (group creator) lists every golfer, for Tidy"             query_as "${TW}" "" golfers false
refused "GRP1 an admin cannot list every golfer"                              query_as "${TAD}" "" golfers false
refused "GRP1 a regular member cannot list every golfer"                      query_as "${TM}" "" golfers false

echo "== GRP2 admin invitations: the owner only"
allowed "GRP2 the owner reads the admin secret"                               get_as "${TW}" "associations/G1/secrets/admin"
refused "GRP2 an admin cannot read the admin secret"                          get_as "${TAD}" "associations/G1/secrets/admin"
refused "GRP2 a member cannot read the admin secret"                          get_as "${TM}" "associations/G1/secrets/admin"
refused "GRP2 an admin cannot change the admin secret"                        write_as "${TAD}" "associations/G1/secrets/admin" '{"adminCode":"MINE1"}'
refused "GRP2 an admin cannot put an admin secret back on the group document" write_as "${TAD}" "associations/G1" '{"adminCode":"MINE1"}'
refused "GRP2 the owner cannot put it back on the group document either"      write_as "${TW}" "associations/G1" '{"adminCode":"MINE1"}'
allowed "GRP2 the owner moves an older group's secret: removes it from the group document" write_as "${TW}" "associations/OLD" '{"adminCode":null}'
allowed "GRP2 ... and saves it where only the owner can read it"              write_as "${TW}" "associations/OLD/secrets/admin" '{"adminCode":"LEGACY1"}'
refused "GRP2 the member code does not make somebody an admin"                write_as "${TN}" "associations/G1/members/${N}" "{\"uid\":\"${N}\",\"role\":\"admin\",\"joinCode\":\"MEMBER1\"}"
refused "GRP2 a wrong admin code is refused"                                  write_as "${TN}" "associations/G1/members/${N}" "{\"uid\":\"${N}\",\"role\":\"admin\",\"joinCode\":\"GUESS12\"}"
allowed "GRP2 the owner's admin invitation works"                             write_as "${TN}" "associations/G1/members/${N}" "{\"uid\":\"${N}\",\"role\":\"admin\",\"joinCode\":\"ADMIN99\"}"
delete_as "${TN}" "associations/G1/members/${N}" >/dev/null
allowed "GRP2 an admin's (regular member) invitation works"                   write_as "${TN}" "associations/G1/members/${N}" "{\"uid\":\"${N}\",\"role\":\"member\",\"joinCode\":\"MEMBER1\"}"

echo "== GRP3 only the owner promotes and demotes"
refused "GRP3 an admin cannot promote a member"                               write_as "${TAD}" "associations/G1/members/${M}" '{"role":"admin"}'
refused "GRP3 an admin cannot demote another admin"                           write_as "${TAD}" "associations/G1/members/${AD2}" '{"role":"member"}'
refused "GRP3 a member cannot promote themselves"                             write_as "${TM}" "associations/G1/members/${M}" '{"role":"admin"}'
allowed "GRP3 the owner promotes a member"                                    write_as "${TW}" "associations/G1/members/${M}" '{"role":"admin"}'
allowed "GRP3 the owner demotes them again"                                   write_as "${TW}" "associations/G1/members/${M}" '{"role":"member"}'
refused "GRP3 nobody can demote the owner"                                    write_as "${TAD}" "associations/G1/members/${W}" '{"role":"member"}'

echo "== GRP4 admins remove regular members of their own group"
refused "GRP4 an admin cannot remove the owner"                               delete_as "${TAD}" "associations/G1/members/${W}"
refused "GRP4 an admin cannot remove another admin"                           delete_as "${TAD}" "associations/G1/members/${AD2}"
refused "GRP4 an admin of another group cannot remove this group's member"    delete_as "${TX}" "associations/G1/members/${M}"
refused "GRP4 a regular member cannot remove another member"                  delete_as "${TM}" "associations/G1/members/${N}"
allowed "GRP4 an admin removes a regular member"                              delete_as "${TAD}" "associations/G1/members/${M}"
allowed "GRP4 a member may still leave by themselves"                         delete_as "${TN}" "associations/G1/members/${N}"

echo "== GRP6 archiving golfers (Tidy's merge and clean-up)"
put "golfers/gOff" '{"name":"Off Roster","linkedUid":null,"groups":["G1"]}'
put "golfers/gOther" '{"name":"Other Group","linkedUid":null,"groups":["G2"]}'
allowed "GRP6 the owner archives a golfer of G1 that is on no roster"         write_as "${TW}" "golfers/gOff" '{"archived":true,"archivedAt":"now","nameKey":null,"editedIn":"G1"}'
refused "GRP6 archiving cannot also rename"                                   write_as "${TAD}" "golfers/gOff" '{"archived":true,"name":"Renamed"}'
refused "GRP6 a regular member cannot archive"                                write_as "${TM}" "golfers/gOff" '{"archived":true}'
refused "GRP6 an admin of G1 cannot archive a golfer of G2 only"              write_as "${TAD}" "golfers/gOther" '{"archived":true}'
allowed "GRP6 an admin of G2 archives G2's golfer"                            write_as "${TX}" "golfers/gOther" '{"archived":true,"editedIn":"G2"}'

echo "== GRP5 the owner keeps every right"
allowed "GRP5 the owner removes an admin"                                     delete_as "${TW}" "associations/G1/members/${AD2}"
allowed "GRP5 the owner renames the group"                                    write_as "${TW}" "associations/G1" '{"name":"Group one renamed"}'
allowed "GRP5 the owner changes the admin secret"                             write_as "${TW}" "associations/G1/secrets/admin" '{"adminCode":"ADMIN77"}'
allowed "GRP5 the owner deletes a group"                                      delete_as "${TW}" "associations/GW"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
