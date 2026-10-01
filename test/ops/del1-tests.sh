#!/usr/bin/env bash
# DEL1 (acceptance matrix; Code + emulator; decision D4).
# Every write the app makes in Delete my account — step 4 (the request record)
# and step 7 (one batch per group, then the golfer unlink) — is sent exactly as
# the app sends it, signed in as the deleting account, against the real
# firestore.rules in the Firebase emulator. Each must be allowed. The same
# writes sent by another account (a fellow member, and a stranger) must each be
# refused. Nothing here touches the live project.
set -Eeuo pipefail

P="${PROJECT:-demo-scorecard}"
FS="${FS_BASE:-http://127.0.0.1:8080/v1}"
AUTHROOT="${AUTH_ROOT:-http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1}"
FS_ADMIN="${FS_ADMIN:-http://127.0.0.1:8080/emulator/v1}"
AUTH_ADMIN="${AUTH_ADMIN:-http://127.0.0.1:9099/emulator/v1}"
DB="projects/${P}/databases/(default)/documents"
ADMIN=(-H "Authorization: Bearer owner")   # the emulator's rules-bypassing token, for seeding only

pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }

reset(){
  curl -g -sS --fail -X DELETE "${ADMIN[@]}" "${FS_ADMIN}/projects/${P}/databases/(default)/documents" >/dev/null
  curl -g -sS --fail -X DELETE "${ADMIN[@]}" "${AUTH_ADMIN}/projects/${P}/accounts" >/dev/null
}
# new_user → "uid token"
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

