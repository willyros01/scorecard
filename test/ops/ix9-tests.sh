#!/usr/bin/env bash
# IX1–IX6: build/ix9.txt itself (the membership search index). Google is played
# by test/ops/ix9-fakes/curl and test/ops/go2-fakes/gcloud. Nothing here
# touches the live project.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }
FAKE="$(mktemp -d)"; RUN="$(mktemp -d)"
ix9(){ ( cd "${RUN}" && printf '%s\n' "${ANSWER:-yes}" | PATH="${HERE}/ix9-fakes:${HERE}/go2-fakes:${PATH}" FAKE_DIR="${FAKE}" \
  IX9_WAIT=0 IX9_TRIES="${TRIES:-5}" bash "${REPO}/build/ix9.txt" ${MODE:-} ) > "${RUN}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${RUN}/out.txt" | tail -n "${1:-6}"; }
patched(){ [[ -s "${FAKE}/patch-body.json" ]]; }
reset(){ rm -f "${FAKE}"/*; }

echo "== IX1 the index is missing; typing anything but yes changes nothing"
reset; code="$(ANSWER=no ix9)"; show 3
check "IX1 it confirms the index is missing"        grep -q "CONFIRMED: Google refuses the membership search" "${RUN}/out.txt"
check "IX1 stops (exit 1)"                          [ "${code}" = 1 ]
check "IX1 nothing was requested"                   bash -c "! [ -s '${FAKE}/patch-body.json' ]"

echo "== IX2 yes: the index is requested, built, and the search then works"
reset; code="$(ix9)"; show 4
check "IX2 succeeds (exit 0)"                       [ "${code}" = 0 ]
check "IX2 says DONE"                               grep -q "DONE. Delete my account can check your groups" "${RUN}/out.txt"
check "IX2 asked for the across-groups index on members.uid" \
  jq -e '.indexConfig.indexes | any(.queryScope=="COLLECTION_GROUP" and .fields[0].fieldPath=="uid" and .fields[0].order=="ASCENDING")' "${FAKE}/patch-body.json"
check "IX2 kept the normal single-group indexes"    jq -e '[.indexConfig.indexes[] | select(.queryScope=="COLLECTION")] | length == 3' "${FAKE}/patch-body.json"
check "IX2 only that one field was touched"         bash -c "grep '^PATCH' '${FAKE}/calls.txt' | grep -vc 'collectionGroups/members/fields/uid?updateMask=indexConfig' | grep -qx 0"

echo "== IX3 running it again changes nothing; verify says OK"
code="$(ix9)"; show 2
check "IX3 exit 0"                                  [ "${code}" = 0 ]
check "IX3 says it already works"                   grep -q "already works. Nothing to add" "${RUN}/out.txt"
code="$(MODE=verify ix9)"
check "IX3 verify says OK"                          [ "${code}" = 0 ]

echo "== IX4 Google refuses the index: nothing changed, it says so"
reset; touch "${FAKE}/patch-fails"; code="$(ix9)"; show 2
check "IX4 stops (exit 1)"                          [ "${code}" = 1 ]
check "IX4 says Google refused it"                  grep -q "Google refused the index" "${RUN}/out.txt"

echo "== IX5 a different problem (not the index): nothing is changed"
reset; touch "${FAKE}/other-error"; code="$(ix9)"; show 3
check "IX5 stops (exit 1)"                          [ "${code}" = 1 ]
check "IX5 shows Google's answer"                   grep -q "insufficient permissions" "${RUN}/out.txt"
check "IX5 nothing was requested"                   bash -c "! [ -s '${FAKE}/patch-body.json' ]"

echo "== IX6 still building when the wait ends: says how to check later"
reset; echo 50 > "${FAKE}/build-polls"; code="$(TRIES=3 ix9)"; show 3
check "IX6 exit 0"                                  [ "${code}" = 0 ]
check "IX6 tells you to verify later"               grep -q "bash ix9.txt verify" "${RUN}/out.txt"
code="$(MODE=verify ix9)"
check "IX6 verify says not ready yet (exit 1)"      [ "${code}" = 1 ]

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
