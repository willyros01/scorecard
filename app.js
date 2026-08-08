import * as db from "./db.js";
import * as lookup from "./courses-api.js";

const VERSION = (typeof self !== "undefined" && self.APP_VERSION) || "dev";
const BUILD = (typeof self !== "undefined" && self.APP_BUILD) || "";

/* ================= handicap math (World Handicap System) ================= */
const r1 = (n) => Math.round(n * 10) / 10;
export const differential = (adjGross, rating, slope) => r1((113 / +slope) * (+adjGross - +rating));

// Rule 5.2a — differentials used, and the adjustment, below 20 rounds
const TABLE = { 3:[1,-2], 4:[1,-1], 5:[1,0], 6:[2,-1], 7:[2,0], 8:[2,0], 9:[3,0], 10:[3,0],
  11:[3,0], 12:[4,0], 13:[4,0], 14:[4,0], 15:[5,0], 16:[5,0], 17:[6,0], 18:[6,0], 19:[7,0], 20:[8,0] };

function handicapIndex(diffsChrono) {
  const recent = diffsChrono.slice(-20);
  if (recent.length < 3) return null;
  const [count, adj] = TABLE[Math.min(recent.length, 20)];
  const best = [...recent].sort((a, b) => a - b).slice(0, count);
  return Math.min(54, r1(best.reduce((a, b) => a + b, 0) / count + adj));
}
const courseHandicap = (idx, slope, rating, par) => Math.round(idx * (+slope / 113) + (+rating - +par));

/* ================= state ================= */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);

let state = { golfers: [], courses: [], rounds: [] };
let sync = { text: "Starting", alert: false };
let tab = "enter";
let form = { date: today(), golfer: "", courseId: "", teeId: "", gross: "", adjusted: "", notes: "" };
let editingId = null;
let filter = { golfer: "", year: "", month: "", courseId: "" };
let drill = { year: null, month: null };
let shareGolfer = "";
let flash = null;
let confirmId = null;

const view = document.getElementById("view");
const sheetEl = document.getElementById("sheet");

const save = async (next) => { state = next; render(); await db.save(next); };

/* ================= derived ================= */
function diffsFor(golfer) {
  return state.rounds.filter((r) => r.golfer === golfer)
    .sort((a, b) => a.date.localeCompare(b.date)).map((r) => r.differential);
}
const indexFor = (g) => handicapIndex(diffsFor(g));
const activeGolfers = () => state.golfers.filter((g) => state.rounds.some((r) => r.golfer === g));

/* ================= text size ================= */
const SIZES = [
  { id: "normal", label: "A", scale: 1 },
  { id: "large",  label: "A+", scale: 1.18 },
  { id: "huge",   label: "A++", scale: 1.36 },
];
function applySize() {
  const id = localStorage.getItem("golf:textsize") || "normal";
  const size = SIZES.find((s) => s.id === id) || SIZES[0];
  document.documentElement.style.fontSize = 16 * size.scale + "px";
  document.documentElement.dataset.size = size.id;
  document.getElementById("sizeBtn").textContent = size.label;
}
document.getElementById("sizeBtn").onclick = () => {
  const current = localStorage.getItem("golf:textsize") || "normal";
  const next = SIZES[(SIZES.findIndex((s) => s.id === current) + 1) % SIZES.length];
  localStorage.setItem("golf:textsize", next.id);
  applySize();
};
applySize();

/* ================= night mode ================= */
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

/* ================= screens ================= */
function empty(title, hint) {
  return `<div class="empty"><h2>${title}</h2><p>${hint}</p></div>`;
}

