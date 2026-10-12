#!/usr/bin/env bash
# Scorecard Android test APK — shared app source, isolated native adapter.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
echo "Running Scorecard V1–V6 package and application source checks"
bash build/verify.sh
node build/test-android.cjs
npm install --no-save --package-lock=false --no-audit --no-fund @capacitor/android@8.5.2
rm -rf www
mkdir -p www
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line//[[:space:]]/}"
  [ -n "$line" ] || continue
  mkdir -p "www/$(dirname "$line")"
  cp -R "${line%/}" "www/${line%/}"
done < build/www-files.txt
test -s www/index.html
test -s www/firebase-config.js
test -s www/vendor/firebase/firebase-10.12.0.js
npx cap add android
npx cap sync android
bash build/android-native.sh
java build/AndroidIcons.java android/app/src/main/res
# Use monotonic GitHub run_number for reliable Android update ordering.
export SCORECARD_ANDROID_BUILD="${GITHUB_RUN_NUMBER:-1}"
python3 - <<'PY'
import os, pathlib, re
file=pathlib.Path('android/app/build.gradle')
s=file.read_text()
assert re.search(r'(?m)^\s*versionCode\s+\d+\s*$',s), 'Unexpected Gradle versionCode'
n=int(os.environ['SCORECARD_ANDROID_BUILD'])
assert 1<=n<=2100000000
s=re.sub(r'(?m)^(\s*versionCode\s+)\d+(\s*)$',lambda m:m.group(1)+str(n)+m.group(2),s,count=1)
version=re.search(r'APP_VERSION\s*=\s*"(\d+\.\d+\.\d+)(?:-[A-Za-z0-9.-]+)?"',pathlib.Path('version.js').read_text())
assert version, 'Scorecard version.js lacks release version'
s=re.sub(r'(?m)^(\s*versionName\s+)"[^"]+"',lambda m:m.group(1)+'"'+version.group(1)+'"',s,count=1)
file.write_text(s)
print('Scorecard Android versionCode:', n, 'versionName:', version.group(1))
PY

bash build/android-sign.sh
trap 'rm -f android/app/sc-sign.p12 android/app/sc-sign.gradle' EXIT
cd android
chmod +x ./gradlew
./gradlew --no-daemon assembleDebug

APK=app/build/outputs/apk/debug/app-debug.apk
test -s "$APK"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
test -n "$SDK"
SIGNER="$(find "$SDK/build-tools" -name apksigner -type f | sort -V | tail -1)"
test -n "$SIGNER"
"$SIGNER" verify --verbose --print-certs "$APK"
ACTUAL="$("$SIGNER" verify --print-certs "$APK" | sed -n 's/^.*certificate SHA-256 digest: *//p' | head -1 | tr 'A-F' 'a-f')"
EXPECTED="$(keytool -list -v -keystore app/sc-sign.p12 -storetype PKCS12 -storepass "$SCORECARD_ANDROID_PASSWORD" -alias scorecard | sed -n 's/^[[:space:]]*SHA256: *//p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')"
test -n "$ACTUAL" && test "$ACTUAL" = "$EXPECTED" || {
  echo "::error title=Signer mismatch::Scorecard APK signer differs from configured permanent key"
  exit 1
}
echo "Verified Scorecard APK certificate SHA256: $ACTUAL"
sha256sum "$APK"
