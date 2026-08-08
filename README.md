# The Scorecard — Version 2

Complete: data layer **and** screens. Nothing is deployed until you upload it.

## Setting it up — about 15 minutes

**1. Firestore rules.** Firebase console → Firestore → Rules → paste `firestore.rules` → Publish. This is the only console work.

**2. Upload these files** to your repository, the same way you have been doing. Your `firebase-config.js` is deliberately not in the zip, so it is not overwritten.

**3. Open the app.** You will be asked to create a group. Name it, name yourself, done — you become the owner.

**4. Invite everyone.** Manage → People → Send an invitation. It produces a link for WhatsApp or email. One tap, they type their name, they are in. No account, no password, nothing Safari can block.

That last point is what fixes your iPad. Joining needs no pop-up and no redirect.

## What is new

| | |
| --- | --- |
| **Join by link** | One tap. No email, no password, no Google. |
| **Roles** | Owner, admin, guest. Guests post rounds; only admins see Manage. |
| **Games** | Group an outing's rounds and get a leaderboard for the day. |
| **Rankings** | Monthly and annual, on net and gross, shareable. |
| **24-hour edit window** | Enforced by Firestore against the server clock, not the device. |
| **One document per round** | Sixteen people posting at once no longer overwrite each other. |
| **Course lookup key in the database** | Entered once by the owner, in the app. No file to maintain, nothing to overwrite on upload. |

---

## What is in this folder

