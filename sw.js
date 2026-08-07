/* Offline shell. The cache name follows version.js — bump that one line to ship a change. */
importScripts("./version.js");
const CACHE = "scorecard-" + (self.APP_VERSION || "dev");
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./db.js", "./courses-api.js",
  "./version.js", "./firebase-config.js", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Never cache Firebase traffic — it has its own transport.
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("firebaseio.com")) return;

  // The Firebase SDK modules: serve from cache, refresh in the background.
  if (url.hostname === "www.gstatic.com") {
    e.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request);
      const net = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // App files: cache first, so a round can be posted with no signal at all.
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("./index.html"))));
  }
});
