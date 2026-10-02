#!/usr/bin/env bash
# AR1–AR6: build/arc.txt (archive leftover golfer copies) end to end against
# the Firestore emulator; Google Cloud is played by test/ops/go2-fakes.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
CURL="$(command -v curl)"
P="scorecard-f41b8"
FS="http://127.0.0.1:8080/v1"
AUTH="http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1"
H=(-H "Authorization: Bearer owner" -H "Content-Type: application/json")
pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }
reset(){
  "${CURL}" -sS -X DELETE "${H[@]}" "http://127.0.0.1:8080/emulator/v1/projects/${P}/databases/(default)/documents" >/dev/null
  PROJECT="${P}" node "${HERE}/arc-seed.mjs" "$@"
}
FAKE="$(mktemp -d)"; RUN="$(mktemp -d)"
arc(){ ( cd "${RUN}" && printf '%s\n' "${ANSWER:-yes}" | PATH="${HERE}/go2-fakes:${PATH}" FAKE_DIR="${FAKE}" REPO_DIR="${REPO}" \
  FS_BASE="${FS}" AUTH_BASE="${AUTH}" bash "${REPO}/build/arc.txt" "$@" ) > "${RUN}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${RUN}/out.txt" | tail -n "${1:-6}"; }
snap(){ ACCESS_TOKEN=owner PROJECT="${P}" FS_BASE="${FS}" AUTH_BASE="${AUTH}" node "${REPO}/build/bk1.mjs" "$1" >/dev/null; }
all(){ jq -S '[.documents[] | {path, fields}] | sort_by(.path)' "$1"; }
f(){ jq -c --arg p "$2" ".documents[] | select(.path == \$p) | .fields$3" "$1"; }
eq(){ [ "$1" = "$2" ]; }
# everything except the three copies
rest(){ jq -S '[.documents[] | select(.path | test("^golfers/c[123]$") | not) | {path, fields}] | sort_by(.path)' "$1"; }

for v in mine namelist; do
  echo "== AR1 ${v}: it stops, nothing changes"
  reset "${v}"; snap "${RUN}/b0.json"
  code="$(arc)"; show 3
  check "AR1 ${v}: stops (exit 1)"                       [ "${code}" = 1 ]
  snap "${RUN}/b1.json"
  check "AR1 ${v}: nothing changed"                      diff -q <(all "${RUN}/b0.json") <(all "${RUN}/b1.json")
done

echo "== AR2 answering no changes nothing"
reset; snap "${RUN}/b0.json"
code="$(ANSWER=no arc)"; show 3
check "AR2 stops"                                        [ "${code}" = 1 ]
snap "${RUN}/b1.json"
check "AR2 nothing changed"                              diff -q <(all "${RUN}/b0.json") <(all "${RUN}/b1.json")
check "AR2 the backup before was taken"                  ls "${RUN}"/scorecard-backup-before-archive-*.json

echo "== AR3 it archives the three copies"
code="$(arc)"; show 12
check "AR3 succeeds"                                     [ "${code}" = 0 ]
check "AR3 lists the copy tied to another golfer's sign-in as left as is" grep -q "LEFT AS IS: Pat Player" "${RUN}/out.txt"
check "AR3 it checks itself"                             grep -q "OK: no leftover copies remain" "${RUN}/out.txt"
snap "${RUN}/b2.json"
for c in c1 c2 c3; do
  check "AR3 ${c} archived, merged into the real golfer" eq "$(f "${RUN}/b2.json" "golfers/${c}" '|[.archived.booleanValue, .mergedInto.stringValue]')" '[true,"gReal"]'
  check "AR3 ${c} keeps its name and sign-in link"       eq "$(f "${RUN}/b2.json" "golfers/${c}" '|[.name, .linkedUid]')" "$(f "${RUN}/b0.json" "golfers/${c}" '|[.name, .linkedUid]')"
done

echo "== AR4 nothing else changed: the real golfer, the name list, rounds, groups, other copies"
check "AR4 everything else is exactly as before"        diff -q <(rest "${RUN}/b0.json") <(rest "${RUN}/b2.json")

echo "== AR5 running it again does nothing; verify agrees"
code="$(arc)"; show 2
check "AR5 nothing to archive (exit 0)"                  [ "${code}" = 0 ]
check "AR5 says so"                                      grep -q "no leftover copies to archive" "${RUN}/out.txt"
code="$(arc verify)"; show 2
check "AR5 verify passes"                                [ "${code}" = 0 ]

echo "== AR6 the app no longer lists them (it hides archived golfers)"
check "AR6 the group-less list skips archived golfers"   grep -q "if (person.archived) return;" "${REPO}/store.js"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
