## NEXT BUILD after the development freeze — course deletion (Willy, 16 Oct 2026)

Approved by Willy on 16 Oct 2026, for all three versions (web, iPhone, Android); build only once he lifts the freeze. Full spec in HANDOFF-v2.md on the v2 branch (same heading): admin-only course deletion enforced by the rules, posted rounds and handicaps preserved, The Marker must not recreate a deleted course, hand-entered courses still acceptable. Decided by Willy (16 Oct): a delete applies to all groups and withdraws the course for good: kept only because posted rounds point to it, marked `withdrawn: true`, never used, edited or restored again (a replacement is a new course). No recalculation: posted rounds stay as they are (Willy, 16 Oct).

## NEXT BUILD after the development freeze — verified scorecard pictures (Willy, 16 Oct 2026)

Decided by Willy, for all three versions; build only once he lifts the freeze. Full spec in HANDOFF-v2.md on the v2 branch (same heading). In short: course details from a verified picture of the club's scorecard replace the golf course database's version; a differing rating/slope automatically recalculates posted rounds' differentials and every affected golfer's index; game results stay as played and corrected rounds show * with an explanation; only signed-in accounts' pictures count; database figures contradicted = correction, verified figures contradicted = re-rating (no recalculation); every correction recorded and undoable.

---

## 2026-10-15 — Current Scorecard Android acceptance/status summary

**Owner-confirmed physical Fire HD 8 acceptance on 12 October:** `scorecard/android` version **2.30.1**, signed build **38320762144**, working installation/in-place update, regular sign-in/sign-out, restored group/history and ranking/index views, large text, portrait/landscape, Home/resume, online reconnect, and downloaded/opened/inspected backup TXT. Admin cockpit, role/member management visibility and Owner-only controls were checked without changing another member's role. Owner concluded this Android version was working for regular use.

**Unverified/not certified:** posting/editing/deleting scores and recalculation, offline queued writes, invitation/deep link flows, mutation of live member/role permissions, exhaustive Android phone models and App Store/Play release. Do not claim all regression cases passed. **No repeat of already accepted device checks unless a subsequent build changes their functionality.**

**Separation:** Android adapter changes are isolated to `android`; `v2` is the current iOS/App Store build-24 source, `main` is protected web, `ios` is an older iOS snapshot. Preserve Firebase `scorecard-f41b8`, rules/indexes, production records, signed APK identity and same-origin Cuberoot distribution. The owner's current development freeze allows documentation/testing records only until a specific build is authorized.

---

# Scorecard Android — build, release and functional parity plan
Date: 2026-10-12. Source version: 2.30.0. Base branch: `v2` at commit `994bd9a7cd4d80db84557827102cb877ab645683`.

## Branch and release boundaries
- Existing repository `willyros01/scorecard`; new branch `android` only, no new repository.
- `main` = live website; `v2` = current iOS/App Store release source; `ios` = older iOS path. **All remain untouched.**
- Android is a separate native shell over the same Scorecard app data logic, using `platform.js` to implement platform differences. Never blindly merge platform-native changes into web/iOS. Full functional parity is the requirement, not identical source files.
- Firebase `scorecard-f41b8`, `firestore.rules`, indexes, users, games, rounds, notifications, and backend data remain unchanged. No account, roster, or data cleanup is authorized by Android builds.
- Treat the existing iOS/App Store version and release automations as protected. Do not start or change TestFlight workflows during Android development.

## Android functionality and adapters
- Package ID `io.github.willyros01.scorecard`; app label `The Scorecard`. App version from the one authoritative `version.js`.
- Android app packages the **exact same web code and pinned Firebase bundle** from `build/www-files.txt` used for iOS. The Android wrapper is ephemeral and built only in the CI runner.
- `platform.js`: preserves native iOS and browser paths; `isAndroid()` uses the Capacitor platform. `ScorecardAndroid.saveToDownloads()` writes backup TXT/JSON/CSV directly into public Downloads on Fire OS, refusing fallback to Share on an error. Android 10+ uses MediaStore + pending/finalize; Android 9 and older uses permission-controlled Downloads.
- `ScorecardAndroid.openExternal()` opens approved HTTPS/HTTP/mailto/SMS links with an OS VIEW Intent **without calling resolveActivity()** (the Cloud Files Fire HD 8 bug). It never embeds a Cuberoot link or Apple/Firebase credentials into a second WebView. Missing handler produces a real error.
- Native App Links: `https://www.cuberoot-systems.com/scorecard/join/?join=...` matched in manifest; Cuberoot `.well-known/assetlinks.json` binds the host to Android package and permanent signing certificate. Existing iOS AASA left untouched. `platform.initLinks()` and `platform.onLink()` remain the single invitation processing path, preserving one-use enforcement.
- iOS App Store installation text remains in the invite; Android/Fire installation instructions appear only for Android senders.
- Existing A, A+, A++, appearance and responsive UI controls preserved. Real tablet layout/keyboard acceptance needed before declaring parity.
- Android launcher icons generated via `build/AndroidIcons.java` from the existing green flag / golf-ball icon design in `icon.svg`.

