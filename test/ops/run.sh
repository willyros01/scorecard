#!/usr/bin/env bash
# Starts the Firebase emulators (Firestore and Authentication, on this machine
# only, with a demo project that cannot reach any live data) and runs SEC1–SEC5.
set -Eeuo pipefail
cd "$(dirname "$0")"
firebase emulators:exec --only firestore,auth --project demo-scorecard "bash sec-tests.sh"
