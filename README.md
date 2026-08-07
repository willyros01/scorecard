# The Scorecard

A golf handicap tracker: post rounds, watch your World Handicap System index, and send an update to the group. Works with no signal and installs to the home screen.

Five screens — **Enter**, **History**, **Summary**, **Share**, **Manage** — the same shape as the expense tracker, with Summary drilling year → month → golfer into a filtered History.

No build step. Plain ES modules, so what's in the repo is what runs.

---

## 1. Firebase (about 5 minutes)

1. At [console.firebase.google.com](https://console.firebase.google.com), create a project. Analytics is optional.
2. **Build → Firestore Database → Create database**. Standard edition, Native mode, a nearby region, production mode.
3. **Rules** tab → paste the contents of `firestore.rules` → **Publish**. These say a scorecard is readable and writable only by the account that owns it.
4. **Build → Authentication → Get started**. Enable **Anonymous**. Enable **Google** too if you want one scorecard across phone and laptop.
5. **Project settings → Your apps → Web (`</>`)**. Register the app, copy the `firebaseConfig` object.
6. Paste those values into `firebase-config.js`.

> **If creating the database shows a billing warning:** check the Firestore panel anyway. The warning is sometimes cosmetic and the database gets provisioned regardless. A healthy setup shows database ID `(default)` and **Spark · No-cost ($0/month)** at the bottom left of the console.

The API key in that file is safe to commit — Firebase web keys identify the project, they don't grant access. The rules in step 3 are what protect the data. Leave the placeholders in place and the app still runs, just without sync.

## 2. GitHub

```bash
git init
git add .
git commit -m "The Scorecard"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/scorecard.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: GitHub Actions**. The workflow in `.github/workflows/deploy.yml` publishes on every push to `main`; the first run takes a minute or two.

**Uploading through the browser instead of git?** The `.github/` folder won't upload — browsers skip dot-folders, and on iOS it's impossible. Upload the other files, then on the Pages screen click **Configure** on the **Static HTML** suggested-workflow card and commit the file GitHub generates. It does the same job as `deploy.yml`. Keep one or the other, never both — two workflows publishing to Pages will fight over each deploy.

Your app lands at `https://YOUR-USERNAME.github.io/scorecard/`.

## 3. Authorize the domain

Back in Firebase: **Authentication → Settings → Authorized domains → Add domain** → `YOUR-USERNAME.github.io`. Sign-in fails without this.

## 4. Install it

Open the URL on your phone. iOS: Share → Add to Home Screen. Android: the install prompt appears on its own. It then launches full-screen and opens without a connection.

---

## How offline works

| Where you are | What happens |
| --- | --- |
| Online | Writes go to Firestore at `users/{uid}/data/scorecard`, and a read cache is kept in `localStorage` so the app opens instantly next time. |
| Offline | The round is written to `localStorage` under `golf:pending` and the header pill turns red — "Saved on device". Everything stays usable. |
| Back online | The pending snapshot uploads, and **`golf:pending` is deleted** the moment Firestore confirms. It retries every 20 seconds and on the browser's `online` event. |

If the same scorecard is edited on two devices while one is offline, the newer `updatedAt` wins — the app never silently merges two versions. For a small group posting their own rounds this is fine; if two people will edit simultaneously, that's the piece to revisit.

The **Storage** pill in the header opens a plain-text backup you can copy or paste back, which is worth doing before any risky change.

## When something fails

The app never shows a blank screen. Failures land in one of three places:

- **A red banner under the header** — the app keeps working, but sync has a problem. The banner names it: rules not published, domain not authorized, anonymous sign-in switched off, quota reached, offline. Each one says which console page to fix it on.
- **An error card in place of the screen** — the app couldn't start at all, or a screen failed to draw. It names the likely file and offers Reload, with the raw error under "Technical detail".
- **The status pill** — tap it any time for the current state plus the last error.

`firebase-config.js` is loaded dynamically for exactly this reason: a missing comma in it used to kill the whole page silently. Now it produces "firebase-config.js couldn't be read" and the app carries on storing rounds locally.

## Course lookup

Adding a course normally means typing the rating and slope off the scorecard — four numbers per tee. You can skip that:

1. Get a free key at [golfcourseapi.com](https://www.golfcourseapi.com/sign-in).
2. **Manage → Course lookup** → paste it → **Save key**. It stays in this browser and is never synced.
3. **Manage → Courses → New** now has a search box. Type part of the course or club name, tap a result, and every rated tee is filled in.

Always check the filled-in numbers against the scorecard before saving — course ratings get revised, and third-party databases lag.

Without a key the app is unchanged: type the tees in by hand. Everything degrades to a plain sentence explaining what to do — no key, offline, no match, no published rating.

To use a different data provider, edit `ENDPOINT`, `AUTH` and `normalize()` in `courses-api.js`. Nothing else in the app knows where course data comes from.

## Versioning

`version.js` holds the version in one line and is loaded by both the app and the service worker:

```js
self.APP_VERSION = "1.1.0";
```

Bump it when you ship a change. That updates the version shown at the foot of the **Summary** screen *and* changes the service worker's cache name, so installed devices pick up the new files. This replaces the old "remember to bump CACHE in sw.js" step — there's now one place to edit.

## Sharing

The Share tab builds a plain-text update — index, recent average, best differential, latest round — and hands it to WhatsApp (`wa.me`), email (`mailto:`), text message (`sms:`), the clipboard, or the system share sheet on phones that support it. Nothing is sent anywhere without you tapping through.

## Night mode

Automatic by clock: dark from 7pm to 6am, rechecked every five minutes. The header button cycles **Auto → Day → Night** and remembers your choice. To follow the system setting instead of the clock, swap the check in `applyTheme()` for `matchMedia("(prefers-color-scheme: dark)")`.

## The handicap math

- Score Differential = (113 ÷ Slope) × (Adjusted Gross − Course Rating)
- Handicap Index = average of the lowest 8 of your last 20 differentials, rounded to a tenth, capped at 54.0
- Under 20 rounds, Rule 5.2a's sliding scale applies (3 rounds → lowest 1 minus 2.0, and so on). Verified against the USGA's own worked examples.
- Course Handicap = Index × (Slope ÷ 113) + (Course Rating − Par)

There is no 0.96 multiplier. That belonged to the pre-2020 USGA system and still shows up on plenty of websites.

**Not implemented:** PCC (daily playing conditions), soft and hard caps against your Low Handicap Index, exceptional score reductions, and 9-hole rounds. Enter adjusted gross yourself — the app doesn't apply net double bogey per hole. This produces an accurate WHS-style index for a friendly group; it is not an official GHIN handicap.

## Files

| File | Role |
| --- | --- |
| `index.html` | Shell, header, tab bar |
| `app.js` | Screens, handicap math, sharing, night mode |
| `db.js` | Firestore sync, the offline queue, auth |
| `firebase-config.js` | Your project keys |
| `courses-api.js` | Course search by keyword. Swap providers here |
| `version.js` | **The one line to bump when you ship a change** — drives both the Summary footer and the offline cache name |
| `sw.js` | Offline caching. Cache name follows `version.js` |
| `firestore.rules` | Paste into the Firestore → Rules tab |

## Local development

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Add `localhost` to the Firebase authorized domains for sign-in to work there. Modules and service workers need a real server — opening `index.html` as a file won't work.