## Build and signing
- `build/android-build.sh` runs existing Scorecard `build/verify.sh` checks V1-V6: pinned npm lock, exact versions, byte-identical Firebase bundle, no imported remote code, Capacitor consistency, and Firebase exports. It also runs isolated `build/test-android.cjs` native adapter regression tests.
- To keep the existing `package.json`, `package-lock.json`, and `build/approved-versions.json` intact, Android CI installs **exact** `@capacitor/android@8.5.2` transiently with `--no-save --package-lock=false` AFTER the main V1–V6 verification. Packaging uses `npx cap add android`, `npx cap sync android`; it must use the app's existing Firebase bundle, not a new source of truth.
- Android Gradle `versionCode` comes from monotonic GitHub `GITHUB_RUN_NUMBER` for update compatibility; `versionName` is parsed from `version.js`.
- Permanent private RSA PKCS12 signing key alias `scorecard`. Keystore generated outside the Git repository; **NEVER commit, print, email, or publish it**.
- The owner must set two GitHub Actions repository secrets in **scorecard**:
  - `SCORECARD_ANDROID_KEYSTORE_BASE64` — contents of private `sc-key64.txt`.
  - `SCORECARD_ANDROID_PASSWORD` — contents of private `sc-pass.txt`.
- Private key backup archive `sc-key.zip` contains `sc-key.p12`, `sc-pass.txt`, `sc-key64.txt`, `README.txt`. It is **NOT encrypted** and must be stored privately in two safe places; no public GitHub upload.
- Certificate SHA256: `40744e5063932de66831717aeb3deea647e681d96e11f7c96434c30cdfef5386` (colons can be inserted every two hex digits for device verification).
- `build/android-sign.sh` decodes the GitHub Action secret only on the ephemeral runner, requires alias/password, configures stable debug APK signing, and fails closed if unavailable. `apksigner` verifies final certificate against `keytool`.
- The APK is a **test/debug build**, not a Google Play production release. Play Store launch separately approved.

## Automated build and Cuberoot APK publication
- `.github/workflows/android-apk.yml` runs on Android branch changes, checks adapter/icons/scripts, and builds only when signing secrets are valid. Result written `build/android-last-run.json` from a dedicated report job, with exact build SHA, artifact and success/failure.
- `willyros01/Cuberoot/main` holds an independent `.github/workflows/publish-scorecard-apk.yml` and `build/publish-scorecard.sh` polling for a confirmed successful artifact. It downloads and verifies the *exact built APK* and never rebuilds or resigns it.
- Publisher creates `downloads/scorecard.apk`, `downloads/scorecard.apk.sha256`, `downloads/scorecard-build.json`. It refuses a signer change once an APK has been published. Failed builds never replace the previous APK. GitHub Pages deployment must pass.
- The public Scorecard app card adds a **same-domain Android download** only when the APK and verified metadata exist, adding `?build=<run_id>` to prevent Silk's stale APK caching. It never shows the GitHub repo URL.
- The public large-print user guide is at `guides/the-scorecard/android-quick-start.html`, indexed in Cuberoot's existing `guides/index.json` and Scorecard docs page. Existing web/iOS guides remain intact.

