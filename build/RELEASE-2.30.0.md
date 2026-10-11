# 2.30.0 — App Store release build

Asked for by Willy on 11 October 2026: a build for App Store review without the word beta.

## Changes

- version.js: 2.30.0 (was 2.30.0-beta.14). The app code is otherwise identical to beta.14.
- build/what-to-test.txt: notes for this build.

## Not in this build (Willy, 11 October)

- User guides and the App Store Connect setup are handled by ChatGPT.
- The App Store link in invitation messages waits for the app's Apple ID.
- The web (main) stays on beta.14 until Willy says otherwise.

## Deployment

No Firebase rule, index or data change. The push to v2 changes version.js, which starts the TestFlight build by itself; that build is the one submitted for App Store review.
