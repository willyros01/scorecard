#!/usr/bin/env bash
# GRQ1–GRQ5: beta.3, requests for private groups (approved by Willy, Oct 1):
# made without signing in, one per email; read and decided by the group
# creator only (claim with the new group id, then approve; or decline).
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

reset
read -r W  TW  <<<"$(new_user)"   # Willy: the group creator
read -r O  TO  <<<"$(new_user)"   # an ordinary signed-in account
put "groupCreators/${W}" '{"note":"set by the setup script"}'

REQ='{"fullName":"Ann Organiser","email":"Ann@Example.com","groupName":"Tuesday Golfers","golfers":"20","where":"Glen Abbey","note":"","status":"pending"}'

echo "== GRQ1 a request is made signed out, once, well formed"
allowed "GRQ1 signed out, a well-formed request is accepted"                 ts_write - "groupRequests/ann@example.com" "${REQ}" createdAt
refused "GRQ1 a second request for the same email is refused"                ts_write - "groupRequests/ann@example.com" "${REQ}" createdAt
refused "GRQ1 the document id must be the lower-case email"                  ts_write - "groupRequests/someone@example.com" "${REQ}" createdAt
refused "GRQ1 status must be pending"                                         ts_write - "groupRequests/b@example.com" "$(jq -c '.email="b@example.com" | .status="approved"' <<<"${REQ}")" createdAt
refused "GRQ1 an extra field is refused"                                      ts_write - "groupRequests/c@example.com" "$(jq -c '.email="c@example.com" | .groupId="g1"' <<<"${REQ}")" createdAt
refused "GRQ1 a missing group name is refused"                                ts_write - "groupRequests/d@example.com" "$(jq -c '.email="d@example.com" | .groupName=""' <<<"${REQ}")" createdAt
refused "GRQ1 a group name over 60 characters is refused"                     ts_write - "groupRequests/e@example.com" "$(jq -c --arg n "$(printf 'x%.0s' {1..61})" '.email="e@example.com" | .groupName=$n' <<<"${REQ}")" createdAt
refused "GRQ1 the time must be the server's"                                  ts_write - "groupRequests/f@example.com" "$(jq -c '.email="f@example.com" | .createdAt="2026-01-01"' <<<"${REQ}")"
allowed "GRQ1 a signed-in account may also send a request"                    ts_write "${TO}" "groupRequests/g@example.com" "$(jq -c '.email="g@example.com"' <<<"${REQ}")" createdAt

echo "== GRQ2 only the group creator reads requests"
refused "GRQ2 signed out cannot read a request"                               get_any - "groupRequests/ann@example.com"
refused "GRQ2 an ordinary account cannot read a request"                      get_as "${TO}" "groupRequests/ann@example.com"
refused "GRQ2 an ordinary account cannot list requests"                       query_as "${TO}" "" groupRequests false
allowed "GRQ2 the group creator reads a request"                              get_as "${TW}" "groupRequests/ann@example.com"
allowed "GRQ2 the group creator lists requests"                               query_as "${TW}" "" groupRequests false

echo "== GRQ3 approving: claim with the new group id, then approve"
refused "GRQ3 an ordinary account cannot claim"                               ts_update "${TO}" "groupRequests/ann@example.com" "{\"status\":\"approving\",\"reviewedBy\":\"${O}\",\"groupId\":\"g1\"}" reviewedAt
refused "GRQ3 a claim needs a group id"                                       ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"approving\",\"reviewedBy\":\"${W}\"}" reviewedAt
refused "GRQ3 pending cannot jump straight to approved"                       ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"approved\",\"reviewedBy\":\"${W}\",\"groupId\":\"g1\"}" reviewedAt
refused "GRQ3 the reviewer must be the one signed in"                         ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"approving\",\"reviewedBy\":\"${O}\",\"groupId\":\"g1\"}" reviewedAt
refused "GRQ3 the request's own fields cannot change"                         ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"approving\",\"reviewedBy\":\"${W}\",\"groupId\":\"g1\",\"groupName\":\"Other\"}" reviewedAt
allowed "GRQ3 the group creator claims it with the new group id"              ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"approving\",\"reviewedBy\":\"${W}\",\"groupId\":\"g1\"}" reviewedAt
refused "GRQ3 the group id cannot change while approving it"                  ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"approved\",\"reviewedBy\":\"${W}\",\"groupId\":\"g2\"}" reviewedAt
allowed "GRQ3 it can be released back to pending, keeping the group id"       ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"pending\",\"reviewedBy\":\"${W}\"}" reviewedAt
allowed "GRQ3 claimed again (a retry)"                                        ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"approving\",\"reviewedBy\":\"${W}\",\"groupId\":\"g1\"}" reviewedAt
allowed "GRQ3 then approved"                                                  ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"approved\",\"reviewedBy\":\"${W}\"}" reviewedAt
refused "GRQ3 an approved request cannot be declined"                         ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"declined\",\"reviewedBy\":\"${W}\"}" reviewedAt
refused "GRQ3 an approved request cannot go back to pending"                  ts_update "${TW}" "groupRequests/ann@example.com" "{\"status\":\"pending\",\"reviewedBy\":\"${W}\"}" reviewedAt

echo "== GRQ4 declining"
refused "GRQ4 an ordinary account cannot decline"                             ts_update "${TO}" "groupRequests/g@example.com" "{\"status\":\"declined\",\"reviewedBy\":\"${O}\"}" reviewedAt
allowed "GRQ4 the group creator declines a pending request"                   ts_update "${TW}" "groupRequests/g@example.com" "{\"status\":\"declined\",\"reviewedBy\":\"${W}\"}" reviewedAt
refused "GRQ4 a declined request cannot be claimed"                           ts_update "${TW}" "groupRequests/g@example.com" "{\"status\":\"approving\",\"reviewedBy\":\"${W}\",\"groupId\":\"g3\"}" reviewedAt

echo "== GRQ5 deleting"
refused "GRQ5 an ordinary account cannot delete a request"                    delete_as "${TO}" "groupRequests/g@example.com"
allowed "GRQ5 the group creator deletes a request"                            delete_as "${TW}" "groupRequests/g@example.com"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
