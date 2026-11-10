#!/usr/bin/env bash
# Shared project preparation for simulator checks and the signed release.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
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
python3 build/ios/camera-permission.py configure "$PLIST"
# Export compliance (spec: Encryption answer): the first release uses only the
# HTTPS built into iOS — exempt. The audit (A7) enforces it.
plutil -replace ITSAppUsesNonExemptEncryption -bool NO "$PLIST"
# Item 12 (Willy, 5 Nov 2026): the app's own link name, so the join page can
# offer a real "Open in The Scorecard" button in any browser (Chrome, Gmail),
# as Android already has. thescorecard://join/?<the same query> carries the
# same link; the app reads it exactly like the https one.
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" \
  -c "Add :CFBundleURLTypes:0 dict" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLName string io.github.willyros01.scorecard" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string thescorecard" "$PLIST"

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

