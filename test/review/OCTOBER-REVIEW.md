# October 2 code and workflow review

Baseline: v2 commit 1036ab02e7a0e64e029c069708f2242608e08992.
TestFlight build 14 is 2.30.0-beta.9 (18512f6). This branch changes tests only.

## Priorities before the next release

1. Fix consumed launch links returning after sign-out/reload. LINK6 proves the
   current ten-minute suppression expires. E33 checks actual join/sign-out in
   web mode and simulated native immediate/delayed launch delivery.
2. Show and report the actual deletion step-1 error, including Firebase code.
   Inject failed-precondition, permission-denied and unavailable independently;
   require no deletion request or destructive writes on failed ownership reads.
3. Publish a reviewed one-time invitation design before changing production:
   independent random secret, atomic consumption, resend invalidates old secret,
   deletion does not reactivate it, only the owner can grant admin access.
   Existing E30/E32 intentionally exercise the OLD reusable-link design.
   They must be revised with that approved design, not simply deleted.
4. Add an index manifest and a read-only live-index verification step. Include
   members.uid equality and rounds.date range collection-group queries.
   Emulators do not enforce production index availability. ix9 fake tests
   validate the repair script, not all live queries.
5. Decide the six-second startup deletion behavior. Offline access must remain
   supported, while a failed online check must not be described as confirmed.
   Keep the server-side deletion lock regardless of the startup decision.
6. Make exact-commit operations and web tests gate TestFlight upload. Currently
   these workflows run independently. Build checks and archive audits pass
   without waiting for the complete behavioral suite.
7. Expand ops-tests path triggers: build/**/*.mjs, build/**/*.txt,
   package.json, package-lock.json, styles.css, and workflow configuration.
   Current triggers can miss changes to tested migration scripts/dependencies.
8. Diagnose E4c via failure traces and isolated repeat runs; do not solve it by
   increasing sleeps or suppressing failures. Update old handoff headings and
   the manual 127-test page to the beta.9 navigation and removed V1 import.

## Added coverage

Nine deterministic tests execute the actual platform.js in an isolated native
delivery harness (no live Firebase). Eight pass on beta.9; LINK6 is a real
expected failure demonstrating replay after eleven minutes.

E33 runs three real app join/sign-out cases against the existing emulators:
web, immediate native launch replay, and delayed native launch replay.
Capacitor delivery is simulated; this does not replace a real iPhone check.

review-tests.yml runs the complete existing operations suite, including SEC,
DEL, privacy, account, PUBLIC, group, cockpit, migration, backup, cleanup,
deletion-lock and index-script tests, plus E33. Its separate link job exposes
known failures without preventing the full emulator job from running.
It uses no Apple keys or live owner credentials and does not publish anything.

The full live WebKit/Chromium workflow is intentionally not run on this review
branch: it uses production Firebase and configured owner credentials.
Reuse it as an exact-commit release gate after fixes are approved.

## Evidence and limits

Local LINK1-LINK9: 8 passed, 1 failed (LINK6).
E33 source passed Node syntax validation.
See review-tests.yml run/artifact for emulator execution results.
No app source, rules, live indexes or release version changed.
