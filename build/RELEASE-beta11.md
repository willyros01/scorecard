# 2.30.0-beta.11 — invitation fixes

Willy approved building these solutions on 2 October 2026. Email prebinding was explicitly rejected: admins do not collect an email before sending a private-group invitation. The first signed-in account to accept claims the link. Existing owner/admin/member powers and PUBLIC application approval remain.

## Implementation

- platform.js stores durable consumed-link receipts outside the account-data reset namespace. Native launch-URL replay is suppressed after logout/reload, including beyond the previous ten-minute limit.
- store.js creates 256-bit random invitation secrets in `associations/{group}/invitationTokens/{token}`. A slot pointer replaces the previous link on resend. Named links use the golfer's slot; general links use an open member/admin slot. Sending another general link cancels the preceding general link of that role; send named links for concurrent invitations.
- Acceptance is one Firestore transaction: membership, golfer link, roster, account-group pointer and used state. Rules enforce an existing group, active slot, exact golfer, one consumer, permitted role and unchanged existing role. A deleted group cannot be rejoined through orphaned invitation documents. Rejected/racing requests leave no partial join. Used receipts retain no accepting UID/email and cannot be reopened or deleted by clients. Account deletion still removes only its own data and leaves golfer/round history as before.
- Manual regular-member group-code entry remains. Old named/admin shared-code URL acceptance is retired by a deployment marker. A known regular-member group code remains a valid manual credential; this does not rotate existing group codes or email-bind invitations.
- app.js awaits saved invitation creation before sharing, uses server invitation metadata, clears spent/cancelled invitations and corrects the obsolete no-password wording.
- Deletion precheck reports the actual code/message into the screen and report diagnostics. The existing deletion steps and completion job are preserved.
- The startup deletion check keeps its six-second bound. Timeout is explicitly unknown with one fifteen-second retry; a detected deletion requests sign-out. A retry is bound to the original account.
- Confirmation messages cancel earlier timers; the approval retry test waits for the actual approved document, not a transient banner.

## Release gate and evidence

`release-checks.yml` runs the committed build checks, link/message/deletion-check/query/deployment regressions and Claude's complete emulator/rules/migration/deletion/real-app suites in Chromium and WebKit. `ios-testflight.yml` depends on this gate for the exact release commit before signing/uploading. All pre-existing suites are retained. The historical dl9 script test compares to its pinned historical rules, rather than incorrectly requiring historical rules to equal every future release.

The query inventory records all twenty-one query calls in the app and maintenance pages; a source query change fails unless its inventory/probe is updated. `iv0.txt` executes those structured queries against live Firestore before changing rules. Emulator success alone does not prove live index readiness. Browser tests simulate Capacitor link delivery and persistent storage; they do not replace a physical-device TestFlight check.

## Deployment state and sequence

The beta.11 app source is on v2. A final server-only tightening refuses tokens belonging to deleted groups; firestore.rules is not packaged into the iOS binary, so this does not change the signed app payload. Its full regression suite is checked separately before the Cloud Shell script is delivered. The live web/main and Firebase have not been updated by this work. `build/iv0.txt` pins the exact new rules and query inventory. It switches first to scorecard-f41b8, requires the live beta.9 rules, checks all live queries, backs up rules and the activation marker, asks `yes`, compiles/publishes/verifies rules and activates the marker. On failure it restores both; rollback works from the saved backup without GitHub access. It never changes existing accounts, golfers, rounds or groups.

1. Finish required automated tests and TestFlight upload.
2. Willy uploads iv0.txt to Google Cloud Shell and runs `bash iv0.txt`; type `yes` only after the checks pass. Keep the scorecard-iv0-backup folder.
3. After successful confirmation, update the live web to the tested beta.11 commit, retaining finish-deletions.yml. Do not merge main before step 2.
4. Use beta.11 for sending new links and resend outstanding old named/admin links. Existing beta.9 memberships/sign-in and normal deletion continue; beta.9 cannot create these new token links.
5. Verify using `bash iv0.txt verify`. Rollback: `bash iv0.txt rollback`; coordinate the matching app/web rollback.

What to test, including the physical iPhone and web logout/reopen checks, is in `build/what-to-test.txt` and uploaded with TestFlight. App Store preparation, V1 cleanup and PUBLIC/group-application redesign are outside this invitation-fix release.
