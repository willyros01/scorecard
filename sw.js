/* Offline shell.
 *
 * Deliberately network-first for the app's own files.
 *
 * The earlier version was cache-first and named its cache after APP_VERSION.
 * That has a trap in it: the browser can serve version.js itself from cache
 * when this worker asks for it, so the worker reads the OLD version, keeps the
 * OLD cache name, and concludes nothing has changed. Bumping the version can
 * never fix a problem where the version number is the stale thing. Deployed
 * changes then never reach an installed app, no matter how many times it is
 * reopened.
 *
 * Now: when online, the network always wins and the cache is refreshed behind
 * it. When offline, the cache answers. Updates land on the next reload without
 * anyone clearing anything.
 */

const CACHE = "scorecard-shell";
const SHELL = ["./", "./index.html", "./cleanup.html", "./repair.html", "./tidy.html", "./rebuild.html", "./quick-start.html", "./styles.css", "./app.js", "./db.js",
  "./courses-api.js", "./version.js", "./firebase-config.js",
  "./model.js", "./store.js", "./outbox.js", "./migrate.js",
  "./manifest.webmanifest", "./icon.svg"];

/* A slow connection must not leave someone staring at a blank screen, so the
   network gets a few seconds and then the cache takes over. */
const NETWORK_TIMEOUT = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((url) => c.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request, { cache: "no-store" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), NETWORK_TIMEOUT)),
    ]);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (request.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    throw new Error("offline and not cached");
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  /* Firebase has its own transport and must never be cached. */
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("firebaseio.com")) return;

  /* The Firebase SDK: cache first, refresh in the background. It is versioned
     in its own URL, so a stale copy is never wrong. */
  if (url.hostname === "www.gstatic.com") {
    e.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request);
      const fresh = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => hit);
      return hit || fresh;
    }));
    return;
  }

  /* The reset page must never be served from cache — it is the escape hatch
     when a previous worker is stuck. */
  if (url.pathname.endsWith("/reset.html") || url.pathname.endsWith("/cleanup.html")
    || url.pathname.endsWith("/repair.html") || url.pathname.endsWith("/tidy.html")
    || url.pathname.endsWith("/rebuild.html")) return;

  if (url.origin === location.origin) e.respondWith(networkFirst(e.request));
});
