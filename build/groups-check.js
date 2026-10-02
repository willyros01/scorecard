/* groups-check.html: shows the one-time group clean-up plan from a backup
   file chosen on this device. Reads only; no network, no database. */
import { makePlan } from "./cl5-plan.mjs";

const out = document.getElementById("out");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const card = (html, cls = "") => `<div class="card ${cls}">${html}</div>`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function show(plan, fileName, savedAt) {
  const h = [];
  h.push(card(`<b>${esc(fileName)}</b><br><span class="small">Backup taken ${esc(savedAt || "")}</span>`));
  if (plan.stops.length) {
    h.push("<h2>The clean-up would stop here</h2>");
    for (const s of plan.stops) h.push(card(esc(s), "stop"));
    h.push(card("Nothing would be changed. Send a screenshot of this to Claude.", "stop"));
  } else {
    h.push(card(`<b>The clean-up can go ahead.</b><br>No golfer and no account will be left without a group.`, "good"));
  }

  h.push("<h2>Your groups: kept, not touched</h2>");
  for (const g of plan.protected) h.push(card(`<b>${esc(g.name)}</b><br>${plural(g.roster, "golfer", "golfers")}, ${plural(g.members, "member", "members")}, ${plural(g.rounds, "round", "rounds")}`));
  if (plan.philippine) h.push(card(`${esc(plan.philippine.name)} only receives the golfers and rounds below. Nothing in it is removed.`));

  h.push(`<h2>Orphan groups to remove: <span class="num">${plan.orphans.length}</span></h2>`);
  for (const g of plan.orphans) {
    const parts = Object.entries(g.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing inside";
    h.push(card(`<b>${esc(g.name)}</b><br>${esc(parts)}<br><span class="small">id ${esc(g.id)}${g.created ? `, created ${esc(g.created.slice(0, 10))}` : ""}${g.owner ? `, owner ${esc(g.owner)}` : ""}${g.youAreMember ? ", you are a member" : ""}</span>`));
  }

  h.push(`<h2>Golfers moving to Philippine Golfers: <span class="num">${plan.movedGolfers.length}</span></h2>`);
  if (!plan.movedGolfers.length) h.push(card("None."));
  for (const g of plan.movedGolfers) h.push(card(`<b>${esc(g.name)}</b><br>found only in ${esc(g.from.join(", "))}<br>${plural(g.rounds, "round moves", "rounds move")} with them${g.email ? `<br><span class="small">account ${esc(g.email)}</span>` : ""}`));

  h.push(`<h2>Accounts joining Philippine Golfers: <span class="num">${plan.newMembers.length}</span></h2>`);
  if (!plan.newMembers.length) h.push(card("None."));
  for (const m of plan.newMembers) h.push(card(`<b>${esc(m.displayName || m.email || m.uid)}</b><br>${esc(m.email)}<br><span class="small">${esc(m.why)}</span>`));

  h.push(`<h2>Left as they are: <span class="num">${(plan.copies || []).length + (plan.skippedAccounts || []).length}</span></h2>`);
  for (const g of plan.copies || []) h.push(card(`<b>${esc(g.name)}</b><br>a leftover copy with no rounds, found in ${esc(g.from.join(", "))}<br><span class="small">your real ${esc(g.name)} is in your groups; this copy is kept as it is and goes into no group</span>`));
  for (const a of plan.skippedAccounts || []) h.push(card(`<b>${esc(a.displayName || a.uid)}</b><br><span class="small">an old sign-in with no email; not added to Philippine Golfers</span>`));
  if (!(plan.copies || []).length && !(plan.skippedAccounts || []).length) h.push(card("None."));

  const r = plan.rounds;
  h.push("<h2>Rounds in the orphan groups</h2>");
  h.push(card(`<b>${r.move}</b> move to Philippine Golfers with their golfer`));
  h.push(card(`<b>${r.copy}</b> removed: copies of rounds already in your groups (the handicap is pointed at the real copy)`));
  h.push(card(`<b>${r.staying}</b> removed: rounds of golfers who stay in your groups${r.staying ? `, ${r.stayingInHandicap} of them count in a handicap now` : ""}`, r.stayingInHandicap ? "stop" : ""));
  for (const g of r.stayingGolfers) h.push(card(`${esc(g.name)}: ${plural(g.rounds, "round", "rounds")}, ${g.inHandicap} in the handicap now`));
  h.push(card(`<b>${r.noGolfer}</b> removed: rounds with no golfer, or of a golfer already merged away`));

  h.push(`<h2>Handicaps that change: <span class="num">${plan.handicapChanges.length}</span></h2>`);
  if (!plan.handicapChanges.length) h.push(card("None."));
  for (const g of plan.handicapChanges) h.push(card(`<b>${esc(g.name)}</b>: ${esc(g.before ?? "none")} becomes ${esc(g.after ?? "none")} (a round counted twice is counted once)`));

  h.push("<h2>In all</h2>");
  h.push(card(`${plural(plan.golferRecords, "golfer record is", "golfer records are")} updated.<br>${plural(plan.removals, "document is", "documents are")} removed, including ${plural(plan.pointers, "group link", "group links")} and ${plural(plan.joinCodes, "join code", "join codes")} of orphan groups.`));
  if (plan.noGroupBefore) h.push(card(`${plural(plan.noGroupBefore, "golfer was", "golfers were")} already in no group before the clean-up. They are not touched.`));
  out.innerHTML = h.join("");
}

document.getElementById("file").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  out.innerHTML = card("Reading ...");
  try {
    const backup = JSON.parse(await f.text());
    show(makePlan(backup), f.name, backup.savedAt);
  } catch (err) {
    out.innerHTML = card(`This file could not be read: ${esc(err && err.message)}`, "stop");
  }
});
