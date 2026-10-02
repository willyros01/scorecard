#!/usr/bin/env bash
# NB1–NB7: .github/scripts/nightly-backup.sh (lock, prove, store, keep 30 days)
# against a throwaway local repository. Needs git, gpg, jq. No Google, no GitHub.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
SCRIPT="${REPO}/.github/scripts/nightly-backup.sh"
pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
check(){ local label="$1"; shift; if "$@"; then ok "${label}"; else bad "${label}"; fi; }
T="$(mktemp -d)"; REMOTE="${T}/remote.git"; git init -q --bare "${REMOTE}"
PASS="correct horse battery staple golf"
backup(){ cat > "$1" <<J
{"kind":"scorecard-full-backup","version":1,"documents":[{"path":"associations/G1","fields":{"name":{"stringValue":"Golfing Buddies"}},"missing":false},{"path":"associations/G1/rounds/r1","fields":{},"missing":false},{"path":"golfers/g1","fields":{},"missing":false}],"accounts":${2:-[]}}
J
}
run(){ ( BACKUP_PASSPHRASE="${NBPASS-$PASS}" REMOTE="${REMOTE}" TODAY="$1" KEEP_DAYS=30 bash "${SCRIPT}" "$2" ) > "${T}/out.txt" 2>&1; echo $?; }
show(){ sed 's/^/      | /' "${T}/out.txt" | tail -n 3; }
files(){ git --git-dir="${REMOTE}" ls-tree --name-only backups 2>/dev/null | grep -c '^scorecard-' || true; }
commits(){ git --git-dir="${REMOTE}" rev-list --count backups 2>/dev/null || echo 0; }
backup "${T}/b.json"

echo "== NB1 no passphrase, or a short one: nothing stored"
code="$(NBPASS= run 2026-10-02 "${T}/b.json")"; show
check "NB1 stops without a passphrase"                       [ "${code}" = 1 ]
code="$(NBPASS=short-pass run 2026-10-02 "${T}/b.json")"; show
check "NB1 stops with a passphrase under 16 characters"     [ "${code}" = 1 ]
check "NB1 nothing stored"                                   [ "$(files)" = 0 ]

echo "== NB2 an incomplete backup: nothing stored"
echo '{"kind":"scorecard-full-backup","documents":[],"accounts":[]}' > "${T}/empty.json"
code="$(run 2026-10-02 "${T}/empty.json")"; show
check "NB2 stops on a backup with no groups"                 [ "${code}" = 1 ]
jq '.accounts = null | .accountsNote = "accounts not read: HTTP 403"' "${T}/b.json" > "${T}/noacc.json"
code="$(run 2026-10-02 "${T}/noacc.json")"; show
check "NB2 stops when the account list was not read"         [ "${code}" = 1 ]
check "NB2 nothing stored"                                   [ "$(files)" = 0 ]

echo "== NB3 the first night is stored, locked"
code="$(run 2026-10-02 "${T}/b.json")"; show
check "NB3 succeeds"                                         [ "${code}" = 0 ]
check "NB3 one file on the backups branch"                   [ "$(files)" = 1 ]
git --git-dir="${REMOTE}" show backups:scorecard-2026-10-02.json.gpg > "${T}/got.gpg"
check "NB3 the stored file is not readable as text"         bash -c "! grep -q 'Golfing Buddies' '${T}/got.gpg'"
G="$(mktemp -d)"; chmod 700 "$G"
check "NB3 it opens with the passphrase, identical"          bash -c "GNUPGHOME='$G' gpg --batch --quiet --pinentry-mode loopback --passphrase '${PASS}' -d '${T}/got.gpg' 2>/dev/null | cmp -s - '${T}/b.json'"
check "NB3 it does not open with a wrong passphrase"         bash -c "! GNUPGHOME='$G' gpg --batch --quiet --pinentry-mode loopback --passphrase 'wrong passphrase here!!' -d '${T}/got.gpg' >/dev/null 2>&1"

