#!/usr/bin/env bash
# DL1–DL6: build/dl9.txt itself (beta.9: the deletion lock),
# end to end with its recovery. Google Cloud is played by the stand-ins in
# test/ops/go2-fakes (gcloud, and curl for GitHub and the Rules API). Nothing
# here touches the live project, and no data is involved.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
P="scorecard-f41b8"
LIVE_COMMIT="0cb05b53757a6ac8fbbaa874b267da6f7bc74c56"

pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }

FAKE="$(mktemp -d)"; RUN="$(mktemp -d)"
# The rules ap4.txt published (a stand-in), as live and on GitHub.
echo "rules_version = '2'; /* the rules ap4.txt published (stand-in) */" > "${FAKE}/old-rules.txt"
mkdir -p "${FAKE}/rulesets" "${FAKE}/raw/${LIVE_COMMIT}"
cp "${FAKE}/old-rules.txt" "${FAKE}/rulesets/r0.txt"
cp "${FAKE}/old-rules.txt" "${FAKE}/raw/${LIVE_COMMIT}/firestore.rules"
echo "projects/${P}/rulesets/r0" > "${FAKE}/release.txt"
live(){ cat "${FAKE}/rulesets/$(basename "$(cat "${FAKE}/release.txt")").txt"; }
live_is_old(){ [[ "$(live)" == "$(cat "${FAKE}/old-rules.txt")" ]]; }
live_is_new(){ diff -q <(live) "${REPO}/firestore.rules" >/dev/null; }
dl9(){ ( cd "${RUN}" && printf 'yes\n' | PATH="${HERE}/go2-fakes:${PATH}" FAKE_DIR="${FAKE}" REPO_DIR="${REPO}" \
  bash "${REPO}/build/dl9.txt" ${DL9_MODE:-} ) > "${RUN}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${RUN}/out.txt" | tail -n "${1:-8}"; }

PIN="$(grep -o '^COMMIT="[0-9a-f]\{40\}"' "${REPO}/build/dl9.txt" | cut -d'"' -f2)"
check "DL7 dl9.txt is pinned to a tested commit"                             test -n "${PIN}"
check "DL7 ... whose rules are exactly these"                               bash -c "cd '${REPO}' && { git cat-file -e '${PIN}' 2>/dev/null || git fetch -q --depth 1 origin '${PIN}'; } && git show '${PIN}:firestore.rules' | diff -q - firestore.rules >/dev/null"
check "DL0 the new rules hold the deletion lock"                             grep -q "function deleting()" "${REPO}/firestore.rules"

echo "== DL1 publishing fails: the earlier rules stay"
touch "${FAKE}/fail-patch"
code="$(dl9)"; show
check "DL1 dl9.txt stops (exit 1)"                                         [ "${code}" = 1 ]
check "DL1 it names the step"                                              grep -q "Something failed during publishing the rules" "${RUN}/out.txt"
check "DL1 the earlier rules are live"                                     live_is_old

echo "== DL2 running it again publishes"
code="$(dl9)"; show 4
check "DL2 succeeds (exit 0)"                                              [ "${code}" = 0 ]
check "DL2 the new rules are live"                                         live_is_new
check "DL2 it says DONE"                                                   grep -q "DONE. The deletion lock is live" "${RUN}/out.txt"

echo "== DL3 once more only checks"
code="$(dl9)"
check "DL3 exit 0"                                                         [ "${code}" = 0 ]
check "DL3 ... and says they are already live"                             grep -q "already live" "${RUN}/out.txt"
code="$(DL9_MODE=verify dl9)"
check "DL3 verify says OK"                                                 [ "${code}" = 0 ]

echo "== DL4 the manual rollback"
code="$(DL9_MODE=rollback dl9)"; show 3
check "DL4 rollback succeeds (exit 0)"                                     [ "${code}" = 0 ]
check "DL4 the earlier rules are live"                                     live_is_old

echo "== DL5 the check after publishing fails: the earlier rules are put back"
echo 2 > "${FAKE}/fail-verify"
code="$(dl9)"; show
check "DL5 dl9.txt stops (exit 1)"                                         [ "${code}" = 1 ]
check "DL5 it names the step"                                              grep -q "Something failed during checking the published rules" "${RUN}/out.txt"
check "DL5 the earlier rules are live"                                     live_is_old
rm -f "${FAKE}/fail-verify"

echo "== DL6 the live rules are not the expected ones: nothing is changed"
echo "rules_version = '2'; /* something else */" > "${FAKE}/rulesets/rX.txt"
echo "projects/${P}/rulesets/rX" > "${FAKE}/release.txt"
code="$(dl9)"; show 3
check "DL6 dl9.txt refuses (exit 1)"                                       [ "${code}" = 1 ]
check "DL6 it says why"                                                    grep -q "not the ones ap4.txt published" "${RUN}/out.txt"
check "DL6 nothing was published"                                          [ "$(live)" = "rules_version = '2'; /* something else */" ]

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