| File | What it does |
| --- | --- |
| **model.js** | The domain. Handicap maths, document shapes, the version 1 migration transform. No Firebase, no browser — every function is pure. |
| **outbox.js** | The offline write queue. Holds changes made without signal and replays them in order when it returns. |
| **store.js** | Everything that touches Firebase. Auth, joining, posting rounds, live reads. The only file that imports the SDK. |
| **migrate.js** | The one-time import of a version 1 scorecard. |
| **firestore.rules** | The security rules. This is the real enforcement layer. |
| **test/** | 39 checks that run under node with no network and no Firebase project. |

Run the tests:

```
node test/foundation.test.mjs
node test/outbox.test.mjs
```

---

## The four decisions that shape everything

### 1. One document per round

Version 1 kept the whole scorecard in a single document, so every save rewrote everything. Firestore allows roughly one write per second to one document, and overlapping saves overwrite each other **silently** — the round disappears with no error.

Each round is now its own document. Sixteen golfers posting at once write to sixteen different places and never collide. The one megabyte document limit stops applying to your history.

### 2. Each golfer carries their own recent-differential window

The handicap index needs the last twenty differentials. Querying twenty rounds every time a screen draws is what makes an app expensive at scale — Firestore bills per document read.

So each golfer document holds a `recentWindow` of its own last twenty entries, and its `handicapIndex` alongside. **Posting a round reads no round history at all.** It updates the window in memory, recomputes the index, and writes the golfer document.

Editing or deleting a round is rarer and correctness matters more, so `rebuildGolferIndex()` re-queries that golfer's last twenty and rebuilds.

### 3. Course details are copied onto every round

Rating, slope, par and tee name are stored on the round itself rather than looked up from the course.

This is about **correctness, not speed**. When a course is re-rated, rounds already played must keep the rating that applied on the day. A round is a permanent record of what happened, not a live view.

### 4. Everything writes through the queue, online or offline

There is one write path, not two. `postRound()` puts operations in the outbox and asks it to flush. If there is signal it lands immediately; if not it waits. The app behaves identically either way, and there is only one path to get right.

---

## The offline queue

This is the part most likely to lose somebody's round, so the design is deliberately boring.

- **Every operation carries an `opId`.** Replaying one twice does the same as replaying it once. A double tap on Post cannot create two rounds.
- **Oldest first.** An edit never lands before the create it depends on.
- **Removed only after the write is confirmed.**
- **A failure stops the run** rather than skipping ahead, because skipping would apply changes out of order.
- **After 50 failed attempts an operation is set aside** into an `abandoned` list rather than blocking every later change forever. It is kept, not silently dropped.
- **Repeated edits to the same document collapse** into one write while still offline.

Tested against the real scenario: three rounds posted with no signal, connection returns, all three arrive exactly once and in order.

### The server timestamp trap

A queued operation may sit in localStorage for hours, and Firestore's `serverTimestamp()` sentinel does not survive being turned into JSON. So the queue stores a placeholder and swaps it for the real sentinel at write time.

This matters more than it looks: the security rules require `enteredAt` to equal the server's clock. A plain number would have every round rejected.

---

## Security rules

There is no server tier in this app. **Anything not enforced in the rules is not enforced.**

Three things are enforced there that the interface also shows, and must never be trusted to the interface alone:

**The join code.** Rules compare the submitted code against the association document. Rules can read that document even though the person cannot, so the code is never exposed and editing the app code gains nothing.

**The 24-hour edit window.** Measured with `request.time` — the server's clock, not the device's. A create must set `enteredAt` to the server timestamp, so a device cannot date a round in the future to give itself an indefinite window.

**The owner's permanence.** The owner cannot be demoted or removed by anyone, including themselves.

### Who can do what

| | Member | Admin | Owner |
| --- | --- | --- | --- |
| Post a round for anybody | yes | yes | yes |
| Edit a round within 24 hours | yes | yes | yes |
| Edit a round after 24 hours | no | yes | yes |
| Delete a golfer | no | yes | yes |
| Grant or revoke admin | no | no | yes |
| Be demoted | — | by owner | never |

---

## Migration from version 1

Three safety properties, in order of importance:

1. **The version 1 document is never touched.** If anything goes wrong, version 1 still works and still has every round.
2. **Ids are derived from the data, not generated.** Running the import twice writes the same documents instead of duplicating them. This is tested.
3. **Every round keeps the rating and slope recorded on the day.**

The flow is `readV1()` → `preview()` → show it to the owner → `run()` → `verify()`. The verify step confirms what actually landed in Firestore rather than assuming the writes succeeded.

---

## What is deliberately missing

| Not built | Why | Build it when |
| --- | --- | --- |
| Screens | Waiting on your trial feedback | Version 1 trial gives results |
| Game and ranking UI | Three of the four open decisions affect it | Decisions answered |
| Cloud Functions | Needs the Blaze plan | Cost decision made |
| Precomputed leaderboards | No association-wide screens yet | Version 3 |
| Pagination | `watchRounds` is capped at 500 | Beyond ~1000 rounds on screen |
| Join code rotation | Not yet worth policing | Version 3 |

The 500-round cap on `watchRounds` is there on purpose. An unbounded query is exactly the thing that quietly runs up a Firebase bill, so it is capped now and paginated later.

---

## Known limitations

**Shared courses are edit-your-own.** Only whoever added a course can change it. A shared library invites well-meaning edits that break other groups' history. Version 3 should add a curated review step; until then, a wrong rating gets a new entry rather than an edit war.

**Any member can edit any round within 24 hours.** This follows directly from "anyone can post for everybody" — the same people who enter a score can fix it. If you would rather people only edited their own entries, it is a one-line rule change.

**Join codes have no rate limiting.** Someone could guess at codes. Six characters from a 30-character alphabet is about 730 million combinations, so this is theoretical, but it is not defended against.

**The index is recomputed on the client.** Inside the app, not on a server. A modified client could write a false index. Version 3 moves this to a Cloud Function.

---

## Deploying this

**Not yet.** When you are ready:

1. Publish `firestore.rules` in the Firebase console — the version 2 rules replace the version 1 ones, and they are not compatible
2. Reuse your existing `firebase-config.js`; it is not in this folder on purpose so it cannot be overwritten
3. The owner runs the import once
4. Verify the round count matches before anyone else joins

Version 1 stays deployed and working throughout.
