// The offline service worker. This file is not bundled: at build time
// scripts/service-worker.mjs prepends `const VERSION = "…"` and `const PRECACHE = [ … ]`
// (every file in dist/) and writes the result to dist/sw.js.
//
// Strategy: precache the whole game on install (it is ~0.5 MB) and serve everything
// cache-first, so the game starts instantly and works with no connection. A new deploy
// changes VERSION, so the browser installs the new worker in the background; it takes over
// straight away (skipWaiting + clients.claim) and the next launch runs the new version.
// The page loads all of its assets at start-up, so an open page never needs files from a
// cache that has just been replaced.

/* global VERSION, PRECACHE */
const CACHE_PREFIX = "premove-";
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const SHELL = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // straight from the server: the HTTP cache may still hold the previous deploy's
      // index.html (GitHub Pages sends max-age=600)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return; // let the browser handle it
  }
  if (request.mode === "navigate") {
    // the app is a single page: any navigation inside the scope gets the cached shell
    event.respondWith(
      caches.match(SHELL, { cacheName: CACHE }).then((cached) => cached ?? fetch(request)),
    );
    return;
  }
  event.respondWith(
    caches.match(request, { cacheName: CACHE, ignoreSearch: true }).then((cached) => cached ?? fetch(request)),
  );
});
