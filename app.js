import * as db from "./store.js";
import * as model from "./model.js";
import * as lookup from "./courses-api.js";

const VERSION = (typeof self !== "undefined" && self.APP_VERSION) || "dev";
const SUPER_ADMIN = "willyros01@gmail.com";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const today = () => new Date().toISOString().slice(0, 10);

const prettyDate = (iso) => {
  if (typeof iso !== "string" || iso.length < 10) return iso || "No date";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (!months[m - 1]) return iso;
  return `${d} ${months[m - 1]} ${y}`;
};

/* ---- our own calendar ----
 * The iPad's native date input has defeated five attempts: change the month or
 * year and the day grid never draws. Rather than a sixth guess, we draw every
 * part of it ourselves, so it behaves identically everywhere. */
let calendarOpen = false;
let calendarMonth = null;
let calPick = null;   /* "months" | "years" | null */

const monthNames = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

function shiftMonth(ym, by) {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function dayGrid(ym) {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;   /* Monday first */
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return cells;
}

function calendarPanel(value) {
  const showing = calendarMonth
    || (typeof value === "string" && value.length >= 7 ? value.slice(0, 7) : today().slice(0, 7));
  const now = today();
  return `<div class="cal">
    <div class="cal-head">
      <button class="cal-arrow" data-cal="prev" aria-label="Previous month">‹</button>
      <div class="cal-title">
        <button class="cal-jump" data-cal="months">${monthNames[Number(showing.slice(5, 7)) - 1]}</button>
        <button class="cal-jump" data-cal="years">${showing.slice(0, 4)}</button>
      </div>
      <button class="cal-arrow" data-cal="next" aria-label="Next month">›</button>
    </div>
    ${calPick === "months" ? `<div class="cal-pick">
      ${monthNames.map((name, i) => {
        const ym = `${showing.slice(0, 4)}-${String(i + 1).padStart(2, "0")}`;
        return `<button class="cal-pick-btn ${ym === showing ? "picked" : ""}" data-cal-month="${ym}">${name.slice(0, 3)}</button>`;
      }).join("")}
    </div>` : ""}

    ${calPick === "years" ? `<div class="cal-pick">
      ${(() => {
        /* Ten years back and none forward — a round cannot be played in the
           future, and reaching 2025 from 2026 took fifteen taps of an arrow. */
        const thisYear = Number(today().slice(0, 4));
        const years = [];
        for (let y = thisYear; y >= thisYear - 9; y--) years.push(y);
        return years.map((y) => {
          const ym = `${y}-${showing.slice(5, 7)}`;
          return `<button class="cal-pick-btn ${String(y) === showing.slice(0, 4) ? "picked" : ""}" data-cal-month="${ym}">${y}</button>`;
        }).join("");
      })()}
    </div>` : ""}

    <div class="cal-week">${["M","T","W","T","F","S","S"].map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="cal-grid">
      ${dayGrid(showing).map((d) => {
        if (d === null) return `<span class="cal-blank"></span>`;
        const iso = `${showing}-${String(d).padStart(2, "0")}`;
        return `<button class="cal-day ${iso === value ? "picked" : ""} ${iso === now ? "today" : ""}"
          data-cal-day="${iso}" ${iso > now ? "disabled" : ""}>${d}</button>`;
      }).join("")}
    </div>
    <div class="cal-typed">
      <label class="lbl">Or type it</label>
      <input class="field" name="typed-date" inputmode="numeric" placeholder="YYYY-MM-DD"
             value="${esc(value || "")}" autocomplete="off">
      <button class="btn ghost compact" data-cal="typed">Use what I typed</button>
    </div>

    <div class="cal-foot">
      <button class="btn ghost compact" data-cal="today">Today</button>
      <button class="btn compact" data-cal="close">Use this date</button>
    </div>
  </div>`;
}

function dateField(value) {
  return `<button class="field datebtn ${calendarOpen ? "open" : ""}" data-act="open-calendar">
      <span>${esc(prettyDate(value))}</span>
      <span class="datebtn-hint">${calendarOpen ? "▲" : "▾"}</span>
    </button>
    ${calendarOpen ? calendarPanel(value) : ""}`;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/* ================= state ================= */

let ready = false;          /* membership resolved, data flowing */
let association = null;
let golfers = [];
let rounds = [];
let courses = [];
let games = [];
let members = [];
let roster = [];        /* golfer ids playing in this group */
let allGolfers = [];    /* every golfer, everywhere */
let switching = false;
let newGroupDraft = false;
let skipImport = false;
let confirmDeleteGroup = false;
let confirmSignOut = false;
let shareGameNet = true;
let shareGameGross = true;
let settling = false;
let bootMessage = "Opening your scorecard…";

/* The opening screen, as a checklist rather than a sentence. One line tells you
   nothing when it takes longer than expected; four named steps show where it
   has got to — and which one is slow if something is wrong. */
const bootSteps = [
  { key: "auth", label: "Checking your access" },
  { key: "group", label: "Loading your group" },
  { key: "data", label: "Loading recent scores" },
  { key: "ready", label: "Almost ready" },
];
let bootAt = 0;

function markBoot(key) {
  const i = bootSteps.findIndex((s) => s.key === key);
  if (i >= 0 && i > bootAt) { bootAt = i; paintBoot(); }
}

function bootCard() {
  const done = Math.min(bootAt, bootSteps.length);
  return `<div class="boot-card">
    <div class="boot-brand">The Scorecard</div>
    <div class="boot-title">${esc(bootMessage.replace(/…$/, ""))}</div>
    <ul class="boot-steps">
      ${bootSteps.map((step, i) => {
        const state = i < done ? "done" : i === done ? "now" : "todo";
        return `<li class="${state}"><span class="mark">${
          state === "done" ? "✓" : state === "now" ? "◉" : "○"
        }</span><span>${esc(step.label)}</span></li>`;
      }).join("")}
    </ul>
    <div class="boot-bar"><span style="width:${Math.round((done / bootSteps.length) * 100)}%"></span></div>
  </div>`;
}

function paintBoot() {
  if (ready) return;
  const host = document.getElementById("view");
  if (host) host.innerHTML = bootCard();
}
let authForm = { email: "", password: "" };

let tab = "enter";
let sync = { text: "Starting", alert: false };
let flash = null;
let joinForm = { name: "", groupName: "", code: "", ownerPlays: true };
let form = { date: today(), golferId: "", courseId: "", teeId: "", gross: "", adjusted: "", notes: "", gameId: "" };

/* Two ways to enter a round, and the person chooses.
 *
 * "full"  — every field at once. Right for an admin typing in a whole
 *           fourball's cards after a game.
 * "steps" — one thing at a time, large. Right for posting your own round
 *           standing in a car park.
 *
 * The FIELDS, the ORDER and every CHECK are identical in both. Only the
 * layout differs, so nothing about what gets saved can diverge. Defaults to
 * "full", because that is what people already know. */
let enterStyle = null;   /* decided on first use, by role */

/* The right default differs by who you are, so it is chosen the first time
   rather than fixed for everybody: a regular member posts one round for
   themselves — the walk-through; an admin or owner types in a whole fourball —
   every field at once. Remembered afterwards, and either can switch. */
function currentEnterStyle() {
  if (enterStyle) return enterStyle;
  try {
    const saved = localStorage.getItem("golf:v2:enterStyle");
    if (saved === "steps" || saved === "full") { enterStyle = saved; return enterStyle; }
  } catch { /* fall through to the role default */ }
  enterStyle = db.canManage() ? "full" : "steps";
  return enterStyle;
}
let stepIndex = 0;
let stepDateOpen = false;

const setEnterStyle = (which) => {
  enterStyle = which === "steps" ? "steps" : "full";
  stepIndex = 0;
  try { localStorage.setItem("golf:v2:enterStyle", enterStyle); } catch {}
};
let filter = { golferId: "", year: "", month: "", courseId: "" };
let drill = { year: null, month: null };
let openGame = null;
let openCourse = null;
let editingGolfer = null;
let editingIndex = null;
let moreOpen = null;
let editingGame = false;
let invitedGolfer = null;
let invitedGroupName = "";

/* Kept beside the handlers so adding a button and forgetting the selector
   cannot happen silently — a test compares this list against the markup. */
const CLICKABLE = [
  "data-act", "data-tee", "data-go", "data-edit", "data-del", "data-confirm-del",
  "data-unfilter", "data-drill", "data-golfer-index", "data-del-golfer", "data-rename",
  "data-set-index", "data-course", "data-pick", "data-rm-tee", "data-game", "data-role",
  "data-invite-golfer", "data-reinvite", "data-cal", "data-cal-day", "data-cal-month", "data-more",
  "data-drop-round", "data-goto-group", "data-forget-group",
].map((name) => `[${name}]`).join(",");
let courseDraft = null;
let gameDraft = null;
let finder = { q: "", results: [], busy: false, msg: "" };
let rankPeriod = { year: String(new Date().getFullYear()), month: "" };
let editingRound = null;
let confirmId = null;

const view = document.getElementById("view");
const sheetEl = document.getElementById("sheet");
const tabsEl = document.getElementById("tabs");

/* Sorting has to survive a record written by an older version with a field
   missing. A single undefined name used to take down the whole screen. */
const byName = (a, b) =>
  String((a && a.name) || "").localeCompare(String((b && b.name) || ""), undefined, { sensitivity: "base" });

const sortedCourses = () => [...courses].sort(byName);
/* The people on this group's roster, resolved from the global golfer list. */
const sortedGolfers = () => allGolfers
  .filter((g) => g && g.id && roster.includes(g.id))
  .sort(byName);
const golferById = (id) => allGolfers.find((g) => g.id === id);

/* The index to show. Never below zero, never from fewer than three rounds —
   a stored value can be stale, so it is checked rather than trusted. */
function shownIndex(golfer) {
  const { index } = model.effectiveIndex(golfer);
  return index;
}

/* Whether an index came from real rounds or a typed-in starting figure, so a
   screen can say so rather than passing off an estimate as a calculation. */
const indexSource = (golfer) => model.effectiveIndex(golfer).source;
const courseById = (id) => courses.find((c) => c.id === id);

/* ================= appearance ================= */

const SIZES = [{ id:"normal", label:"A", scale:1 }, { id:"large", label:"A+", scale:1.18 }, { id:"huge", label:"A++", scale:1.36 }];
function applySize() {
  const id = localStorage.getItem("golf:textsize") || "large";   /* larger by default */
  const size = SIZES.find((s) => s.id === id) || SIZES[1];
  document.documentElement.style.fontSize = 16 * size.scale + "px";
  document.getElementById("sizeBtn").textContent = size.label;
}
document.getElementById("sizeBtn").onclick = () => {
  const current = localStorage.getItem("golf:textsize") || "large";
  const next = SIZES[(SIZES.findIndex((s) => s.id === current) + 1) % SIZES.length];
  localStorage.setItem("golf:textsize", next.id);
  applySize();
};
applySize();

function applyTheme() {
  const pref = localStorage.getItem("golf:theme") || "auto";
  const hour = new Date().getHours();
  const dark = pref === "dark" || (pref === "auto" && (hour >= 19 || hour < 6));
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0E2A20" : "#1F5641";
  document.getElementById("themeBtn").textContent = pref === "auto" ? (dark ? "Auto · night" : "Auto · day") : pref === "dark" ? "Night" : "Day";
}
document.getElementById("themeBtn").onclick = () => {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(localStorage.getItem("golf:theme") || "auto") + 1) % 3];
  localStorage.setItem("golf:theme", next);
  applyTheme();
};
applyTheme();
setInterval(applyTheme, 5 * 60 * 1000);

/* ================= shared bits ================= */

const empty = (title, hint) => `<div class="empty"><h2>${title}</h2><p>${hint}</p></div>`;
const flashBar = () => (flash ? `<div class="note">${esc(flash)}</div>` : "");

function flashMsg(msg) { flash = msg; render(); setTimeout(() => { flash = null; render(); }, 3200); }

/* ================= joining ================= */

/* Shown until this device belongs to a group. Everything else is unreachable
   until then, which is what makes the rest of the app simpler. */
/* The first screen.
 *
 * Starting a group requires signing in with an email and a password. That is
 * not bureaucracy — it is the fix for the bug that made version 2 unusable.
 * On iOS, Safari and an app opened from the home screen keep separate storage,
 * so an anonymous account differs between them: the same person appeared as
 * two people, each quietly getting their own group. A real account is the same
 * account in both.
 *
 * Joining by invitation still needs nothing at all. A guest taps a link and
 * types a name.
 */
function screenJoin() {
  const invite = db.readJoinLink();

  if (invite) {
    /* A named invitation greets them by name and needs one tap. The name is
       read from the database, not from the link — a URL can be edited. */
    if (invite.golferId && invitedGolfer) {
      return `<div class="stack">
        ${flashBar()}
        <div class="card padded">
          <h2 class="panel-title">${esc(invitedGroupName || "You have been invited")}</h2>
          <p class="hint">You have been invited to keep your handicap with this group.</p>

          <div class="invited-as">
            <span class="sub">Joining as</span>
            <span class="name big">${esc(invitedGolfer.name)}</span>
            ${invitedGolfer.handicapIndex != null
              ? `<span class="sub">index ${Number(invitedGolfer.handicapIndex).toFixed(1)}</span>`
              : `<span class="sub">no handicap yet</span>`}
          </div>

          <div class="inline-actions stacked">
            <button class="btn" data-act="accept-named" ${joining ? "disabled" : ""}>${joining ? "Joining…" : "Yes, that's me — join"}</button>
          </div>
          <p class="hint">${invite.role === "admin"
            ? "You are joining as an <b>admin</b>, so you will be asked to set a password afterwards."
            : "Nothing to type. Your rounds and handicap come with you."}</p>
          <p class="hint">Not you? <button class="linkbtn" data-act="not-me">This is somebody else's invitation</button></p>
        </div>
        ${versionBlock()}
      </div>`;
    }

    return `<div class="stack">
      ${flashBar()}
      <div class="card padded">
        <h2 class="panel-title">You have been invited</h2>
        <p class="hint">Type the name you play under and you are in. No account, no password.</p>
        <label class="lbl">Your name</label>
        <input class="field" name="join-name" value="${esc(joinForm.name)}" placeholder="e.g. Willy Rosales" autocomplete="name">
        <div class="inline-actions stacked">
          <button class="btn" data-act="accept-invite" ${joining ? "disabled" : ""}>${joining ? "Joining…" : "Join the group"}</button>
        </div>
        <p class="hint">Using more than one device? Tap this same link on each of them.</p>
      </div>
      ${versionBlock()}
    </div>`;
  }

  if (showCodeEntry) {
    return `<div class="stack">
      ${flashBar()}
      <div class="card padded">
        <h2 class="panel-title">Join with a code</h2>
        <p class="hint">Six characters, like ABC234.</p>
        <label class="lbl">Your name</label>
        <input class="field" name="join-name" value="${esc(joinForm.name)}" placeholder="e.g. Willy" autocomplete="name">
        <label class="lbl">Group code</label>
        <input class="field mono" name="join-code" value="${esc(joinForm.code)}" placeholder="ABC234" autocapitalize="characters" autocomplete="off">
        <div class="inline-actions stacked">
          <button class="btn" data-act="join-by-code" ${joining ? "disabled" : ""}>${joining ? "Checking…" : "Join"}</button>
          <button class="btn ghost" data-act="hide-code">Back</button>
        </div>
      </div>
      ${versionBlock()}
    </div>`;
  }

  const signedIn = db.isSignedIn();

  return `<div class="stack">
    ${flashBar()}

    ${signedIn ? `
      <div class="card padded">
        <h2 class="panel-title">Start your group</h2>
        <p class="hint">Signed in as <b>${esc(db.currentEmail())}</b>. This is the same account on every device, so your groups follow you.</p>
        <label class="lbl">Your name</label>
        <input class="field" name="join-name" value="${esc(joinForm.name)}" placeholder="e.g. Willy Rosales" autocomplete="name">
        <label class="lbl">Group name</label>
        <input class="field" name="group-name" value="${esc(joinForm.groupName)}" placeholder="Golfing Buddies">
        <label class="checkline">
          <input type="checkbox" name="owner-plays" ${joinForm.ownerPlays ? "checked" : ""}>
          <span>Add me to the roster as a player</span>
        </label>
        <p class="hint" style="margin-top:0">Untick this if you organise but do not play. Either way you can add or remove anybody later, including yourself.</p>
        <div class="inline-actions stacked">
          <button class="btn" data-act="begin" ${joining ? "disabled" : ""}>${joining ? "One moment…" : "Create the group"}</button>
        </div>
      </div>
      ${migrationCard()}
    ` : `
      <div class="card padded">
        <h2 class="panel-title">Sign in</h2>
        <p class="hint">Needed once, so this is the same account whether you open the app in Safari or from your home screen. Without it, each one becomes a separate person with a separate group — which is exactly what went wrong before.</p>
        ${db.currentEmail() ? `<div class="note tip">This device is already known to Google as <b>${esc(db.currentEmail())}</b>. Use that email and choose a password for it — that keeps your existing data. A different email would start a separate, empty account.</div>` : ""}
        <label class="lbl">Email</label>
        <input class="field" name="email" type="email" value="${esc(authForm.email || db.currentEmail())}" placeholder="you@example.com" autocomplete="username" autocapitalize="none">
        <label class="lbl">Password</label>
        <input class="field" name="password" type="password" placeholder="At least 6 characters" autocomplete="current-password">
        <div class="inline-actions stacked">
          <button class="btn" data-act="sign-in" ${joining ? "disabled" : ""}>${joining ? "Signing in…" : "Sign in"}</button>
        </div>
        <p class="hint">New email? An account is made for you. <b>This is a password for this app only</b> — not your email password. Pick a different one.</p>
        <div class="inline-actions stacked">
          <button class="btn ghost" data-act="reset-password">Forgot the password</button>
        </div>
      </div>
      <p class="hint" style="text-align:center">
        Been sent an invitation? Tap that link instead — guests need no account.
      </p>
      <p class="hint" style="text-align:center">
        Looking for the Google button? It only works in the Safari browser, never in an app opened from the home screen. Email and password works in both.
      </p>
      <p class="hint" style="text-align:center">
        <button class="linkbtn" data-act="enter-code">I was given a code</button>
      </p>
    `}
    ${versionBlock()}
  </div>`;
}

let legacy = null;          /* { v1, preview } once found */
let importing = false;
let editingKey = false;
let showCodeEntry = false;
let joining = false;

function migrationCard() {
  if (!legacy) return "";
  const p = legacy.preview;
  return `<div class="card padded">
    <h2 class="panel-title">Bring your existing rounds across</h2>
    <p class="hint">A version 1 scorecard was found on this account: <b>${p.rounds} round${p.rounds === 1 ? "" : "s"}</b>, ${p.golfers} golfer${p.golfers === 1 ? "" : "s"}, ${p.courses} course${p.courses === 1 ? "" : "s"}${p.earliest ? `, from ${p.earliest} to ${p.latest}` : ""}.</p>
    <p class="hint"><b>Nothing is deleted.</b> The original is left exactly where it is, and version 1 keeps working. This copies everything into a new group with you as owner. Running it twice does not duplicate anything.</p>
    <label class="lbl">Name for the group</label>
    <input class="field" name="import-group" value="${esc(joinForm.groupName)}" placeholder="Saturday Group">
    <label class="lbl">Your name</label>
    <input class="field" name="import-name" value="${esc(joinForm.name)}" placeholder="e.g. Willy">
    <div class="inline-actions stacked">
      <button class="btn" data-act="import-v1" ${importing ? "disabled" : ""}>${importing ? "Importing…" : "Import my rounds"}</button>
    </div>
  </div>`;
}

async function importV1() {
  const groupName = ((view.querySelector('[name="import-group"]') || {}).value || joinForm.groupName).trim();
  const name = ((view.querySelector('[name="import-name"]') || {}).value || joinForm.name).trim();
  if (!groupName) { flashMsg("Give the group a name first"); return; }
  if (!name) { flashMsg("Type the name you play under"); return; }

  importing = true;
  busy("Importing your version 1 rounds");
  render();
  try {
    const result = await db.importLegacyV1({ v1: legacy.v1, assocName: groupName, displayName: name });
    importing = false;
    /* Counted afterwards from Firestore rather than assumed, so a partial
       import is visible instead of silent. */
    const ok = result.check.rounds.ok && result.check.golfers.ok;
    await start(result.assocId);
    flashMsg(ok
      ? `Imported and verified: ${result.check.rounds.found} rounds, ${result.check.golfers.found} golfers. Your version 1 scorecard is untouched.`
      : `Imported ${result.check.rounds.found} of ${result.check.rounds.expected} rounds. Nothing was deleted — your version 1 scorecard still has everything. Tap Import again to finish.`);
  } catch (e) {
    importing = false;
    /* Say what actually went wrong. A silent failure here is what makes people
       think their data has gone, when it is sitting untouched where it was. */
    const code = String((e && (e.code || e.message)) || "");
    const cause = code.includes("permission")
      ? "Firebase refused the write, which means the rules in the console are older than this version. Publish the latest firestore.rules and tap Import again."
      : code || "No detail was given.";
    flashMsg(`The import did not finish. ${cause}`);
    setTimeout(() => { flash = `Nothing was lost — your version 1 scorecard is untouched and version 1 still opens it.`; render(); }, 3400);
    render();
  } finally {
    /* Without this the veil stayed up for ever on both paths — success and
       failure — leaving the app apparently frozen behind it. */
    idleAll();
  }
}

/* ================= enter ================= */

/* One step at a time.
 *
 * The same four things, in the same order, with the same checks — only shown
 * one at a time and much larger. Post still enables on exactly the condition
 * the full form uses, so the two cannot drift apart. */
