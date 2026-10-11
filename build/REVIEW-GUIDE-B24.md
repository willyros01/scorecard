# The Scorecard — Apple App Review Test Guide
**Version 2.30.0 · Apple Build 24 · 11 October 2026**

**Audience:** Apple App Review. **Roles: Administrator and Regular User only.**  
**Group:** Apple Test Group (private demonstration group).  
**Start:** Receipt of the one-time Admin invitation.  
**Finish:** Delete the Regular User account, then delete the Administrator account.  
**Build source:** `v2`, `af33720c2820758456aa7bdf3c32a76d1333e36d`.

> **Confidential access:** The actual invitation, reviewer email(s) and passwords are supplied only through private App Store Connect review information. They are not reproduced in this document or Cuberoot's public pages. This guide contains no usable authentication secrets.

## Read this before starting

- Open the **installed iOS Build 24** supplied for review. The invitation may contain "Step 1 — download from the App Store"; because the app is not publicly released during pre-release review, **skip the storefront download** and open the invitation's **Step 2 — join here** link instead.
- The invitation is **one-time use**. Once accepted, always sign back in using the same review email and Scorecard password rather than reusing the link.
- The Admin invitation is **named "Apple Tester"** and grants the **admin** role in **Apple Test Group**. You may see **"Yes, that's me — join"** when accepting it.
- **The Apple reviewer creates their own Regular User test account(s) as part of the required test.** After joining as Admin, use **Manage → Golfers in this group → Type a name → Add golfer → Invite** for each new test golfer. The reviewer sends each one-time invitation to a different reviewer-controlled email/account. The invited user then opens the link and creates their own email/password login. **No Regular User invitations or accounts need to be prepared by the developer in advance.** The public group instead uses an application process; stay in Apple Test Group for invitation tests.
- Maintain two independent test sign-ins (Admin and Regular User). Use separate devices if practical, or sign out and sign in with a second test email. Keep credentials securely available when switching.
- All edits use **fictional test records only**. Avoid deleting the entire group or altering live golfer records.
- Every numbered test has an **Expected result** and **Result: ☐ Pass ☐ Fail ☐ Not tested**. Record the actual screen, exact error and device model for any failure.

### Suggested test data (not real customer information)
- New regular golfer: **Review Golfer** (or **Review Golfer 2** if already present).
- Course: Use an existing demonstration course with tees and valid course rating, slope and par. If no course exists, create a fictional test course under Manage.
- Course example (only if you must create one): **Apple Review Links**, White tees, rating 71.2, slope 128, par 72.
- Round date: Today's date (unless testing the date picker).
- Sample scores: 91, 88 and 94, each on a different round date if calculating a first index.
- Game: **Apple Review Game**.
- Never use real personal data or unlicensed course details as publicly presented facts.

---

## PART A — Invitation, account creation and joining (Admin)

### A01. Receive the Administrator invitation
**Start:** Confidential invitation has been provided in App Store Connect.  
**Tap:**
1. Read the message addressed to **Apple Tester**.
2. Confirm the group is **Apple Test Group** and the invitation states **Admin**.
3. Note the **Step 2 — join here** link. Keep it private.

**Expected:** A one-time invitation for the correct group and admin role is available.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### A02. Open the invitation in Build 24
**Start:** The app is installed for review on an iPhone/iPad.  
**Tap:**
1. Open The Scorecard Build 24, then tap **Step 2 — join here** from the invitation.
2. Allow iOS to open The Scorecard if prompted.
3. If the invitation mentions downloading from the public App Store, ignore that step during pre-release review.

**Expected:** The app opens the invitation flow for **Apple Test Group**, not an unrelated sign-in or blank screen.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### A03. Create a new reviewer account
**Start:** Invitation sign-in/creation screen.  
**Tap:**
1. Choose account creation if you have not already registered.
2. Enter an accessible reviewer email address and new **Scorecard password**.
3. Confirm the password if requested.
4. Tap **Create account** and follow any email-confirmation instructions.

