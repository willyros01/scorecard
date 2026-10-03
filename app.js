import * as db from "./store.js";
import * as model from "./model.js";
import * as lookup from "./courses-api.js";
import * as platform from "./platform.js";

const VERSION = (typeof self !== "undefined" && self.APP_VERSION) || "dev";
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
      <input class="field" name="typed-date" inputmode="text" placeholder="2025-05-18"
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

/* beta.7: how long each start-up step took, kept in the report trail so a
   slow start shows exactly where the time went. */
const bootT0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
function markBoot(key) {
  const i = bootSteps.findIndex((s) => s.key === key);
  try { note(`start-up: ${key} reached after ${Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - bootT0)} ms`); } catch {}
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
let stepIndex = null;   /* null = let the walk-through choose where to start */
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

/* Fast entry: one screen for a whole field's scores.
 *
 * Deliberately folded INTO a game rather than added to Manage as a second
 * path. The game already knows the date and the course, so asking for them
 * again would be two extra screens for nothing — and two ways to do the same
 * thing is how a codebase grows contradictions. */
let fastEntry = null;   /* { scores: {golferId: "97"}, indexes: {golferId: "14.2"} } */

/* Whether we have already told this person, on this device, that their new
   admin role needs a password. Shown once per session rather than on every
   redraw — a dialog that reappears is worse than one that is missed. */
let toldAboutPromotion = false;
let editingGame = false;
let invitedGolfer = null;
let invitedGroupName = "";
/* Version 2.0 Phase B: which account card a signed-out (or old guest) screen
   shows — "create" or "signin". Null means the screen's own default. */
let accountMode = null;
const claimedOnce = new Set();   /* golfers this session has already tried to claim (screenEnter) */
/* Version 2.0 Phase C: the PUBLIC group. */
/* beta.3: the signed-out screens. null = the first screen (Sign in);
   "code" = I have a code; "choose" = Become a member or start a group;
   "member" = the public group application; "group" = a private group request. */
let adminTab = "cockpit";
/* beta.5: the screen to return to after Tidy (kept for this browser tab only). */
const RETURN_KEY = "golf:return";
const EMULATED_QS = (() => { try { return new URLSearchParams(location.search).has("emulators") ? "?emulators=1" : ""; } catch { return ""; } })();
let returnTo = (() => {
  try {
    const r = JSON.parse(sessionStorage.getItem(RETURN_KEY) || "null");
    sessionStorage.removeItem(RETURN_KEY);
    return r && Date.now() - r.at < 2 * 60 * 60 * 1000 ? { ...r, until: Date.now() + 20000 } : null;
  } catch { return null; }
})();       /* beta.4: Cockpit | Applications | Members | Settings */
let signedOutStep = null;
let applySentTo = "";           /* signed out: the application just sent */
let applySentAuto = false;      /* beta.4: that application got the sign-in link (Auto) */
let applyInUse = "";            /* beta.4: the email typed already has an account */
let applySettings = null;       /* beta.4: { mode, dailyLimit }, read when the form opens */
let requestSentTo = "";         /* signed out: the group request just sent */
let requestForm = { fullName: "", email: "", groupName: "", size: "", where: "", note: "" };
let groupRequests = [];         /* the group creator: requests for private groups */
let requestsWatched = false;
let confirmDecline = null;      /* the group request key awaiting a second tap */
let applications = [];          /* reviewers: pending applications */
let publicReports = [];         /* reviewers: reports of golfers' names */
let approvalsWaiting = [];      /* reviewers: approved, not joined yet */
let blocked = [];               /* this account's blocked golfers (PUBLIC) */
let rawGolfers = [];            /* golfers as delivered, before blocking */
let confirmReject = null;       /* the application key awaiting a second tap */
let confirmationSent = false;   /* the confirmation email was sent this session */

/* Kept beside the handlers so adding a button and forgetting the selector
   cannot happen silently — a test compares this list against the markup. */
const CLICKABLE = [
  "data-act", "data-tee", "data-go", "data-edit", "data-del", "data-confirm-del",
  "data-unfilter", "data-drill", "data-golfer-index", "data-del-golfer", "data-rename",
  "data-set-index", "data-course", "data-pick", "data-rm-tee", "data-game", "data-role",
  "data-invite-golfer", "data-reinvite", "data-cal", "data-cal-day", "data-cal-month", "data-more", "data-drop-member",
  "data-drop-round", "data-goto-group", "data-forget-group",
  "data-edit-course", "data-hide-course", "data-unhide-course",
].map((name) => `[${name}]`).join(",");
let courseDraft = null;
let showHidden = false;   /* Courses screen: reveal the hidden ones so they can be brought back. */
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

/* EVERY course picker uses this, so hiding one takes it out of all of them at
   once rather than leaving it lurking in a dropdown somewhere.
   A course still IN USE by this group is never hidden from the pickers — that
   would strand the rounds already posted on it and make an old round
   uneditable. Hiding is for clutter, not for retiring a course you play. */
const sortedCourses = () => {
  const hidden = db.hiddenCourses();
  return [...courses]
    .filter((c) => c && !hidden.includes(c.id))
    .sort(byName);
};

/* The Courses screen itself, which CAN show the hidden ones on request. */
const allCoursesForList = () => [...courses].sort(byName);
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

let flashTimer;
function flashMsg(msg) {
  clearTimeout(flashTimer);
  flash = msg; render();
  flashTimer = setTimeout(() => { flash = null; render(); }, 10000);
}

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

  /* Version 2.0 Phase B: nobody is signed in automatically any more. An
     invitation or a code first asks for an account (create one, or sign in),
     then shows the invitation itself — which can only be read with one. */
  if (!db.hasUser()) return screenSignedOut(invite);

  /* Offline, "nothing found" only means "not downloaded yet" (Change 3,
     Part C). Never offer to start a new group, or call an invitation unknown,
     on the strength of that. */
  if (db.readsOffline() && !(invite && invitedGolfer)) {
    return `<div class="stack">
      ${flashBar()}
      <div class="card padded">
        <h2 class="panel-title">You're offline</h2>
        <p class="lead">${invite ? "This invitation can't be opened until you reconnect." : "Your groups appear when you reconnect."}</p>
        <p class="hint">Nothing has been lost. This screen updates by itself once there is a connection.</p>
      </div>
      ${versionBlock()}
    </div>`;
  }

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
            ? "You are joining as an <b>admin</b>."
            : "Nothing to type. Your rounds and handicap come with you."}</p>
          <p class="hint">Not you? <button class="linkbtn" data-act="not-me">This is somebody else's invitation</button></p>
        </div>
        ${versionBlock()}
      </div>`;
    }

    return `<div class="stack">
      ${flashBar()}
      <div class="card padded">
        <h2 class="panel-title">${invite.role === "admin" && !invite.golferId
          ? "You have been invited to help run the group"
          : "You have been invited"}</h2>
        <p class="hint">${invite.role === "admin" && !invite.golferId
          ? "You will be an admin: you can add courses, manage the roster and post rounds for anybody. You are not added as a player, so no handicap is kept for you."
          : "Type the name you play under and you are in."}</p>
        <label class="lbl">${invite.role === "admin" && !invite.golferId ? "Your name" : "Your name"}</label>
        <input class="field" name="join-name" value="${esc(joinForm.name)}" placeholder="e.g. Willy Rosales" autocomplete="name">
        <div class="inline-actions stacked">
          <button class="btn" data-act="accept-invite" ${joining ? "disabled" : ""}>${joining ? "Joining…" : "Join the group"}</button>
        </div>
        <p class="hint">Using more than one device? Sign in there with the same email and password.</p>
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
        <div class="note tip">A group code joins you as a <b>guest</b>. If you are already an admin
        here, your role is kept — the code will not take it away.</div>
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
      ${confirmEmailCard()}
      <div class="card padded" style="border:2px solid var(--pencil)">
        <div class="name">Expecting to see a group here?</div>
        <p class="hint">If you already belong to one, <b>do not create another</b> — a second group
        would sit alongside the first with none of your rounds in it. Look again first; if it is
        still missing, ask whoever runs the group to send you a fresh invitation link.</p>
        <div class="inline-actions stacked">
          <button class="btn" data-act="look-again">Look for my groups again</button>
          <button class="btn ghost" data-act="enter-code">I have a code for my group</button>
        </div>
        <p class="hint">The code is six characters. Whoever runs the group can read it out — Admin,
        then <b>Show the code</b>. Joining by code always works, even when the search cannot find
        you.</p>
      </div>

      ${db.canCreateGroups() ? `<div class="card padded">
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
      </div>` : `<div class="card padded">
        <h2 class="panel-title">Not in a group yet</h2>
        <p class="hint">New groups are created by The Scorecard's owner. Ask your group for an invitation link or its code.</p>
      </div>`}
    ` : ""}
    ${versionBlock()}
  </div>`;
}

/* ---------------- Version 2.0 Phase C: the PUBLIC group ---------------- */

/* Signed out: apply to the PUBLIC group with full name and email (R1). */
/* beta.3: shown on both application screens (approved by Willy, Oct 1). */
function conditionsBlock(boxName) {
  return `<h3 class="sub-title">Conditions</h3>
    <div class="terms">
      <p>Approval is not automatic. Every application is reviewed by a person, and The Scorecard may accept or decline any application at its discretion, without giving a reason.</p>
      <p>Every member agrees to follow the Code of Conduct: be courteous and respectful, use your real name, enter honest scores, and post nothing offensive or abusive. The Scorecard has zero tolerance for objectionable content or abusive behaviour, and may remove any member or group that does not follow it, at any time.</p>
    </div>
    <label class="checkline agree">
      <input type="checkbox" name="${boxName}">
      <span>I have read and agree to the <button class="linkbtn" data-act="open-conduct">Code of Conduct</button> and the <button class="linkbtn" data-act="open-privacy">Privacy policy</button>.</span>
    </label>`;
}

function stepsBlock(steps) {
  return `<h3 class="sub-title">What happens next</h3>
    <ol class="steps">${steps.map((t) => `<li>${t}</li>`).join("")}</ol>`;
}

/* The first screen's two buttons lead here and to the code screen. */
function screenCodeFirst() {
  return `<div class="stack">
    ${flashBar()}
    ${offlineAccountNote()}
    <div class="card padded">
      <h2 class="panel-title">I have a code</h2>
      <p class="hint">Type the group code you were given. Next, you create your account or sign in, and then you join the group.</p>
      <label class="lbl">Group code</label>
      <input class="field mono" name="join-code" value="${esc(joinForm.code)}" placeholder="ABC234" autocapitalize="characters" autocomplete="off">
      <div class="inline-actions stacked">
        <button class="btn" data-act="code-continue">Continue</button>
        <button class="btn ghost" data-act="hide-apply">Back</button>
      </div>
    </div>
    ${versionBlock()}
  </div>`;
}

function screenChoose() {
  return `<div class="stack">
    ${flashBar()}
    <div class="panel-head"><h2 class="panel-title">Become a member or start a group</h2></div>
    <p class="hint" style="margin-top:0">Choose one. Every application is read by a person, and approval is subject to the conditions shown on the next screen.</p>
    <button class="choice" data-act="show-apply">
      <span class="choice-title">Become a member</span>
      <span class="hint">Join the public group and track your handicap with golfers from everywhere.</span>
    </button>
    <button class="choice" data-act="show-request">
      <span class="choice-title">Start your own group</span>
      <span class="hint">A private group for your friends or your club, with you as its admin.</span>
    </button>
    <p class="hint">Invited to a private group? Tap the link you were sent instead.</p>
    <div class="inline-actions stacked"><button class="btn ghost" data-act="hide-apply">Back</button></div>
    ${versionBlock()}
  </div>`;
}

function screenGroupRequest() {
  if (requestSentTo) {
    return `<div class="stack">
      ${flashBar()}
      <div class="card padded">
        <h2 class="panel-title">Request sent</h2>
        <p class="lead">Thank you. Every request is read by a person, so it can take a few days.</p>
        <p class="hint">If it is approved, an email goes to <b>${esc(requestSentTo)}</b> with your invitation link. Check your junk mail too.</p>
        <div class="inline-actions stacked"><button class="btn ghost" data-act="hide-apply">Back to Sign in</button></div>
      </div>
      ${versionBlock()}
    </div>`;
  }
  const f = requestForm;
  return `<div class="stack">
    ${flashBar()}
    ${offlineAccountNote()}
    <div class="card padded">
      <h2 class="panel-title">Start your own group</h2>
      <p class="hint">Tell us about your group. When it is approved, the group is created and you become its admin.</p>
      <label class="lbl">Your full name</label>
      <input class="field" name="rq-name" value="${esc(f.fullName)}" placeholder="e.g. Willy Rosales" autocomplete="name" maxlength="80">
      <label class="lbl">Your email</label>
      <input class="field" name="rq-email" type="email" value="${esc(f.email)}" placeholder="you@example.com" autocomplete="email" autocapitalize="none" maxlength="254">
      <label class="lbl">Group name</label>
      <input class="field" name="rq-group" value="${esc(f.groupName)}" placeholder="e.g. Tuesday Morning Golfers" maxlength="60">
      <label class="lbl">About how many golfers</label>
      <input class="field" name="rq-size" value="${esc(f.size)}" inputmode="numeric" placeholder="e.g. 20" maxlength="20">
      <label class="lbl">Where you play</label>
      <input class="field" name="rq-where" value="${esc(f.where)}" placeholder="Club or city" maxlength="100">
      <label class="lbl">Anything else (optional)</label>
      <textarea class="field" name="rq-note" rows="3" maxlength="1000">${esc(f.note)}</textarea>
      ${stepsBlock([
        "You send this request.",
        "The Scorecard's owner reviews it, usually within a few days, and may email you with questions.",
        "If it is approved, your group is created and you get an email with your invitation link. Tap it, create your account, and you join your group as its admin.",
        "From the Admin area, you send invitation links to your golfers.",
        "Your golfers tap the link, create their account and join your group. Only members of your group see its rounds and ranking.",
      ])}
      <p class="hint">As the group's admin, you invite and remove regular members. The Scorecard's owner remains the owner of every group.</p>
      <p class="hint">If your request is not approved, you will not receive an email.</p>
      ${conditionsBlock("rq-agree")}
      <div class="inline-actions stacked">
        <button class="btn" data-act="submit-request" ${joining ? "disabled" : ""}>${joining ? "Sending…" : "Send my request"}</button>
        <button class="btn ghost" data-act="show-choose">Back</button>
      </div>
    </div>
    ${versionBlock()}
  </div>`;
}

async function submitRequestHere() {
  const val = (n) => ((view.querySelector(`[name="${n}"]`) || {}).value || "");
  requestForm = { fullName: val("rq-name").trim(), email: val("rq-email").trim(), groupName: val("rq-group").trim(),
    size: val("rq-size").trim(), where: val("rq-where").trim(), note: val("rq-note").trim() };
  const f = requestForm;
  if (f.fullName.length < 2) { flashMsg("Type your full name"); return render(); }
  if (!f.email) { flashMsg("Type your email address"); return render(); }
  if (f.groupName.length < 2) { flashMsg("Type the group name"); return render(); }
  if (!f.size) { flashMsg("Type about how many golfers"); return render(); }
  if (f.where.length < 2) { flashMsg("Type where you play"); return render(); }
  const agreed = view.querySelector('[name="rq-agree"]');
  if (!agreed || !agreed.checked) { flashMsg("Tick the box to agree to the Code of Conduct and the Privacy policy"); return render(); }
  joining = true;
  busy("Sending your request");
  render();
  try {
    await db.submitGroupRequest(f);
    requestSentTo = f.email;
  } catch (err) {
    const code = String((err && (err.code || err.message)) || "");
    if (code.includes("app/exists")) flashMsg("There is already a request for that email. If it is approved, you will get an email.");
    else if (code.includes("app/email")) flashMsg("That email does not look right. Check it for a typo.");
    else if (code.includes("app/name")) flashMsg("Type your full name (up to 80 characters).");
    else if (code.includes("app/group")) flashMsg("Type the group name (up to 60 characters).");
    else if (code.includes("app/size")) flashMsg("Type about how many golfers (up to 20 characters).");
    else if (code.includes("app/where")) flashMsg("Type where you play (up to 100 characters).");
    else flashMsg(`It was not sent: ${code || "no connection"}. Check the connection and try again.`);
  } finally {
    joining = false;
    idle();
    render();
  }
}

function screenApply() {
  const auto = !!(applySettings && applySettings.mode === "auto");
  if (applySentTo && applySentAuto) {
    return `<div class="stack">
      ${flashBar()}
      <div class="card padded">
        <h2 class="panel-title">Check your email</h2>
        <p class="lead">Thank you. A link to finish joining has gone to <b>${esc(applySentTo)}</b>.</p>
        <p class="hint">Open that email on this phone or computer and tap the link. It confirms your email; then you choose your password and you are in the public group, once the last checks pass. Otherwise your application waits for a person to look at it.</p>
        <p class="hint">The email comes from Firebase, which The Scorecard uses for accounts. It sometimes lands in junk mail.</p>
        <div class="inline-actions stacked"><button class="btn ghost" data-act="hide-apply">Back to Sign in</button></div>
      </div>
      ${versionBlock()}
    </div>`;
  }
  if (applySentTo) {
    return `<div class="stack">
      ${flashBar()}
      <div class="card padded">
        <h2 class="panel-title">Application sent</h2>
        <p class="lead">Thank you. Every application is read by a person, so it can take a day or two.</p>
        <p class="hint">When it is approved, an email goes to <b>${esc(applySentTo)}</b> with a link to choose your password. Then open The Scorecard and sign in with that email and password.</p>
        <p class="hint">The email comes from Firebase, which The Scorecard uses for accounts. It sometimes lands in junk mail.</p>
        <div class="inline-actions stacked"><button class="btn ghost" data-act="hide-apply">Back to Sign in</button></div>
      </div>
      ${versionBlock()}
    </div>`;
  }
  return `<div class="stack">
    ${flashBar()}
    ${offlineAccountNote()}
    <div class="card padded">
      <h2 class="panel-title">Become a member</h2>
      <p class="hint">${auto
        ? "Give your full name and your email. No password yet. You get an email with a link to finish joining."
        : "Give your full name and your email. No password yet. When a person has approved it, you get an email to choose your password."}</p>
      <label class="lbl">Full name</label>
      <input class="field" name="apply-name" value="${esc(joinForm.name || "")}" placeholder="e.g. Willy Rosales" autocomplete="name" maxlength="80">
      <label class="lbl">Email</label>
      <input class="field" name="apply-email" type="email" value="${esc(authForm.email || "")}" placeholder="you@example.com" autocomplete="email" autocapitalize="none" maxlength="254">
      ${applyInUse ? `<div class="note warn in-use"><b>This email already has an account.</b> Sign in with it instead, or tap Forgot the password on the Sign in screen. Nothing was sent.</div>
        <div class="inline-actions stacked"><button class="btn" data-act="hide-apply">Back to Sign in</button></div>` : ""}
      <div class="note tip">Other members of the public group see your <b>full name</b> and your <b>handicap index</b>, and nothing else. Your rounds stay private.</div>
      ${auto ? stepsBlock([
        "You send this application.",
        "You get an email with a link. It comes from Firebase, which The Scorecard uses for accounts, and it sometimes lands in junk mail.",
        "You tap the link, which confirms your email, and choose your password.",
        "If the automatic checks pass, you are in the public group straight away. If not, a person reviews your application, usually within one or two days.",
        "You can start entering your rounds.",
      ]) : stepsBlock([
        "You send this application.",
        "A person reviews it, usually within one or two days.",
        "If it is approved, you get an email with a link to choose your password. It comes from Firebase, which The Scorecard uses for accounts, and it sometimes lands in junk mail.",
        "You choose your password, open The Scorecard and sign in with your email and that password.",
        "You are in the public group and can start entering your rounds.",
      ])}
      <p class="hint">If your application is not approved, you will not receive an email.</p>
      ${conditionsBlock("ap-agree")}
      <div class="inline-actions stacked">
        <button class="btn" data-act="submit-application" ${joining ? "disabled" : ""}>${joining ? "Sending…" : "Send my application"}</button>
        <button class="btn ghost" data-act="show-choose">Back</button>
      </div>
    </div>
    ${versionBlock()}
  </div>`;
}

