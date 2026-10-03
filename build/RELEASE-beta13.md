# 2.30.0-beta.13 — invitation wording and roster-tool cleanup

Approved by Willy on 3 October 2026.

## Changes

- Every invitation message now says: “This invitation link is for one-time use only. Once you join, it cannot be used again.”
- The two app links to Rebuild the roster were removed: the empty-roster Manage link and Admin → Settings. The controlled repair page remains in the repository for deliberate recovery work.
- E4c was diagnosed as a timing problem in the test. The application had completed the approval, but the old test could miss a three-second success message. The current test checks the saved Firestore result for up to 20 seconds. The approval logic did not need another change.

## Automated coverage

- E12 checks the exact one-time-use notice in a regular-member invitation.
- E16 checks the notice in the organiser/admin invitation and verifies that neither Admin → Settings nor empty-roster Manage exposes Rebuild the roster.
- The release workflow runs the full rules, operations, application, web, iOS and TestFlight checks before distribution.

## Deployment

No Firebase rule, index or data change is required. The same beta.13 application files are deployed to TestFlight and the web.