**Expected:** Account creation completes. The password is for Scorecard, not the email account.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### A04. Accept the named admin invitation
**Start:** The invitation has been recognised after sign-in.  
**Tap:**
1. Read the displayed golfer name **Apple Tester** and group name.
2. Confirm this is the intended reviewer identity.
3. Tap **Yes, that's me — join**, or the corresponding **Join the group** control if shown.
4. Wait until group data loads.

**Expected:** Apple Tester joins **Apple Test Group** with Admin permissions. The app does not ask the reviewer to own the group.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### A05. Check one-time invitation behaviour
**Start:** Admin account joined successfully, password safely recorded.  
**Tap:**
1. Reopen the same invitation link once.
2. Return to the normal application screen and use your existing sign-in.

**Expected:** The one-time invitation cannot establish a second membership/account and does not take the reviewer into an invitation-sign-in loop.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### A06. Check app version and sync
**Start:** Signed in as Admin.  
**Tap:**
1. Open any regular app screen.
2. Scroll down to the footer and find the app version.
3. Wait for the online sync indicator.

**Expected:** **v2.30.0**, without "beta"; online changes finish syncing.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

---

## PART B — Administrator exploration and invitation creation

**REQUIRED ONBOARDING TEST: The Apple Admin reviewer must create and invite at least one Regular User, preferably two if testing membership differences.** This is part of the review, not a prerequisite requiring developer-created member accounts. First add a golfer record, then generate a one-time invitation, then complete member account creation using a separate reviewer-controlled email.

### B01. Verify Admin navigation
**Tap:** Open **Enter**, **History**, **Summary**, **Games**, **Manage** and **Admin** in turn.  
**Expected:** All six tabs are visible and usable with no crash.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B02. Review Admin → Cockpit
**Tap:**
1. Tap **Admin**, then **Cockpit**.
2. Read the member activity, unused invitations, round counts and "Last seen" records.
3. Rotate the device and revisit if using iPad.

**Expected:** Values load, fit the screen and reflect the available fictional group records.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B03. Review Admin → Members
**Tap:**
1. Open **Admin → Members**.
2. Find **Apple Tester**, labelled **admin**.
3. Inspect members and their roles.

**Expected:** Regular members and the review admin are displayed. An administrator may remove a regular member, but not arbitrarily alter management roles.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B04. Review Manage → Golfers in this group
**Tap:**
1. Open **Manage**.
2. Find **Golfers in this group**.
3. Review existing names, indexes, round counts and their invitation states.

**Expected:** "Invite" means not invited; "Re-send" means invited but not joined; "Joined ✓" means joined.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B05. Admin creates regular golfer(s) for Apple testing
**Tap:**
1. Under the roster, find **Type a name**.
2. Enter **Review Golfer**.
3. Tap **Add golfer**.
4. Locate the new row.
5. Optionally repeat with **Review Golfer 2** to test invitations to multiple regular users; each invited user must use a separate review email/account.

**Expected:** Exactly one row per newly added golfer appears. **Adding a golfer record does not create their sign-in account**; each invited Regular User creates their own login when accepting their personal invitation.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B06. Admin generates and sends the Regular User invitation(s)
**Tap:**
1. On the **Review Golfer** row, tap **Invite**.
2. Read the invitation text, including the app-download step and the personal join link.
3. Use the Share / Copy action to send that invitation to a different reviewer-controlled email/device.
4. Repeat the invitation operation for Review Golfer 2 if the optional second member is being tested, using a **different invitation and different email/account**.
5. Return to Manage.

**Expected:** The Apple Admin reviewer can generate **one personal member invitation for each test golfer**, without asking the developer to prepare member accounts. The roster displays **Re-send** until each person joins. Do not post the link publicly.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B07. Re-send an outstanding invitation
**Tap:**
1. While the regular user has **not** accepted the invite, locate the row.
2. Tap **Re-send** and examine the newly shared invitation.
3. Preserve only the latest valid invitation for the Regular User.

