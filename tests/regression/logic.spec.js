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

test('Wall day label is the festival date on any device', async ({ browser }) => {
  for (const timezoneId of ['America/Los_Angeles', 'Pacific/Auckland']) {
    const { page, context } = await openOperator(browser, { at: '2026-06-19T20:00:00+02:00', timezoneId });
    expect(await page.evaluate(() => [_wvDayLabel({ name: 'Friday', date: '2026-06-19' }), _wvDayLabel({ name: 'Saturday', date: '2026-11-01' })]))
      .toEqual(['Geplande tijden friday — 19 juni', 'Geplande tijden saturday — 1 november']);
    await context.close();
  }
});

test('timer panel photo: src only assigned when it changes', async ({ browser }) => {
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const { page, context } = await openOperator(browser, {
    at: '2026-06-19T22:30:00+02:00',
    data: { shows: [{ id: 'a', stage: 's1', day: 'd1', artist: 'Alpha', date: '2026-06-19', start: '22:00:00', end: '23:00:00', photo }] },
  });
  const n = await page.evaluate(() => {
    const img = document.getElementById('tp-photo');
    const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    window.__srcSets = 0;
    Object.defineProperty(img, 'src', { configurable: true, get() { return d.get.call(this); }, set(v) { window.__srcSets++; d.set.call(this, v); } });
    return document.getElementById('tp-photo-wrap').classList.contains('has-photo');
  });
  expect(n).toBe(true);
  await page.clock.runFor(3000); // 12 ticks
  expect(await page.evaluate(() => window.__srcSets)).toBe(0);
  await page.evaluate(() => { G.shows[0].photo = ''; });
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => [window.__srcSets, document.getElementById('tp-photo-wrap').classList.contains('has-photo')])).toEqual([1, false]);
  await context.close();
});

test.describe('crew pushes via send-push', () => {
  const data = {
    memberIds: ['u1', 'u2'],
    stages: [{ id: 's1', name: 'Main' }, { id: 's2', name: 'Club' }],
    days: [{ id: 'd1', name: 'Friday', date: '2026-06-19' }, { id: 'd2', name: 'Saturday', date: '2026-06-20' }],
    shows: [
      { id: 'past', stage: 's1', day: 'd1', artist: 'Past', date: '2026-06-19', start: '18:00:00', end: '19:00:00' },
      { id: 'a', stage: 's1', day: 'd1', artist: 'Alpha', date: '2026-06-19', start: '22:00:00', end: '23:00:00', startsAt: '2026-06-19T22:00:00', endsAt: '2026-06-19T23:00:00' },
      { id: 'late', stage: 's2', day: 'd1', artist: 'Late', date: '2026-06-19', start: '23:30:00', end: '01:30:00' },
      { id: 'x', stage: 's2', day: 'd1', artist: 'Off', date: '2026-06-19', start: '21:00:00', end: '22:00:00', cancelled: true },
      { id: 'other', stage: 's1', day: 'd2', artist: 'Other day', date: '2026-06-20', start: '21:00:00', end: '22:00:00' },
    ],
  };
  const sendPush = (onCall) => async (route, req, u, st, json) => {
    if (!u.includes('/functions/v1/send-push')) return false;
    await onCall(route, req, json);
    return true;
  };
  test('schedules from end / endsAt / stage in festival time, user token, no OneSignal', async ({ browser }) => {
    const sent = [];
    const { page, context, st } = await openOperator(browser, {
      at: '2026-06-19T20:00:00+02:00', timezoneId: 'America/New_York', data,
      handle: sendPush(async (route, req, json) => {
        sent.push({ auth: req.headers()['authorization'], body: JSON.parse(req.postData()) });
        await json(route, 200, { ok: true, id: 'n' + sent.length, recipients: 2 });
      }),
    });
    expect(sent.map(s => s.body.show_id)).toEqual(['a', 'late']);
    expect(sent[0].auth).toBe('Bearer user.jwt');
    expect(sent[0].body).toEqual({
      project_id: 'P1', show_id: 'a', include_external_user_ids: ['u1', 'u2'],
      headings: { en: 'Alpha almost finished', nl: 'Alpha almost finished' },
      contents: { en: 'Alpha on Main ends at 23:00 - about 10 min left.', nl: 'Alpha on Main ends at 23:00 - about 10 min left.' },
      send_after: '2026-06-19T20:50:00.000Z',
    });
    expect(sent[1].body.send_after).toBe('2026-06-19T23:20:00.000Z'); // 01:30 next night = 01:20 CEST push
    expect(sent[1].body.contents.en).toBe('Late on Club ends at 01:30 - about 10 min left.');
    expect(st.requests.some(r => /onesignal/i.test(r))).toBe(false);
    expect(st.unexpected).toEqual([]);
    expect(await page.evaluate(() => typeof OS_REST_KEY)).toBe('undefined');
    await context.close();
  });
  test('missing function (404): one clear operator notice, no retries', async ({ browser }) => {
    let calls = 0;
    const { page, context, st } = await openOperator(browser, {
      at: '2026-06-19T20:00:00+02:00', data,
      handle: sendPush(async (route, req, json) => {
        calls++;
        await json(route, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
      }),
    });
    expect(calls).toBe(1);
    await expect(page.locator('#op-notices')).toContainText('Push is not configured yet');
    await page.evaluate(() => openProject('P1'));
    await page.clock.runFor(1000);
    expect(calls).toBe(1);
    expect(st.errors).toEqual([]);
    await context.close();
  });
});
