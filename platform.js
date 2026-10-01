/* The one place the web app and the iPhone app differ.
 *
 * In a browser every function here does exactly what the web app has always
 * done. Inside the iPhone app (Capacitor) it uses the native plugins instead,
 * reached through window.Capacitor.Plugins — the same way Fairpot does, so no
 * extra code is downloaded or bundled for this.
 *
 * Nothing here is ever needed by the web app to work: if Capacitor is absent,
 * isApp() is false and every branch below is the browser branch. */

const Cap = (typeof window !== "undefined" && window.Capacitor) || null;

export const isApp = () => !!(Cap && typeof Cap.isNativePlatform === "function" && Cap.isNativePlatform());
const plugin = (name) => (isApp() && Cap.Plugins && Cap.Plugins[name]) || null;

/* ---------------- addresses (Change 1) ---------------- */

const WEB_BASE = "https://willyros01.github.io/scorecard/";
const GUIDE_URL = "https://www.cuberoot-systems.com/scorecard/guide/";
const JOIN_BASE = "https://www.cuberoot-systems.com/scorecard/join/";

/* The published web app. Used only for the web-only data tools (Change 6). */
export const webBase = () => WEB_BASE;
/* One guide for both the iPhone app and the web app (Phase 1). */
export const guideUrl = () => GUIDE_URL;
/* The privacy policy and support pages, also on the Cuberoot site. */
export const privacyUrl = () => "https://www.cuberoot-systems.com/scorecard/privacy/";
export const conductUrl = () => "https://www.cuberoot-systems.com/scorecard/conduct/";
export const supportUrl = () => "https://www.cuberoot-systems.com/scorecard/support/";
/* Invitation links. On an iPhone with the app installed this address opens
   the app; anywhere else the Cuberoot page forwards to the web app with the
   same ?join=… query, which the web app reads exactly as before. */
export const joinBase = () => JOIN_BASE;

/* ---------------- invitation links (Change 2) ---------------- */

/* In a browser the invitation is in the address bar. Inside the app it arrives
   separately: App.getLaunchUrl() on a cold start, and an appUrlOpen event
   while running. iOS can deliver the same link through both, or again when the
   app comes back from the background — so every delivery goes through
   takeLink(), which keeps exactly one waiting link and ignores repeats. */

const LAST_LINK_KEY = "golf:v2:lastLink";
const REPEAT_WINDOW_MS = 10 * 60 * 1000;   // a repeat within 10 minutes is a duplicate delivery
let pendingQuery = "";

function keyOf(query) {
  try {
    const params = new URLSearchParams(query);
    const join = params.get("join");
    if (!join) return "";
    return join + (params.get("as") === "admin" ? "&as=admin" : "");
  } catch { return ""; }
}

function lastUsedKey() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_LINK_KEY) || "null");
    if (saved && saved.key && Date.now() - saved.at < REPEAT_WINDOW_MS) return saved.key;
  } catch { /* unreadable: treat as none */ }
  return "";
}

/* Returns true only when the link is new and has become the waiting link. */
export function takeLink(url) {
  let query = "";
  try { query = new URL(url).search; } catch { return false; }
  const key = keyOf(query);
  if (!key) return false;
  if (key === keyOf(pendingQuery)) return false;   // already waiting on screen
  if (key === lastUsedKey()) return false;          // just used successfully here
  pendingQuery = query;
  return true;
}

/* What store.js readJoinLink() reads. Browser: the address bar, as always. */
export const linkQuery = () => (isApp() ? pendingQuery : location.search);

/* Called once a join has succeeded. */
export function clearLinkQuery() {
  if (!isApp()) return;   // the browser path is history.replaceState in store.js, unchanged
  const key = keyOf(pendingQuery);
  if (key) {
    try { localStorage.setItem(LAST_LINK_KEY, JSON.stringify({ key, at: Date.now() })); } catch { /* best effort */ }
  }
  pendingQuery = "";
}

/* Cold start: read the link that opened the app, before boot() looks for it. */
export async function initLinks() {
  const App = plugin("App");
  if (!App || typeof App.getLaunchUrl !== "function") return;
  try {
    const launched = await App.getLaunchUrl();
    if (launched && launched.url) takeLink(launched.url);
  } catch { /* no launch link */ }
}

/* Warm start: a link tapped while the app is already open. */
export function onLink(handler) {
  const App = plugin("App");
  if (!App || typeof App.addListener !== "function") return;
  App.addListener("appUrlOpen", (event) => {
    if (event && event.url && takeLink(event.url)) handler();
  });
}

/* ---------------- sharing, copying, files, other apps (Change 5) ---------------- */

/* Whether "More apps…" can be offered. */
export const canShare = () => (isApp() ? true : !!(typeof navigator !== "undefined" && navigator.share));

/* The system share sheet with text. */
export async function share({ text, title }) {
  const Share = plugin("Share");
  if (Share) return Share.share({ text, title });
  return navigator.share({ text });
}

/* Copy text. Throws if refused, so the caller can fall back to selecting it. */
export async function copy(text) {
  const Clipboard = plugin("Clipboard");
  if (Clipboard) return Clipboard.write({ string: text });
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  throw new Error("no clipboard");
}

/* App only: write a text file, confirm it is really on the device, then open
   the share sheet with it, where Save to Files offers iCloud Drive or any
   folder. Resolves only once the file has been written and read back — a save
   is never reported before it has happened. */
export async function saveFile(name, text, title) {
  const Filesystem = plugin("Filesystem");
  const Share = plugin("Share");
  if (!Filesystem || !Share) throw new Error("File saving is not available here.");
  const safe = String(name || "scorecard-backup.txt").replace(/[^A-Za-z0-9._-]/g, "-");
  const written = await Filesystem.writeFile({ path: safe, data: text, directory: "CACHE", encoding: "utf8" });
  const check = await Filesystem.readFile({ path: safe, directory: "CACHE", encoding: "utf8" });
  if (!check || check.data !== text) throw new Error("The file could not be written completely.");
  const uri = (written && written.uri) || (await Filesystem.getUri({ path: safe, directory: "CACHE" })).uri;
  await Share.share({ title: title || "Scorecard backup", files: [uri] });
}

/* Open WhatsApp, Mail, Messages or Safari.
   how: "tab" opens a new window in a browser (WhatsApp), "self" changes the
   page address (mailto:, sms:) — exactly what the web app did before. */
export async function openExternal(url, how = "self") {
  const Launcher = plugin("AppLauncher");
  if (Launcher) return Launcher.openUrl({ url });
  if (how === "tab") { window.open(url, "_blank"); return; }
  location.href = url;
}
