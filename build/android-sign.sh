#!/usr/bin/env bash
# Persistent Android APK signing for the isolated scorecard/android branch.
# Secrets MUST be supplied by GitHub Actions. No fallback to a new debug key.
set -euo pipefail
umask 077

: "${SCORECARD_ANDROID_KEYSTORE_BASE64:?Missing GitHub secret SCORECARD_ANDROID_KEYSTORE_BASE64}"
: "${SCORECARD_ANDROID_PASSWORD:?Missing GitHub secret SCORECARD_ANDROID_PASSWORD}"

APP="android/app"
test -f "$APP/build.gradle"
STORE="$APP/sc-sign.p12"
printf '%s' "$SCORECARD_ANDROID_KEYSTORE_BASE64" | base64 --decode > "$STORE"
chmod 600 "$STORE"
test -s "$STORE"

if ! keytool -list -keystore "$STORE" -storetype PKCS12 \
     -storepass "$SCORECARD_ANDROID_PASSWORD" -alias scorecard >/dev/null 2>&1; then
  echo "::error title=Android signing invalid::Secret keystore/password/alias mismatch"
  exit 1
fi

cat > "$APP/sc-sign.gradle" <<'GRADLE'
android {
    signingConfigs {
        scorecardPermanent {
            storeFile file("sc-sign.p12")
            storePassword System.getenv("SCORECARD_ANDROID_PASSWORD")
            keyAlias "scorecard"
            keyPassword System.getenv("SCORECARD_ANDROID_PASSWORD")
            storeType "PKCS12"
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.scorecardPermanent
        }
    }
}
GRADLE

if ! grep -Fq 'apply from: "sc-sign.gradle"' "$APP/build.gradle"; then
  printf '\napply from: "sc-sign.gradle"\n' >> "$APP/build.gradle"
fi
echo "Stable Android signing configuration verified; private key stays in runner."