fields(){ jq -c 'with_entries(.value = (if .value == null then {nullValue:null} else {stringValue:.value} end))' <<<"$1"; }
# Seeding, bypassing the rules.
put(){ jq -nc --arg n "${DB}/$1" --argjson f "$(fields "$2")" '{writes:[{update:{name:$n,fields:$f}}]}' \
  | curl -g -sS --fail "${ADMIN[@]}" -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit" >/dev/null; }
exists(){ [[ "$(curl -g -sS -o /dev/null -w '%{http_code}' "${ADMIN[@]}" "${FS}/${DB}/$1")" == 200 ]]; }

# Write objects, as the web SDK sends them.
w_set(){   # path fields-json   — setDoc(..., {merge:true}): an update with a mask of the given fields
  jq -nc --arg n "${DB}/$1" --argjson f "$(fields "$2")" '{update:{name:$n,fields:$f},updateMask:{fieldPaths:($f|keys)}}'; }
w_update(){ # path fields-json  — updateDoc: the same, and the document must exist
  jq -nc --arg n "${DB}/$1" --argjson f "$(fields "$2")" '{update:{name:$n,fields:$f},updateMask:{fieldPaths:($f|keys)},currentDocument:{exists:true}}'; }
w_delete(){ jq -nc --arg n "${DB}/$1" '{delete:$n}'; }

# commit_as TOKEN WRITE... → prints the HTTP status of one atomic commit
commit_as(){ local token="$1"; shift
  printf '%s\n' "$@" | jq -sc '{writes:.}' \
  | curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" \
      -H 'Content-Type: application/json' --data-binary @- "${FS}/${DB}:commit"; }
allowed(){ local label="$1"; shift; local code; code="$(commit_as "$@")"
  [[ "${code}" == 200 ]] && ok "${label}" || bad "${label} (HTTP ${code}, expected 200)"; }
refused(){ local label="$1"; shift; local code; code="$(commit_as "$@")"
  [[ "${code}" == 403 ]] && ok "${label}" || bad "${label} (HTTP ${code}, expected 403 refused)"; }

seed(){
  read -r A TA <<<"$(anon_user)"  # the account being deleted: an old anonymous guest in G1 and G2
  read -r B TB <<<"$(new_user)"   # a fellow member of G1
  read -r X TX <<<"$(new_user)"   # a stranger in no group
  read -r O TO <<<"$(new_user)"   # the owner of both groups
  for g in G1 G2; do
    put "associations/${g}" "{\"name\":\"Group ${g}\",\"ownerUid\":\"${O}\"}"
    put "associations/${g}/members/${O}" "{\"uid\":\"${O}\",\"role\":\"owner\"}"
    put "associations/${g}/members/${A}" "{\"uid\":\"${A}\",\"role\":\"member\",\"golferId\":\"gA\"}"
    put "associations/${g}/invites/gA" "{\"acceptedBy\":\"${A}\",\"role\":\"member\"}"
    put "associations/${g}/roster/gA" '{"golferId":"gA"}'
    put "userGroups/${A}/groups/${g}" "{\"assocId\":\"${g}\"}"
  done
  put "associations/G1/members/${B}" "{\"uid\":\"${B}\",\"role\":\"member\",\"golferId\":\"gB\"}"
  put "userGroups/${B}/groups/G1" '{"assocId":"G1"}'
  put "golfers/gA" "{\"name\":\"Alice Golfer\",\"linkedUid\":\"${A}\"}"
  put "golfers/gB" "{\"name\":\"Bob Golfer\",\"linkedUid\":\"${B}\"}"
}

# The app's writes, for account $1 (uid), exactly as store.js deleteMyAccount builds them.
rec_requested(){ w_set "accountDeletions/$1" '{"stage":"requested","kind":"anonymous","groups":"G1,G2","golferIds":"gA"}'; }
rec_reauth(){    w_set "accountDeletions/$1" '{"stage":"reauthenticated"}'; }
leave_batch(){ # uid group
  w_delete "associations/$2/members/$1"
  w_delete "userGroups/$1/groups/$2"
  w_delete "associations/$2/invites/gA"
  w_set "accountDeletions/$1" "{\"stage\":\"cleaning\",\"lastGroup\":\"$2\"}"; }
unlink_batch(){ # uid
  w_update "golfers/gA" '{"linkedUid":null}'
  w_set "accountDeletions/$1" '{"stage":"auth-deleting"}'; }

# query_as TOKEN PARENT(relative, '' for root) COLLECTION ALLDESC FIELD VALUE -> HTTP status (field == value)
query_as(){ local q; q="$(jq -nc --arg c "$3" --argjson a "$4" --arg f "$5" --arg v "$6" \
    '{structuredQuery:{from:[{collectionId:$c,allDescendants:$a}],where:{fieldFilter:{field:{fieldPath:$f},op:"EQUAL",value:{stringValue:$v}}}}}')"
  curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
    --data-binary "${q}" "${FS}/${DB}${2:+/$2}:runQuery"; }
list_as(){ curl -g -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "${FS}/${DB}/$2"; }
read_ok(){ local label="$1"; shift; local code; code="$("$@")"
  [[ "${code}" == 200 ]] && ok "${label}" || bad "${label} (HTTP ${code}, expected 200)"; }
read_refused(){ local label="$1"; shift; local code; code="$("$@")"
  [[ "${code}" == 403 ]] && ok "${label}" || bad "${label} (HTTP ${code}, expected 403 refused)"; }

echo "== DEL1 part 0: the reads Delete my account makes before any write (steps 1 and 4, still anonymous) — each must be allowed"
reset; seed
read_ok "DEL1 step 1: A asks which groups it owns (associations where ownerUid == A)" query_as "${TA}" "" associations false ownerUid "${A}"
read_ok "DEL1 step 1: A finds its memberships (collection group members where uid == A)" query_as "${TA}" "" members true uid "${A}"
read_ok "DEL1 step 1: A lists its own group list"                                   list_as "${TA}" "userGroups/${A}/groups"
read_ok "DEL1 step 4: A finds its own golfer (golfers where linkedUid == A)"         query_as "${TA}" "" golfers false linkedUid "${A}"
read_refused "DEL1 A cannot find B's memberships (uid == B)"                        query_as "${TA}" "" members true uid "${B}"

echo "== DEL1 part 1: another account tries the same writes — each must be refused"
reset; seed
for who in "B:${TB}:a fellow member" "X:${TX}:a stranger"; do
  IFS=: read -r tag tok desc <<<"${who}"
  refused "DEL1 ${desc} (${tag}) cannot write A's deletion record"            "${tok}" "$(rec_requested "${A}")"
  refused "DEL1 ${desc} (${tag}) cannot delete A's membership in G1"          "${tok}" "$(w_delete "associations/G1/members/${A}")"
  refused "DEL1 ${desc} (${tag}) cannot delete A's group list entry"          "${tok}" "$(w_delete "userGroups/${A}/groups/G1")"
  refused "DEL1 ${desc} (${tag}) cannot delete A's invitation claim"          "${tok}" "$(w_delete "associations/G1/invites/gA")"
  refused "DEL1 ${desc} (${tag}) cannot unlink A's golfer"                    "${tok}" "$(w_update "golfers/gA" '{"linkedUid":null}')"
  mapfile -t LB < <(leave_batch "${A}" G1)
  refused "DEL1 ${desc} (${tag}) cannot run A's whole step-7 batch for G1"    "${tok}" "${LB[@]}"
done
if exists "associations/G1/members/${A}" && exists "associations/G1/invites/gA" && exists "userGroups/${A}/groups/G1" \
   && ! exists "accountDeletions/${A}"; then ok "DEL1 nothing of A's changed after the refused attempts"
else bad "DEL1 nothing of A's changed after the refused attempts"; fi

echo "== DEL1 part 2: the account itself makes every write, in the app's order — each must be allowed"
allowed "DEL1 step 4: A (still anonymous) records its deletion request (D4)"  "${TA}" "$(rec_requested "${A}")"
mapfile -t LB < <(leave_batch "${A}" G1)
refused "DEL1 Phase B: A cannot leave a group while still anonymous"           "${TA}" "${LB[@]}"
# Step 5: the app attaches the throwaway email to the SAME account (reconfirmSignIn).
TA="$(link_email "${TA}" "delete-${A,,}@accounts.cuberoot-systems.com")"
[[ -n "${TA}" && "${TA}" != null ]] && ok "DEL1 step 5: the throwaway email is attached to A's own account" \
  || bad "DEL1 step 5: the throwaway email is attached to A's own account"
allowed "DEL1 step 5: A marks the request re-confirmed"                       "${TA}" "$(rec_reauth "${A}")"
read_ok "DEL1 step 7: A (email attached) finds its own invitation claims in G1"      query_as "${TA}" "associations/G1" invites false acceptedBy "${A}"
for g in G1 G2; do
  mapfile -t LB < <(leave_batch "${A}" "${g}")
  allowed "DEL1 step 7: A leaves ${g} in one batch (membership, group list, own invitation claim (D4), record)" "${TA}" "${LB[@]}"
done
mapfile -t UB < <(unlink_batch "${A}")
allowed "DEL1 step 7: A unlinks its golfer and marks the record auth-deleting" "${TA}" "${UB[@]}"
# The end state the batches were meant to produce.
state_ok=1
for g in G1 G2; do
  exists "associations/${g}/members/${A}" && state_ok=0
  exists "associations/${g}/invites/gA" && state_ok=0
  exists "userGroups/${A}/groups/${g}" && state_ok=0
  exists "associations/${g}/roster/gA" || state_ok=0
done
exists "associations/G1/members/${B}" || state_ok=0
exists "accountDeletions/${A}" || state_ok=0
[[ "${state_ok}" == 1 ]] && ok "DEL1 end state: A is out of both groups; roster, B and the record remain" \
  || bad "DEL1 end state: A is out of both groups; roster, B and the record remain"
LINK="$(curl -g -sS --fail "${ADMIN[@]}" "${FS}/${DB}/golfers/gA" | jq -r '.fields.linkedUid | has("nullValue")')"
NAME="$(curl -g -sS --fail "${ADMIN[@]}" "${FS}/${DB}/golfers/gA" | jq -r '.fields.name.stringValue')"
[[ "${LINK}" == true && "${NAME}" == "Alice Golfer" ]] && ok "DEL1 golfer unlinked and the name kept (D1)" \
  || bad "DEL1 golfer unlinked and the name kept (D1) (linkedUid null: ${LINK}, name: ${NAME})"

echo "== DEL1 part 3: another account still cannot touch A's record; A can withdraw it (wrong-password path)"
refused "DEL1 a fellow member cannot delete A's deletion record"               "${TB}" "$(w_delete "accountDeletions/${A}")"
allowed "DEL1 A can delete its own record (D4, the wrong-password withdrawal)" "${TA}" "$(w_delete "accountDeletions/${A}")"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
