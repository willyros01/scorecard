#!/usr/bin/env bash
# PRIV1–PRIV12: Version 2.0 Phase A privacy rules (onboarding design Rev 2,
# section 11 acceptance tests), against the real firestore.rules in the
# Firebase emulator. Every read is made as a real signed-in test account.
# Nothing here touches the live project.
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
new_user(){ curl -g -sS --fail -H 'Content-Type: application/json' -d '{"returnSecureToken":true}' \
  "${AUTHROOT}/accounts:signUp?key=fake-api-key" | jq -r '"\(.localId) \(.idToken)"'; }

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
read -r O  TO  <<<"$(new_user)"   # owner of G1
read -r AD TAD <<<"$(new_user)"   # admin of G1
read -r A  TA  <<<"$(new_user)"   # regular member of G1, golfer gA
read -r B  TB  <<<"$(new_user)"   # regular member of G1, golfer gB
read -r X  TX  <<<"$(new_user)"   # outsider: owner of unrelated G2
put "associations/G1" "{\"name\":\"Group one\",\"ownerUid\":\"${O}\"}"
put "associations/G2" "{\"name\":\"Group two\",\"ownerUid\":\"${X}\"}"
put "associations/G1/members/${O}"  "{\"uid\":\"${O}\",\"role\":\"owner\"}"
put "associations/G1/members/${AD}" "{\"uid\":\"${AD}\",\"role\":\"admin\"}"
put "associations/G1/members/${A}"  "{\"uid\":\"${A}\",\"role\":\"member\",\"golferId\":\"gA\"}"
put "associations/G1/members/${B}"  "{\"uid\":\"${B}\",\"role\":\"member\",\"golferId\":\"gB\"}"
put "associations/G2/members/${X}"  "{\"uid\":\"${X}\",\"role\":\"owner\"}"
put "golfers/gA" "{\"name\":\"Alice Golfer\",\"linkedUid\":\"${A}\",\"groups\":[\"G1\"]}"
put "golfers/gB" "{\"name\":\"Bob Golfer\",\"linkedUid\":\"${B}\",\"groups\":[\"G1\"]}"
put "golfers/gU" '{"name":"Una Unclaimed","linkedUid":null,"groups":["G1"]}'
put "golfers/gX" "{\"name\":\"Xavier Other\",\"linkedUid\":\"${X}\",\"groups\":[\"G2\"]}"
put "golferNames/alice-golfer" '{"golferId":"gA","name":"Alice Golfer"}'
put "golferNames/bob-golfer" '{"golferId":"gB","name":"Bob Golfer"}'
for g in gA gB gU; do put "associations/G1/roster/${g}" "{\"golferId\":\"${g}\"}"; done
put "associations/G1/rounds/rA" '{"golferId":"gA","assocId":"G1","date":"2026-09-01"}'
put "associations/G1/rounds/rB" '{"golferId":"gB","assocId":"G1","date":"2026-09-02"}'
put "associations/G2/rounds/rX" '{"golferId":"gX","assocId":"G2","date":"2026-09-03"}'
put "associations/G1/directory/gA" '{"golferId":"gA","displayName":"Alice Golfer","handicapIndex":"12.3"}'
put "associations/G1/directory/gB" '{"golferId":"gB","displayName":"Bob Golfer","handicapIndex":"20.1"}'
put "associations/G1/games/game1" "{\"name\":\"Saturday\",\"createdBy\":\"${AD}\",\"participantGolferIds\":[\"gA\",\"gU\"]}"
put "associations/G1/games/game2" "{\"name\":\"Sunday\",\"createdBy\":\"${AD}\",\"participantGolferIds\":[\"gB\"]}"

echo "== PRIV1 rounds: no reads across the database"
refused "PRIV1 an outsider cannot read a G1 round directly"                  get_as "${TX}" "associations/G1/rounds/rA"
refused "PRIV1 a collection-group query on every rounds collection is refused" query_as "${TA}" "" rounds true
refused "PRIV1 an outsider's collection-group query is refused"               query_as "${TX}" "" rounds true

