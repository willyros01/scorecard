# The Scorecard — App Store paperwork (DRAFT)

Draft for App Store Connect, written from the migration spec (section "App Store Connect"),
the app's `build/ios/PrivacyInfo.xcprivacy`, and the live privacy page. Nothing here has been
entered into App Store Connect. Items marked **CONFIRM** need your decision or a Phase 4 device
check before submission.

## 1. App record (create first — spec: "before any build")

| Field | Value |
|---|---|
| Platform | iOS (iPhone and iPad) |
| Name | The Scorecard |
| Primary language | English (U.S.) |
| Bundle ID | io.github.willyros01.scorecard |
| SKU | scorecard-ios |
| User access | Full access |

If Apple says the name is taken, fallback names (all ≤ 30 characters): **The Scorecard: Golf Handicaps**, **The Scorecard – Golf Groups**.

## 2. App information

| Field | Value |
|---|---|
| Subtitle (≤ 30) | Golf handicaps for your group (29) |
| Category | Primary: Sports. Secondary: none |
| Content rights | Yes, the app shows third-party content: course and tee data looked up from golfcourseapi.com. **CONFIRM** your GolfCourseAPI plan allows use in an app. |
| Age rating | Answer **None / No** to every question (no violence, gambling, contests, mature themes, medical, unrestricted web access, user-generated content shown to strangers). Expected result: 4+. |
| Price | Free (**CONFIRM**; the guide says it costs nothing) |
| Privacy Policy URL | https://www.cuberoot-systems.com/scorecard/privacy/ |
| Support URL | https://www.cuberoot-systems.com/scorecard/support/ |
| Marketing URL | leave empty |
| Copyright | 2026 Wilfredo Rosales |

## 3. Version 2.22.0 — store text

**Promotional text** (≤ 170, can change without review):

> Post the scores after a round and everyone's handicap updates itself. One scorecard for your whole group, on iPhone, iPad and the web.

**Description** (≤ 4000):

> The Scorecard is a golf handicap tracker your group shares. Somebody posts the scores after a round, and everyone's handicap keeps itself up to date.
>
> FOR YOUR GROUP
> • One shared roster, history and set of handicaps for everyone in the group
> • Invite people with a link — they tap it and they're in
> • Several groups, and tournaments over more than one day
> • Owners and admins can correct scores and manage the roster
>
> HANDICAPS, WORKED OUT PROPERLY
> • Handicap indexes calculated the World Handicap System way from each golfer's recent rounds
> • Course handicaps from the course and tee you played
> • Look up courses and tees by name
>
> WORKS ON THE COURSE
> • Post a round with no signal — it uploads once you're back online
> • Your group, rounds and handicaps stay readable offline
>
> SHARE AND KEEP
> • Share results by WhatsApp, email, text message or copy
> • Save a backup of your group's rounds to Files or iCloud Drive
>
> ONE ACCOUNT EVERYWHERE
> The app and the website at willyros01.github.io/scorecard use the same account and the same data. Sign in with your email and Scorecard password and your groups are there.
>
> No adverts. No tracking. Delete your account at any time from the foot of any screen.

**Keywords** (≤ 100, comma-separated, no spaces needed):

> golf,handicap,scorecard,WHS,index,group,league,society,rounds,scores,tournament,course,tee

**What's New** (first release): leave as the default for version 1, or: "The Scorecard is now an app for iPhone and iPad."

**Screenshots** — required sizes: 6.9-inch iPhone (1320×2868) and 13-inch iPad (2064×2752). Suggested five: the group's handicap list, posting a round, History, an invitation's join screen, the offline "showing saved copy" status. Take them from the TestFlight build in Phase 4 with the demo group (no real names).

## 4. App privacy (the "nutrition label")

Spec: the label is recalculated from the finished app during Phase 4 (device check **P1**, Web
Inspector traffic survey); the label, `PrivacyInfo.xcprivacy` and the privacy page must agree.
This draft is the current `PrivacyInfo.xcprivacy`, answer by answer. **CONFIRM after P1.**

**Do you or your third-party partners collect data from this app?** Yes.

| Apple data type | Collected | Linked to the user | Used for tracking | Purpose | Where it comes from |
|---|---|---|---|---|---|
| Contact Info → Email Address | Yes | Yes | No | App Functionality | Email-and-password sign-in (Firebase Authentication) |
| Contact Info → Name | Yes | Yes | No | App Functionality | Golfer name shown to the group |
| Identifiers → User ID | Yes | Yes | No | App Functionality | Firebase account ID |
| User Content → Other User Content | Yes | Yes | No | App Functionality | Rounds, scores, games, group membership |
| Diagnostics → Other Diagnostic Data | Yes | No | No | App Functionality | Bug report details, only when the user sends one (Formspree) |

Not collected (answer No): Health & Fitness, Financial Info, Location, Sensitive Info, Contacts,
Browsing History, Search History (course-search text goes to golfcourseapi.com only to answer that
search, in real time), Purchases, Usage Data, Crash Data, Performance Data, Photos or Videos,
Audio, Gameplay Content, Customer Support, Device ID, Advertising Data.

**Tracking:** No. The app does not track users (`NSPrivacyTracking` false, no tracking domains).

## 5. App Review information

**Sign-in required:** Yes.

**Demo account** (spec: an admin, not the owner, in a demo group whose owner is a separate test
account, so the reviewer can try Delete my account without meeting the owner refusal):

| | |
|---|---|
| User name | *reviewer email — created in Phase 4* |
| Password | *created in Phase 4* |

Before each submission: re-create the reviewer account if a reviewer deleted it, and re-invite it
to the demo group as admin.

**Notes for the reviewer** (≤ 4000):

> The Scorecard keeps golf scores and handicaps for a private group of golfers. There is no public content and no purchases.
>
> To review:
> 1. Open the app and tap Sign in. Use the demo account above. You are an admin of the group "Demo Golf Society", which already has golfers, courses and rounds.
> 2. Post a round: tap Enter, choose a golfer, the course and tee, type a score, and tap Post round. The round appears in History.
> 3. See the handicap: the golfer's handicap index updates to include the new round.
> 4. Delete the account: at the foot of any screen tap "Delete my account", read what remains, and confirm with the demo password. The app shows "Your account has been deleted" and the account no longer exists. The golfer's name and rounds stay with the group so the other golfers' shared history stays correct; this is stated in the privacy policy.
>
> Sign-in is an email and a password for this app only. There is no third-party or social sign-in, so Sign in with Apple is not required (Guideline 4.8).
>
> The app works offline: rounds posted without a signal upload once the device is back online.
>
> Contact: Wilfredo Rosales, willyros01@gmail.com

**Contact information:** Wilfredo Rosales · willyros01@gmail.com · phone **CONFIRM** (Apple requires one).

## 6. Export compliance

Set in the build: `ITSAppUsesNonExemptEncryption` = NO (audit check A7). App Store Connect does not
ask the encryption questions for these builds.

## 7. Still needed before submission

1. The App Store Connect app record (section 1) — also unblocks the first TestFlight build.
2. Demo group "Demo Golf Society" with a separate owner test account and the reviewer admin account (Phase 4).
3. P1 traffic survey, then final privacy answers (section 4).
4. Screenshots from the TestFlight build.
5. The three CONFIRM items: price, GolfCourseAPI content rights, review contact phone.