function screenEnter() {
  if (!state.golfers.length || !state.courses.length) {
    return empty("Set up your roster first", "Add a golfer and a rated course, then you can post rounds anywhere — signal or not.")
      + `<button class="btn" data-go="manage">Add golfers and courses</button>`;
  }
  const course = state.courses.find((c) => c.id === form.courseId);
  const tee = course && course.tees.find((t) => t.id === form.teeId);
  const ags = +(form.adjusted || form.gross);
  const diff = tee && form.gross ? differential(ags, tee.rating, tee.slope) : null;
  const idx = form.golfer ? indexFor(form.golfer) : null;
  const ch = idx != null && tee ? courseHandicap(idx, tee.slope, tee.rating, tee.par) : null;
  const ready = form.golfer && tee && +form.gross > 0;

  return `
  ${editingId ? `<div class="note warn" style="display:flex;justify-content:space-between">Editing a posted round <button class="linkbtn" data-act="cancel-edit">Cancel</button></div>` : ""}
  ${flash ? `<div class="note">${esc(flash)}</div>` : ""}
  <div class="stack">
    <div class="row">
      <div><div class="eyebrow">Date</div><input class="field" type="date" name="date" value="${form.date}"></div>
      <div><div class="eyebrow">Golfer</div>
        <select class="field" name="golfer"><option value="">Select…</option>
        ${state.golfers.map((g) => `<option ${g === form.golfer ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>
      </div>
    </div>
    <div><div class="eyebrow">Course</div>
      <select class="field" name="courseId"><option value="">Select…</option>
      ${state.courses.map((c) => `<option value="${c.id}" ${c.id === form.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    </div>
    ${course ? `<div><div class="eyebrow">Tees</div><div class="tees">
      ${course.tees.map((t) => `<button class="tee ${t.id === form.teeId ? "on" : ""}" data-tee="${t.id}">
        <b>${esc(t.name)}</b><span class="sub">${(+t.rating).toFixed(1)} / ${t.slope} · par ${t.par}</span></button>`).join("")}
    </div></div>` : ""}
    <div class="row">
      <div><div class="eyebrow">Gross score</div><input class="field score" name="gross" inputmode="numeric" value="${form.gross}" placeholder="—"></div>
      <div><div class="eyebrow">Adjusted</div><input class="field score" name="adjusted" inputmode="numeric" value="${form.adjusted}" placeholder="${form.gross || "same"}"></div>
    </div>
    <p class="small muted" style="margin:-6px 0 0">Adjusted gross caps each hole at net double bogey. Leave blank if it matches your gross.</p>
    <div><div class="eyebrow">Notes</div><input class="field" name="notes" value="${esc(form.notes)}" placeholder="Wind, partners, anything worth recalling"></div>
    ${diff != null || ch != null ? `<div class="preview">
      <div><div class="eyebrow" style="margin:0">This round</div>
        <div class="small">${ch != null ? `Playing off <b class="mono">${ch}</b> on these tees` : "Post 3 rounds to establish an index"}</div></div>
      ${diff != null ? `<span class="stamp">${diff.toFixed(1)}</span>` : ""}
    </div>` : ""}
    <button class="btn" data-act="post" ${ready ? "" : "disabled"}>${editingId ? "Save changes" : "Post round"}</button>
  </div>`;
}

function screenHistory() {
  const years = [...new Set(state.rounds.map((r) => r.date.slice(0, 4)))].sort().reverse();
  const rows = state.rounds.filter((r) =>
    (!filter.golfer || r.golfer === filter.golfer) &&
    (!filter.year || r.date.slice(0, 4) === filter.year) &&
    (!filter.month || r.date.slice(5, 7) === filter.month) &&
    (!filter.courseId || r.courseId === filter.courseId))
    .sort((a, b) => b.date.localeCompare(a.date));

  const chips = Object.entries(filter).filter(([, v]) => v).map(([k, v]) =>
    `<button class="pill" data-unfilter="${k}">${k === "month" ? MONTHS[+v - 1] : k === "courseId" ? esc((state.courses.find((c) => c.id === v) || {}).name || "Course") : esc(v)} ✕</button>`).join("");

  return `
  <div class="filters">
    <select class="field" name="f-golfer"><option value="">All golfers</option>
      ${state.golfers.map((g) => `<option ${g === filter.golfer ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>
    <select class="field" name="f-year"><option value="">All years</option>
      ${years.map((y) => `<option ${y === filter.year ? "selected" : ""}>${y}</option>`).join("")}</select>
    <select class="field" name="f-course"><option value="">All courses</option>
      ${state.courses.map((c) => `<option value="${c.id}" ${c.id === filter.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
  </div>
  ${chips ? `<div class="pills">${chips}<button class="linkbtn" data-act="clear-filters">Clear</button></div>` : ""}
  ${rows.length === 0 ? empty("No rounds here yet", "Post one from the Enter tab, or widen the filters above.") : `
  <div class="eyebrow" style="display:flex;justify-content:space-between"><span>${rows.length} round${rows.length === 1 ? "" : "s"}</span><span>Differential</span></div>
  <div class="card list">${rows.map((r) => `
    <div style="padding:12px 14px">
      <div style="display:flex;gap:12px;justify-content:space-between">
        <div class="grow" style="min-width:0">
          <div><span class="sub">${r.date}</span> <span class="name">${esc(r.golfer)}</span></div>
          <div class="small truncate">${esc(r.courseName)} · ${esc(r.teeName)}</div>
          <div class="sub">${r.gross}${r.adjusted !== r.gross ? ` (adj ${r.adjusted})` : ""} · ${(+r.rating).toFixed(1)}/${r.slope} · par ${r.par}</div>
          ${r.notes ? `<div class="small muted" style="font-style:italic">${esc(r.notes)}</div>` : ""}
        </div>
        <div style="text-align:right">
          <span class="stamp sm">${r.differential.toFixed(1)}</span>
          <div><button class="iconbtn" data-edit="${r.id}" aria-label="Edit">✎</button><button class="iconbtn warn" data-del="${r.id}" aria-label="Delete">🗑</button></div>
        </div>
      </div>
      ${confirmId === r.id ? `<div class="note warn" style="display:flex;justify-content:space-between;margin-top:8px">Delete this round?
        <span><button class="linkbtn" data-confirm-del="${r.id}">Delete</button> &nbsp; <button class="linkbtn" data-act="cancel-del" style="color:var(--muted)">Keep</button></span></div>` : ""}
    </div>`).join("")}</div>`}`;
}

function screenSummary() {
  if (!state.rounds.length) {
    return empty("Nothing to summarize yet", "Your index, trends and drill-downs appear once you post rounds.") + versionBlock();
  }

  const scoped = state.rounds.filter((r) => (!drill.year || r.date.slice(0, 4) === drill.year) && (!drill.month || r.date.slice(5, 7) === drill.month));
  const level = drill.month ? "golfer" : drill.year ? "month" : "year";
  let items;
  if (level === "year") items = [...new Set(state.rounds.map((r) => r.date.slice(0, 4)))].sort().reverse()
    .map((y) => ({ key: y, label: y, list: state.rounds.filter((r) => r.date.slice(0, 4) === y) }));
  else if (level === "month") items = [...new Set(scoped.map((r) => r.date.slice(5, 7)))].sort().reverse()
    .map((m) => ({ key: m, label: MONTHS[+m - 1], list: scoped.filter((r) => r.date.slice(5, 7) === m) }));
  else items = [...new Set(scoped.map((r) => r.golfer))].sort()
    .map((g) => ({ key: g, label: g, list: scoped.filter((r) => r.golfer === g) }));

  const stat = (l) => `${l.length} round${l.length === 1 ? "" : "s"} · avg ${(l.reduce((a, r) => a + r.gross, 0) / l.length).toFixed(1)} · best diff ${Math.min(...l.map((r) => r.differential)).toFixed(1)}`;

  return `
  <section>
    <div class="eyebrow">Current Handicap Index</div>
    <div class="indexes">${activeGolfers().map((g) => {
      const i = indexFor(g), n = state.rounds.filter((r) => r.golfer === g).length;
      return `<button class="idx" data-golfer-index="${esc(g)}">
        <div class="name truncate">${esc(g)}</div>
        <div class="big ${i == null ? "none" : ""}">${i == null ? "—" : i.toFixed(1)}</div>
        <div class="small muted">${i == null ? `${3 - n} more round${3 - n === 1 ? "" : "s"} to establish` : `best ${TABLE[Math.min(n, 20)][0]} of last ${Math.min(n, 20)}`}</div>
      </button>`;
    }).join("")}</div>
  </section>
  <section>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div class="eyebrow" style="margin:0">${drill.year || drill.month ? `<button class="linkbtn" data-act="drill-back" style="text-decoration:none">‹</button> ` : ""}
        By ${level === "year" ? "year" : level === "month" ? `month · ${drill.year}` : `golfer · ${MONTHS[+drill.month - 1]} ${drill.year}`}</div>
      ${drill.year ? `<button class="linkbtn" data-act="view-scope">View all rounds</button>` : ""}
    </div>
    <div class="card list" style="margin-top:8px">${items.map((it) => `
      <button class="list-row" data-drill="${esc(it.key)}">
        <span class="grow"><span class="name">${esc(it.label)}</span><br><span class="sub">${stat(it.list)}</span></span>
        <span class="caret">›</span>
      </button>`).join("")}</div>
    <p class="small muted" style="margin-top:8px">${level === "golfer" ? "Tap a golfer to open those rounds in History." : "Tap a row to drill down."}</p>
  </section>
  ${versionBlock()}`;
}

function versionBlock() {
  return `<section class="version">
    <div><b>The Scorecard</b> <span class="mono">v${VERSION}</span>${BUILD ? ` <span class="muted">· ${BUILD}</span>` : ""}</div>
    <div class="sub">${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"} · ${state.golfers.length} golfer${state.golfers.length === 1 ? "" : "s"} · ${state.courses.length} course${state.courses.length === 1 ? "" : "s"}</div>
    <div class="sub">${esc(sync.text)} · World Handicap System, best 8 of last 20</div>
  </section>`;
}

/* ---------- share ---------- */
function shareText(g) {
  const rounds = state.rounds.filter((r) => r.golfer === g).sort((a, b) => a.date.localeCompare(b.date));
  const idx = indexFor(g);
  const last = rounds[rounds.length - 1];
  const recent = rounds.slice(-20);
  const lines = [
    `${g} — Handicap update`,
    idx == null ? `Index: not established (${rounds.length} of 3 rounds posted)` : `Handicap Index: ${idx.toFixed(1)}`,
  ];
  if (recent.length) {
    lines.push(`Last ${recent.length} rounds: avg ${(recent.reduce((a, r) => a + r.gross, 0) / recent.length).toFixed(1)}, best differential ${Math.min(...recent.map((r) => r.differential)).toFixed(1)}`);
  }
  if (last) lines.push(`Latest: ${last.date} · ${last.courseName} (${last.teeName}) ${last.gross} → differential ${last.differential.toFixed(1)}`);
  lines.push(`Posted with The Scorecard · ${location.origin}${location.pathname}`);
  return lines.join("\n");
}

function screenShare() {
  const list = activeGolfers();
  if (!list.length) return empty("No one to report on yet", "Post a round and you can send an index straight to the group.");
  if (!shareGolfer || !list.includes(shareGolfer)) shareGolfer = list[0];
  const text = shareText(shareGolfer);
  return `
  <div class="stack">
    <div><div class="eyebrow">Send an update for</div>
      <select class="field" name="share-golfer">${list.map((g) => `<option ${g === shareGolfer ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></div>
    <pre class="msg">${esc(text)}</pre>
    <div class="share-grid">
      <button class="btn" data-send="whatsapp">WhatsApp</button>
      <button class="btn" data-send="email">Email</button>
      <button class="btn ghost" data-send="sms">Text message</button>
      <button class="btn ghost" data-send="copy">Copy</button>
    </div>
    ${navigator.share ? `<button class="btn ghost" data-send="native">More apps…</button>` : ""}
    <p class="small muted">Numbers follow the World Handicap System: the average of your best 8 differentials from the last 20 rounds. It isn't an official GHIN index.</p>
  </div>`;
}

function send(how) {
  const text = shareText(shareGolfer);
  const subject = `${shareGolfer} — handicap update`;
  if (how === "whatsapp") open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  else if (how === "email") location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  else if (how === "sms") location.href = `sms:?&body=${encodeURIComponent(text)}`;
  else if (how === "copy") { navigator.clipboard?.writeText(text); flashMsg("Copied to the clipboard"); }
  else if (how === "native") navigator.share({ title: subject, text }).catch(() => {});
}

/* ---------- manage ---------- */
let courseDraft = null;
let finder = { q: "", results: [], busy: false, msg: "" };
let editingGolfer = null;
let openCourse = null;
const SUPER_ADMIN = "willyros01@gmail.com";

function screenManage() {
  return `
  <section>
    <div class="eyebrow">Golfers</div>
    <div class="card list">
      ${state.golfers.map((g) => {
        const used = state.rounds.some((r) => r.golfer === g);
        if (editingGolfer === g) {
          return `<div class="addrow">
            <input name="rename-golfer" value="${esc(g)}" autocomplete="off">
            <button class="btn addbtn" data-act="save-rename">Save</button>
            <button class="btn ghost addbtn" data-act="cancel-rename">Cancel</button>
          </div>`;
        }
        return `<div class="list-row"><span class="grow name">${esc(g)}</span>
          <button class="rowbtn" data-rename="${esc(g)}">Edit</button>
          <button class="rowbtn warn" data-del-golfer="${esc(g)}" ${used ? "disabled title='Has posted rounds — delete those first'" : ""}>Delete</button></div>`;
      }).join("")}
      <div class="addrow">
        <input name="new-golfer" placeholder="Type a name" autocomplete="off">
        <button class="btn addbtn" data-act="add-golfer">Add golfer</button>
      </div>
    </div>
  </section>
  <section>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div class="eyebrow" style="margin:0">Courses and tees</div>
      <button class="linkbtn" data-act="new-course">＋ New</button>
    </div>
    <div class="stack" style="margin-top:8px">
      ${state.courses.length === 0 && !courseDraft ? `<div class="card" style="padding:20px;text-align:center"><p class="small muted" style="margin:0">Add a course with its rating and slope — both are printed on the scorecard.</p></div>` : ""}
      ${state.courses.length ? `<div class="card list">
      ${state.courses.map((c) => {
        const used = state.rounds.some((r) => r.courseId === c.id);
        const open = openCourse === c.id;
        return `<div>
          <button class="course-head" data-course="${c.id}" aria-expanded="${open}">
            <span class="grow">
              <span class="name">${esc(c.name)}</span><br>
              <span class="sub">${c.tees.length} tee${c.tees.length === 1 ? "" : "s"}${used ? " · in use" : ""}</span>
            </span>
            <span class="chev">${open ? "▾" : "▸"}</span>
          </button>
          ${open ? `<div class="course-body">
            ${c.tees.map((t) => `<div class="teeline"><span>${esc(t.name)}</span><span>${(+t.rating).toFixed(1)} / ${t.slope} · par ${t.par}</span></div>`).join("")}
            <div class="course-actions">
              <button class="rowbtn" data-edit-course="${c.id}">Edit</button>
              <button class="rowbtn warn" data-del-course="${c.id}" ${used ? "disabled title='Rounds use this course'" : ""}>Delete</button>
            </div>
          </div>` : ""}
        </div>`;
      }).join("")}
      </div>` : ""}
      ${courseDraft ? courseEditor() : ""}
    </div>
  </section>
  <section>
    <div class="eyebrow">Sync</div>
    <div class="card" style="padding:14px">
      <div class="small">${esc(db.accountLabel())}</div>
      <div class="sub" style="margin-bottom:10px">${esc(sync.text)}${db.hasPending() ? " · changes waiting to upload" : ""}</div>
      <div class="row">
        <button class="btn ghost" data-act="google">Use a Google account</button>
        <button class="btn ghost" data-act="backup">Backup text</button>
      </div>
    </div>
    <p class="small muted" style="margin-top:8px">Signing in with Google carries this scorecard to your other devices.</p>
  </section>
  ${lookupSection()}`;
}

/* Administrative, and only for the account that owns the app. Everyone else
   never learns the key box exists — searching simply works for them. */
function lookupSection() {
  if (db.currentEmail() !== SUPER_ADMIN) return "";
  if (lookup.usingEmbeddedKey()) {
    return `<section>
      <div class="eyebrow">Course lookup — super admin</div>
      <div class="card" style="padding:14px">
        <p class="small" style="margin:0">The search key is built into the app, so nobody has to enter one. To change it, edit <b>lookup-key.js</b> in the repository and commit — everyone picks it up on their next reload.</p>
      </div>
    </section>`;
  }
  return `<section>
    <div class="eyebrow">Course lookup — super admin</div>
    <div class="card" style="padding:14px">
      <p class="small muted" style="margin:0 0 10px">No key is built into the app yet. Paste one from <b>golfcourseapi.com</b> to enable search on this device, or add it to <b>lookup-key.js</b> in the repository so everyone gets it.</p>
      <input class="field" name="apikey" value="${esc(lookup.getKey())}" placeholder="Paste your lookup key">
      <div class="row" style="margin-top:10px">
        <button class="btn ghost" data-act="save-key">${lookup.hasKey() ? "Update key" : "Save key"}</button>
        ${lookup.hasKey() ? `<button class="btn ghost" data-act="clear-key">Remove</button>` : ""}
      </div>
    </div>
  </section>`;
}

function courseEditor() {
  const d = courseDraft;
  return `<div class="card" style="padding:14px;border-width:2px;border-color:var(--pine)">
    <div class="eyebrow">Find a course by name</div>
    <div class="row" style="gap:6px">
      <input class="field" name="finder-q" value="${esc(finder.q)}" placeholder="e.g. Pebble Creek, or a club name">
      <button class="btn" data-act="find" style="flex:0 0 92px" ${finder.busy ? "disabled" : ""}>${finder.busy ? "…" : "Search"}</button>
    </div>
    ${finder.msg ? `<p class="small muted" style="margin-top:8px">${esc(finder.msg)}</p>` : ""}
    ${finder.results.length ? `<div class="card list" style="margin-top:10px">
      ${finder.results.map((c, i) => `<button class="list-row" data-pick="${i}">
        <span class="grow"><span class="name">${esc(c.name)}</span><br>
        <span class="sub">${esc(c.where || "")}${c.where ? " · " : ""}${c.tees.length} rated tee${c.tees.length === 1 ? "" : "s"}</span></span>
        <span class="caret">›</span></button>`).join("")}
    </div>
    <p class="small muted" style="margin-top:6px">Tap one to fill in the tees, then check them against the scorecard before saving.</p>` : ""}
    <div class="eyebrow" style="margin-top:16px">Course name</div>
    <input class="field" name="c-name" value="${esc(d.name)}" placeholder="Pebble Creek">
    <div class="eyebrow" style="margin-top:12px">Tees</div>
    ${d.tees.map((t, i) => `<div class="row" style="margin-bottom:8px;gap:6px">
      <input class="field" data-tee-field="${i}:name" value="${esc(t.name)}" placeholder="Blue" style="flex:1.2">
      <input class="field mono" data-tee-field="${i}:rating" value="${esc(t.rating)}" placeholder="Rating" inputmode="decimal">
      <input class="field mono" data-tee-field="${i}:slope" value="${esc(t.slope)}" placeholder="Slope" inputmode="numeric">
      <input class="field mono" data-tee-field="${i}:par" value="${esc(t.par)}" placeholder="Par" inputmode="numeric" style="flex:.7">
      ${d.tees.length > 1 ? `<button class="iconbtn warn" data-rm-tee="${i}" style="flex:0">✕</button>` : ""}
    </div>`).join("")}
    <button class="linkbtn" data-act="add-tee">＋ Add a tee</button>
    <div class="row" style="margin-top:14px">
      <button class="btn" data-act="save-course">Save course</button>
      <button class="btn ghost" data-act="cancel-course">Cancel</button>
    </div>
  </div>`;
}

/* ================= render ================= */
function render() {
  const screens = { enter: screenEnter, history: screenHistory, summary: screenSummary, share: screenShare, manage: screenManage };
  try {
    view.innerHTML = screens[tab]();
  } catch (e) {
    // A screen failed to draw. Say so and offer a way back instead of showing nothing.
    view.innerHTML = `<div class="fatal"><div class="fatal-mark">!</div>
      <h2>This screen couldn't be drawn</h2>
      <p>Your rounds are safe. Try another tab, or reload.</p>
      <button class="btn" data-act="recover">Back to Enter</button>
      <details><summary>Technical detail</summary><pre>${esc(e && e.message)}</pre></details></div>`;
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const btn = document.getElementById("statusBtn");
  btn.textContent = sync.text;
  btn.classList.toggle("alert", !!sync.alert);
  paintAlert();
  if (window.__scorecardBooted) window.__scorecardBooted();
}

/* One banner, above the screen. Never blocks what you were doing. */
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

function flashMsg(msg) { flash = msg; render(); setTimeout(() => { flash = null; render(); }, 2600); }

/* ================= events ================= */
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  tab = b.dataset.tab; if (tab === "enter") editingId = null; render();
});
document.getElementById("statusBtn").onclick = () => openBackup();

// Text fields update state without a re-render, so the keyboard and caret stay put.
view.addEventListener("input", (e) => {
  const n = e.target.name;
  if (n === "gross" || n === "adjusted") {
    form[n] = e.target.value.replace(/\D/g, "");
    e.target.value = form[n];
    return updatePreview();
  }
  if (n === "notes") { form.notes = e.target.value; return; }
  if (n === "finder-q") { finder.q = e.target.value; return; }
  if (e.target.dataset.teeField) {
    const [i, key] = e.target.dataset.teeField.split(":");
    courseDraft.tees[+i][key] = e.target.value;
    return;
  }
  if (n === "c-name") courseDraft.name = e.target.value;
});

// Redraw only the differential panel and the post button while typing a score.
function updatePreview() {
  const course = state.courses.find((c) => c.id === form.courseId);
  const tee = course && course.tees.find((t) => t.id === form.teeId);
  const box = view.querySelector(".preview");
  const btn = view.querySelector('[data-act="post"]');
  if (btn) btn.disabled = !(form.golfer && tee && +form.gross > 0);
  if (!box || !tee) return;
  const stamp = box.querySelector(".stamp");
  if (!form.gross) { if (stamp) stamp.remove(); return; }
  const d = differential(+(form.adjusted || form.gross), tee.rating, tee.slope).toFixed(1);
  if (stamp) stamp.textContent = d;
  else box.insertAdjacentHTML("beforeend", `<span class="stamp">${d}</span>`);
  const adj = view.querySelector('[name="adjusted"]');
  if (adj) adj.placeholder = form.gross || "same";
}

view.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.name === "new-golfer") { e.preventDefault(); addGolfer(); }
  if (e.target.name === "rename-golfer") { e.preventDefault(); saveRename(); }
  if (e.target.name === "finder-q") { e.preventDefault(); runFinder(); }
});

view.addEventListener("change", (e) => {
  const n = e.target.name, v = e.target.value;
  if (n === "date") { form.date = v; render(); }
  if (n === "golfer") { form.golfer = v; render(); }
  if (n === "courseId") {
    const c = state.courses.find((x) => x.id === v);
    form.courseId = v; form.teeId = c && c.tees.length === 1 ? c.tees[0].id : "";
    render();
  }
  if (n === "f-golfer") { filter.golfer = v; render(); }
  if (n === "f-year") { filter.year = v; filter.month = ""; render(); }
  if (n === "f-course") { filter.courseId = v; render(); }
  if (n === "share-golfer") { shareGolfer = v; render(); }
});

view.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act],[data-tee],[data-go],[data-edit],[data-del],[data-confirm-del],[data-unfilter],[data-drill],[data-golfer-index],[data-send],[data-del-golfer],[data-edit-course],[data-del-course],[data-rm-tee],[data-pick],[data-rename],[data-course]");
  if (!t) return;
  const d = t.dataset;

  if (d.go) { tab = d.go; return render(); }
  if (d.tee) { form.teeId = d.tee; return render(); }
  if (d.send) return send(d.send);

  if (d.unfilter) { filter[d.unfilter] = ""; return render(); }
  if (d.edit) {
    const r = state.rounds.find((x) => x.id === d.edit);
    editingId = r.id;
    form = { date: r.date, golfer: r.golfer, courseId: r.courseId, teeId: r.teeId,
      gross: String(r.gross), adjusted: r.adjusted === r.gross ? "" : String(r.adjusted), notes: r.notes || "" };
    tab = "enter"; return render();
  }
  if (d.del) { confirmId = d.del; return render(); }
  if (d.confirmDel) { confirmId = null; return save({ ...state, rounds: state.rounds.filter((r) => r.id !== d.confirmDel) }); }
  if (d.drill) {
    if (!drill.year) drill.year = d.drill;
    else if (!drill.month) drill.month = d.drill;
    else { filter = { golfer: d.drill, year: drill.year, month: drill.month, courseId: "" }; tab = "history"; }
    return render();
  }
  if (d.golferIndex) { filter = { golfer: d.golferIndex, year: "", month: "", courseId: "" }; tab = "history"; return render(); }
  if (d.rename) { editingGolfer = d.rename; return render(); }
  if (d.course) { openCourse = openCourse === d.course ? null : d.course; return render(); }
  if (d.delGolfer) return save({ ...state, golfers: state.golfers.filter((g) => g !== d.delGolfer) });
  if (d.editCourse) { courseDraft = JSON.parse(JSON.stringify(state.courses.find((c) => c.id === d.editCourse))); return render(); }
  if (d.delCourse) return save({ ...state, courses: state.courses.filter((c) => c.id !== d.delCourse) });
  if (d.rmTee) { courseDraft.tees.splice(+d.rmTee, 1); return render(); }
  if (d.pick) {
    const c = finder.results[+d.pick];
    courseDraft.name = c.name;
    courseDraft.tees = c.tees.map((t) => ({ id: uid(), name: t.name, rating: String(t.rating), slope: String(t.slope), par: String(t.par) }));
    finder = { q: "", results: [], busy: false, msg: `Filled in ${c.tees.length} tee${c.tees.length === 1 ? "" : "s"} — check them against the scorecard.` };
    return render();
  }

  switch (d.act) {
    case "recover": tab = "enter"; return render();
    case "cancel-edit": editingId = null; form = { ...form, gross: "", adjusted: "", notes: "" }; return render();
    case "cancel-del": confirmId = null; return render();
    case "clear-filters": filter = { golfer: "", year: "", month: "", courseId: "" }; return render();
    case "drill-back": drill.month ? (drill.month = null) : (drill.year = null); return render();
    case "view-scope": filter = { golfer: "", year: drill.year || "", month: drill.month || "", courseId: "" }; tab = "history"; return render();
    case "post": return post();
    case "add-golfer": return addGolfer();
    case "save-rename": return saveRename();
    case "cancel-rename": editingGolfer = null; return render();
    case "find": return runFinder();
    case "save-key": {
      const el = view.querySelector('[name="apikey"]');
      lookup.setKey(el ? el.value : "");
      flashMsg(lookup.hasKey() ? "Lookup key saved on this device" : "Lookup key removed");
      return;
    }
    case "clear-key": lookup.setKey(""); flashMsg("Lookup key removed"); return render();
    case "new-course":
      finder = { q: "", results: [], busy: false, msg: lookup.hasKey() ? "" : lookup.explain("NO_KEY") };
      courseDraft = { id: uid(), name: "", tees: [{ id: uid(), name: "", rating: "", slope: "", par: "72" }] };
      return render();
    case "add-tee": courseDraft.tees.push({ id: uid(), name: "", rating: "", slope: "", par: "72" }); return render();
    case "cancel-course": courseDraft = null; finder = { q: "", results: [], busy: false, msg: "" }; return render();
    case "save-course": {
      const c = { ...courseDraft, name: courseDraft.name.trim(), tees: courseDraft.tees.filter((t) => t.name.trim() && t.rating && t.slope && t.par) };
      if (!c.name || !c.tees.length) return;
      const exists = state.courses.some((x) => x.id === c.id);
      courseDraft = null;
      openCourse = null;
      finder = { q: "", results: [], busy: false, msg: "" };
      return save({ ...state, courses: exists ? state.courses.map((x) => (x.id === c.id ? c : x)) : [...state.courses, c] });
    }
    case "google":
      try { await db.signInWithGoogle(); flashMsg("Signed in — this scorecard now follows your Google account"); }
      catch (err) { flashMsg("Sign-in didn't complete. See the message at the top of the screen."); }
      return;
    case "backup": return openBackup();
  }
});

// Search is fussy about wording, so try the query as typed and again with the
// filler words stripped, then merge whatever comes back.
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

function saveRename() {
  const input = view.querySelector('[name="rename-golfer"]');
  const next = (input ? input.value : "").trim();
  const previous = editingGolfer;
  if (!next) { flashMsg("Type a name first"); return; }
  if (next === previous) { editingGolfer = null; return render(); }
  if (state.golfers.includes(next)) { flashMsg(`${next} is already on the list`); return; }

  // Rounds store the golfer by name, so every one of theirs moves with them.
  const golfers = state.golfers.map((g) => (g === previous ? next : g)).sort();
  const rounds = state.rounds.map((r) => (r.golfer === previous ? { ...r, golfer: next } : r));

  // Anything currently pointing at the old name follows too.
  if (form.golfer === previous) form.golfer = next;
  if (filter.golfer === previous) filter.golfer = next;
  if (shareGolfer === previous) shareGolfer = next;

  const moved = state.rounds.filter((r) => r.golfer === previous).length;
  editingGolfer = null;
  save({ ...state, golfers, rounds });
  flashMsg(moved ? `Renamed to ${next} — ${moved} round${moved === 1 ? "" : "s"} moved with them` : `Renamed to ${next}`);
}

function addGolfer() {
  const input = view.querySelector('[name="new-golfer"]');
  const name = (input ? input.value : "").trim();
  if (!name) { flashMsg("Type a name first"); return; }
  if (state.golfers.includes(name)) { flashMsg(`${name} is already on the list`); return; }
  save({ ...state, golfers: [...state.golfers, name].sort() });
  flashMsg(`${name} added`);
}

function post() {
  const course = state.courses.find((c) => c.id === form.courseId);
  const tee = course.tees.find((t) => t.id === form.teeId);
  const ags = +(form.adjusted || form.gross);
  const rec = {
    id: editingId || uid(), date: form.date, golfer: form.golfer,
    courseId: course.id, courseName: course.name, teeId: tee.id, teeName: tee.name,
    rating: +tee.rating, slope: +tee.slope, par: +tee.par,
    gross: +form.gross, adjusted: ags, differential: differential(ags, tee.rating, tee.slope),
    notes: form.notes.trim(),
  };
  const rounds = editingId ? state.rounds.map((r) => (r.id === editingId ? rec : r)) : [...state.rounds, rec];
  const msg = editingId ? "Round updated" : `Round posted — differential ${rec.differential.toFixed(1)}`;
  editingId = null;
  form = { ...form, gross: "", adjusted: "", notes: "", date: today() };
  save({ ...state, rounds });
  flashMsg(msg);
}

/* ---------- backup sheet ---------- */
function openBackup() {
  const pending = db.hasPending();
  sheetEl.hidden = false;
  sheetEl.innerHTML = `<div class="sheet-body">
    <div style="display:flex;justify-content:space-between;align-items:center"><h2>Storage</h2><button class="iconbtn" data-close="1">✕</button></div>
    ${sync.error ? `<div class="note warn"><b>${esc(sync.error.short)}</b><br>${esc(sync.error.full)}</div>` : ""}
    <p class="small muted">${pending
      ? "Rounds are held on this device and upload to Firebase the moment you're back online. The local copy is deleted as soon as it lands."
      : sync.text === "On this device"
        ? "Sync isn't configured, so everything stays in this browser. Add your Firebase config to turn it on."
        : "Everything is in Firebase. Paste a backup below to restore a scorecard."}</p>
    <textarea class="field" name="backup">${esc(JSON.stringify(state))}</textarea>
    <div class="row" style="margin-top:12px">
      <button class="btn ghost" data-copy="1">Copy backup</button>
      <button class="btn" data-restore="1">Restore</button>
    </div>
  </div>`;
}
sheetEl.addEventListener("click", (e) => {
  if (e.target === sheetEl || e.target.closest("[data-close]")) { sheetEl.hidden = true; return; }
  if (e.target.closest("[data-copy]")) { navigator.clipboard?.writeText(JSON.stringify(state)); return; }
  if (e.target.closest("[data-restore]")) {
    try {
      const p = JSON.parse(sheetEl.querySelector('[name="backup"]').value);
      if (!Array.isArray(p.rounds)) throw new Error();
      sheetEl.hidden = true;
      save({ golfers: p.golfers || [], courses: p.courses || [], rounds: p.rounds });
    } catch { alert("That text isn't a valid backup."); }
  }
});

/* ================= start ================= */
db.onChange((next, s) => {
  state = { golfers: next.golfers || [], courses: next.courses || [], rounds: next.rounds || [] };
  sync = s;
  render();
});
try {
  const c = db.readCache();
  state = { golfers: c.golfers || [], courses: c.courses || [], rounds: c.rounds || [] };
} catch {
  state = { golfers: [], courses: [], rounds: [] };
}
render();                       // first paint — clears the "Opening your scorecard…" placeholder
db.init().catch((e) => {        // sync problems must never take the app down
  sync = { text: "On this device", alert: true,
    error: { short: "Sync couldn't start", full: (e && e.message) || "Rounds are being saved on this device." } };
  render();
});
