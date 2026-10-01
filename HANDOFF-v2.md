# The Scorecard — Version 2.0 handoff (state at 30 September 2026)

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
| `main` | The live web app, **2.21.9**, served by GitHub Pages. Frozen except the deletion job (`finish-deletions.yml`). Tag `v2.21.9-live`. |
| `ios` | **Version 1** of the iPhone/iPad app (2.22.0-ios.5, TestFlight builds 1–5). Its `firestore.rules` are the **rules published today** (rf1.txt, 30 Sep). |
| `v2` | **Version 2.0** (this document). Built on `ios`. Not live. TestFlight builds come from here from 2.30.0 on. |
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

## 4. Tests (all run by themselves on every push to `v2`)

- `ios-checks.yml`: build checks V1–V6 (V3 = committed Firebase bundle equals a fresh build; the bootstrap step rebuilds and commits the bundle when `build/firebase-entry.js` or the lockfile changes — fingerprint in `vendor/firebase/bundle.source`), then web tests `test/web/run.mjs` in WebKit and Chromium against the live project (throwaway `webtest-…` accounts only).
- `ops-tests.yml`: Firebase emulators; `test/ops/run.sh` runs SEC1–5, DEL1, PRIV, ACC, PUB, GRP (rules), then `test/app/e2e.mjs` (the real app on `localhost:8000/?emulators=1`, E1–E14), then `test/ops/golive-tests.mjs` (GO1–GO9), then `test/ops/go2-tests.sh` (GL1–GL5: go2.txt end to end with stand-ins for Google in `test/ops/go2-fakes/`, including each failure and its recovery).
- `?emulators=1` works only on localhost (store.js `EMULATORS`, tidy.html). The published site and the iPhone app always use the live project.

## 5. Go-live (not done yet — needs Willy's go-ahead at each step)

1. Willy messages his group to set a password now in 2.21.9 (tap their name at the top → "Set a password"), and a reminder a week later.
2. `bash cnt.txt` (build/cnt.txt) — **count only**: members per group, guests without email, admins without email, last sign-in.
3. `bash go2.txt` (build/go2.txt) — checks the live rules are rf1's, shows the plan, waits for "yes", runs `build/golive.mjs apply` (data backfill: groupCreators, PUBLIC group, admin codes to secrets, golfer `groups`, directories, membership `golferId`, game players/result sheets), publishes the v2 rules, verifies, sets the password-email subject. `bash go2.txt verify`, `bash go2.txt rollback` (old rules, admin codes, email subject back).
4. **Immediately after**, Claude switches the web to Version 2.0 (merge `v2` into `main`, keeping `finish-deletions.yml`; Pages deploys `main`). Until then the old web app shows members nothing. Rollback: redeploy `v2.21.9-live`.
5. Guests who don't set a password get the "Set your email and password" screen in the same browser; if they use another device, the owner re-invites them with a named link (golfer and rounds kept).

`cnt.txt` and `go2.txt` pin the tested `v2` commit (`COMMIT=` line). If anything on `v2` changes after that, re-test and update the pin.

## 6. TestFlight

- `ios-testflight.yml` builds when `version.js` changes on `ios` or `v2`; build number = the workflow's run number; "What to Test" from `build/what-to-test.txt` (`build/asc.mjs notes`). Version 2.0 starts at **2.30.0** (`2.30.0-beta.1`).
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
