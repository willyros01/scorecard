import * as db from "./store.js";
import * as model from "./model.js";
import * as lookup from "./courses-api.js";

const VERSION = (typeof self !== "undefined" && self.APP_VERSION) || "dev";
const SUPER_ADMIN = "willyros01@gmail.com";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const today = () => new Date().toISOString().slice(0, 10);
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

let tab = "enter";
let sync = { text: "Starting", alert: false };
let flash = null;
let joinForm = { name: "", groupName: "", code: "" };
let form = { date: today(), golferId: "", courseId: "", teeId: "", gross: "", adjusted: "", notes: "", gameId: "" };
let filter = { golferId: "", year: "", month: "", courseId: "" };
let drill = { year: null, month: null };
let openGame = null;
let openCourse = null;
let editingGolfer = null;
let courseDraft = null;
let gameDraft = null;
let finder = { q: "", results: [], busy: false, msg: "" };
let rankPeriod = { year: String(new Date().getFullYear()), month: "" };
let editingRound = null;
let confirmId = null;

const view = document.getElementById("view");
const sheetEl = document.getElementById("sheet");
const tabsEl = document.getElementById("tabs");

const sortedCourses = () => [...courses].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
/* The people on this group's roster, resolved from the global golfer list. */
const sortedGolfers = () => allGolfers
  .filter((g) => roster.includes(g.id))
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
const golferById = (id) => allGolfers.find((g) => g.id === id);
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
/* The first screen. One box, one button.
 *
 * Whether this ends up joining a group or starting one depends on how the
 * person arrived, not on a choice they have to understand. Somebody sent an
 * invitation link: they join it. Nobody did: they get their own group, which
 * can be renamed later. Either way the next thing they see is the Enter tab.
 */
