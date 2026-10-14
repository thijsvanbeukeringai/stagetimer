#!/usr/bin/env node
// Copies the web app into the Capacitor webDir (native/www). Not a bundler:
// app.html is copied byte for byte as www/index.html, plus exactly the local
// files it references. Plain node, no dependencies.
//
//   node scripts/sync-web.mjs                      release: production backend
//   node scripts/sync-web.mjs --dev                dev: $BACKEND or http://127.0.0.1:54350
//   node scripts/sync-web.mjs --backend <url>      dev: that backend
//   ... --cap-sync                                 then run `cap sync ios`
//
// --backend rewrites the production Supabase host in the COPIED index.html
// only. app.html hardcodes SUPA_URL, so a simulator build without it would
// read and write real customer data (CLAUDE.md rule 2).
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const NATIVE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(NATIVE, '..');
const WWW = join(NATIVE, 'www');
const PROD_HOST = 'bamjpsquhdzxvsymldpq.supabase.co';
const PROD_URL = `https://${PROD_HOST}`;
const DEFAULT_DEV_BACKEND = 'http://127.0.0.1:54350';
// No service worker in the native app: WKWebView does not run one on
// capacitor://, and push goes through the native OneSignal plugin instead.
const NEVER_COPY = new Set(['sw.js', 'OneSignalSDKWorker.js']);
const ASSET_EXT = 'png|svg|jpe?g|webp|gif|ico|json|js|css|woff2?|ttf|otf|mp3|wav|m4a|ogg|webmanifest';

const die = (msg) => { console.error(`\n[sync-web] FAILED: ${msg}\n`); process.exit(1); };
const log = (msg) => console.log(`[sync-web] ${msg}`);

// ── args
const argv = process.argv.slice(2);
let backend = null, capSync = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dev') backend = backend || process.env.BACKEND || DEFAULT_DEV_BACKEND;
  else if (a === '--backend') { backend = argv[++i]; if (!backend) die('--backend needs a URL'); }
  else if (a.startsWith('--backend=')) backend = a.slice('--backend='.length);
  else if (a === '--cap-sync') capSync = true;
  else die(`unknown argument "${a}"`);
}
if (backend !== null) {
  let u;
  try { u = new URL(backend); } catch { die(`--backend "${backend}" is not a URL`); }
  if (!/^https?:$/.test(u.protocol)) die(`--backend must be http(s), got "${u.protocol}"`);
  if (u.hostname === PROD_HOST) die('--backend points at the production project');
  if (u.pathname !== '/' || u.search || u.hash) die('--backend must be an origin only (no path/query), like supabase-js expects');
  backend = u.origin;
}

// ── collect local assets referenced by a text file
const isLocalAsset = (p) => p && !/^(?:[a-z]+:|\/\/|#|\$\{)/i.test(p) && new RegExp(`\\.(?:${ASSET_EXT})$`, 'i').test(p);
function refsIn(text) {
  const out = new Set();
  // quoted strings and CSS url(...) that end in an asset extension
  const re = new RegExp(`["'\`(]\\s*(/?[A-Za-z0-9_./-]+\\.(?:${ASSET_EXT}))\\s*["'\`)?#]`, 'gi');
  for (const m of text.matchAll(re)) if (isLocalAsset(m[1])) out.add(m[1].replace(/^\.?\//, ''));
  return out;
}
const srcPath = (rel) => {
  const p = resolve(ROOT, rel);
  if (!p.startsWith(ROOT + sep)) die(`asset "${rel}" resolves outside the repo`);
  if (rel.split('/')[0] === 'native') die(`asset "${rel}" points into native/`);
  return p;
};

// ── build www/
const appHtml = join(ROOT, 'app.html');
if (!existsSync(appHtml)) die(`missing ${appHtml}`);
let html = readFileSync(appHtml, 'utf8');

const nSupa = (html.match(/const SUPA_URL\s*=\s*(['"])https:\/\/bamjpsquhdzxvsymldpq\.supabase\.co\1/g) || []).length;
if (nSupa !== 1) die(`expected exactly one production "const SUPA_URL=..." in app.html, found ${nSupa}`);

if (backend !== null) {
  html = html.replace(/(const SUPA_URL\s*=\s*)(['"])https:\/\/bamjpsquhdzxvsymldpq\.supabase\.co\2/, `$1$2${backend}$2`);
  const esc = backend.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const nNew = (html.match(new RegExp(`const SUPA_URL\\s*=\\s*(['"])${esc}\\1`, 'g')) || []).length;
  if (nNew !== 1) die(`SUPA_URL rewrite did not happen exactly once (found ${nNew})`);
  // The same host is also hardcoded outside SUPA_URL (preconnect hints, the
  // early share-link fetch in <head>). Point those at the dev backend too, then
  // prove that not a single reference to production is left.
  html = html.split(PROD_URL).join(backend);
  if (html.includes(PROD_HOST)) die(`production host ${PROD_HOST} still appears in the dev index.html (a form other than ${PROD_URL})`);
}

// Asset list: every local file app.html references, plus vendor/ and fonts/
// whole (fonts.css picks files by unicode-range), plus what those reference.
const assets = new Set(['vendor', 'fonts']);
const queue = [...refsIn(html)];
const seen = new Set();
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  if (NEVER_COPY.has(rel)) { log(`skip ${rel} (no service worker in the native app)`); continue; }
  const p = srcPath(rel);
  if (!existsSync(p) || !statSync(p).isFile()) die(`app.html references "${rel}" but ${relative(ROOT, p) || p} does not exist`);
  assets.add(rel);
  if (/\.(css|json|webmanifest)$/i.test(rel)) {
    const text = readFileSync(p, 'utf8');
    let refs = [...refsIn(text)];
    if (/\.(json|webmanifest)$/i.test(rel)) {
      try { const j = JSON.parse(text); refs = refs.concat((j.icons || []).map(i => String(i.src || '').replace(/^\//, ''))); }
      catch (e) { die(`${rel} is not valid JSON: ${e.message}`); }
    }
    for (const r of refs) if (isLocalAsset(r)) queue.push(r);
  }
}
for (const d of ['vendor', 'fonts']) if (!existsSync(join(ROOT, d))) die(`missing ${d}/`);

rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });
writeFileSync(join(WWW, 'index.html'), html);
for (const rel of [...assets].sort()) {
  const dst = join(WWW, rel);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(srcPath(rel), dst, { recursive: true });
}
for (const f of NEVER_COPY) if (existsSync(join(WWW, f))) die(`${f} ended up in www/`);

log(`www/ ready: index.html + ${[...new Set([...assets].map(a => a.split('/')[0]))].sort().join(', ')}`);
log(backend === null
  ? `backend: PRODUCTION (${PROD_URL}). Release builds only, never run this build to test.`
  : `backend: ${backend} (dev; production host removed from index.html)`);

if (capSync) {
  const cap = join(NATIVE, 'node_modules', '.bin', 'cap');
  if (!existsSync(cap)) die('node_modules missing: run `npm install` in native/ first');
  const r = spawnSync(cap, ['sync', 'ios'], { cwd: NATIVE, stdio: 'inherit' });
  if (r.status !== 0) die('`cap sync ios` failed');
}
