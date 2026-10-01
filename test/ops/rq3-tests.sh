#!/usr/bin/env bash
# RQ1–RQ6: build/rq3.txt itself (beta.3: the rules for private group requests),
# end to end with its recovery. Google Cloud is played by the stand-ins in
# test/ops/go2-fakes (gcloud, and curl for GitHub and the Rules API). Nothing
# here touches the live project, and no data is involved.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
P="scorecard-f41b8"
LIVE_COMMIT="752914a95d2a7e845636b902a197a28fc34a9795"

pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }

FAKE="$(mktemp -d)"; RUN="$(mktemp -d)"
# The rules go2.txt published this morning (a stand-in), as live and on GitHub.
echo "rules_version = '2'; /* the Version 2.0 rules go2.txt published (stand-in) */" > "${FAKE}/old-rules.txt"
mkdir -p "${FAKE}/rulesets" "${FAKE}/raw/${LIVE_COMMIT}"
cp "${FAKE}/old-rules.txt" "${FAKE}/rulesets/r0.txt"
cp "${FAKE}/old-rules.txt" "${FAKE}/raw/${LIVE_COMMIT}/firestore.rules"
echo "projects/${P}/rulesets/r0" > "${FAKE}/release.txt"
live(){ cat "${FAKE}/rulesets/$(basename "$(cat "${FAKE}/release.txt")").txt"; }
live_is_old(){ [[ "$(live)" == "$(cat "${FAKE}/old-rules.txt")" ]]; }
live_is_new(){ diff -q <(live) "${REPO}/firestore.rules" >/dev/null; }
rq3(){ ( cd "${RUN}" && printf 'yes\n' | PATH="${HERE}/go2-fakes:${PATH}" FAKE_DIR="${FAKE}" REPO_DIR="${REPO}" \
  bash "${REPO}/build/rq3.txt" ${RQ3_MODE:-} ) > "${RUN}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${RUN}/out.txt" | tail -n "${1:-8}"; }

check "RQ0 the new rules hold the group requests"                          grep -q "match /groupRequests/" "${REPO}/firestore.rules"

echo "== RQ1 publishing fails: the earlier rules stay"
touch "${FAKE}/fail-patch"
code="$(rq3)"; show
check "RQ1 rq3.txt stops (exit 1)"                                         [ "${code}" = 1 ]
check "RQ1 it names the step"                                              grep -q "Something failed during publishing the rules" "${RUN}/out.txt"
check "RQ1 the earlier rules are live"                                     live_is_old

echo "== RQ2 running it again publishes"
code="$(rq3)"; show 4
check "RQ2 succeeds (exit 0)"                                              [ "${code}" = 0 ]
check "RQ2 the new rules are live"                                         live_is_new
check "RQ2 it says DONE"                                                   grep -q "DONE. Group requests are live" "${RUN}/out.txt"

echo "== RQ3 once more only checks"
code="$(rq3)"
check "RQ3 exit 0"                                                         [ "${code}" = 0 ]
check "RQ3 ... and says they are already live"                             grep -q "already live" "${RUN}/out.txt"
code="$(RQ3_MODE=verify rq3)"
check "RQ3 verify says OK"                                                 [ "${code}" = 0 ]

echo "== RQ4 the manual rollback"
code="$(RQ3_MODE=rollback rq3)"; show 3
check "RQ4 rollback succeeds (exit 0)"                                     [ "${code}" = 0 ]
check "RQ4 the earlier rules are live"                                     live_is_old

echo "== RQ5 the check after publishing fails: the earlier rules are put back"
echo 2 > "${FAKE}/fail-verify"
code="$(rq3)"; show
check "RQ5 rq3.txt stops (exit 1)"                                         [ "${code}" = 1 ]
check "RQ5 it names the step"                                              grep -q "Something failed during checking the published rules" "${RUN}/out.txt"
check "RQ5 the earlier rules are live"                                     live_is_old
rm -f "${FAKE}/fail-verify"

echo "== RQ6 the live rules are not the expected ones: nothing is changed"
echo "rules_version = '2'; /* something else */" > "${FAKE}/rulesets/rX.txt"
echo "projects/${P}/rulesets/rX" > "${FAKE}/release.txt"
code="$(rq3)"; show 3
check "RQ6 rq3.txt refuses (exit 1)"                                       [ "${code}" = 1 ]
check "RQ6 it says why"                                                    grep -q "not the ones go2.txt published" "${RUN}/out.txt"
check "RQ6 nothing was published"                                          [ "$(live)" = "rules_version = '2'; /* something else */" ]

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
