#!/usr/bin/env bash
# The real generated app, installed on an iPhone simulator. Camera hardware is
# unavailable in Simulator: this verifies the installed permission and launch,
# not taking a physical photograph. Browser CAM4 covers Manage's file input.
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
OUT="${RUNNER_TEMP:-/tmp}/scorecard-camera-simulator"
mkdir -p "$OUT"
python3 test/ios/camera-permission-tests.py
xcrun simctl list devices available -j > "$OUT/devices.json"
UDID="$(python3 - "$OUT/devices.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    devices = json.load(f)['devices']
for runtime, items in sorted(devices.items(), reverse=True):
    if '.iOS-' in runtime:
        for d in items:
            if d.get('isAvailable') and d['name'].startswith('iPhone'):
                print(d['udid'])
                sys.exit(0)
raise SystemExit('FAIL no available iPhone simulator')
PY
)"
# Existing generated project and privacy configuration are identical to release.
xcodebuild build -project ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator -destination "id=$UDID" \
  -derivedDataPath "$OUT/DerivedData" CODE_SIGNING_ALLOWED=NO \
  > "$OUT/build.log" 2>&1 || { tail -80 "$OUT/build.log"; exit 1; }
APP="$OUT/DerivedData/Build/Products/Debug-iphonesimulator/App.app"
python3 build/ios/camera-permission.py verify "$APP/Info.plist"
# Verify the detector fails if this exact built app loses the key again.
python3 - "$APP/Info.plist" "$OUT/missing-camera.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    data = plistlib.load(f)
data.pop('NSCameraUsageDescription')
with open(sys.argv[2], 'wb') as f:
    plistlib.dump(data, f)
PY
if python3 build/ios/camera-permission.py verify "$OUT/missing-camera.plist"; then
  echo 'FAIL SIM-CAM1 negative control was accepted'; exit 1
fi
echo 'PASS SIM-CAM1 built app permission validated; missing-key negative control rejected'
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"
BUNDLE=io.github.willyros01.scorecard
INSTALLED="$(xcrun simctl get_app_container "$UDID" "$BUNDLE" app)"
python3 build/ios/camera-permission.py verify "$INSTALLED/Info.plist"
xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" | tee "$OUT/launch.log"
PID="$(awk -F ': ' '/io.github.willyros01.scorecard:/ {print $NF}' "$OUT/launch.log")"
[[ "$PID" =~ ^[0-9]+$ ]] || { echo 'FAIL simulator returned no app PID'; exit 1; }
for tick in {1..10}; do
  sleep 1
  kill -0 "$PID" || { echo 'FAIL app exited after simulator launch'; exit 1; }
done
xcrun simctl io "$UDID" screenshot "$OUT/launched.png"
echo 'PASS SIM-CAM2 installed Scorecard launched and remained running for 10 seconds'
echo 'LIMIT: Simulator has no camera. Physical photo capture still requires device acceptance.'
xcrun simctl terminate "$UDID" "$BUNDLE"
