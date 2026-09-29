#!/usr/bin/env bash
# Starts the Firebase emulators (Firestore and Authentication, on this machine
# only, with a demo project that cannot reach any live data) and runs SEC1–SEC5
# (the deletion job) and DEL1 (the app's deletion writes against the real rules).
set -Eeuo pipefail
cd "$(dirname "$0")"
# The emulator only reads files inside this folder, so use a fresh copy of the rules.
cp ../../firestore.rules firestore.rules.copy
firebase emulators:exec --only firestore,auth --project demo-scorecard \
  's=0; bash sec-tests.sh || s=1; echo; bash del1-tests.sh || s=1; echo; if [ -f privacy-tests.sh ]; then bash privacy-tests.sh || s=1; fi; exit $s'
