#!/usr/bin/env node
// Local fake Supabase over real HTTP + WebSocket, for the iOS simulator.
//
//   node tests/support/mock-server.js [--port 54321|0] [--seed demo|festival|empty]
//   npm run mock:server -- --port 54321
//
// Why: app.html hardcodes the production SUPA_URL. The native dev build
// rewrites it to http://127.0.0.1:<port>, and this server answers there, so a
// smoke test in the simulator never touches production. It is the SAME fake as
// the Playwright harness: MockBackend.handleRequest (HTTP) and RealtimeStub
// (Phoenix websocket), driven by node's http server and the `ws` package
// instead of Playwright routes. State lives in memory and is gone on exit.
//
// Paths: /rest/v1/* (incl. rpc/ and HEAD /rest/v1/ = server clock),
// /auth/v1/*, /functions/v1/*, /storage/v1/*, /realtime/v1/websocket,
// /realtime/v1/api/broadcast. Anything else: 404 JSON. There is no outbound
// network code here at all: nothing is proxied.
//
// Seeds:
//   demo      (default) the test festival moved so a show is live now on Main
//             Stage and The Tent (festivalSeed shifted by demoSeed), company
//             plan active for a year, plus the login in mock-server.seed.json
//   festival  festivalSeed() exactly as the specs see it (July 2026) + that login
//   empty     the company and the login, no projects
// The seed.js test users (FESTIVAL.users) can log in too.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { MockBackend, SUPA_HOST } = require('./mock-backend');
const { demoSeed, festivalSeed } = require('./seed');

const HOST = '127.0.0.1'; // loopback only: this is a dev fake with open CORS and no auth worth the name
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
if (args.includes('--help') || args.includes('-h')) {
  console.log('node tests/support/mock-server.js [--port 54321] [--seed demo|festival|empty]');
  process.exit(0);
}
let PORT = Number(arg('port', process.env.MOCK_PORT || 54321)); // 0: any free port (printed on startup)
const SEED = arg('seed', 'demo');
const LOGIN = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-server.seed.json'), 'utf8'));

function buildSeed(name) {
  const seed = demoSeed(Date.now(), LOGIN);   // users + a company whose plan is active
  if (name === 'festival') seed.projects = festivalSeed().projects.map((p) => ({ ...p, created_by: LOGIN.id }));
  else if (name === 'empty') seed.projects = [];
  else if (name !== 'demo') { console.error(`[mock-server] unknown --seed "${name}" (demo, festival, empty)`); process.exit(2); }
  return seed;
}

const backend = new MockBackend().seed(buildSeed(SEED));
backend.serverNow = () => Date.now(); // HEAD /rest/v1/ answers with this machine's clock

// The page origin is capacitor://localhost (or a local static server).
// MockBackend's CORS block is fine for Playwright routes, which skip the
// browser's CORS checks; a real WebKit needs the request headers echoed,
// because "*" never covers Authorization.
const ALLOW_HEADERS = 'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-client-info, x-supabase-api-version, x-upsert, cache-control';
function cors(req) {
  return {
    'access-control-allow-origin': req.headers.origin || '*',
    'access-control-allow-headers': req.headers['access-control-request-headers'] || ALLOW_HEADERS,
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS',
    'access-control-expose-headers': 'content-range, date, x-supabase-api-version',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

const SERVED = [/^\/rest\/v1(\/|$)/, /^\/auth\/v1\//, /^\/functions\/v1\//, /^\/storage\/v1\//, /^\/realtime\/v1\/api\/broadcast$/];

// One line per request. Query strings are cut short and the anon apikey dropped.
function logLine(method, url, status, t0, note = '') {
  const u = new URL(url, 'http://x');
  u.searchParams.delete('apikey');
  let q = u.searchParams.toString();
  if (q.length > 100) q = q.slice(0, 97) + '...';
  const t = new Date().toISOString().slice(11, 23);
  console.log(`${t} ${method.padEnd(7)} ${u.pathname}${q ? '?' + q : ''} -> ${status} ${Date.now() - t0}ms${note ? ' ' + note : ''}`);
}

function send(req, res, status, headers, body) {
  res.writeHead(status, { ...headers, ...cors(req) });
  res.end(req.method === 'HEAD' ? undefined : body);
}
const jsonError = (code, message) => JSON.stringify({ code, details: null, hint: null, message });

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (req.method !== 'OPTIONS' && !SERVED.some((re) => re.test(pathname))) {
      send(req, res, 404, { 'content-type': 'application/json' }, jsonError('MOCK404', `mock server: no route for ${req.method} ${pathname}`));
      return logLine(req.method, req.url, 404, t0);
    }
    const buf = Buffer.concat(chunks);
    let out;
    try {
      out = await backend.handleRequest({
        method: req.method, url: `http://${HOST}:${PORT}${req.url}`, headers: req.headers,
        raw: buf.length ? buf.toString('utf8') : null, buffer: buf,
      }, { supabase: true });
    } catch (e) {
      console.warn('[mock-server] handler failed:', e);
      out = { status: 500, headers: {}, body: 'mock error' };
    }
    if (out.violation) {
      // Unmocked Supabase endpoint: a plain 404 here (Playwright aborts it and fails the test).
      send(req, res, 404, { 'content-type': 'application/json' }, jsonError('MOCK404', out.violation));
      return logLine(req.method, req.url, 404, t0, '(not mocked)');
    }
    if (out.hang) return logLine(req.method, req.url, '---', t0, '(left unanswered)');
    if (out.abort) { req.socket.destroy(); return logLine(req.method, req.url, 'xxx', t0, `(aborted: ${out.abort})`); }
    const body = out.path ? fs.readFileSync(out.path) : out.body;
    send(req, res, out.status, out.headers, body);
    logLine(req.method, req.url, out.status, t0, out.status >= 500 ? String(body).slice(0, 200) : '');
  });
});

