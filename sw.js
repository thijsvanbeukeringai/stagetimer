// Stagetimer service worker - conservative network-first strategy.
//
// Critical: live users are currently on the app. This SW must NEVER serve
// stale HTML for too long. It only steps in when the network actively fails
// (festival wifi blip, mid-event reconnect), and only for the app shell.
// Supabase / Stripe / OneSignal calls pass through untouched.

const SW_VERSION = 'stagetimer-sw-v4';
const APP_SHELL_CACHE = SW_VERSION + '-shell';

// Only these GET requests are intercepted + cached. Everything else (Supabase,
// Stripe, fonts, OneSignal SDK, etc.) goes straight through the network.
const SHELL_PATHS = new Set([
  '/app',
  '/app.html',
  '/manifest.json',
  '/stagetimer-logo.png',
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    // Best-effort prefetch - don't fail install if one asset can't be fetched.
    await Promise.all([...SHELL_PATHS].map((p) =>
      fetch(p, { cache: 'no-cache' })
        .then((res) => res.ok ? cache.put(p, res.clone()) : null)
        .catch(() => null)
    ));
    // We do NOT skipWaiting on purpose: a live user mid-action stays on the
    // old SW until they reload. New SW takes over on next page load.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== APP_SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only handle same-origin requests for paths we explicitly opted in to.
  if (url.origin !== self.location.origin) return;
  if (!SHELL_PATHS.has(url.pathname)) return;

  // Network-first with 3-second timeout, fallback to cache, fallback to error.
  event.respondWith((async () => {
    try {
      const networkRes = await Promise.race([
        fetch(req, { cache: 'no-cache' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      if (networkRes && networkRes.ok) {
        const clone = networkRes.clone();
        caches.open(APP_SHELL_CACHE).then((c) => c.put(req, clone)).catch(() => {});
      }
      return networkRes;
    } catch (e) {
      const cached = await caches.match(req);
      if (cached) return cached;
      // Last resort: try the alias of /app <-> /app.html so a cached HTML still works
      if (url.pathname === '/app') {
        const alt = await caches.match('/app.html');
        if (alt) return alt;
      } else if (url.pathname === '/app.html') {
        const alt = await caches.match('/app');
        if (alt) return alt;
      }
      throw e;
    }
  })());
});

// Allow the page to trigger an immediate update check (e.g. on logout).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