/* beta.4: the applicant tapped the link in their email. */
function screenFinishApply() {
  return `<div class="stack">
    ${flashBar()}
    ${offlineAccountNote()}
    <div class="card padded">
      <h2 class="panel-title">Finish joining</h2>
      <p class="hint">Your email is confirmed by this link. Type the same email, choose a password for The Scorecard, and you are done.</p>
      <label class="lbl">Email</label>
      <input class="field" name="email" type="email" value="${esc(authForm.email || db.rememberedApplyEmail())}" placeholder="you@example.com" autocomplete="username" autocapitalize="none">
      <label class="lbl">Choose a password for this app</label>
      <input class="field" name="password" type="password" placeholder="At least 6 characters" autocomplete="new-password">
      <label class="lbl">The same password again</label>
      <input class="field" name="password-again" type="password" placeholder="At least 6 characters" autocomplete="new-password">
      <p class="hint"><b>Not your email password.</b> Pick a different one, for The Scorecard only.</p>
      <div class="inline-actions stacked">
        <button class="btn" data-act="finish-apply" ${joining ? "disabled" : ""}>${joining ? "Finishing…" : "Finish joining"}</button>
      </div>
    </div>
    ${versionBlock()}
  </div>`;
}

async function finishApplyHere() {
  const fields = readNewAccountFields();
  if (!fields) return;
  joining = true;
  busy("Finishing");
  render();
  let finished = { ok: false };
  try {
    finished = await db.finishApplyLink(fields);
  } catch (err) {
    joining = false; idle();
    const code = String((err && (err.code || err.message)) || "");
    if (/invalid-action-code|expired-action-code/.test(code)) {
      db.clearJoinLink();
      flashMsg("This link has expired or was already used. If you set a password, sign in with it; otherwise apply again.");
    } else if (/invalid-email|user-mismatch/.test(code)) {
      flashMsg("That is not the email the link was sent to. Type the email you applied with.");
    } else {
      flashMsg(`It did not finish: ${code || "no connection"}. Tap Finish joining again.`);
    }
    return render();
  }
  /* Approved by a reviewer already? Join that way; otherwise try Auto. */
  let result = { waiting: true };
  try {
    const manual = await db.joinPublicIfApproved();
    if (manual && manual.joined) { await db.finishPublicJoin().catch(() => {}); result = { joined: true }; }
    else result = await db.autoJoinPublic();
  } catch { result = { waiting: true }; }
  joining = false;
  idleAll();
  const pw = finished && finished.passwordFailed
    ? " Your password could not be set: on the Sign in screen, tap Forgot the password to choose one." : "";
  if (result.joined) {
    await start(db.PUBLIC_ID);
    tab = "enter";
    flashMsg(`Welcome to the public group. Post your rounds on the Enter tab.${pw}`);
  } else {
    flashMsg(`Your email is confirmed${pw ? "" : " and your password is set"}. Your application now waits for a person to review it. You will get an email when it is approved.${pw}`);
  }
  render();
}

async function submitApplicationHere() {
  const fullName = ((view.querySelector('[name="apply-name"]') || {}).value || "").trim();
  const email = ((view.querySelector('[name="apply-email"]') || {}).value || "").trim();
  joinForm.name = fullName; authForm = { email, password: "" };
  if (fullName.length < 2) { flashMsg("Type your full name"); return; }
  if (!email) { flashMsg("Type your email address"); return; }
  const agreed = view.querySelector('[name="ap-agree"]');
  if (!agreed || !agreed.checked) { flashMsg("Tick the box to agree to the Code of Conduct and the Privacy policy"); return; }
  joining = true;
  busy("Sending your application");
  render();
  applyInUse = "";
  try {
    await db.submitApplication({ fullName, email });
    /* beta.4: with the switch on Auto and a plain name, the sign-in link goes
       out now. If it cannot be sent, the application still waits for a
       person, exactly as in Manual. */
    applySentAuto = false;
    const settings = applySettings || await db.readApplicationSettings();
    if (settings.mode === "auto" && db.plainName(fullName)) {
      try { await db.sendApplicationLink(email); applySentAuto = true; } catch { applySentAuto = false; }
    }
    applySentTo = email;
  } catch (err) {
    const code = String((err && (err.code || err.message)) || "");
    if (code.includes("app/in-use")) applyInUse = email;
    else if (code.includes("app/exists")) flashMsg("There is already an application for that email. If it is approved, you will get an email.");
    else if (code.includes("app/email")) flashMsg("That email does not look right. Check it for a typo.");
    else if (code.includes("app/name")) flashMsg("Type your full name (up to 80 characters).");
    else flashMsg(`It was not sent: ${code || "no connection"}. Check the connection and try again.`);
  } finally {
    joining = false;
    idle();
    render();
  }
}

/* After any sign-in: join the PUBLIC group if an approval is waiting for this
   email. Quiet when there is none. */
async function checkPublicApproval() {
  /* Phase D: also learn, once per sign-in, whether this account may create groups. */
  await db.loadGroupCreator();
  watchRequestsIfCreator();
  /* beta.4: record this account's email (for "already has an account"). */
  db.ensureAccountEmail();
  let result;
  try { result = await db.joinPublicIfApproved(); }
  catch (e) {
    flashMsg("Your approval for the public group was found, but joining did not finish. Open the app again to retry.");
    return;
  }
  /* beta.4: an automatic join that stopped part-way finishes here; an
     application still pending tries Auto again (the switch, the checks and
     the daily limit are all re-checked). */
  /* finishPublicJoin checks for itself (member of the public group, own
     application still pending), so it is always safe to call. */
  try { await db.finishPublicJoin(); } catch {}
  if (!(result && result.joined) && db.emailConfirmed()) {
    try { const auto = await db.autoJoinPublic(); if (auto && auto.joined) result = { joined: true }; } catch {}
  }
  if (!result || !result.joined) return;
  if (!db.currentAssociation()) {
    await start(db.PUBLIC_ID);
    tab = "enter";
    flashMsg("Welcome to the public group. Post your rounds on the Enter tab.");
  } else {
    flashMsg("You are now in the public group too. Tap the group name at the top to switch to it.");
  }
}

/* Signed in, in no group, email not confirmed: somebody approved for the
   public group who already had an account confirms their email here. */
function confirmEmailCard() {
  if (db.emailConfirmed()) return "";
  return `<div class="card padded">
    <div class="name">Applied to the public group?</div>
    <p class="hint">Once your application is approved, confirm your email address and you join straight away.</p>
    <div class="inline-actions stacked">
      <button class="btn ghost" data-act="send-confirmation">${confirmationSent ? "Send the confirmation email again" : "Send me the confirmation email"}</button>
      ${confirmationSent ? `<button class="btn" data-act="confirmed-email">I have confirmed it — continue</button>` : ""}
    </div>
    ${confirmationSent ? `<p class="hint">Sent to <b>${esc(db.currentEmail())}</b>. Open the link in it, then come back and tap Continue. It sometimes lands in junk mail.</p>` : ""}
  </div>`;
}

/* Shown under the ranking in the public group (Apple guideline 1.2). */
function publicSafetyNote() {
  return `${blocked.length && !db.canManage() ? `<div class="card list">
      <div class="list-row"><span class="grow"><span class="name">Golfers you blocked</span><br><span class="sub">Hidden from your screens. Only you see this list.</span></span></div>
      ${blocked.map((b) => `<div class="list-row"><span class="grow"><span class="name">${esc(b.name || "A golfer")}</span></span>
        <button class="rowbtn" data-act="unblock" data-id="${esc(b.golferId)}">Unblock</button></div>`).join("")}
    </div>` : ""}
    <p class="hint">See a name that shouldn't be here? Tap <b>Report or block</b> under it. Reports go to the people who run the public group. You can also write to <button class="linkbtn" data-act="open-support">Support</button>.</p>`;
}

function openGolferActions(golferId) {
  const golfer = golferById(golferId) || allGolfers.find((g) => g.id === golferId);
  if (!golfer) return;
  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>${esc(golfer.name)}</h2><button class="rowbtn" data-close="1">Close</button></div>
    <label class="lbl">Report this name to the people who run the public group</label>
    <textarea class="field" name="report-reason" rows="3" maxlength="500" placeholder="What is wrong with it? (optional)"></textarea>
    <div class="inline-actions stacked">
      <button class="btn" data-pc="report" data-id="${esc(golfer.id)}">Send the report</button>
      <button class="btn ghost" data-pc="block" data-id="${esc(golfer.id)}">Block — hide ${esc(golfer.name)} from my screens</button>
    </div>
    <p class="hint">Blocking only changes what you see. You can unblock under the ranking at any time.</p>
  </div>`;
}

/* Reviewers: the waiting applications. */
function applicationsSection() {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Applications</h2></div>
    ${applications.length === 0 ? `<div class="card"><p class="blank">No applications waiting.</p></div>` : `
    <div class="card list">
      ${applications.map((a) => {
        const inProgress = a.status === "approving";
        const mine = inProgress && a.reviewedBy === db.status().uid;
        return `<div class="list-row">
        <span class="grow"><span class="name">${esc(a.fullName)}</span><br><span class="sub">${esc(a.email)}${inProgress
          ? (mine ? " · approval not finished — tap Approve to finish it" : " · being approved by another reviewer")
          : ""}</span></span>
        <span class="inline-actions">
          <button class="rowbtn" data-act="review-application" data-id="${esc(a.key)}">${mine ? "Finish" : "Approve"}</button>
          ${inProgress ? "" : `<button class="rowbtn ${confirmReject === a.key ? "danger" : ""}" data-act="reject-application" data-id="${esc(a.key)}">${confirmReject === a.key ? "Tap to reject" : "Reject"}</button>`}
        </span>
      </div>`;
      }).join("")}
    </div>`}
    ${approvalsWaiting.length ? `<div class="card list" style="margin-top:0.6rem">
      <div class="list-row"><span class="grow"><span class="name">Approved, not joined yet</span><br><span class="sub">They need to choose a password from the email, then sign in.</span></span></div>
      ${approvalsWaiting.map((p) => `<div class="list-row">
        <span class="grow"><span class="name">${esc(p.displayName || p.key)}</span><br><span class="sub">${esc(p.key)}</span></span>
        <button class="rowbtn" data-act="resend-approval-email" data-id="${esc(p.key)}">Send the email again</button>
      </div>`).join("")}
    </div>` : ""}
    <p class="hint">Approving creates their account and emails them a link to choose a password. Their golfer name must be unique; if it is taken, add a middle initial.</p>
  </section>`;
}

/* beta.3: requests for private groups, for the group creator (Willy). */
function groupRequestsSection() {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Group requests</h2></div>
    ${groupRequests.length === 0 ? `<div class="card"><p class="blank">No group requests waiting.</p></div>` : `
    <div class="card list">
      ${groupRequests.map((r) => {
        const inProgress = r.status === "approving";
        return `<div class="list-row request-row">
        <span class="grow"><span class="name">${esc(r.groupName)}</span><br>
          <span class="sub">${esc(r.fullName)} · ${esc(r.email)}</span><br>
          <span class="sub">About ${esc(r.golfers)} golfers · ${esc(r.where)}</span>
          ${r.note ? `<br><span class="sub">${esc(r.note)}</span>` : ""}
          ${inProgress ? `<br><span class="sub">Approval not finished — tap Finish.</span>` : ""}</span>
        <span class="inline-actions">
          <button class="rowbtn" data-act="approve-request" data-id="${esc(r.key)}">${inProgress ? "Finish" : "Approve"}</button>
          <button class="rowbtn ${confirmDecline === r.key ? "danger" : ""}" data-act="decline-request" data-id="${esc(r.key)}">${confirmDecline === r.key ? "Tap to decline" : "Decline"}</button>
        </span>
      </div>`;
      }).join("")}
    </div>`}
    <p class="hint">Approve creates the group with you as its owner (not on its roster), then opens an email to the organiser with an admin invitation link. Decline sends no email.</p>
  </section>`;
}

function watchRequestsIfCreator() {
  if (requestsWatched || !db.canCreateGroups()) return;
  requestsWatched = true;
  db.watchGroupRequests((list) => { groupRequests = list; render(); });
}

async function approveRequestHere(key) {
  const r = groupRequests.find((x) => x.key === key);
  if (!r) return render();
  busy("Creating the group");
  render();
  let claim;
  try { claim = await db.claimGroupRequest(key); }
  catch (e) {
    idleAll();
    const code = String((e && (e.code || e.message)) || "");
    flashMsg(code.includes("app/declined") ? "That request was declined already."
      : code.includes("app/gone") ? "That request no longer exists."
      : `It was not approved: ${code || "no connection"}. Nothing was changed.`);
    return render();
  }
  const groupId = claim.groupId;
  const req = claim.request || r;
  try {
    if (!claim.already) {
      /* A retry finds the group already made and does not make another. */
      if (!(await db.ownGroupExists(groupId))) {
        const me = members.find((m) => m.uid === db.status().uid);
        await db.createAssociation({ name: req.groupName, displayName: (me && me.displayName) || "Willy", id: groupId });
      }
      await db.finishGroupRequest(key);
    }
  } catch (e) {
    await db.releaseGroupRequest(key);
    idleAll();
    flashMsg(`The group was not created: ${String((e && (e.code || e.message)) || "no connection")}. Tap Approve to try again.`);
    return render();
  }
  try {
    await start(groupId);
    tab = "admin";
    await db.ensureAdminCode();
    const link = await db.inviteLink("admin");
    idleAll();
    if (!link) {
      flashMsg(`"${req.groupName}" is created and the request is approved. Send the organiser an admin invitation from Admin: Invite an admin who doesn't play.`);
      return render();
    }
    const guide = platform.guideUrl();
    const text = [
      `Hello ${req.fullName},`,
      "",
      `Your request for a private group on The Scorecard is approved. Your group "${req.groupName}" is ready, and you are invited to run it as its admin.`,
      "",
      `Join here: ${link}`,
      "",
      "Tap the link, create your account (your email and a password), and you join your group as its admin. From the Admin area you then send invitation links to your golfers.",
      "",
      `How it works, in one page: ${guide}`,
      "",
      "The link works once, so keep it to yourself.",
    ].join("\n");
    openShare(text, "Your private group is approved", { to: req.email });
    flashMsg(`"${req.groupName}" is created. Send the email to ${req.email}.`);
  } catch (e) {
    idleAll();
    flashMsg(`"${req.groupName}" is created and the request is approved, but the invitation could not be prepared. Open the group, then Admin, and send an admin invitation.`);
    render();
  }
}

function openApproveSheet(key) {
  const a = applications.find((x) => x.key === key);
  if (!a) return;
  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>Approve ${esc(a.fullName)}</h2><button class="rowbtn" data-close="1">Close</button></div>
    <p class="hint">${esc(a.email)}</p>
    <label class="lbl">Their golfer name in the public group</label>
    <input class="field" name="approve-name" value="${esc(a.golferName || a.fullName)}" maxlength="80">
    <div class="inline-actions stacked">
      <button class="btn" data-pc="approve" data-id="${esc(a.key)}">Approve and send the email</button>
    </div>
    <p class="hint">They get an email from Firebase to choose their password, then they sign in and they are in.</p>
    <p class="hint" data-name-note></p>
  </div>`;
  /* beta.4 (Willy, Oct 1): if the name is taken, the next free number is
     filled in: the first golfer keeps the plain name, then "Name 1", "Name 2". */
  if (!a.golferName) {
    db.nextFreeName(a.fullName).then((free) => {
      const input = sheetEl.querySelector('[name="approve-name"]');
      if (!input || sheetEl.hidden || input.value !== a.fullName || free === a.fullName) return;
      input.value = free;
      const note = sheetEl.querySelector("[data-name-note]");
      if (note) note.textContent = `A golfer called ${a.fullName} already exists, so the next number is filled in. You can change it.`;
    }).catch(() => {});
  }
}

/* Phase D: what an admin (not the owner) sees of the members: the regular
   members, each of whom they may remove. The owner and other admins are
   listed without a button — only the owner changes those. */
function adminMembersSection() {
  const mine = db.status().uid;
  const list = [...members].sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));
  const label = (m) => m.role === "owner" ? "owner" : m.role === "admin" ? "admin" : "member";
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Members</h2></div>
    <div class="card list">
      ${list.map((m) => `<div class="list-row person-row">
        <span class="grow"><span class="name">${esc(m.displayName || "Unnamed")}</span><br><span class="sub">${label(m)}${m.uid === mine ? " · you" : ""}</span></span>
        ${m.role === "member" && m.uid !== mine ? `<button class="rowbtn warn" data-drop-member="${esc(m.uid)}">Remove from group</button>` : ""}
      </div>`).join("")}
    </div>
    <p class="hint">Removing someone takes away their access to this group. Their golfer, rounds and handicap stay. Only the owner makes or removes admins.</p>
  </section>`;
}

/* Reviewers: reports of golfers' names. */
function reportsSection() {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Reports</h2></div>
    ${publicReports.length === 0 ? `<div class="card"><p class="blank">No reports.</p></div>` : `
    <div class="card list">
      ${publicReports.map((r) => {
        const member = members.find((m) => m.golferId === r.golferId && m.role === "member");
        return `<div class="list-row">
          <span class="grow"><span class="name">${esc(r.displayName || (golferById(r.golferId) || {}).name || "A golfer")}</span><br>
            <span class="sub">${esc(r.reason || "No reason given")}</span></span>
          <span class="inline-actions">
            <button class="rowbtn" data-act="dismiss-report" data-id="${esc(r.id)}">Dismiss</button>
            ${member ? `<button class="rowbtn danger" data-act="remove-reported" data-id="${esc(r.id)}">Remove from group</button>` : ""}
          </span>
        </div>`;
      }).join("")}
    </div>`}
    <p class="hint">Removing someone takes away their access to the public group. Their rounds stay. To rename a golfer instead, use Manage.</p>
  </section>`;
}

/* ---------------- Version 2.0 Phase B: accounts ---------------- */

/* Signing in or creating an account needs a connection; say so up front. */
function offlineAccountNote() {
  return typeof navigator !== "undefined" && navigator.onLine === false
    ? `<div class="note">You're offline. Signing in needs a connection — this screen works again once you reconnect.</div>`
    : "";
}

/* The account card shared by the signed-out screen and the old-guest screen. */
function signInCard({ heading, lead = "", backAct = "", backLabel = "" }) {
  return `<div class="card padded">
    <h2 class="panel-title">${heading}</h2>
    ${lead}
    <label class="lbl">Email</label>
    <input class="field" name="email" type="email" value="${esc(authForm.email || "")}" placeholder="you@example.com" autocomplete="username" autocapitalize="none">
    <label class="lbl">Password</label>
    <input class="field" name="password" type="password" placeholder="Your Scorecard password" autocomplete="current-password">
    <div class="inline-actions stacked">
      <button class="btn" data-act="sign-in" ${joining ? "disabled" : ""}>${joining ? "Signing in…" : "Sign in"}</button>
      <button class="btn ghost" data-act="reset-password">Forgot the password</button>
    </div>
    ${backAct ? `<p class="hint"><button class="linkbtn" data-act="${backAct}">${backLabel}</button></p>` : ""}
  </div>`;
}

/* Email, password and the password again — a typo in a new password locks
   somebody out of an account they have only just made. */
