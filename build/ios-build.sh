#!/usr/bin/env bash
# The Scorecard — build the iPhone app and upload it to TestFlight.
#
# Run by .github/workflows/ios-testflight.yml on a GitHub Mac, by itself,
# whenever a push to the ios branch changes the version number in version.js.
# Based on Fairpot's proven build script. Every line of output goes to the log
# the workflow saves on the ci-logs branch.
#
# Needs (GitHub repository secrets): ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8,
# APPLE_TEAM_ID — and RUN_NUMBER, the build number, rising every run.

set -Eeuo pipefail
cd "$(dirname "$0")/.."

for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 APPLE_TEAM_ID; do
  if [ -z "${!v:-}" ]; then
    echo "::error title=Build not started::The Apple secret $v is not set in the scorecard repo yet."
    echo "RESULT: not started — the Apple secret $v is not set yet."
    exit 1
  fi
done

TMP="${RUNNER_TEMP:-/tmp}"
APP_VERSION_FULL="$(node -e 'global.self={};require("./version.js");console.log(self.APP_VERSION)')"
VERSION="$(printf '%s' "$APP_VERSION_FULL" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
[[ -n "$VERSION" ]] || { echo "RESULT: version.js has no X.Y.Z version ($APP_VERSION_FULL)"; exit 1; }
BUILD="${RUN_NUMBER:-1}"
echo "Building The Scorecard $APP_VERSION_FULL as version $VERSION, build $BUILD"

echo "--- 1. npm ci and 2. build checks V1-V6"
bash build/verify.sh

echo "--- 3. Collect the web files into www/"
rm -rf www && mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"; line="${line//[[:space:]]/}"
  [[ -n "$line" ]] || continue
  mkdir -p "www/$(dirname "$line")"
  cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
find www -type f | sort

echo "--- 4. Capacitor: generate the iOS project (fresh every build) and sync"
rm -rf ios
npx cap add ios
npx cap sync ios

echo "--- Project settings: privacy manifest, entitlements, Info.plist"
cp build/ios/PrivacyInfo.xcprivacy ios/App/App/PrivacyInfo.xcprivacy
cp build/ios/App.entitlements ios/App/App/App.entitlements
ruby -e 'require "xcodeproj"' 2>/dev/null || gem install xcodeproj --user-install --no-document
ruby build/ios/configure.rb
PLIST=ios/App/App/Info.plist
plutil -replace CFBundleDisplayName -string "The Scorecard" "$PLIST"
# Export compliance (spec: Encryption answer): the first release uses only the
# HTTPS built into iOS — exempt. The audit (A7) enforces it.
plutil -replace ITSAppUsesNonExemptEncryption -bool NO "$PLIST"

echo "--- App icon and launch image"
ICONSET=ios/App/App/Assets.xcassets/AppIcon.appiconset
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
cp resources/icon.png "$ICONSET/AppIcon-1024.png"
cat > "$ICONSET/Contents.json" <<'JSON'
{
  "images": [
    { "filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" }
  ],
  "info": { "author": "xcode", "version": 1 }
}
JSON
SPLASH=ios/App/App/Assets.xcassets/Splash.imageset
if [ -d "$SPLASH" ]; then
  rm -f "$SPLASH"/*.png
  cp resources/splash.png "$SPLASH/splash.png"
  cat > "$SPLASH/Contents.json" <<'JSON'
{
  "images": [
    { "idiom": "universal", "filename": "splash.png", "scale": "1x" },
    { "idiom": "universal", "filename": "splash.png", "scale": "2x" },
    { "idiom": "universal", "filename": "splash.png", "scale": "3x" }
  ],
  "info": { "author": "xcode", "version": 1 }
}
JSON
fi

echo "--- App Store Connect key"
mkdir -p "$TMP/keys"
KEY="$TMP/keys/AuthKey_${ASC_KEY_ID}.p8"
printf '%s\n' "$ASC_KEY_P8" > "$KEY"
trap 'rm -rf "$TMP/keys"; cp "$TMP/xcodebuild.log" xcodebuild.log 2>/dev/null || true' EXIT
AUTH=(-allowProvisioningUpdates
      -authenticationKeyPath "$KEY"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

echo "--- Check the Apple key is accepted"
KEY="$KEY" node build/asc.mjs preflight

echo "--- 5. Set the version, 6. archive (signed for distribution at export, as Fairpot does: no devices needed)"
xcodebuild archive \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$TMP/App.xcarchive" \
  "${AUTH[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY="-" \
  AD_HOC_CODE_SIGNING_ALLOWED=YES \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  > "$TMP/xcodebuild.log" 2>&1 || { tail -n 80 "$TMP/xcodebuild.log"; echo "RESULT: failed at archive and sign"; exit 1; }
tail -n 5 "$TMP/xcodebuild.log"

export_options(){ # destination
  cat > "$TMP/ExportOptions-$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$1</string>
  <key>teamID</key><string>${APPLE_TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
}

echo "--- 7. Audit the finished, distribution-signed app (A1-A7). No upload unless it passes."
export_options export
xcodebuild -exportArchive -archivePath "$TMP/App.xcarchive" -exportOptionsPlist "$TMP/ExportOptions-export.plist" \
  -exportPath "$TMP/export" "${AUTH[@]}" >> "$TMP/xcodebuild.log" 2>&1 \
  || { tail -n 60 "$TMP/xcodebuild.log"; echo "RESULT: failed at export for the audit"; exit 1; }
IPA="$(find "$TMP/export" -name '*.ipa' | head -1)"
bash build/audit-archive.sh "$IPA" "$TMP/audit" | tee audit-report.txt
[[ "${PIPESTATUS[0]}" -eq 0 ]] || { echo "RESULT: failed the archive audit — not uploaded"; exit 1; }

echo "--- 8. Upload to TestFlight"
export_options upload
xcodebuild -exportArchive -archivePath "$TMP/App.xcarchive" -exportOptionsPlist "$TMP/ExportOptions-upload.plist" \
  -exportPath "$TMP/upload" "${AUTH[@]}" >> "$TMP/xcodebuild.log" 2>&1 \
  || { tail -n 60 "$TMP/xcodebuild.log"; echo "RESULT: failed at upload"; exit 1; }
echo "::notice title=Uploaded::The Scorecard $VERSION build $BUILD sent to App Store Connect."

echo "--- 9. Test Information and What to Test"
KEY="$KEY" VERSION="$VERSION" BUILD="$BUILD" node build/asc.mjs notes \
  || echo "::warning title=Notes not filled::The build is uploaded, but Test Information or What to Test could not be filled. See the log."

echo "RESULT: success — The Scorecard $VERSION build $BUILD uploaded to TestFlight."
