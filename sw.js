const CACHE_NAME = 'attendance-v5';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-512.png',
  './lib/html5-qrcode.min.js',
  './lib/xlsx.full.min.js',
  './lib/supabase.js',
  './lib/chart.js'
];

// Cache Google Fonts
const FONT_CACHE_NAME = 'google-fonts';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME && key !== FONT_CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Special handling for Google Fonts
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    e.respondWith(
      caches.match(e.request).then(cachedResponse => {
        if (cachedResponse) return cachedResponse;
        return fetch(e.request).then(networkResponse => {
          const responseClone = networkResponse.clone();
          caches.open(FONT_CACHE_NAME).then(cache => cache.put(e.request, responseClone));
          return networkResponse;
        });
      })
    );
    return;
  }

  // Default strategy: Network first, fallback to cache
  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Update cache with the latest version for local assets
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(e.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Fall back to cache if offline
        return caches.match(e.request).then(cached => {
            if (cached) return cached;
            // If it's a navigation request, return index.html
            if (e.request.mode === 'navigate') {
                return caches.match('./index.html');
            }
        });
      })
  );
});