## Required Fire HD 8 / Android acceptance (not yet device-tested)
1. Install signed APK from Cuberoot, check icon, starting screen, version label, text size A/A+/A++, day/night and portrait/landscape.
2. Sign in with an existing controlled test account. Confirm account recovery and logout; cold start and background return must not cause hangs or duplicate accounts.
3. Check member/admin/owner access with authorized test accounts only; verify regular user privacy: own rounds, games participated, group directory name/index only. Never exercise production administrative changes to pass an automated test.
4. Enter a *test* round with known scores; verify History, handicap calculation, group rankings and relevant game leaderboard. If using real Firebase, agree on test records before writing.
5. Disable Wi-Fi, queue a test operation, reconnect, prove exactly-once synchronized write and no duplicate rounds; preserve data on restart.
6. Create an invitation using a disposable test token and verify Cuberoot Android App Link opens correct join screen; do not consume a real outstanding invitation. One-use enforcement and login-after-logout.
7. Open user guide, privacy, support, and report-email links; confirm Fire Silk and email app launch without a false “no external browser” error.
8. Export backup to Downloads: verify a non-empty file on the device, valid JSON data inside TXT, and no Share chooser; test import only with a SAFE disposable data set after reviewing replace/merge semantics.
9. Install a **later APK signed with the same key** over the existing installation without uninstalling, verify account state, preferences and history.
10. Compare Scorecard Android release artifact metadata/signing SHA and Cuberoot deployed APK checksums; log real device PASS/FAIL in this document.
11. Test Firebase email/password accounts and authorized domain/redirect behavior in Android WebView, one-time invitations, offline queue, App Links and any app review acceptance items. Source presence is not a pass.

## Status as of 2026-10-12
- Branch `android` created from `v2`; no web/iOS/Firebase source or backend changed.
- Android platform adapters, manifest App Links, icons, regression tests, pinned build scripts, CI reporting, permanent key and signing workflow prepared.
- Cuberoot automatic Scorecard APK publisher, gated download button and Android quick guide prepared.
- APK signing secrets and real-device functional acceptance **pending**. Never say Android is production-ready until the signed APK succeeds and device tests pass.

## Automated pre-signing validation result — 2026-10-12
- GitHub Actions Scorecard Android workflow run **38316868374**, check job completed SUCCESSFULLY. The real source tests passed: Android native Downloads and Fire OS browser adapter, iOS Share/web fallback, generated Android App Links manifest, launcher assets, and shell-script syntax.
- Shared Scorecard verification **V1–V6 all passed**: exact package-lock, pinned approved dependency versions, deterministic offline Firebase bundle, no imported remote code in 19 packaged files, matching Capacitor versions, and complete Firebase module exports.
- Signed APK build job intentionally reports FAILURE at **Require permanent Android signing secrets** until the user creates `SCORECARD_ANDROID_KEYSTORE_BASE64` and `SCORECARD_ANDROID_PASSWORD` under GitHub Actions secrets. Do NOT weaken/bypass this gate.
- Cuberoot Pages deployment of the public Scorecard Android guide and verified-download UI passed; `downloads/scorecard.apk` must not be advertised until a verified signed build is published. Device tests still outstanding.


## Signed Android APK and automatic website publication — 2026-10-12
- User requested APK build and automatic Cuberoot upload (same as Fairpot and Cloud Files).
- GitHub Actions `Scorecard Android APK test build` run **38316868374** re-run attempt **2** completed successfully after the user configured permanent signing secrets. Adapter/launcher checks, V1–V6 pinned application validations, Gradle Android build, signing check, artifact upload, and result-report job all passed.
- Successful build report `build/android-last-run.json`: branch `android`, source SHA `cafc8ed3d5053f1190672d7575180a6ce0bc08da`, run `38316868374`, artifact `scorecard-android-test-apk` ID `11776788439`. Build log reports `BUILD SUCCESSFUL`.
- Signed APK SHA256 **`3eff653c3cc7ce0c7e10b4e17aff58274a4a986e7b5d7915d4dbfddddabe3a3b`**, permanent signing certificate SHA256 **`40744e5063932de66831717aeb3deea647e681d96e11f7c96434c30cdfef5386`**. Certificate matches private key backup fingerprint. Exact APK has Android package ID `io.github.willyros01.scorecard`.
- **Automatic Cuberoot publisher passed:** GitHub Actions `Publish Scorecard Android APK` run **38318270589** fetched exactly the signed APK artifact, verified signature and hash, committed `downloads/scorecard.apk`, `downloads/scorecard.apk.sha256`, and `downloads/scorecard-build.json` with matching source/run/artifact/signature/checksum. Publisher does not rebuild or resign; future successful builds are polled automatically.
- **Cuberoot GitHub Pages deployment passed:** run **38318293096**, build/report/deploy all successful.
- Public APK URL **`https://www.cuberoot-systems.com/downloads/scorecard.apk?build=38316868374`**. Cuberoot apps UI displays Download Android APK only after both published metadata and APK exist.
- **Status:** CI signing/build/publisher/Pages PASS; **Fire HD 8 functional/device validation NOT YET performed**. Test startup, Firebase email/password login, A++ fonts, role/privacy checks, invitation links, external browser, offline queue, history/rounds, backup directly to Downloads, and later in-place upgrades. Do not claim functional parity until confirmed on device.
- **Change boundaries maintained:** Only `scorecard/android` docs/build source and `Cuberoot/main` publication files changed; Scorecard `main`, `v2`, `ios` and live Firebase remained unchanged.

