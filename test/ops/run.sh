#!/usr/bin/env bash
# Starts the Firebase emulators (Firestore and Authentication, on this machine
# only, with a demo project that cannot reach any live data) and runs SEC1–SEC5
# (the deletion job), DEL1 (the app's deletion writes against the real rules),
# PRIV (Phase A privacy), ACC (Phase B accounts) and PUB (Phase C, the PUBLIC group),
# GRP (Phase D), the app itself against the emulators (test/app/e2e.mjs), and the
# go-live data step (golive-tests.mjs).
set -Eeuo pipefail
cd "$(dirname "$0")"
# The emulator only reads files inside this folder, so use a fresh copy of the rules.
cp ../../firestore.rules firestore.rules.copy
firebase emulators:exec --only firestore,auth --project demo-scorecard \
  's=0; bash sec-tests.sh || s=1; echo; bash del1-tests.sh || s=1; echo; if [ -f privacy-tests.sh ]; then bash privacy-tests.sh || s=1; fi; echo; bash acc-tests.sh || s=1; echo; bash pub-tests.sh || s=1; echo; bash grp-tests.sh || s=1; echo; if [ -d ../../node_modules/playwright ]; then node ../app/e2e.mjs ../.. || s=1; else echo "SKIP  app tests (npm ci not run)"; fi; echo; node golive-tests.mjs || s=1; echo; bash go2-tests.sh || s=1; exit $s'
