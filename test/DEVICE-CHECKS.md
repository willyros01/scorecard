# Device checks — The Scorecard iPhone app

Every acceptance check whose Type (in the migration spec's acceptance matrix) includes **Device**: only a real iPhone or iPad can prove it. Wording is copied from the spec. Tick each on the TestFlight build; anything automated is in GitHub Actions and is not repeated here.

Use test accounts for every DEL check — never your own owner account.

| ID | Check | Passes when | Type | Result |
|---|---|---|---|---|
| S1 | Try to run static.yml by hand from the ios branch | GitHub refuses: the branch isn't allowed for github-pages | Device | |
| S3 | Automated: open the ios branch at the local address and the live app in the same browser | Signing out of one leaves the other signed in (separate storage) | Device | |
| R1 | Automated rehearsal: an anonymous guest and the test owner signed in at http://localhost:8000 running v2.21.9; then the ios branch's files are swapped in at the same address and the page reloads | Both are still signed in as the same account (status button) | Device | |
| R2 | Rehearsal: a round queued offline on v2.21.9; switch; go online | It uploads once | Device | |
| R3 | Rehearsal: the remembered group | The app opens straight into the group | Device | |
| R4 | Rehearsal: after the switch | No Google button, and the Delete my account link is present | Device | |
| I1 | Apple's copy of apple-app-site-association | Returns the published JSON | CI + Device | |
| I2 | Open /scorecard/join/?join=TEST.CODE in Safari | Arrives at the web app with the query intact | Device | |
| O1 | Online, open the group, roster and History. Force-quit, turn on Airplane Mode, reopen | Group, roster, rounds and handicap appear; the status button says "Offline — showing saved copy" | Device | |
| O2 | Fresh install, sign in online, turn on Airplane Mode, open a golfer never viewed | Says it isn't available offline; never "not found" | Device | |
| O3 | Airplane Mode on the first screen right after install | "You're offline"; no Create the group button | Device | |
| O4 | The web app in Safari, offline | Behaves as today (memory only) | Device | |
| DEL2 | A guest with a password deletes their account | The UID is absent from Firebase Authentication (accounts:lookup). There is no membership, group list entry or invitation claim, and no golfer with that linkedUid. The golfer name, rounds and handicap are unchanged. The record is gone after the job runs | Device | |
| DEL3 | Wrong password on the confirmation screen | Nothing changes; still a member; no record left | Device | |
| DEL4 | A round waiting in the queue | Deletion refuses until it uploads; no record is written | Device | |
| DEL5 | Airplane Mode during step 7, then reopen online | The app opens on "Your account isn't deleted yet"; Try again finishes; end state as DEL2 | Device | |
| DEL6 | An anonymous guest who joined more than 7 days earlier deletes their account | Passes only when accounts:lookup confirms the anonymous UID is gone from Firebase Authentication. Signed out with no membership is a FAIL | Device | |
| DEL7 | An anonymous guest: stop the app after step 4 (after the record is written), then delete the app. Run the job | The job finishes the clean-up; accounts:lookup confirms the UID is gone; the record is deleted | Device + job | |
| DEL8 | The owner tries | Refuses and explains. After the owner deletes the test group, deletion succeeds and no group has that ownerUid | Device | |
| DEL9 | Re-invite the deleted guest | Joins as the same golfer, with the old rounds and handicap | Device | |
| DEL10 | Airplane Mode just before step 8 (deleteUser) | Never reports deleted; still signed in to the same UID; Sign out hidden; Try again online succeeds and accounts:lookup confirms the UID is gone | Device | |
| M1 | The owner moves | Same group, roster, History and handicap; no new golfer | Device | |
| M2 | An admin with a password moves | Same as M1 | Device | |
| M3 | An admin without a password: Set a password, then move | Same as M1; the Admin tab shows the admin role | Device | |
| M4 | An anonymous guest: Set a password (new email), then move | Same golfer, can post their own round; roster count unchanged | Device | |
| M5 | The guest reinvite path | Same golfer ID; roster count unchanged; the old web sign-in removed with remove-older-sign-ins | Device | |
| M6 | The web app shows "Saved on device (1 waiting)" | The guide says don't move. Once online it reads Synced, and after the move the round is present | Device | |
| A7 / EXP1 | Encryption in the first-release archive | ITSAppUsesNonExemptEncryption is NO, and no SQLCipher, OpenSSL or BoringSSL is found in the app or its frameworks. App Store Connect doesn't ask the encryption questions for the build | CI + Device | |
| P1 | Traffic survey in Web Inspector | Every server contacted appears in the label table | Device | |
| C1 | Send an invitation from the iPhone app to yourself by email | The link starts with https://www.cuberoot-systems.com/scorecard/join/ and the guide link opens the Cuberoot guide | Device | |
| C2 | Tap that link on a device with the app installed | The app opens on the join screen, greeting the named golfer | Device | |
| C3 | Tap it on a device without the app, or on a computer | The web app opens and joins as today | Device | |
| C4 | With the app already open, tap another invitation | The app switches to the join screen for the new link | Device | |
| C4b | App closed: tap an invitation (cold start), join, then send the app to the background and bring it back; also tap the same link again | The join screen appears once; one membership write in the log; after joining, the same link opens the group, not the join screen again | Device | |
| C5 | Open the app for the first time and sign in | Sign-in completes; the status moves past "Starting" | Device | |
| C6 | Admin tab on a device not signed in | Only the owner-email warning and email-and-password sign-in; no Google button | Device | |
| C7 | Backup → Save it somewhere → Save to Files → iCloud Drive | The file is in iCloud Drive and opens as text | Device | |
| C8 | Share a game summary by WhatsApp, Email, Text message and Copy | Each opens the right app with the text; Copy pastes correctly | Device | |
| C9 | Send a bug report from the app | Formspree receives it, or the mail fallback opens | Device | |
| C10 | Search for a course by name | Results appear (the course service accepts the app's requests) | Device | |
| C11 | Tap Rebuild the roster in the app | The tool opens in Safari | Device | |
| C12 | Airplane Mode, post a round, force-quit, reopen, turn the network on | The round uploads once, with no duplicate | Device | |
| C13 | Normal start inside the app | No service worker registered; nothing else changes | Device | |