## Fire HD 8 device acceptance — login and existing records
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 on Fire HD 8 displays Owner-only role management controls (Make admin / Make guest) for another member. No member roles were changed. This verifies control visibility, NOT server-side permission enforcement.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 Owner Settings on Fire HD 8 shows Group, Backup, Course lookup, and Account sections, and all four open without errors. Read-only Owner interface verification only; settings were not changed, and server-side permissions were not tested.
- **PASS (user-confirmed 2026-10-12):** In Scorecard Android 2.30.1 on Fire HD 8, the active account displays its role as **Owner** in Admin → Members. This confirms displayed role identity only; no Owner-only modifications or backend enforcement have been exercised.
- **PASS (user-confirmed 2026-10-12):** On Scorecard Android 2.30.1 on Fire HD 8 with their Owner/Admin account, Cockpit and Members screens open, member roles are visible, and management controls are displayed. This is a READ-ONLY administrative UI visibility check; no member was changed or removed, and server-side permission enforcement has NOT been tested.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 on Fire HD 8 successfully logs out and signs back into the existing account; the user's golf group and existing records reappear correctly after reauthentication. This confirms the basic logout/login and data reload flow, not multiple accounts or account recovery.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 backup file was independently checked on Fire HD 8: the saved TXT exists in Downloads, opens successfully, and contains data. Backup restore was NOT performed. This closes the earlier file existence/content verification gap.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 on Fire HD 8 displays an existing round correctly in portrait and landscape orientations; text, controls, and scores remain readable, and the current round remains visible after rotation. This is a user-observed screen-rotation test, not a device-wide orientation audit.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 on Fire HD 8 resumes correctly after pressing the tablet's Home button, waiting briefly, and returning to the app; the previously open existing round remains visible. This verifies background/resume screen preservation, not a cold start after process termination.
- **PASS (user-confirmed 2026-10-12):** On Scorecard Android 2.30.1 on Fire HD 8, pressing Back from an external link in the Fire browser returned to Scorecard with the previous app screen intact. This confirms browser-return navigation; other deep-link and invitation flows remain untested.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 on Fire HD 8 retains Dark Mode selection after fully closing and reopening the app. This confirms local Appearance preference persistence across app restart; it does not test persistence after reinstall.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 on Fire HD 8 retains A++ text-size selection after fully closing and reopening the app. This confirms preference persistence across an app restart; it does not test a device restart or reinstall.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 on Fire HD 8 displays the group Members/Players list with member names and handicap indexes correctly. This verifies visible existing member data, not editing members, role enforcement, or handicap calculation.
- **PASS (user-confirmed 2026-10-12):** Scorecard Android 2.30.1 on Fire HD 8 displayed the New Round entry screen correctly, including course, date, and score-entry fields. The user did not save or submit a round. This verifies screen display only, not score submission or calculations.
- **PASS (user-confirmed 2026-10-12):** Fire HD 8 Scorecard Android 2.30.1 successfully reconnected after Wi-Fi was restored and the app reopened. Golf group, History, and rankings all remained visible and correct. This verifies post-offline reconnection and read continuity, not offline edits or queued-write synchronization.
- **PASS (user-confirmed 2026-10-12):** On Scorecard Android 2.30.1, an existing History round remained readable on Fire HD 8 after Wi-Fi was turned off. This verifies offline read of previously available data only, NOT offline score changes, queued writes, or later synchronization.
- **PASS (user-confirmed 2026-10-12):** External links from Scorecard Android version 2.30.1 open correctly in the Fire HD 8 browser.
- **PASS (user-confirmed 2026-10-12):** A++ large text on Fire HD 8 is readable on all tested screens, with no overlapping buttons or cut-off information.
- **PASS (user-confirmed 2026-10-12):** The user's handicap index and group rankings display correctly on Scorecard Android Fire HD 8.
- **PASS (user-confirmed 2026-10-12):** The Scorecard Android APK installed and opened on Fire HD 8; user reports appearance looks very good.
- **PASS (user-confirmed 2026-10-12):** Sign-in with their existing Scorecard account works; their golf group and existing records are visible.
- **PASS (user-confirmed 2026-10-12):** History opens on Scorecard Android Fire HD 8, and the selected existing round shows the correct date, course and score.
- These confirmations cover startup/visual appearance, sign-in, initial read of existing records, offline viewing of a previously available History round, and separately confirmed working backup. They do **not** yet prove posting a new round, permissions, offline write queues and synchronization, invitations, handicap recalculation, or other user flows. Continue functional acceptance separately without changing production data unnecessarily.