function newAccountFields() {
  /* beta.5: short labels (Willy: the invitation screen was too wordy). */
  return `<label class="lbl">Email</label>
    <input class="field" name="email" type="email" value="${esc(authForm.email || "")}" placeholder="you@example.com" autocomplete="username" autocapitalize="none">
    <label class="lbl">New password</label>
    <input class="field" name="password" type="password" placeholder="Not your email password" autocomplete="new-password">
    <label class="lbl">Password again</label>
    <input class="field" name="password-again" type="password" placeholder="At least 6 characters" autocomplete="new-password">`;
}

/* Nobody signed in. With an invitation or a code, the account comes first
   (create one, or sign in to an existing one); otherwise it is Sign in. */
function screenSignedOut(invite) {
  /* beta.4: arrived from the "finish joining" email of an Auto application. */
  if (!invite && db.isApplyLink()) return screenFinishApply();
  if (!invite && !showCodeEntry) {
    if (signedOutStep === "code") return screenCodeFirst();
    if (signedOutStep === "choose") return screenChoose();
    if (signedOutStep === "member") return screenApply();
    if (signedOutStep === "group") return screenGroupRequest();
  }
  const joiningSomething = !!invite || showCodeEntry;
  const mode = accountMode || (joiningSomething ? "create" : "signin");
  const adminOnly = invite && invite.role === "admin" && !invite.golferId;
  const heading = invite
    ? (adminOnly ? "You\u2019re invited to help run a group" : "You\u2019re invited")
    : showCodeEntry ? "Join with a code" : "Sign in";

  if (joiningSomething && mode === "create") {
    return `<div class="stack">
      ${flashBar()}
      ${offlineAccountNote()}
      <div class="card padded">
        <h2 class="panel-title">${heading}</h2>
        <p class="lead">${invite ? "Create your account to join." : "Create your account, then type the code."}</p>
        ${newAccountFields()}
        <div class="inline-actions stacked">
          <button class="btn" data-act="create-account" ${joining ? "disabled" : ""}>${joining ? "Creating your account…" : "Create account"}</button>
        </div>
        <p class="hint"><button class="linkbtn" data-act="account-mode-signin">Have an account? Sign in</button></p>
        ${showCodeEntry && !invite ? `<div class="inline-actions stacked"><button class="btn ghost" data-act="hide-code">Back</button></div>` : ""}
      </div>
      ${versionBlock()}
    </div>`;
  }

  return `<div class="stack">
    ${flashBar()}
    ${offlineAccountNote()}
    ${signInCard({
      heading,
      lead: joiningSomething
        ? `<p class="lead">${invite ? "Sign in to see your invitation." : "Sign in, then type the code."}</p>`
        : "",
      backAct: joiningSomething ? "account-mode-create" : "",
      backLabel: "New here? Create an account",
    })}
    ${joiningSomething ? (showCodeEntry && !invite ? `<div class="inline-actions stacked"><button class="btn ghost" data-act="hide-code">Back</button></div>` : "") : `
      <div class="inline-actions stacked first-choices">
        <button class="btn ghost" data-act="show-choose">Become a member or start a group</button>
        <button class="btn ghost" data-act="enter-code">I have a code</button>
      </div>`}
    ${versionBlock()}
  </div>`;
}

/* ================= beta.5: Terms of Use (Willy, Oct 2) =================
 *
 * Shown full screen the first time The Scorecard opens on a device, before
 * anything else, sign-in included. Accept works only after ticking "I have
 * read and agree"; Decline keeps the app locked. Accepting is remembered on
 * this device and, once signed in, recorded on the account itself
 * (users/{uid}/terms/accepted: version, server time, app version) — that is
 * the lasting record. If the device forgets, the terms are simply shown again.
 * A new TERMS_VERSION asks everybody again. Wording follows Fairpot's terms,
 * with the handicap and account sections written for golf. */
const TERMS_VERSION = 1;
const TERMS_EFFECTIVE = "October 2, 2026";
const TERMS_KEY = "golf:terms";
const TERMS = [
  ["1. Who provides The Scorecard", "The Scorecard is provided by Wilfredo Rosales, an individual developer (\u201cwe\u201d, \u201cus\u201d). These terms are an agreement between you and us."],
  ["2. A free app", "The Scorecard is free. There are no fees, subscriptions, advertising or in-app purchases."],
  ["3. Provided \u201cas is\u201d", "The Scorecard is provided \u201cas is\u201d and \u201cas available\u201d, without any warranty or condition of any kind, express or implied, including any warranty of merchantability, fitness for a particular purpose, accuracy or non-infringement. We do not promise that it will be free of errors, will always work, or will never lose data."],
  ["4. Handicaps are estimates", "The Scorecard works out a handicap from the scores entered, following the World Handicap System formula. It is not an official Handicap Index from Golf Canada, the USGA or any golf association. You are responsible for checking every score, course rating and result before you rely on it, including for competitions, prizes or bets."],
  ["5. Your account and your group", "Your account and your group's scores are kept with Google Firebase, as our Privacy Policy explains. People in your group see your name and handicap. Everyone agrees to our Code of Conduct, and we may remove anyone who breaks it."],
  ["6. No liability", "To the fullest extent permitted by law, we accept no liability of any kind for any loss or damage arising from your use of The Scorecard or your inability to use it. This includes lost data, wrong scores or handicaps, disputes between people, and any direct, indirect, incidental, special or consequential damages, even if we were told such loss was possible. You use The Scorecard entirely at your own risk."],
  ["7. Your rights under the law", "Some places do not allow certain warranties or liabilities to be excluded. Where that is the case, the exclusions in these terms apply only as far as the law allows. Nothing in these terms takes away rights you have by law that cannot be given up."],
  ["8. Apple", "These terms are between you and us, not Apple. Apple is not responsible for The Scorecard or its content, has no obligation to provide maintenance or support for it, and is not responsible for any claim relating to it. Apple and its subsidiaries are third-party beneficiaries of these terms and may enforce them. Apple\u2019s Licensed Application End User License Agreement also applies to your use of The Scorecard."],
  ["9. Changes to these terms", "We may change these terms in a later version. If we do, The Scorecard will show you the new terms and ask you to accept them before you can continue."],
  ["10. Governing law", "These terms are governed by the laws of the Province of Ontario and the federal laws of Canada that apply there, except where the law of the place you live requires otherwise."],
  ["11. Contact", "Questions about The Scorecard or these terms: willyros01@gmail.com"],
];
let termsState = "";          /* "" | "declined" | "viewing" (read-only, from the footer) */
let termsAcceptedNow = false; /* accepted in this session even if the device could not keep it */
const termsRecordedFor = new Set();
function termsDevice() {
  try { const t = JSON.parse(localStorage.getItem(TERMS_KEY) || "null"); return t && t.version >= TERMS_VERSION ? t : null; }
  catch { return null; }
}
function termsAccepted() { return termsAcceptedNow || !!termsDevice(); }
function termsBody() {
  return TERMS.map(([h, p]) => `<h3 class="terms-h">${esc(h)}</h3><p>${esc(p)}</p>`).join("");
}
function screenTerms() {
  if (termsState === "declined") {
    return `<div class="stack terms-gate">
      <div class="card padded">
        <h2 class="panel-title">The Scorecard is locked</h2>
        <p class="lead">You declined the Terms of Use. The Scorecard cannot be used unless you accept them.</p>
        <div class="inline-actions stacked"><button class="btn" data-act="terms-again">Read the terms again</button></div>
      </div>
    </div>`;
  }
  const viewing = termsState === "viewing";
  return `<div class="stack terms-gate">
    <div class="card padded">
      <h2 class="panel-title">Terms of Use</h2>
      <p class="hint">${viewing ? `Effective ${TERMS_EFFECTIVE}.` : "Please read these terms. You must accept them to use The Scorecard."}</p>
      <div class="terms-text">${termsBody()}</div>
      ${viewing ? `<div class="inline-actions stacked"><button class="btn" data-act="terms-close">Close</button></div>` : `
      <label class="terms-agree"><input type="checkbox" id="termsTick" data-terms-tick> I have read and agree to The Scorecard Terms of Use.</label>
      <p class="hint">By tapping Accept, you agree to these terms. If you decline, The Scorecard stays locked.</p>
      <div class="terms-buttons">
        <button class="btn ghost" data-act="terms-decline">Decline</button>
        <button class="btn" id="termsAccept" data-act="terms-accept" disabled>Accept</button>
      </div>`}
    </div>
  </div>`;
}
/* Once signed in, the acceptance is written to the account (once per
   account per session; never blocks the app if it cannot be saved). */
function recordTermsOnAccount() {
  const uid = db.hasUser() && db.status().uid;
  if (!uid || termsRecordedFor.has(uid) || !termsAccepted()) return;
  termsRecordedFor.add(uid);
  const device = termsDevice();
  db.recordTermsAcceptance({ version: TERMS_VERSION, appVersion: VERSION, deviceAcceptedAt: device ? device.at : Date.now() })
    .catch(() => termsRecordedFor.delete(uid));
}

/* An old guest session from before Version 2.0. The rules refuse it
   everything but finding its own groups and deleting itself, so the email and
   password are set here, on the SAME account: nothing moves, nothing is lost. */
function screenUpgrade() {
  if (accountMode === "signin") {
    return `<div class="stack">
      ${flashBar()}
      ${offlineAccountNote()}
      ${signInCard({
        heading: "Sign in",
        lead: `<p class="lead">Sign in with your email and password.</p>`,
        backAct: "account-mode-create",
        backLabel: "Back",
      })}
      ${versionBlock()}
    </div>`;
  }
  return `<div class="stack">
    ${flashBar()}
      ${offlineAccountNote()}
    <div class="card padded">
      <h2 class="panel-title">Set your email and password</h2>
      <p class="lead">One step to keep your groups and handicap.</p>
      ${newAccountFields()}
      <div class="inline-actions stacked">
        <button class="btn" data-act="upgrade-account" ${joining ? "disabled" : ""}>${joining ? "Saving…" : "Keep my place"}</button>
      </div>
      <p class="hint"><button class="linkbtn" data-act="account-mode-signin">Have an account? Sign in</button></p>
    </div>
    ${versionBlock()}
  </div>`;
}

/* Reads the new-account fields; returns null (after saying why) if unusable. */
function readNewAccountFields() {
  const email = ((view.querySelector('[name="email"]') || {}).value || "").trim();
  const password = (view.querySelector('[name="password"]') || {}).value || "";
  const again = (view.querySelector('[name="password-again"]') || {}).value || "";
  authForm = { email, password: "" };
  if (!email) { flashMsg("Type your email address"); return null; }
  if (password.length < 6) { flashMsg("The password needs at least six characters"); return null; }
  if (password !== again) { flashMsg("The two passwords are different. Type them again."); return null; }
  return { email, password };
}

async function createAccountHere() {
  const fields = readNewAccountFields();
  if (!fields) return;
  joining = true;
  busy("Creating your account");
  render();
  try {
    await db.createAccount(fields);
    accountMode = null;
    await loadInvitedDetails();
    joining = false;
    flashMsg("Account created. Use this email and password on your other devices.");
  } catch (err) {
    const code = String((err && (err.code || err.message)) || "");
    if (code.includes("email-already-in-use")) {
      /* beta.8 (Willy, Oct 2): the email already has an account. Asking for
         the same email and password again on a sign-in screen was the second
         screen he objected to. Sign in with what was just typed — the same
         check as the Sign in screen, so nothing is weaker — and go straight on
         to the invitation (or the code). Only a password that does not match
         stops here, on this same screen. */
      try {
        const result = await db.signInWithEmail(fields);
        joining = false;
        await finishSignIn(result, fields.email, "That email already had an account, so you are signed in with it.");
      } catch (again) {
        joining = false;
        const why = String((again && (again.code || again.message)) || "");
        openSignInProblem(/no-such-account|wrong-password|invalid-credential|invalid-login/i.test(why)
          ? Object.assign(new Error("auth/existing-account-password"), { code: "auth/existing-account-password" })
          : again, fields.email);
      }
    } else {
      joining = false;
      openSignInProblem(err, fields.email);
    }
  } finally {
    idle();
    render();
  }
}

async function upgradeAccount() {
  const fields = readNewAccountFields();
  if (!fields) return;
  joining = true;
  busy("Setting your email and password");
  render();
  try {
    await db.setMyPassword(fields);
    accountMode = null;
    joining = false;
    await settleGroup(db.recallAssociation());
    await loadInvitedDetails();
    tab = "enter";
    flashMsg(`Done. You are signed in as ${fields.email} — use it on every device.`);
    await checkPublicApproval();
  } catch (err) {
    joining = false;
    openSignInProblem(err, fields.email);
  } finally {
    idle();
    render();
  }
}

