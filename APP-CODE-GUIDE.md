# The Scorecard — Illustrated Application & Code Guide

**Documentation snapshot:** 7 November 2026  
**Scope:** web, iOS and Android application architecture. Documentation only; no application code, Firebase rules, builds or deployments are changed by this guide.

## 1. What the application does

The Scorecard is the group golf-record system. It manages golfers, groups, invitations, course records, rounds, handicaps, games and rankings. Members use the same product across the web and native mobile releases, while a small platform adapter handles device-specific operations.

### Platform and source snapshot

| Target | Source branch | Source version recorded in version.js | Notes |
|---|---|---:|---|
| Web production | main | 2.30.0 | Protected web line; do not assume it contains later native-branch changes |
| iOS / App Store source | v2 | 2.31.2 | Current iOS source snapshot reviewed for this guide |
| Android / Fire HD 8 | android | 2.31.2-android.1 | Separate native adapter and Android packaging |

The branch is the authority for its own code. Equal version labels do not prove that two builds contain identical files or have passed the same device tests.

## 2. System architecture

The design separates the user interface, golf rules, cloud access, offline queue and platform-specific device behavior.

~~~mermaid
flowchart TD
  U[Golfer / Group Administrator] --> UI[app.js — screens and user actions]
  UI --> M[model.js — golf and group domain rules]
  UI --> S[store.js — Firebase access]
  S --> Q[outbox.js — ordered offline writes]
  Q --> F[(Firebase Authentication + Firestore)]
  F --> R[firestore.rules — server-side authorization]
  UI --> P[platform.js — platform boundary]
  P --> W[Browser / PWA]
  P --> I[Capacitor iOS plugins]
  P --> A[Capacitor Android plugins]
~~~

**Key rule:** the interface does not decide whether a write is authorized. Firestore security rules enforce membership, role permissions, edit windows and protected ownership.

### Main code modules

| File | Responsibility |
|---|---|
| app.js | Screens, navigation, form handling, status and user-facing messages |
| model.js | Pure golf calculations, join-code helpers, round/window transformations and domain rules |
| store.js | Authentication, group membership, reads/writes and Firebase listeners |
| outbox.js | Offline write queue, replay ordering, duplicate protection and retry handling |
| platform.js | Browser versus iOS/Android behavior, links, sharing and native file operations |
| courses-api.js / lookup-key.js | Course lookup and course-key integration |
| firestore.rules | Actual authorization boundary for Firestore |
| version.js | Single source of truth for app version/build labels |
| test/ | Automated tests for model, queue, screens, joining and related behavior |

## 3. How a round is saved

A round is not stored as one giant group document. Each round has its own Firestore document. This prevents simultaneous golfers from overwriting one another's scores.

~~~mermaid
sequenceDiagram
  participant G as Golfer
  participant A as app.js
  participant M as model.js
  participant Q as outbox.js
  participant S as store.js
  participant F as Firestore
  G->>A: Enter and save round
  A->>M: Calculate/validate golf values
  A->>Q: Queue operation with unique opId
  Q->>S: Flush oldest pending operation
  S->>F: Write round + golfer index update
  F-->>S: Confirm or reject under rules
  S-->>Q: Confirmed write removes queue item
  S-->>A: Updated status / actionable error
~~~

### Offline behavior

- The same write path is used whether the device is online or offline.
- Each operation has an operation ID so replaying it does not create a duplicate.
- The queue preserves order; a dependent edit cannot overtake its create.
- A queued item is removed only after the write is confirmed.
- A failed operation does not silently disappear. Repeated failures are set aside for recovery rather than being discarded.
- An offline cache miss is treated as unknown data, not proof that a golfer or group does not exist.

## 4. Handicap and golf domain model

The handicap calculations live in model.js and are kept independent of Firebase and the screen layer. This makes the rules testable without a browser or network.

### Score-to-index flow

