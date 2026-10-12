# Scorecard 2.30.1-android.1 — Fire HD 8 backup routing repair (2026-10-12)

## Device finding
- **FAIL (user-confirmed):** In the first Scorecard Android APK on Fire HD 8, tapping **Save it somewhere** launched the Android Share chooser but did not offer a direct file save. User could not confirm a backup in Downloads.
- This means the user-facing backup workflow was NOT working as intended, even though the earlier unit tests passed.

## Root-cause path and correction
- The old platform adapter took a snapshot of `window.Capacitor` when its module loaded. The Android branch also required both `isNativePlatform()` and `getPlatform() === "android"`. If the bridge was late or one probe unavailable, the backup path could fall into the existing iOS/web Share handling.
- The new adapter reads the live bridge on each use, accepts the explicitly Android-only `ScorecardAndroid` plugin as native Android evidence, and recognizes Android WebViews loading packaged files from `localhost`. The native host fallback is **fail-closed**: missing native Downloads plugin gives a visible error rather than a Share chooser.
- In the actual backup sheet, Android now shows **Save backup to Downloads** and clear platform-specific help. The handler **requires** a native `saved: true, location: Downloads` result; it displays an inline error if unavailable or failed, and reports the file's actual saved name on success. It never treats an Android Share operation as a saved backup.
- The Android-only native Downloads writer from the initial release is retained; it follows the proven Fairpot Fire OS MediaStore implementation and preserves the same permanent signing key. The iOS Share and web browser paths are unchanged.

## Deterministic tests added
- Regression harness loads the real `platform.js` and executes the actual backup sheet and `saveBackup()` handlers extracted from `app.js` with controlled native-plugin stubs.
- Checks Android normal save, missing plugin, rejected save, missing `getPlatform`, stale platform report, and delayed bridge injection. Verifies Share is never called for any Android save.
- Checks missing Android bridge on native `http://localhost` produces a visible no-save error, and the iOS path still opens Share.
- Retain all Scorecard V1–V6 checks, APK signing verification, and automatic artifact publication. No bypass.

## Release and testing
- Android-only app version: `2.30.1-android.1`. Monotonic Android versionCode comes from GitHub Actions build run number, so install the updated APK **over** the previous app.
- Scope: only `scorecard/android` files; no changes to Scorecard `main`, `v2`, `ios`, Firebase backend/rules/data, or Fairpot and Cloud Files.
- Real Fire HD 8 device retest is REQUIRED: tap **Save backup to Downloads**, verify **no Share chooser** and a non-empty `scorecard-*.txt` file in Downloads. Do not declare backup PASS based only on CI.
