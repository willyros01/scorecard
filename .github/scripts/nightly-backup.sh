#!/usr/bin/env bash
# The Scorecard — NIGHTLY BACKUP, the part after the backup file is made.
# Run by .github/workflows/nightly-backup.yml; tested by test/ops/nb-tests.sh.
#
#   nightly-backup.sh <backup.json>
#
# 1. checks the backup is complete (a Scorecard backup, groups and golfers in
#    it, the account list read);
# 2. locks it with Willy's passphrase (GnuPG, AES-256, strong key stretching);
# 3. proves the locked file opens again and matches, byte for byte;
# 4. stores it on the "backups" branch with the earlier nights, keeping the
#    last KEEP_DAYS days, as ONE commit (no history piles up);
# 5. never removes the earlier backups if anything above fails.
#
# Settings (environment):
#   BACKUP_PASSPHRASE  required, at least 16 characters (a GitHub secret)
#   REMOTE             the repository to push to (default: this repository)
#   TODAY              YYYY-MM-DD (default: today, UTC)
#   KEEP_DAYS          default 30
set -Eeuo pipefail

SRC="${1:-}"
KEEP_DAYS="${KEEP_DAYS:-30}"
TODAY="${TODAY:-$(date -u +%Y-%m-%d)}"
BRANCH="backups"
die(){ echo "ERROR: $*" >&2; exit 1; }

[[ -n "${SRC}" && -s "${SRC}" ]] || die "no backup file was made."
PASS="${BACKUP_PASSPHRASE:-}"
[[ -n "${PASS}" ]] || die "the passphrase secret BACKUP_PASSPHRASE is not set on GitHub. Nothing was stored."
(( ${#PASS} >= 16 )) || die "the passphrase is shorter than 16 characters. Nothing was stored."
[[ "${TODAY}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "bad date ${TODAY}"
: "${REMOTE:?REMOTE is required}"

# 1. Complete?
jq -e '.kind == "scorecard-full-backup"' "${SRC}" >/dev/null || die "the file is not a Scorecard backup."
NGROUPS="$(jq '[.documents[] | select((.missing | not) and (.path | test("^associations/[^/]+$")))] | length' "${SRC}")"
NGOLFERS="$(jq '[.documents[] | select((.missing | not) and (.path | test("^golfers/[^/]+$")))] | length' "${SRC}")"
NROUNDS="$(jq '[.documents[] | select(.path | test("^associations/[^/]+/rounds/[^/]+$"))] | length' "${SRC}")"
(( NGROUPS > 0 && NGOLFERS > 0 )) || die "the backup has no groups or no golfers (${NGROUPS} groups, ${NGOLFERS} golfers) — something is wrong; nothing was stored."
jq -e '.accounts | type == "array"' "${SRC}" >/dev/null || die "the account list could not be read: $(jq -r '.accountsNote // "unknown"' "${SRC}")"
NACCOUNTS="$(jq '.accounts | length' "${SRC}")"
echo "Backup complete: ${NGROUPS} groups, ${NGOLFERS} golfers, ${NROUNDS} rounds, ${NACCOUNTS} accounts."

# 2. Lock it.
WORK="$(mktemp -d)"
NAME="scorecard-${TODAY}.json.gpg"
gpg_do(){ gpg --batch --quiet --yes --no-tty --pinentry-mode loopback --passphrase-fd 3 "$@" 3<<<"${PASS}"; }
export GNUPGHOME="${WORK}/gnupg"; mkdir -m 700 "${GNUPGHOME}"
gpg_do --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
  --compress-algo zlib --output "${WORK}/${NAME}" "${SRC}" || die "could not lock the backup."

# 3. Does it open again, identical?
gpg_do --decrypt --output "${WORK}/check.json" "${WORK}/${NAME}" || die "the locked backup did not open again."
cmp -s "${SRC}" "${WORK}/check.json" || die "the locked backup does not match the original."
rm -f "${WORK}/check.json"
echo "Locked and checked: ${NAME} ($(( $(stat -c %s "${WORK}/${NAME}") / 1024 )) KB)."

# 4. Store it with the earlier nights.
STORE="${WORK}/store"; mkdir -p "${STORE}"
set +e; git ls-remote --exit-code --heads "${REMOTE}" "${BRANCH}" >/dev/null 2>&1; HAS=$?; set -e
if [[ "${HAS}" == 0 ]]; then
  git clone -q --depth 1 --branch "${BRANCH}" "${REMOTE}" "${WORK}/old" || die "could not read the earlier backups; nothing was changed."
  cp "${WORK}/old"/scorecard-*.json.gpg "${STORE}/" 2>/dev/null || true
elif [[ "${HAS}" != 2 ]]; then
  die "could not reach the repository (code ${HAS}); nothing was changed."
fi
cp "${WORK}/${NAME}" "${STORE}/"
CUTOFF="$(date -u -d "${TODAY} -$((KEEP_DAYS - 1)) days" +%Y-%m-%d)"
for f in "${STORE}"/scorecard-*.json.gpg; do
  d="$(basename "$f" | sed -E 's/^scorecard-([0-9]{4}-[0-9]{2}-[0-9]{2})\.json\.gpg$/\1/')"
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  if [[ "$d" < "${CUTOFF}" ]]; then rm -f "$f"; fi
done
KEPT="$(ls -1 "${STORE}"/scorecard-*.json.gpg | wc -l)"
cat > "${STORE}/README.txt" <<TXT
The Scorecard — nightly backups, LOCKED with the owner's passphrase.
They cannot be opened without it. The last ${KEEP_DAYS} days are kept.
Open one with build/ckb.txt in Google Cloud Shell.
TXT
cd "${STORE}"
git init -q -b "${BRANCH}"
git add -A
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "Nightly backup ${TODAY}: ${NGROUPS} groups, ${NGOLFERS} golfers, ${NROUNDS} rounds (${KEPT} nights kept)"
git push -q --force "${REMOTE}" "HEAD:${BRANCH}" || die "could not store the backup; the earlier backups are unchanged."
echo "Stored on the ${BRANCH} branch. ${KEPT} nights kept (from ${CUTOFF})."