**Expected:** Invite sharing is available without creating a duplicate golfer. Invitation behaviour remains one-time-use.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B08. Set a starting handicap index
**Tap:**
1. Locate Review Golfer (fewer than 3 rounds).
2. Tap **Index**.
3. Enter **18.2** and tap **Save**.
4. Verify the displayed starting index.

**Expected:** A starting index appears. After enough scores determine an actual index, the manual "Index" action becomes disabled.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B09. Inspect course and tees
**Tap:**
1. In **Manage → Courses**, open an existing sample course.
2. Check each tee's rating, slope and par.
3. Where permitted, tap **Edit**, make a harmless fictional-data correction and save; otherwise return without editing.

**Expected:** Course details are readable; an Admin can edit a permitted course but not one the app identifies as entered by someone else.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B10. Add a sample course only if needed
**Tap:**
1. Tap **Manage → Courses → Add a course**.
2. Enter/search a test course, add a tee with required rating, slope and par.
3. Save and reopen.

**Expected:** Course and tee appear and can be chosen during round entry. Skip this test if valid sample courses already exist.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B11. Enter a round for a golfer (Admin)
**Tap:**
1. Open **Enter**.
2. Choose Review Golfer or another fictitious test golfer, then select the date.
3. Select a demonstration course and tee.
4. Type **91** for gross score; enter an adjusted score only if required.
5. Tap **Post round**.

**Expected:** One and only one round is posted. The app displays a meaningful confirmation or status and updates group data.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B12. Inspect History and correct a round
**Tap:**
1. Open **History**.
2. Filter by the test golfer and date.
3. Locate the 91-stroke round and tap **Edit**.
4. Change its score to **90**, then tap **Save changes**.
5. Reopen the entry and review its values.

**Expected:** The score is 90, not duplicated; any recalculation uses the corrected value.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B13. Confirm Admin history permissions
**Tap:**
1. In History, change the golfer filter to a different sample golfer.
2. Review only fictional data.
3. If a test entry is incorrectly associated, use permitted correction controls.

**Expected:** The Admin can view group rounds and perform corrections within their role. No permission error on authorised operations.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B14. Read handicaps and rankings
**Tap:**
1. Open **Summary**.
2. Locate the group's handicap list and the **Rankings** section.
3. Choose a year and, if available, a month; tap **Share** to view the sharing sheet (cancel sending).

**Expected:** Handicap indexes and rank order display. Results do not contain duplicate rows and share text matches the screen.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B15. Create a single-day game
**Tap:**
1. Open **Games → Add a game**.
2. Choose today, a demo course and the name **Apple Review Game**.
3. Tap **Save game** and open it.

**Expected:** The event appears in Games with the correct name, date and course.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B16. Record scores in a game
**Tap:**
1. Within the test game, tap **Enter scores for everyone**.
2. Choose the correct common tees.
3. Type scores only for fictional golfers, leaving other fields blank.
4. Tap **Post the scores** (or the numbered **Post N scores** button).

**Expected:** Only filled rows are posted; existing rounds are not duplicated. Results appear in the game leaderboard.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B17. Inspect the game leaderboard and share
**Tap:**
1. Open Apple Review Game.
2. Review gross/net scores and placement.
3. Tap **Share** if present; view text and cancel or send it to your own test address.

**Expected:** Correct fictional names and scores appear. Sharing does not alter rounds.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B18. Create a multi-day game
**Tap:**
1. Tap **Games → Add a game**.
2. Choose **Runs over more than one day**.
3. Enter a first and last date, select a course and a new fictional game name.
4. Save and open.

**Expected:** The game displays its date span and a day-by-day standing once test scores are recorded.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### B19. Validate Admin member removal (optional, destructive)
**Precondition:** A **separate disposable** regular test member exists and is not needed for later tasks.  
**Tap:** Open **Admin → Members**, find the disposable member and tap **Remove from group**, then confirm.  
**Expected:** The removed test member loses that group's access; their previously posted golfer rounds remain. **Do not remove Review Golfer until after Part C.**  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

