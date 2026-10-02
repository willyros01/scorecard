#!/usr/bin/env bash
# NK1–NK6: build/nbk.txt (the nightly backup's read-only helper and keyless
# sign-in) against a stand-in gcloud (test/ops/nbk-fakes). Nothing touches Google.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }
F="$(mktemp -d)"
run(){ ( cd "$F" && printf '%s\n' "${ANSWER:-yes}" | PATH="${HERE}/nbk-fakes:${PATH}" FAKE_DIR="$F" bash "${REPO}/build/nbk.txt" "$@" ) > "$F/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "$F/out.txt" | tail -n "${1:-4}"; }
W="${REPO}/.github/workflows/nightly-backup.yml"

check "NK0 the project is set before anything else"   bash -c "[ \$(grep -n '^PROJECT_ID=' '${REPO}/build/nbk.txt' | cut -d: -f1) -lt 20 ]"

echo "== NK1 the wrong project number: stops before any change"
code="$(FAKE_NUMBER=999 run)"; show 2
check "NK1 stops"                                      [ "${code}" = 1 ]
check "NK1 nothing created"                            bash -c "[ ! -f '$F/sa' ] && [ ! -f '$F/pool' ]"

echo "== NK2 answering no changes nothing"
code="$(ANSWER=no run)"; show 2
check "NK2 stops"                                      [ "${code}" = 1 ]
check "NK2 nothing created"                            bash -c "[ ! -f '$F/sa' ] && [ ! -f '$F/pool' ]"

echo "== NK3 verify before setup reports what is missing"
code="$(run verify)"; show 3
check "NK3 verify fails"                               [ "${code}" = 1 ]

echo "== NK4 setup (the GitHub link fails once and is retried)"
touch "$F/fail-provider"
code="$(run)"; show 8
check "NK4 succeeds"                                   [ "${code}" = 0 ]
check "NK4 the helper can only read: exactly two viewer roles" bash -c "[ \"\$(sort '$F/roles.txt' | tr '\n' ' ')\" = 'roles/datastore.viewer roles/firebaseauth.viewer ' ]"
check "NK4 only this repository's nightly-backup workflow on main" grep -qx "assertion.repository_id=='1327018101' && assertion.workflow_ref=='willyros01/scorecard/.github/workflows/nightly-backup.yml@refs/heads/main'" "$F/condition.txt"
check "NK4 the helper is linked to that sign-in only"  grep -qx "principalSet://iam.googleapis.com/projects/811267714235/locations/global/workloadIdentityPools/scorecard-backup/\*" "$F/link.txt"
check "NK4 no key file is ever made"                   bash -c "! grep -q 'keys create' '$F/calls.txt'"
check "NK4 the workflow uses the same pool, provider and helper" bash -c "grep -q 'workloadIdentityPools/scorecard-backup/providers/nightly-backup' '$W' && grep -q 'scorecard-backup@scorecard-f41b8' '$W'"
check "NK4 the workflow file is the one the condition names" [ -f "${REPO}/.github/workflows/nightly-backup.yml" ]

echo "== NK5 running it again adds nothing twice"
code="$(run)"; show 2
check "NK5 succeeds"                                   [ "${code}" = 0 ]
check "NK5 still two roles"                            [ "$(wc -l < "$F/roles.txt")" = 2 ]
check "NK5 still one link"                             [ "$(wc -l < "$F/link.txt")" = 1 ]

echo "== NK6 verify passes"
code="$(run verify)"; show 2
check "NK6 verify succeeds"                            [ "${code}" = 0 ]

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
