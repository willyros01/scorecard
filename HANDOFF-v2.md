# The Scorecard — Version 2.0 handoff (state at 1 October 2026, afternoon)

Written so that anyone (Claude, ChatGPT or a person) can continue the work. Read it fully before changing anything.

## For deeper discussion — Login on every launch (Willy, 3 October 2026)

Willy is reconsidering whether every ordinary launch should start at Login, with invitation launches as the exception. **Decision deferred; no implementation is approved.** Keep the current saved sign-in behavior until the discussion and an explicit decision. Discuss what counts as a launch (cold start, return from background, navigation back from tools), convenience versus account security, offline use, and invitation routing before choosing any change. This supersedes the earlier instruction to require Login on every launch.

## To do — invitation wording (Willy, 3 October 2026)

- Add an explicit notice to every invitation message: **“This invitation link is for one-time use only. Once you join, it cannot be used again.”** Include it for both Send invitation and Send again, and for member and admin invitations. This is a requested future wording change, not implemented in beta.12.
- Device result reported by Willy on beta.12: invitation opened the invitation login, signing in succeeded, logout returned to the regular login, and reopening the accepted invitation showed it was invalid.

## Latest release: beta.11 (2 October 2026)

Willy approved the invitation fixes and a new TestFlight build. Read `build/RELEASE-beta11.md` for the architecture, test gate, limitations and deployment order; `build/what-to-test.txt` for the device checks. Email prebinding is not required. One-use random token links replace shared-code named/admin URLs. Manual regular-member code entry remains. Account deletion keeps its existing process, with real precheck diagnostics; startup timeouts are marked unknown and retried.

**Deployment confirmed 2 October 2026, 23:30 Toronto:** Willy ran `build/iv1.txt` in Cloud Shell. All 21 live query checks passed, rules/marker were backed up, and the script confirmed the tested rules and one-time invitations are active. The tested beta.11 web files were then merged into main (9e0bada185d93bda960efa217a1a45683c424dbe), retaining the unchanged scheduled deletion job. TestFlight remains 2.30.0 build 16 / 2.30.0-beta.11. Keep the scorecard-iv0-backup folder; `bash iv1.txt verify` checks activation and `bash iv1.txt rollback` restores the saved backend state. A rollback must be coordinated with the matching app/web version. The historical sections below describe earlier releases.

Deployment correction (3 October): the first iv0 attempt stopped at the rounds query check before publishing anything. Its probe parent used a reserved `__.*__` document ID. iv1 uses a permitted parent, pins the corrected inventory separately from the unchanged tested beta.11 rules, and displays Google API error status/message on failure. Both scripts retain the same rollback backup folder. Regression tests reject reserved parents and require the real index error to be printed. No app version or Firebase index was changed by this correction.

## 1. Working rules from Willy (the owner) — always apply

- **Ask before any change he has not approved.** Describe the change, wait for "go". Never assume.
- Replies to Willy: the whole reply as markdown heading lines (large text); no small text or inline code; anything he must type goes in its own copy block.
- Firebase changes are delivered as a shell script file with a 3-character name and `.txt` extension, run with `bash xxx.txt` in Google Cloud Shell on his iPad (he cannot paste there, so keep commands short). The script must switch to project `scorecard-f41b8` before anything else, check before changing, and offer `rollback`.
- Everything lives in the repo `willyros01/scorecard` (no new repos). The Cuberoot repo is for web pages only.
- Never put `firebase-config.js` in a zip. Zips are named with dots, e.g. `scorecard.v2.30.0.zip`.
- The phone number stays out of the public repo.
- Check deliverables thoroughly; he wants no rework.

## 2. Branches

| Branch | What it is |
|---|---|
| `main` | The live web app, served by GitHub Pages. **Version 2.0 since 1 Oct 9:55** (v2 merged into main after go2.txt). Before that 2.21.9 (tag `v2.21.9-live`, the rollback point). Keeps the deletion job (`finish-deletions.yml`). |
| `ios` | **Version 1** of the iPhone/iPad app (2.22.0-ios.5, TestFlight builds 1–5). Its `firestore.rules` are the **rules published today** (rf1.txt, 30 Sep). |
| `v2` | **Version 2.0** (this document). Built on `ios`. Live on the web since 1 Oct (merge into `main`). TestFlight builds come from here from 2.30.0 on. |
| `ci-logs` | Logs saved by every CI run (`logs/checks`, `logs/ops`, `logs/testflight`, `logs/deletions`). Read with `git fetch origin +refs/heads/ci-logs`. |