---

## PART C — Regular User invitation and account

### C01. Finish Regular User invitation on a different account
**Start:** The Apple Admin reviewer completed B05–B06 and privately sent the member invitation. **The Regular User account does not exist until the recipient completes this step.**  
**Tap:**
1. Open the member invitation **generated by the Apple Admin reviewer** on a second reviewer-controlled email/device.
2. Use the **Step 2 join link** in Apple's installed Build 24.
3. Tap **Create account** with a **different email/password** from the Admin.
4. After signing in, confirm **Review Golfer** and tap **Yes, that's me — join**.

**Expected:** The reviewer has now created a **new Regular User test account** from the Admin-generated invitation. The review golfer joins as a normal member; the named golfer's scores/history follow the record without duplication. If a second golfer was invited, repeat C01 using a distinct account.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### C02. Verify Regular User tabs and permissions
**Tap:** Open **Enter**, **My rounds**, **Summary** and **Games**.  
**Expected:** These four tabs work. **Manage and Admin do not appear** for a regular member. The member cannot edit another golfer's private round history.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### C03. Enter an ordinary member round
**Tap:**
1. Open **Enter**. The regular member is already associated with Review Golfer.
2. Start at course/tee selection, choose an existing demonstration course, choose tees, then tap **Next**.
3. Enter score **88**.
4. Select **Not part of a game** unless deliberately testing game linkage.
5. Tap **Post round**.

**Expected:** A single round for the *signed-in golfer* is saved. A regular member cannot select another member to post for them.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### C04. Check My rounds filters
**Tap:**
1. Open **My rounds**.
2. Use the year and course filters.
3. Find the score from C03 and inspect its date and tees.

**Expected:** The new round appears with correct details. Other golfers' personal round entries are not shown here.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### C05. Check the member's own Summary
**Tap:** Open **Summary**, read the **My season** and handicap sections.  
**Expected:** Own rounds and calculated index or starting index appear. It may take at least three qualifying rounds to calculate the first index, so a blank initial index is not necessarily an error.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### C06. Check shared ranking privacy
**Tap:** In Summary, review the group handicap/ranking list.  
**Expected:** Other golfers' names and indexes can be visible as permitted; regular members cannot inspect other golfers' detailed private rounds.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### C07. View games and results as a member
**Tap:** Open **Games → Apple Review Game**, read its leaderboard and result sheet.  
**Expected:** The member sees published game names/scores and rankings but cannot change the game's administrative setup.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### C08. Test sign-out and return
**Tap:**
1. Locate the account area/sign-out control and select **Sign out of this device**.
2. If required, confirm by tapping the control again.
3. Sign in with **the same Regular User email/password**.

**Expected:** Sign-out does not erase account or golfer history. The consumed invitation is **not** required again.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### C09. Check offline entry and reliable sync (optional)
**Tap:**
1. With the regular account still signed in, turn on Airplane Mode.
2. Enter a single fictional round, noting it is pending.
3. Turn connectivity back on.
4. Wait for **Synced**, then inspect My rounds.

**Expected:** The round is posted **once**, not lost or duplicated. If it remains queued, avoid deleting the account until it syncs.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

---

## PART D — Final self-service account deletion

> **The actual button is a small "Delete my account" link at the bottom of the content of a signed-in screen, immediately ABOVE the bottom navigation bar. It is NOT under Admin/Manage.** See https://www.cuberoot-systems.com/scorecard/quick-start/#q-delete for the actual annotated app screenshot.

### D01. Inspect the deletion sheet without deleting
**Account:** Regular User.  
**Tap:**
1. Scroll to the footer and tap **Delete my account**.
2. Read **Delete your account?**.
3. Read what is removed and what remains.
4. Tap **Keep it**.

**Expected:** The confirmation closes; the account is still usable. No data is deleted.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### D02. Test incorrect password (optional)
**Account:** Regular User.  
**Tap:**
1. Open **Delete my account** again.
2. Type a deliberately wrong Scorecard password.
3. Tap **Delete my account**.

