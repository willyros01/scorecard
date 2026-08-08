/* Look up a course by keyword instead of copying numbers off a scorecard.
 *
 * Provider: GolfCourseAPI (api.golfcourseapi.com) — free key, sign up at
 * https://www.golfcourseapi.com/sign-in. Nothing is sent anywhere until you
 * paste a key in and press Search, and the app is fully usable without one.
 *
 * To swap providers, change ENDPOINT, AUTH and normalize() — nothing else
 * in the app knows where this data came from.
 */

const KEY_STORE = "golf:courselookup";

/* The embedded key ships with the app and needs no setup. A key saved on the
   device is only a fallback, kept so the feature still works if the embedded
   one is ever empty. */
const embeddedKey = () => {
  try { return (self.COURSE_LOOKUP_KEY || "").trim(); } catch { return ""; }
};
export const usingEmbeddedKey = () => !!embeddedKey();
const ENDPOINT = "https://api.golfcourseapi.com/v1/search?search_query=";
const AUTH = (key) => ({ Authorization: "Key " + key });

const savedKey = () => { try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; } };
export const getKey = () => embeddedKey() || savedKey();
export const hasKey = () => !!getKey();
export function setKey(k) {
  try { k && k.trim() ? localStorage.setItem(KEY_STORE, k.trim()) : localStorage.removeItem(KEY_STORE); } catch {}
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/* Providers rename fields over time, so accept any plausible spelling and
   drop anything without both a rating and a slope — those two are the only
   values the handicap math cannot work without. */
function teesFrom(raw) {
  const out = [];
  const add = (list, tag) => (list || []).forEach((t) => {
    const rating = num(t.course_rating ?? t.rating ?? t.courseRating);
    const slope = num(t.slope_rating ?? t.slope ?? t.slopeRating);
    if (!rating || !slope) return;
    const par = num(t.par_total ?? t.par ?? t.total_par) || 72;
    const name = String(t.tee_name ?? t.name ?? t.tee ?? "Tee") + (tag ? ` (${tag})` : "");
    out.push({ name, rating, slope, par });
  });
  if (Array.isArray(raw)) add(raw);
  else if (raw && typeof raw === "object") { add(raw.male, "M"); add(raw.female, "W"); }
  return out;
}

function normalize(c) {
  const club = (c.club_name || "").trim();
  const course = (c.course_name || "").trim();
  const name = !course || course === club ? club || course : `${club} — ${course}`;
  const loc = c.location || {};
  const where = loc.address || [loc.city, loc.state, loc.country].filter(Boolean).join(", ");
  return { name: name || "Unnamed course", where, tees: teesFrom(c.tees) };
}

/* Throws a short code the UI turns into a sentence. */
export async function search(query) {
  const key = getKey();
  if (!key) throw new Error("NO_KEY");
  if (!query || query.trim().length < 3) throw new Error("TOO_SHORT");
  if (!navigator.onLine) throw new Error("OFFLINE");

  let res;
  try {
    res = await fetch(ENDPOINT + encodeURIComponent(query.trim()), { headers: AUTH(key) });
  } catch {
    throw new Error("UNREACHABLE");   // no network, or the service refuses browser requests
  }
  if (res.status === 401 || res.status === 403) throw new Error("BAD_KEY");
  if (res.status === 429) throw new Error("RATE");
  if (!res.ok) throw new Error("HTTP_" + res.status);

  let data;
  try { data = await res.json(); } catch { throw new Error("BAD_RESPONSE"); }

  const list = Array.isArray(data) ? data : data.courses || data.results || [];
  const usable = list.map(normalize).filter((c) => c.tees.length);
  if (!list.length) throw new Error("NO_MATCH");
  if (!usable.length) throw new Error("NO_RATINGS");   // found it, but no rating/slope published
  return usable.slice(0, 8);
}

/* Providers match on exact-ish names, so a query that reads naturally to a person
   ("royal ontario golf club") can miss. Try it as typed, then again with the
   filler words removed, and merge — de-duplicated, best matches first. */
export async function searchWide(query) {
  const raw = String(query || "").trim();
  const trimmed = raw.replace(/\b(golf|club|course|country|links|and|the|&|cc|gc|g&cc)\b/gi, " ")
                     .replace(/\s+/g, " ").trim();

  const attempts = [raw];
  if (trimmed && trimmed.toLowerCase() !== raw.toLowerCase() && trimmed.length >= 3) attempts.push(trimmed);

  const seen = new Set();
  const merged = [];
  let lastError = null;

  for (const attempt of attempts) {
    try {
      for (const course of await search(attempt)) {
        const fingerprint = course.name.toLowerCase();
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        merged.push(course);
      }
    } catch (e) {
      lastError = e;
    }
  }
  if (!merged.length) throw lastError || new Error("NO_MATCH");
  return merged.slice(0, 10);
}

export function explain(code) {
  switch (String(code)) {
    case "NO_KEY": return "Course search is not set up yet. Type the rating and slope off the scorecard for now — it takes about twenty seconds.";
    case "TOO_SHORT": return "Type at least three letters of the course or club name.";
    case "OFFLINE": return "You're offline, so lookup isn't available. Enter the tees by hand — everything else works.";
    case "UNREACHABLE": return "The lookup service couldn't be reached from this browser. Enter the tees by hand.";
    case "BAD_KEY": return "That lookup key was rejected. Check it, or paste a fresh one.";
    case "RATE": return "Lookup limit reached for now. Try later, or enter the tees by hand.";
    case "NO_MATCH": return "No course matched. Try the club name instead, or just the town.";
    case "NO_RATINGS": return "Found the course, but no rating and slope are published for it. You'll need the scorecard.";
    case "BAD_RESPONSE": return "The lookup service sent something unreadable. Enter the tees by hand.";
    default: return "Lookup didn't work. Enter the tees by hand — nothing else is affected.";
  }
}