let editingKey = false;
let showCodeEntry = false;
let joining = false;


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
  /* Which step to show.
   *
   * This was a trap. It jumped to the first UNFINISHED step whenever stepIndex
   * was 0 — so after posting a round, with the golfer and course still filled
   * in, it landed on the score and Back could not escape: Back set stepIndex to
   * 0, and 0 meant "jump to the first unfinished step" all over again. The
   * course could never be changed for the next round.
   *
   * Now stepIndex is simply obeyed. It is set to the first unfinished step ONCE
   * when the walk-through opens (below), and after that the person is in
   * charge of where they are. */
  if (stepIndex == null) {
    /* A guest's golfer is fixed and re-seeded the moment the screen opens, so
       "who" is ALWAYS done for them — which meant the first-unfinished rule
       sent them straight back to the score after every round, with the course
       unreachable. They start at the course instead, which is the first thing
       they can actually change. An admin still starts at the golfer. */
    const start = db.canManage() ? 0 : 1;
    const firstUndone = steps.findIndex((s, i) => i >= start && !s.done);
    stepIndex = firstUndone === -1 ? start : firstUndone;
  }
  const showing = steps[Math.min(Math.max(0, stepIndex), steps.length - 1)] || steps[0];

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
    let mine = typeof db.myGolferId === "function" ? db.myGolferId(allGolfers) : "";
    /* Version 2.0: the membership records which golfer this is (golferId),
       and the own golfer record may still be loading. */
    if (!mine && typeof db.myGolferIdNow === "function") {
      const recorded = db.myGolferIdNow();
      if (recorded && allGolfers.some((g) => g.id === recorded)) mine = recorded;
    }

    /* Fall back to matching on the name they joined under.
     *
     * myGolferId relies on the golfer carrying linkedUid, which is only set
     * when somebody accepts a NAMED invitation. Anyone who joined by typing a
     * code, or before named invitations existed, has no link at all — and was
     * left staring at "Not linked yet" with Post disabled. Matching the name
     * on their membership recovers them. */
    if (!mine) {
      const me = members.find((m) => m.uid === db.status().uid);
      const named = me && String(me.displayName || "").trim().toLowerCase();
      if (named) {
        /* Real golfer records only: a directory entry (name and index of
           somebody else) is never "you", and has no link to claim. */
        const match = allGolfers.find((g) => !g.fromDirectory && String(g.name || "").trim().toLowerCase() === named);
        if (match) {
          mine = match.id;

          /* Tell the DATABASE, not just this screen.
           *
           * The rules decide whether a round is yours by reading
           * golfers/{id}.linkedUid. Matching by name here made the APP agree
           * you were that golfer while the rules still saw no link at all — so
           * a guest could post a round and then not delete it. Claiming an
           * unlinked golfer as yourself is explicitly permitted, so this write
           * is allowed and it makes the two agree. */
          /* Once per golfer per session: this runs while drawing the screen,
             and the claim itself redraws it. */
          if (match.linkedUid == null && !claimedOnce.has(match.id)) { claimedOnce.add(match.id); db.claimGolfer(match.id); }
        }
      }
    }

    if (mine) form.golferId = mine;
  }

  if (!golfers.length || !courses.length) {
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
  /* beta.4: "My season" at the top for anyone who plays in this group. */
  const season = (() => { try { return mySeasonCard(); } catch { return ""; } })();
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
    ${/* A regular member still sees the group's ranking (names and indexes)
         before posting anything — and, in the public group, Report or block. */
      !db.canManage() ? groupRankingSection() : ""}
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
  ${season}
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
      /* A regular member sees other golfers through the directory only, so
         "has rounds" is judged by the published index instead. */
      .filter((g) => (g.fromDirectory ? shownIndex(g) != null : rounds.some((r) => r.golferId === g.id)))
      .filter((g) => g.id !== db.myGolferId(allGolfers) || shownIndex(g) == null)
      .map((g) => {
      const n = rounds.filter((r) => r.golferId === g.id).length;
      if (g.fromDirectory) return `<div class="idx">
        <div class="name truncate">${esc(g.name)}</div>
        <div class="big">${shownIndex(g).toFixed(1)}</div>
      </div>`;
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
  if (!db.canManage()) return groupRankingSection();
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

/* The ranking a regular member sees (Version 2.0, Phase A): every golfer in
   the group from 1 to N by handicap index, with rank, name and index only.
   Rows do not open anything. Golfers without an index yet come last. */
function groupRankingSection() {
  const rows = sortedGolfers()
    .map((g) => ({ id: g.id, name: g.name, index: shownIndex(g) }))
    .sort((a, b) => (a.index == null) - (b.index == null) || (a.index ?? 0) - (b.index ?? 0) || a.name.localeCompare(b.name));
  let place = 0, seen = 0, previous;
  for (const r of rows) {
    if (r.index == null) { r.place = null; continue; }
    seen++;
    if (r.index !== previous) { place = seen; previous = r.index; }
    r.place = place;   /* equal indexes share a place */
  }
  const mine = db.myGolferId(allGolfers);
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Group ranking</h2></div>
    ${rows.length === 0 ? `<div class="card"><p class="blank">No golfers yet.</p></div>` : `
    <div class="card list">
      ${rows.map((r) => `<div class="list-row${r.id === mine ? " me" : ""}">
        <span class="rank">${r.place || "—"}</span>
        <span class="grow"><span class="name">${esc(r.name)}</span>
          ${db.isPublicGroup() && r.id !== mine ? `<br><button class="linkbtn" data-act="golfer-actions" data-id="${esc(r.id)}">Report or block</button>` : ""}</span>
        <span class="netavg">${r.index == null ? "—" : r.index.toFixed(1)}<br><span class="sub">index</span></span>
      </div>`).join("")}
    </div>
    <p class="hint">Ranked by handicap index, lowest first. Only names and indexes are shown; each golfer's rounds stay private.</p>`}
    ${db.isPublicGroup() ? publicSafetyNote() : ""}
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
        /* A regular member cannot see other players' rounds; the game's
           published result sheet says who played. */
        const played = db.canManage() ? rounds.filter((r) => r.gameId === g.id) : (g.results || []);
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

/* The whole field on one screen.
 *
 * One row per golfer: their name, their index, and a box for the score. No
 * date, no course, no per-golfer dialogs — the game already knows all of that,
 * which is exactly why this belongs here and not on Manage.
 *
 * Somebody with no index gets a second small box to type one, because a
 * tournament is precisely when an unrated player turns up and a net score is
 * needed on the day. */
function fastEntryPanel(game) {
  const playing = sortedGolfers();
  const already = new Set(rounds.filter((r) => r.gameId === game.id).map((r) => r.golferId));
  const course = courses.find((c) => c.id === game.courseId);
  const tees = course ? course.tees : [];
  const teeId = fastEntry.teeId || (tees[0] && tees[0].id) || "";
  const tee = tees.find((t) => t.id === teeId);

  /* Counted from what has been TYPED, which the panel tracks as it goes.
     Reading it from state at render time meant the count was always zero: the
     panel is deliberately not redrawn on every keystroke, so the state never
     caught up and the button stayed disabled for ever. */
  const filled = Object.values(fastEntry.scores).filter((v) => +v > 0).length;

  return `<section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">Scores for the field</h2>
      <button class="linkbtn" data-act="fast-cancel">Cancel</button>
    </div>

    <div class="card padded">
      <div class="sub">${esc(model.gameSpanLabel(game))} · ${esc(courseName(game.courseId))}</div>

      ${tees.length > 1 ? `
        <label class="lbl" style="margin-top:0.7rem">Everyone played from</label>
        <select class="field" name="fast-tee">
          ${tees.map((t) => `<option value="${t.id}" ${t.id === teeId ? "selected" : ""}>${esc(t.name)} — ${(+t.rating).toFixed(1)}/${t.slope}</option>`).join("")}
        </select>
        <p class="hint">Anyone who played different tees can be corrected afterwards from History.</p>
      ` : tee ? `<div class="sub">${esc(tee.name)} — ${(+tee.rating).toFixed(1)}/${tee.slope}</div>` : `
        <div class="note warn">This course has no tees yet. Add them on Manage first.</div>`}
    </div>

    ${tee ? `<div class="card" style="margin-top:0.8rem">
      <div class="fast-head">
        <span class="grow">Golfer</span>
        <span class="fast-idx">Index</span>
        <span class="fast-score">Score</span>
      </div>
      ${playing.map((g) => {
        const { index, source } = model.effectiveIndex(g);
        const posted = already.has(g.id);
        return `<div class="fast-row ${posted ? "posted" : ""}">
          <span class="grow">
            <span class="name">${esc(g.name)}</span>
            ${posted ? `<br><span class="sub">already in this game</span>` : ""}
          </span>
          <span class="fast-idx">
            ${index != null
              ? `<span class="mono">${index.toFixed(1)}</span>${source === "manual" ? `<br><span class="sub">start</span>` : ""}`
              : `<input class="field tiny" name="fast-index-${g.id}" inputmode="decimal"
                   value="${esc(fastEntry.indexes[g.id] || "")}" placeholder="—" aria-label="Starting index for ${esc(g.name)}">`}
          </span>
          <span class="fast-score">
            <input class="field tiny score" name="fast-score-${g.id}" inputmode="numeric"
              value="${esc(fastEntry.scores[g.id] || "")}" placeholder="—"
              aria-label="Score for ${esc(g.name)}" ${posted ? "disabled" : ""}>
          </span>
        </div>`;
      }).join("")}
    </div>

    <div class="inline-actions stacked" style="margin-top:0.9rem">
      <button class="btn" data-act="fast-post" id="fast-post">
        ${filled ? `Post ${filled} score${filled === 1 ? "" : "s"}` : "Post the scores"}
      </button>
    </div>
    <p class="hint">Only golfers with a score are posted. Leave the rest blank — nothing happens to them.
    Anybody with no index who is given one keeps it until they have three rounds of their own.</p>` : ""}
  </section>`;
}

/* Writes the game's result sheet when it differs from what is published. */
function publishSheetIfChanged(game, played, board) {
  const byRound = new Map(board.map((row) => [row.roundId, row]));
  const results = played.map((r) => {
    const row = byRound.get(r.id) || {};
    return { id: r.id, golferId: r.golferId, name: row.name || (golferById(r.golferId) || {}).name || "",
             date: r.date || "", gross: r.gross ?? null, adjusted: r.adjusted ?? null,
             courseHandicap: row.courseHandicap ?? r.courseHandicap ?? null, teeName: r.teeName || "",
             estimated: !!row.estimated };
  }).sort((a, b) => a.id.localeCompare(b.id));
  /* Compared with the keys in a fixed order: Firestore hands maps back with
     their keys in its own order, and a plain comparison would then differ
     forever and write on every redraw. Also written at most once per content
     per session, since this runs while the screen is being drawn. */
  const stable = (list) => JSON.stringify(list.map((o) => Object.keys(o).sort().map((k) => [k, o[k] ?? null])));
  const now = stable(results);
  const before = stable([...(game.results || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))));
  if (now !== before && publishedSheets.get(game.id) !== now) {
    publishedSheets.set(game.id, now);
    db.publishGameResults(game.id, results);
  }
}
const publishedSheets = new Map();   /* game id -> the sheet this session last published */

function gameDetail(gameId) {
  const game = games.find((g) => g.id === gameId);
  if (!game) { openGame = null; return screenGames(); }

  /* Version 2.0, Phase A: a regular member reads the result sheet published
     on the game (names and scores), never the players' rounds. Owners and
     admins work from the rounds and publish the sheet as they look at it. */
  const sheet = db.canManage() ? null : (game.results || []);
  const played = sheet || rounds.filter((r) => r.gameId === gameId);
  const people = sheet ? sheet.map((r) => ({ id: r.golferId, name: r.name })) : allGolfers;
  const multiDay = !!(game.endDate && game.endDate !== game.date);
  const standings = multiDay ? model.gameStandings(played, people, game) : { days: [], players: [] };
  /* allGolfers, not the roster. Somebody who played in this game but has since
     been taken off the roster must still appear in its result — a past
     leaderboard should not change because the roster did. */
  const board = model.gameLeaderboard(played, people);
  if (!sheet) publishSheetIfChanged(game, played, board);

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

  ${db.canManage() && !fastEntry ? `<section class="panel">
    <div class="inline-actions stacked">
      <button class="btn" data-act="fast-entry">Enter scores for everyone</button>
    </div>
    <p class="hint">One screen for the whole field — tick who played, type their scores, and every round is posted into this game at once.</p>
  </section>` : ""}

  ${db.canManage() && fastEntry ? fastEntryPanel(game) : ""}

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
      ${platform.canShare() ? `<button class="btn ghost" data-send="native">More apps…</button>` : ""}
    </div>
  </div>`;
  sheetEl.dataset.text = text;
  sheetEl.dataset.title = title;
  sheetEl.dataset.to = options.to || "";
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
      ${!golfers.length && db.canManage() && !db.readsOffline() ? `<div class="welcome" style="border:0;padding:1.4rem 1rem">
        <p style="margin:0 0 1rem">Nobody is on this roster yet. If your golfers already exist from before, put them back in one tap.</p>
        <div class="inline-actions stacked">
          <button class="btn" data-act="open-tool" data-tool="rebuild">Rebuild the roster</button>
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
          /* THREE STATES, NOT TWO.
           *
           * This row used to branch on linkedUid alone, so a golfer who had been
           * invited but had not joined yet looked exactly like one who had never
           * been invited at all — the button still read "Invite" and there was no
           * way to tell who you had already sent to. The invitation IS recorded:
           * noteInvitation writes invitedAt and invitedAs onto the golfer, and the
           * pending-invites list further down reads it. The row simply never did.
           *
           * The labels were wrong too. "Invited ✓" was shown for somebody who had
           * JOINED, which is a different and much better thing, and it left no
           * wording free for the state in between. */
          const joined = !!g.linkedUid;
          const waiting = !joined && !!g.invitedAt;
          const invitedOn = waiting
            ? new Date(g.invitedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })
            : "";
          return `<div class="roster-row">
            <div class="roster-name">
              <span class="name">${esc(g.name)}</span>
              <span class="sub">${g.handicapIndex == null ? "no index yet" : `index ${(+g.handicapIndex).toFixed(1)}`} · ${g.roundCount || 0} round${g.roundCount === 1 ? "" : "s"}${
                waiting ? ` · <span class="waiting">invited ${esc(invitedOn)}, not joined yet</span>` : ""}</span>
            </div>
            <div class="roster-actions">
            ${joined
              ? (db.isOwner()
                  ? `<button class="rowbtn wide" data-reinvite="${g.id}" title="Let them join again">Joined ✓</button>`
                  : `<button class="rowbtn wide" disabled>Joined ✓</button>`)
              /* The public group is joined by application only, never by invitation. */
              : db.isPublicGroup() ? ""
              : (waiting
                  ? `<button class="rowbtn wide" data-invite-golfer="${g.id}" title="Invited ${esc(invitedOn)} — send it again">Re-send</button>`
                  : `<button class="rowbtn wide primary" data-invite-golfer="${g.id}">Invite</button>`)}
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
      ${allCoursesForList().filter((c) => showHidden || !db.hiddenCourses().includes(c.id)).map((c) => {
        const open = openCourse === c.id;
        const used = rounds.some((r) => r.courseId === c.id);
        const hidden = db.hiddenCourses().includes(c.id);
        const mine = db.canEditCourse(c);
        return `<div${hidden ? ` class="dimmed"` : ""}>
          <button class="course-head" data-course="${c.id}" aria-expanded="${open}">
            <span class="grow"><span class="name">${esc(c.name)}</span><br>
              <span class="sub">${c.tees.length} tee${c.tees.length === 1 ? "" : "s"}${used ? " · in use" : ""}${hidden ? " · hidden" : ""}</span></span>
            <span class="chev">${open ? "▾" : "▸"}</span>
          </button>
          ${open ? `<div class="course-body">
            ${c.tees.map((t) => `<div class="teeline"><span>${esc(t.name)}</span><span>${(+t.rating).toFixed(1)} / ${t.slope} · par ${t.par}</span></div>`).join("")}
            ${db.canManage() ? `<div class="inline-actions">
              ${mine ? `<button class="rowbtn" data-edit-course="${c.id}">Edit</button>`
                : `<span class="hint">Entered by somebody else, so it cannot be edited here.</span>`}
              ${db.isOwner()
                ? (hidden
                    ? `<button class="rowbtn" data-unhide-course="${c.id}">Unhide</button>`
                    : (used
                        ? `<span class="hint">In use by this group, so it stays on the list.</span>`
                        : `<button class="rowbtn" data-hide-course="${c.id}">Hide</button>`))
                : ""}
            </div>` : ""}
          </div>` : ""}
        </div>`;
      }).join("")}
    </div>` : (courseDraft ? "" : `<div class="card"><p class="blank">No courses yet. Search for one by name, or type its rating and slope from the scorecard.</p></div>`)}
    ${db.hiddenCourses().length ? `<div class="style-switch"><button class="linkbtn" data-act="toggle-hidden-courses">${
      showHidden ? "Hide the hidden ones again" : `Show ${db.hiddenCourses().length} hidden course${db.hiddenCourses().length === 1 ? "" : "s"}`
    }</button></div>` : ""}
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
    ${db.canCreateGroups() ? `<div class="inline-actions stacked">
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

/* ======================= beta.4: Admin tabs and the cockpit =======================
   Approved by Willy (Oct 1): the Admin tab gets four tabs at its top. Every
   section of the old Admin page moves, unchanged, into one of them: People to
   Members (exactly as before), Group / Import / Backup / Course lookup /
   Account to Settings, Group requests / Applications / Reports to
   Applications. A group admin who is not the owner sees Cockpit and Members
   (plus Applications in the public group). */

function adminTabs() {
  const tabs = [{ id: "cockpit", label: "Cockpit" }];
  if (db.canCreateGroups() || db.isPublicGroup()) tabs.push({ id: "applications", label: "Applications" });
  tabs.push({ id: "members", label: "Members" });
  if (db.isOwner()) tabs.push({ id: "settings", label: "Settings" });
  return tabs;
}

function adminTabBar(tabs, active) {
  return `<div class="subtabs n${tabs.length}" role="tablist">${tabs.map((t) =>
    `<button class="subtab ${t.id === active ? "on" : ""}" role="tab" aria-selected="${t.id === active}" data-act="admin-tab" data-id="${t.id}">${t.label}${
      t.id === "applications" && waitingCount() ? ` <span class="subtab-count">${waitingCount()}</span>` : ""}</button>`).join("")}</div>`;
}

function waitingCount() {
  return (db.canCreateGroups() ? groupRequests.length : 0)
    + (db.isPublicGroup() ? applications.length + publicReports.length : 0);
}

const daysAgo = (ms) => {
  if (!ms) return "";
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return "Today";
  const d = Math.ceil((start.getTime() - ms) / 86400000);
  return d <= 1 ? "Yesterday" : `${d} days ago`;
};
const seenMs = (m) => (m && m.lastSeenAt ? (typeof m.lastSeenAt.toMillis === "function" ? m.lastSeenAt.toMillis()
  : (m.lastSeenAt.seconds ? m.lastSeenAt.seconds * 1000 : 0)) : (m && m.lastSeen) || 0);
const monthKey = (offset = 0) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function tile(n, label, warn = false) {
  return `<div class="ck-tile${warn ? " warn" : ""}"><span class="ck-num">${n}</span><span class="ck-lab">${label}</span></div>`;
}

/* ---- the mini cockpit: one group, from what the app already holds ---- */
function miniCockpitSection() {
  const now = Date.now();
  const week = now - 7 * 86400000;
  const claimed = new Set(members.map((m) => m.golferId).filter(Boolean));
  const waiting = sortedGolfers().filter((g) => g.invitedAt && !g.linkedUid && !claimed.has(g.id));
  const groupRounds = rounds.filter((r) => typeof r.date === "string");
  const thisMonth = groupRounds.filter((r) => r.date.slice(0, 7) === monthKey(0)).length;
  const lastMonth = groupRounds.filter((r) => r.date.slice(0, 7) === monthKey(-1)).length;
  const last = [...groupRounds].sort((a, b) => b.date.localeCompare(a.date))[0];
  const seen = [...members].sort((a, b) => seenMs(b) - seenMs(a));
  const active = members.filter((m) => seenMs(m) >= week).length;
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">${esc(association ? association.name : "This group")}</h2></div>
    <p class="hint" style="margin-top:0">This group only.</p>
    <div class="ck-tiles">
      ${tile(members.length, "Members")}
      ${tile(active, "Active in 7 days")}
      ${tile(waiting.length, "Invitations not used", waiting.length > 0)}
      ${tile(thisMonth, "Rounds this month")}
    </div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Last seen</h2></div>
    <div class="card list">${seen.map((m) => `<div class="list-row">
      <span class="grow"><span class="name">${esc(m.displayName || "Unnamed")}</span><br><span class="sub">${esc(m.role === "member" ? "member" : m.role)}</span></span>
      <span class="ck-when">${seenMs(m) ? daysAgo(seenMs(m)) : "Not seen yet"}</span></div>`).join("") || `<p class="blank">Nobody yet.</p>`}</div>
    <p class="hint">"Not seen yet" means not since this version, which started counting on its first day.</p>
  </section>
  ${waiting.length ? `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Never opened the app</h2></div>
    <div class="card list">${waiting.map((g) => `<div class="list-row person-row">
      <span class="grow"><span class="name">${esc(g.name)}</span><br><span class="sub">Invited${g.invitedAt ? ` ${esc(new Date(g.invitedAt).toLocaleDateString())}` : ""}</span></span>
      ${db.isPublicGroup() ? "" : `<button class="rowbtn" data-invite-golfer="${esc(g.id)}">Invite again</button>`}</div>`).join("")}</div>
  </section>` : ""}
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Rounds</h2></div>
    <div class="ck-tiles">${tile(thisMonth, "This month")}${tile(lastMonth, "Last month")}</div>
    <p class="hint">${last ? `Last round: ${esc((golferById(last.golferId) || {}).name || "a golfer")}, ${esc(last.date)}${last.courseName ? `, ${esc(last.courseName)}` : ""}.` : "No rounds yet."}</p>
  </section>`;
}

/* ---- the owner cockpit: every group (the group creator only) ---- */
let ownerCockpit = null;          /* loaded data, or null */
let ownerCockpitState = "idle";   /* idle | loading | ready | failed */
let ownerCockpitError = "";
let cockpitGroup = null;          /* a group opened from the Groups list */
let appSettings = null;           /* { mode, dailyLimit } for the Applications tab */

async function loadOwnerCockpitHere() {
  ownerCockpitState = "loading"; render();
  try {
    ownerCockpit = await db.loadOwnerCockpit();
    ownerCockpitState = "ready";
  } catch (e) {
    ownerCockpitState = "failed";
    ownerCockpitError = String((e && (e.code || e.message)) || "no connection");
  }
  if (!appSettings) { try { appSettings = await db.readApplicationSettings(); } catch {} }
  render();
}

function ownerSummary(data) {
  const now = Date.now();
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const people = new Map();
  for (const m of data.members) {
    const p = people.get(m.uid) || { uid: m.uid, name: m.displayName, lastSeen: 0, groups: [] };
    p.lastSeen = Math.max(p.lastSeen, m.lastSeen || 0);
    if (!p.name && m.displayName) p.name = m.displayName;
    p.groups.push(m.assocId);
    people.set(m.uid, p);
  }
  const everyone = [...people.values()];
  const groupName = new Map(data.groups.map((g) => [g.id, g.id === db.PUBLIC_ID ? "Public group" : g.name]));
  const byGroup = data.groups.map((g) => {
    const ms = data.members.filter((m) => m.assocId === g.id);
    const rs = data.rounds.filter((r) => r.assocId === g.id);
    const owner = ms.find((m) => m.uid === g.ownerUid) || ms.find((m) => m.role === "owner");
    const lastRound = rs.map((r) => r.date).sort().pop() || "";
    return {
      id: g.id, name: groupName.get(g.id), ownerUid: g.ownerUid,
      ownerName: g.ownerUid === data.me ? "you" : ((owner && owner.displayName) || "someone else"),
      members: ms.length, admins: ms.filter((m) => m.role === "admin").length,
      active30: ms.filter((m) => m.lastSeen >= now - 30 * 86400000).length,
      roundsThisMonth: rs.filter((r) => r.date.slice(0, 7) === monthKey(0)).length,
      lastRound,
      quiet: !rs.some((r) => r.date >= isoDaysAgo(90)),
    };
  }).sort((a, b) => (b.active30 - a.active30) || (b.roundsThisMonth - a.roundsThisMonth) || a.name.localeCompare(b.name));
  const months = [-5, -4, -3, -2, -1, 0].map((o) => {
    const k = monthKey(o);
    return { key: k, label: MONTH_SHORT[+k.slice(5, 7) - 1], count: data.rounds.filter((r) => r.date.slice(0, 7) === k).length };
  });
  return {
    people: everyone.length,
    active7: everyone.filter((p) => p.lastSeen >= now - 7 * 86400000).length,
    today: everyone.filter((p) => p.lastSeen >= startToday.getTime()).length,
    active30: everyone.filter((p) => p.lastSeen >= now - 30 * 86400000).length,
    notSeen: everyone.filter((p) => !p.lastSeen).length,
    recent: everyone.filter((p) => p.lastSeen).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 5)
      .map((p) => ({ ...p, groupLabel: p.groups.map((id) => groupName.get(id)).filter(Boolean).slice(0, 2).join(", ") })),
    groups: byGroup, months,
    roundsThisMonth: data.rounds.filter((r) => r.date.slice(0, 7) === monthKey(0)).length,
    notMine: byGroup.filter((g) => g.ownerUid !== data.me),
    quiet: byGroup.filter((g) => g.quiet),
  };
}
const isoDaysAgo = (n) => { const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function ownerCockpitSection() {
  if (ownerCockpitState === "idle") { setTimeout(loadOwnerCockpitHere, 0); return `<section class="panel"><p class="hint">Counting…</p></section>`; }
  if (ownerCockpitState === "loading" && !ownerCockpit) return `<section class="panel"><p class="hint">Counting…</p></section>`;
  if (ownerCockpitState === "failed" && !ownerCockpit) return `<section class="panel"><div class="note warn">The cockpit could not be counted (${esc(ownerCockpitError)}). The database rules for this version may not be published yet.</div>
    <div class="inline-actions stacked"><button class="btn ghost" data-act="cockpit-refresh">Try again</button></div></section>`;
  if (cockpitGroup) return otherGroupCockpit(cockpitGroup);
  const s = ownerSummary(ownerCockpit);
  const waitingApps = db.isPublicGroup() ? applications.length : null;
  const maxMonth = Math.max(1, ...s.months.map((m) => m.count));
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Cockpit</h2>
      <button class="linkbtn" data-act="cockpit-refresh">${ownerCockpitState === "loading" ? "Counting…" : "Refresh"}</button></div>
    <p class="hint" style="margin-top:0">All groups. Counted when you open it.</p>
    <div class="ck-tiles">
      ${tile(s.people, "Members, all groups")}
      ${tile(s.active7, "Active in 7 days")}
      ${tile(waitingCount(), "Waiting for you", waitingCount() > 0)}
      ${tile(s.roundsThisMonth, "Rounds this month")}
    </div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Sign-ins</h2></div>
    <div class="ck-tiles">
      ${tile(s.today, "Today")}
      ${tile(s.active30, "In 30 days")}
      ${tile(s.notSeen, "Not seen yet")}
      ${tile(s.groups.length, "Groups")}
    </div>
    ${s.recent.length ? `<div class="card list" style="margin-top:0.7rem">${s.recent.map((p) => `<div class="list-row">
      <span class="grow"><span class="name">${esc(p.name || "Unnamed")}</span><br><span class="sub">${esc(p.groupLabel)}</span></span>
      <span class="ck-when">${daysAgo(p.lastSeen)}</span></div>`).join("")}</div>` : ""}
    <p class="hint">"Not seen yet" counts from this version on; Firebase's own sign-in history is in cnt.txt.</p>
  </section>
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Waiting for you</h2></div>
    <div class="card list">
      <div class="list-row"><span class="grow name">Applications</span><span class="ck-when">${waitingApps == null ? "open the public group" : waitingApps}</span></div>
      <div class="list-row"><span class="grow name">Group requests</span><span class="ck-when">${groupRequests.length}</span></div>
      <div class="list-row"><span class="grow name">Switch, public group</span><span class="ck-when">${appSettings ? (appSettings.mode === "auto" ? "Auto" : "Manual") : "…"}</span></div>
    </div>
    <div class="inline-actions stacked"><button class="btn" data-act="admin-tab" data-id="applications">Open Applications</button></div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Groups</h2><span class="panel-count">${s.groups.length}</span></div>
    <div class="card list">${s.groups.map((g) => `<button class="list-row ck-group" data-act="cockpit-group" data-id="${esc(g.id)}">
      <span class="grow"><span class="name">${esc(g.name)}</span><br>
        <span class="sub">${g.members} member${g.members === 1 ? "" : "s"} · ${g.admins} admin${g.admins === 1 ? "" : "s"} · owner ${esc(g.ownerName)}${g.lastRound ? ` · last round ${esc(g.lastRound)}` : ""}</span></span>
      <span class="ck-when">${g.active30} active<br>${g.roundsThisMonth} rounds</span></button>`).join("")}</div>
    <p class="hint">Active = seen in the last 30 days. Rounds = this month. Tap a group to see it.</p>
  </section>
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Rounds, all groups</h2></div>
    ${ownerCockpit.roundsError ? `<div class="note">The rounds count needs a database index that the rules script adds. It appears once that has run.</div>` : `
    <div class="ck-bars" role="img" aria-label="Rounds per month, last 6 months">${s.months.map((m) => `<div class="ck-barcol">
      <span class="ck-barnum">${m.count}</span><span class="ck-bar" style="height:${Math.round((m.count / maxMonth) * 100)}%"></span><span class="ck-barlab">${m.label}</span></div>`).join("")}</div>
    <p class="hint">${MONTH_SHORT[new Date().getMonth()]} so far.</p>`}
  </section>
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Housekeeping</h2></div>
    <div class="card list">
      <div class="list-row"><span class="grow name">Groups quiet for 90 days</span><span class="ck-when">${s.quiet.length}</span></div>
      <div class="list-row"><span class="grow name">Groups not owned by you</span><span class="ck-when">${s.notMine.length}</span></div>
      <div class="list-row"><span class="grow"><span class="name">Old guest sign-ins</span><br><span class="sub">Counted by cnt.txt only</span></span></div>
    </div>
    ${s.notMine.length ? `<details class="danger-drawer" style="margin-top:0.6rem"><summary>See the ${s.notMine.length} groups not owned by you</summary>
      <div class="card list">${s.notMine.map((g) => `<div class="list-row"><span class="grow"><span class="name">${esc(g.name)}</span><br>
        <span class="sub">owner ${esc(g.ownerName)} · ${g.members} member${g.members === 1 ? "" : "s"}${g.lastRound ? ` · last round ${esc(g.lastRound)}` : " · no rounds in 6 months"}</span></span></div>`).join("")}</div></details>` : ""}
    <div class="inline-actions stacked"><button class="btn ghost" data-act="open-tool" data-tool="tidy">Open Tidy</button></div>
    <p class="hint">Nothing here deletes anything.</p>
  </section>`;
}

/* A group opened from the owner's Groups list (it may be one Willy is not in). */
function otherGroupCockpit(groupId) {
  const data = ownerCockpit;
  const g = data.groups.find((x) => x.id === groupId);
  const ms = data.members.filter((m) => m.assocId === groupId).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const rs = data.rounds.filter((r) => r.assocId === groupId);
  const week = Date.now() - 7 * 86400000;
  const lastRound = [...rs].sort((a, b) => b.date.localeCompare(a.date))[0];
  return `<section class="panel">
    <div class="inline-actions"><button class="btn ghost compact" data-act="cockpit-group" data-id="">Back to all groups</button></div>
    <div class="panel-head" style="margin-top:0.8rem"><h2 class="panel-title">${esc(g ? (g.id === db.PUBLIC_ID ? "Public group" : g.name) : "Group")}</h2></div>
    <div class="ck-tiles">
      ${tile(ms.length, "Members")}
      ${tile(ms.filter((m) => m.lastSeen >= week).length, "Active in 7 days")}
      ${tile(rs.filter((r) => r.date.slice(0, 7) === monthKey(0)).length, "Rounds this month")}
      ${tile(rs.filter((r) => r.date.slice(0, 7) === monthKey(-1)).length, "Rounds last month")}
    </div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Last seen</h2></div>
    <div class="card list">${ms.map((m) => `<div class="list-row">
      <span class="grow"><span class="name">${esc(m.displayName || "Unnamed")}</span><br><span class="sub">${esc(m.role)}</span></span>
      <span class="ck-when">${m.lastSeen ? daysAgo(m.lastSeen) : "Not seen yet"}</span></div>`).join("") || `<p class="blank">Nobody.</p>`}</div>
    <p class="hint">${lastRound ? `Last round: ${esc(lastRound.date)}${lastRound.courseName ? `, ${esc(lastRound.courseName)}` : ""}.` : "No rounds in the last 6 months."} To manage this group's people, open the group itself.</p>
  </section>`;
}

/* ---- the Applications tab ---- */
let blockLists = { emails: [], domains: [], names: [] };
let blockWatched = false;

function applicationsTab() {
  const parts = [];
  if (db.canCreateGroups()) parts.push(safe("Group requests", groupRequestsSection));
  if (db.isPublicGroup()) {
    if (!appSettings) setTimeout(async () => { appSettings = await db.readApplicationSettings(); render(); }, 0);
    if (!blockWatched && db.canManage()) { blockWatched = true; db.watchBlockList((l) => { blockLists = l; render(); }); }
    parts.push(safe("Switch", switchSection));
    parts.push(safe("Applications", applicationsSection));
    parts.push(safe("Reports", reportsSection));
    parts.push(safe("Block list", blockListSection));
  } else if (db.canCreateGroups()) {
    parts.push(`<section class="panel"><div class="note">Applications to the public group, its switch and its block list are here when the public group is open. Tap the group name at the top to switch to it.</div></section>`);
  }
  return parts.join("");
}

function switchSection() {
  const mode = appSettings ? appSettings.mode : null;
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Public group applications</h2></div>
    <div class="seg" role="radiogroup" aria-label="Applications switch">
      <button class="seg-b ${mode === "manual" ? "on" : ""}" role="radio" aria-checked="${mode === "manual"}" data-act="set-switch" data-id="manual">Manual</button>
      <button class="seg-b ${mode === "auto" ? "on" : ""}" role="radio" aria-checked="${mode === "auto"}" data-act="set-switch" data-id="auto">Auto</button>
    </div>
    <p class="hint">${mode === "auto"
      ? `Auto: when every check passes, the applicant is emailed a sign-in link. Tapping it confirms the email, they choose a password and they are in. Any failed check waits for you. At most ${appSettings.dailyLimit} a day.`
      : mode === "manual" ? "Manual: every application waits for you, as today." : "Reading the switch…"}</p>
  </section>`;
}

function blockListSection() {
  const kinds = [["emails", "Blocked emails", "name@example.com"], ["domains", "Blocked email domains", "example.com"], ["names", "Blocked names", "Full name"]];
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Block list</h2></div>
    <p class="hint" style="margin-top:0">An application matching any of these is never approved automatically; it waits for you.</p>
    ${kinds.map(([kind, title, ph]) => `<div class="card padded" style="margin-top:0.6rem">
      <div class="name">${title} <span class="panel-count">${blockLists[kind].length}</span></div>
      ${blockLists[kind].length ? `<div class="list">${blockLists[kind].map((k) => `<div class="list-row person-row">
        <span class="grow mono">${esc(k)}</span><button class="rowbtn warn" data-act="unblock" data-kind="${kind}" data-id="${esc(k)}">Remove</button></div>`).join("")}</div>` : `<p class="blank">None.</p>`}
      <div class="inline-actions" style="margin-top:0.5rem">
        <input class="field" name="block-${kind}" placeholder="${ph}" autocapitalize="none" style="flex:1 1 12rem">
        <button class="btn compact" data-act="block-add" data-kind="${kind}">Add</button>
      </div>
    </div>`).join("")}
  </section>`;
}

function settingsTab() {
  return `${safe("Group", groupSection)}
  ${safe("Backup", backupSection)}
  ${safe("Course lookup", lookupSection)}
  ${safe("Account", accountSection)}`;
}

/* ---- My season (regular members, top of Summary): their own data only ---- */
function mySeasonCard() {
  const mine = db.myGolferId(rawGolfers);
  if (!mine) return "";
  const golfer = golferById(mine);
  if (!golfer) return "";
  const myRounds = rounds.filter((r) => r.golferId === mine && typeof r.date === "string");
  const year = String(new Date().getFullYear());
  const thisYear = myRounds.filter((r) => r.date.startsWith(year)).length;
  const now = shownIndex(golfer);
  const cutoff = isoDaysAgo(183);
  let window = [];
  for (const r of [...myRounds].filter((r) => r.date <= cutoff && Number.isFinite(+r.differential)).sort((a, b) => a.date.localeCompare(b.date))) {
    window = model.insertIntoWindow(window, { roundId: r.id, date: r.date, differential: +r.differential, assocId: r.assocId });
  }
  const then = window.length >= 3 ? model.displayIndex(window) : null;
  /* The trend compares this group's rounds with this group's rounds (the
     index shown above is the golfer's own, from every group). */
  let all = [];
  for (const r of [...myRounds].filter((r) => Number.isFinite(+r.differential)).sort((a, b) => a.date.localeCompare(b.date))) {
    all = model.insertIntoWindow(all, { roundId: r.id, date: r.date, differential: +r.differential, assocId: r.assocId });
  }
  const nowHere = all.length >= 3 ? model.displayIndex(all) : null;
  const move = nowHere != null && then != null ? Math.round((nowHere - then) * 10) / 10 : null;
  return `<section class="panel my-season">
    <div class="panel-head"><h2 class="panel-title">My season</h2></div>
    <div class="ck-tiles">
      ${tile(thisYear, `Rounds in ${year}`)}
      ${tile(now == null ? "–" : now.toFixed(1), "Handicap index now")}
    </div>
    <p class="hint">${move == null ? "Your 6-month trend appears once you have rounds from 6 months ago."
      : move === 0 ? "Your index is the same as 6 months ago."
      : move < 0 ? `Your index is down ${Math.abs(move).toFixed(1)} since 6 months ago. Well played.`
      : `Your index is up ${move.toFixed(1)} since 6 months ago.`}${move == null ? "" : " Based on your rounds in this group."}</p>
  </section>`;
}

function screenAdmin() {
  /* Somebody who manages nothing still needs the password form if they have
     a role on this device only; otherwise this tab is not theirs. */
  if (!db.canManage()) {
    if (db.needsPassword()) {
      return `${flashBar()}
        ${safe("Set a password", passwordPrompt)}
        ${versionBlock()}`;
    }
    return empty("Not your area", "Only the group owner manages people and settings.");
  }

  /* beta.4: the four tabs. "Set a password" stays above them, on every tab,
     until it is done. */
  const tabs = adminTabs();
  if (!tabs.some((t) => t.id === adminTab)) adminTab = "cockpit";
  let body = "";
  if (adminTab === "cockpit") body = db.canCreateGroups() ? safe("Cockpit", ownerCockpitSection) : safe("Cockpit", miniCockpitSection);
  else if (adminTab === "applications") body = applicationsTab();
  else if (adminTab === "members") body = db.isOwner() ? safe("People", peopleSection) : safe("Members", adminMembersSection);
  else if (adminTab === "settings") body = settingsTab();
  return `${flashBar()}
  ${db.needsPassword() ? safe("Set a password", passwordPrompt) : ""}
  ${adminTabBar(tabs, adminTab)}
  ${body}
  ${versionBlock()}`;
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
        ${people.length ? people.map((p) => `<div class="list-row person-row">
          <span class="grow"><span class="name">${esc(p.name)}</span><br>
            <span class="sub">${roleLabel(p.role)}${p.you ? " · you" : ""} ·
              <span class="invite-state ${p.state}">${p.state === "joined" ? "invitation used" : "not used yet"}</span>${
                p.extras.length ? ` · <span class="invite-state waiting">${p.extras.length} older sign-in${p.extras.length === 1 ? "" : "s"}</span>` : ""
              }</span></span>
          ${p.state === "joined" && p.role !== "owner"
            ? `<button class="rowbtn" data-role="${p.key}:${p.role === "admin" ? "member" : "admin"}">${p.role === "admin" ? "Make guest" : "Make admin"}</button>
               <button class="rowbtn warn" data-drop-member="${p.key}">Remove</button>`
            : p.state === "waiting" && !db.isPublicGroup()
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

      ${db.isPublicGroup() ? `<div class="inline-form bordered">
        <p class="hint" style="margin:0">People join the public group only by applying — see
        <b>Applications</b> above. There are no invitation links or codes for it. To make somebody a
        reviewer, tap <b>Make admin</b> beside their name.</p>
      </div>` : `<div class="inline-form bordered">
        <p class="hint" style="margin:0 0 0.7rem">Invitations for people who play are on the
        <b>Manage</b> tab, beside each name — that way the link carries their name and ties them to
        their existing rounds.</p>
        <p class="hint" style="margin:0 0 0.7rem"><b>An administrator who does not play?</b> This adds
        the role only — no golfer, no place on the roster.</p>
        <div class="inline-actions">
          <button class="btn compact" data-act="invite-nonplayer">Invite an admin who doesn't play</button>
          <button class="btn ghost compact" data-act="show-code">Show the code</button>
        </div>
      </div>`}
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
    <p class="hint"><button class="linkbtn" data-act="open-tool" data-tool="rebuild">Rebuild the roster</button> · <button class="linkbtn" data-act="open-tool" data-tool="tidy">Check and tidy the data</button> · <button class="linkbtn" data-act="open-tool" data-tool="cleanup">Clean up unused groups</button></p>
    ${platform.isApp() ? `<p class="hint">Opens in Safari. Sign in there with the owner's email if asked.</p>` : ""}
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
      ${platform.canShare() ? `<button class="btn ghost" data-send="native">More apps…</button>` : ""}
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

  /* Inside the iPhone app: write the file, confirm it is really written, then
     open the share sheet with it. The sheet stays open with a clear message if
     the write fails — nothing is reported as saved that wasn't. */
  if (platform.isApp()) {
    try {
      await platform.saveFile(name, text, sheetEl.dataset.title || "Scorecard backup");
      sheetEl.hidden = true;
      flashMsg("Choose Save to Files, then pick iCloud Drive or any folder you like.");
      render();
    } catch (e) {
      if (e && /cancel/i.test(String(e.message || e))) return;   /* they closed the share sheet */
      flashMsg("The backup was NOT saved: " + ((e && e.message) || "the file could not be written") + ". Try Email or Copy instead.");
    }
    return;
  }

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
          <div class="note"><b>One step left.</b> No password is set on this account yet. Set one so you can sign in on your other devices.</div>
          <label class="lbl">Password for this app</label>
          <input class="field" name="password" type="password" placeholder="Invent one, at least 6 characters" autocomplete="new-password">
          <div class="inline-actions stacked">
            <button class="btn" data-act="set-password" ${joining ? "disabled" : ""}>${joining ? "Setting…" : "Set the password"}</button>
          </div>
          <p class="hint"><b>Not the password for your email account.</b> This is a new one, for this app only. Write it down — you will type it on every other device, with the email above.</p>
        `}

        ${db.deletionPending() ? "" : `<div class="inline-actions stacked">
          <button class="btn ${confirmSignOut ? "danger" : "ghost"}" data-act="sign-out">
            ${confirmSignOut ? "Tap again to sign out" : "Sign out of this device"}
          </button>
        </div>`}
        <p class="hint">${confirmSignOut
          ? "Nothing is deleted — this device simply returns to the first screen. Wait a few seconds to cancel."
          : "Signing out deletes nothing. It returns this device to the first screen."}</p>
      </div>
    </section>`;
  }

  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Account</h2></div>
    <div class="card padded">
      <div class="name">Sign in as the owner</div>
      <div class="note"><b>Sign in with the owner's email address.</b> Use the email and the Scorecard password you set as owner — not your email account's password. Signing in with any other email opens a different account that does not own this group.</div>
      ${db.canManage() ? `<p class="hint">Your role only lasts on this device until you sign in.</p>` : ""}

      <label class="lbl">Email</label>
      <input class="field" name="email" type="email" value="${esc(authForm.email)}" placeholder="you@example.com" autocomplete="username" autocapitalize="none">
      <label class="lbl">Password for this app</label>
      <input class="field" name="password" type="password" placeholder="Your Scorecard password" autocomplete="current-password">
      <div class="inline-actions stacked">
        <button class="btn" data-act="sign-in" ${joining ? "disabled" : ""}>${joining ? "Signing in…" : "Sign in"}</button>
      </div>
      <p class="hint"><b>Not your email password.</b> The Scorecard password, for this app only.</p>
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

/* How many of this group's rounds were played off a given tee.
   Used to lock the Remove button: taking away a tee that rounds point at
   leaves them naming something the course no longer has. */
const roundsOnTee = (courseId, teeId) =>
  rounds.filter((r) => r.courseId === courseId && r.teeId === teeId).length;

function courseEditor() {
  const d = courseDraft;
  const editing = !!d.editing;
  return `<div class="card editor">
    <div class="editor-title">${editing ? "Edit course" : "New course"}</div>
    ${editing ? `<div class="note tip">Rounds already posted here keep the rating and slope they were
      played on — those are frozen onto each round and nothing here changes them. New rounds will use
      what you save now.</div>` : ""}
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
          <span class="sub">${esc(c.where || "")}</span></span>
        <span class="chev">›</span></button>`).join("")}
    </div>` : ""}

    <label class="lbl">Course name</label>
    <input class="field" name="c-name" value="${esc(d.name)}" placeholder="Royal Ontario">

    <label class="lbl">Tees</label>
    ${d.tees.map((t, i) => {
      const inUse = editing ? roundsOnTee(d.id, t.id) : 0;
      return `<div class="tee-row">
      <div class="tee-head">
        <input class="field" data-tee-field="${i}:name" value="${esc(t.name)}" placeholder="Tee name, e.g. Blue">
        ${d.tees.length > 1
          ? (inUse
              ? `<span class="hint">${inUse} round${inUse === 1 ? "" : "s"} — cannot remove</span>`
              : `<button class="rowbtn warn" data-rm-tee="${i}">Remove</button>`)
          : ""}
      </div>
      <div class="tee-nums">
        <label>Rating<input class="field mono" data-tee-field="${i}:rating" value="${esc(t.rating)}" inputmode="decimal"></label>
        <label>Slope<input class="field mono" data-tee-field="${i}:slope" value="${esc(t.slope)}" inputmode="numeric"></label>
        <label>Par<input class="field mono" data-tee-field="${i}:par" value="${esc(t.par)}" inputmode="numeric"></label>
      </div>
    </div>`;
    }).join("")}
    <button class="linkbtn" data-act="add-tee">Add another tee</button>

    <div class="inline-actions stacked editor-actions">
      <button class="btn" data-act="save-course">${editing ? "Save changes" : "Save course"}</button>
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
  /* beta.5: signed out, only the links (the counts mean nothing yet). */
  if (!db.hasUser()) {
    return `<section class="version">
    <div class="sub"><button class="linkbtn" data-act="open-user-guide">User guide</button> · <button class="linkbtn" data-act="open-support">Support</button> · <button class="linkbtn" data-act="open-privacy">Privacy</button> · <button class="linkbtn" data-act="terms-view">Terms</button></div>
    <div class="sub">The Scorecard <span class="mono">v${VERSION}</span></div>
  </section>`;
  }
  return `<section class="version">
    <div><b>The Scorecard</b> <span class="mono">v${VERSION}</span></div>
    <div class="sub">${rounds.length} round${rounds.length === 1 ? "" : "s"} · ${golfers.length} golfer${golfers.length === 1 ? "" : "s"} · ${courses.length} course${courses.length === 1 ? "" : "s"}</div>
    <div class="sub">${esc(sync.text)} · World Handicap System, best 8 of last 20</div>
    <div class="sub"><button class="linkbtn" data-act="open-user-guide">User guide</button> · <button class="linkbtn" data-act="open-support">Support</button> · <button class="linkbtn" data-act="open-privacy">Privacy</button> · <button class="linkbtn" data-act="terms-view">Terms</button></div>
    ${db.hasUser() ? `<div class="sub"><button class="linkbtn" data-act="delete-account">Delete my account</button></div>` : ""}
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

/* ================= Delete my account (Change 7) ================= */

function openDeleteAccount({ resume = false, problem = "" } = {}) {
  const needsPassword = db.hasPassword() && !(db.currentEmail() || "").startsWith("delete-");
  const blockers = db.deletionBlockers();
  sheetEl.hidden = false;
  sheetEl.dataset.report = "";
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2>${resume ? "Your account isn't deleted yet" : "Delete your account?"}</h2>
      <button class="rowbtn" data-close="1">${resume ? "Later" : "Keep it"}</button>
    </div>
    ${problem ? `<div class="note warn">${esc(problem)}</div>` : ""}
    ${resume
      ? `<p class="lead">The deletion you started didn't finish. You are still signed in. Tap Try again to finish it — if it keeps failing, it finishes automatically within a day.</p>`
      : `<p class="lead">Your email and sign-in are deleted and you leave every group. Your golfer name, rounds and handicap stay with the group so its history and handicaps stay correct, and an admin can keep entering your scores. This can't be undone.</p>`}
    ${!resume && blockers.abandoned ? `<div class="note warn"><b>${blockers.abandoned} earlier change${blockers.abandoned === 1 ? "" : "s"} could not be saved.</b> They will never upload. Dismiss them to continue.
      <div class="inline-actions stacked"><button class="btn ghost" data-del="dismiss">Dismiss them</button></div></div>` : ""}
    ${needsPassword ? `<label class="lbl">Your Scorecard password</label>
      <input class="field" name="delete-password" type="password" autocomplete="current-password" placeholder="To confirm it's you">` : ""}
    <div class="inline-actions stacked">
      <button class="btn danger" data-del="go">${resume ? "Try again" : "Delete my account"}</button>
      ${resume ? "" : `<button class="btn ghost" data-close="1">Keep it</button>`}
    </div>
  </div>`;
}

/* Version 2.0 Phase C: the report, block and approve sheets. */
sheetEl.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-pc]");
  if (!t) return;
  const { pc, id } = t.dataset;
  if (pc === "report") {
    const golfer = allGolfers.find((g) => g.id === id) || golferById(id) || {};
    const reason = ((sheetEl.querySelector('[name="report-reason"]') || {}).value || "").trim();
    sheetEl.hidden = true;
    busy("Sending the report");
    try { await db.reportGolfer({ golferId: id, displayName: golfer.name || "", reason }); flashMsg("Report sent to the people who run the public group. Thank you."); }
    catch { flashMsg("The report was not sent. Check the connection and try again."); }
    finally { idle(); }
    return render();
  }
  if (pc === "block") {
    const golfer = allGolfers.find((g) => g.id === id) || golferById(id) || {};
    sheetEl.hidden = true;
    busy("Blocking");
    try { await db.blockGolfer({ golferId: id, name: golfer.name || "" }); flashMsg(`${golfer.name || "They"} will no longer appear on your screens.`); }
    catch { flashMsg("Couldn't block — the message above says why."); }
    finally { idle(); }
    return render();
  }
  if (pc === "approve") {
    const a = applications.find((x) => x.key === id);
    const name = ((sheetEl.querySelector('[name="approve-name"]') || {}).value || "").trim();
    if (!a) { sheetEl.hidden = true; return render(); }
    if (name.length < 2) { flashMsg("Type their golfer name"); return; }
    sheetEl.hidden = true;
    busy(`Approving ${a.fullName}`);
    try {
      const result = await db.approveApplication({ application: a, golferName: name });
      flashMsg(result.already
        ? `${a.fullName} was already approved. Nothing more to do.`
        : result.emailFailed
          ? `${a.fullName} is approved, but the password email did not send. Use "Send the email again" under Applications.`
          : result.existingAccount
            ? `${a.fullName} is approved. They already had an account: they sign in with it (the email also lets them choose a new password), then confirm their email to join.`
            : `${a.fullName} is approved. The email to choose a password has gone to ${a.email}.`);
    } catch (err) {
      const code = String((err && (err.code || err.message)) || "");
      if (code.includes("name-taken")) { flashMsg(`The name "${name}" is already used. Add a middle initial or a nickname and approve again.`); openApproveSheet(id); }
      else if (code.includes("app/busy")) flashMsg("Another reviewer is approving this application right now. Nothing was changed.");
      else if (code.includes("app/rejected")) flashMsg("This application was rejected, so it cannot be approved.");
      else if (code.includes("app/gone")) flashMsg("This application no longer exists.");
      else flashMsg(`The approval did not finish: ${code || "no connection"}. Tap Finish to complete it — it is safe to repeat.`);
    } finally { idle(); }
    return render();
  }
});

sheetEl.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-del]");
  if (!button) return;
  if (button.dataset.del === "dismiss") { db.dismissAbandoned(); return openDeleteAccount(); }
  if (button.dataset.del !== "go") return;
  const password = ((sheetEl.querySelector('[name="delete-password"]') || {}).value) || "";
  const resume = db.deletionPending();
  button.disabled = true;
  busy("Deleting your account");
  let result;
  try {
    result = await db.deleteMyAccount({ password, onStep: (step) => { note(`deleting: ${step}`); busyWhat = step; paintBusy(); } });
  } finally { idleAll(); }
  /* beta.9: recorded but not finished — they are already signed out. */
  if (result && result.reason === "PENDING") {
    note(`deletion stopped at: ${result.step || "?"}`);
    return showBeingDeleted(result.message);
  }
  if (result && result.ok) {
    sheetEl.hidden = false;
    sheetEl.innerHTML = `<div class="sheet-body"><h2>Your account has been deleted</h2>
      <p class="lead">Your sign-in is gone and you have left every group. This app will now start fresh.</p>
      <div class="inline-actions stacked"><button class="btn" data-del="restart">Done</button></div></div>`;
    return;
  }
  openDeleteAccount({ resume: db.deletionPending() || resume, problem: (result && result.message) || "Something went wrong. Nothing was reported as deleted." });
});
sheetEl.addEventListener("click", (e) => {
  if (e.target.closest('[data-del="restart"]')) location.reload();
});

/* beta.9: an account whose deletion has started is never used again. The
   person is signed out and told; the completion job finishes the rest. */
function showBeingDeleted(detail) {
  sheetEl.hidden = false;
  sheetEl.dataset.report = "";
  sheetEl.innerHTML = `<div class="sheet-body centred">
    <h2>This account is being deleted</h2>
    <p class="lead">${esc(detail || "You have been signed out. The deletion finishes by itself within 20 minutes.")}</p>
    <p class="hint">Nothing more is needed from you. After that, this email can be used again for a new account.</p>
    <div class="inline-actions stacked"><button class="btn" data-del="restart">Done</button></div>
  </div>`;
  render();
}
async function refuseDeletingAccount() {
  note("sign-in refused: this account is being deleted");
  await db.signOutHere();
  accountMode = null;
  showBeingDeleted("You have been signed out. Its deletion finishes by itself within 20 minutes; it cannot be used meanwhile.");
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
      platform.openExternal(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(sheetEl.dataset.subject || "BUG")}&body=${encodeURIComponent(context())}`);
    }
    return;
  }

  if (what === "email") {
    platform.openExternal(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(sheetEl.dataset.subject || "BUG")}&body=${encodeURIComponent(context())}`);
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
  /* Phase C: admins of the PUBLIC group review applications on this tab;
     the count of waiting ones is shown on it. */
  /* Phase D: admins have the tab too, to remove regular members (and, in the
     public group, to review applications and reports). */
  if (db.isOwner() || db.canManage()) {
    const waiting = db.isPublicGroup() ? applications.length + publicReports.length : 0;
    tabs.push(["admin", waiting ? `Admin (${waiting})` : "Admin", "★"]);
  }
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

/* A guest who has just been made an admin has no password, and no reason to
   visit the tab where the form lives. Tell them the moment their role changes,
   wherever they happen to be. */
function checkPromotion() {
  if (toldAboutPromotion) return;
  if (!ready) return;
  if (typeof db.myRole !== "function" || !db.myRole()) return;

  /* Remember the role even when nothing needs saying, so a later promotion is
     recognised as a change rather than looking like it was always so. */
  if (!db.needsPassword()) {
    try { localStorage.setItem(`golf:v2:lastRole:${db.currentAssociation() || ""}`, db.myRole()); }
    catch {}
    return;
  }

  toldAboutPromotion = true;

  /* Was this a PROMOTION, or have they simply always been an admin without a
     password? The wording must not claim something that did not just happen. */
  const roleKey = `golf:v2:lastRole:${db.currentAssociation() || ""}`;
  let before = "";
  try { before = localStorage.getItem(roleKey) || ""; } catch {}
  const now = db.myRole();
  try { localStorage.setItem(roleKey, now); } catch {}

  const justPromoted = before === "member" && (now === "admin" || now === "owner");

  openPasswordSheet({
    heading: justPromoted ? "You are now an admin" : "Set a password",
    because: justPromoted
      ? "You can manage this group from now on. Setting a password means the role follows you to any device — without one it lives only in this browser, and cannot be recovered if it is cleared."
      : "You can manage this group, but only from this browser. A password means the role follows you to any device, and survives the browser's data being cleared.",
    allowLater: true,
  });
}

function render({ force = false } = {}) {
  if (!force && dateFieldIsOpen()) {
    redrawWanted = true;
    /* Update only what can be changed without touching the panel, so the
       screen is not stale while the picker is up. */
    try {
      const btn = document.getElementById("statusBtn");
      const sync = db.status();
      if (btn) paintStatus(btn, sync);
      paintBusy();
      paintAlert();
    } catch { /* cosmetic only */ }
    return;
  }
  redrawWanted = false;
  const drawn = renderNow();
  recordTermsOnAccount();
  checkPromotion();
  return drawn;
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
    if (!termsAccepted() || termsState === "viewing") {
      tabsEl.innerHTML = "";
      view.innerHTML = screenTerms();
      document.getElementById("brandSub").textContent = "Terms of Use";
    } else if (!ready || settling) {
      view.innerHTML = bootCard();
    } else if (db.isAnonymousSession()) {
      tabsEl.innerHTML = "";
      view.innerHTML = screenUpgrade();
      document.getElementById("brandSub").textContent = "Handicap tracking";
    } else if (!db.currentAssociation()) {
      tabsEl.innerHTML = "";
      view.innerHTML = screenJoin();
      document.getElementById("brandSub").textContent = "Getting started";
    } else {
      const allowed = visibleTabs().map(([id]) => id);
      if (returnTo) {
        if (allowed.includes(returnTo.tab)) { tab = returnTo.tab; if (returnTo.adminTab) adminTab = returnTo.adminTab; returnTo = null; }
        else if (Date.now() > returnTo.until) returnTo = null;
      }
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
  paintStatus(document.getElementById("statusBtn"), sync);
  paintBusy();
  paintAlert();
  if (window.__scorecardBooted) window.__scorecardBooted();
}

/* beta.4: the status pill. On a narrow screen a plain "Connected" shrinks to
   a green dot (tap it for the words), so the header always fits on one line;
   anything else (offline, waiting writes, a problem) keeps its words. */
function paintStatus(btn, s) {
  if (!btn) return;
  const text = String((s && s.text) || "");
  const plain = text === "Connected" && !(s && s.alert);
  btn.innerHTML = `<span class="status-dot" aria-hidden="true"></span><span class="status-label">${esc(text)}</span>`;
  btn.classList.toggle("alert", !!(s && s.alert));
  btn.classList.toggle("plain", plain);
  btn.setAttribute("aria-label", text);
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
      ${db.deletionPending() ? "" : `<button class="btn ghost warn" data-quick="signout">Sign out of this device</button>`}
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
  const n = e.target.name || "";
  /* Typed into the fast-entry grid. The value is remembered and the button
     label updated IN PLACE — redrawing here would move the keyboard and lose
     the cursor between every digit. */
  if (n.startsWith("fast-score-") || n.startsWith("fast-index-")) {
    if (!fastEntry) return;
    /* Digits only, and a single decimal point for an index. Typing a letter
       into a score should simply not appear. */
    /* This block moved here from the change listener in 2.21.3 and left `v`
       behind — it was declared there, not here. Every keystroke threw
       ReferenceError before a single character could be filtered, which is why
       letters still got through AND an error was logged. */
    const v = String(e.target.value == null ? "" : e.target.value);
    const digitsOnly = n.startsWith("fast-score-");
    const cleaned = digitsOnly
      ? v.replace(/[^0-9]/g, "").slice(0, 3)
      : v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 4);
    if (cleaned !== v && e.target) e.target.value = cleaned;

    const id = n.replace(/^fast-(score|index)-/, "");
    if (digitsOnly) fastEntry.scores[id] = cleaned;
    else fastEntry.indexes[id] = cleaned;

    const button = document.getElementById("fast-post");
    if (button) {
      const count = Object.values(fastEntry.scores).filter((x) => +x > 0).length;
      button.textContent = count ? `Post ${count} score${count === 1 ? "" : "s"}` : "Post the scores";
    }
    return;
  }
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
  if (n === "fast-tee") { if (fastEntry) fastEntry.teeId = v; return render(); }

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

view.addEventListener("change", (e) => {
  if (e.target && e.target.matches && e.target.matches("[data-terms-tick]")) {
    const btn = document.getElementById("termsAccept");
    if (btn) btn.disabled = !e.target.checked;
  }
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
      const raw = field ? field.value.trim() : "";
      /* The iPhone's number pad has no hyphen at all, so any separator is
         accepted — slash, dot, space — and plain digits too. Insisting on one
         punctuation mark the keyboard cannot produce is not a validation rule,
         it is a trap. */
      const digits = raw.replace(/\D/g, "");
      let typed = "";
      if (digits.length === 8) {
        typed = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
      }
      if (!typed) {
        flashMsg("Type the date as year, month, day — for example 2025 05 18");
        return render();
      }
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
  if (d.dropMember) {
    /* Removes a person's access to this group. A membership is only a sign-in
       record — their golfer, their rounds and their handicap are untouched, and
       they can be invited again. The owner's own row never offers this. */
    const who = members.find((m) => m.uid === d.dropMember);
    busy("Removing them from this group");
    try {
      await db.removeMemberships([d.dropMember]);
      flashMsg(`${(who && who.displayName) || "They"} no longer have access. Their rounds and handicap are untouched.`);
    } catch {
      idleAll();
      openProblem({
        title: "Could not remove them",
        detail: "The database refused it.",
        advice: "Nothing was changed. Send this report and it will say what refused it.",
      });
    } finally { idleAll(); }
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
      ${db.isOwner() ? `<label class="checkline">
        <input type="radio" name="invite-role" value="admin">
        <span><b>Admin</b> — also manages the roster and posts for anybody. Sets a password.</span>
      </label>` : ""}
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

  if (d.editCourse) {
    const c = courses.find((x) => x.id === d.editCourse);
    if (!c) return;
    if (!db.canEditCourse(c)) {
      openProblem({
        title: "This course was entered by somebody else",
        detail: "Courses are shared across every group, so only whoever added one may change it.",
        advice: "Add it again under your own name if you need different figures — rounds already posted keep the numbers they were played on either way.",
      });
      return;
    }
    /* The existing tee ids are carried through UNCHANGED. Rounds point at a tee
       by id, so minting new ones here would quietly detach every round from
       the tee it was played off. */
    courseDraft = {
      id: c.id,
      editing: true,
      createdBy: c.createdBy,
      name: c.name,
      tees: c.tees.map((t) => ({
        id: t.id, name: t.name,
        rating: String(t.rating), slope: String(t.slope), par: String(t.par),
      })),
    };
    finder = { q: "", results: [], busy: false, msg: "" };
    openCourse = null;
    return render();
  }

  if (d.hideCourse || d.unhideCourse) {
    const id = d.hideCourse || d.unhideCourse;
    const c = courses.find((x) => x.id === id);
    /* Refused rather than hidden: a course this group has played would take its
       rounds out of every picker, and an old round could not then be edited. */
    if (d.hideCourse && rounds.some((r) => r.courseId === id)) {
      flashMsg("This group has rounds on that course, so it stays on the list.");
      return render();
    }
    note(d.hideCourse ? "hiding a course" : "bringing a course back");
    db.setCourseHidden(id, !!d.hideCourse);
    idle();
    flashMsg(d.hideCourse
      ? `${c ? c.name : "That course"} hidden from this group's list.`
      : `${c ? c.name : "That course"} is back on the list.`);
    return render();
  }
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
    const chosen = finder.results[+d.pick];
    if (!chosen) return;

    /* The tees are NOT in the search result — the provider sends only a count
       there and requires the course to be fetched by id for the real data.
       So picking a course makes the second call. */
    /* Never while editing: the name you already have is the one you recognise,
       and the fetch may yet fail and leave a stranger's spelling behind. */
    if (!courseDraft.editing) courseDraft.name = chosen.name;
    finder = { ...finder, busy: true, msg: `Fetching the tees for ${chosen.name}…` };
    render();

    let full = chosen;
    if (chosen.id) {
      try {
        full = await lookup.courseById(chosen.id);
      } catch (err) {
        finder = {
          q: finder.q, results: finder.results, busy: false,
          msg: lookup.explain(err && err.message),
        };
        /* The name is still filled in, so the tees can be typed by hand. */
        return render();
      }
    }

    /* ALREADY ON THE LIST?
     *
     * Picking a course you already have used to add a SECOND copy under the
     * same name, and there was then no way to tell them apart. So it switches
     * to updating the one that exists — same course id, so every round posted
     * on it stays attached — and the NAME YOU ALREADY HAVE is kept, because
     * that is the one you recognise. */
    const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
    const mine = courseDraft.editing
      ? courses.find((c) => c.id === courseDraft.id)
      : courses.find((c) => same(c.name, full.name || chosen.name));

    /* Tee ids are matched by NAME and carried over. A round points at a tee by
       id, so a fresh id would detach it from the tee it was played off. */
    const existingTees = (mine && mine.tees) || [];
    const teeIdFor = (name) => {
      const hit = existingTees.find((t) => same(t.name, name));
      return hit ? hit.id : model.newId();
    };

    if (mine && !db.canEditCourse(mine)) {
      finder = {
        q: finder.q, results: [], busy: false,
        msg: `${mine.name} is already on the list and was entered by somebody else, so it cannot be updated here.`,
      };
      return render();
    }

    courseDraft = {
      id: mine ? mine.id : courseDraft.id,
      editing: !!mine,
      createdBy: mine ? mine.createdBy : undefined,
      /* The name you already have wins. */
      name: mine ? mine.name : (full.name || chosen.name),
      tees: full.tees.map((t2) => ({
        id: teeIdFor(t2.name),
        name: t2.name,
        rating: String(t2.rating),
        slope: String(t2.slope),
        par: String(t2.par),
      })),
    };

    finder = {
      q: "", results: [], busy: false,
      msg: mine
        ? `You already have ${mine.name}. Saving will update its ${full.tees.length} tee${full.tees.length === 1 ? "" : "s"} and keep the name — check them against the scorecard.`
        : `Filled in ${full.tees.length} tee${full.tees.length === 1 ? "" : "s"} — check them against the scorecard.`,
    };
    return render();
  }

  switch (d.act) {
    case "terms-accept": {
      const tick = view.querySelector("[data-terms-tick]");
      if (!tick || !tick.checked) { flashMsg("Tick \u201cI have read and agree\u201d first"); return; }
      termsAcceptedNow = true;
      termsState = "";
      try { localStorage.setItem(TERMS_KEY, JSON.stringify({ version: TERMS_VERSION, at: Date.now() })); } catch { /* asked again next time */ }
      window.scrollTo(0, 0);
      recordTermsOnAccount();
      return render();
    }
    case "terms-decline": termsState = "declined"; window.scrollTo(0, 0); return render();
    case "terms-again": termsState = ""; return render();
    case "terms-view": termsState = "viewing"; window.scrollTo(0, 0); return render();
    case "terms-close": termsState = ""; return render();
    case "look-again": {
      /* A membership can exist while its pointer is missing, so this searches
         the memberships themselves rather than the pointer list — and repairs
         the pointer if it finds one. */
      busy("Looking for your groups");
      try {
        const mine = await db.loadMyGroups();
        if (mine.length) {
          await settleGroup(mine[0].id);
          idleAll();
          flashMsg(`Found ${mine.length} group${mine.length === 1 ? "" : "s"}. You are back in.`);
          return render();
        }
        idleAll();
        /* Say WHY, when there is a why. A search that failed is a completely
           different situation from an account that genuinely belongs nowhere,
           and telling somebody the second when the first is true leaves them
           stuck on this screen. */
        const why = typeof db.groupLookupError === "function" ? db.groupLookupError() : "";
        if (why) {
          openProblem({
            title: "The search could not be completed",
            detail: `This is not the same as having no groups — the lookup itself failed. ${why}`,
            advice: "Use the code instead: tap \"I have a code for my group\" above. Ask whoever runs the group to read it out from Admin.",
          });
        } else {
          openNotice({
            title: "No groups found for this account",
            detail: "Nothing is wrong with your rounds — they belong to the group, not to your sign-in. This account simply is not a member of one.",
            advice: "Ask whoever runs the group for a fresh invitation link, or use the code. Only create a group here if you really are starting a new one.",
          });
        }
      } catch {
        idleAll();
        flashMsg("Couldn't check just now. Try again in a moment.");
      } finally { idleAll(); }
      return render();
    }
    case "recover": tab = "enter"; openGame = null; return render();
    case "dismiss-alert": return;
    case "cancel-del": confirmId = null; return render();
    case "cancel-round-edit": editingRound = null; form = { ...form, gross: "", adjusted: "", notes: "" }; return render();
    case "clear-filters": filter = { golferId: "", year: "", month: "", courseId: "" }; return render();
    case "drill-back": drill.month ? (drill.month = null) : (drill.year = null); return render();
    case "view-scope": filter = { golferId: "", year: drill.year || "", month: drill.month || "", courseId: "" }; tab = "history"; return render();
    case "enter-steps": setEnterStyle("steps"); stepIndex = null; return render();
    case "enter-full": setEnterStyle("full"); return render();
    case "step-next": stepIndex = Math.min(2, (stepIndex ?? 0) + 1); return render();
    case "step-back": stepIndex = Math.max(0, (stepIndex ?? 0) - 1); return render();
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
          title: stale ? "Please sign in again first" : "The password could not be set",
          detail: stale
            ? "For safety, Firebase will not attach a password to an account that signed in days ago."
            : code || "No detail was given.",
          advice: stale
            ? "Sign out of this device, sign back in, then set the password straight away. If this account has no other way to sign in, email support."
            : "Try again. If it keeps failing, email this to support.",
        });
      } finally { idle(); }
      return render();
    }
    case "delete-account":
      openDeleteAccount({ resume: db.deletionPending() });
      return;
    case "open-guide":
      platform.openExternal(`${platform.guideUrl()}#moving`);
      return;
    /* The online guide, support and privacy pages on the Cuberoot site, from
       the foot of every screen. They open in Safari. */
    case "open-user-guide":
      platform.openExternal(platform.guideUrl(), "tab");
      return;
    case "open-support":
      platform.openExternal(platform.supportUrl(), "tab");
      return;
    case "open-privacy":
      platform.openExternal(platform.privacyUrl(), "tab");
      return;
    case "open-tool": {
      /* The one-time data tools are web pages, never part of the iPhone app.
         In a browser they open as always; in the app, in Safari. */
      const tool = { rebuild: "rebuild", tidy: "tidy", cleanup: "cleanup" }[d.tool];
      if (!tool) return;
      /* beta.5: coming back from a tool lands on the screen it was opened from. */
      try { sessionStorage.setItem(RETURN_KEY, JSON.stringify({ tab, adminTab, at: Date.now() })); } catch {}
      /* beta.7: every tool is packaged inside the app (on the app's own
         Firebase copy), so each opens here, already signed in — never in
         Safari, whose sign-in is separate (Willy, Oct 2).
         beta.8: but first close this page's Firestore and wait until it is
         closed. Left open, the iPhone keeps this page frozen with it, and the
         app coming back from the tool waited on "Loading your group" until
         the phone threw the frozen page away (store.js shutDown). */
      busy("Opening");
      const left = Date.now();
      let how;
      try { await db.shutDown(); how = `closed in ${Date.now() - left} ms`; }
      catch (err) { how = `closing FAILED: ${(err && err.message) || err}`; }
      /* Kept for the report trail of the page that comes back (Send a report). */
      try { sessionStorage.setItem(RETURN_KEY, JSON.stringify({ tab, adminTab, at: Date.now(), left: `left for ${tool}: ${how}` })); } catch {}
      location.href = `./${tool}.html${EMULATED_QS}`;
      return;
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
      if ((db.readJoinLink() || {}).token) {
        db.clearJoinLink(); invitedGolfer = null;
        flashMsg("Ask the admin for your own invitation.");
        await settleGroup(db.recallAssociation()); return render();
      }
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
        const result = link.token
          ? await db.acceptTokenInvite({ associationId: link.associationId, token: link.token })
          : await db.acceptNamedInvite({ associationId: link.associationId, code: link.code, golferId: link.golferId, role });
        joining = false;
        if (!result.ok) {
          idleAll();
          note(`join refused: ${result.reason}`);
          openProblem({
            title: result.reason === "USED"
              ? "This invitation has already been used"
              : result.reason === "OTHER_GOLFER"
                ? "You are already in this group as another golfer"
                : "This invitation belongs to somebody else",
            detail: result.reason === "USED"
              ? "An admin invitation works once only. Ask for a fresh one."
              : result.reason === "OTHER_GOLFER"
                ? "This sign-in already plays in this group under another name, so it cannot become this golfer as well."
                : "Somebody has already joined with this link. Ask whoever runs the group to send you your own.",
            advice: result.reason === "OTHER_GOLFER"
              ? "Nothing was changed. If this invitation is for you, ask whoever runs the group to sort out the two names."
              : "Nothing was changed.",
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
        /* beta.9: each refusal names its step and says what to do. */
        const code = String((err && (err.code || err.message)) || "");
        note(`join refused: ${code}`);
        openProblem({
          title: code.includes("join/membership-refused") ? "This invitation link no longer works"
            : code.includes("join/link-refused") ? "You are in the group, but your golfer could not be linked"
            : "Could not join the group",
          detail: code.includes("join/membership-refused")
            ? "The group's code has changed since it was sent, so the link is out of date."
            : code.includes("join/link-refused")
              ? "This golfer is still linked to another sign-in."
              : code || "No detail was given.",
          advice: code.includes("join/membership-refused")
            ? "Ask whoever runs the group to tap Send again for you, then use the new link. Nothing was changed."
            : code.includes("join/link-refused")
              ? "Ask whoever runs the group to tap Send again for you (that releases the old link), then tap the new link."
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
    case "enter-code":
      /* Signed out: the code screen comes first (beta.3). Signed in: as before. */
      if (!db.isSignedIn()) { signedOutStep = "code"; return render(); }
      showCodeEntry = true; accountMode = null; return render();
    case "code-continue": {
      const typed = ((view.querySelector('[name="join-code"]') || {}).value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!typed) { flashMsg("Type the group code"); return render(); }
      joinForm.code = typed;
      signedOutStep = null; showCodeEntry = true; accountMode = null;
      return render();
    }
    case "show-choose": signedOutStep = "choose"; applySentTo = ""; requestSentTo = ""; return render();
    case "show-request": signedOutStep = "group"; requestSentTo = ""; return render();
    case "submit-request": return submitRequestHere();
    case "open-conduct":
      platform.openExternal(platform.conductUrl(), "tab");
      return;
    case "create-account": return createAccountHere();
    case "show-apply":
      /* The switch is read first, so the form is drawn once: a redraw after
         somebody started typing would wipe what they typed. */
      applySentTo = ""; applyInUse = "";
      applySettings = await db.readApplicationSettings();
      signedOutStep = "member";
      return render();
    case "hide-apply": signedOutStep = null; applySentTo = ""; requestSentTo = ""; return render();
    case "submit-application": return submitApplicationHere();
    case "finish-apply": return finishApplyHere();
    case "send-confirmation": {
      busy("Sending the confirmation email");
      try { await db.sendEmailConfirmation(); confirmationSent = true; flashMsg("Sent. Open the link in the email, then tap Continue."); }
      catch (e) { flashMsg(`It was not sent: ${String((e && (e.code || e.message)) || "no connection")}.`); }
      finally { idle(); }
      return render();
    }
    case "confirmed-email": {
      busy("Checking");
      try {
        const ok = await db.refreshEmailState();
        if (!ok) { flashMsg("Not confirmed yet. Open the link in the email first."); return render(); }
        const result = await db.joinPublicIfApproved();
        if (result && result.joined) { await start(db.PUBLIC_ID); tab = "enter"; flashMsg("Welcome to the public group. Post your rounds on the Enter tab."); }
        else flashMsg("Your email is confirmed. There is no approval for it yet — you will get an email when there is.");
      } catch { flashMsg("That did not finish. Check the connection and try again."); }
      finally { idle(); }
      return render();
    }
    case "golfer-actions": return openGolferActions(d.id);
    case "unblock": {
      busy("Unblocking");
      try { await db.unblockGolfer(d.id); flashMsg("Unblocked."); }
      catch { flashMsg("Couldn't unblock — the message above says why."); }
      finally { idle(); }
      return render();
    }
    case "review-application": return openApproveSheet(d.id);
    case "approve-request": return approveRequestHere(d.id);
    case "admin-tab": adminTab = d.id || "cockpit"; cockpitGroup = null; window.scrollTo && window.scrollTo(0, 0); return render();
    case "cockpit-refresh": return loadOwnerCockpitHere();
    case "cockpit-group": cockpitGroup = d.id || null; window.scrollTo && window.scrollTo(0, 0); return render();
    case "set-switch": {
      if (!appSettings || appSettings.mode === d.id) return;
      busy("Changing the switch");
      try { appSettings = await db.saveApplicationSettings({ mode: d.id, dailyLimit: appSettings.dailyLimit });
        flashMsg(appSettings.mode === "auto" ? "The switch is on Auto." : "The switch is on Manual."); }
      catch (e) { flashMsg(`The switch did not change: ${String((e && (e.code || e.message)) || "no connection")}.`); }
      finally { idle(); }
      return render();
    }
    case "block-add": {
      const input = view.querySelector(`[name="block-${d.kind}"]`);
      const value = ((input || {}).value || "").trim();
      if (!value) { flashMsg("Type what to block first."); return; }
      busy("Adding to the block list");
      try { const key = await db.addBlock(d.kind, value); flashMsg(`${key} is on the block list.`); }
      catch (e) { flashMsg(`It was not added: ${String((e && (e.code || e.message)) || "no connection")}.`); }
      finally { idle(); }
      return render();
    }
    case "unblock": {
      busy("Removing from the block list");
      try { await db.removeBlock(d.kind, d.id); flashMsg(`${d.id} is off the block list.`); }
      catch (e) { flashMsg(`It was not removed: ${String((e && (e.code || e.message)) || "no connection")}.`); }
      finally { idle(); }
      return render();
    }
    case "decline-request": {
      if (confirmDecline !== d.id) {
        confirmDecline = d.id;
        setTimeout(() => { if (confirmDecline === d.id) { confirmDecline = null; render(); } }, 4000);
        return render();
      }
      confirmDecline = null;
      const r = groupRequests.find((x) => x.key === d.id);
      if (!r) return render();
      busy("Declining");
      try { await db.declineGroupRequest(r.key); flashMsg(`The request for "${r.groupName}" was declined. No email is sent.`); }
      catch (e) { flashMsg(`It was not declined: ${String((e && (e.code || e.message)) || "no connection")}.`); }
      finally { idle(); }
      return render();
    }
    case "resend-approval-email": {
      busy("Sending the email");
      try { await db.resendApprovalEmail(d.id); flashMsg(`The password email has gone to ${d.id} again.`); }
      catch (e) { flashMsg(`It was not sent: ${String((e && (e.code || e.message)) || "no connection")}.`); }
      finally { idle(); }
      return render();
    }
    case "reject-application": {
      if (confirmReject !== d.id) {
        confirmReject = d.id;
        setTimeout(() => { if (confirmReject === d.id) { confirmReject = null; render(); } }, 4000);
        return render();
      }
      confirmReject = null;
      const a = applications.find((x) => x.key === d.id);
      if (!a) return render();
      busy("Rejecting");
      try { await db.rejectApplication(a); flashMsg(`${a.fullName}'s application was rejected. No email is sent.`); }
      catch { flashMsg("Couldn't reject it — the message above says why."); }
      finally { idle(); }
      return render();
    }
    case "dismiss-report": {
      busy("Dismissing");
      try { await db.dismissReport(d.id); flashMsg("Report dismissed."); }
      catch { flashMsg("Couldn't dismiss it — the message above says why."); }
      finally { idle(); }
      return render();
    }
    case "remove-reported": {
      const r = publicReports.find((x) => x.id === d.id);
      const member = r && members.find((m) => m.golferId === r.golferId && m.role === "member");
      if (!member) return render();
      busy("Removing them from the group");
      try {
        await db.removeMemberships([member.uid]);
        await db.dismissReport(r.id);
        flashMsg(`${r.displayName || "They"} no longer have access to the public group. Their rounds stay.`);
      } catch { flashMsg("Couldn't remove them — the message above says why."); }
      finally { idle(); }
      return render();
    }
    case "upgrade-account": return upgradeAccount();
    case "account-mode-signin": accountMode = "signin"; return render();
    case "account-mode-create": accountMode = "create"; return render();
    case "hide-code":
      showCodeEntry = false;
      if (!db.isSignedIn()) signedOutStep = "code";
      return render();
    case "create-group": return createGroup();

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
    case "toggle-hidden-courses": showHidden = !showHidden; return render();
    case "save-course": return saveCourse();
    case "find": return runFinder();

    case "new-game": gameDraft = { date: today(), endDate: "", courseId: "", name: "", multiDay: false }; return render();
    case "make-multiday": gameDraft.multiDay = true; return render();
    case "cancel-game": gameDraft = null; return render();
    case "save-game": return saveGame();
    case "close-game": openGame = null; editingGame = false; return render();
    case "edit-game": editingGame = !editingGame; return render();
    case "fast-entry":
      fastEntry = { scores: {}, indexes: {}, teeId: "" };
      return render();

    case "fast-cancel":
      fastEntry = null;
      return render();

    case "fast-post": {
      const game = games.find((g) => g.id === openGame);
      if (!game || !fastEntry) return;

      const course = courses.find((c) => c.id === game.courseId);
      const tees = course ? course.tees : [];
      const tee = tees.find((t) => t.id === fastEntry.teeId) || tees[0];
      if (!tee) { flashMsg("This course has no tees yet."); return render(); }

      /* Gather what was typed, straight from the fields — the panel is not
         redrawn between keystrokes, so the DOM is the source of truth. */
      /* Read from the REMEMBERED values, falling back to the field.
       *
       * Reading only the DOM lost scores: any live update from the database
       * redraws the panel, and a redraw rebuilds it from state — so anything
       * typed but not yet remembered simply vanished. State is now filled on
       * every keystroke, and the field is only a backstop. */
      const entries = [];
      for (const g of sortedGolfers()) {
        const field = view.querySelector(`[name="fast-score-${g.id}"]`);
        const typed = String(fastEntry.scores[g.id] ?? (field ? field.value : "")).trim();
        const gross = +typed;
        if (!(gross > 0)) continue;

        const indexField = view.querySelector(`[name="fast-index-${g.id}"]`);
        const rawIndex = fastEntry.indexes[g.id] ?? (indexField ? indexField.value : "");
        const typedIndex = model.clampIndex(rawIndex);
        entries.push({ golfer: g, gross, typedIndex });
      }

      if (!entries.length) { flashMsg("No scores typed in yet."); return render(); }

      busy(`Posting ${entries.length} round${entries.length === 1 ? "" : "s"}`);
      let posted = 0;
      const failed = [];
      try {
        for (const entry of entries) {
          try {
            /* A starting index has to be saved BEFORE the round, or the round
               freezes a course handicap worked out from nothing. */
            if (entry.typedIndex != null && model.effectiveIndex(entry.golfer).index == null) {
              db.setManualIndex(entry.golfer.id, entry.typedIndex);
              entry.golfer = { ...entry.golfer, manualIndex: entry.typedIndex };
            }

            db.postRound({
              golfer: entry.golfer,
              course, tee,
              date: game.date,
              gross: String(entry.gross),
              adjusted: "",
              notes: "",
              gameId: game.id,
            });
            posted++;
          } catch {
            failed.push(entry.golfer.name);
          }
        }
      } finally { idleAll(); }

      fastEntry = null;
      /* WAIT FOR THE DATABASE BEFORE CLAIMING ANYTHING.
       *
       * postRound only queues; the write happens later. So this used to
       * announce "8 rounds posted" while every one of them was being refused
       * and quietly abandoned. Flushing here means the count is real. */
      let refused = 0;
      try {
        const result = await db.flush();
        if (result && result.failed) refused = result.failed;
      } catch { /* flush reports its own trouble in the status bar */ }

      if (refused) {
        openProblem({
          title: `${refused} of ${posted} could not be saved`,
          detail: "The database refused them. Nothing was lost on your side — the scores simply did not reach it.",
          advice: "Usually the rules in the Firebase console are older than this version. Publish the latest firestore.rules, then enter the missing scores again.",
        });
      } else if (failed.length) {
        openProblem({
          title: `${posted} posted, ${failed.length} did not`,
          detail: `These were refused: ${failed.join(", ")}.`,
          advice: "The rest went through. Post the missing ones from the Enter tab.",
        });
      } else {
        flashMsg(`${posted} round${posted === 1 ? "" : "s"} posted into this game.`);
      }
      return render();
    }

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

    case "share-invite": {
      busy("Preparing the invitation");
      try { return openShare(`Join our golf scorecard:\n${await db.inviteLink("member")}\n\nCreate an account or sign in. This link works once.`, "Invitation"); }
      catch (err) { openProblem({ title: "Could not prepare the invitation", detail: String(err.message || err), advice: "Try again when connected." }); }
      finally { idleAll(); }
      return;
    }
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
        const link = await db.inviteLink("admin");
        if (!link) {
          idleAll();
          return openProblem({
            title: "The invitation link could not be built",
            detail: "The group's details have not finished loading yet.",
            advice: "Wait a moment and try again.",
          });
        }
        const guide = platform.guideUrl();
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
  }
});

sheetEl.addEventListener("click", async (e) => {
  /* FIRST, before any guard at all.
   *
   * This button has been reported dead three times. Each fix addressed a real
   * fault and it stayed dead, so rather than a fourth theory it now runs before
   * anything else in this listener can intercept, close, or return. */
  const reopening = e.target.closest("[data-reset-invite]");
  if (reopening) {
    const id = reopening.dataset.resetInvite;
    const golfer = golferById(id);
    sheetEl.hidden = true;
    busy("Clearing the old invitation");
    try {
      await db.resetInvitation(id);
      openNotice({
        title: `${(golfer || {}).name || "They"} can be invited again`,
        detail: "The old invitation has been cleared. Send them a fresh link from Manage.",
      });
    } catch (err) {
      /* Say exactly what went wrong. A silent failure here has wasted three
         rounds of diagnosis already. */
      idleAll();
      openProblem({
        title: "Could not clear the invitation",
        detail: String((err && (err.code || err.message)) || err) || "No detail was given.",
        advice: "Nothing was changed. Send this report and it will say what refused it.",
      });
    }
    finally { idleAll(); }
    render();
    return;
  }

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
      const outcome = await db.setMyPassword({ email, password: secret });
      openNotice({
        title: outcome && outcome.outcome === "signed-in-existing"
          ? "Signed in to your existing account"
          : "Password saved",
        detail: outcome && outcome.outcome === "signed-in-existing"
          ? `${email} already had an account, so you have been signed in to it and your role has been carried across. Nothing was lost.`
          : `Sign in with ${email} and this password on any device, and your role and groups come with you.`,
      });
    } catch (err) {
      idleAll();
      openSignInProblem(err, email);
    } finally { idleAll(); }
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
    /* Phase D: only the owner sends admin invitations. */
    const role = chosen && chosen.value === "admin" && db.isOwner() ? "admin" : "member";
    const golferId = inviting.dataset.golfer || null;
    const named = golferId ? golferById(golferId) : null;
    sheetEl.hidden = true;
    busy("Preparing the invitation");
    try {
      if (role === "admin") await db.ensureAdminCode();
      const link = await db.inviteLink(role, golferId);
      if (golferId) db.noteInvitation(golferId, role, named);
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

      const guide = platform.guideUrl();
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
          ? "Tap the link, create your account (your email and a password) or sign in, and it greets you by name. One button and you are in."
          : "Tap the link, create your account (your email and a password) or sign in, then type the name you play under.",
        role === "admin"
          ? "This makes you an admin, so you will be asked to set a password. It works once, so keep it to yourself."
          : "Create an account or sign in with your email and password. This invitation works once.",
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
    platform.openExternal(`https://wa.me/?text=${encodeURIComponent(text)}`, "tab");
    return;
  }
  if (how === "email") {
    platform.openExternal(`mailto:${sheetEl.dataset.to || ""}?subject=${encodeURIComponent(sheetEl.dataset.title || "")}&body=${encodeURIComponent(text)}`);
    return;
  }
  if (how === "sms") {
    platform.openExternal(`sms:?&body=${encodeURIComponent(text)}`);
    return;
  }

  if (how === "copy") {
    send.disabled = true;
    const was = send.textContent;
    try {
      await platform.copy(text);
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
    if (!platform.canShare()) { flashMsg("This device has no share sheet. Use one of the other buttons."); return; }
    try { await platform.share({ text }); }
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
    await finishSignIn(result, email);
  } catch (err) {
    joining = false;
    openSignInProblem(err, email);
  } finally {
    /* Always. A spinner that never stops is worse than no spinner at all. */
    idle();
    render();
  }
}

/* What follows a successful sign-in, from the Sign in screen or (beta.8) from
   Create account when the email already had an account. */
async function finishSignIn(result, email, message) {
  accountMode = null;
  /* beta.9: an account whose deletion has started opens nothing. */
  if (await db.checkPendingDeletion()) { await refuseDeletingAccount(); return; }
  if (db.readJoinLink()) {
    /* Signed in from an invitation: show the invitation next. */
    await loadInvitedDetails();
  } else {
    await settleGroup(db.currentAssociation() || db.recallAssociation());
  }

  /* Land on Enter. Signing in used to leave people on whichever tab they
     happened to be on — usually Admin, which is not where anybody wants to
     start. */
  tab = "enter";

  flashMsg(message
    || (result.outcome === "password-added"
      ? `Password set on ${result.email}. That is now your one account — use this email and password on every device.`
      : result.outcome === "created" ? "Account created. Use this email and password on your other devices."
      : `Signed in as ${email}.`));
  /* Phase C: an approval for the public group waiting for this email.
     Its own message, if any, replaces the one above. */
  await checkPublicApproval();
}

/* A failed sign-in has to say which of the several possible things went wrong,
   and offer the way out in the same breath. Sending somebody off to hunt for a
   Forgot the password link at the moment they are already stuck is no help. */
function openSignInProblem(error, email) {
  const code = String((error && (error.code || error.message)) || "").toLowerCase();

  let title = "Sign-in did not work";
  let detail = code || "No detail was given.";
  let offerReset = false;

  if (code.includes("no-such-account")
    || code.includes("wrong-password") || code.includes("invalid-credential") || code.includes("invalid-login")) {
    /* ONE message for both, on purpose.
     *
     * Firebase's email enumeration protection returns the SAME code whether
     * the address is unknown or the password is wrong. Naming one of them is
     * therefore a guess, and it sends people off checking the wrong thing. */
    title = "That email and password did not match";
    detail = "Check both.";
    offerReset = true;
  } else if (code.includes("user-not-found")) {
    /* Only reached when the project has enumeration protection turned off, in
       which case Firebase really has told us the address is unknown. */
    title = "No account for that email";
    detail = "Check the address for a typo.";
  } else if (code.includes("invalid-email")) {
    title = "That email does not look right";
    detail = "Check it for a typo.";
  } else if (code.includes("too-many-requests")) {
    title = "Too many attempts";
    detail = "Try again in a few minutes.";
    offerReset = true;
  } else if (code.includes("network") || code.includes("failed to fetch")) {
    title = "Could not reach Firebase";
    detail = "Check your connection.";
  } else if (code.includes("weak-password")) {
    title = "Password too short";
    detail = "Use at least six characters.";
  } else if (code.includes("existing-account-password")) {
    /* beta.8: Create account, with an email that already has an account and a
       password that is not that account's. */
    title = "That email already has an account";
    detail = "The password you typed is not its password. Type that account's password in both boxes, or reset it.";
    offerReset = true;
  } else if (code.includes("email-already-in-use") || code.includes("credential-already-in-use")) {
    title = "That email already has an account";
    detail = "Sign in with it instead, or use a different email.";
    offerReset = true;
  } else if (code.includes("wrong-email")) {
    title = "That is not this account's email";
    detail = "Use the email this account already has.";
  }

  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body centred">
    <h2>${esc(title)}</h2>
    <p class="lead">${esc(detail)}</p>
    <div class="inline-actions stacked">
      <button class="btn" data-close="1">Try again</button>
      ${offerReset ? `<button class="btn ghost" data-reset-password="${esc(email)}">Reset my password</button>` : ""}
    </div>
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
  let result;
  try { result = invite.token
    ? await db.acceptTokenInvite({ associationId: invite.associationId, token: invite.token, displayName: name })
    : await db.joinAssociation({ associationId: invite.associationId, code: invite.code, displayName: name });
  } catch (err) {
    joining = false; idleAll();
    openProblem({ title: "This invitation could not be accepted", detail: String(err.code || err.message || err), advice: "Nothing was changed. Ask the admin for a fresh link if this one was used or replaced." });
    return render();
  }
  if (result.ok) {
    db.clearJoinLink();

    /* An admin invitation with no golfer named is somebody who RUNS the group
       without playing in it — a club secretary or a scorer. Creating a golfer
       for them puts a player on the roster who will never post a round, and
       who then has to be found and removed. Only players get a golfer. */
    if (!(invite.role === "admin" && !invite.golferId)) {
      await db.linkGolferForMember(name);
    }

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
    /* Being already a member is the good outcome, not a failure — and saying
       which role they kept is the whole point after an admin was quietly
       turned into a guest by this very screen. */
    if (result.already) {
      const asRole = result.role === "owner" ? "the owner"
        : result.role === "admin" ? "an admin" : "a guest";
      flashMsg(`You were already in this group as ${asRole}. Nothing was changed.`);
    }
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
      ${(() => {
        /* Two headings: people who play in another group, then anybody who
           belongs to no group at all — usually because their group was
           deleted. Their record and handicap survived, so they can be picked
           straight back up. */
        const playing = people.filter((p) => !p.orphaned);
        const orphans = people.filter((p) => p.orphaned);
        const row = (p) => `<label class="checkline" style="padding:0.6rem 0.8rem">
          <input type="checkbox" name="pick-golfer" value="${esc(p.id)}">
          <span><span class="name">${esc(p.name || "Unnamed")}</span><br>
            <span class="sub">${p.orphaned ? "not in any group" : esc(p.groups.join(", "))}${
              p.handicapIndex != null ? ` · index ${Number(p.handicapIndex).toFixed(1)}` : " · no index yet"
            }</span></span>
        </label>`;

        return `${playing.length ? `<div class="eyebrow" style="padding:0.6rem 0.8rem 0.2rem">In your other groups</div>${playing.map(row).join("")}` : ""}
          ${orphans.length ? `<div class="eyebrow" style="padding:0.9rem 0.8rem 0.2rem">Not in any group</div>${orphans.map(row).join("")}` : ""}`;
      })()}
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
  const editing = !!courseDraft.editing;
  const c = { ...courseDraft, name: courseDraft.name.trim(),
    tees: courseDraft.tees.filter((t) => t.name.trim() && t.rating && t.slope && t.par) };
  if (!c.name || !c.tees.length) { flashMsg("A course needs a name and at least one complete tee"); return; }

  /* A tee with rounds on it must survive the save even if the filter above
     dropped it for an incomplete number — losing it would strand those
     rounds. Checked here rather than trusted to the greyed-out button, which
     is only a hint. */
  if (editing) {
    const before = (courses.find((x) => x.id === c.id) || {}).tees || [];
    const lost = before.filter((t) => roundsOnTee(c.id, t.id) > 0 && !c.tees.some((n) => n.id === t.id));
    if (lost.length) {
      flashMsg(`${lost.map((t) => t.name).join(", ")} has rounds on it and cannot be removed.`);
      return;
    }
  }

  note(editing ? `updating course ${c.name}` : `adding course ${c.name}`);
  if (editing) db.updateCourse(c); else db.addCourse(c);
  courseDraft = null;
  finder = { q: "", results: [], busy: false, msg: "" };
  flashMsg(editing
    ? `${c.name} updated. Rounds already posted keep the figures they were played on.`
    : `${c.name} added`);
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
    /* THE RATING COMES OFF THE ROUND, NOT THE COURSE.
     *
     * This used to read tee.rating and tee.slope from the course as it is
     * TODAY. Harmless while courses could never change — and a silent rewriting
     * of history the moment they could: correcting a typo in a five-year-old
     * score would re-rate it against figures that did not exist when it was
     * played. The round froze its own rating and slope at entry, which is what
     * the handicap system requires, so that is what is used. Only if the round
     * predates that field is the course fallen back on. */
    const original = rounds.find((r) => r.id === editingRound);
    const wasRating = original && Number.isFinite(Number(original.rating)) ? Number(original.rating) : tee.rating;
    const wasSlope = original && Number.isFinite(Number(original.slope)) ? Number(original.slope) : tee.slope;
    /* gameId is written every time, including as null — so a round can be taken
       out of a game as well as moved between them. */
    db.updateRound(editingRound, {
      date: form.date, gross: +form.gross, adjusted: ags,
      differential: model.differential(ags, wasRating, wasSlope),
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

  /* Send the walk-through back to the beginning.
   *
   * Without this it stayed wherever it was — on the score — and since the
   * course was still filled in from the last round there was no way to reach
   * it again. Starting at the golfer is right anyway: that is the one thing
   * that always changes between rounds. */
  /* Go back to the FIRST step they can act on, rather than letting the
     first-unfinished rule drop them on the score again. An admin starts at the
     golfer; a guest's golfer is fixed, so they start at the course — the thing
     most likely to differ next time. */
  stepIndex = db.canManage() ? 0 : 1;
  calendarOpen = false;
  calendarMonth = null;
  calPick = null;

  flashMsg(`Round posted — differential ${round.differential.toFixed(1)}`);
}

/* Owners and admins keep the group's directory (name and index only, which is
   all a regular member may see of other golfers) in step with the golfer
   records, a few seconds after anything changes. Only differences are written. */
let directoryTimer = null;
function scheduleDirectoryRefresh() {
  if (!db.canManage()) return;
  clearTimeout(directoryTimer);
  directoryTimer = setTimeout(() => {
    db.refreshGroupDirectory(allGolfers.filter((g) => roster.includes(g.id))).catch(() => {});
  }, 4000);
}

/* ================= start ================= */

async function start(assocId) {
  db.setAssociation(assocId);
  const member = await db.loadMembership(assocId);
  if (!member) return;
  association = await db.loadAssociation(assocId);
  if (association) lookup.setSharedKey(association.lookupKey || "");
  /* beta.4: "last seen" for the cockpit (at most twice a day; quiet). */
  db.stampLastSeen();
  /* A new group: the cockpit shows the new group's numbers. */
  ownerCockpit = null; ownerCockpitState = "idle"; cockpitGroup = null; blockWatched = false; blockLists = { emails: [], domains: [], names: [] };
  db.stopWatching();
  db.watchAssociation((doc) => {
    association = doc;
    lookup.setSharedKey(doc.lookupKey || "");
    render();
  });
  db.watchGolfers((list) => { rawGolfers = list; applyBlocks(); render(); scheduleDirectoryRefresh(); });
  db.watchRoster((ids) => { roster = ids; refreshScope(); render(); });
  db.watchRounds((list) => { rounds = list; render(); });
  db.watchCourses((list) => { courses = list; render(); });
  db.watchGames((list) => { games = list; render(); });
  db.watchMembers((list) => { members = list; render(); });
  /* Phase C: in the PUBLIC group, blocks for everybody; applications and
     reports for its reviewers. */
  applications = []; publicReports = []; blocked = []; approvalsWaiting = [];
  groupRequests = []; requestsWatched = false;
  watchRequestsIfCreator();
  if (db.isPublicGroup()) {
    db.watchBlocks((list) => { blocked = list; applyBlocks(); render(); });
    if (db.canManage()) {
      db.watchApplications((list) => { applications = list; render(); });
      db.watchApprovals((list) => { approvalsWaiting = list; render(); });
      db.watchReports((list) => { publicReports = list; render(); });
    }
  }
  render();
}

/* A regular member of the PUBLIC group never sees a golfer they blocked —
   not in the directory, the ranking or anywhere else. Admins see everybody,
   because they have to act on reports. */
function applyBlocks() {
  const hidden = new Set(db.isPublicGroup() && !db.canManage() ? blocked.map((b) => b.golferId) : []);
  const mine = db.myGolferId(rawGolfers);
  allGolfers = hidden.size ? rawGolfers.filter((g) => !hidden.has(g.id) || g.id === mine) : rawGolfers;
  refreshScope();
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

db.onChange((s, patch) => { sync = s; if (patch && patch.deletionDetected) refuseDeletingAccount(); render(); });

/* The steps boot() runs for an invitation that names somebody: fetch them so
   the screen can greet them. Also used when a link arrives while the iPhone
   app is already open (Change 2). */
async function loadInvitedDetails() {
  invitedGolfer = null;
  invitedGroupName = "";
  /* Only an account can read an invitation (Phase B); signed out or an old
     guest session, the account screen comes first. */
  if (!db.hasUser() || db.isAnonymousSession()) return;
  const link = db.readJoinLink();
  if (link && link.token) {
    try {
      const inv = await db.loadInvitation(link);
      if (!inv) {
        db.clearJoinLink();
        flashMsg("This invitation was used or cancelled. Sign in normally, or ask the admin for a fresh link.");
        await settleGroup(db.recallAssociation());
        return;
      }
      invitedGolfer = inv.golferId && inv.name ? { ...inv, id: inv.golferId } : null;
      invitedGroupName = inv.groupName || "";
    } catch (err) {
      note(`invitation read: ${String(err.code || err.message || err)}`);
      flashMsg("The invitation could not be checked. Reconnect and open the link again.");
    }
    return;
  }
  if (link && link.golferId) {
    /* Go-live fix 1: from the invitation record, not the private golfer. */
    const inv = await db.invitationFor(link.associationId, link.golferId);
    invitedGolfer = inv && inv.name ? inv : null;
    invitedGroupName = inv ? inv.groupName : "";
  }
}

/* beta.8: a page that left closed its Firebase first (store.js shutDown). If
   the iPhone ever brings that frozen page back (pageshow from its cache), it
   must not carry on with a closed database: start it afresh. */
addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });

(async function boot() {
  if (returnTo && returnTo.left) note(returnTo.left);
  render();
  await platform.initLinks();   /* iPhone app: the link that opened it, if any */
  platform.onLink(async () => { await loadInvitedDetails(); render(); });
  await db.init();
  /* beta.9: a device still signed in to an account whose deletion has started
     is signed out at once, before anything of it is opened. */
  if (await db.checkPendingDeletion()) await refuseDeletingAccount();
  markBoot("group");

  const remembered = db.recallAssociation();

  /* An old guest session (Phase B) can read nothing until it has an email and
     password, so it goes straight to that screen. Signed out: nothing to load. */
  const account = db.hasUser() && !db.isAnonymousSession();
  if (account) await settleGroup(remembered);
  markBoot("data");

  /* beta.6 (Willy, Oct 2): the version 1 import is gone for good — no check,
     no screen. Version 1 was retired; its leftovers are never offered again. */

  /* If the link names somebody, fetch them so the screen can greet them. */
  if (account) await loadInvitedDetails();
  if (account) await checkPublicApproval();

  markBoot("ready");
  ready = true;
  render();
  if (db.offlineCopyUnavailable()) flashMsg("Offline data unavailable on this device — the app needs a connection to show your group.");

  /* Coming back online on the first screen: look for the groups again. */
  addEventListener("online", async () => {
    if (db.currentAssociation() || !db.hasUser() || db.isAnonymousSession()) return render();
    await settleGroup(db.recallAssociation());
    await loadInvitedDetails();
    render();
  });
})();

