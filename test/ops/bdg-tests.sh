#!/usr/bin/env bash
# BG1–BG4: build/bdg.txt (the 1-dollar spending alert) against a stand-in
# gcloud (test/ops/bdg-fakes). Nothing touches the live project.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }
FAKE="$(mktemp -d)"
run(){ ( cd "${FAKE}" && PATH="${HERE}/bdg-fakes:${PATH}" FAKE_DIR="${FAKE}" bash "${REPO}/build/bdg.txt" ) > "${FAKE}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${FAKE}/out.txt" | tail -n 4; }
budgets(){ grep -c . "${FAKE}/budgets.txt" 2>/dev/null || echo 0; }

echo "billingAccounts/0A1B2C-3D4E5F-6G7H8I" > "${FAKE}/accounts.txt"
check "BG0 the project is set before anything else"   bash -c "grep -n 'PROJECT_ID=\"scorecard-f41b8\"' '${REPO}/build/bdg.txt' | head -1 | cut -d: -f1 | xargs -I{} test {} -lt 20"

echo "== BG1 two billing accounts: it stops, nothing created"
printf 'billingAccounts/A\nbillingAccounts/B\n' > "${FAKE}/accounts.txt"
code="$(run)"; show
check "BG1 stops (exit 1)"                             [ "${code}" = 1 ]
check "BG1 nothing created"                            [ "$(budgets)" = 0 ]

echo "== BG2 the budget tool cannot be switched on: it stops, nothing created"
echo "billingAccounts/0A1B2C-3D4E5F-6G7H8I" > "${FAKE}/accounts.txt"; touch "${FAKE}/fail-enable"
code="$(run)"; show
check "BG2 stops (exit 1)"                             [ "${code}" = 1 ]
check "BG2 nothing created"                            [ "$(budgets)" = 0 ]
rm -f "${FAKE}/fail-enable"

echo "== BG3 creates the budget: 1.00 CAD, 50/90/100%"
code="$(run)"; show
check "BG3 succeeds (exit 0)"                          [ "${code}" = 0 ]
check "BG3 one budget, the right name"                 [ "$(cat "${FAKE}/budgets.txt")" = "Spending alert - 1 dollar" ]
check "BG3 on the right billing account"               grep -q -- "--billing-account=0A1B2C-3D4E5F-6G7H8I --display-name" "${FAKE}/calls.txt"

echo "== BG4 running it again changes nothing"
code="$(run)"; show
check "BG4 succeeds (exit 0)"                          [ "${code}" = 0 ]
check "BG4 says it is already there"                   grep -q "already there" "${FAKE}/out.txt"
check "BG4 still one budget"                           [ "$(budgets)" = 1 ]

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
