// Smoke: the local fake Supabase for the iOS simulator (tests/support/mock-server.js)
// carries the real app end to end over real HTTP + WebSocket, with real CORS.
//
// app.html is served with SUPA_URL pointed at the server, exactly what the
// native dev build does. The fixture's guard still aborts and fails on any
// non-localhost request, and the in-process MockBackend must see no call at
// all: everything went to the server on 127.0.0.1.
const { spawn } = require('child_process');
const path = require('path');
const { test, expect } = require('../support/fixtures');
const { SUPA_HOST } = require('../support/mock-backend');
const LOGIN = require('../support/mock-server.seed.json');

let proc;
let base;
let log = '';

test.beforeAll(async () => {
  // --port 0: every worker gets its own free port, parallel runs never clash.
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'support', 'mock-server.js'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => { log += d; });   // keep draining: a full pipe would stall the server
  proc.stderr.on('data', (d) => { log += d; });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock server did not start:\n${log}`)), 10_000);
    proc.stdout.on('data', () => {
      const m = log.match(/fake Supabase at (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mock server exited (${code}):\n${log}`)); });
  });
});
test.afterAll(() => { if (proc) proc.kill('SIGINT'); });

test('login, projects and realtime run through the local mock server', async ({ page, context, backend, browserName }) => {
  // Chromium's Local Network Access check treats another loopback port as a
  // permission prompt; the simulator (WebKit) has no such gate.
  if (browserName === 'chromium') await context.grantPermissions(['local-network-access']);
  const PROD = `const SUPA_URL='https://${SUPA_HOST}';`;
  await page.route('**/app.html', async (route) => {
    const html = await (await route.fetch()).text();
    expect(html.split(PROD).length - 1, 'app.html declares SUPA_URL exactly once').toBe(1);
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html.replace(PROD, `const SUPA_URL='${base}';`) });
  });
  await page.goto('/app.html');
  await page.locator('#li-email').fill(LOGIN.email);
  await page.locator('#li-pw').fill(LOGIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.locator('#dash.open')).toBeVisible();
  await page.waitForFunction(() => window._remoteLoaded === true);
  await expect(page.locator('#proj-grid')).toContainText('Zomerfeest 2026');

  // The demo seed is shifted to now: Main Stage has a live show.
  await page.locator('#proj-grid tr', { hasText: 'Zomerfeest 2026' }).first().click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('body')).toContainText("DJ O'Neil");

  await expect.poll(() => log).toMatch(/POST\s+\/auth\/v1\/token\?grant_type=password -> 200/);
  await expect.poll(() => log).toMatch(/GET\s+\/rest\/v1\/projects\?.* -> 200/);
  await expect.poll(() => log).toMatch(/WS\s+\/realtime\/v1\/websocket\?.* -> 101/);
  expect(log).not.toMatch(/-> 404 .*\(not mocked\)|-> 500/);
  expect(backend.requests.filter((r) => r.host === SUPA_HOST)).toEqual([]);
});