## Fire HD 8 BACKUP failure and repair — 2026-10-12
- **PASS (user-confirmed):** On Scorecard Android 2.30.1 on Fire HD 8, backup now works after installing the updated APK over the existing app. This closes the previously reported backup failure; the saved file was subsequently verified to exist, open, and contain data (see latest acceptance entry).
- **PASS (user-confirmed):** Fire HD 8 now reports Scorecard version 2.30.1 after installing the updated Android APK over the existing installation. **User later confirmed the backup works; inspecting the saved file was not separately confirmed.**
- **BACKUP SAVE FAIL (user-confirmed):** On initial Android APK build `38316868374`, choosing **Save it somewhere** opened Android Share and did not provide a local file save option. **The previous backup test was not a PASS.**
- Investigation of `app.js` and `platform.js`: Share can be reached if Android native detection fails. Previous adapter captured `window.Capacitor` once at module initialization and required both `isNativePlatform` and `getPlatform` to succeed before using the Android Downloads plugin.
- **Android-only repair:** dynamically query the live Capacitor bridge; use the registered `ScorecardAndroid` plugin as definitive Android evidence; recognize packaged Android localhost WebView and fail closed if the native plugin is missing. The actual backup sheet now labels the button **Save backup to Downloads**, reports the exact saved filename, and visibly reports errors without invoking Share.
- Add deterministic tests of real backup sheet and `saveBackup()` handlers as well as delayed bridge/missing `getPlatform`/misreported platform/no-plugin cases and untouched iOS Share behavior. See `build/RELEASE-ANDROID-2.30.1.md`.
- **Device verification (user-confirmed PASS):** On updated Fire HD 8 version 2.30.1, the user reported backup works. The file was subsequently confirmed to exist in Downloads, open successfully, and contain data. No restore was tested. Previously passed login, history, handicap, rankings and A++ tests remain recorded.


## Fire HD 8 backup repair APK published — 2026-10-12
- **Automated Android build run `38320762144` SUCCESS:** checks, generated Android-only native marker, actual backup UI regression tests, original Scorecard V1–V6 checks, Gradle APK compilation, signed APK verification and artifact upload succeeded. App shows `2.30.1-android.1`; Android APK versionName `2.30.1`; monotonic versionCode `14`.
- **Source commit `aae5116407ed07dd2081c072bc7e83485fb6b5e7`.** Signed build artifact ID `11778477150`. APK SHA256 `40e391cc0f65f10ae67d6d25bc1c6368a4e67e8a47c89c8d43485a1d75601289`. Certificate SHA256 `40744e5063932de66831717aeb3deea647e681d96e11f7c96434c30cdfef5386` matches initial Scorecard APK; in-place upgrade supported.
- **Cuberoot automatic publisher `38321106608` SUCCESS:** exact artifact downloaded, verified and published to `downloads/scorecard.apk` with identical source SHA, artifact ID, APK hash and signer SHA in `downloads/scorecard-build.json`.
- **Cuberoot Pages build and deploy `38321200343` SUCCESS** after public guide updated to version 2.30.1-android.1 and website availability changed to Android test APK available.
- **Replacement download:** `https://www.cuberoot-systems.com/downloads/scorecard.apk?build=38320762144`
- **Real-device backup retest PASS (user-confirmed):** After installing the updated Scorecard 2.30.1 APK over the existing Fire HD 8 app, the user reports the backup works. The user later confirmed the file exists in Downloads, opens, and contains data. No restore was tested.

