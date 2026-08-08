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

/* Courses are listed alphabetically everywhere. localeCompare rather than a
   plain sort, so accented and non-English names land where a person expects. */
const sortedCourses = () =>
  [...state.courses].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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
      ${sortedCourses().map((c) => `<option value="${c.id}" ${c.id === form.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
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
      ${sortedCourses().map((c) => `<option value="${c.id}" ${c.id === filter.courseId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
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
  const golfers = state.golfers;
  const courses = sortedCourses();

  return `
  <section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">Golfers</h2>
      <span class="panel-count">${golfers.length || ""}</span>
    </div>
    <div class="card">
      ${golfers.length ? `<div class="list">
        ${golfers.map((g) => {
          const used = state.rounds.some((r) => r.golfer === g);
          if (editingGolfer === g) {
            return `<div class="inline-form">
              <input name="rename-golfer" class="inline-input" value="${esc(g)}" autocomplete="off">
              <div class="inline-actions">
                <button class="btn compact" data-act="save-rename">Save</button>
                <button class="btn ghost compact" data-act="cancel-rename">Cancel</button>
              </div>
            </div>`;
          }
          return `<div class="list-row">
            <span class="grow name">${esc(g)}</span>
            <button class="rowbtn" data-rename="${esc(g)}">Edit</button>
            <button class="rowbtn warn" data-del-golfer="${esc(g)}" ${used ? "disabled title='Has posted rounds — delete those first'" : ""}>Delete</button>
          </div>`;
        }).join("")}
      </div>` : `<p class="blank">Nobody on the roster yet.</p>`}
      <div class="inline-form bordered">
        <input name="new-golfer" class="inline-input" placeholder="Type a name" autocomplete="off">
        <div class="inline-actions">
          <button class="btn compact" data-act="add-golfer">Add golfer</button>
        </div>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">Courses</h2>
      ${courseDraft ? "" : `<button class="linkbtn" data-act="new-course">Add a course</button>`}
    </div>
    ${courses.length ? `<div class="card list">
      ${courses.map((c) => {
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
            <div class="inline-actions spread">
              <button class="rowbtn" data-edit-course="${c.id}">Edit</button>
              <button class="rowbtn warn" data-del-course="${c.id}" ${used ? "disabled title='Rounds use this course'" : ""}>Delete</button>
            </div>
          </div>` : ""}
        </div>`;
      }).join("")}
    </div>` : (courseDraft ? "" : `<div class="card"><p class="blank">No courses yet. Add one with its rating and slope — both are printed on the scorecard.</p></div>`)}
    ${courseDraft ? courseEditor() : ""}
  </section>

  <section class="panel">
    <div class="panel-head"><h2 class="panel-title">Sync</h2></div>
    <div class="card padded">
      <div class="name">${esc(db.accountLabel())}</div>
      <div class="sub">${esc(sync.text)}${db.hasPending() ? " · changes waiting to upload" : ""}</div>
      <div class="inline-actions stacked">
        <button class="btn ghost" data-act="google">Use a Google account</button>
        <button class="btn ghost" data-act="backup">Backup text</button>
      </div>
      <p class="hint">Signing in with Google carries this scorecard to your other devices.</p>
    </div>
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
  const existing = state.courses.some((c) => c.id === d.id);

  return `<div class="card editor">
    <div class="editor-title">${existing ? "Edit course" : "New course"}</div>

    ${existing ? "" : `
    <label class="lbl">Find it by name</label>
    <div class="inline-form">
      <input name="finder-q" class="inline-input" value="${esc(finder.q)}" placeholder="Course or club name" autocomplete="off">
      <div class="inline-actions">
        <button class="btn compact" data-act="find" ${finder.busy ? "disabled" : ""}>${finder.busy ? "Searching…" : "Search"}</button>
      </div>
    </div>
    ${finder.msg ? `<p class="hint">${esc(finder.msg)}</p>` : ""}
    ${finder.results.length ? `<div class="results list">
      ${finder.results.map((c, i) => `<button class="list-row" data-pick="${i}">
        <span class="grow">
          <span class="name">${esc(c.name)}</span><br>
          <span class="sub">${esc(c.where || "")}${c.where ? " · " : ""}${c.tees.length} rated tee${c.tees.length === 1 ? "" : "s"}</span>
        </span>
        <span class="chev">›</span>
      </button>`).join("")}
    </div>` : ""}`}

    <label class="lbl">Course name</label>
    <input class="field" name="c-name" value="${esc(d.name)}" placeholder="Royal Ontario" autocomplete="off">

    <label class="lbl">Tees</label>
    ${d.tees.map((t, i) => `<div class="tee-row">
      <div class="tee-head">
        <input class="field" data-tee-field="${i}:name" value="${esc(t.name)}" placeholder="Tee name, e.g. Blue" autocomplete="off">
        ${d.tees.length > 1 ? `<button class="rowbtn warn" data-rm-tee="${i}">Remove</button>` : ""}
      </div>
      <div class="tee-nums">
        <label>Rating<input class="field mono" data-tee-field="${i}:rating" value="${esc(t.rating)}" placeholder="71.2" inputmode="decimal"></label>
        <label>Slope<input class="field mono" data-tee-field="${i}:slope" value="${esc(t.slope)}" placeholder="131" inputmode="numeric"></label>
        <label>Par<input class="field mono" data-tee-field="${i}:par" value="${esc(t.par)}" placeholder="72" inputmode="numeric"></label>
      </div>
    </div>`).join("")}
    <button class="linkbtn" data-act="add-tee">Add another tee</button>

    <div class="inline-actions stacked editor-actions">
      <button class="btn" data-act="save-course">Save course</button>
      <button class="btn ghost" data-act="cancel-course">Cancel</button>
    </div>
  </div>`;
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