~~~mermaid
flowchart TD
  R[Round score] --> AG[Adjusted gross score]
  AG --> D[Score differential using course rating and slope]
  D --> W[Golfer's recent differential window]
  W --> L[Select lowest counting differentials]
  L --> H[Handicap index]
  H --> CH[Course handicap for selected tee]
~~~

The current model:

- Calculates a differential using adjusted gross score, course rating and slope rating.
- Uses the World Handicap System scale for fewer than 20 posted rounds.
- Uses the golfer's most recent 20 differentials as the rolling window.
- Stores the window newest-first, then orders it chronologically for index calculation.
- Rebuilds the window when a round is edited or removed.
- Preserves course rating, slope, par and tee details on the round so a later course update does not rewrite golf history.

The current source caps the calculated index at 54.0. This guide describes the code's implemented calculation; it is not a substitute for Golf Canada's official handicap record.

## 5. Groups, membership and roles

The app organizes golfers inside groups (associations). Invitations provide a controlled way to join. Membership and role permissions are checked by Firestore rules, not just by hiding buttons.

Typical responsibilities:

| Capability | Member | Admin | Owner |
|---|---:|---:|---:|
| Post rounds | Yes | Yes | Yes |
| Edit a round within the allowed window | Yes | Yes | Yes |
| Edit after the normal window | No | Yes | Yes |
| Manage golfers | No | Yes | Yes |
| Grant or revoke admin | No | No | Yes |
| Remove or demote the owner | No | No | Never |

The exact interface may differ by platform branch. Use the branch's current rules and acceptance records when investigating a permissions question.

### Invitation flow

~~~mermaid
sequenceDiagram
  participant O as Owner/Admin
  participant A as Scorecard
  participant L as Invitation link
  participant N as New golfer
  participant R as Firestore rules
  O->>A: Create invitation
  A->>L: Create one-time join link
  O->>N: Share link
  N->>A: Open link / app
  A->>R: Request membership using invitation
  R-->>A: Validate invitation and role
  A-->>N: Show joined group
~~~

The native platform adapter receives app links from Capacitor on supported mobile builds. It normalizes duplicate link deliveries so one invitation is not processed repeatedly.

## 6. Games, rankings and course history

- **Rounds** are individual records and preserve the tee/course facts used at the time of play.
- **Games** group rounds from an outing and provide a game leaderboard.
- **Rankings** present monthly and annual results, including gross and net views where supported.
- **Course records** are managed separately from historical round snapshots.
- **Golfer handicap windows** are maintained to avoid querying a golfer's full round history for every index display.

## 7. Platform adapter: web, iOS and Android

The shared JavaScript application owns the business rules. The platform adapter is the boundary for native behavior.

~~~mermaid
flowchart LR
  CORE[Shared JavaScript app + model + store]
  CORE --> AD[platform.js]
  AD --> WEB[Web / PWA browser APIs]
  AD --> IOS[iOS Capacitor bridge]
  AD --> AND[Android Capacitor bridge]
  IOS --> SW[Native iOS plugins]
  AND --> NAT[Scorecard Android plugin]
~~~

### Web

The browser path uses browser capabilities and the web deployment. The platform module also supplies the canonical web, guide, privacy, support and invitation URLs.

### iOS

The iOS app hosts the shared web application inside Capacitor. Native functions are reached through the Capacitor bridge. Swift is used for platform integration where required; the golf business rules remain in the shared JavaScript model.

### Android

The Android branch has an Android-aware adapter and a dedicated native plugin path. The adapter reads the live Capacitor bridge because Fire OS may expose native plugins after initial JavaScript module evaluation. If Android is detected but the native save bridge is unavailable, the code fails closed instead of accidentally falling through to an unrelated browser share path.

Android-specific backup/download behavior belongs to the Android adapter and must not be copied blindly into web or iOS code.

## 8. Security and data ownership

- Firestore rules are the authoritative enforcement layer.
- Invitation codes and group membership must be validated by rules.
- The normal round-edit window is measured against server time, not the device clock.
- The owner role is protected from demotion/removal.
- The UI is not a security boundary; hiding a button does not replace a Firestore rule.
- Never place service-account credentials, signing keys or private owner credentials in the client application or public documentation.

## 9. Accessibility and display

The Scorecard stylesheet includes a dark theme through its theme variables and a scalable text-size control. The text-size control changes the root font size so rem-based interface elements scale together. Verify the exact controls and current default on the target branch/build before describing them to end users.

Large text, clear score states, readable status messages and adequate touch targets are part of the app's usability, not merely decoration.

## 10. Backups, tests and maintenance

- Backup/export behavior is platform-specific. The Android branch includes native save-to-device behavior and was separately accepted on Fire HD 8; do not infer identical file destinations on iOS or web.
- Automated tests should be run from the relevant branch before any future release is authorized.
- A release should update version.js, automated tests, user guides and release notes together.
- Data-model changes require a migration plan and an explicit statement of what happens to existing records.
- Changes to firestore.rules must be called out separately because publishing rules is a production operation.

## 11. Source map

Use these source files when tracing a behavior:

| Question | Start here |
|---|---|
| Which screen handles this action? | app.js |
| How is a handicap calculated? | model.js |
| Where does a Firestore read/write happen? | store.js |
| Why is an offline write waiting? | outbox.js |
| Why does iOS or Android behave differently? | platform.js on that branch |
| Who is allowed to perform the write? | firestore.rules |
| Which build/version is this? | version.js and the branch's release record |

## 12. Change-control status

**Development remains frozen unless the owner explicitly authorizes it.** This guide is documentation only. It does not authorize source-code changes, Firebase rule publication, deployment, TestFlight submission, APK generation or release.