## Android Fire HD 8 owner acceptance — 2026-10-12
- **USER ACCEPTED FOR REGULAR USE:** The owner concluded that the Android version is working after the recorded Fire HD 8 acceptance tests. This is **practical device acceptance for the verified workflows**, not a claim of complete feature parity or exhaustive security testing.
- **Accepted app baseline:** The Scorecard Android **2.30.1** (`scorecard/android`), signed APK build **38320762144**, exact SHA256 **`40e391cc0f65f10ae67d6d25bc1c6368a4e67e8a47c89c8d43485a1d75601289`**, published via the automatic Cuberoot publisher. Preserve this successful installable release; do not change live Scorecard web/iOS/Firebase to mark acceptance.
- **Confirmed functional paths:** Install and in-place update, login/logout, group membership and existing records, History scores and dates, handicap/index/rankings display, visible new-round entry form without saving, downloaded backup TXT existence and readability, external browser links and Back, offline read and subsequent reconnect, app Home/resume, portrait/landscape, A++ and Dark Mode with preference persistence, Owner identity, Cockpit/Members/Settings displays, and Owner role-control visibility without changing permissions.
- **Not yet certified:** Posting/editing/deleting rounds and subsequent handicap recalculation; offline queued write and sync; invitations and deep links; actual member/role changes and Firebase authorization enforcement; restore from backup; regular-member privacy restrictions; comprehensive multi-account/multi-device testing. Do not label these PASS on current evidence.
- **Governance:** This is a documentation-only acceptance note, no app code change, no new APK, no changes to Scorecard `main`, `v2`, `ios`, Cuberoot or Firebase. Resume development or these untested areas only on user request.


## NEXT BUILD after the development freeze — commit-rule fixes (Willy, 18 Oct 2026)

Approved for planning by Willy on 18 Oct 2026; build only once he lifts the freeze. Full specification: Claude Doc "The Scorecard — fixes for after the freeze" (https://claude.ai/code/artifact/86482d42-634d-4f9c-9788-abd7ff4f4a65). In short, in this order: (2+3) a round edit or delete, the golfer's window/index/round count and every directory entry in ONE commit with preconditions, outbox queues it as one item (today deleteRoundAndRebuild/updateRound + rebuildGolferIndex are separate saves and the directory is refreshed ~4 s later by an admin's app); (5) load every collection as { ...d.data(), id: d.id } and never look up a course by an empty id; (1) lock the scores of rounds with enteredVia "marker" in the edit screen and in firestore.rules (gross, adjusted, differential, holes, rating, slope, par, courseHandicap, indexAtEntry unchanged) — corrections are made in The Marker (scorer 24 h, owner/admin any time); (4) deleting a game clears gameId on its rounds in the same commit, and a missing game never shows a course name (54 Golfing Buddies rounds point to deleted game msngo2mu2yqef3; one-off clean-up needs Willy's decision).


## MOST IMPORTANT, first after the freeze — invitation opened on a device already signed in (Willy, 18 Oct 2026)

Willy believed this was documented; it was not in these notes. Today: if an invitation link is opened while the app is signed in (e.g. as someone else), joining fails but the invitation is silently marked used — the invited person never gets to set their email and password, and the link is dead for them. AGREED: the app signs out FIRST (before any write), then shows the invitation screen to create email and password; the invitation is marked used only in the SAME commit that creates the account and membership — any failure writes nothing, the invitation stays valid, and the screen says so plainly. Check web, iPhone and Android; the invited person's own account already signed in (say already a member, do not consume); an invitation already lost this way must be resendable (Send again). Tests: signed in as another account → sign out → create-password screen, invitation still valid until the account exists; fault during joining → invitation still valid. Full text: Claude Doc "The Scorecard — fixes for after the freeze".

- Entry-screens plan of 13 Oct 2026 (approval email, invitation on a signed-in device, recovery, deterministic first screen, wording; build 25, resubmit instead of releasing 2.30.0 — Willy's Option A) was never in these notes: it is "scorecard-approval-fix-plan.md" revision 5 (https://claude.ai/artifact/Q5BM51Z9RhwQWKWvtUjmdy), copied in full into the Claude Doc "The Scorecard — fixes for after the freeze" (https://claude.ai/code/artifact/86482d42-634d-4f9c-9788-abd7ff4f4a65), section "Most important". That doc is the master list to use after Apple approves 2.30.0 and Willy lifts the freeze.