echo "== NB4 35 more nights: only the last 30 are kept, and only one commit"
for i in $(seq 1 35); do run "$(date -u -d "2026-10-02 +${i} days" +%Y-%m-%d)" "${T}/b.json" >/dev/null; done
check "NB4 30 files kept"                                    [ "$(files)" = 30 ]
check "NB4 the newest night is there"                        bash -c "git --git-dir='${REMOTE}' ls-tree --name-only backups | grep -q scorecard-2026-11-06.json.gpg"
check "NB4 the oldest kept is 30 days back"                  bash -c "git --git-dir='${REMOTE}' ls-tree --name-only backups | grep scorecard- | sort | head -1 | grep -q scorecard-2026-10-08.json.gpg"
check "NB4 no history piles up (one commit)"                 [ "$(commits)" = 1 ]

echo "== NB5 the same night run twice replaces, never duplicates"
code="$(run 2026-11-06 "${T}/b.json")"
check "NB5 succeeds"                                         [ "${code}" = 0 ]
check "NB5 still 30 files"                                   [ "$(files)" = 30 ]

echo "== NB6 the repository cannot be reached: earlier backups untouched"
before="$(git --git-dir="${REMOTE}" rev-parse backups)"
code="$( ( BACKUP_PASSPHRASE="${PASS}" REMOTE="${T}/nowhere.git" TODAY=2026-11-07 bash "${SCRIPT}" "${T}/b.json" ) > "${T}/out.txt" 2>&1; echo $?)"; show
check "NB6 stops"                                            [ "${code}" != 0 ]
check "NB6 the backups branch is unchanged"                  [ "$(git --git-dir="${REMOTE}" rev-parse backups)" = "${before}" ]

echo "== NB7 the workflow"
W="${REPO}/.github/workflows/nightly-backup.yml"
check "NB7 runs daily at 07:00 UTC (3 am Toronto in summer)" grep -q 'cron: "0 7 \* \* \*"' "${W}"
check "NB7 signs in to Google without a key"                 grep -q "workload_identity_provider: projects/811267714235/locations/global/workloadIdentityPools/scorecard-backup/providers/nightly-backup" "${W}"
check "NB7 uses the read-only helper"                        grep -q "service_account: scorecard-backup@scorecard-f41b8.iam.gserviceaccount.com" "${W}"
check "NB7 takes the passphrase from the secret"             grep -q 'BACKUP_PASSPHRASE: \${{ secrets.BACKUP_PASSPHRASE }}' "${W}"

echo "== NB8 ckb.txt opens the newest night with the passphrase"
ck(){ ( cd "${T}" && printf '%s\n' "$1" | PATH="${HERE}/nbk-fakes:${PATH}" FAKE_DIR="${T}" CKB_REMOTE="${REMOTE}" bash "${REPO}/build/ckb.txt" ${2:-} ) > "${T}/out.txt" 2>&1; echo $?; }
code="$(ck "${PASS}")"; show 9
check "NB8 opens (exit 0)"                                   [ "${code}" = 0 ]
check "NB8 names the newest night"                           grep -q "The newest is scorecard-2026-11-06.json.gpg" "${T}/out.txt"
check "NB8 shows what it holds"                              bash -c "grep -q 'groups         : 1' '${T}/out.txt' && grep -q 'group names    : Golfing Buddies' '${T}/out.txt'"
check "NB8 keeps no open copy when only checking"            bash -c "! ls '${T}'/scorecard-backup-opened-* >/dev/null 2>&1"
code="$(ck "wrong passphrase here!!")"; show 2
check "NB8 a wrong passphrase does not open it"              [ "${code}" = 1 ]
code="$(ck "${PASS}" open)"; show 2
check "NB8 open keeps a copy, identical to the backup"       cmp -s "${T}/scorecard-backup-opened-2026-11-06.json" "${T}/b.json"

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