function enterInSteps({ course, tee, golfer, ags, diff, ch, ready2, pickableGames }) {
  const steps = [
    { key: "who", done: !!golfer, label: "Golfer" },
    { key: "where", done: !!tee, label: "Course and tees" },
    { key: "score", done: +form.gross > 0, label: "Score" },
  ];
  /* Land on the first thing still outstanding, unless they have moved by hand. */
  const firstUndone = steps.findIndex((s) => !s.done);
  const at = Math.min(Math.max(0, stepIndex), steps.length - 1);
  const current = steps[firstUndone === -1 ? at : Math.max(at, 0)] || steps[0];
  const showing = stepIndex === 0 && firstUndone !== -1 ? steps[firstUndone] : current;

  const done = steps.filter((s) => s.done).length;
  const chosen = [
    prettyDate(form.date),
    golfer ? golfer.name : null,
    course ? course.name : null,
    tee ? tee.name : null,
  ].filter(Boolean).join(" · ");

  const body = () => {
    if (showing.key === "who") {
      if (!db.canManage()) {
        return `<div class="step-body">
          <p class="step-ask">Posting for</p>
          <div class="step-value">${esc(golfer ? golfer.name : "Not linked yet")}</div>
          ${golfer ? "" : `<p class="hint">Your account is not tied to a golfer on this roster. Ask whoever runs the group for an invitation link with your name on it.</p>`}
        </div>`;
      }
      return `<div class="step-body">
        <p class="step-ask">Who played?</p>
        <select class="field big" name="golferId">
          <option value="">Choose the golfer…</option>
          ${sortedGolfers().map((g) => `<option value="${g.id}" ${g.id === form.golferId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
        </select>
      </div>`;
    }

    if (showing.key === "where") {
      return `<div class="step-body">
        <p class="step-ask">Where did they play?</p>
        <select class="field big" name="courseId">
          <option value="">Choose the course…</option>
          ${sortedCourses().map((c) => `<option value="${c.id}" ${c.id === form.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select>
        ${course ? `<p class="step-ask" style="margin-top:1.2rem">From which tees?</p>
          <div class="tee-grid">
            ${course.tees.map((t) => `<button class="tee-choice ${t.id === form.teeId ? "picked" : ""}" data-tee="${t.id}">
              <span class="name">${esc(t.name)}</span>
              <span class="sub">${(+t.rating).toFixed(1)} / ${t.slope} · par ${t.par}</span>
            </button>`).join("")}
          </div>` : ""}
      </div>`;
    }

    return `<div class="step-body">
      <p class="step-ask">What did they shoot?</p>
      <input class="field score" name="gross" inputmode="numeric" value="${esc(form.gross)}" placeholder="—">
      <p class="hint">${form.adjusted && form.adjusted !== form.gross
        ? `Adjusted ${esc(form.adjusted)}`
        : "Adjusted score is the same unless you set it."}</p>
      ${ch != null ? `<div class="step-note">Course handicap ${ch}${+form.gross > 0 ? ` · net ${ags - ch}` : ""}</div>` : ""}
      ${diff != null ? `<div class="step-note">Differential ${diff.toFixed(1)}</div>` : ""}
      ${pickableGames.length ? `<label class="lbl" style="margin-top:1rem">Part of a game</label>
        <select class="field" name="gameId">
          <option value="">Not part of a game</option>
          ${pickableGames.map((g) => `<option value="${g.id}" ${g.id === form.gameId ? "selected" : ""}>${esc(g.name || courseName(g.courseId))} — ${esc(model.gameSpanLabel(g))}</option>`).join("")}
        </select>` : ""}
    </div>`;
  };

  return `<div class="stack">
    ${flashBar()}

    <div class="step-head">
      <div class="step-bar"><span style="width:${Math.round((done / steps.length) * 100)}%"></span></div>
      <div class="step-count">Step ${steps.indexOf(showing) + 1} of ${steps.length}</div>
    </div>

    <div class="step-chosen">
      <button class="linkbtn" data-act="open-calendar">${esc(prettyDate(form.date))} ▾</button>
      ${chosen.split(" · ").slice(1).length ? `<span class="sub">${esc(chosen.split(" · ").slice(1).join(" · "))}</span>` : ""}
    </div>

    ${calendarOpen ? `<div class="card padded">${calendarPanel(form.date)}</div>` : ""}

    ${body()}

    <div class="step-nav">
      ${steps.indexOf(showing) > 0 ? `<button class="btn ghost" data-act="step-back">Back</button>` : `<span></span>`}
      ${steps.indexOf(showing) < steps.length - 1
        ? `<button class="btn" data-act="step-next" ${showing.done ? "" : "disabled"}>Next</button>`
        : `<button class="btn" data-act="post" ${ready2 ? "" : "disabled"}>${editingRound ? "Save changes" : "Post round"}</button>`}
    </div>

    <p class="hint" id="post-hint">${ready2 || steps.indexOf(showing) < steps.length - 1 ? "" : [
      form.golferId ? "" : "choose the golfer",
      course ? (tee ? "" : "choose the tees") : "choose the course",
      +form.gross > 0 ? "" : "type the score",
    ].filter(Boolean).join(", ").replace(/^./, (c) => c.toUpperCase()) + " to enable Post."}</p>

    <div class="style-switch"><button class="linkbtn" data-act="enter-full">Show every field at once instead</button></div>
    ${versionBlock()}
  </div>`;
}

function screenEnter() {
  /* A guest posts only for themselves, so their golfer is fixed — but nothing
     ever set it, so form.golferId stayed empty, the field fell back to the word
     "You", and Post could never enable. A guest simply could not use the app.
     Seeding it here covers every route in, including a fresh join. */
  if (!db.canManage() && !form.golferId) {
    const mine = typeof db.myGolferId === "function" ? db.myGolferId(allGolfers) : "";
    if (mine) form.golferId = mine;
  }

  if (!golfers.length || !courses.length) {
    /* An empty group with a version 1 scorecard waiting is the commonest state
       to be stuck in, so the way out is offered here rather than three taps
       away in Admin. */
    if (legacy && db.canManage()) {
      const p = legacy.preview;
      return `${flashBar()}
        <div class="card padded">
          <h2 class="panel-title">Bring in your existing data</h2>
          <p class="hint">You have <b>${p.golfers} golfer${p.golfers === 1 ? "" : "s"}</b> and <b>${p.courses} course${p.courses === 1 ? "" : "s"}</b> from version 1. Copy them into this group — nothing is deleted, and running it twice changes nothing.</p>
          <div class="inline-actions stacked">
            <button class="btn" data-act="import-here" ${importing ? "disabled" : ""}>${importing ? "Importing…" : "Bring them in"}</button>
            <button class="btn ghost" data-go="manage">I'll add them by hand instead</button>
          </div>
        </div>
        ${versionBlock()}`;
    }

    return `${flashBar()}` + empty("Almost ready", db.canManage()
      ? "Add a golfer and a course under Manage, then you can post rounds."
      : "Whoever runs your group still needs to add the roster and a course.")
      + (db.canManage() ? `<button class="btn" data-go="manage">Go to Manage</button>` : "");
  }

  const course = courseById(form.courseId);
  const tee = course && course.tees.find((t) => t.id === form.teeId);
  const golfer = golferById(form.golferId);
  const ags = +(form.adjusted || form.gross);
  const diff = tee && form.gross ? model.differential(ags, tee.rating, tee.slope) : null;
  /* The course handicap frozen onto a round must come from the same guarded
     value the screens show, or a stale index would be baked in permanently. */
  const golferIndex = shownIndex(golfer);
  const ch = golferIndex != null && tee
    ? model.courseHandicap(golferIndex, tee.slope, tee.rating, tee.par) : null;
  const ready2 = golfer && tee && +form.gross > 0;
  /* Every game is offered, newest first, with its date shown. Matching only on
     an exact date meant the choice vanished whenever the dates did not line up,
     and rounds silently ended up in no game — or the wrong one. */
  const pickableGames = [...games].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  /* Both layouts are built from the SAME values computed above — course, tee,
     golfer, ready2. Nothing about what is required or what is saved differs. */
  if (currentEnterStyle() === "steps" && !editingRound) {
    return enterInSteps({ course, tee, golfer, ags, diff, ch, ready2, pickableGames });
  }

  return `<div class="stack">
    ${flashBar()}
    ${editingRound ? `<div class="note warn">Editing a posted round <button class="linkbtn" data-act="cancel-round-edit">Cancel</button></div>` : ""}
    ${db.canManage() ? "" : `<div class="style-switch"><button class="linkbtn" data-act="enter-steps">Switch to one step at a time</button></div>`}

    <div class="row">
      <div>
        <div class="eyebrow">Date</div>
        ${dateField(form.date)}
      </div>
      <div>
        <div class="eyebrow">Golfer</div>
        ${db.canManage() ? `<select class="field" name="golferId"><option value="">Select…</option>
          ${sortedGolfers().map((g) => `<option value="${g.id}" ${g.id === form.golferId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
        </select>` : (() => {
          /* Their real name, never the word "You" — and if we genuinely cannot
             work out who they are, say so plainly instead of leaving a dead
             Post button with no explanation. */
          const me = golferById(form.golferId);
          return me
            ? `<div class="field locked">${esc(me.name)}</div>`
            : `<div class="field locked warn">Not linked yet</div>
               <p class="hint">Your account is not tied to a golfer on this roster, so a round cannot be posted. Ask whoever runs the group to send you an invitation link with your name on it.</p>`;
        })()}
      </div>
    </div>

    <div>
      <div class="eyebrow">Course</div>
      <select class="field" name="courseId"><option value="">Select…</option>
        ${sortedCourses().map((c) => `<option value="${c.id}" ${c.id === form.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>
    </div>

    ${course ? `<div>
      <div class="eyebrow">Tees</div>
      <div class="tees">
        ${course.tees.map((t) => `<button class="tee ${t.id === form.teeId ? "on" : ""}" data-tee="${t.id}">
          <b>${esc(t.name)}</b><span class="sub">${(+t.rating).toFixed(1)} / ${t.slope} · par ${t.par}</span></button>`).join("")}
      </div>
    </div>` : ""}

    ${pickableGames.length ? `<div>
      <div class="eyebrow">Part of a game</div>
      <select class="field" name="gameId"><option value="">Not part of a game</option>
        ${pickableGames.map((g) => `<option value="${g.id}" ${g.id === form.gameId ? "selected" : ""}>${esc(g.name || courseName(g.courseId))} · ${g.date}${g.endDate && g.endDate !== g.date ? ` to ${g.endDate}` : ""}</option>`).join("")}
      </select>
      <p class="hint">A round joins a game only when you choose one here.</p>
    </div>` : ""}

    <div class="row">
      <div><div class="eyebrow">Gross score</div>
        <input class="field score" name="gross" inputmode="numeric" value="${form.gross}" placeholder="—"></div>
      <div><div class="eyebrow">Adjusted</div>
        <input class="field score" name="adjusted" inputmode="numeric" value="${form.adjusted}" placeholder="${form.gross || "same"}"></div>
    </div>
    <p class="hint">Adjusted gross caps each hole at net double bogey. Leave it blank if it matches your gross.</p>

    <div><div class="eyebrow">Notes</div>
      <input class="field" name="notes" value="${esc(form.notes)}" placeholder="Wind, partners, anything worth recalling"></div>

    ${diff != null || ch != null ? `<div class="preview">
      <div>
        <div class="eyebrow" style="margin:0">This round</div>
        <div class="small">${ch != null ? `Playing off <b class="mono">${ch}</b> on these tees` : "Post 3 rounds to establish an index"}</div>
      </div>
      ${diff != null ? `<span class="stamp">${diff.toFixed(1)}</span>` : ""}
    </div>` : ""}

    <p class="hint" id="post-hint">${ready2 ? "" : [
      golfer ? "" : "choose the golfer",
      course ? (tee ? "" : "choose the tees") : "choose the course",
      +form.gross > 0 ? "" : "type the score",
    ].filter(Boolean).join(", ").replace(/^./, (c) => c.toUpperCase()) + " to enable Post."}</p>
    <button class="btn" data-act="post" ${ready2 ? "" : "disabled"}>${editingRound ? "Save changes" : "Post round"}</button>
    ${db.canManage() && !editingRound ? `<div class="style-switch"><button class="linkbtn" data-act="enter-steps">Switch to one step at a time</button></div>` : ""}
  </div>`;
}

const courseName = (id) => { const c = courseById(id); return c ? c.name : "Unknown course"; };

/* ================= history ================= */

/* A handicap trend, drawn as plain SVG from rounds already in memory.
 *
 * No chart library: one would add a download, a build step and another thing to
 * break, for a line and some dots. Every value here is one the app already
 * calculates. */
function trendChart(list) {
  /* Wrapped whole. A chart is decoration — it must never be able to stop
     somebody reading their rounds, which is exactly what it did. */
  try {
    return buildTrendChart(list);
  } catch {
    return "";
  }
}

function buildTrendChart(list) {
  const rounds = (list || [])
    .filter((r) => r && typeof r.date === "string" && Number.isFinite(+r.differential))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-20);
  if (rounds.length < 3) return "";

  /* Replay the index round by round, and work out which rounds were actually
     counting at each point — the best 8 of the last 20 under the World
     Handicap System. A round that counted is worth seeing: it is the one that
     moved your handicap, and the rest are just weather. */
  const points = [];
  let window = [];
  for (const r of rounds) {
    window = model.insertIntoWindow(window, {
      roundId: r.id, date: r.date, differential: +r.differential, assocId: r.assocId,
    });
    points.push({
      id: r.id,
      date: r.date,
      differential: +r.differential,
      index: model.displayIndex(window),
      gross: r.gross,
      course: r.courseName || "",
    });
  }

  /* Which of the rounds on screen are counting RIGHT NOW. */
  const counting = new Set();
  const latest = window;
  if (latest.length >= 3) {
    const howMany = Math.min(8, Math.max(1, model.countingRounds(latest.length)));
    [...latest]
      .sort((a, b) => a.differential - b.differential)
      .slice(0, howMany)
      .forEach((e) => counting.add(e.roundId));
  }

  const shown = points.filter((p) => p.index != null);
  if (shown.length < 2) return "";

  const now = shown[shown.length - 1].index;
  const low = Math.min(...shown.map((p) => p.index));
  const first = shown[0].index;
  const move = now - first;

  /* ---- geometry ---- */
  const W = 680, H = 300;
  const padL = 52, padR = 16, padT = 22, padB = 46;
  const values = points.map((p) => p.differential).concat(shown.map((p) => p.index));
  let lo = Math.floor(Math.min(...values) - 1);
  let hi = Math.ceil(Math.max(...values) + 1);
  if (hi - lo < 6) hi = lo + 6;

  const x = (i, n) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  /* ---- gridlines, four of them, on round numbers ---- */
  const step = Math.max(1, Math.round((hi - lo) / 4));
  const ticks = [];
  for (let v = lo; v <= hi; v += step) {
    ticks.push(`<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" class="grid"/>
      <text x="${padL - 10}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${v}</text>`);
  }

  /* ---- the index line, plus a soft band beneath it ---- */
  const line = shown.map((p, i) => `${i ? "L" : "M"}${x(i, shown.length).toFixed(1)},${y(p.index).toFixed(1)}`).join(" ");
  const area = `${line} L${x(shown.length - 1, shown.length).toFixed(1)},${y(lo).toFixed(1)} L${x(0, shown.length).toFixed(1)},${y(lo).toFixed(1)} Z`;

  /* ---- the low index, marked as a reference the way a handicap card does ---- */
  const lowLine = `<line x1="${padL}" y1="${y(low).toFixed(1)}" x2="${W - padR}" y2="${y(low).toFixed(1)}" class="lowmark"/>
    <text x="${W - padR}" y="${(y(low) - 6).toFixed(1)}" class="axis low" text-anchor="end">low ${low.toFixed(1)}</text>`;

  /* ---- each round, counting ones filled, the rest hollow ---- */
  /* Each dot is tappable, not merely hoverable.
   *
   * The first version used an SVG <title>, which only ever appears on hover —
   * and an iPad has no hover, so the detail was unreachable on the device this
   * app is actually used on. A generous invisible target sits over each dot so
   * a fingertip does not have to be precise. */
  const dots = points.map((p, i) => {
    const counts = counting.has(p.id);
    const cx = x(i, points.length).toFixed(1);
    const cy = y(p.differential).toFixed(1);
    const detail = `${p.date} · ${p.gross != null ? `${p.gross} gross · ` : ""}differential ${p.differential.toFixed(1)}${p.index != null ? ` · index after this round ${p.index.toFixed(1)}` : ""}${counts ? " · counting" : " · not counting today"}${p.course ? ` · ${p.course}` : ""}`;
    return `<circle cx="${cx}" cy="${cy}" r="${counts ? 5 : 4}" class="${counts ? "dot counting" : "dot spare"}"/>
      <circle cx="${cx}" cy="${cy}" r="16" class="dot-target" data-round-detail="${esc(detail)}"><title>${esc(detail)}</title></circle>`;
  }).join("");

  /* ---- dates at each end, and one in the middle if there is room ---- */
  const middle = Math.floor(points.length / 2);
  const dateLabels = `
    <text x="${padL}" y="${H - 14}" class="axis">${points[0].date}</text>
    ${points.length > 6 ? `<text x="${x(middle, points.length).toFixed(1)}" y="${H - 14}" class="axis" text-anchor="middle">${points[middle].date}</text>` : ""}
    <text x="${W - padR}" y="${H - 14}" class="axis" text-anchor="end">${points[points.length - 1].date}</text>`;

  const direction = move === 0 ? "no change" : move < 0 ? `down ${Math.abs(move).toFixed(1)}` : `up ${move.toFixed(1)}`;

  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Handicap trend</h2>
      <span class="panel-count">${esc(direction)}</span></div>

    <div class="card padded">
      <div class="trend-stats">
        <div><span class="stat-big">${now.toFixed(1)}</span><span class="stat-label">index now</span></div>
        <div><span class="stat-big">${low.toFixed(1)}</span><span class="stat-label">lowest</span></div>
        <div><span class="stat-big">${points.length}</span><span class="stat-label">rounds shown</span></div>
        <div><span class="stat-big ${move <= 0 ? "good" : "bad"}">${move === 0 ? "—" : `${move > 0 ? "+" : ""}${move.toFixed(1)}`}</span><span class="stat-label">since ${points[0].date.slice(0, 7)}</span></div>
      </div>

      <svg viewBox="0 0 ${W} ${H}" class="trend" role="img"
           aria-label="Handicap index over the last ${points.length} rounds, from ${first.toFixed(1)} to ${now.toFixed(1)}, lowest ${low.toFixed(1)}">
        ${ticks.join("")}
        <path d="${area}" class="trendarea"/>
        ${lowLine}
        <path d="${line}" class="trendline"/>
        ${dots}
        ${dateLabels}
      </svg>

      <div class="readout" id="round-readout">Tap any dot to see that round.</div>

      <div class="legend">
        <span><i class="key counting"></i>counting round</span>
        <span><i class="key spare"></i>not counting</span>
        <span><i class="key line"></i>handicap index</span>
      </div>
      <p class="hint">The line is the index after each round. Filled dots are the rounds currently counting — the best 8 of the last 20. Hollow ones still sit in the window but do not affect the number today.</p>
    </div>
  </section>`;
}

function screenHistory() {
  /* A guest sees their own rounds. Nothing is hidden that concerns them, and
     nothing is shown that does not. */
  /* Called defensively. A screen must not die because one helper is missing —
     that is exactly what happened here, and the guard costs nothing. */
  const mine = typeof db.myGolferId === "function" ? db.myGolferId(golfers) : "";

  /* Every round is checked before it is read from.
   *
   * A restored or imported round can be missing a field the screen assumed was
   * always there — a date, most often — and one undefined value used to throw
   * and take the whole screen down. Rounds without a date are still counted and
   * listed; they simply sort last. Nothing is hidden. */
  const usable = (db.canManage() ? rounds : rounds.filter((r) => r && r.golferId === mine))
    .filter((r) => r && typeof r === "object");
  const dateOf = (r) => (typeof r.date === "string" ? r.date : "");
  const scope = usable;

  const years = [...new Set(scope.map((r) => dateOf(r).slice(0, 4)).filter(Boolean))].sort().reverse();
  const rows = scope.filter((r) =>
    (!filter.golferId || r.golferId === filter.golferId) &&
    (!filter.year || dateOf(r).slice(0, 4) === filter.year) &&
    (!filter.month || dateOf(r).slice(5, 7) === filter.month) &&
    (!filter.courseId || r.courseId === filter.courseId)
  ).sort((a, b) => dateOf(b).localeCompare(dateOf(a)));

  const chips = Object.entries(filter).filter(([, v]) => v).map(([k, v]) =>
    `<button class="pill" data-unfilter="${k}">${k === "month" ? MONTHS[+v - 1] : k === "courseId" ? esc(courseName(v)) : esc((golferById(v) || {}).name || v)} ✕</button>`).join("");

  return `${flashBar()}
  <div class="filters${db.canManage() ? "" : " two"}">
    ${db.canManage() ? `<select class="field" name="f-golfer"><option value="">All golfers</option>
      ${sortedGolfers().map((g) => `<option value="${g.id}" ${g.id === filter.golferId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>` : ""}
    <select class="field" name="f-year"><option value="">All years</option>
      ${years.map((y) => `<option ${y === filter.year ? "selected" : ""}>${y}</option>`).join("")}</select>
    <select class="field" name="f-course"><option value="">All courses</option>
      ${sortedCourses().map((c) => `<option value="${c.id}" ${c.id === filter.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
  </div>
  ${chips ? `<div class="pills">${chips}<button class="linkbtn" data-act="clear-filters">Clear</button></div>` : ""}
  ${filter.golferId ? trendChart(rounds.filter((r) => r.golferId === filter.golferId)) : ""}
  ${rows.length === 0 ? empty("No rounds here yet", "Post one from the Enter tab, or widen the filters above.") : `
  <div class="eyebrow" style="display:flex;justify-content:space-between"><span>${rows.length} round${rows.length === 1 ? "" : "s"}</span><span>Differential</span></div>
  <div class="card list">${rows.map((r) => {
    const editable = db.canEditRound(r);
    return `<div style="padding:0.85rem 0.9rem">
      <div style="display:flex;gap:12px;justify-content:space-between">
        <div class="grow" style="min-width:0">
          <div><span class="sub">${esc(dateOf(r) || "no date")}</span> <span class="name">${esc((golferById(r.golferId) || {}).name || "Unknown")}</span></div>
          <div class="small truncate">${esc(r.courseName || "Unknown course")}${r.teeName ? ` · ${esc(r.teeName)}` : ""}</div>
          <div class="sub">${r.gross == null ? "—" : r.gross}${r.adjusted != null && r.adjusted !== r.gross ? ` (adj ${r.adjusted})` : ""}${r.courseHandicap != null ? ` · net ${model.netScore(r)}` : ""}${Number.isFinite(+r.rating) && r.slope ? ` · ${(+r.rating).toFixed(1)}/${r.slope}` : ""}</div>
          ${r.gameId ? `<div class="sub">in game: ${esc((games.find((g) => g.id === r.gameId) || {}).name || courseName((games.find((g) => g.id === r.gameId) || {}).courseId))}</div>` : ""}
          ${r.notes ? `<div class="small muted" style="font-style:italic">${esc(r.notes)}</div>` : ""}
        </div>
        <div style="text-align:right">
          <span class="stamp sm">${Number.isFinite(+r.differential) ? (+r.differential).toFixed(1) : "—"}</span>
          ${editable ? `<div class="inline-actions" style="margin-top:0.5rem">
            <button class="rowbtn" data-edit="${r.id}">Edit</button>
            <button class="rowbtn warn" data-del="${r.id}">Delete</button>
          </div>` : `<div class="sub" style="margin-top:0.5rem">locked</div>`}
        </div>
      </div>
      ${confirmId === r.id ? `<div class="note warn" style="display:flex;justify-content:space-between;margin-top:8px">Delete this round?
        <span><button class="linkbtn" data-confirm-del="${r.id}">Delete</button> &nbsp; <button class="linkbtn" data-act="cancel-del">Keep</button></span></div>` : ""}
    </div>`;
  }).join("")}</div>`}`;
}

/* ================= summary ================= */

function screenSummary() {
  if (!rounds.length) {
    return `${flashBar()}
    <section class="panel">
      <div class="welcome">
        <div class="welcome-mark">⛳</div>
        <h2>No rounds yet</h2>
        <p>Handicap indexes appear here after three rounds. Rankings and trends follow as the season builds up.</p>
        <div class="inline-actions stacked">
          <button class="btn" data-go="enter">Post your first round</button>
        </div>
      </div>
    </section>
    ${versionBlock()}`;
  }

  const dated = rounds.filter((r) => r && typeof r.date === "string");
  const scoped = dated.filter((r) => (!drill.year || r.date.slice(0, 4) === drill.year) && (!drill.month || r.date.slice(5, 7) === drill.month));
  const level = drill.month ? "golfer" : drill.year ? "month" : "year";
  let items;
  if (level === "year") items = [...new Set(dated.map((r) => r.date.slice(0, 4)))].sort().reverse()
    .map((y) => ({ key: y, label: y, list: dated.filter((r) => r.date.slice(0, 4) === y) }));
  else if (level === "month") items = [...new Set(scoped.map((r) => r.date.slice(5, 7)))].sort().reverse()
    .map((m) => ({ key: m, label: MONTHS[+m - 1], list: scoped.filter((r) => r.date.slice(5, 7) === m) }));
  else items = [...new Set(scoped.map((r) => r.golferId))]
    .map((id) => ({ key: id, label: (golferById(id) || {}).name || "Unknown", list: scoped.filter((r) => r.golferId === id) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const stat = (l) => `${l.length} round${l.length === 1 ? "" : "s"} · avg ${(l.reduce((a, r) => a + r.gross, 0) / l.length).toFixed(1)} · best diff ${Math.min(...l.map((r) => +r.differential)).toFixed(1)}`;

  return `${flashBar()}
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Handicap Index</h2>
      <button class="linkbtn" data-act="share-indexes">Share</button></div>

    ${(() => {
      /* Your own number, first and large — it is what most people open the app
         to see. NAMED, not just "yours": a screenshot still makes sense once it
         has been shared, and an admin can see whose device they are looking at. */
      const me = golferById(db.myGolferId(allGolfers));
      const mine = me ? shownIndex(me) : null;
      if (!me || mine == null) return "";
      const played = rounds.filter((r) => r.golferId === me.id).length;
      return `<button class="my-index" data-golfer-index="${me.id}">
        <span class="label">Your handicap index</span>
        <span class="who">${esc(me.name)}</span>
        <span class="figure">${mine.toFixed(1)}</span>
        <span class="from">from ${played} round${played === 1 ? "" : "s"}</span>
      </button>
      <div class="eyebrow" style="margin:1rem 0 0.4rem">Everyone else</div>`;
    })()}

    <div class="indexes">${sortedGolfers()
      .filter((g) => rounds.some((r) => r.golferId === g.id))
      .filter((g) => g.id !== db.myGolferId(allGolfers) || shownIndex(g) == null)
      .map((g) => {
      const n = rounds.filter((r) => r.golferId === g.id).length;
      return `<button class="idx" data-golfer-index="${g.id}">
        <div class="name truncate">${esc(g.name)}</div>
        <div class="big ${shownIndex(g) == null ? "none" : ""}">${shownIndex(g) == null ? "—" : shownIndex(g).toFixed(1)}</div>
        <div class="small muted">${shownIndex(g) == null ? `${Math.max(0, 3 - n)} more round${3 - n === 1 ? "" : "s"} needed` : `from ${n} round${n === 1 ? "" : "s"}`}</div>
      </button>`;
    }).join("")}</div>
  </section>

  ${rankingSection()}

  <section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">${drill.year || drill.month ? `<button class="linkbtn" data-act="drill-back">‹</button> ` : ""}By ${level === "year" ? "year" : level === "month" ? `month · ${drill.year}` : `golfer · ${MONTHS[+drill.month - 1]} ${drill.year}`}</h2>
      ${drill.year ? `<button class="linkbtn" data-act="view-scope">View rounds</button>` : ""}
    </div>
    <div class="card list">${items.map((it) => `
      <button class="list-row" data-drill="${esc(it.key)}">
        <span class="grow"><span class="name">${esc(it.label)}</span><br><span class="sub">${stat(it.list)}</span></span>
        <span class="chev">›</span>
      </button>`).join("")}</div>
  </section>
  ${versionBlock()}`;
}

/* ================= rankings ================= */

function rankingSection() {
  const period = { year: rankPeriod.year, month: rankPeriod.month };
  const scoped = rounds.filter((r) => model.inPeriod(r, period));
  const table = model.periodRanking(scoped, golfers, { minRounds: 3 });
  /* Undated rounds are skipped for ranking purposes only — a ranking needs a
     period to sit in. They still count everywhere else, and still appear in
     History. */
  const datedRounds = rounds.filter((r) => r && typeof r.date === "string");
  const years = [...new Set(datedRounds.map((r) => r.date.slice(0, 4)))].sort().reverse();
  const label = period.month ? `${MONTHS[+period.month - 1]} ${period.year}` : period.year;

  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Rankings</h2>
      <button class="linkbtn" data-act="share-ranking">Share</button></div>
    <div class="row" style="margin-bottom:0.7rem">
      <select class="field" name="rank-year">${years.map((y) => `<option ${y === period.year ? "selected" : ""}>${y}</option>`).join("")}</select>
      <select class="field" name="rank-month"><option value="">Whole year</option>
        ${MONTHS.map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}" ${String(i + 1).padStart(2, "0") === period.month ? "selected" : ""}>${m}</option>`).join("")}</select>
    </div>
    ${table.length === 0 ? `<div class="card"><p class="blank">No rounds in ${esc(label)}.</p></div>` : `
    <div class="card list">
      ${table.map((row) => `<div class="list-row">
        <span class="rank">${row.place || "—"}</span>
        <span class="grow">
          <span class="name">${esc(row.name)}</span><br>
          <span class="sub">${row.played} round${row.played === 1 ? "" : "s"} · gross avg ${row.avgGross}${row.bestNet != null ? ` · best net ${row.bestNet}` : ""}</span>
          ${row.ranked ? "" : `<br><span class="sub">needs 3 rounds to be ranked</span>`}
        </span>
        <span class="netavg">${row.avgNet == null ? "—" : row.avgNet}<br><span class="sub">net avg</span></span>
      </div>`).join("")}
    </div>
    <p class="hint">Ranked on average net score — gross minus the course handicap that applied when each round was entered. Gross averages are shown alongside so both pictures are visible.</p>`}
  </section>`;
}

/* ================= games ================= */

function screenGames() {
  if (openGame) return gameDetail(openGame);

  return `${flashBar()}
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Games</h2>
      ${db.canManage() && !gameDraft ? `<button class="linkbtn" data-act="new-game">Add a game</button>` : ""}</div>
    ${gameDraft ? gameEditor() : ""}
    ${games.length === 0 && !gameDraft ? `<div class="card"><p class="blank">${db.canManage()
      ? "No games yet. A game groups everyone's rounds from one outing, so you get a leaderboard for the day."
      : "No games yet. Whoever organises your group sets these up."}</p></div>` : ""}
    ${games.length ? `<div class="card list">
      ${games.map((g) => {
        const played = rounds.filter((r) => r.gameId === g.id);
        return `<button class="list-row" data-game="${g.id}">
          <span class="grow">
            <span class="name">${esc(g.name || courseName(g.courseId))}</span><br>
            <span class="sub">${esc(model.gameSpanLabel(g))} · ${played.length} player${played.length === 1 ? "" : "s"}${g.endDate && g.endDate !== g.date ? ` · ${model.gameDays(g)} days` : ""}</span>
          </span>
          <span class="chev">›</span>
        </button>`;
      }).join("")}
    </div>` : ""}
  </section>
  ${versionBlock()}`;
}

function gameEditor() {
  const d = gameDraft;
  return `<div class="card editor">
    <div class="editor-title">New game</div>
    <label class="lbl">Date</label>
    <input class="field" type="date" name="g-date" value="${d.date}">
    ${d.multiDay ? `
      <label class="lbl">Last day</label>
      <input class="field" type="date" name="g-end-date" value="${d.endDate || ""}">
      <p class="hint">Rounds played on any day in this range can join the game.</p>
    ` : `<button class="linkbtn" data-act="make-multiday" style="margin-top:0.4rem">Runs over more than one day</button>`}
    <label class="lbl">Course</label>
    <select class="field" name="g-course"><option value="">Select…</option>
      ${sortedCourses().map((c) => `<option value="${c.id}" ${c.id === d.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    <label class="lbl">Name (optional)</label>
    <input class="field" name="g-name" value="${esc(d.name)}" placeholder="Saturday medal">
    <p class="hint" id="game-hint">${d.courseId ? "" : "Pick the course to enable Save."}</p>
    <div class="inline-actions stacked">
      <button class="btn" data-act="save-game" ${d.courseId ? "" : "disabled"}>Save game</button>
      <button class="btn ghost" data-act="cancel-game">Cancel</button>
    </div>
  </div>`;
}

function gameDetail(gameId) {
  const game = games.find((g) => g.id === gameId);
  if (!game) { openGame = null; return screenGames(); }

  const played = rounds.filter((r) => r.gameId === gameId);
  const multiDay = !!(game.endDate && game.endDate !== game.date);
  const standings = multiDay ? model.gameStandings(played, allGolfers, game) : { days: [], players: [] };
  /* allGolfers, not the roster. Somebody who played in this game but has since
     been taken off the roster must still appear in its result — a past
     leaderboard should not change because the roster did. */
  const board = model.gameLeaderboard(played, allGolfers);

  /* Rounds played on a day this game covers but not yet part of it.
     This is what saves entering a tournament twice: post rounds as normal on
     the Enter tab, then sweep them into the game here in one tap. */
  const candidates = rounds
    .filter((r) => r && !r.gameId && model.gameCovers(game, r.date))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return `${flashBar()}
  <div class="panel-head">
    <button class="linkbtn" data-act="close-game">‹ All games</button>
    ${played.length ? `<button class="linkbtn" data-act="share-game">Share</button>` : ""}
  </div>

  <section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">${esc(game.name || courseName(game.courseId))}</h2>
      ${db.canManage() ? `<button class="linkbtn" data-act="edit-game">${editingGame ? "Cancel" : "Edit"}</button>` : ""}
    </div>
    <div class="sub">${esc(model.gameSpanLabel(game))} · ${esc(courseName(game.courseId))}</div>

    ${editingGame ? `<div class="card editor">
      <label class="lbl">Name</label>
      <input class="field" name="edit-game-name" value="${esc(game.name || "")}" placeholder="e.g. Pagong Cup">
      <label class="lbl">First day</label>
      <input class="field" type="date" name="edit-game-date" value="${esc(game.date || "")}">
      <label class="lbl">Last day</label>
      <input class="field" type="date" name="edit-game-end" value="${esc(game.endDate || "")}">
      <p class="hint">Leave the last day empty for a one-day game. Widening the range lets more rounds be added; it never removes any already in the game.</p>
      <label class="lbl">Course</label>
      <select class="field" name="edit-game-course">
        ${sortedCourses().map((c) => `<option value="${c.id}" ${c.id === game.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>
      <div class="inline-actions stacked">
        <button class="btn" data-act="save-game-edit">Save the changes</button>
      </div>
    </div>` : ""}
  </section>

  ${db.canManage() && candidates.length ? `<section class="panel">
    <div class="card padded">
      <div class="name">${candidates.length} round${candidates.length === 1 ? "" : "s"} on ${game.endDate ? "these dates" : "this date"} are not in the game</div>
      <p class="hint" style="margin:0.3rem 0 0.6rem">Untick anybody who was not playing in it.</p>
      <div class="list">
        ${candidates.map((r) => `<label class="checkline">
          <input type="checkbox" name="add-round" value="${esc(r.id)}" checked>
          <span>${esc((golferById(r.golferId) || {}).name || "Unknown")} · ${esc(r.date)} · ${r.gross == null ? "—" : r.gross}</span>
        </label>`).join("")}
      </div>
      <div class="inline-actions stacked">
        <button class="btn" data-act="add-to-game">Add the ticked rounds</button>
      </div>
    </div>
  </section>` : ""}

  ${multiDay && standings.players.length ? `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Standing</h2>
      <span class="panel-count">after ${standings.days.length} of ${model.gameDays(game)} day${model.gameDays(game) === 1 ? "" : "s"}</span></div>
    <div class="card">
      <div class="standings-head">
        <span class="grow">Player</span>
        ${standings.days.map((d) => `<span class="day">${esc(d.slice(5))}</span>`).join("")}
        <span class="total">Total</span>
      </div>
      ${standings.players.map((p) => `<div class="standings-row">
        <span class="grow"><span class="name">${p.place}. ${esc(p.name)}</span></span>
        ${standings.days.map((d) => {
          const played = p.byDay[d];
          return `<span class="day">${played
            ? (standings.rankedOnNet && played.net != null ? played.net : played.gross)
            : "—"}</span>`;
        }).join("")}
        <span class="total">${standings.rankedOnNet ? p.totalNet : p.totalGross}</span>
      </div>`).join("")}
    </div>
    <p class="hint">${standings.rankedOnNet
      ? "Net scores, day by day, with the running total. Lowest total leads."
      : "Gross scores — somebody has no handicap yet, so the standing cannot use net."}${standings.days.length < model.gameDays(game) ? " More days still to play." : ""}</p>
  </section>` : ""}

  ${db.canManage() && board.some((r) => r.net == null || r.estimated) ? `<section class="panel">
    <div class="card padded">
      <div class="name">${board.filter((r) => r.net == null).length
        ? `${board.filter((r) => r.net == null).length} player${board.filter((r) => r.net == null).length === 1 ? " has" : "s have"} no net score`
        : "Some net scores are worked out, not frozen"}</div>
      <p class="hint">A round records the handicap that applied when it was posted. Anybody whose index was set afterwards kept nothing, so their net is blank. Recalculating re-freezes every round in this game from each golfer's index today.</p>
      <div class="inline-actions stacked">
        <button class="btn" data-act="recalc-game">Recalculate this game's handicaps</button>
      </div>
      <p class="hint">Only this game. Nothing else is touched.</p>
    </div>
  </section>` : ""}

  ${board.length ? `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">${multiDay ? "Every round" : "Leaderboard"}</h2><span class="panel-count">${board.length}</span></div>
    <div class="card">
      <div class="list">
        ${[...board]
          .sort((a, b) => (a.net != null && b.net != null) ? a.netPlace - b.netPlace : a.grossPlace - b.grossPlace)
          .map((r) => `<div class="list-row">
            <span class="grow"><span class="name">${r.net != null && !multiDay ? `${r.netPlace}. ` : ""}${esc(r.name)}</span><br>
              <span class="sub">${multiDay ? `${esc((played.find((x) => x.id === r.roundId) || {}).date || "")} · ` : ""}gross ${r.gross}${r.net != null ? ` · net ${r.net}` : " · no handicap yet"}</span></span>
            ${db.canManage() ? `<button class="rowbtn warn" data-drop-round="${esc(r.roundId)}">Remove</button>` : ""}
          </div>`).join("")}
      </div>
    </div>
    ${db.canManage() ? `<p class="hint">Remove takes a round out of this game only. The round and the golfer's handicap are untouched.</p>` : ""}
  </section>` : `<div class="card padded">
      <p class="blank">No rounds in this game yet. Post them from Enter and pick this game, or add them above.</p>
    </div>`}

  ${versionBlock()}`;
}

/* ================= sharing ================= */

/* withNet defaults to false when anybody in the game has no index — a result
   listing half the field with a blank net column looks broken, and reads as
   though those golfers did badly rather than simply not having a handicap yet. */
function gameShareText(gameId, withNet, withGross) {
  const game = games.find((g) => g.id === gameId);
  const board = model.gameLeaderboard(rounds.filter((r) => r.gameId === gameId), golfers);
  const everyoneHasNet = board.length > 0 && board.every((r) => r.net != null);
  const includeNet = withNet == null ? everyoneHasNet : withNet;
  /* Gross is on by default and independent of net. It used to disappear
     entirely from a multi-day share, because that path returned before the
     gross section was ever reached. */
  const includeGross = withGross == null ? true : withGross;

  const lines = [
    `${game.name || courseName(game.courseId)} — ${model.gameSpanLabel(game)}`,
    courseName(game.courseId),
  ];

  /* A multi-day event is shared as a standing, not a pile of rounds — the
     day-by-day columns and the running total are the whole point of it. */
  const spans = !!(game.endDate && game.endDate !== game.date);
  if (spans) {
    const standing = model.gameStandings(rounds.filter((r) => r.gameId === gameId), allGolfers, game);
    if (standing.players.length) {
      const total = model.gameDays(game);
      const useNet = includeNet && standing.rankedOnNet;

      if (useNet) {
        lines.push("", `Net standing after ${standing.days.length} of ${total} day${total === 1 ? "" : "s"}:`);
        standing.players.forEach((p) => {
          const perDay = standing.days
            .map((d) => { const r = p.byDay[d]; return r && r.net != null ? r.net : "—"; })
            .join(" + ");
          lines.push(`${p.place}. ${p.name} ${p.totalNet}  (${perDay})`);
        });
      }

      if (includeGross) {
        /* Ranked on gross in its own right, not left in net order. */
        const byGross = [...standing.players].sort((a, b) => a.totalGross - b.totalGross);
        let place = 0, seen = 0, previous = null;
        byGross.forEach((p) => {
          seen++;
          if (p.totalGross !== previous) { place = seen; previous = p.totalGross; }
          p.grossPlace = place;
        });

        lines.push("", `Gross standing after ${standing.days.length} of ${total} day${total === 1 ? "" : "s"}:`);
        byGross.forEach((p) => {
          const perDay = standing.days
            .map((d) => { const r = p.byDay[d]; return r ? r.gross : "—"; })
            .join(" + ");
          lines.push(`${p.grossPlace}. ${p.name} ${p.totalGross}  (${perDay})`);
        });
      }

      if (includeNet && !standing.rankedOnNet) {
        lines.push("", "No net standing — somebody has no handicap yet.");
      }

      lines.push("", "Posted with The Scorecard");
      return lines.join("\n");
    }
  }

  if (includeNet) {
    const withScores = board.filter((r) => r.net != null).sort((a, b) => a.netPlace - b.netPlace);
    lines.push("", "Net:", ...withScores.map((r) => `${r.netPlace}. ${r.name} ${r.net} (gross ${r.gross})`));
    const missing = board.filter((r) => r.net == null);
    if (missing.length) {
      lines.push("", `No handicap yet: ${missing.map((r) => r.name).join(", ")}`);
    }
  }

  if (includeGross) {
    const grossOrder = [...board].sort((a, b) => a.grossPlace - b.grossPlace);
    lines.push("", "Gross:", ...grossOrder.map((r) => `${r.grossPlace}. ${r.name} ${r.gross}`));
  }
  lines.push("", `Posted with The Scorecard`);
  return lines.join("\n");
}

/* Every golfer's current index, for sending to the group. */
function indexShareText() {
  const lines = [`${association ? association.name : "Group"} — handicap indexes`, new Date().toISOString().slice(0, 10), ""];
  const listed = sortedGolfers();

  const established = listed.filter((g) => shownIndex(g) != null)
    .sort((a, b) => shownIndex(a) - shownIndex(b));
  const waiting = listed.filter((g) => shownIndex(g) == null);

  established.forEach((g) => {
    const n = rounds.filter((r) => r.golferId === g.id).length;
    lines.push(`${shownIndex(g).toFixed(1)}  ${g.name}  (${n} round${n === 1 ? "" : "s"})`);
  });

  if (waiting.length) {
    lines.push("", "Not established yet — three rounds are needed:");
    waiting.forEach((g) => {
      const n = rounds.filter((r) => r.golferId === g.id).length;
      lines.push(`   ${g.name} (${n} of 3)`);
    });
  }

  lines.push("", "World Handicap System — average of the best 8 differentials from the last 20 rounds.", "Posted with The Scorecard");
  return lines.join("\n");
}

function rankingShareText() {
  const period = rankPeriod;
  const label = period.month ? `${MONTHS[+period.month - 1]} ${period.year}` : period.year;
  const table = model.periodRanking(rounds.filter((r) => model.inPeriod(r, period)), golfers, { minRounds: 3 });
  const lines = [`${association ? association.name : "Group"} — ${label}`, "", "Ranked on average net:"];
  table.filter((r) => r.ranked).forEach((r) => lines.push(`${r.place}. ${r.name} ${r.avgNet} (${r.played} rounds, index ${r.handicapIndex == null ? "—" : r.handicapIndex})`));
  const unranked = table.filter((r) => !r.ranked);
  if (unranked.length) lines.push("", `Not yet ranked: ${unranked.map((r) => `${r.name} (${r.played})`).join(", ")}`);
  lines.push("", "Posted with The Scorecard");
  return lines.join("\n");
}

/* Net and gross are independent choices — a group may want either, both, or
   the gross alone when somebody is still unrated. */
function openGameShare(everyoneHasNet) {
  openShare(gameShareText(openGame, shareGameNet, shareGameGross), "Game result", {
    toggles: [
      {
        key: "net",
        on: shareGameNet,
        label: "Include net scores",
        hint: everyoneHasNet ? "" : "Some players have no handicap yet, so their net score would be blank.",
      },
      { key: "gross", on: shareGameGross, label: "Include gross scores" },
    ],
  });
}

function openShare(text, title, options = {}) {
  const toggle = options.toggle;
  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center"><h2>${esc(title)}</h2>
      <button class="rowbtn" data-close="1">Close</button></div>
    ${(options.toggles || (toggle ? [toggle] : [])).map((t) => `<label class="checkline">
      <input type="checkbox" data-share-toggle="${esc(t.key || "net")}" ${t.on ? "checked" : ""}>
      <span>${esc(t.label)}</span>
    </label>${t.hint ? `<p class="hint" style="margin-top:0">${esc(t.hint)}</p>` : ""}`).join("")}
    <pre class="msg">${esc(text)}</pre>
    <div class="share-grid" style="margin-top:1rem">
      <button class="btn" data-send="whatsapp">WhatsApp</button>
      <button class="btn" data-send="email">Email</button>
      <button class="btn ghost" data-send="sms">Text message</button>
      <button class="btn ghost" data-send="copy">Copy</button>
    </div>
    <div class="inline-actions stacked">
      <button class="btn ghost" data-send="save">Save as a file</button>
      ${navigator.share ? `<button class="btn ghost" data-send="native">More apps…</button>` : ""}
    </div>
  </div>`;
  sheetEl.dataset.text = text;
  sheetEl.dataset.title = title;
  sheetEl.dataset.filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${today()}.txt`;
}

/* ================= manage ================= */

function screenManage() {
  if (!db.canManage()) return empty("Manage is for organisers", "Your group's organiser looks after the roster and courses. You can post rounds on the Enter tab.");

  return `${flashBar()}
  ${safe("Set a password", passwordPrompt)}
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Golfers in this group</h2><span class="panel-count">${golfers.length || ""}</span></div>
    <div class="card">
      ${!golfers.length && db.canManage() ? `<div class="welcome" style="border:0;padding:1.4rem 1rem">
        <p style="margin:0 0 1rem">Nobody is on this roster yet. If your golfers already exist from before, put them back in one tap.</p>
        <div class="inline-actions stacked">
          <a class="btn" href="./rebuild.html" style="text-decoration:none;display:flex;align-items:center;justify-content:center">Rebuild the roster</a>
        </div>
      </div>` : ""}
      ${golfers.length ? `<div class="list">
        ${sortedGolfers().map((g) => {
          /* The starting-index editor, shown in place of the row while open —
             the same shape as the rename editor below it. This branch was
             missing entirely, which is why tapping Index did nothing visible
             even after the button itself was wired up. */
          if (editingIndex === g.id) {
            const current = g.manualIndex == null ? "" : g.manualIndex;
            return `<div class="inline-form">
              <p class="hint" style="margin:0 0 .6rem">
                A starting handicap for <b>${esc(g.name)}</b>, who has not played three rounds with you yet.
                Their own rounds take over as soon as they have three.
              </p>
              <input name="manual-index" class="inline-input" inputmode="decimal"
                     value="${esc(current)}" placeholder="e.g. 14.2" autocomplete="off">
              <div class="inline-actions">
                <button class="btn compact" data-act="save-index">Save</button>
                ${g.manualIndex != null ? `<button class="btn ghost compact" data-act="clear-index">Clear it</button>` : ""}
                <button class="btn ghost compact" data-act="cancel-index">Cancel</button>
              </div>
            </div>`;
          }

          if (editingGolfer === g.id) {
            return `<div class="inline-form">
              <input name="rename-golfer" class="inline-input" value="${esc(g.name)}" autocomplete="off">
              <div class="inline-actions">
                <button class="btn compact" data-act="save-rename">Save</button>
                <button class="btn ghost compact" data-act="cancel-rename">Cancel</button>
              </div></div>`;
          }
          const used = rounds.some((r) => r.golferId === g.id);
          /* The name gets its own line, and the two rare actions — Rename and
             Remove — move behind a menu. Four buttons beside a long name will
             never fit a phone; they overlapped it instead. This also puts
             Remove out of accidental reach. */
          return `<div class="roster-row">
            <div class="roster-name">
              <span class="name">${esc(g.name)}</span>
              <span class="sub">${g.handicapIndex == null ? "no index yet" : `index ${(+g.handicapIndex).toFixed(1)}`} · ${g.roundCount || 0} round${g.roundCount === 1 ? "" : "s"}</span>
            </div>
            <div class="roster-actions">
            ${g.linkedUid
              ? (db.isOwner()
                  ? `<button class="rowbtn wide" data-reinvite="${g.id}" title="Let them join again">Invited ✓</button>`
                  : `<button class="rowbtn wide" disabled>Invited ✓</button>`)
              : `<button class="rowbtn wide primary" data-invite-golfer="${g.id}">Invite</button>`}
            ${indexSource(g) === "rounds"
              ? `<button class="rowbtn" disabled title="Their index now comes from their own rounds">Index</button>`
              : `<button class="rowbtn" data-set-index="${g.id}">Index</button>`}
              <button class="rowbtn more" data-more="${g.id}" aria-label="More for ${esc(g.name)}">···</button>
            </div>
            ${moreOpen === g.id ? `<div class="roster-more">
              <button class="rowbtn" data-rename="${g.id}">Rename</button>
              <button class="rowbtn warn" data-del-golfer="${g.id}">Remove from this group</button>
            </div>` : ""}
          </div>`;
        }).join("")}
      </div>` : `<p class="blank">Nobody on the roster yet.</p>`}
      <div class="inline-form bordered">
        <input name="new-golfer" class="inline-input" placeholder="Type a name" autocomplete="off">
        <div class="inline-actions"><button class="btn compact" data-act="add-golfer">Add golfer</button></div>
        <div class="inline-actions stacked">
          <button class="btn ghost compact" data-act="from-other-groups">Add from my other groups</button>
        </div>
      </div>
    </div>
    <p class="hint">Rename changes that person in every group. Remove takes them off this group's roster only — their rounds and handicap stay.</p>
    <p class="hint"><b>Index</b> sets a starting handicap for somebody who has not played three rounds with you yet. It greys out once their own rounds take over.</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Courses</h2>
      ${courseDraft ? "" : `<button class="linkbtn" data-act="new-course">Add a course</button>`}</div>
    ${courses.length ? `<div class="card list">
      ${sortedCourses().map((c) => {
        const open = openCourse === c.id;
        const used = rounds.some((r) => r.courseId === c.id);
        return `<div>
          <button class="course-head" data-course="${c.id}" aria-expanded="${open}">
            <span class="grow"><span class="name">${esc(c.name)}</span><br>
              <span class="sub">${c.tees.length} tee${c.tees.length === 1 ? "" : "s"}${used ? " · in use" : ""}</span></span>
            <span class="chev">${open ? "▾" : "▸"}</span>
          </button>
          ${open ? `<div class="course-body">
            ${c.tees.map((t) => `<div class="teeline"><span>${esc(t.name)}</span><span>${(+t.rating).toFixed(1)} / ${t.slope} · par ${t.par}</span></div>`).join("")}
          </div>` : ""}
        </div>`;
      }).join("")}
    </div>` : (courseDraft ? "" : `<div class="card"><p class="blank">No courses yet. Search for one by name, or type its rating and slope from the scorecard.</p></div>`)}
    ${courseDraft ? courseEditor() : ""}
  </section>

  ${versionBlock()}`;
}

/* Everything to do with people, permissions and settings, in one place that
   only the owner can reach. Nobody else knows it exists. */
/* Every group this person belongs to, with a way to start another.
   Only shown when it is relevant — one group and there is nothing to switch. */
function groupSwitcher() {
  const groups = db.knownGroups();
  const current = db.currentAssociation();
  return `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>Your groups</h2><button class="rowbtn" data-close="1">Close</button></div>
    <div class="card list" style="margin-top:0.6rem">
      ${groups.map((g) => `<div class="list-row">
        <button class="grow" data-goto-group="${esc(g.id)}" style="background:none;border:0;text-align:left;padding:0;color:inherit">
          <span class="name">${esc(g.name)}</span>${g.id === current ? `<br><span class="sub">you are here</span>` : ""}
        </button>
        <span class="chev">${g.id === current ? "✓" : "›"}</span>
      </div>`).join("")}
    </div>
    ${db.isOwner() || !current ? `<div class="inline-actions stacked">
      <button class="btn ghost" data-act="new-group">Start another group</button>
    </div>` : ""}
    <p class="hint">A golfer's handicap is the same in every group — it is built from all their rounds, wherever they played them.</p>

    ${groups.length > 1 ? `<details class="danger-drawer">
      <summary>Remove a group from this list</summary>
      <p class="hint">This only takes a group off <b>your</b> list. It deletes nothing — no rounds, no golfers, and nobody else is affected. Use it for a group you no longer want to see.</p>
      <div class="list">
        ${groups.filter((g) => g.id !== current).map((g) => `<div class="list-row">
          <span class="grow"><span class="name">${esc(g.name)}</span></span>
          <button class="rowbtn warn" data-forget-group="${esc(g.id)}" data-forget-name="${esc(g.name)}">Remove from my list</button>
        </div>`).join("")}
      </div>
    </details>` : ""}
  </div>`;
}

function screenAdmin() {
  /* An admin without an account still needs the password form, and the rest of
     this tab is the owner's. So the form is shown here on its own rather than
     turning them away with nothing — being told "not your area" while holding
     a real admin role is exactly what looked like a broken button. */
  if (!db.isOwner()) {
    if (db.needsPassword()) {
      return `${flashBar()}
        ${safe("Set a password", passwordPrompt)}
        ${versionBlock()}`;
    }
    return empty("Not your area", "Only the group owner manages people and settings.");
  }

  return `${flashBar()}
  ${safe("Set a password", passwordPrompt)}
  ${safe("People", peopleSection)}
  ${safe("Group", groupSection)}
  ${safe("Import", importSection)}
  ${safe("Backup", backupSection)}
  ${safe("Course lookup", lookupSection)}
  ${safe("Account", accountSection)}
  ${versionBlock()}`;
}

/* Only appears while there is a version 1 scorecard that has not been brought
   across. Once its golfers are here it disappears by itself. */
function importSection() {
  if (!legacy) return "";
  const arrived = (legacy.preview.golfers || 0) > 0 && golfers.length >= legacy.preview.golfers;
  if (arrived) return "";
  const p = legacy.preview;
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Your version 1 data</h2></div>
    <div class="card padded">
      <p class="hint" style="margin:0 0 0.6rem">Still sitting where it always was: <b>${p.golfers} golfer${p.golfers === 1 ? "" : "s"}</b>, <b>${p.courses} course${p.courses === 1 ? "" : "s"}</b>, ${p.rounds} round${p.rounds === 1 ? "" : "s"}${p.earliest ? `, ${p.earliest} to ${p.latest}` : ""}.</p>
      <p class="hint">This copies it into <b>${esc(association ? association.name : "this group")}</b>. Nothing is deleted, and running it twice does not duplicate anything.</p>
      <div class="inline-actions stacked">
        <button class="btn" data-act="import-here" ${importing ? "disabled" : ""}>${importing ? "Importing…" : "Bring it into this group"}</button>
      </div>
    </div>
  </section>`;
}

/* Shown to an admin or owner who has no account yet.
 *
 * Deliberately at the top of Admin and repeated on Manage: their role works
 * today, but it is tied to this browser alone, which is not a safe place for
 * the ability to edit everybody's rounds. */
function passwordPrompt() {
  if (!db.needsPassword()) return "";
  const role = db.myRole();
  return `<section class="panel">
    <div class="card padded" style="border:2px solid var(--pencil)">
      <div class="name">You are ${role === "owner" ? "the owner" : "an admin"} on this device only</div>
      <p class="hint">Your role works, but it lives in this browser alone. Clear its data and it is gone — and nothing connects what you do here to you rather than to this device. Set an email and password and it follows you everywhere.</p>

      <label class="lbl">Email</label>
      <input class="field" name="promote-email" type="email" placeholder="you@example.com"
             autocomplete="username" autocapitalize="none" value="${esc(authForm.email)}">
      <label class="lbl">Password for this app</label>
      <input class="field" name="promote-password" type="password"
             placeholder="Invent one, at least 6 characters" autocomplete="new-password">
      <div class="inline-actions stacked">
        <button class="btn" data-act="set-admin-password">Set my password</button>
      </div>
      <p class="hint"><b>Not the password for your email account.</b> A new one, for this app only.</p>
    </div>
  </section>`;
}

function peopleSection() {
  /* ONE row per PERSON, not one per account.
   *
   * Every time somebody taps an invitation in a fresh browser or a private
   * window, an anonymous account is created and another membership written. A
   * golfer who joined from three devices therefore appeared three times, all
   * identical, with no way to tell which was current. They are grouped here by
   * the golfer they belong to (falling back to the name), the most recent kept,
   * and the older ones offered for removal.
   *
   * Nothing is removed automatically: a duplicate might be a real second person
   * with the same name, and only the owner can tell. */
  const mine = db.status().uid;
  const claimed = new Set(members.map((m) => m.golferId).filter(Boolean));

  const groups = new Map();
  for (const m of members) {
    const key = m.golferId || `name:${String(m.displayName || "").trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const joined = [...groups.values()].map((list) => {
    /* Most recent first — the owner is always kept whatever its age, since it
       is the account that cannot be removed. */
    const sorted = [...list].sort((a, b) => {
      if (a.role === "owner") return -1;
      if (b.role === "owner") return 1;
      const at = (m) => (m.joinedAt && m.joinedAt.seconds) || m.joinedAt || 0;
      return at(b) - at(a);
    });
    const keep = sorted[0];
    return {
      key: keep.uid,
      name: keep.displayName || "Unnamed",
      role: keep.role,
      you: sorted.some((m) => m.uid === mine),
      state: "joined",
      extras: sorted.slice(1).filter((m) => m.role !== "owner"),
    };
  });

  const waiting = sortedGolfers()
    .filter((g) => g.invitedAt && !g.linkedUid && !claimed.has(g.id))
    .map((g) => ({
      key: `g:${g.id}`, name: g.name,
      role: g.invitedAs === "admin" ? "admin" : "member",
      you: false, state: "waiting", golferId: g.id, extras: [],
    }));

  const people = [...joined, ...waiting];
  const spare = joined.reduce((n, p) => n + p.extras.length, 0);

  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">People</h2>
      <span class="panel-count">${people.length || ""}</span></div>
    <div class="card">
      <div class="list">
        ${people.length ? people.map((p) => `<div class="list-row">
          <span class="grow"><span class="name">${esc(p.name)}</span><br>
            <span class="sub">${roleLabel(p.role)}${p.you ? " · you" : ""} ·
              <span class="invite-state ${p.state}">${p.state === "joined" ? "invitation used" : "not used yet"}</span>${
                p.extras.length ? ` · <span class="invite-state waiting">${p.extras.length} older sign-in${p.extras.length === 1 ? "" : "s"}</span>` : ""
              }</span></span>
          ${p.state === "joined" && p.role !== "owner"
            ? `<button class="rowbtn" data-role="${p.key}:${p.role === "admin" ? "member" : "admin"}">${p.role === "admin" ? "Make guest" : "Make admin"}</button>`
            : p.state === "waiting"
              ? `<button class="rowbtn" data-invite-golfer="${esc(p.golferId)}">Send again</button>`
              : ""}
        </div>`).join("") : `<p class="blank" style="padding:1rem">Nobody yet.</p>`}
      </div>

      ${spare ? `<div class="inline-form bordered">
        <p class="hint" style="margin:0 0 0.7rem"><b>${spare} older sign-in${spare === 1 ? "" : "s"}</b> —
        left behind when somebody joined again from another browser or a private window. Each one is
        a separate account for the same person. Removing them tidies this list and takes nothing
        away: their rounds belong to the golfer, not the sign-in.</p>
        <div class="inline-actions">
          <button class="btn compact" data-act="tidy-signins">Remove the older sign-ins</button>
        </div>
      </div>` : ""}

      <div class="inline-form bordered">
        <p class="hint" style="margin:0 0 0.7rem">Invitations for people who play are on the
        <b>Manage</b> tab, beside each name — that way the link carries their name and ties them to
        their existing rounds.</p>
        <p class="hint" style="margin:0 0 0.7rem"><b>An administrator who does not play?</b> This adds
        the role only — no golfer, no place on the roster.</p>
        <div class="inline-actions">
          <button class="btn compact" data-act="invite-nonplayer">Invite an admin who doesn't play</button>
          <button class="btn ghost compact" data-act="show-code">Show the code</button>
        </div>
      </div>
    </div>
    <p class="hint"><b>Guests</b> post their own rounds and see the results. <b>Admins</b> also add courses, manage the roster and post for anybody. <b>You</b> can do everything, and only you can change these.</p>
  </section>`;
}

function groupSection() {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Group</h2></div>
    <div class="card padded">
      <label class="lbl" style="margin-top:0">Group name</label>
      <input class="field" name="assoc-name" value="${esc(association ? association.name : "")}">
      <div class="inline-actions stacked">
        <button class="btn ghost" data-act="rename-group">Save the name</button>
      </div>
    </div>
    <p class="hint"><a href="./rebuild.html">Rebuild the roster</a> · <a href="./tidy.html">Check and tidy the data</a> · <a href="./cleanup.html">Clean up unused groups</a></p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Delete this group</h2></div>
    <div class="card padded">
      <p class="hint" style="margin:0 0 0.7rem">Removes <b>${esc(association ? association.name : "")}</b> and every round and game in it. <b>Golfers are not deleted</b> — they are people, and they keep their handicap and their place in your other groups.</p>
      ${confirmDeleteGroup ? `
        <div class="note warn">
          <b>What goes:</b> this group, its ${rounds.length} round${rounds.length === 1 ? "" : "s"} and its ${games.length} game${games.length === 1 ? "" : "s"}.<br>
          <b>What stays:</b> all ${golfers.length} golfer${golfers.length === 1 ? "" : "s"}, every course, and every round they have played in your other groups. Their handicaps are rebuilt from what remains.
        </div>
        <p class="hint">A copy of the rounds is saved to this device first, and offered to you as a file straight afterwards — so even this is recoverable.</p>
        <div class="inline-actions stacked">
          <button class="btn ghost" data-act="cancel-delete-group">Keep it</button>
          <button class="btn danger" data-act="really-delete-group">Delete ${esc(association ? association.name : "this group")}</button>
        </div>
      ` : `<div class="inline-actions stacked">
          <button class="btn ghost warn" data-act="delete-group">Delete this group</button>
        </div>`}
    </div>
  </section>`;
}



const roleLabel = (role) => (role === "owner" ? "owner" : role === "admin" ? "admin" : "guest");

function backupSection() {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Backup</h2></div>
    <div class="card padded">
      <p class="hint" style="margin:0 0 0.8rem">Saves every golfer, course and round to a file you keep. Worth doing before anything risky, and before handing the app to more people.</p>
      <div class="inline-actions stacked">
        <button class="btn" data-act="backup">Back up now</button>
        <button class="btn ghost" data-act="restore">Restore from a file</button>
        <button class="btn ghost" data-act="paste-restore">Paste a backup instead</button>
      </div>
      <p class="hint">Restoring never deletes anything. Rounds already here are left alone; missing ones are put back.</p>
    </div>
  </section>`;
}

function backupData() {
  return {
    kind: "scorecard-backup",
    version: VERSION,
    savedAt: new Date().toISOString(),
    group: association ? association.name : "",
    golfers, courses, rounds,
  };
}

const backupFilename = () =>
  `scorecard-${(association && association.name ? association.name : "backup").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${today()}.txt`;

/* One button, then a choice of where it goes. A downloaded file is the one
   that survives a lost phone, so it is offered first. */
function openBackupSheet() {
  const data = backupData();
  const text = JSON.stringify(data, null, 1);
  sheetEl.hidden = false;
  sheetEl.dataset.text = text;
  sheetEl.dataset.title = `Scorecard backup — ${data.group || "group"}`;
  sheetEl.dataset.filename = backupFilename();
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>Backup ready</h2><button class="rowbtn" data-close="1">Close</button></div>
    <p class="hint">${rounds.length} round${rounds.length === 1 ? "" : "s"}, ${golfers.length} golfer${golfers.length === 1 ? "" : "s"}, ${courses.length} course${courses.length === 1 ? "" : "s"}. Where should it go?</p>
    <div class="inline-actions stacked">
      <button class="btn" data-send="save">Save it somewhere</button>
    </div>
    <div class="share-grid" style="margin-top:0.7rem">
      <button class="btn ghost" data-send="email">Email it to me</button>
      <button class="btn ghost" data-send="whatsapp">WhatsApp</button>
    </div>
    <div class="inline-actions stacked">
      <button class="btn ghost" data-send="copy">Copy the text</button>
      ${navigator.share ? `<button class="btn ghost" data-send="native">More apps…</button>` : ""}
    </div>
    <p class="hint">Save it somewhere lets you choose the folder — iCloud Drive, Google Drive, Dropbox or anywhere else on the device. A file kept off the phone is the one that survives losing the phone.</p>
  </div>`;
}

/* Lets the person choose where it goes instead of dropping it in Downloads.
 *
 * Three routes, best first. A desktop browser can open a real save dialog. A
 * phone cannot, but its share sheet offers Save to Files, iCloud Drive, Google
 * Drive and the rest — which is the same choice by another name. Only if
 * neither exists does it fall back to a plain download.
 */
async function saveBackup() {
  const text = sheetEl.dataset.text || "";
  const name = sheetEl.dataset.filename || "scorecard-backup.txt";

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "Text file", accept: { "text/plain": [".txt"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      sheetEl.hidden = true;
      flashMsg("Saved where you chose.");
      render();
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;   /* they changed their mind */
    }
  }

  try {
    const file = new File([text], name, { type: "text/plain" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: sheetEl.dataset.title || "Scorecard backup" });
      sheetEl.hidden = true;
      flashMsg("Choose Save to Files, then pick iCloud Drive or any folder you like.");
      render();
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }

  downloadBackup();
}

function downloadBackup() {
  try {
    const blob = new Blob([sheetEl.dataset.text || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sheetEl.dataset.filename || "scorecard-backup.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    sheetEl.hidden = true;
    flashMsg("Saved to this device's downloads folder.");
  } catch {
    flashMsg("This browser wouldn't save the file. Use Email or Copy instead.");
  }
}

/* Paste the backup text straight in, with no file involved.
 *
 * Saving a note as a file, finding it again, and handing it to a file picker is
 * several fiddly steps on an iPad — and it failed repeatedly. Select All, Copy,
 * paste here is two taps and cannot go wrong. */
function openPasteRestore() {
  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>Paste a backup</h2><button class="rowbtn" data-close="1">Close</button></div>
    <p class="hint">Open the backup wherever you kept it — a note, an email — tap <b>Select All</b>, then <b>Copy</b>. Tap in the box below and paste.</p>
    <textarea class="field" name="pasted-backup" rows="6" placeholder="Paste here. It starts with a curly brace." autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>
    <div id="paste-check" class="hint"></div>
    <div class="inline-actions stacked">
      <button class="btn" data-paste="restore">Check and restore</button>
    </div>
    <p class="hint">Nothing is written until you have seen what it found. Restoring never deletes — anything already here is left alone.</p>
  </div>`;
}

/* Asks for the file, checks what is in it, and shows you before writing. */
function askForBackupFile() {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".txt,.json,text/plain,application/json";
  picker.onchange = () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const found = {
          golfers: parsed.golfers || [],
          courses: parsed.courses || [],
          rounds: parsed.rounds || [],
        };
        if (!Array.isArray(found.rounds)) throw new Error("not a backup");
        const result = db.restoreBackup(found);
        flashMsg(`Restoring ${found.rounds.length} round${found.rounds.length === 1 ? "" : "s"} and ${found.golfers.length} golfer${found.golfers.length === 1 ? "" : "s"}. ${result.queued} change${result.queued === 1 ? "" : "s"} queued — nothing was deleted.`);
      } catch {
        flashMsg("That file isn't a Scorecard backup. Pick the .txt file the app saved.");
      }
    };
    reader.onerror = () => flashMsg("Couldn't read that file.");
    reader.readAsText(file);
  };
  picker.click();
}

/* Signing in has to be reachable from inside the app, not only on the very
   first screen. Somebody who already belongs to a group never sees that screen
   again — which left them anonymous, and therefore a different person in
   Safari and in the home-screen app, with no way to fix it. */
function accountSection() {
  const email = typeof db.currentEmail === "function" ? db.currentEmail() : "";
  const hasGroup = !!db.currentAssociation();

  if (email) {
    const settled = typeof db.hasPassword === "function" ? db.hasPassword() : true;
    return `<section class="panel">
      <div class="panel-head"><h2 class="panel-title">Account</h2></div>
      <div class="card padded">
        <div class="name">${esc(email)}</div>
        <div class="sub">${esc(sync.text)}${settled ? "" : " · no password yet"}</div>

        ${settled ? `
          <p class="hint">Use this email and password on your other devices and you are one person everywhere.</p>
        ` : `
          <div class="note"><b>One step left.</b> You are signed in through Google, which only works here in Safari. Set a password so you can reach this same account from the home-screen app, where Google cannot work.</div>
          <label class="lbl">Password for this app</label>
          <input class="field" name="password" type="password" placeholder="Invent one, at least 6 characters" autocomplete="new-password">
          <div class="inline-actions stacked">
            <button class="btn" data-act="set-password" ${joining ? "disabled" : ""}>${joining ? "Setting…" : "Set the password"}</button>
          </div>
          <p class="hint"><b>Not the password for your email account.</b> This is a new one, for this app only. Write it down — you will type it on every other device, with the email above.</p>
        `}

        <div class="inline-actions stacked">
          <button class="btn ${confirmSignOut ? "danger" : "ghost"}" data-act="sign-out">
            ${confirmSignOut ? "Tap again to sign out" : "Sign out of this device"}
          </button>
        </div>
        <p class="hint">${confirmSignOut
          ? "Nothing is deleted — this device simply returns to the first screen. Wait a few seconds to cancel."
          : "Signing out deletes nothing. It returns this device to the first screen."}</p>
      </div>
    </section>`;
  }

  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Account</h2></div>
    <div class="card padded">
      <div class="name">This device only${db.canManage() ? " — and you are " + (db.myRole() === "owner" ? "the owner" : "an admin") : ""}</div>
      <p class="hint">Right now this device is not tied to any account. That means Safari and the home-screen app count as two different people, each with their own groups. Signing in fixes that.</p>
      ${db.canManage() ? `<div class="note"><b>Worth doing today.</b> Your role is real and works properly, but it exists only in this browser. Without an account it cannot follow you to another device, and it disappears if this browser's data is cleared.</div>` : ""}

      <div class="note tip"><b>If you have version 1 data, do this in order.</b> Tap the Google button first — it can only work here in Safari — then come back and set a password. Setting a password without that step would create a separate, empty account.</div>

      <div class="inline-actions stacked">
        <button class="btn ghost" data-act="google">Sign in with Google — Safari only</button>
      </div>
      <p class="hint">Never works in an app opened from the home screen; iOS blocks the window Google needs.</p>

      <label class="lbl">Email</label>
      <input class="field" name="email" type="email" value="${esc(authForm.email)}" placeholder="you@example.com" autocomplete="username" autocapitalize="none">
      <label class="lbl">Password for this app</label>
      <input class="field" name="password" type="password" placeholder="Invent one, at least 6 characters" autocomplete="new-password">
      <div class="inline-actions stacked">
        <button class="btn" data-act="sign-in" ${joining ? "disabled" : ""}>${joining ? "Signing in…" : "Set the password"}</button>
      </div>
      <p class="hint"><b>Not your email password.</b> A new one, for this app only. You will type it on your other devices.</p>
      ${hasGroup ? `<p class="hint">Your groups and rounds stay exactly as they are — signing in attaches this device to an account, it does not move anything.</p>` : ""}
    </div>
  </section>`;
}

function lookupSection() {
  if (!db.isOwner()) return "";
  const set = lookup.usingSharedKey();

  if (set && !editingKey) {
    return `<section class="panel">
      <div class="panel-head"><h2 class="panel-title">Course lookup</h2>
        <button class="linkbtn" data-act="edit-key">Change</button></div>
      <div class="card padded">
        <p class="hint" style="margin:0">A search key is saved for the group, so everybody can find courses by name without entering anything.</p>
      </div>
    </section>`;
  }

  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Course lookup</h2></div>
    <div class="card padded">
      <p class="hint" style="margin:0 0 0.6rem">${set
        ? "Paste a new key to replace the one saved for the group."
        : "<b>Not set up yet.</b> Without a key, courses have to be typed in by hand with their rating and slope. With one, anybody in the group can search by name. Get a free key at <b>golfcourseapi.com</b>."}</p>
      <p class="hint">It is saved once for the whole group. Nobody else has to enter it, and only you can change it.</p>
      <input class="field mono" name="lookupkey" value="" placeholder="Paste the key here" autocomplete="off">
      <div class="inline-actions stacked">
        <button class="btn" data-act="save-key">Save for the group</button>
        ${set ? `<button class="btn ghost" data-act="cancel-key">Cancel</button>` : ""}
      </div>
    </div>
  </section>`;
}

function courseEditor() {
  const d = courseDraft;
  return `<div class="card editor">
    <div class="editor-title">New course</div>
    <label class="lbl">Find it by name</label>
    <div class="inline-form" style="padding:0">
      <input name="finder-q" class="inline-input" value="${esc(finder.q)}" placeholder="Course or club name" autocomplete="off">
      <div class="inline-actions">
        <button class="btn compact" data-act="find" ${finder.busy ? "disabled" : ""}>${finder.busy ? "Searching…" : "Search"}</button>
      </div>
    </div>
    ${finder.msg ? `<p class="hint">${esc(finder.msg)}${!lookup.hasKey() && !db.isOwner() ? " Ask whoever set up the group to add a course lookup key." : ""}</p>` : ""}
    ${finder.results.length ? `<div class="results list">
      ${finder.results.map((c, i) => `<button class="list-row" data-pick="${i}">
        <span class="grow"><span class="name">${esc(c.name)}</span><br>
          <span class="sub">${esc(c.where || "")}${c.where ? " · " : ""}${c.tees.length} rated tee${c.tees.length === 1 ? "" : "s"}</span></span>
        <span class="chev">›</span></button>`).join("")}
    </div>` : ""}

    <label class="lbl">Course name</label>
    <input class="field" name="c-name" value="${esc(d.name)}" placeholder="Royal Ontario">

    <label class="lbl">Tees</label>
    ${d.tees.map((t, i) => `<div class="tee-row">
      <div class="tee-head">
        <input class="field" data-tee-field="${i}:name" value="${esc(t.name)}" placeholder="Tee name, e.g. Blue">
        ${d.tees.length > 1 ? `<button class="rowbtn warn" data-rm-tee="${i}">Remove</button>` : ""}
      </div>
      <div class="tee-nums">
        <label>Rating<input class="field mono" data-tee-field="${i}:rating" value="${esc(t.rating)}" inputmode="decimal"></label>
        <label>Slope<input class="field mono" data-tee-field="${i}:slope" value="${esc(t.slope)}" inputmode="numeric"></label>
        <label>Par<input class="field mono" data-tee-field="${i}:par" value="${esc(t.par)}" inputmode="numeric"></label>
      </div>
    </div>`).join("")}
    <button class="linkbtn" data-act="add-tee">Add another tee</button>

    <div class="inline-actions stacked editor-actions">
      <button class="btn" data-act="save-course">Save course</button>
      <button class="btn ghost" data-act="cancel-course">Cancel</button>
    </div>
  </div>`;
}

function refreshScope() { golfers = sortedGolfers(); }

/* Enable or disable a button in place, rather than redrawing the screen.
   Redrawing closed open pickers and lost half-typed text — which is why Save
   game stayed grey after picking a course, and why the date wheel kept
   bouncing back to the main screen. */
function updateEnterHints() {
  /* Reads and patches only the Post button and its hint. It must never write to
     the date input or redraw it — see the note in the change handler. */
  const course = courseById(form.courseId);
  const tee = course && course.tees.find((t) => t.id === form.teeId);
  const ok = form.golferId && tee && +form.gross > 0;
  const button = view.querySelector('[data-act="post"]');
  if (button) button.disabled = !ok;
  const hint = view.querySelector("#post-hint");
  if (hint) {
    const missing = [
      form.golferId ? "" : "choose the golfer",
      course ? (tee ? "" : "choose the tees") : "choose the course",
      +form.gross > 0 ? "" : "type the score",
    ].filter(Boolean);
    hint.textContent = missing.length
      ? missing.join(", ").replace(/^./, (c) => c.toUpperCase()) + " to enable Post."
      : "";
  }
}

function updateGameHints() {
  const button = view.querySelector('[data-act="save-game"]');
  if (button) button.disabled = !(gameDraft && gameDraft.courseId);
  const hint = view.querySelector("#game-hint");
  if (hint) hint.textContent = gameDraft && gameDraft.courseId ? "" : "Pick the course to enable Save.";
}

/* Draws one section, and if it throws, says which one rather than taking the
   whole screen down with it. A screen that is 90 per cent useful beats an
   error card every time. */
function safe(label, build) {
  try { return build(); }
  catch (e) {
    return `<section class="panel"><div class="note warn">
      <b>${esc(label)} could not be shown</b><br>${esc((e && e.message) || "Unknown error")}
    </div></section>`;
  }
}

function versionBlock() {
  return `<section class="version">
    <div><b>The Scorecard</b> <span class="mono">v${VERSION}</span></div>
    <div class="sub">${rounds.length} round${rounds.length === 1 ? "" : "s"} · ${golfers.length} golfer${golfers.length === 1 ? "" : "s"} · ${courses.length} course${courses.length === 1 ? "" : "s"}</div>
    <div class="sub">${esc(sync.text)} · World Handicap System, best 8 of last 20</div>
  </section>`;
}

/* ================= busy ================= */

/* Shown whenever the app is doing something that takes a moment. Without it a
   slow save looks like a frozen app, and people tap again — which is how
   duplicates get made. */
let busyDepth = 0;
let busyWhat = "";

/* Held as state and repainted by render(), rather than poked into the page once.
 *
 * Poking it directly never worked: flashMsg() and render() both redraw, and any
 * redraw between busy() and idle() wiped the bar or, worse, left it showing with
 * nothing able to clear it. A spinner that never stops is the most alarming
 * thing an app can do, so this is now driven from one variable that render()
 * reads — it cannot fall out of step with what is on screen.
 *
 * paintBusy() is also called directly so the bar appears immediately, without
 * waiting for the next redraw. */
let busyStarted = 0;

function paintBusy() {
  const bar = document.getElementById("busy");
  const what = document.getElementById("busyWhat");
  if (what && busyWhat) what.textContent = `${busyWhat}…`;
  if (!bar) return;
  /* Only the text changes. The card's markup lives in index.html and is never
     rewritten — rebuilding it would restart the spinner animation on every
     call and throw away the element the screen reader is announcing. */
  bar.hidden = busyDepth === 0;
}

function busy(what) {
  if (busyDepth === 0) busyStarted = Date.now();
  busyDepth++;
  busyWhat = what || "Working";
  paintBusy();
}

function idle() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (busyDepth === 0) busyWhat = "";
  paintBusy();
}

/* Belt and braces: nothing may leave a spinner running for more than half a
   minute. If it ever does, that is a bug — but the person is not left stuck. */
function idleAll() { busyDepth = 0; busyWhat = ""; paintBusy(); }
setInterval(() => { if (busyDepth > 0 && Date.now() - busyStarted > 30000) idleAll(); }, 5000);

/* ================= problems ================= */

/* One dialog for anything that goes wrong, so a failure is never silent and
   never leaves somebody guessing what to do next.
 *
 * Fatal means the app cannot carry on. Everything else offers Continue. */
const SUPPORT_EMAIL = "willyros01@gmail.com";
const REPORT_ENDPOINT = "https://formspree.io/f/xnpapknv";

/* The last few things that happened, so a report says what led to the failure
   rather than only what broke. Kept small and in memory — never stored, never
   sent anywhere except in a report the person chooses to send. */
const trail = [];
function note(what) {
  trail.push(`${new Date().toISOString().slice(11, 19)}  ${what}`);
  if (trail.length > 25) trail.shift();
}

/* Good news, in the same shape as the problem dialog but without any of the
 * error machinery.
 *
 * Using openProblem for something that had gone RIGHT titled it "That did not
 * work", labelled the report "BUG", and offered to send it — so a successful
 * admin join arrived as a bug report. Anything informational belongs here. */
/* Setting or changing the password, available to anybody signed in, at any
   time, from the account bubble. No conditions. */
function openPasswordSheet({ heading, because, allowLater = false } = {}) {
  const email = db.currentEmail();
  const has = db.hasPassword();
  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>${esc(heading || (has ? "Change your password" : "Set a password"))}</h2>
      ${allowLater ? "" : `<button class="rowbtn" data-close="1">Close</button>`}</div>

    ${because ? `<div class="note tip">${esc(because)}</div>` : ""}

    ${has
      ? `<p class="hint">This account already signs in with a password. Setting a new one replaces it.</p>`
      : email
        ? `<p class="hint">This account signs in another way, with no password of its own. Adding one means you can sign in with an email address and password anywhere.</p>`
        : `<p class="hint">This device has no account. Adding an email and password keeps your role and your groups when you change browser or device.</p>`}

    <label class="lbl">Email</label>
    <input class="field" name="pw-email" type="email" value="${esc(email || "")}"
           placeholder="you@example.com" autocomplete="username" autocapitalize="none"
           ${email ? "readonly" : ""}>
    ${email ? `<p class="hint">This is the account you are signed in as. The password will belong to it.</p>` : ""}

    <label class="lbl">${has ? "New password" : "Password for this app"}</label>
    <input class="field" name="pw-secret" type="password" autocomplete="new-password"
           placeholder="At least 6 characters">

    <div class="inline-actions stacked">
      <button class="btn" data-pw="save">${has ? "Change it" : "Set it and finish"}</button>
      ${allowLater ? `<button class="btn ghost" data-pw="later">Not now</button>` : ""}
    </div>
    <p class="hint"><b>Not the password for your email account.</b> A new one, for this app only.</p>
  </div>`;
}

function openNotice({ title, detail, advice, action }) {
  sheetEl.hidden = false;
  sheetEl.dataset.report = "";
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>${esc(title)}</h2>
      <button class="rowbtn" data-close="1">Close</button>
    </div>
    <div class="note tip">${esc(detail || "")}</div>
    ${advice ? `<p class="hint"><b>Next:</b> ${esc(advice)}</p>` : ""}
    <div class="inline-actions stacked">
      ${action ? `<button class="btn" data-act="${esc(action.act)}">${esc(action.label)}</button>` : ""}
      <button class="btn ${action ? "ghost" : ""}" data-close="1">Got it</button>
    </div>
  </div>`;
}

function openProblem({ title, detail, advice, fatal = false }) {
  note(`problem: ${title}`);
  const report = [
    `${fatal ? "FATAL" : "BUG"}: ${title}`,
    "",
    `What happened: ${detail || "no detail given"}`,
    `Version: ${VERSION}`,
    `Screen: ${tab}`,
    `Group: ${association ? association.name : "none"}`,
    /* The role matters as much as the account: "this device only" plus "admin"
       says an anonymous user holds a real role, which changes what they are
       allowed to READ and is exactly what one report turned on. */
    `Account: ${db.currentEmail() || "this device only (anonymous)"}${db.myRole() ? ` · role ${db.myRole()}` : " · no role"}`,
    `Sync: ${sync.text}`,
    `When: ${new Date().toISOString()}`,
    `Device: ${navigator.userAgent}`,
    "",
    "What happened just before:",
    ...(trail.length ? trail.slice(-15) : ["nothing recorded"]),
  ].join("\n");

  sheetEl.hidden = false;
  sheetEl.dataset.report = report;
  sheetEl.dataset.subject = `${fatal ? "FATAL" : "BUG"} — The Scorecard ${VERSION} — ${title}`;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>${fatal ? "Something has gone wrong" : "That did not work"}</h2>
      ${fatal ? "" : `<button class="rowbtn" data-close="1">Close</button>`}
    </div>
    <div class="note ${fatal ? "" : "tip"}"><b>${esc(title)}</b><br>${esc(detail || "")}</div>
    ${advice ? `<p class="hint"><b>What to try:</b> ${esc(advice)}</p>` : ""}

    <label class="lbl">What were you doing? (optional, but it helps a lot)</label>
    <input class="field" name="what-happened" placeholder="e.g. renaming a golfer on the Manage tab" autocomplete="off">

    <div class="inline-actions stacked">
      ${fatal ? "" : `<button class="btn" data-problem="continue">Carry on</button>`}
      <button class="btn" data-problem="send">Send this report</button>
      <button class="btn ghost" data-problem="email">Email it instead</button>
      <button class="btn ghost warn" data-problem="reset">Reset and start again</button>
    </div>
    <p class="hint">Send goes straight through with no mail app. Reset discards anything half-typed and reopens the app; nothing already saved is affected.</p>
  </div>`;
}

sheetEl.addEventListener("click", async (e) => {
  const action = e.target.closest("[data-problem]");
  if (!action) return;
  const what = action.dataset.problem;

  const context = () => {
    const field = sheetEl.querySelector('[name="what-happened"]');
    const said = field && field.value.trim();
    return said
      ? `${sheetEl.dataset.report}\n\nThey said: ${said}`
      : sheetEl.dataset.report || "";
  };

  if (what === "continue") { sheetEl.hidden = true; return; }

  if (what === "send") {
    action.disabled = true;
    action.textContent = "Sending…";
    try {
      const response = await fetch(REPORT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ subject: sheetEl.dataset.subject || "BUG", message: context() }),
      });
      if (!response.ok) throw new Error(String(response.status));
      sheetEl.hidden = true;
      flashMsg("Report sent. Thank you — that genuinely helps.");
    } catch {
      /* Never leave somebody with a dead Send. Hand it to the mail app instead. */
      action.disabled = false;
      action.textContent = "Send this report";
      flashMsg("Couldn't send it directly. Opening your mail app instead.");
      location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(sheetEl.dataset.subject || "BUG")}&body=${encodeURIComponent(context())}`;
    }
    return;
  }

  if (what === "email") {
    location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(sheetEl.dataset.subject || "BUG")}&body=${encodeURIComponent(context())}`;
    return;
  }

  if (what === "reset") { location.reload(); return; }
});

/* Anything thrown after the app is running comes here rather than to a banner
   nobody reads. */
window.showBanner = (title, detail) => openProblem({ title, detail, fatal: false });

/* ================= render ================= */

/* Tabs are the whole permission model as far as anybody using the app is
   concerned. Nothing they cannot do is ever on screen, so there is nothing to
   tap and be refused. */
function visibleTabs() {
  const tabs = [
    ["enter", "Enter", "✎"],
    ["history", db.canManage() ? "History" : "My rounds", "≡"],
    ["summary", "Summary", "▤"],
    ["games", "Games", "⚑"],
  ];
  if (db.canManage()) tabs.push(["manage", "Manage", "⚙"]);
  if (db.isOwner()) tabs.push(["admin", "Admin", "★"]);
  return tabs;
}

function renderTabs() {
  tabsEl.innerHTML = visibleTabs().map(([id, label, icon]) =>
    `<button data-tab="${id}" class="${tab === id ? "on" : ""}" role="tab"><span class="ico">${icon}</span>${label}</button>`).join("");
}

/* A redraw is postponed while a date field is open.
 *
 * render() rewrites the whole panel, which destroys the native date input the
 * picker is attached to. On iOS the calendar is then orphaned: the month and
 * year wheels still move, but the day grid never draws, and the only way out is
 * to leave the field and come back — which is exactly how this was reported.
 *
 * The trigger is not the user's own typing; it is a live update arriving from
 * the database mid-interaction, and several arrive while a group syncs. So the
 * redraw is held until the field is closed, then run once. */
let redrawWanted = false;

function dateFieldIsOpen() {
  const active = document.activeElement;
  return !!(active
    && active.tagName === "INPUT"
    && active.type === "date"
    && view.contains(active));
}

function render({ force = false } = {}) {
  if (!force && dateFieldIsOpen()) {
    redrawWanted = true;
    /* Update only what can be changed without touching the panel, so the
       screen is not stale while the picker is up. */
    try {
      const btn = document.getElementById("statusBtn");
      const sync = db.status();
      if (btn) {
        btn.textContent = sync.text;
        btn.classList.toggle("alert", !!sync.alert);
      }
      paintBusy();
      paintAlert();
    } catch { /* cosmetic only */ }
    return;
  }
  redrawWanted = false;
  return renderNow();
}

/* Whenever a date field loses focus, catch up on anything held back. */
document.addEventListener("focusout", (e) => {
  if (!(e.target && e.target.tagName === "INPUT" && e.target.type === "date")) return;
  /* A tick later, so the browser has finished moving focus. */
  setTimeout(() => {
    if (redrawWanted && !dateFieldIsOpen()) {
      redrawWanted = false;
      renderNow();
    }
  }, 0);
}, true);

function renderNow() {
  try {
    if (!ready || settling) {
      view.innerHTML = bootCard();
    } else if (!db.currentAssociation()) {
      tabsEl.innerHTML = "";
      view.innerHTML = screenJoin();
      document.getElementById("brandSub").textContent = "Getting started";
    } else {
      const allowed = visibleTabs().map(([id]) => id);
      if (!allowed.includes(tab)) tab = "enter";
      renderTabs();
      const screens = { enter: screenEnter, history: screenHistory, summary: screenSummary,
                        games: screenGames, manage: screenManage, admin: screenAdmin };
      /* A screen that throws used to show a dead end. Now the failure is
         reported and the tab bar still works, so nobody is trapped. */
      view.innerHTML = (screens[tab] || screenEnter)();
      const sub = document.getElementById("brandSub");
      const groups = db.knownGroups();
      sub.textContent = (association ? association.name : "Handicap tracking") + (groups.length > 1 ? "  ▾" : "");
      sub.dataset.act = "switch-group";

      /* Who you are, beside the group. Shown only when there is something worth
         saying: a role is only meaningful for an admin or the owner, and a
         guest sees nothing extra rather than the word "guest" following them
         around. */
      const who = document.getElementById("whoAmI");
      if (who) {
        const me = members.find((m) => m.uid === db.status().uid);
        const role = me && me.role;
        const email = db.currentEmail();
        const parts = [];
        if (me && me.displayName) parts.push(me.displayName);
        if (role === "owner" || role === "admin") parts.push(role);
        who.textContent = parts.join(" · ");
        who.title = email || "";
        who.hidden = !parts.length;
      }
    }
  } catch (e) {
    view.innerHTML = `<div class="fatal"><div class="fatal-mark">!</div>
      <h2>This screen couldn't be drawn</h2>
      <p>Your rounds are safe. Try another tab, or reload.</p>
      <button class="btn" data-act="recover">Back to Enter</button>
      <details><summary>Technical detail</summary><pre>${esc(e && e.message)}</pre></details></div>`;
  }
  const btn = document.getElementById("statusBtn");
  btn.textContent = sync.text;
  btn.classList.toggle("alert", !!sync.alert);
  paintBusy();
  paintAlert();
  if (window.__scorecardBooted) window.__scorecardBooted();
}

let dismissed = "";
function paintAlert() {
  const el = document.getElementById("alert");
  const err = sync.error;
  if (!err || dismissed === err.short + err.full) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>${esc(err.short)}</b> ${esc(err.full)} <button class="linkbtn" data-act="dismiss-alert">Dismiss</button>`;
}
document.getElementById("alert").addEventListener("click", (e) => {
  if (e.target.dataset.act === "dismiss-alert" && sync.error) {
    dismissed = sync.error.short + sync.error.full;
    paintAlert();
  }
});

/* ================= events ================= */

tabsEl.addEventListener("click", (e) => {
  /* Switching tab always draws. Anything holding a redraw back is irrelevant
     once the person has left the screen it belonged to. */
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  note(`opened ${tab}`);
  if (tab === "enter") editingRound = null;
  if (tab !== "games") openGame = null;
  render();
});

/* The status pill is on every screen, so it carries the things somebody might
   need from anywhere: which account they are signed in as, sign out, and the
   backup. Sign out used to live only on the Admin tab, which a guest never
   sees at all. */
document.getElementById("statusBtn").onclick = () => {
  const email = typeof db.currentEmail === "function" ? db.currentEmail() : "";
  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>This device</h2><button class="rowbtn" data-close="1">Close</button></div>
    <div class="card padded">
      <div class="name">${esc(email || "No account — this device only")}</div>
      <div class="sub">${esc(sync.text)}${association ? ` · ${esc(association.name)}` : ""}${db.myRole() ? ` · ${esc(db.myRole())}` : ""}</div>
      <div class="sub"><b>${db.hasPassword()
        ? "This account has a password"
        : email
          ? "This account has NO password — it signs in another way"
          : "No account, so no password"}</b></div>
    </div>

    ${!email && db.canManage() ? `<div class="note warn">
      <b>You are signed in, but without an account.</b> It said "not signed in", which was wrong —
      your ${esc(db.myRole() === "owner" ? "owner" : "admin")} role is real and this device holds it.
      What it does not have is an account, so the role cannot follow you to another device and is
      lost if this browser's data is cleared. Set a password on the Admin tab.
    </div>` : ""}

    ${!email && !db.canManage() ? `<p class="hint">You are signed in without an account, which is all a guest needs. Your rounds are saved to the group, not to this device.</p>` : ""}

    <div class="inline-actions stacked">
      <button class="btn ghost" data-quick="backup">Back up my data</button>
      <button class="btn ${db.hasPassword() ? "ghost" : ""}" data-quick="setpassword">${db.hasPassword() ? "Change my password" : "Set a password"}</button>
      <button class="btn ghost warn" data-quick="signout">Sign out of this device</button>
    </div>
    <p class="hint">Signing out deletes nothing. It returns this device to the first screen.${email ? "" : " Without an account, you will need your invitation link to come back."}</p>
  </div>`;
};

document.getElementById("brandSub").onclick = () => {
  if (!db.currentAssociation()) return;
  sheetEl.hidden = false;
  sheetEl.innerHTML = groupSwitcher();
};

view.addEventListener("input", (e) => {
  const n = e.target.name;
  if (n === "gross" || n === "adjusted") {
    form[n] = e.target.value.replace(/\D/g, "");
    e.target.value = form[n];
    return updateEnterHints();
  }
  if (n === "notes") { form.notes = e.target.value; return; }
  if (n === "finder-q") { finder.q = e.target.value; return; }
  if (n === "join-name" || n === "join-name-2") { joinForm.name = e.target.value; return; }
  if (n === "email") { authForm.email = e.target.value; return; }
  if (n === "group-name" || n === "import-group") { joinForm.groupName = e.target.value; return; }
  if (n === "import-name") { joinForm.name = e.target.value; return; }
  if (n === "join-code") { joinForm.code = e.target.value; return; }
  if (n === "owner-plays") { joinForm.ownerPlays = e.target.checked; return; }
  if (n === "g-name") { gameDraft.name = e.target.value; return; }
  if (e.target.dataset.teeField) {
    const [i, key] = e.target.dataset.teeField.split(":");
    courseDraft.tees[+i][key] = e.target.value;
    return;
  }
  if (n === "c-name") courseDraft.name = e.target.value;
});

view.addEventListener("change", (e) => {
  const n = e.target.name, v = e.target.value;
  /* Nothing here may touch the input itself.
   *
   * iOS fires a change event on every movement of the month and year wheels,
   * not only when a day is finally chosen. Anything that rewrites or redraws
   * this element mid-interaction tears the picker down — which is why the day
   * grid vanished after changing the month, and why the panel used to close.
   * Read the value, update state, update the hint text. Nothing else. */
  if (n === "date") { form.date = v; updateEnterHints(); return; }
  if (n === "golferId") {
    form.golferId = v;
    /* In the walk-through, choosing moves you on — that is the point of it. */
    if (currentEnterStyle() === "steps" && v) stepIndex = 1;
    render();
  }
  if (n === "gameId") { form.gameId = v; }
  if (n === "courseId") {
    const c = courseById(v);
    form.courseId = v; form.teeId = c && c.tees.length === 1 ? c.tees[0].id : "";
    render();
  }
  if (n === "f-golfer") { filter.golferId = v; render(); }
  if (n === "f-year") { filter.year = v; filter.month = ""; render(); }
  if (n === "f-course") { filter.courseId = v; render(); }
  if (n === "rank-year") { rankPeriod.year = v; render(); }
  if (n === "rank-month") { rankPeriod.month = v; render(); }
  if (n === "g-date") { gameDraft.date = v; updateGameHints(); return; }
  if (n === "g-end-date") { gameDraft.endDate = v; return; }
  if (n === "g-course") { gameDraft.courseId = v; updateGameHints(); }
});

view.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.name === "new-golfer") { e.preventDefault(); addGolfer(); }
  if (e.target.name === "rename-golfer") { e.preventDefault(); saveRename(); }
  if (e.target.name === "finder-q") { e.preventDefault(); runFinder(); }
});

view.addEventListener("click", async (e) => {
  /* The calendar is drawn inside the panel, so its taps arrive HERE. They were
     attached to the pop-up sheet's listener instead, which is why every button
     on it was dead and the date could not be changed at all. */
  const calNav = e.target.closest("[data-cal]");
  if (calNav) {
    const what = calNav.dataset.cal;
    const showing = calendarMonth || form.date.slice(0, 7);
    if (what === "prev") { calendarMonth = shiftMonth(showing, -1); calPick = null; }
    else if (what === "next") { calendarMonth = shiftMonth(showing, 1); calPick = null; }
    else if (what === "months") calPick = calPick === "months" ? null : "months";
    else if (what === "years") calPick = calPick === "years" ? null : "years";
    else if (what === "today") { form.date = today(); calendarMonth = form.date.slice(0, 7); calPick = null; }
    else if (what === "typed") {
      /* Typed in by hand. Accepted only if it is a real date and not in the
         future — otherwise the field is left alone and says why. */
      const field = view.querySelector('[name="typed-date"]');
      const typed = field ? field.value.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(typed)) { flashMsg("Type the date as YYYY-MM-DD, for example 2025-05-18"); return render(); }
      const [y, m, d] = typed.split("-").map(Number);
      const real = new Date(Date.UTC(y, m - 1, d));
      if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) {
        flashMsg("That is not a real date"); return render();
      }
      if (typed > today()) { flashMsg("A round cannot have been played in the future"); return render(); }
      form.date = typed;
      calendarOpen = false; calendarMonth = null; calPick = null;
    }
    else if (what === "close") { calendarOpen = false; calendarMonth = null; calPick = null; }
    render();
    updateEnterHints();
    return;
  }

  const calMonth = e.target.closest("[data-cal-month]");
  if (calMonth) {
    calendarMonth = calMonth.dataset.calMonth;
    calPick = null;
    return render();
  }

  const calDay = e.target.closest("[data-cal-day]");
  if (calDay) {
    form.date = calDay.dataset.calDay;
    calendarOpen = false;
    calendarMonth = null;
    render();
    updateEnterHints();
    return;
  }

  /* A tapped dot writes into the readout without redrawing anything, so the
     chart does not flicker and the tap target stays under the finger. */
  const dot = e.target.closest("[data-round-detail]");
  if (dot) {
    const readout = document.getElementById("round-readout");
    if (readout) {
      readout.textContent = dot.dataset.roundDetail;
      readout.classList.add("showing");
    }
    return;
  }

  /* Every clickable attribute must be listed here or the tap never arrives.
   *
   * This hand-maintained list is a trap: data-set-index was added to a button
   * and given a handler, but omitted here, so the Index button did nothing at
   * all. The test below (test/handlers.test.mjs) now checks that every
   * data-* attribute used on a button in this file appears in this selector. */
  const t = e.target.closest(CLICKABLE);
  if (!t) return;
  const d = t.dataset;

  if (d.go) { tab = d.go; return render(); }
  if (d.tee) { form.teeId = d.tee; return render(); }
  if (d.dropRound) {
    busy("Removing from the game");
    try {
      await db.setGameRounds({ gameId: openGame, removeRoundIds: [d.dropRound] });
      flashMsg("Taken out of the game. The round itself is untouched.");
    } catch { flashMsg("Couldn't remove it — the message above says why."); }
    finally { idleAll(); }
    return render();
  }
  if (d.game) { openGame = d.game; return render(); }
  if (d.unfilter) { filter[d.unfilter] = ""; return render(); }
  if (d.golferIndex) { filter = { golferId: d.golferIndex, year: "", month: "", courseId: "" }; tab = "history"; return render(); }
  if (d.drill) {
    if (!drill.year) drill.year = d.drill;
    else if (!drill.month) drill.month = d.drill;
    else { filter = { golferId: d.drill, year: drill.year, month: drill.month, courseId: "" }; tab = "history"; }
    return render();
  }
  if (d.more) { moreOpen = moreOpen === d.more ? null : d.more; return render(); }
  if (d.reinvite) {
    const golfer = golferById(d.reinvite);
    if (!golfer) return;
    sheetEl.hidden = false;
    sheetEl.innerHTML = `<div class="sheet-body">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2>${esc(golfer.name)} has already joined</h2>
        <button class="rowbtn" data-close="1">Close</button></div>
      <p class="hint">Their invitation has been used, so the link will not work again.</p>
      <div class="note"><b>Locked out?</b> Somebody who joined without setting a password loses their
      access if they sign out — an account with no password cannot be signed back into. Letting them
      join again clears the old invitation so you can send a fresh link.</div>
      <p class="hint">Their rounds and handicap are untouched either way.</p>
      <div class="inline-actions stacked">
        <button class="btn" data-reset-invite="${esc(golfer.id)}">Let them join again</button>
      </div>
    </div>`;
    return;
  }
  if (d.inviteGolfer) {
    const golfer = golferById(d.inviteGolfer);
    if (!golfer) return;
    sheetEl.hidden = false;
    sheetEl.innerHTML = `<div class="sheet-body">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2>Invite ${esc(golfer.name)}</h2><button class="rowbtn" data-close="1">Close</button></div>
      <p class="hint">The link names them, so they tap it once and they are in — nothing to type, and no chance of a misspelled second record.</p>

      <label class="lbl">They join as</label>
      <label class="checkline">
        <input type="radio" name="invite-role" value="member" checked>
        <span><b>Guest</b> — posts their own rounds, sees results. No password.</span>
      </label>
      <label class="checkline">
        <input type="radio" name="invite-role" value="admin">
        <span><b>Admin</b> — also manages the roster and posts for anybody. Sets a password.</span>
      </label>
      <p class="hint">A guest link keeps working for that same person on another device. An admin link works once.</p>

      <div class="inline-actions stacked">
        <button class="btn" data-invite="send" data-golfer="${esc(golfer.id)}">Choose how to send it</button>
      </div>
    </div>`;
    return;
  }
  if (d.setIndex) { editingIndex = d.setIndex; return render(); }
  if (d.rename) { editingGolfer = d.rename; return render(); }
  if (d.course) { openCourse = openCourse === d.course ? null : d.course; return render(); }
  if (d.delGolfer) {
    db.removeFromRoster(d.delGolfer);
    flashMsg("Taken off this group's roster. Their rounds and handicap are untouched.");
    return render();
  }
  if (d.rmTee) { courseDraft.tees.splice(+d.rmTee, 1); return render(); }
  if (d.role) {
    const [memberUid, role] = d.role.split(":");
    db.setMemberRole(memberUid, role);
    flashMsg("Role updated");
    return;
  }
  if (d.edit) {
    const r = rounds.find((x) => x.id === d.edit);
    editingRound = r.id;
    form = { date: r.date, golferId: r.golferId, courseId: r.courseId, teeId: r.teeId,
      gross: String(r.gross), adjusted: r.adjusted === r.gross ? "" : String(r.adjusted),
      notes: r.notes || "", gameId: r.gameId || "" };
    tab = "enter"; return render();
  }
  if (d.del) { confirmId = d.del; return render(); }
  if (d.confirmDel) {
    const r = rounds.find((x) => x.id === d.confirmDel);
    confirmId = null;
    busy("Deleting the round");
    try {
      if (r) await db.deleteRoundAndRebuild(r);
      else db.deleteRound(d.confirmDel);
      flashMsg("Round deleted");
    } catch { flashMsg("Couldn't delete it — the message above says why."); }
    finally { idle(); }
    return render();
  }
  if (d.pick) {
    const c = finder.results[+d.pick];
    courseDraft.name = c.name;
    courseDraft.tees = c.tees.map((t2) => ({ id: model.newId(), name: t2.name, rating: String(t2.rating), slope: String(t2.slope), par: String(t2.par) }));
    finder = { q: "", results: [], busy: false, msg: `Filled in ${c.tees.length} tee${c.tees.length === 1 ? "" : "s"} — check them against the scorecard.` };
    return render();
  }

  switch (d.act) {
    case "recover": tab = "enter"; openGame = null; return render();
    case "dismiss-alert": return;
    case "cancel-del": confirmId = null; return render();
    case "cancel-round-edit": editingRound = null; form = { ...form, gross: "", adjusted: "", notes: "" }; return render();
    case "clear-filters": filter = { golferId: "", year: "", month: "", courseId: "" }; return render();
    case "drill-back": drill.month ? (drill.month = null) : (drill.year = null); return render();
    case "view-scope": filter = { golferId: "", year: drill.year || "", month: drill.month || "", courseId: "" }; tab = "history"; return render();
    case "enter-steps": setEnterStyle("steps"); return render();
    case "enter-full": setEnterStyle("full"); return render();
    case "step-next": stepIndex = Math.min(2, stepIndex + 1); return render();
    case "step-back": stepIndex = Math.max(0, stepIndex - 1); return render();
    case "step-date": stepDateOpen = !stepDateOpen; return render();
    case "step-date-done": stepDateOpen = false; return render();
    case "open-calendar":
      calendarOpen = !calendarOpen;
      calendarMonth = calendarOpen ? form.date.slice(0, 7) : null;
      return render();
    case "date-today": {
      /* Writes the value straight into the field as well as into state. Setting
         only the state left the picker showing the old date, which is why this
         appeared to do nothing. */
      form.date = today();
      const field = view.querySelector("#round-date");
      if (field) field.value = form.date;
      updateEnterHints();
      return render();
    }
    case "post":
      /* Close the picker first, so the panel is free to redraw — otherwise a
         posted round appears not to have gone anywhere. */
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return postRound();

    case "begin": return begin();
    case "sign-in": return signIn();
    case "set-admin-password": {
      const email = ((view.querySelector('[name="promote-email"]') || {}).value || "").trim();
      const password = (view.querySelector('[name="promote-password"]') || {}).value || "";
      if (!email) { flashMsg("Type your email address"); return render(); }
      if (password.length < 6) { flashMsg("The password needs at least six characters"); return render(); }

      busy("Setting your password");
      try {
        await db.signInWithEmail({ email, password });
        flashMsg(`Done. Sign in with ${email} and this password on your other devices.`);
      } catch (err) {
        idleAll();
        openSignInProblem(err, email);
        return render();
      } finally { idleAll(); }
      return render();
    }
    case "set-password": {
      const field = view.querySelector('[name="password"]');
      const secret = field ? field.value : "";
      if ((secret || "").length < 6) { flashMsg("The password needs at least six characters"); return; }
      joining = true;
      busy("Setting the password");
      render();
      try {
        const result = await db.signInWithEmail({ email: db.currentEmail(), password: secret });
        joining = false;
        await settleGroup(db.currentAssociation());
        tab = "enter";
        flashMsg(`Password set on ${db.currentEmail()}. Use that email and this password on your other devices.`);
      } catch (err) {
        joining = false;
        const code = String((err && (err.code || err.message)) || "");
        const stale = code.includes("requires-recent-login");
        openProblem({
          title: stale ? "Google needs to confirm you again" : "The password could not be set",
          detail: stale
            ? "Firebase will not attach a password to an account that signed in days ago."
            : code || "No detail was given.",
          advice: stale
            ? "Tap Sign in with Google just above this panel, pick your account, then set the password straight away."
            : "Try again. If it keeps failing, email this to support.",
        });
      } finally { idle(); }
      return render();
    }
    case "reset-password": {
      const address = ((view.querySelector('[name="email"]') || {}).value || authForm.email).trim();
      if (!address) { flashMsg("Type your email address first"); return; }
      busy("Sending the reset link");
      try { await db.sendPasswordReset(address); flashMsg(`Reset link sent to ${address}. Open it, choose a new password, then sign in with it.`); }
      catch { flashMsg("Couldn't send the reset link. Check the email address."); }
      finally { idleAll(); }
      return render();
    }
    case "accept-invite": return acceptInvite();
    case "not-me": {
      /* Fall back to typing a name, rather than joining as the wrong person. */
      invitedGolfer = null;
      flashMsg("Type the name you play under instead.");
      return render();
    }
    case "accept-named": {
      const link = db.readJoinLink();
      if (!link || !link.golferId) return;
      joining = true;
      busy("Joining the group");
      render();
      try {
        /* The role comes from the link. Somebody who has not joined yet cannot
           read the group document, so asking it is pointless — the rules verify
           the code against the group when the membership is written. */
        const role = link.role || "member";
        const result = await db.acceptNamedInvite({
          associationId: link.associationId, code: link.code,
          golferId: link.golferId, role,
        });
        joining = false;
        if (!result.ok) {
          idleAll();
          openProblem({
            title: result.reason === "USED"
              ? "This invitation has already been used"
              : "This invitation belongs to somebody else",
            detail: result.reason === "USED"
              ? "An admin invitation works once only. Ask for a fresh one."
              : "Somebody has already joined with this link. Ask whoever runs the group to send you your own.",
            advice: "Nothing was changed.",
          });
          return render();
        }
        db.clearJoinLink();
        await start(link.associationId);
        tab = "enter";
        idleAll();
        if (role === "admin") {
          /* Said properly rather than as a passing message. An admin without an
             account can manage everything, but only from this browser — they
             need to understand that before they walk away from it. */
          /* The password step happens HERE, as part of joining — not as a
             pointer to somewhere they have to go and find. An admin who walks
             away without one is locked out the moment this browser forgets
             them, and their invitation is already spent. */
          tab = "manage";
        }
        finishJoining();
      } catch (err) {
        joining = false;
        idleAll();
        /* Say what actually went wrong. Swallowing it left the screen exactly
           as it was, which reads as the button doing nothing at all. */
        const code = String((err && (err.code || err.message)) || "");
        openProblem({
          title: "Could not join the group",
          detail: code.includes("permission")
            ? "Firebase refused the write, usually because the rules in the console are older than this version."
            : code || "No detail was given.",
          advice: code.includes("permission")
            ? "Ask whoever runs the group to publish the latest firestore.rules, then tap the link again. Nothing was changed."
            : "Nothing was changed. Try the link again, or send this report.",
        });
      }
      return render();
    }
    case "join-by-code": return joinByCode();
    case "skip-import": skipImport = true; return render();
    /* Named apart from the Admin tab's "show-code" on purpose: both lived in
       this one switch, so the first case matched and the Show the code button
       silently did nothing at all. */
    case "enter-code": showCodeEntry = true; return render();
    case "hide-code": showCodeEntry = false; return render();
    case "create-group": return createGroup();
    case "import-v1": return importV1();

    case "save-index": {
      const field = view.querySelector('[name="manual-index"]');
      const value = field ? field.value.trim() : "";
      const id = editingIndex;
      editingIndex = null;
      if (!value) { flashMsg("Type an index, or tap Clear it"); return render(); }
      const clean = model.clampIndex(value);
      if (clean == null) { flashMsg("That does not look like a handicap index"); return render(); }
      db.setManualIndex(id, clean);
      flashMsg(`Starting index set to ${clean.toFixed(1)}. Real rounds will take over after three.`);
      return render();
    }
    case "clear-index": {
      const id = editingIndex;
      editingIndex = null;
      db.setManualIndex(id, null);
      flashMsg("Starting index cleared.");
      return render();
    }
    case "cancel-index": editingIndex = null; return render();
    case "add-golfer": return addGolfer();
    case "from-other-groups": return openOtherGroupPicker();
    case "save-new-group": {
      const field = view.querySelector('[name="new-group-name"]');
      const name = (field ? field.value : "").trim();
      if (!name) { flashMsg("Give the group a name"); return; }
      newGroupDraft = false;
      busy(`Creating ${name}`);
      try {
        const me = members.find((m) => m.uid === db.status().uid);
        const box = view.querySelector('[name="new-owner-plays"]');
        const created = await db.createAnotherGroup({
          name, displayName: me ? me.displayName : "Me",
          addToRoster: box ? box.checked : true,
        });
        await start(created.id);
        flashMsg(`${name} created. You are its owner.`);
      } catch { flashMsg("Couldn't create it — the message above says why."); }
      finally { idleAll(); }
      render();
      return;
    }
    case "cancel-new-group": newGroupDraft = false; return render();
    case "save-rename": return saveRename();
    case "cancel-rename": editingGolfer = null; return render();

    case "new-course":
      courseDraft = { id: model.newId(), name: "", tees: [{ id: model.newId(), name: "", rating: "", slope: "", par: "72" }] };
      finder = { q: "", results: [], busy: false, msg: "" };
      openCourse = null;
      return render();
    case "add-tee": courseDraft.tees.push({ id: model.newId(), name: "", rating: "", slope: "", par: "72" }); return render();
    case "cancel-course": courseDraft = null; finder = { q: "", results: [], busy: false, msg: "" }; return render();
    case "save-course": return saveCourse();
    case "find": return runFinder();

    case "new-game": gameDraft = { date: today(), endDate: "", courseId: "", name: "", multiDay: false }; return render();
    case "make-multiday": gameDraft.multiDay = true; return render();
    case "cancel-game": gameDraft = null; return render();
    case "save-game": return saveGame();
    case "close-game": openGame = null; editingGame = false; return render();
    case "edit-game": editingGame = !editingGame; return render();
    case "recalc-game": {
      busy("Working out the handicaps");
      let preview;
      try {
        preview = await db.recalculateGameHandicaps(openGame, { preview: true });
      } catch {
        idleAll();
        flashMsg("Couldn't read the rounds — the message above says why.");
        return render();
      }
      idleAll();

      if (!preview.changes.length) {
        flashMsg("Nothing to change — every round already has the right handicap.");
        return render();
      }

      /* Shown before anything is written, the same as every other correction. */
      sheetEl.hidden = false;
      sheetEl.innerHTML = `<div class="sheet-body">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2>Recalculate ${preview.changes.length} round${preview.changes.length === 1 ? "" : "s"}</h2>
          <button class="rowbtn" data-close="1">Close</button></div>
        <p class="hint">These are the changes. Nothing is written until you confirm.</p>
        <div class="card list">
          ${preview.changes.map((c) => `<div class="list-row">
            <span class="grow"><span class="name">${esc(c.name)}</span><br>
              <span class="sub">${esc(c.date || "")} · ${c.was == null ? "no handicap" : c.was} → ${c.now} (index ${c.index.toFixed(1)})</span></span>
          </div>`).join("")}
        </div>
        <div class="inline-actions stacked">
          <button class="btn" data-recalc="go">Apply these changes</button>
        </div>
      </div>`;
      return;
    }
    case "save-game-edit": {
      const name = (view.querySelector('[name="edit-game-name"]') || {}).value || "";
      const date = (view.querySelector('[name="edit-game-date"]') || {}).value || "";
      const end = (view.querySelector('[name="edit-game-end"]') || {}).value || "";
      const courseId = (view.querySelector('[name="edit-game-course"]') || {}).value || "";
      if (!date) { flashMsg("A game needs a first day"); return; }
      if (end && end < date) { flashMsg("The last day cannot come before the first"); return; }

      busy("Saving the game");
      try {
        await db.updateGameDetails(openGame, {
          name: name.trim(), date, endDate: end || null, courseId,
        });
        editingGame = false;
        flashMsg("Saved.");
      } catch { flashMsg("Couldn't save it — the message above says why."); }
      finally { idleAll(); }
      return render();
    }
    case "add-to-game": {
      const ids = [...view.querySelectorAll('[name="add-round"]:checked')].map((b) => b.value);
      if (!ids.length) { flashMsg("Nothing ticked"); return; }
      busy("Adding to the game");
      try {
        await db.setGameRounds({ gameId: openGame, addRoundIds: ids });
        flashMsg(`${ids.length} round${ids.length === 1 ? "" : "s"} added to the game.`);
      } catch { flashMsg("Couldn't add them — the message above says why."); }
      finally { idleAll(); }
      return render();
    }
    case "delete-game": db.deleteGame(openGame); openGame = null; flashMsg("Game deleted"); return render();
    case "share-game": {
      const board = model.gameLeaderboard(rounds.filter((r) => r.gameId === openGame), allGolfers);
      const everyoneHasNet = board.length > 0 && board.every((r) => r.net != null);
      shareGameNet = everyoneHasNet;
      shareGameGross = true;
      return openGameShare(everyoneHasNet);
    }
    case "share-ranking": return openShare(rankingShareText(), "Rankings");
    case "share-indexes": return openShare(indexShareText(), "Handicap indexes");

    case "share-invite": return openShare(
      `Join our golf scorecard:\n${db.joinLink(association)}\n\nOne tap, enter your name, done.`, "Invitation");
    case "tidy-signins": {
      /* Removes only SUPERSEDED memberships — never the newest for any person,
         never the owner, never your own. A membership is just a sign-in record;
         rounds belong to the golfer, so nothing is lost. */
      const byPerson = new Map();
      for (const m of members) {
        const key = m.golferId || `name:${String(m.displayName || "").trim().toLowerCase()}`;
        if (!byPerson.has(key)) byPerson.set(key, []);
        byPerson.get(key).push(m);
      }
      const spare = [];
      for (const list of byPerson.values()) {
        if (list.length < 2) continue;
        const sorted = [...list].sort((a, b) => {
          if (a.role === "owner") return -1;
          if (b.role === "owner") return 1;
          const at = (m) => (m.joinedAt && m.joinedAt.seconds) || m.joinedAt || 0;
          return at(b) - at(a);
        });
        sorted.slice(1).filter((m) => m.role !== "owner").forEach((m) => spare.push(m));
      }
      if (!spare.length) { flashMsg("Nothing to tidy."); return render(); }

      busy(`Removing ${spare.length} older sign-in${spare.length === 1 ? "" : "s"}`);
      try {
        await db.removeMemberships(spare.map((m) => m.uid));
        flashMsg(`${spare.length} older sign-in${spare.length === 1 ? "" : "s"} removed. Everybody's rounds are untouched.`);
      } catch { flashMsg("Couldn't remove them — the message above says why."); }
      finally { idleAll(); }
      return render();
    }

    case "invite-nonplayer": {
      /* The role and nothing else — no golfer, no roster place. For a club
         secretary or scorer who runs the group without playing in it. */
      busy("Preparing the invitation");
      try {
        await db.ensureAdminCode();
        const link = db.inviteLink("admin");
        if (!link) {
          idleAll();
          return openProblem({
            title: "The invitation link could not be built",
            detail: "The group's details have not finished loading yet.",
            advice: "Wait a moment and try again.",
          });
        }
        const guide = `${location.origin}${location.pathname}quick-start.html`;
        openShare([
          `${association ? association.name : "Our golf group"} — you are invited to help run the group.`,
          "", `Join here: ${link}`, "", `How it works, in one page: ${guide}`, "",
          "This makes you an admin: you can add courses, manage the roster and post rounds for anybody. You are not added as a player, so no handicap is kept for you.",
          "You will be asked to set a password as you join. The link works once, so keep it to yourself.",
        ].join("\n"), "Admin invitation");
      } catch { flashMsg("Couldn't prepare it — the message above says why."); }
      finally { idleAll(); }
      return render();
    }

    case "show-code": {
      if (!association) return;
      sheetEl.hidden = false;
      sheetEl.innerHTML = `<div class="sheet-body">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2>Group code</h2><button class="rowbtn" data-close="1">Close</button></div>
        <p class="hint">For somebody who cannot receive a link. Read it out — it is six characters.</p>
        <div class="codebox">${esc(association.joinCode)}</div>
        <p class="hint">The invitation link is easier and carries this code inside it.</p>
      </div>`;
      return;
    }

    case "sign-out": {
      /* Confirmed in the button itself rather than by a message underneath it.
         A small line of text is easy to miss, so the first tap looked like
         nothing happening and the second like a button that needed hitting
         twice. Now the button says what the next tap will do. */
      /* An account with no password cannot be signed back into — signing out
         destroys it. Somebody who joined by invitation and has not set a
         password would be locked out entirely, and their invitation is spent.
         That deserves more than a confirmation. */
      if (!db.hasPassword()) {
        confirmSignOut = false;
        return openNotice({
          title: "Set a password first",
          detail: "This device has no account yet, so there is nothing to sign back in with. Signing out now would lock you out, and an invitation link only works once.",
          advice: "Set an email and password above, then sign out whenever you like.",
        });
      }

      if (!confirmSignOut) {
        confirmSignOut = true;
        setTimeout(() => {
          if (confirmSignOut) { confirmSignOut = false; render(); }
        }, 6000);
        return render();
      }
      confirmSignOut = false;

      /* render() FIRST, then busy(). Drawing the screen re-reads the waiting
         card's state, so raising it beforehand was immediately undone — which
         is why no spinner appeared. */
      render();
      busy("Signing out");
      try { await db.signOutEverywhere(); }
      catch {
        idleAll();
        flashMsg("Couldn't sign out. Try again.");
        return render();
      }
      /* No idle() on success: signOutEverywhere reloads the page, and the card
         should stay up until it does. */
      return;
    }
    case "delete-group": confirmDeleteGroup = true; return render();
    case "cancel-delete-group": confirmDeleteGroup = false; return render();
    case "really-delete-group": {
      confirmDeleteGroup = false;
      busy("Deleting the group");
      render();
      try {
        await db.deleteGroup();
        /* Start again from a clean slate rather than trying to unpick what is
           left in memory. Deleting a group leaves listeners pointing at
           collections that no longer exist, which is why the roster vanished
           from the screen afterwards and only came back after signing out. A
           reload is instant and cannot be half-right. */
        idle();
        flashMsg("Group deleted. Reloading…");
        setTimeout(() => location.reload(), 900);
        return;
      } catch {
        idle();
        flashMsg("Couldn't delete it — the message above says why.");
        return render();
      }
    }
    case "import-here": return importHere();
    case "rename-group": {
      const field = view.querySelector('[name="assoc-name"]');
      const name = (field ? field.value : "").trim();
      if (!name) { flashMsg("Give the group a name"); return; }
      db.updateAssociation({ name });
      flashMsg(`Renamed to ${name}.`);
      return render();
    }
    case "backup": return openBackupSheet();
    case "restore": return askForBackupFile();
    case "paste-restore": return openPasteRestore();
    case "edit-key": editingKey = true; return render();
    case "cancel-key": editingKey = false; return render();
    case "save-key": {
      const field = view.querySelector('[name="lookupkey"]');
      const key = (field ? field.value : "").trim();
      if (!key) { flashMsg("Paste the key first"); return; }
      db.updateAssociation({ lookupKey: key });
      lookup.setSharedKey(key);
      editingKey = false;
      flashMsg("Saved. Everybody in the group can search for courses now.");
      return render();
    }
    case "google":
      try { await db.signInWithGoogle(); flashMsg("Signed in"); }
      catch { flashMsg("Sign-in didn't complete."); }
      return render();
  }
});

sheetEl.addEventListener("click", async (e) => {
  /* Actions are checked BEFORE the close guard.
   *
   * The guard used to run first, and any button sitting inside markup that also
   * carried a close marker was read as "close the dialog" — which is why "Let
   * them join again" did nothing at all. An action button is never a close
   * button, so it must be allowed through. */
  const ACTIONS = "[data-pw],[data-reset-invite],[data-recalc],[data-invite],[data-pick],[data-paste],[data-problem],[data-send],[data-quick],[data-share-toggle]";
  if (!e.target.closest(ACTIONS)
      && (e.target === sheetEl || e.target.closest("[data-close]"))) {
    sheetEl.hidden = true;
    return;
  }

  /* Forget removes a group from THIS account's list and this device, without
     touching the group itself. It is the one action that cannot fail: it does
     not read anything, does not need permission from a group you may no longer
     belong to, and does not depend on the group still existing. That is why it
     is here — a stale entry kept coming back after every sign-in, and nothing
     that tried to be clever about it ever worked. */
  const savingPassword = e.target.closest("[data-pw]");
  if (savingPassword) {
    if (savingPassword.dataset.pw === "later") {
      /* Allowed, but never silently — somebody who skips this can be locked
         out, and they should hear that once, plainly, before it happens. */
      sheetEl.hidden = true;
      openNotice({
        title: "You can set it later",
        detail: "Until you do, your admin role lives only in this browser. If it forgets you, or you sign out, you will need a fresh invitation from whoever runs the group.",
        advice: "Tap the status button at the top right whenever you want to set it.",
      });
      return;
    }
    const email = ((sheetEl.querySelector('[name="pw-email"]') || {}).value || "").trim();
    const secret = (sheetEl.querySelector('[name="pw-secret"]') || {}).value || "";
    if (!email) { flashMsg("Type your email address"); return; }
    if (secret.length < 6) { flashMsg("The password needs at least six characters"); return; }

    sheetEl.hidden = true;
    busy("Saving your password");
    try {
      await db.setMyPassword({ email, password: secret });
      openNotice({
        title: "Password saved",
        detail: `Sign in with ${email} and this password on any device, and your role and groups come with you.`,
      });
    } catch (err) {
      idleAll();
      openSignInProblem(err, email);
    } finally { idleAll(); }
    render();
    return;
  }

  const reopening = e.target.closest("[data-reset-invite]");
  if (reopening) {
    const id = reopening.dataset.resetInvite;
    const golfer = golferById(id);
    sheetEl.hidden = true;
    busy("Clearing the old invitation");
    try {
      await db.resetInvitation(id);
      flashMsg(`${(golfer || {}).name || "They"} can be invited again. Send them a fresh link.`);
    } catch { flashMsg("Couldn't clear it — the message above says why."); }
    finally { idleAll(); }
    render();
    return;
  }

  const recalc = e.target.closest("[data-recalc]");
  if (recalc) {
    sheetEl.hidden = true;
    busy("Re-freezing the handicaps");
    try {
      const result = await db.recalculateGameHandicaps(openGame);
      flashMsg(`${result.applied} round${result.applied === 1 ? "" : "s"} updated. The net scores are right now.`);
    } catch { flashMsg("Couldn't apply them — the message above says why."); }
    finally { idleAll(); }
    render();
    return;
  }

  const inviting = e.target.closest("[data-invite]");
  if (inviting) {
    const chosen = sheetEl.querySelector('[name="invite-role"]:checked');
    const role = chosen ? chosen.value : "member";
    const golferId = inviting.dataset.golfer || null;
    const named = golferId ? golferById(golferId) : null;
    sheetEl.hidden = true;
    busy("Preparing the invitation");
    try {
      if (role === "admin") await db.ensureAdminCode();
      const link = db.inviteLink(role, golferId);
      if (golferId) db.noteInvitation(golferId, role);
      if (!link) {
        /* This used to flashMsg and return without redrawing, so the button
           looked completely dead. Say it properly instead. */
        idleAll();
        openProblem({
          title: "The invitation link could not be built",
          detail: "The group's details have not finished loading yet.",
          advice: "Wait a moment and try again. If it keeps happening, close the app and reopen it.",
        });
        return;
      }

      const guide = `${location.origin}${location.pathname}quick-start.html`;
      const text = [
        named
          ? `${named.name} — you are invited to keep your handicap with ${association ? association.name : "our golf group"}.`
          : `${association ? association.name : "Our golf group"} — you are invited to keep your handicap with us.`,
        "",
        `Join here: ${link}`,
        "",
        `How it works, in one page: ${guide}`,
        "",
        named
          ? "Tap the link and it will greet you by name. One button and you are in — nothing to type."
          : "Tap the link, type the name you play under, and you are in. No account, no password.",
        role === "admin"
          ? "This makes you an admin, so you will be asked to set a password. It works once, so keep it to yourself."
          : "No account and no password needed.",
      ].join("\n");

      openShare(text, role === "admin" ? "Admin invitation" : "Invitation");
    } catch {
      flashMsg("Couldn't prepare it — the message above says why.");
    } finally { idleAll(); }
    return;
  }

  const picking = e.target.closest("[data-pick]");
  if (picking) {
    if (picking.dataset.pick === "all") {
      sheetEl.querySelectorAll('[name="pick-golfer"]').forEach((b) => { b.checked = true; });
      return;
    }
    const ids = [...sheetEl.querySelectorAll('[name="pick-golfer"]:checked')].map((b) => b.value);
    if (!ids.length) { flashMsg("Nobody ticked"); return; }
    sheetEl.hidden = true;
    busy("Adding them to this group");
    try {
      const result = await db.addExistingToRoster(ids);
      flashMsg(`${result.added} golfer${result.added === 1 ? "" : "s"} added, with their rounds and handicaps.`);
    } catch { flashMsg("Couldn't add them — the message above says why."); }
    finally { idleAll(); }
    render();
    return;
  }

  const pasting = e.target.closest("[data-paste]");
  if (pasting) {
    const field = sheetEl.querySelector('[name="pasted-backup"]');
    const text = (field ? field.value : "").trim();
    const check = document.getElementById("paste-check");

    if (!text) { if (check) check.textContent = "Nothing pasted yet."; return; }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (check) check.textContent = "That does not look like a backup. It should start with a curly brace and end with one. Make sure the whole thing was copied.";
      return;
    }

    const found = {
      golfers: Array.isArray(parsed.golfers) ? parsed.golfers : [],
      courses: Array.isArray(parsed.courses) ? parsed.courses : [],
      rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [],
    };

    if (!found.rounds.length && !found.golfers.length) {
      if (check) check.textContent = "That backup has no golfers or rounds in it.";
      return;
    }

    /* Shown before anything is written, so a wrong file is caught here. */
    if (pasting.dataset.armed !== "1") {
      pasting.dataset.armed = "1";
      pasting.textContent = `Restore ${found.rounds.length} round${found.rounds.length === 1 ? "" : "s"} — tap again`;
      if (check) {
        check.textContent = `Found ${found.golfers.length} golfer${found.golfers.length === 1 ? "" : "s"}, ${found.courses.length} course${found.courses.length === 1 ? "" : "s"} and ${found.rounds.length} round${found.rounds.length === 1 ? "" : "s"}${parsed.savedAt ? `, saved ${String(parsed.savedAt).slice(0, 16).replace("T", " at ")}` : ""}.`;
      }
      return;
    }

    pasting.disabled = true;
    pasting.textContent = "Restoring…";
    sheetEl.hidden = true;
    busy("Restoring your backup");
    try {
      const result = await db.restoreBackup(found);
      flashMsg(`Restored ${found.rounds.length} round${found.rounds.length === 1 ? "" : "s"} and ${found.golfers.length} golfer${found.golfers.length === 1 ? "" : "s"}. Run the tidy page next so the handicaps are recalculated.`);
    } catch (err) {
      openProblem({
        title: "The restore did not go through",
        detail: String((err && (err.code || err.message)) || err),
        advice: "Nothing was written — it is all or nothing, so there is no half-restored state. Your backup text is untouched.",
      });
    } finally {
      idleAll();
      render();
    }
    return;
  }

  const forgetting = e.target.closest("[data-forget-group]");
  if (forgetting) {
    const id = forgetting.dataset.forgetGroup;
    const name = forgetting.dataset.forgetName;

    /* Three deliberate taps, each saying something different, and the button
       lives behind a closed drawer well away from the group you tap to switch.
       Nothing here deletes data — but it is still the sort of thing nobody
       should be able to do by brushing the screen. */
    const step = forgetting.dataset.armed || "0";
    if (step === "0") {
      forgetting.dataset.armed = "1";
      forgetting.textContent = `Remove ${name}?`;
      return;
    }
    if (step === "1") {
      forgetting.dataset.armed = "2";
      forgetting.textContent = "Tap once more to confirm";
      setTimeout(() => {
        if (forgetting.dataset.armed === "2") {
          forgetting.dataset.armed = "0";
          forgetting.textContent = "Remove from my list";
        }
      }, 6000);
      return;
    }
    forgetting.disabled = true;
    forgetting.textContent = "Forgetting…";
    await db.forgetGroupEverywhere(id);
    sheetEl.hidden = true;
    flashMsg(`${name} removed from your list. Nothing in it was deleted.`);
    render();
    return;
  }

  const quick = e.target.closest("[data-quick]");
  if (quick) {
    const what = quick.dataset.quick;
    if (what === "backup") { sheetEl.hidden = true; return openBackupSheet(); }
    if (what === "setpassword") {
      /* Opened right here rather than sending them to a tab.
       *
       * Pointing at a tab failed twice: Admin turns non-owners away, and the
       * form only appeared when the app judged it was needed. Somebody asking
       * for it should simply get it. */
      openPasswordSheet();
      return;
    }

    if (what === "signout") {
      if (!db.hasPassword()) {
        sheetEl.hidden = true;
        return openNotice({
          title: "Set a password first",
          detail: "This device has no account yet, so there is nothing to sign back in with. Signing out now would lock you out, and an invitation link only works once.",
          advice: db.canManage()
            ? "The form is on the Manage tab. Set a password, then sign out whenever you like."
            : "Ask whoever runs the group for a fresh link if you have already signed out.",
        });
      }
      sheetEl.hidden = true;
      /* Say what is actually happening. The page reloads on sign-out, and the
         boot screen used to announce "Opening your scorecard" — the opposite of
         what somebody just asked for. */
      bootMessage = "Signing out…";
      ready = false;
      /* render() before busy(), for the reason given in the sign-out case:
         drawing the screen re-reads the waiting card's state and would undo it. */
      render();
      busy("Signing out");
      try { await db.signOutEverywhere(); }
      catch { idleAll(); flashMsg("Couldn't sign out. Try again."); render(); }
      return;   /* signOutEverywhere reloads the page, taking the card with it */
    }
    return;
  }

  const toggling = e.target.closest("[data-share-toggle]");
  if (toggling) {
    /* Redraw the preview in place so the effect of each choice is visible
       before anything is sent. */
    if (toggling.dataset.shareToggle === "gross") shareGameGross = toggling.checked;
    else shareGameNet = toggling.checked;

    if (!shareGameNet && !shareGameGross) {
      /* Both off leaves nothing to send, so the last one turned off comes back. */
      if (toggling.dataset.shareToggle === "gross") shareGameGross = true;
      else shareGameNet = true;
      flashMsg("A result needs at least one of net or gross.");
    }

    const board = model.gameLeaderboard(rounds.filter((r) => r.gameId === openGame), allGolfers);
    openGameShare(board.length > 0 && board.every((r) => r.net != null));
    return;
  }

  const resetting = e.target.closest("[data-reset-password]");
  if (resetting) {
    const address = resetting.dataset.resetPassword;
    resetting.disabled = true;
    resetting.textContent = "Sending…";
    try {
      await db.sendPasswordReset(address);
      sheetEl.hidden = true;
      flashMsg(`Reset link sent to ${address}. Open it, choose a new password, then sign in with it.`);
    } catch {
      resetting.disabled = false;
      resetting.textContent = "Reset my password";
      flashMsg("Couldn't send the reset link. Check the email address.");
    }
    return;
  }

  const goto = e.target.closest("[data-goto-group]");
  if (goto) {
    sheetEl.hidden = true;
    const id = goto.dataset.gotoGroup;
    if (id === db.currentAssociation()) return;
    switching = true;
    busy("Switching group");
    render();
    const member = await db.loadMembership(id);
    switching = false;
    idleAll();
    if (member) { await start(id); flashMsg("Switched"); }
    else {
      /* Not a member any more — usually a group that was deleted. Take it off
         the list rather than leaving it there to be tapped again. */
      db.forgetGroup(id);
      flashMsg("That group is gone, so it has been taken off your list.");
      render();
    }
    return;
  }

  if (e.target.closest('[data-act="new-group"]')) {
    /* Drawn in the sheet itself. It used to set a flag that only screenManage
       knew how to draw, so tapping this from any other tab did nothing at all. */
    sheetEl.innerHTML = `<div class="sheet-body">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2>Start another group</h2><button class="rowbtn" data-close="1">Close</button></div>
      <p class="hint">A separate set of rounds and games. Golfers in both groups keep one handicap across them.</p>
      <label class="lbl">Group name</label>
      <input class="field" name="new-group-name" placeholder="September Tournament" autocomplete="off">
      <label class="checkline">
        <input type="checkbox" name="new-owner-plays" checked>
        <span>Add me to this group's roster too</span>
      </label>
      <div class="inline-actions stacked">
        <button class="btn" data-newgroup="create">Create it</button>
        <button class="btn ghost" data-close="1">Cancel</button>
      </div>
    </div>`;
    return;
  }

  if (e.target.closest("[data-newgroup]")) {
    const field = sheetEl.querySelector('[name="new-group-name"]');
    const name = (field ? field.value : "").trim();
    if (!name) { flashMsg("Give the group a name"); return; }
    const box = sheetEl.querySelector('[name="new-owner-plays"]');
    const playing = box ? box.checked : true;
    sheetEl.hidden = true;
    busy("Creating the group");
    try {
      const me = members.find((m) => m.uid === db.status().uid);
      const created = await db.createAnotherGroup({
        name, displayName: me ? me.displayName : "Me", addToRoster: playing,
      });
      await start(created.id);
      flashMsg(`${name} created. You are its owner.`);
    } catch { flashMsg("Couldn't create it — the message above says why."); }
    finally { idle(); }
    render();
    return;
  }
  const send = e.target.closest("[data-send]");
  if (!send) return;
  const text = sheetEl.dataset.text || "";
  const how = send.dataset.send;
  /* Every one of these now says whether it worked.
   *
   * Copy and Save looked like dead buttons because they did their job silently
   * and, on iOS, often failed silently too — the clipboard is refused unless
   * the page has focus, and there was no fallback and no message either way. */
  if (how === "save") { saveBackup(); return; }
  if (how === "download") { downloadBackup(); return; }

  if (how === "whatsapp") {
    open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    return;
  }
  if (how === "email") {
    location.href = `mailto:?subject=${encodeURIComponent(sheetEl.dataset.title || "")}&body=${encodeURIComponent(text)}`;
    return;
  }
  if (how === "sms") {
    location.href = `sms:?&body=${encodeURIComponent(text)}`;
    return;
  }

  if (how === "copy") {
    send.disabled = true;
    const was = send.textContent;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("no clipboard");
      }
      send.textContent = "Copied";
      setTimeout(() => { send.textContent = was; send.disabled = false; }, 1600);
    } catch {
      /* Refused, which iOS does often. Select the text instead so a long press
         and Copy still works — better than a button that appears dead. */
      send.disabled = false;
      send.textContent = was;
      const box = sheetEl.querySelector(".msg, textarea");
      if (box) {
        try {
          if (box.select) { box.focus(); box.select(); }
          else {
            const range = document.createRange();
            range.selectNodeContents(box);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }
          flashMsg("Selected the text — press and hold it, then tap Copy.");
        } catch { flashMsg("Copying was refused. Select the text above and copy it by hand."); }
      }
    }
    return;
  }

  if (how === "native") {
    if (!navigator.share) { flashMsg("This device has no share sheet. Use one of the other buttons."); return; }
    try { await navigator.share({ text }); }
    catch (err) {
      /* Cancelling is not a failure and should say nothing. */
      if (err && err.name !== "AbortError") flashMsg("Sharing did not open. Try Email or WhatsApp.");
    }
    return;
  }
});

/* ================= actions ================= */

/* Joins or creates, whichever fits, then lands on Enter. */
async function begin() {
  const name = ((view.querySelector('[name="join-name"]') || {}).value || joinForm.name).trim();
  if (!name) { flashMsg("Type the name you play under"); return render(); }
  joinForm.name = name;
  const invite = db.readJoinLink();
  if (invite) return acceptInvite();

  const groupName = ((view.querySelector('[name="group-name"]') || {}).value || joinForm.groupName).trim();
  return createGroup(name, groupName || `${name}'s group`);
}

async function signIn() {
  const email = ((view.querySelector('[name="email"]') || {}).value || authForm.email).trim();
  const password = (view.querySelector('[name="password"]') || {}).value || "";
  if (!email) { flashMsg("Type your email address"); return; }
  if (password.length < 6) { flashMsg("The password needs at least six characters"); return; }
  authForm = { email, password: "" };
  joining = true;
  busy("Signing in");
  render();

  try {
    const result = await db.signInWithEmail({ email, password });
    joining = false;
    await settleGroup(db.currentAssociation());

    /* Land on Enter. Signing in used to leave people on whichever tab they
       happened to be on — usually Admin, which is not where anybody wants to
       start. */
    tab = "enter";

    flashMsg(
      result.outcome === "password-added"
        ? `Password set on ${result.email}. That is now your one account — use this email and password on every device.`
        : result.outcome === "created" ? "Account created. Use this email and password on your other devices."
        : `Signed in as ${email}.`);
  } catch (err) {
    joining = false;
    openSignInProblem(err, email);
  } finally {
    /* Always. A spinner that never stops is worse than no spinner at all. */
    idle();
    render();
  }
}

/* A failed sign-in has to say which of the several possible things went wrong,
   and offer the way out in the same breath. Sending somebody off to hunt for a
   Forgot the password link at the moment they are already stuck is no help. */
function openSignInProblem(error, email) {
  const code = String((error && (error.code || error.message)) || "").toLowerCase();

  let title = "Sign-in did not work";
  let detail = code || "No detail was given.";
  let offerReset = false;

  if (code.includes("wrong-password") || code.includes("invalid-credential") || code.includes("invalid-login")) {
    title = "That password was not right";
    detail = `The email ${email} exists, but the password does not match it.`;
    offerReset = true;
  } else if (code.includes("user-not-found")) {
    title = "No account for that email";
    detail = `Nothing is registered to ${email}. Check for a typo — or if this is a new address, an account will be made for you when the password is at least six characters.`;
  } else if (code.includes("invalid-email")) {
    title = "That email does not look right";
    detail = "Check it for a typo.";
  } else if (code.includes("too-many-requests")) {
    title = "Too many attempts";
    detail = "Firebase has paused sign-in for this device for a few minutes. Nothing is wrong with your account.";
    offerReset = true;
  } else if (code.includes("network") || code.includes("failed to fetch")) {
    title = "Could not reach Firebase";
    detail = "Check your connection and try again.";
  } else if (code.includes("weak-password")) {
    title = "Password too short";
    detail = "It needs at least six characters.";
  }

  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>Sign-in problem</h2><button class="rowbtn" data-close="1">Close</button></div>
    <div class="note"><b>${esc(title)}</b><br>${esc(detail)}</div>
    <div class="inline-actions stacked">
      <button class="btn ghost" data-close="1">Try again</button>
      ${offerReset ? `<button class="btn" data-reset-password="${esc(email)}">Reset my password</button>` : ""}
    </div>
    ${offerReset ? `<p class="hint">A link goes to ${esc(email)}. Open it and choose a new password for this app. The password for your email account itself is not affected.</p>` : ""}
  </div>`;
}

async function acceptInvite() {
  /* Every path that waits on Firebase raises the veil, without exception. */
  const invite = db.readJoinLink();
  const name = ((view.querySelector('[name="join-name"]') || {}).value || joinForm.name).trim();
  if (!name) { flashMsg("Type the name you play under"); return; }
  joining = true;
  busy("Joining the group");
  render();
  const result = await db.joinAssociation({ associationId: invite.associationId, code: invite.code, displayName: name });
  if (result.ok) {
    db.clearJoinLink();
    await db.linkGolferForMember(name);
    await start(invite.associationId);
    joining = false;
    idleAll();
    finishJoining();
    render();
  } else { joining = false; idleAll(); render(); }
}

/* Every route into a group ends here, so an admin is never left without the
   password step whichever way they arrived — by named link, by open link, or
   by typing a code. */
function finishJoining() {
  if (db.canManage() && !db.hasPassword()) {
    openPasswordSheet({
      heading: "One last step",
      because: `You are in as ${db.myRole() === "owner" ? "the owner" : "an admin"}. Setting a password now means your role follows you to any device — without one it lives only in this browser, and cannot be recovered if it is cleared.`,
      allowLater: true,
    });
    return;
  }
  flashMsg("You're in. Post your round on the Enter tab.");
}

async function joinByCode() {
  const name = ((view.querySelector('[name="join-name"]') || {}).value || joinForm.name).trim();
  const code = ((view.querySelector('[name="join-code"]') || {}).value || joinForm.code).trim();
  if (!name) { flashMsg("Type the name you play under"); return; }
  if (!code) { flashMsg("Type the group code"); return; }

  joining = true;
  busy("Checking the code");
  render();
  const assocId = await db.findAssociationByCode(code);
  if (!assocId) {
    joining = false;
    idleAll();
    flashMsg("No group has that code. Codes are six characters — check it, or ask for the invitation link instead.");
    return render();
  }
  const result = await db.joinAssociation({ associationId: assocId, code, displayName: name });
  if (result.ok) {
    await db.linkGolferForMember(name);
    await start(assocId);
    joining = false;
    idleAll();
    finishJoining();
    render();
  } else { joining = false; idleAll(); render(); }
}

async function createGroup(name, groupName) {
  const box = view.querySelector('[name="owner-plays"]');
  const playing = box ? box.checked : joinForm.ownerPlays;
  joining = true;
  busy("Setting up your group");
  render();
  try {
    const created = await db.createAssociation({ name: groupName, displayName: name });
    /* Only if they said they play. An organiser who does not play should not
       appear on the roster, and should certainly not get a handicap record
       created for them without being asked. */
    if (playing) await db.linkGolferForMember(name);
    await start(created.id);
    joining = false;
    idleAll();
    flashMsg(playing
      ? "Ready. Add the rest of your golfers under Manage, or invite them from Admin."
      : "Ready. Add your golfers under Manage — you are organising, not on the roster.");
  } catch {
    joining = false;
    idleAll();
    flashMsg("Couldn't set up the group — the message above says why.");
    render();
  }
}

async function importHere() {
  if (!legacy) return;
  importing = true;
  busy("Bringing your rounds across");
  render();
  try {
    const result = await db.importLegacyIntoCurrentGroup({ v1: legacy.v1 });
    importing = false;
    idleAll();
    const ok = result.check.rounds.ok && result.check.golfers.ok;
    flashMsg(ok
      ? `Brought across and checked: ${result.check.golfers.found} golfers, ${result.check.rounds.found} rounds. Your version 1 scorecard is untouched.`
      : `Brought across ${result.check.golfers.found} of ${result.check.golfers.expected} golfers. Nothing was lost — tap again to finish.`);
  } catch (e) {
    importing = false;
    idleAll();
    const code = String((e && (e.code || e.message)) || "");
    flashMsg(code.includes("permission")
      ? "Firebase refused it — the rules in the console are older than this version. Publish firestore.rules and try again."
      : `The import did not finish. ${code || "No detail was given."} Your version 1 data is untouched.`);
  }
  render();
}

/* Everyone on your other groups' rosters, with tick boxes.
 *
 * Typing a name again is what creates a second person with a split handicap.
 * This adds the SAME golfer, so their rounds and index come with them. */
async function openOtherGroupPicker() {
  busy("Looking through your other groups");
  let people = [];
  try { people = await db.golfersInMyOtherGroups(); }
  catch {
    idleAll();
    sheetEl.hidden = false;
    sheetEl.innerHTML = `<div class="sheet-body">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2>Could not look</h2><button class="rowbtn" data-close="1">Close</button></div>
      <p class="hint">Your other groups could not be read just now. Try again in a moment.</p>
    </div>`;
    return;
  }

  idleAll();
  sheetEl.hidden = false;

  if (!people.length) {
    sheetEl.innerHTML = `<div class="sheet-body">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2>Nobody to add</h2><button class="rowbtn" data-close="1">Close</button></div>
      <p class="hint">Everyone from your other groups is already on this roster, or you have no other groups yet.</p>
    </div>`;
    return;
  }

  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>Add from your other groups</h2><button class="rowbtn" data-close="1">Close</button></div>
    <p class="hint">The same person, not a copy — their rounds and handicap come with them.</p>
    <div class="card list">
      ${people.map((p) => `<label class="checkline" style="padding:0.6rem 0.8rem">
        <input type="checkbox" name="pick-golfer" value="${esc(p.id)}">
        <span><span class="name">${esc(p.name || "Unnamed")}</span><br>
          <span class="sub">${esc(p.groups.join(", "))}${p.handicapIndex != null ? ` · index ${Number(p.handicapIndex).toFixed(1)}` : " · no index yet"}</span></span>
      </label>`).join("")}
    </div>
    <div class="inline-actions stacked">
      <button class="btn" data-pick="all">Tick everybody</button>
      <button class="btn" data-pick="add">Add the ticked golfers</button>
    </div>
  </div>`;
}

async function addGolfer() {
  const input = view.querySelector('[name="new-golfer"]');
  const name = (input ? input.value : "").trim();
  if (!name) { flashMsg("Type a name first"); return; }
  /* The veil goes up FIRST — before any check — so every outcome looks the
     same and none of them can be tapped through. Returning early on a
     duplicate used to skip the veil entirely, so that case alone showed
     nothing at all and the message flashed past. */
  busy(`Adding ${name}`);

  const already = golfers.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (already) {
    idleAll();
    openNotice({
      title: `${already.name} is already on this roster`,
      detail: "Nothing was added. One person should appear once, or their rounds and handicap end up split between two records.",
      advice: "If you meant somebody different, give them a middle initial or surname so the two names are distinct.",
    });
    if (input) input.value = "";
    return render();
  }
  try {
    const { golfer, reused } = await db.addGolfer({ name });
    idleAll();
    if (reused) {
      /* Worth a proper message rather than a flash: it means the handicap and
         rounds came with them, which is exactly what somebody adding a name by
         hand is trying to avoid getting wrong. */
      openNotice({
        title: `${golfer.name} was already known`,
        detail: `They have been added to this roster as the same person, so their rounds and handicap${golfer.handicapIndex != null ? ` (index ${Number(golfer.handicapIndex).toFixed(1)})` : ""} come with them. No second record was created.`,
      });
    } else {
      flashMsg(`${golfer.name} added`);
    }
    if (input) input.value = "";
  } catch (e) {
    const code = String((e && (e.code || e.message)) || "");
    flashMsg(code.includes("already")
      ? `${name} already exists. Use "Add from my other groups" to bring them in with their rounds.`
      : "Couldn't add them — the message above says why.");
  } finally { idleAll(); }
  render();
}

async function saveRename() {
  const input = view.querySelector('[name="rename-golfer"]');
  const next = (input ? input.value : "").trim();
  if (!next) { flashMsg("Type a name first"); return; }
  const id = editingGolfer;
  note("renaming a golfer");
  editingGolfer = null;
  busy("Renaming");
  let result;
  try { result = await db.renameGolfer(id, next); }
  catch (e) {
    idle();
    openProblem({
      title: "The rename did not go through",
      detail: String((e && (e.code || e.message)) || e),
      advice: "Nothing was changed. Try again, and send this report if it keeps happening.",
    });
    return render();
  }
  idle();
  if (result.ok) flashMsg(`Renamed to ${next}. That is their name in every group.`);
  else if (result.reason === "TAKEN") flashMsg(`Another golfer is already called ${next}. Names have to be unique — try adding an initial.`);
  else flashMsg("Couldn't rename them.");
  render();
}

function saveCourse() {
  const c = { ...courseDraft, name: courseDraft.name.trim(),
    tees: courseDraft.tees.filter((t) => t.name.trim() && t.rating && t.slope && t.par) };
  if (!c.name || !c.tees.length) { flashMsg("A course needs a name and at least one complete tee"); return; }
  note(`adding course ${c.name}`);
  db.addCourse(c);
  courseDraft = null;
  finder = { q: "", results: [], busy: false, msg: "" };
  flashMsg(`${c.name} added`);
}

function saveGame() {
  if (!gameDraft.courseId) { flashMsg("Pick the course"); return; }
  note("creating a game");
  db.addGame({ date: gameDraft.date, courseId: gameDraft.courseId, name: gameDraft.name });
  gameDraft = null;
  flashMsg("Game created. Post rounds to it from the Enter tab.");
}

async function runFinder() {
  const q = ((view.querySelector('[name="finder-q"]') || {}).value || finder.q).trim();
  finder = { q, results: [], busy: true, msg: "Searching…" };
  render();
  try {
    const results = await lookup.searchWide(q);
    finder = { q, results, busy: false, msg: `${results.length} match${results.length === 1 ? "" : "es"} — tap one to fill in its tees` };
  } catch (err) {
    finder = { q, results: [], busy: false, msg: lookup.explain(err && err.message) };
  }
  render();
}

function postRound() {
  const golfer = golferById(form.golferId);
  const course = courseById(form.courseId);
  const tee = course.tees.find((t) => t.id === form.teeId);

  if (editingRound) {
    const ags = +(form.adjusted || form.gross);
    /* gameId is written every time, including as null — so a round can be taken
       out of a game as well as moved between them. */
    db.updateRound(editingRound, {
      date: form.date, gross: +form.gross, adjusted: ags,
      differential: model.differential(ags, tee.rating, tee.slope),
      notes: form.notes.trim(), gameId: form.gameId || null,
    });
    db.rebuildGolferIndex(golfer.id);
    editingRound = null;
    form = { ...form, gross: "", adjusted: "", notes: "" };
    flashMsg("Round updated");
    return;
  }

  note("posting a round");
  const { round } = db.postRound({
    golfer, course, tee, date: form.date,
    gross: form.gross, adjusted: form.adjusted, notes: form.notes,
    gameId: form.gameId || null,
  });
  /* Keep the date — several rounds from one outing are entered together — but
     clear the golfer, so the next one is never posted against the last person
     by accident. */
  form = { ...form, golferId: "", gross: "", adjusted: "", notes: "" };
  flashMsg(`Round posted — differential ${round.differential.toFixed(1)}`);
}

/* ================= start ================= */

async function start(assocId) {
  db.setAssociation(assocId);
  const member = await db.loadMembership(assocId);
  if (!member) return;
  association = await db.loadAssociation(assocId);
  if (association) lookup.setSharedKey(association.lookupKey || "");
  db.stopWatching();
  db.watchAssociation((doc) => {
    association = doc;
    lookup.setSharedKey(doc.lookupKey || "");
    render();
  });
  db.watchGolfers((list) => { allGolfers = list; refreshScope(); render(); });
  db.watchRoster((ids) => { roster = ids; refreshScope(); render(); });
  db.watchRounds((list) => { rounds = list; render(); });
  db.watchCourses((list) => { courses = list; render(); });
  db.watchGames((list) => { games = list; render(); });
  db.watchMembers((list) => { members = list; render(); });
  render();
}

/* Works out which group this account should actually be looking at.
 *
 * A device can be left pointing at a group created by an older identity — the
 * anonymous account it had before signing in. That group refuses every write,
 * which looks like a broken app. So: check membership, and if it is not ours,
 * move to one that is. */
async function settleGroup(preferred) {
  /* Held true until this finishes, so the first screen never flashes up
     "Start your group" at somebody who already has one — which is what made
     signing in look as though it had lost everything. */
  settling = true;
  render();
  try {
    return await settleGroupInner(preferred);
  } finally {
    settling = false;
    render();
  }
}

async function settleGroupInner(preferred) {
  /* No veil here on purpose: the boot card is already on screen at this point,
     and stacking a second waiting state on top of it would flicker. The veil is
     for actions somebody has just taken, not for opening the app. */
  const mine = await db.loadMyGroups();

  if (preferred && await db.amMemberOf(preferred)) {
    await start(preferred);
    return;
  }

  for (const group of mine) {
    if (await db.amMemberOf(group.id)) {
      await start(group.id);
      if (preferred && preferred !== group.id) {
        /* settleGroup() renders in its finally block, so this message does
         reach the screen — the note is here so nobody removes that render
         without noticing what depends on it. */
      flashMsg(`Switched to ${group.name}. The group this device was showing belonged to an older sign-in on it.`);
      render();
      }
      return;
    }
  }
  /* Nothing belongs to this account: the first screen handles it. */
}

db.onChange((s) => { sync = s; render(); });

(async function boot() {
  render();
  await db.init();
  markBoot("group");

  const invite = db.readJoinLink();
  const remembered = db.recallAssociation();

  await settleGroup(remembered);
  markBoot("data");

  /* Look for a version 1 scorecard whether or not there is already a group.
     Somebody who created one first still needs a way to bring their data in. */
  legacy = await db.readLegacyV1();

  /* If the link names somebody, fetch them so the screen can greet them. */
  const link = db.readJoinLink();
  if (link && link.golferId) {
    invitedGolfer = await db.golferNamedInLink(link.golferId);
    /* Usually null — a group document is not readable until you belong to it.
       The screen falls back to a generic heading rather than looking broken. */
    const group = await db.loadAssociation(link.associationId);
    invitedGroupName = group ? group.name : "";
  }

  markBoot("ready");
  ready = true;
  render();
})();
