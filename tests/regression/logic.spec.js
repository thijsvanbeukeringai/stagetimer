// Regression tests: operator (logged-in) logic paths.
//
// Self-contained like timer.spec.js until the shared harness (tests/support)
// lands: every HTTP request is answered by context.route below, WebSockets
// are closed and service workers blocked, so nothing reaches a real server.
// Anything that is not the fake origin or the (fully mocked) Supabase host is
// recorded in st.unexpected and fails the test.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8')
  .replace(/\sintegrity="[^"]*"/g, ''); // the stubbed supabase-js would fail SRI
const ORIGIN = 'https://stagetimer.test';
const SUPA = 'https://bamjpsquhdzxvsymldpq.supabase.co';
const SUPA_STUB = `window.supabase={createClient(){const ch={on(){return ch},subscribe(){return ch}};return{
  auth:{onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}},getSession:async()=>({data:{session:null}}),
        setSession:async()=>({data:{session:null}}),signOut:async()=>({}),refreshSession:async()=>({data:{session:null}})},
  channel(){return ch},removeChannel(){},
  from(){const q={select(){return q},eq(){return q},then(r){r({data:[],error:null})}};return q}}}};`;

function projectRow(data) {
  return {
    id: 'P1', name: 'Test', company_id: 'C1', created_at: 1, created_by: 'u1',
    data: Object.assign({
      stages: [{ id: 's1', name: 'Main' }],
      days: [{ id: 'd1', name: 'Friday', date: '2026-06-19' }],
      activeStage: 's1', activeDay: 'd1', timerMode: 'live', fohNotes: {}, memberIds: [],
      shows: [
        { id: 'a', stage: 's1', day: 'd1', artist: 'Alpha', date: '2026-06-19', start: '22:00:00', end: '23:00:00', startsAt: '2026-06-19T22:00:00', endsAt: '2026-06-19T23:00:00' },
      ],
    }, data || {}),
  };
}