// ── Realtime: a real `ws` socket dressed as Playwright's WebSocketRoute, so
// RealtimeStub (phx_join, heartbeat, broadcast, presence, postgres_changes)
// runs unchanged.
function asWebSocketRoute(sock, url) {
  return {
    url: () => url,
    send: (m) => { if (sock.readyState === sock.OPEN) sock.send(m); },
    close: ({ code, reason } = {}) => sock.close(code, reason),
    onMessage: (cb) => sock.on('message', (data, isBinary) => cb(isBinary ? data : data.toString('utf8'))),
    onClose: (cb) => sock.on('close', () => cb()),
  };
}
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const t0 = Date.now();
  if (new URL(req.url, 'http://x').pathname !== '/realtime/v1/websocket') {
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return logLine('WS', req.url, 404, t0);
  }
  wss.handleUpgrade(req, socket, head, (sock) => {
    logLine('WS', req.url, 101, t0, '(realtime connected)');
    sock.on('close', (code) => logLine('WS', req.url, `closed ${code}`, t0));
    backend.realtime._onSocket(asWebSocketRoute(sock, `ws://${HOST}:${PORT}${req.url}`));
  });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `[mock-server] port ${PORT} is busy (another mock server or a local Supabase?). Use --port.` : `[mock-server] ${e.message}`);
  process.exit(1);
});

// macOS lets this 127.0.0.1 bind succeed next to a wildcard listener on the
// same port (e.g. `supabase start` in Docker/colima, whose API port is 54321
// too). Then 127.0.0.1 (and localhost) reach this mock, but the LAN address
// and, once this mock stops, 127.0.0.1 itself reach the other service without
// any error. Probe first and say so loudly instead of failing silently.
function portTaken(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const s = net.connect({ host: HOST, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}
portTaken(PORT).then((taken) => server.listen(PORT, HOST, () => {
  if (taken) {
    console.warn([
      `[mock-server] WARNING: something else already listens on port ${PORT} (wildcard address; a local Supabase in Docker?).`,
      `[mock-server]   http://${HOST}:${PORT} reaches this mock; the LAN address reaches the other service, and so does`,
      `[mock-server]   ${HOST} once this mock stops. Stop that service or use --port <other> with a matching SUPA_URL.`,
    ].join('\n'));
  }
  PORT = server.address().port;
  const base = `http://${HOST}:${PORT}`;
  const fest = backend.db.projects.length;
  console.log([
    `[mock-server] fake Supabase at ${base}  (seed: ${SEED}, ${fest} project${fest === 1 ? '' : 's'}, in memory)`,
    `[mock-server] stands in for https://${SUPA_HOST}; nothing is proxied, nothing leaves this machine`,
    `[mock-server] login: ${LOGIN.email} / ${LOGIN.password}   (test values, tests/support/mock-server.seed.json)`,
    `[mock-server] point the dev build at: SUPA_URL='${base}'   Ctrl-C to stop`,
  ].join('\n'));
}));

let stopping = false;
function stop() {
  if (stopping) return process.exit(0);
  stopping = true;
  console.log('\n[mock-server] stopping');
  for (const c of wss.clients) c.terminate();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
