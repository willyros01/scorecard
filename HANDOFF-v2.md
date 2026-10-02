# The Scorecard — Version 2.0 handoff (state at 1 October 2026, afternoon)

Written so that anyone (Claude, ChatGPT or a person) can continue the work. Read it fully before changing anything.

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
