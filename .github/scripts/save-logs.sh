#!/usr/bin/env bash
# Saves a run's log files to the ci-logs branch of this repo, so they can be
# read later without GitHub's separate log-download site. Keeps the last 30
# runs of each kind. Usage: save-logs.sh KIND RESULT FILE...
# Needs GH_TOKEN (the workflow's own token) with contents: write.
set -Eeuo pipefail
KIND="$1"; RESULT="$2"; shift 2
: "${GH_TOKEN:?GH_TOKEN is required}"
RUN_DIR="$(printf '%05d' "${GITHUB_RUN_NUMBER}")-${GITHUB_SHA:0:7}"
REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
TMP="$(mktemp -d)"

if git ls-remote --exit-code --heads "${REMOTE}" ci-logs >/dev/null 2>&1; then
  git clone -q --depth 1 --branch ci-logs "${REMOTE}" "${TMP}"
else
  git init -q -b ci-logs "${TMP}"
  git -C "${TMP}" remote add origin "${REMOTE}"
  printf 'Build and test logs only. Never merged, never published.\n' > "${TMP}/README.txt"
fi

DEST="${TMP}/logs/${KIND}/${RUN_DIR}"
mkdir -p "${DEST}"
for f in "$@"; do [[ -f "${f}" ]] && cp "${f}" "${DEST}/"; done
{
  echo "kind:    ${KIND}"
  echo "result:  ${RESULT}"
  echo "branch:  ${GITHUB_REF_NAME}"
  echo "commit:  ${GITHUB_SHA}"
  echo "run:     ${GITHUB_RUN_NUMBER} (id ${GITHUB_RUN_ID})"
  echo "time:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for f in "$@"; do [[ -f "${f}" ]] && { echo; echo "--- last lines of ${f##*/} ---"; tail -n 40 "${f}"; }; done
} > "${DEST}/summary.txt"

# Keep only the newest 30 runs of this kind.
ls -1d "${TMP}/logs/${KIND}"/*/ 2>/dev/null | sort | head -n -30 | xargs -r rm -rf

cd "${TMP}"
git add -A
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "Logs: ${KIND} run ${GITHUB_RUN_NUMBER} (${RESULT})"
for attempt in 1 2 3; do
  git push -q origin HEAD:ci-logs && exit 0
  git pull -q --rebase origin ci-logs || true
  sleep $((attempt * 3))
done
echo "Could not save logs to ci-logs." >&2
exit 1
