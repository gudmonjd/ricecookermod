const CACHE_NAME = "ricecooker-cache-v1";
const FILES_TO_CACHE = [
  "/",
  "/index.html",
  //"/style.css",
  //"/script.js",
  //"/icon-512.png",
  //"/favicon.png",
  //"/favicon.ico",
  //"/icon-192.png",
  "/manifest.json"
];

// Install Event: Safe caching (won't crash if one icon fails to load)
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        FILES_TO_CACHE.map(url => 
          fetch(url).then(response => {
            if (response.ok) return cache.put(url, response);
            throw new Error(`Failed to fetch ${url}`);
          })
        )
      );
    })
  );
});

// Fetch Event: Cache-First strategy (same as yours, which is perfect for offline control)
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
