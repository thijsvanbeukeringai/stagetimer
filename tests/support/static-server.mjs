#!/usr/bin/env node
// Minimal static server for the Playwright harness.
//
// Mirrors .devserver.py / vercel.json: serves a directory as-is, rewrites
// /app -> /app.html and sends no-store everywhere. Unlike .devserver.py the
// root and port are configurable, so the booth baseline can be generated from
// an exported copy of an older commit (BASE_ROOT) while the harness itself
// (mocks, fonts, node_modules) always comes from this checkout.
//
//   BASE_ROOT  directory to serve (default: repo root). Relative paths resolve
//              against the repo root.
//   ST_PORT    port (default 5599).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(repoRoot, process.env.BASE_ROOT || '.');
const port = Number(process.env.ST_PORT || 5599);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

if (!fs.existsSync(path.join(root, 'app.html'))) {
  console.error(`[static-server] ${root} has no app.html - wrong BASE_ROOT?`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/__harness') {
    // Lets a test assert which tree is being served (baseline vs current).
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ root }));
    return;
  }
  if (pathname === '/app') pathname = '/app.html';
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'content-length': st.size,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[static-server] serving ${root} at http://127.0.0.1:${port}/`);
});