## 3. What Version 2.0 is (all built and tested on `v2`)

The approved design is "Scorecard Onboarding Privacy Architecture — Revision 2" (R1–R13), plus Willy's decisions of 30 Sep.

- **Phase A — privacy.** A regular member sees only their own rounds, the games they played in (result sheet on the game), and the group ranking/directory (name and index only). Admins and owners see everything in their groups. Nobody reads groups they don't belong to. Golfer records are private (own account, admins of a group listed in the golfer's `groups`, or a single read of an unclaimed golfer for invitations).
- **Phase B — accounts.** Everyone signs in with email and password; no anonymous sign-in. Signed out: Sign in, Apply, "I was given a code". An invitation or code asks to create an account (or sign in) first. An old guest session must "Set your email and password" (same account, keeps everything) or delete itself.
- **Phase C — the PUBLIC group** (id `PUBLIC`, owner Willy). Apply while signed out with full name + email only (`publicApplications/{email}`). Reviewers (admins of PUBLIC, chosen by Willy) approve: a separate Firebase instance creates the account, golfer, roster and directory entries and `publicApprovals/{email}`; Firebase's password-reset email is the invitation. The applicant sets a password, signs in and joins (needs a confirmed email; the reset link confirms it). Reject is possible. Apple 1.2: members "Report or block" names; reports go to the Admin tab (Dismiss / Remove from group); blocks are per account (`userBlocks`). The public group has no invitation links or codes.
- **Phase D — groups and admins (Willy's rules, 30 Sep).**
  - Only Willy creates groups (`groupCreators/{uid}`, written only by the setup script). Everyone else sees "New groups are created by The Scorecard's owner".
  - Willy (owner) keeps full rights in every group — he owns every group because only he creates them. **No "super owner" role; do not add one.**
  - Admins invite **regular members only**; only the owner sends admin invitations (the admin code moved to `associations/{id}/secrets/admin`, owner-only). Only the owner promotes/demotes. Admins may remove regular members of their own group (Admin tab → Members); never the owner or another admin. Admins cannot delete the group.
  - Tidy (`tidy.html`, owner only) keeps its algorithm **unchanged**. Willy chose option B: the group creator may list every golfer. Owners/admins may archive a golfer of their group (fixes Tidy's merge and unused-golfer clean-up, which the live rules refused). Tidy now frees a name only if the claim belongs to the archived record, and its repair step no longer refers to a missing variable (`groups`), which had made the merge and clean-up always fail. **No manual merge** (Willy said no).
- **Rebuild the roster** looks only at the owner's own groups.

Decisions kept from before: free app; Version 1 was to be unlisted; one GolfCourseAPI key; approvals are manual; golfer names are unique (reviewer adds a middle initial); only one set of Firestore rules can be live (no per-app rules — explained to Willy).

### Go-live fixes (1 October, from the external review Willy forwarded on 30 Sep)

1. **No unclaimed-golfer read.** Golfer records are readable only by their own account and the admins of their groups. A named invitation greets the invitee from `associations/{id}/invitations/{golferId}` (name, index, group name, role), written by the owner/admin app when the invitation is sent (admins: member invitations only), read one at a time by id, listed only by the group's admins. The go-live data step creates these records for invitations already sent and not used.
2. **Safe PUBLIC approval.** `pending → approving` (claim, in a transaction: reviewer id, golfer id, golfer name, server time) → account created → one batch (golfer, name claim, roster, directory, `publicApprovals` (rules: only under that reviewer's claim, create once) and `approving → approved`) → password email. Retry by the same reviewer reuses the golfer id ("Finish" button). A second reviewer is refused while the claim is under 10 minutes old. Reject only while pending. "Approved, not joined yet" list with "Send the email again".
3. **Go-live robustness.** Marker `migrations/v2` (no app access): data-started / data-failed / data-done / rules-published / verified / failed / rolled-back, with every admin code saved before it moves. `go2.txt` recovers by itself if the data step, the rules publication or the check fails (old rules back, tried 3 times; admin codes back; marker), and can simply be run again. `bash go2.txt status` shows the marker.

### beta.3 (1 October, approved by Willy from the prototype "Scorecard sign-in prototype")

- **First screen** (signed out): Sign in only (email, password, Sign in, Forgot the password) plus two buttons: **I have a code** and **Become a member or start a group**. The "Used The Scorecard in Safari?" link was removed from it (still in the User guide).
- **I have a code**: the code is typed first, then the account (create or sign in); the code is then filled in on the join screen.
- **Become a member or start a group**: two choices. **Become a member** = the public group application. **Start your own group** = a request for a private group (`groupRequests/{email}`: full name, email, group name, about how many golfers (`golfers`), where they play, note). Both forms show "What happens next" and the **Conditions** (approval at The Scorecard's discretion; Code of Conduct; zero tolerance for objectionable content or abusive behaviour) and are sent only when "I have read and agree to the Code of Conduct and the Privacy policy" is ticked. Declined applicants and requests get **no email** (Willy's decision).
- **Code of Conduct**: `https://www.cuberoot-systems.com/scorecard/conduct/` (Cuberoot repo, `scorecard/conduct/index.html`), `platform.conductUrl()`.
- **Group requests** (Admin tab, only for the group creator): Approve claims the request with a new group id (`pending → approving`), creates the group with that id (Willy owner, not on the roster; a retry finds it and does not make another), marks it `approved`, opens the new group and an email to the organiser with an **admin invitation link** (the existing admin invitation, `invite-nonplayer` style). The organiser taps it, creates an account and joins as the group's admin. Decline (two taps) sends no email.
- Rules: `groupRequests` block in `firestore.rules` (create signed out, one per email; only `groupCreator()` reads, decides, deletes). Published with **`bash rq3.txt`** (`build/rq3.txt`, pinned to the tested commit 747678b; checks the live rules are go2's (752914a) first; recovers by itself; `bash rq3.txt rollback`). Tests: GRQ1–GRQ5 (rules), E15–E17 (app), RQ1–RQ6 (the script), web B1/C5/C7/W1/W5.
- **Order at release:** Willy runs `bash rq3.txt` first, then Claude merges `v2` into `main` (until then a request sent from the web would be refused). TestFlight build of 2.30.0-beta.3 can go any time.

### beta.4 (1 October, approved by Willy: design doc "Scorecard Cockpit Design" + prototype "Scorecard cockpit prototype")

- **Admin tab has four tabs**: Cockpit, Applications, Members, Settings. Every old section moved unchanged: **People → Members (exactly as before; Willy: "very important, cannot change")**, Group / Import / Backup / Course lookup / Account → Settings, Group requests / Applications / Reports → Applications. "Set a password" shows above the tabs. A group admin (not owner) sees Cockpit + Members (+ Applications in the public group).
- **Owner cockpit** (group creator only; `loadOwnerCockpit`: every group, every membership by collection-group query, rounds of the last 6 months by collection-group query on `date`): at a glance, sign-ins (last seen), waiting for you, groups (tap → that group's numbers), rounds per month, housekeeping (quiet groups, groups not owned by Willy, Tidy). **Mini cockpit** for other owners/admins: their group, from data already loaded. **Last seen** = `lastSeenAt` on the member's own membership, stamped by their app at most every 12 hours (counts from beta.4 on).
- **My season** card at the top of Summary for anyone who plays in the group (rounds this year, index now, 6-month trend from this group's rounds).
- **Applications switch** (`settings/publicApplications` {mode manual|auto, dailyLimit}), set by Willy or the public group's reviewers; starts Manual, 20 a day. **Auto** = sign-in link (Firebase email link): the applicant applies with name+email only; with Auto and a plain name the app sends the link; tapping it creates the account (email confirmed), they choose a password, and their own app joins the public group (`autoJoinPublic`): one batch of golfer + name claim + day counter (`autoApprovals/{days since 1970}`, stamped lastBy/lastAt) + `publicApprovals` with `auto:true`, then membership, roster, directory, application approved (`finishPublicJoin`, safe to re-run at each sign-in). The rules check every Level 1 condition (switch Auto, confirmed email, plain two-word name, name free, not on a block list, under the limit). Anything that fails waits for a reviewer.
- **Email already in use**: `accountEmails/{email}` (each account writes its own at sign-in; ap4 backfills); the form stops the applicant on screen; the rules refuse the application too. Delete my account removes it.
- **Block lists** (`blockedEmails`, `blockedDomains`, `blockedNames`) in the Applications tab; ap4 seeds 14 throwaway domains.
- **Name numbering** (Willy): the approve sheet pre-fills the next free name: "Name", then "Name 1", "Name 2"…
- **Small fixes**: fixed-size header (only the body follows A/A+/A++); on narrow phones a plain "Connected" shows as a green dot; person rows wrap their buttons below the name; tab names and buttons are not selectable; a refused group-requests read is quiet.
- **Release**: `bash ap4.txt` first (checks rq3's rules are live; adds account emails, the switch, throwaway domains, the collection-group index on rounds.date; switches on email link sign-in and allows www.cuberoot-systems.com; publishes the rules; recovers by itself; `rollback`). Then the web (merge v2 → main) and TestFlight. Tests: CK1–CK9 (rules), AP1–AP8 (script), E4b updated, E18–E23 (app). All green at 0cb05b5; ap4.txt pinned to it. TestFlight build of 2.30.0-beta.4 started Oct 1. **Next step: Willy runs bash ap4.txt, then Claude merges v2 into main (web).**

## 4. Tests (all run by themselves on every push to `v2`)

- `ios-checks.yml`: build checks V1–V6 (V3 = committed Firebase bundle equals a fresh build; the bootstrap step rebuilds and commits the bundle when `build/firebase-entry.js` or the lockfile changes — fingerprint in `vendor/firebase/bundle.source`), then web tests `test/web/run.mjs` in WebKit and Chromium against the live project (throwaway `webtest-…` accounts only).
- `ops-tests.yml`: Firebase emulators; `test/ops/run.sh` runs SEC1–5, DEL1, PRIV, ACC, PUB, GRP (rules), then `test/app/e2e.mjs` (the real app on `localhost:8000/?emulators=1`, E1–E14), then `test/ops/golive-tests.mjs` (GO1–GO9), then `test/ops/go2-tests.sh` (GL1–GL5: go2.txt end to end with stand-ins for Google in `test/ops/go2-fakes/`, including each failure and its recovery).
- `?emulators=1` works only on localhost (store.js `EMULATORS`, tidy.html). The published site and the iPhone app always use the live project.

## 5. Go-live (DONE 1 Oct: go2.txt ran at 9:53, web switched at 9:55; kept for reference)

1. Willy messages his group to set a password now in 2.21.9 (tap their name at the top → "Set a password"), and a reminder a week later.
2. `bash cnt.txt` (build/cnt.txt) — **count only**: members per group, guests without email, admins without email, last sign-in.
3. `bash go2.txt` (build/go2.txt) — checks the live rules are rf1's, shows the plan, waits for "yes", runs `build/golive.mjs apply` (data backfill: groupCreators, PUBLIC group, admin codes to secrets, golfer `groups`, directories, membership `golferId`, game players/result sheets), publishes the v2 rules, verifies, sets the password-email subject. `bash go2.txt verify`, `bash go2.txt rollback` (old rules, admin codes, email subject back).
4. **Immediately after**, Claude switches the web to Version 2.0 (merge `v2` into `main`, keeping `finish-deletions.yml`; Pages deploys `main`). Until then the old web app shows members nothing. Rollback: redeploy `v2.21.9-live`.
5. Guests who don't set a password get the "Set your email and password" screen in the same browser; if they use another device, the owner re-invites them with a named link (golfer and rounds kept).

`cnt.txt` and `go2.txt` pin the tested `v2` commit (`COMMIT=` line; on 1 Oct: `752914a`, all checks green). If anything on `v2` changes after that, re-test and update the pin.

## 6. TestFlight

- `ios-testflight.yml` builds when `version.js` changes on `ios` or `v2`; build number = the workflow's run number; "What to Test" from `build/what-to-test.txt` (`build/asc.mjs notes`). Version 2.0 starts at **2.30.0**: build 6 = `2.30.0-beta.1` (30 Sep), build 7 = `2.30.0-beta.2` with the go-live fixes (1 Oct); next build = `2.30.0-beta.3` (new first screen and group requests).
- Before go-live the TestFlight app uses the live database with today's rules: sign-in, groups, rounds work; the public group, group creation and admin invitations need the v2 rules.
- Willy still has to fill the TestFlight Test Information contact fields (values given in chat; phone not in repo).

## 7. Still open

- Before the App Store: privacy policy (Cuberoot site) and App Store privacy answers (full name shown to public-group members), age rating (user-generated names among strangers), screenshots, reviewer demo account, GolfCourseAPI reply.
- Optional later: a script to delete old guest sign-ins that belong to no group (cnt.txt shows how many).
- Emulators cannot be downloaded in Claude's sandbox; all emulator testing happens in GitHub Actions — read results from `ci-logs`.

## 8. Where things are

- Rules: `firestore.rules` (header lists every phase's changes). Tests: `test/ops/*.sh`, `test/ops/golive-tests.mjs`, `test/app/e2e.mjs`, `test/web/run.mjs`.
- App: `app.js` (screens), `store.js` (Firebase), `model.js` (handicap maths), `platform.js`. Tools: `tidy.html`, `rebuild.html`.
- Migration spec: Claude doc "Scorecard iOS Migration Spec" (Version 2.0 section) and PDFs in Willy's outputs. Onboarding design: "Scorecard_Onboarding_Privacy_Architecture - Revision 2.docx".

## One-time group clean-up (Oct 1, evening)

- **Step 1, backup:** `build/bk1.txt` (pinned 9e69664) runs `build/bk1.mjs`: every document and subcollection, accounts without passwords, to one JSON file. Tests BK1–BK2.
- **Step 2, clean-up:** `groups-check.html` (live on the web, read only: reads a backup file on the device, no network) shows the plan from `build/cl5-plan.mjs`; `build/cl5.txt` (pinned b935bed) takes a backup, shows the same plan, waits for yes, then: golfers found only in orphan groups move to Philippine Golfers with their rounds (window repointed, handicap kept; a double-counted round is counted once and the window refilled); accounts only in orphan groups join Philippine Golfers; copies of rounds already in a real group are removed and handicaps pointed at the real copy; the orphan groups, their links and join codes are removed; then a second backup and `verify`. Rerunnable. Stops if any of the four group names is missing or ambiguous. Tests CL1–CL9.
- Willy's answer A (Oct 1): a leftover golfer copy (no rounds, same name as a golfer in a real group) is left as it is; sign-ins with no email are not added to Philippine Golfers.
- **RAN Oct 1, 9:46 pm**: 34 orphan groups removed (44 documents), nothing moved, no handicap changed. Verified: 4 groups, 30 golfers, 124 rounds. Backup before: scorecard-backup-before-cleanup-2026-10-02-0146.json in Willy's Cloud Shell home.
- **Step 3, nightly backup — LIVE Oct 2:** `.github/workflows/nightly-backup.yml` (on main; 07:00 UTC; also on push of itself/its script, and by hand) signs in keylessly (pool `scorecard-backup`, provider `nightly-backup`, condition: repo id 1327018101 + this workflow file on main) as the read-only `scorecard-backup` helper (datastore.viewer + firebaseauth.viewer; set up by `build/nbk.txt`, which Willy ran), runs bk1.mjs (BK_NO_QUOTA_HEADER=1), then `.github/scripts/nightly-backup.sh` locks it with the GitHub secret BACKUP_PASSPHRASE (gpg AES-256, s2k SHA512 x65M), proves it decrypts identically, and force-pushes ONE commit to the `backups` branch holding the last 30 nights. `build/ckb.txt` opens and checks the newest (or `open` keeps a copy). Tests NK1–NK6, NB1–NB8. First run failed only because Google's new link takes minutes to activate; the re-run succeeded (4 groups, 30 golfers, 124 rounds).
- Also Oct 2: `build/bdg.txt` (ran) — CA$1 budget alert on the billing account (50/90/100%).

## 2.30.0-beta.5 (Oct 2) — live on the web and TestFlight

- **Terms of Use** on first open (app.js: TERMS_VERSION 1, effective Oct 2, 2026; wording from Fairpot with golf sections 4 and 5). Gate in renderNow before everything; Accept needs the tick; Decline locks. Remembered on the device (localStorage `golf:terms`) and recorded on the account at `users/{uid}/terms/accepted` (version, server time, app version) — this uses the old `users/{uid}/**` rule, so that rule must be KEPT. Footer link "Terms" opens a read-only copy. A new TERMS_VERSION asks everyone again. Tests set `golf:terms` by default; E25 tests a fresh device.
- **Short invitation/code screens** (signed out): You're invited / Create your account to join / Email, New password, Password again / Create account / Have an account? Sign in. Signed-out footer shows links only.
- **Bottom tabs** fixed at 12.5px / 21px icons (styles.css end).
- **Pinch zoom** in the app: capacitor.config.json ios.zoomEnabled = true.
- **Tidy inside the app**: tidy.html now loads vendor/firebase (no gstatic) with initializeAuth + IndexedDB, is in build/www-files.txt, and opens in the same window (app and web). Opening a tool stores the tab/admin tab in sessionStorage (`golf:return`); the app restores it on return. Rebuild and Clean up still open in Safari from the app. Tests E24.
- E4c is occasionally flaky (passed on b750b49, failed on a610050 with only version.js changed).

## 2.30.0-beta.6 (Oct 2) — version 1 import removed for good

Willy: "V1 was a mistake ... make it irrelevant forever." The app no longer reads version 1 data (readLegacyV1, importLegacyV1, importLegacyIntoCurrentGroup removed), shows no import card on Enter (empty group), Join or Admin, and migrate.js is gone from the repo, the app package and the service worker list. model.migrateFromV1 remains as an unused pure function. The old version 1 documents under users/{uid} are still in the database (untouched); users/{uid}/terms/accepted now lives beside them.

## 2.30.0-beta.7 (Oct 2) — tools inside the app

- `tool-firebase.js`: the one connection for every tool page (vendor Firebase, initializeAuth + IndexedDB, emulator mode, no anonymous sign-in, back links keep ?emulators=1). Tidy, Rebuild, Clean up and Repair use it, are packaged (www-files.txt) and open in the same window in the app and on the web. reset.html stays web-only (service-worker escape hatch; not linked from the app).
- Tool pages scroll: each overrides the shared stylesheet's locked body.
- Start-up: persistentSingleTabManager({ forceOwnership: true }) in the app; checkPendingDeletion has a 6 s limit; each start-up step's time is written to the report trail ("start-up: ... after N ms").
- Shorter old-guest screen (screenUpgrade) and sign-in card; "Become a member or start a group" above "I have a code" (fits without scrolling except on the smallest iPhone at A++).
- Tests: E26 (all tools in place, signed in, scrolling, top back link), E25 checks the first-screen order.

## FIXED in beta.8 — beta.7 hang on "Loading your group" after returning from a tool (analysis kept below)

**Symptom (Willy, iPhone app):** after opening Tidy (or any tool) and tapping Back, the boot card stays on "Opening your scorecard / Checking your access ✓ / Loading your group" until the app is backgrounded or the phone sleeps; on return everything is normal.

**Cause (code analysis):** beta.7 opens tools with `location.href = ./tool.html` in the SAME WKWebView, and Back is a fresh navigation to `./`. WKWebView keeps the old app page frozen (back-forward cache) with its Firestore client and IndexedDB persistence still open. The new app page's Firestore (persistentLocalCache in IndexedDB) cannot proceed while the frozen page holds it; backgrounding evicts the frozen page, which frees it, and the waiting reads complete. `settleGroup()` → `db.loadMyGroups()` / `amMemberOf()` / `start()` reads then wait indefinitely. The beta.7 6 s limit on `checkPendingDeletion` only HID the same stall one step earlier (it fails quietly and moves on). Desktop Chromium tests never reproduced it because Chromium does not keep that page alive the same way.

**Willy's rules for the fix:**
- Fix the CAUSE. No time-out counters to cover it up ("it just hides the problem").
- Offline use must keep working: the app must still open the group from the saved copy with no signal (store and forward). Scores already queue in our own outbox (localStorage `golf:v2:outbox`), independent of Firestore's cache. Plan B (drop the saved copy) was rejected for this reason.
- Firebase web SDK can only use IndexedDB or memory; SQLite would need the native Firebase iOS SDK (a full rewrite) — not chosen.

**Agreed plan (Plan A) — build only after Willy says go:**
1. Before navigating to any tool, the app shuts its Firestore down cleanly: export `terminate` from the vendor bundle wrapper, stop all watchers, flush or leave the outbox untouched, `await terminate(fb.db)`, then navigate. Also terminate on `pagehide` (covers any other way the page is left) and, on `pageshow` with `persisted`, reload so a restored frozen page never reuses a terminated client.
2. Remove the beta.7 `forceOwnership: true` (not needed once the old client is closed).
3. Propose to Willy removing the beta.7 6 s limit on the deletion check, since it masked this (his rule: no time-outs that hide problems). Do not remove without his go.
4. Review EVERY start-up read path for the same class of stall before building (not just the reported one).
5. New e2e test that reproduces the frozen page: keep the old page's Firestore + IndexedDB open (e.g. a second page/iframe holding the persistent client), open Tidy, come back, and require boot to reach "ready" within a few seconds — online and offline (from the saved copy). It must FAIL on beta.7 code first.
6. Confirm on device with Send a report (start-up timings "start-up: ... reached after N ms").

## 2.30.0-beta.8 (Oct 2) — the cause of the tool round-trip hang, and one invitation screen less

- **store.js `shutDown()`**: sets `closing`, stops every listener, sets `fb = null`, then `await terminate(db)` FIRST and `await deleteApp(instance)` second. Deleting the app alone hangs when Firestore was never used (auth deleted while Firestore's terminate waits for it) — reproduced in Chromium; it stuck Tidy's Back when signed out. No time-out: it waits for the close to finish.
- **app.js open-tool**: `await db.shutDown()` before `location.href = ./tool.html`. The time it took (or the failure) is put in the `golf:return` record and written to the report trail of the page that comes back ("left for tidy: closed in N ms").
- **tool-firebase.js**: remembers what it opened; every `a[href="./"]` (Back to the app) closes Firestore, then the app, then navigates.
- Both pages: `pageshow` with `persisted` → `location.reload()` (a page restored from the iPhone's page cache never reuses a closed Firebase).
- **forceOwnership removed** (persistentSingleTabManager() plain).
- **Outbox**: a write cut off by the close is NOT counted as refused (Firestore reports failed-precondition, which the outbox treats as permanent) — it stays queued for the next page.
- `terminate` added to build/firebase-entry.js; CI rebuilt and committed the bundle (1474e74).
- The beta.7 6 s limit on the deletion check is KEPT for now (it also covers starting with no signal); Willy dislikes time-outs that hide problems — ask him before removing it.
- **Invitation, existing email**: `createAccountHere()` on email-already-in-use signs in with what was typed (`db.signInWithEmail`, the same check as Sign in) and continues via `finishSignIn()` (shared with `signIn()`), straight to the invitation. A wrong password shows "That email already has an account / The password you typed is not its password" (code auth/existing-account-password) on the same screen, with Reset.
- Tests: E27 (app mode via a fake window.Capacitor: the Firestore saved copy's `owner` lease is released before Tidy loads; Back opens the app within 8 s) and E28 (existing email on an invitation) FAILED on beta.7 code (27b8917) and pass on beta.8; E29 (Back from a signed-out Tidy). E24 now names the failing step.

## 2.30.0-beta.9 (Oct 2) — Delete my account done properly; joining again (Willy: last build until Thursday Oct 8)

Willy's test: a member deleted their own account, the deletion stopped part-way with no clear message and "Later" let them carry on as an admin; re-invited with the same email, joining was refused ("rules are older"). Willy's design (confirmed): self-serve; once confirmed the person is forced out and the removal is completed for them; the golfer stays on its group's roster with rounds and handicap (admins keep posting for them); the email is freed.

- **store.js deleteMyAccount**: steps named via `step()`; once `accountDeletions/{uid}` is written, ANY stop → `stopAndSignOut()` writes `{stage:"app-stopped", appStep, appError}` (8 s limit, best effort) and `signOutHere()`; returns reason PENDING. Owner found at step 6 → request withdrawn (allowed at stage reauthenticated), stays signed in. Test hook `globalThis.__scorecardStopDeletionAt` works only with the emulators (E31).
- **app.js**: PENDING → `showBeingDeleted()` sheet; boot and `finishSignIn()` call `checkPendingDeletion()` and `refuseDeletingAccount()` (sign out + message). The old resume/"Later" path is no longer reached.
- **Joining** (`acceptNamedInvite`): an existing membership is kept (role included) and only the claim, pointer, golfer link and roster are written; a membership for a different golfer → OTHER_GOLFER; refusals are coded `join/membership-refused` (link out of date) and `join/link-refused` (golfer linked to another sign-in), each with its own message.
- **Rules (dl9.txt, pinned acd6cee; Willy RAN it Oct 2, 4:57 pm — live)**: `deleting()` = accountDeletions/{uid} exists. `isMember` is false for a deleting account (no admin/member powers anywhere); members/invites/golfers/golferNames/userGroups/accountEmails/userBlocks/courses creates and updates refuse it; it may still read its own records, leave groups, delete its claims/pointers/blocks/email entry and only UNLINK its golfer; invites list also allows its own claims (acceptedBy == me). accountDeletions: create only as "requested"; delete (withdraw) only while "requested"/"reauthenticated"; never moved back to those stages.
- **Completion job**: every 15 minutes (7,22,37,52), MIN_AGE_SECONDS 300 (set in the workflow; script default still 3600); also deletes `accountEmails/{email}` (email from Firebase Auth, not the request); logs saved only when there was something to do, a failure, a push run, or the 07 UTC hour (keep-alive activity).
- Tests: E30 (delete end to end + rejoin with the same email as the same golfer), E31 (stopped part-way: signed out, sign-in refused, rules lock, job finishes incl. email), E32 (invitation when already a member: E32 failed on beta.8 with Willy's exact refusal); DEL1 updated (no withdrawal once removal began); DL0–DL7 for dl9.txt.
- Not changed: privacy/support pages still promise "within one day" (now within ~20 minutes, so still true).

## OPEN after beta.9 (Oct 2, 5 pm) — Delete my account never got past step 1 in production

- Willy (as wrosales@icloud.com, admin of Golfing Buddies, online): "Your groups couldn't be checked. Connect to the internet and try again. Nothing was changed." The same happened in his earlier test (the job then found no request).
- Cause: `myGroupIdsFromServer()` (and `groupsFromMemberships()`) run a COLLECTION-GROUP query `members where uid == me`. Production Firestore needs a collection-group single-field index on members.uid; it was never created (only the rounds/date one, by ap4). The emulators need no index, so E30/E31/DEL1 could not catch it.
- Fix without a build: `build/ix9.txt` (tests IX1–IX6, fakes in test/ops/ix9-fakes): proves the query is refused, adds the field override (members/uid: COLLECTION asc/desc/contains + COLLECTION_GROUP asc), waits until the same query works. `bash ix9.txt verify` re-checks.
- [Willy] TO DO for the Thursday Oct 8 build: (1) step 1 of deleteMyAccount must show and report the REAL error (not "Connect to the internet"); (2) put the reason in Send a report; (3) a test that lists every filtered collection-group query in the code and fails unless its index is in a repo index list that a script keeps live.
- [Willy, Oct 2, 5:36 pm] TO DO for Thursday: invitation links one-time and personal (own secret per invitation), cancelled when used or when the account is deleted; "Send again" always makes a fresh link. Today: member links lock to the first account (reusable by it, TAKEN for others) and become usable by anyone after that account is deleted (deleteMyAccount/job remove the claim and unlink the golfer); the link carries the group join code. Admin links are already spent after one use. Propose before building.
- [Willy, Oct 2, 8:48 pm] TO DO for Thursday: after joining through an invitation, Sign out lands on the INVITATION sign-in screen instead of the regular Sign in screen. Likely cause to check first: the app is re-handed its launch link (platform.initLinks → App.getLaunchUrl() returns the invitation URL again after signOutEverywhere's location.reload, and lastUsedKey's repeat window may not cover it), or the web address still carries ?join=. Fix so that a used invitation never reappears; add a test (join by invitation → sign out → plain Sign in screen, app mode and web).
