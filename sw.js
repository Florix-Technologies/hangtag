/* Hangtag service worker: keeps the app working offline.
   Serves the saved copy of the app first, then refreshes it in the background,
   so a new version shows up on the next open.
   Supabase (sign-in and data) always goes to the network: a saved copy of that would be stale. */
const CACHE = "hangtag-v3";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
// Other sites whose files are safe to keep for offline use (the Supabase library and the fonts)
const STATIC_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  // Deleting old caches also clears the Supabase answers and ?code= pages the old version saved
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith("http")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin && !STATIC_HOSTS.includes(url.hostname)) return;
  const nav = req.mode === "navigate";
  // Pages are saved under their address without ?code=… so a sign-in return doesn't pin an old copy
  const key = nav ? url.origin + url.pathname : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(key);
      const fresh = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) cache.put(key, res.clone());
          return res;
        })
        .catch(() => hit || (nav ? cache.match("./index.html") : undefined));
      return hit || fresh;
    })
  );
});
