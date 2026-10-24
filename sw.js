// Stagetimer service worker - the ONE worker for scope '/'.
//
// Critical: live users are on the app. This SW must NEVER serve stale HTML for
// too long. HTML is network-first; the cache only steps in when the network
// actively fails or hangs (festival wifi blip, mid-event reconnect).
// Supabase / Stripe / OneSignal API calls pass through untouched.
//
// ── Push (OneSignal Web SDK v16) ────────────────────────────────────────────
// A scope can only have one service worker, and sw.js and OneSignalSDKWorker.js
// both registered at '/', so whichever registered last silently replaced the
// other. Per OneSignal's documented "existing service worker" integration we
// importScripts their SW SDK here and point OneSignal.init() at this file
// (serviceWorkerPath: 'sw.js', scope '/', see app.html). Only on the
// production apex, the only origin the OneSignal app is configured for (same
// rule as window._OS_ENABLED in app.html), so localhost/previews never load
// it. OneSignalSDKWorker.js stays in the repo only so older registrations
// that still point at it keep updating cleanly; nothing registers it anymore.
// If the import fails (offline during an update check) the install fails and
// the previous worker simply stays active - the browser retries later.
if (self.location.hostname === 'stagetimer.nl') {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
}

// ── Versioning ──────────────────────────────────────────────────────────────
// No build step, so this is bumped BY HAND. Bump it on every deploy that
// changes app.html, /vendor, /fonts or the icons. A bump:
//   - makes the browser install the new worker (sw.js itself changed),
//   - drops the old caches on activate,
//   - makes open control screens show "new version available"
//     (app.html dispatches `st:sw-update` when a new worker is waiting).
// Without a bump the app still updates (HTML is network-first), the open tab
// just isn't told about it.
const SW_VERSION = 'stagetimer-sw-v43';
const APP_SHELL_CACHE = SW_VERSION + '-shell';

// Precached on install so the app shell can boot with no network at all.
const PRECACHE = [
  '/app.html',
  '/manifest.json',
  '/vendor/supabase.js',            // @supabase/supabase-js 2.112.3 (UMD, SRI-pinned in app.html)
  '/fonts/fonts.css',
  // The latin + latin-ext subsets app.html actually needs on first paint;
  // other subsets (cyrillic, greek, ...) are cached on first use.
  '/fonts/inter-latin.woff2',
  '/fonts/inter-latin-ext.woff2',
  '/fonts/jetbrains-mono-latin.woff2',
  '/fonts/jetbrains-mono-latin-ext.woff2',
  '/fonts/geist-latin.woff2',
  '/fonts/geist-latin-ext.woff2',
  '/stagetimer-logo.png',
  '/stagetimer-wordmark.png',
  '/app-icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

// '/app' (Vercel rewrite) and '/app.html' are the same document; every query
// string (?mode=stage&pid=..) too. They share one cache entry.
const HTML_PATHS = new Set(['/app', '/app.html']);
const HTML_KEY = '/app.html';
// Network-first (fresh when online, cached when not). Vendor is network-first
// on purpose: app.html pins it with SRI, so a stale copy after an upgrade
// without a SW_VERSION bump would be blocked by the browser.
const NETWORK_FIRST = new Set(PRECACHE.filter((p) => !p.startsWith('/fonts/')));
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    // Best-effort - don't fail install if one asset can't be fetched.
    await Promise.all(PRECACHE.map((p) =>
      fetch(p, { cache: 'no-cache' })
        .then((res) => (res.ok ? cache.put(p, res) : null))
        .catch(() => null)
    ));
    // We do NOT skipWaiting on purpose: a live user mid-action stays on the
    // old worker. The page offers a reload (control screens) or applies it
    // when the tab is hidden (public screens) by posting 'SKIP_WAITING'.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('stagetimer-sw-') && k !== APP_SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function putInCache(key, res) {
  if (!res || !res.ok || res.type !== 'basic') return;
  const copy = res.clone();
  caches.open(APP_SHELL_CACHE).then((c) => c.put(key, copy)).catch(() => {});
}

// Network-first with a 3 s timeout. On timeout/failure: the cached copy if we
// have one, otherwise keep waiting for the network (never fail just because
// the network is slow and nothing is cached yet).
async function networkFirst(req, key) {
  const network = fetch(req, { cache: 'no-cache' }).then((res) => { putInCache(key, res); return res; });
  network.catch(() => {}); // handled below; avoid an unhandled rejection
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_TIMEOUT_MS, null); });
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (e) { /* network error - fall back to the cache */ }
  finally { clearTimeout(timer); }
  const cached = await caches.match(key);
  if (cached) return cached;
  return network; // nothing cached: wait for (or rethrow) the network result
}

async function cacheFirst(req, key) {
  const cached = await caches.match(key);
  if (cached) return cached;
  const res = await fetch(req);
  putInCache(key, res);
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only same-origin requests for paths we explicitly opted in to.
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (HTML_PATHS.has(path)) {
    event.respondWith(networkFirst(req, HTML_KEY));
  } else if (path.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(req, path));
  } else if (NETWORK_FIRST.has(path)) {
    event.respondWith(networkFirst(req, path));
  }
});

// The page posts 'SKIP_WAITING' to activate a waiting update (then reloads on
// controllerchange). OneSignal's own messages are objects and are ignored here.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