**Expected:** The app rejects the wrong password and does not delete the account. Sign-in stays recoverable.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### D03. Delete the Regular User account
**Account:** Regular User.  
**Precondition:** All saved rounds have synced. The account is not responsible for managing a group.  
**Tap:**
1. Scroll to the footer and tap **Delete my account**.
2. Read the warning: your sign-in and memberships will be removed while golfer history stays.
3. Enter the correct Scorecard password if requested.
4. Tap the red **Delete my account** confirmation.
5. Wait; if complete, tap **Done**.

**Expected:** The app shows **Your account has been deleted** and returns to signed-out state. The same deleted sign-in cannot access member-only content.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### D04. Confirm shared history remains (Admin)
**Account:** Admin.  
**Tap:**
1. Sign in again using the Admin email and password (do not reuse invitation).
2. Open **History** or Manage.
3. Find Review Golfer's previously recorded rounds.

**Expected:** Golfer, rounds and handicap history remain available in the shared group, while the former Regular User account no longer has membership.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### D05. Delete the Admin review account (last task)
**Account:** Admin. This is the FINAL test.  
**Precondition:** Demo group is administered separately and is not owned by this reviewer account; all pending changes are synced.  
**Tap:**
1. On any signed-in screen, scroll down until the footer is visible.
2. Tap **Delete my account**, directly above the bottom navigation bar.
3. Read the consequences: sign-in and group memberships are removed; shared golfer scores remain.
4. Enter the Admin account's correct Scorecard password.
5. Tap **Delete my account** to confirm.
6. Wait for **Your account has been deleted** and tap **Done**.

**Expected:** Admin account deletion succeeds. The reviewer is signed out and cannot access the group with the deleted account. **No group deletion is needed or requested.**  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

### D06. If deletion is interrupted
**Only if this happens naturally.** Do not deliberately crash or tamper with the app.  
1. If **Your account isn't deleted yet** appears, tap **Try again** when connected.
2. If **This account is being deleted** appears, the app says you have been signed out and background completion will finish automatically (typically within 20 minutes, otherwise within a day).
3. If a message says changes are waiting to upload, leave the account in place until it shows **Synced**.
4. Report a persistent problem with **Send a report** or Scorecard Support (omit passwords/links).

**Expected:** No hanging, silent failure or ambiguous account state.  
**Result:** ☐ Pass ☐ Fail ☐ Not tested

---

## PART E — Acceptance summary (complete after testing)

| Scope | Tests | Result |
|---|---|---|
| Admin invitation and first sign-in | A01–A06 | ☐ Pass ☐ Fail |
| Admin/group navigation and management | B01–B10 | ☐ Pass ☐ Fail |
| Score, handicap and game workflows | B11–B18 | ☐ Pass ☐ Fail |
| Regular user joining and privacy | C01–C08 | ☐ Pass ☐ Fail |
| Offline behaviour (optional) | C09 | ☐ Pass ☐ Fail ☐ Not tested |
| Account deletion and retained golf records | D01–D06 | ☐ Pass ☐ Fail |

**App version/build confirmed:** __________  
**Device & iOS version:** __________  
**Date/time and time zone:** __________  
**Overall:** ☐ Pass ☐ Fail / needs developer reply  
**Issues with step IDs and exact error text:** __________

### Troubleshooting and privacy
- Only use the **one-time** invitation for first join. Subsequent visits use the same email/password.
- If the pre-release App Store download link is not yet active, use Apple's already-installed review build.
- Never paste invitation tokens or account passwords into screenshots, reports or public messages.
- If a named control differs from the actual Build 24 UI, record the exact difference, do not invent another action, and contact the reviewer support address.
- Support: https://www.cuberoot-systems.com/scorecard/support/
- Privacy: https://www.cuberoot-systems.com/scorecard/privacy/

**End of Apple App Review guide.**