// Opens app.html as a logged-in operator with project P1 open.
// opts.handle(route, req, url, st) may answer a request first (return true).
async function openOperator(browser, { at, data, role = 'operator', timezoneId = 'Europe/Amsterdam', company, handle, users } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', timezoneId, viewport: { width: 1280, height: 800 } });
  if (context.routeWebSocket) await context.routeWebSocket(/.*/, ws => ws.close());
  const page = await context.newPage();
  const st = { unexpected: [], errors: [], patches: [], requests: [], row: projectRow(data) };
  page.on('pageerror', e => st.errors.push(e.message));
  page.on('dialog', d => { st.dialogs = (st.dialogs || []).concat([d.message()]); d.accept().catch(() => {}); });
  await page.clock.install({ time: new Date(at) });
  const me = { id: 'u1', name: 'Op', email: 'op@example.test', role, company_id: 'C1' };
  const co = Object.assign({ id: 'C1', name: 'Co', subscription_status: 'active', plan_slug: 'pro', live_stages_limit: null, setup_pending: false }, company || {});
  const json = (route, status, body, headers) => route.fulfill({ status, contentType: 'application/json', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  await context.route('**/*', async route => {
    const req = route.request(), u = req.url(), m = req.method();
    if (u.startsWith(ORIGIN + '/app.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: APP_HTML });
    if (u.includes('/vendor/supabase.js') || u.includes('supabase-js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPA_STUB });
    if (u.startsWith(SUPA)) st.requests.push(m + ' ' + u.slice(SUPA.length));
    if (handle && await handle(route, req, u, st, json)) return;
    if (u.startsWith(SUPA + '/auth/v1/user')) return json(route, 200, { id: 'auth-u1', email: me.email });
    if (u.startsWith(SUPA + '/rest/v1/app_users')) return json(route, 200, u.includes('email=eq.') ? [me] : (users || [me]));
    if (u.startsWith(SUPA + '/rest/v1/companies')) return json(route, 200, [co]);
    if (u.startsWith(SUPA + '/rest/v1/projects')) {
      if (m === 'GET') return json(route, 200, [st.row]);
      if (m === 'PATCH') {
        const body = JSON.parse(req.postData() || '{}');
        st.patches.push(body);
        if (body.data) st.row.data = body.data;
        return json(route, 200, [{ id: 'P1' }]);
      }
    }
    if (u.startsWith(SUPA + '/rest/v1/') && m === 'HEAD') return route.fulfill({ status: 200, headers: { date: new Date(at).toUTCString() }, body: '' });
    if (!u.startsWith(ORIGIN) && !u.startsWith(SUPA + '/')) st.unexpected.push(u);
    return route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__seeded')) return; // keep state across reloads
    sessionStorage.setItem('__seeded', '1');
    localStorage.setItem('st_auth_v1', JSON.stringify({ access_token: 'user.jwt', refresh_token: 'r1' }));
  });
  await page.goto(`${ORIGIN}/app.html`);
  await page.clock.runFor(1500);
  await page.evaluate(() => openProject('P1'));
  await page.clock.runFor(1000);
  return { page, context, st };
}

test.describe('show editor uses festival time', () => {
  for (const timezoneId of ['Europe/Amsterdam', 'America/New_York', 'Asia/Tokyo']) {
    test(`round trip on a device in ${timezoneId}`, async ({ browser }) => {
      const { page, context, st } = await openOperator(browser, { at: '2026-06-19T20:00:00+02:00', timezoneId });
      const fields = () => page.evaluate(() => ['f-start-date', 'f-start-time', 'f-start-sec', 'f-end-date', 'f-end-time', 'f-end-sec']
        .map(id => document.getElementById(id).value));
      // Existing show: the inputs show 22:00-23:00 festival time.
      await page.evaluate(() => openDrawer('a'));
      expect(await fields()).toEqual(['2026-06-19', '22:00', '00', '2026-06-19', '23:00', '00']);
      // Save unchanged: nothing moves.
      await page.evaluate(() => saveShow());
      let a = await page.evaluate(() => G.shows.find(s => s.id === 'a'));
      expect(a).toMatchObject({ date: '2026-06-19', start: '22:00:00', end: '23:00:00', startsAt: '2026-06-19T22:00:00', endsAt: '2026-06-19T23:00:00', endsNextDay: false });
      // Edit across midnight with seconds.
      await page.evaluate(() => {
        openDrawer('a');
        const set = (id, v) => { document.getElementById(id).value = v; };
        set('f-start-time', '23:30'); set('f-start-sec', '15');
        set('f-end-date', '2026-06-20'); set('f-end-time', '01:15'); set('f-end-sec', '00');
        saveShow();
      });
      a = await page.evaluate(() => G.shows.find(s => s.id === 'a'));
      expect(a).toMatchObject({ date: '2026-06-19', start: '23:30:15', end: '01:15:00', startsAt: '2026-06-19T23:30:15', endsAt: '2026-06-20T01:15:00', endsNextDay: true });
      await page.evaluate(() => { openDrawer('a'); updDur(); });
      expect(await page.evaluate(() => document.getElementById('dur-txt').textContent)).toBe('Duration: 1h 44m 45s · ends next day');
      await page.evaluate(() => closeDrawer());
      // New show: starts where the last one ends, 90 min long, festival time.
      await page.evaluate(() => openDrawer(null));
      expect(await fields()).toEqual(['2026-06-20', '01:15', '00', '2026-06-20', '02:45', '00']);
      await page.clock.runFor(1000);
      expect(st.patches.length).toBeGreaterThan(0);
      expect(st.row.data.shows[0].startsAt).toBe('2026-06-19T23:30:15');
      expect(st.errors).toEqual([]);
      expect(st.unexpected).toEqual([]);
      await context.close();
    });
  }
  test('new show on an empty day starts at the current festival hour', async ({ browser }) => {
    const { page, context } = await openOperator(browser, { at: '2026-06-19T20:40:00+02:00', timezoneId: 'America/New_York', data: { shows: [] } });
    await page.evaluate(() => openDrawer(null));
    const v = await page.evaluate(() => ['f-start-date', 'f-start-time', 'f-start-sec', 'f-end-time'].map(id => document.getElementById(id).value));
    expect(v).toEqual(['2026-06-19', '20:00', '00', '21:30']);
    await context.close();
  });
});