function screenJoin() {
  const invite = db.readJoinLink();

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

  return `<div class="stack">
    ${flashBar()}
    <div class="card padded">
      <h2 class="panel-title">${invite ? "You have been invited" : "Welcome"}</h2>
      <p class="hint">${invite
        ? "Type the name you play under and you are in."
        : "Type your name to begin. Everything else can wait."}</p>
      <label class="lbl">Your name</label>
      <input class="field" name="join-name" value="${esc(joinForm.name)}" placeholder="e.g. Willy Rosales" autocomplete="name">
      <div class="inline-actions stacked">
        <button class="btn" data-act="begin" ${joining ? "disabled" : ""}>${joining ? "One moment…" : "Start"}</button>
      </div>
    </div>
    ${invite ? "" : `${migrationCard()}
    <p class="hint" style="text-align:center">
      Joining someone else's group? <button class="linkbtn" data-act="show-code">I was given a code</button>
    </p>`}
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
  flashMsg("Importing. Do not close the app.");
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
    flashMsg("The import did not finish. Nothing was lost — version 1 still has every round. See the message at the top.");
    render();
  }
}

/* ================= enter ================= */

function screenEnter() {
  if (!golfers.length || !courses.length) {
    return empty("Almost ready", db.canManage()
      ? "Add a golfer and a course under Manage, then you can post rounds."
      : "Whoever runs your group still needs to add the roster and a course.")
      + (db.canManage() ? `<button class="btn" data-go="manage">Go to Manage</button>` : "");
  }

  const course = courseById(form.courseId);
  const tee = course && course.tees.find((t) => t.id === form.teeId);
  const golfer = golferById(form.golferId);
  const ags = +(form.adjusted || form.gross);
  const diff = tee && form.gross ? model.differential(ags, tee.rating, tee.slope) : null;
  const ch = golfer && golfer.handicapIndex != null && tee
    ? model.courseHandicap(golfer.handicapIndex, tee.slope, tee.rating, tee.par) : null;
  const ready2 = golfer && tee && +form.gross > 0;
  const todayGames = games.filter((g) => g.date === form.date);

  return `<div class="stack">
    ${flashBar()}
    ${editingRound ? `<div class="note warn">Editing a posted round <button class="linkbtn" data-act="cancel-round-edit">Cancel</button></div>` : ""}

    <div class="row">
      <div>
        <div class="eyebrow">Date</div>
        <input class="field" type="date" name="date" value="${form.date}">
      </div>
      <div>
        <div class="eyebrow">Golfer</div>
        ${db.canManage() ? `<select class="field" name="golferId"><option value="">Select…</option>
          ${sortedGolfers().map((g) => `<option value="${g.id}" ${g.id === form.golferId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
        </select>` : `<div class="field locked">${esc((golferById(form.golferId) || {}).name || "You")}</div>`}
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

    ${todayGames.length ? `<div>
      <div class="eyebrow">Part of a game</div>
      <select class="field" name="gameId"><option value="">Not part of a game</option>
        ${todayGames.map((g) => `<option value="${g.id}" ${g.id === form.gameId ? "selected" : ""}>${esc(g.name || courseName(g.courseId))}</option>`).join("")}
      </select>
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

    <button class="btn" data-act="post" ${ready2 ? "" : "disabled"}>${editingRound ? "Save changes" : "Post round"}</button>
  </div>`;
}

const courseName = (id) => { const c = courseById(id); return c ? c.name : "Unknown course"; };

/* ================= history ================= */

function screenHistory() {
  /* A guest sees their own rounds. Nothing is hidden that concerns them, and
     nothing is shown that does not. */
  const mine = db.myGolferId(golfers);
  const scope = db.canManage() ? rounds : rounds.filter((r) => r.golferId === mine);
  const years = [...new Set(scope.map((r) => r.date.slice(0, 4)))].sort().reverse();
  const rows = scope.filter((r) =>
    (!filter.golferId || r.golferId === filter.golferId) &&
    (!filter.year || r.date.slice(0, 4) === filter.year) &&
    (!filter.month || r.date.slice(5, 7) === filter.month) &&
    (!filter.courseId || r.courseId === filter.courseId)
  ).sort((a, b) => b.date.localeCompare(a.date));

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
  ${rows.length === 0 ? empty("No rounds here yet", "Post one from the Enter tab, or widen the filters above.") : `
  <div class="eyebrow" style="display:flex;justify-content:space-between"><span>${rows.length} round${rows.length === 1 ? "" : "s"}</span><span>Differential</span></div>
  <div class="card list">${rows.map((r) => {
    const editable = db.canEditRound(r);
    return `<div style="padding:0.85rem 0.9rem">
      <div style="display:flex;gap:12px;justify-content:space-between">
        <div class="grow" style="min-width:0">
          <div><span class="sub">${r.date}</span> <span class="name">${esc((golferById(r.golferId) || {}).name || "Unknown")}</span></div>
          <div class="small truncate">${esc(r.courseName)} · ${esc(r.teeName)}</div>
          <div class="sub">${r.gross}${r.adjusted !== r.gross ? ` (adj ${r.adjusted})` : ""}${r.courseHandicap != null ? ` · net ${model.netScore(r)}` : ""} · ${(+r.rating).toFixed(1)}/${r.slope}</div>
          ${r.notes ? `<div class="small muted" style="font-style:italic">${esc(r.notes)}</div>` : ""}
        </div>
        <div style="text-align:right">
          <span class="stamp sm">${(+r.differential).toFixed(1)}</span>
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
  if (!rounds.length) return flashBar() + empty("Nothing to summarize yet", "Indexes and rankings appear once rounds are posted.") + versionBlock();

  const scoped = rounds.filter((r) => (!drill.year || r.date.slice(0, 4) === drill.year) && (!drill.month || r.date.slice(5, 7) === drill.month));
  const level = drill.month ? "golfer" : drill.year ? "month" : "year";
  let items;
  if (level === "year") items = [...new Set(rounds.map((r) => r.date.slice(0, 4)))].sort().reverse()
    .map((y) => ({ key: y, label: y, list: rounds.filter((r) => r.date.slice(0, 4) === y) }));
  else if (level === "month") items = [...new Set(scoped.map((r) => r.date.slice(5, 7)))].sort().reverse()
    .map((m) => ({ key: m, label: MONTHS[+m - 1], list: scoped.filter((r) => r.date.slice(5, 7) === m) }));
  else items = [...new Set(scoped.map((r) => r.golferId))]
    .map((id) => ({ key: id, label: (golferById(id) || {}).name || "Unknown", list: scoped.filter((r) => r.golferId === id) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const stat = (l) => `${l.length} round${l.length === 1 ? "" : "s"} · avg ${(l.reduce((a, r) => a + r.gross, 0) / l.length).toFixed(1)} · best diff ${Math.min(...l.map((r) => +r.differential)).toFixed(1)}`;

  return `${flashBar()}
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Handicap Index</h2></div>
    <div class="indexes">${sortedGolfers().filter((g) => rounds.some((r) => r.golferId === g.id)).map((g) => {
      const n = rounds.filter((r) => r.golferId === g.id).length;
      return `<button class="idx" data-golfer-index="${g.id}">
        <div class="name truncate">${esc(g.name)}</div>
        <div class="big ${g.handicapIndex == null ? "none" : ""}">${g.handicapIndex == null ? "—" : (+g.handicapIndex).toFixed(1)}</div>
        <div class="small muted">${g.handicapIndex == null ? `${Math.max(0, 3 - n)} more round${3 - n === 1 ? "" : "s"} needed` : `from ${n} round${n === 1 ? "" : "s"}`}</div>
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
  const years = [...new Set(rounds.map((r) => r.date.slice(0, 4)))].sort().reverse();
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
            <span class="sub">${g.date} · ${played.length} player${played.length === 1 ? "" : "s"}</span>
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
    <label class="lbl">Course</label>
    <select class="field" name="g-course"><option value="">Select…</option>
      ${sortedCourses().map((c) => `<option value="${c.id}" ${c.id === d.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    <label class="lbl">Name (optional)</label>
    <input class="field" name="g-name" value="${esc(d.name)}" placeholder="Saturday medal">
    <div class="inline-actions stacked">
      <button class="btn" data-act="save-game">Save game</button>
      <button class="btn ghost" data-act="cancel-game">Cancel</button>
    </div>
  </div>`;
}

function gameDetail(gameId) {
  const game = games.find((g) => g.id === gameId);
  if (!game) { openGame = null; return screenGames(); }
  const played = rounds.filter((r) => r.gameId === gameId);
  const board = model.gameLeaderboard(played, golfers);

  return `${flashBar()}
  <section class="panel">
    <div class="panel-head">
      <h2 class="panel-title"><button class="linkbtn" data-act="close-game">‹</button> ${esc(game.name || courseName(game.courseId))}</h2>
    </div>
    <p class="hint">${game.date} · ${esc(courseName(game.courseId))}</p>
    ${board.length === 0 ? `<div class="card"><p class="blank">No rounds posted to this game yet. On the Enter tab, pick this game when posting.</p></div>` : `
    <div class="card list">
      ${board.map((row) => `<div class="list-row">
        <span class="rank">${row.netPlace || "—"}</span>
        <span class="grow">
          <span class="name">${esc(row.name)}</span><br>
          <span class="sub">${esc(row.teeName)} · gross ${row.gross} (#${row.grossPlace || "—"})${row.courseHandicap != null ? ` · handicap ${row.courseHandicap}` : ""}</span>
        </span>
        <span class="netavg">${row.net == null ? "—" : row.net}<br><span class="sub">net</span></span>
      </div>`).join("")}
    </div>
    <div class="inline-actions stacked">
      <button class="btn" data-act="share-game">Share the result</button>
      ${db.canManage() ? `<button class="btn ghost warn" data-act="delete-game">Delete game</button>` : ""}
    </div>
    <p class="hint">Ranked on net. Gross placing is shown beside each player.</p>`}
  </section>`;
}

/* ================= sharing ================= */

function gameShareText(gameId) {
  const game = games.find((g) => g.id === gameId);
  const board = model.gameLeaderboard(rounds.filter((r) => r.gameId === gameId), golfers);
  const lines = [
    `${game.name || courseName(game.courseId)} — ${game.date}`,
    courseName(game.courseId),
    "",
    "Net:",
    ...board.filter((r) => r.net != null).sort((a, b) => a.netPlace - b.netPlace)
      .map((r) => `${r.netPlace}. ${r.name} ${r.net} (gross ${r.gross})`),
  ];
  const grossOrder = [...board].sort((a, b) => a.grossPlace - b.grossPlace);
  lines.push("", "Gross:", ...grossOrder.map((r) => `${r.grossPlace}. ${r.name} ${r.gross}`));
  lines.push("", `Posted with The Scorecard`);
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

function openShare(text, title) {
  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center"><h2>${esc(title)}</h2>
      <button class="rowbtn" data-close="1">Close</button></div>
    <pre class="msg">${esc(text)}</pre>
    <div class="share-grid" style="margin-top:1rem">
      <button class="btn" data-send="whatsapp">WhatsApp</button>
      <button class="btn" data-send="email">Email</button>
      <button class="btn ghost" data-send="sms">Text message</button>
      <button class="btn ghost" data-send="copy">Copy</button>
    </div>
    ${navigator.share ? `<div class="inline-actions stacked"><button class="btn ghost" data-send="native">More apps…</button></div>` : ""}
  </div>`;
  sheetEl.dataset.text = text;
  sheetEl.dataset.title = title;
}

/* ================= manage ================= */

function screenManage() {
  if (!db.canManage()) return empty("Manage is for organisers", "Your group's organiser looks after the roster and courses. You can post rounds on the Enter tab.");

  return `${flashBar()}
  ${newGroupDraft ? `<section class="panel">
    <div class="card editor">
      <div class="editor-title">Start another group</div>
      <p class="hint">A separate set of rounds and games. Golfers you add to both keep one handicap across them.</p>
      <label class="lbl">Group name</label>
      <input class="field" name="new-group-name" placeholder="Tuesday Fourball">
      <div class="inline-actions stacked">
        <button class="btn" data-act="save-new-group">Create it</button>
        <button class="btn ghost" data-act="cancel-new-group">Cancel</button>
      </div>
    </div>
  </section>` : ""}

  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Golfers in this group</h2><span class="panel-count">${golfers.length || ""}</span></div>
    <div class="card">
      ${golfers.length ? `<div class="list">
        ${sortedGolfers().map((g) => {
          if (editingGolfer === g.id) {
            return `<div class="inline-form">
              <input name="rename-golfer" class="inline-input" value="${esc(g.name)}" autocomplete="off">
              <div class="inline-actions">
                <button class="btn compact" data-act="save-rename">Save</button>
                <button class="btn ghost compact" data-act="cancel-rename">Cancel</button>
              </div></div>`;
          }
          const used = rounds.some((r) => r.golferId === g.id);
          return `<div class="list-row">
            <span class="grow"><span class="name">${esc(g.name)}</span><br>
              <span class="sub">${g.handicapIndex == null ? "no index yet" : `index ${(+g.handicapIndex).toFixed(1)}`} · ${g.roundCount || 0} round${g.roundCount === 1 ? "" : "s"}</span></span>
            <button class="rowbtn" data-rename="${g.id}">Rename</button>
            <button class="rowbtn warn" data-del-golfer="${g.id}">Remove</button>
          </div>`;
        }).join("")}
      </div>` : `<p class="blank">Nobody on the roster yet.</p>`}
      <div class="inline-form bordered">
        <input name="new-golfer" class="inline-input" placeholder="Type a name" autocomplete="off">
        <div class="inline-actions"><button class="btn compact" data-act="add-golfer">Add golfer</button></div>
      </div>
    </div>
    <p class="hint">Rename changes that person in every group. Remove takes them off this group's roster only — their rounds and handicap stay.</p>
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
      ${groups.map((g) => `<button class="list-row" data-goto-group="${esc(g.id)}">
        <span class="grow"><span class="name">${esc(g.name)}</span>${g.id === current ? `<br><span class="sub">you are here</span>` : ""}</span>
        ${g.id === current ? `<span class="chev">✓</span>` : `<span class="chev">›</span>`}
      </button>`).join("")}
    </div>
    <div class="inline-actions stacked">
      <button class="btn ghost" data-act="new-group">Start another group</button>
    </div>
    <p class="hint">A golfer's handicap is the same in every group — it is built from all their rounds, wherever they played them.</p>
  </div>`;
}

function screenAdmin() {
  if (!db.isOwner()) return empty("Not your area", "Only the group owner manages people and settings.");

  return `${flashBar()}
  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">People</h2><span class="panel-count">${members.length || ""}</span></div>
    <div class="card">
      <div class="list">
        ${members.map((m) => {
          const you = m.uid === db.status().uid;
          return `<div class="list-row">
            <span class="grow"><span class="name">${esc(m.displayName || "Unnamed")}</span><br>
              <span class="sub">${roleLabel(m.role)}${you ? " · you" : ""}</span></span>
            ${m.role === "owner" ? "" : `<button class="rowbtn" data-role="${m.uid}:${m.role === "admin" ? "member" : "admin"}">${m.role === "admin" ? "Make guest" : "Make admin"}</button>`}
          </div>`;
        }).join("")}
      </div>
      <div class="inline-form bordered">
        <p class="hint" style="margin:0 0 0.7rem">Send this link to add somebody. They tap it, type their name, and they are in as a guest.</p>
        <div class="inline-actions">
          <button class="btn compact" data-act="share-invite">Send an invitation</button>
          <button class="btn ghost compact" data-act="show-code">Show the code</button>
        </div>
      </div>
    </div>
    <p class="hint"><b>Guests</b> post their own rounds and see the results. <b>Admins</b> also add courses, manage the roster and post for anybody. <b>You</b> can do everything, and only you can change these.</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Group</h2></div>
    <div class="card padded">
      <label class="lbl" style="margin-top:0">Group name</label>
      <input class="field" name="assoc-name" value="${esc(association ? association.name : "")}">
      <div class="inline-actions stacked">
        <button class="btn ghost" data-act="rename-group">Save the name</button>
      </div>
    </div>
  </section>

  ${backupSection()}
  ${lookupSection()}
  ${accountSection()}
  ${versionBlock()}`;
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

function accountSection() {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Account</h2></div>
    <div class="card padded">
      <div class="name">${esc(db.accountLabel())}</div>
      <div class="sub">${esc(sync.text)}${db.status().queued ? ` · ${db.status().queued} waiting to upload` : ""}</div>
      <div class="inline-actions stacked">
        <button class="btn ghost" data-act="google">${db.currentEmail() ? "Signed in" : "Sign in with Google (optional)"}</button>
      </div>
      <p class="hint">Optional, and not needed for anything. It only ties this device to a Google account so your access survives clearing browser data.</p>
    </div>
  </section>`;
}

/* Only the owner sees this, and only the owner can change it — the rules
   reject the write from anybody else. Everyone else in the group simply finds
   that course search works. */
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

function versionBlock() {
  return `<section class="version">
    <div><b>The Scorecard</b> <span class="mono">v${VERSION}</span></div>
    <div class="sub">${rounds.length} round${rounds.length === 1 ? "" : "s"} · ${golfers.length} golfer${golfers.length === 1 ? "" : "s"} · ${courses.length} course${courses.length === 1 ? "" : "s"}</div>
    <div class="sub">${esc(sync.text)} · World Handicap System, best 8 of last 20</div>
  </section>`;
}

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

function render() {
  try {
    if (!ready) {
      view.innerHTML = `<div class="boot">Opening your scorecard…</div>`;
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
      view.innerHTML = (screens[tab] || screenEnter)();
      const sub = document.getElementById("brandSub");
      const groups = db.knownGroups();
      sub.textContent = (association ? association.name : "Handicap tracking") + (groups.length > 1 ? "  ▾" : "");
      sub.dataset.act = "switch-group";
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
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  if (tab === "enter") editingRound = null;
  if (tab !== "games") openGame = null;
  render();
});

document.getElementById("statusBtn").onclick = () => openBackupSheet();

document.getElementById("brandSub").onclick = () => {
  if (!db.currentAssociation()) return;
  sheetEl.hidden = false;
  sheetEl.innerHTML = groupSwitcher();
};

view.addEventListener("input", (e) => {
  const n = e.target.name;
  if (n === "gross" || n === "adjusted") { form[n] = e.target.value.replace(/\D/g, ""); e.target.value = form[n]; return; }
  if (n === "notes") { form.notes = e.target.value; return; }
  if (n === "finder-q") { finder.q = e.target.value; return; }
  if (n === "join-name" || n === "join-name-2") { joinForm.name = e.target.value; return; }
  if (n === "group-name" || n === "import-group") { joinForm.groupName = e.target.value; return; }
  if (n === "import-name") { joinForm.name = e.target.value; return; }
  if (n === "join-code") { joinForm.code = e.target.value; return; }
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
  if (n === "date") { form.date = v; render(); }
  if (n === "golferId") { form.golferId = v; render(); }
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
  if (n === "g-date") { gameDraft.date = v; }
  if (n === "g-course") { gameDraft.courseId = v; }
});

view.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.name === "new-golfer") { e.preventDefault(); addGolfer(); }
  if (e.target.name === "rename-golfer") { e.preventDefault(); saveRename(); }
  if (e.target.name === "finder-q") { e.preventDefault(); runFinder(); }
});

view.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act],[data-tee],[data-go],[data-edit],[data-del],[data-confirm-del],[data-unfilter],[data-drill],[data-golfer-index],[data-del-golfer],[data-rename],[data-course],[data-pick],[data-rm-tee],[data-game],[data-role]");
  if (!t) return;
  const d = t.dataset;

  if (d.go) { tab = d.go; return render(); }
  if (d.tee) { form.teeId = d.tee; return render(); }
  if (d.game) { openGame = d.game; return render(); }
  if (d.unfilter) { filter[d.unfilter] = ""; return render(); }
  if (d.golferIndex) { filter = { golferId: d.golferIndex, year: "", month: "", courseId: "" }; tab = "history"; return render(); }
  if (d.drill) {
    if (!drill.year) drill.year = d.drill;
    else if (!drill.month) drill.month = d.drill;
    else { filter = { golferId: d.drill, year: drill.year, month: drill.month, courseId: "" }; tab = "history"; }
    return render();
  }
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
    db.deleteRound(d.confirmDel);
    if (r) await db.rebuildGolferIndex(r.golferId);
    confirmId = null;
    flashMsg("Round deleted");
    return;
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
    case "post": return postRound();

    case "begin": return begin();
    case "accept-invite": return acceptInvite();
    case "join-by-code": return joinByCode();
    case "show-code": showCodeEntry = true; return render();
    case "hide-code": showCodeEntry = false; return render();
    case "create-group": return createGroup();
    case "import-v1": return importV1();

    case "add-golfer": return addGolfer();
    case "save-new-group": {
      const field = view.querySelector('[name="new-group-name"]');
      const name = (field ? field.value : "").trim();
      if (!name) { flashMsg("Give the group a name"); return; }
      newGroupDraft = false;
      flashMsg("Creating…");
      try {
        const me = members.find((m) => m.uid === db.status().uid);
        const created = await db.createAnotherGroup({ name, displayName: me ? me.displayName : "Me" });
        await start(created.id);
        flashMsg(`${name} created. You are its owner.`);
      } catch { flashMsg("Couldn't create it — the red bar above says why."); render(); }
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

    case "new-game": gameDraft = { date: today(), courseId: "", name: "" }; return render();
    case "cancel-game": gameDraft = null; return render();
    case "save-game": return saveGame();
    case "close-game": openGame = null; return render();
    case "delete-game": db.deleteGame(openGame); openGame = null; flashMsg("Game deleted"); return render();
    case "share-game": return openShare(gameShareText(openGame), "Game result");
    case "share-ranking": return openShare(rankingShareText(), "Rankings");

    case "share-invite": return openShare(
      `Join our golf scorecard:\n${db.joinLink(association)}\n\nOne tap, enter your name, done.`, "Invitation");
    case "show-code": return flashMsg(`Group code: ${association.joinCode}`);

    case "rename-group": {
      const field = view.querySelector('[name="assoc-name"]');
      const name = (field ? field.value : "").trim();
      if (!name) { flashMsg("Give the group a name"); return; }
      db.updateAssociation({ name });
      flashMsg("Renamed");
      return;
    }
    case "backup": return openBackupSheet();
    case "restore": return askForBackupFile();
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
  if (e.target === sheetEl || e.target.closest("[data-close]")) { sheetEl.hidden = true; return; }

  const goto = e.target.closest("[data-goto-group]");
  if (goto) {
    sheetEl.hidden = true;
    const id = goto.dataset.gotoGroup;
    if (id === db.currentAssociation()) return;
    switching = true; render();
    const member = await db.loadMembership(id);
    switching = false;
    if (member) { await start(id); flashMsg("Switched"); }
    else flashMsg("You are no longer a member of that group.");
    return;
  }

  if (e.target.closest('[data-act="new-group"]')) {
    sheetEl.hidden = true;
    newGroupDraft = true;
    render();
    return;
  }
  const send = e.target.closest("[data-send]");
  if (!send) return;
  const text = sheetEl.dataset.text || "";
  const how = send.dataset.send;
  if (how === "save") return saveBackup();
  if (how === "download") return downloadBackup();
  if (how === "whatsapp") open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  else if (how === "email") location.href = `mailto:?subject=${encodeURIComponent(sheetEl.dataset.title || "")}&body=${encodeURIComponent(text)}`;
  else if (how === "sms") location.href = `sms:?&body=${encodeURIComponent(text)}`;
  else if (how === "copy") { navigator.clipboard?.writeText(text); }
  else if (how === "native") navigator.share({ text }).catch(() => {});
});

/* ================= actions ================= */

/* Joins or creates, whichever fits, then lands on Enter. */
async function begin() {
  const name = ((view.querySelector('[name="join-name"]') || {}).value || joinForm.name).trim();
  if (!name) { flashMsg("Type the name you play under"); return; }
  joinForm.name = name;
  const invite = db.readJoinLink();
  if (invite) return acceptInvite();
  return createGroup(name);
}

async function acceptInvite() {
  const invite = db.readJoinLink();
  const name = ((view.querySelector('[name="join-name"]') || {}).value || joinForm.name).trim();
  if (!name) { flashMsg("Type the name you play under"); return; }
  joining = true;
  flashMsg("Joining…");
  const result = await db.joinAssociation({ associationId: invite.associationId, code: invite.code, displayName: name });
  if (result.ok) {
    db.clearJoinLink();
    await db.linkGolferForMember(name);
    await start(invite.associationId);
    joining = false;
    flashMsg("You're in. Post your round on the Enter tab.");
  } else { joining = false; render(); }
}

async function joinByCode() {
  const name = ((view.querySelector('[name="join-name"]') || {}).value || joinForm.name).trim();
  const code = ((view.querySelector('[name="join-code"]') || {}).value || joinForm.code).trim();
  if (!name) { flashMsg("Type the name you play under"); return; }
  if (!code) { flashMsg("Type the group code"); return; }

  joining = true;
  flashMsg("Checking the code…");
  const assocId = await db.findAssociationByCode(code);
  if (!assocId) {
    joining = false;
    flashMsg("No group has that code. Codes are six characters — check it, or ask for the invitation link instead.");
    return render();
  }
  const result = await db.joinAssociation({ associationId: assocId, code, displayName: name });
  if (result.ok) {
    await db.linkGolferForMember(name);
    await start(assocId);
    joining = false;
    flashMsg("You're in. Post your round on the Enter tab.");
  } else { joining = false; render(); }
}

async function createGroup(name) {
  joining = true;
  flashMsg("Setting up…");
  try {
    /* Named after them for now. Renaming it lives in Admin, for later. */
    const created = await db.createAssociation({ name: `${name}'s group`, displayName: name });
    await db.linkGolferForMember(name);
    await start(created.id);
    joining = false;
    flashMsg("Ready. Post a round, or invite the others from the Admin tab.");
  } catch {
    joining = false;
    flashMsg("Couldn't set up the group — the red bar above says why.");
    render();
  }
}

async function addGolfer() {
  const input = view.querySelector('[name="new-golfer"]');
  const name = (input ? input.value : "").trim();
  if (!name) { flashMsg("Type a name first"); return; }
  if (golfers.some((g) => g.name.toLowerCase() === name.toLowerCase())) { flashMsg(`${name} is already in this group`); return; }
  try {
    const { golfer, reused } = await db.addGolfer({ name });
    flashMsg(reused
      ? `${golfer.name} added — same person as in your other group, so their handicap comes with them.`
      : `${golfer.name} added`);
  } catch { flashMsg("Couldn't add them — the red bar above says why."); }
  render();
}

async function saveRename() {
  const input = view.querySelector('[name="rename-golfer"]');
  const next = (input ? input.value : "").trim();
  if (!next) { flashMsg("Type a name first"); return; }
  const id = editingGolfer;
  editingGolfer = null;
  const result = await db.renameGolfer(id, next);
  if (result.ok) flashMsg(`Renamed to ${next}. That is their name in every group.`);
  else if (result.reason === "TAKEN") flashMsg(`Another golfer is already called ${next}. Names have to be unique — try adding an initial.`);
  else flashMsg("Couldn't rename them.");
  render();
}

function saveCourse() {
  const c = { ...courseDraft, name: courseDraft.name.trim(),
    tees: courseDraft.tees.filter((t) => t.name.trim() && t.rating && t.slope && t.par) };
  if (!c.name || !c.tees.length) { flashMsg("A course needs a name and at least one complete tee"); return; }
  db.addCourse(c);
  courseDraft = null;
  finder = { q: "", results: [], busy: false, msg: "" };
  flashMsg(`${c.name} added`);
}

function saveGame() {
  if (!gameDraft.courseId) { flashMsg("Pick the course"); return; }
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

  const { round } = db.postRound({
    golfer, course, tee, date: form.date,
    gross: form.gross, adjusted: form.adjusted, notes: form.notes,
    gameId: form.gameId || null,
  });
  form = { ...form, gross: "", adjusted: "", notes: "", date: today() };
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

db.onChange((s) => { sync = s; render(); });

(async function boot() {
  render();
  await db.init();

  const invite = db.readJoinLink();
  const remembered = db.recallAssociation();

  if (remembered) {
    const member = await db.loadMembership(remembered);
    if (member) await start(remembered);
  }

  /* Look for a version 1 scorecard, so the offer to import appears without
     anybody having to know it exists. */
  if (!db.currentAssociation()) {
    legacy = await db.readLegacyV1();
  }

  ready = true;
  render();
})();
