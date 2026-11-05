// Docket's service worker — exists only to satisfy PWA installability
// (a home-screen icon, a standalone window) and to keep the app's own
// static shell available if the connection drops mid-session. It is
// deliberately narrow:
//
// - Never touches `/api/*`. Those responses are per-request, often
//   privileged, and must always come from the network — caching one
//   would mean either serving stale case data or, worse, one user's
//   cached response reappearing for a different session. The fetch
//   handler returns immediately for any such request, which lets the
//   browser handle it exactly as if no service worker existed at all.
// - Network-first for everything else (the HTML/CSS/JS shell, icons,
//   the manifest itself) rather than cache-first: this app redeploys
//   often, and a returning visitor should see today's app.js, not a
//   version cached last week. The cache is purely a fallback for when
//   the network request fails.
const CACHE_NAME = "docket-shell-v1";
const SHELL_PATHS = [
  "/login.html",
  "/login.css",
  "/login.js",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_PATHS).catch(() => undefined)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