echo "== PRIV2 rounds: a regular member sees only their own"
allowed "PRIV2 A reads A's own round"                                        get_as "${TA}" "associations/G1/rounds/rA"
refused "PRIV2 A cannot read B's round, even knowing its path"               get_as "${TA}" "associations/G1/rounds/rB"
allowed "PRIV2 A's query for golferId == gA is allowed"                      query_as "${TA}" "associations/G1" rounds false golferId EQUAL gA
refused "PRIV2 A's query for every round of the group is refused"            query_as "${TA}" "associations/G1" rounds false
refused "PRIV2 A's query for golferId == gB is refused"                      query_as "${TA}" "associations/G1" rounds false golferId EQUAL gB

echo "== PRIV3 rounds: admins see their group, not others"
allowed "PRIV3 the G1 admin lists every G1 round"                            query_as "${TAD}" "associations/G1" rounds false
allowed "PRIV3 the G1 owner lists every G1 round"                            query_as "${TO}" "associations/G1" rounds false
refused "PRIV3 the G2 owner cannot list G1 rounds"                           query_as "${TX}" "associations/G1" rounds false

echo "== PRIV4 golfer records are private"
allowed "PRIV4 A reads A's own golfer record"                                get_as "${TA}" "golfers/gA"
refused "PRIV4 A cannot read B's golfer record"                              get_as "${TA}" "golfers/gB"
allowed "PRIV4 the G1 admin reads B's golfer record (B plays in G1)"         get_as "${TAD}" "golfers/gB"
refused "PRIV4 the G2 owner cannot read B's golfer record"                   get_as "${TX}" "golfers/gB"
allowed "PRIV4 an unclaimed golfer can be read by id (invitation greeting)"  get_as "${TX}" "golfers/gU"
refused "PRIV4 nobody can list the golfers collection (member)"             query_as "${TA}" "" golfers false
refused "PRIV4 nobody can list the golfers collection (admin)"              query_as "${TAD}" "" golfers false

echo "== PRIV5 the directory: name and index for members only"
allowed "PRIV5 A lists the G1 directory"                                      query_as "${TA}" "associations/G1" directory false
refused "PRIV5 the G2 owner cannot list the G1 directory"                    query_as "${TX}" "associations/G1" directory false
allowed "PRIV5 A updates A's own index in the G1 directory"                  write_as "${TA}" "associations/G1/directory/gA" '{"golferId":"gA","displayName":"Alice Golfer","handicapIndex":"11.9"}'
refused "PRIV5 A cannot change B's directory entry"                          write_as "${TA}" "associations/G1/directory/gB" '{"golferId":"gB","displayName":"Bob Golfer","handicapIndex":"1.0"}'
refused "PRIV5 A cannot add a private field to A's own entry"                write_as "${TA}" "associations/G1/directory/gA" '{"linkedUid":"x"}'
allowed "PRIV5 the G1 admin updates B's directory entry"                     write_as "${TAD}" "associations/G1/directory/gB" '{"golferId":"gB","displayName":"Bob Golfer","handicapIndex":"19.8"}'

echo "== PRIV6 games: participants only"
allowed "PRIV6 A (played in game1) reads game1"                               get_as "${TA}" "associations/G1/games/game1"
refused "PRIV6 A (did not play in game2) cannot read game2"                  get_as "${TA}" "associations/G1/games/game2"
allowed "PRIV6 A's query for games containing gA is allowed"                  query_as "${TA}" "associations/G1" games false participantGolferIds ARRAY_CONTAINS gA
refused "PRIV6 A's query for every game is refused"                          query_as "${TA}" "associations/G1" games false
allowed "PRIV6 the G1 admin lists every game"                                query_as "${TAD}" "associations/G1" games false
refused "PRIV6 the G2 owner cannot read game1"                               get_as "${TX}" "associations/G1/games/game1"

echo "== PRIV7 golfer name index"
allowed "PRIV7 a single name lookup is allowed (uniqueness check)"           get_as "${TX}" "golferNames/alice-golfer"
refused "PRIV7 nobody can list every golfer name"                           query_as "${TA}" "" golferNames false
refused "PRIV7 an outsider cannot delete A's name claim"                    delete_as "${TX}" "golferNames/alice-golfer"
refused "PRIV7 B cannot delete A's name claim"                              delete_as "${TB}" "golferNames/alice-golfer"
allowed "PRIV7 the G1 admin can delete A's name claim (rename)"             delete_as "${TAD}" "golferNames/alice-golfer"

echo "== PRIV8 invitation claims"
refused "PRIV8 an outsider cannot list G1's invitation claims"               query_as "${TX}" "associations/G1" invites false

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
