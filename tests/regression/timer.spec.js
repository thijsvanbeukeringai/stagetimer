// Regression tests: timer logic + public view data feed.
//
// Self-contained until the shared harness (tests/support) lands: every HTTP
// request is answered by page.route below (supabase-js is stubbed, the RPC
// and REST reads are fixtures), WebSockets are closed and service workers
// blocked, so nothing ever reaches a real server. Time is driven by
// page.clock. When tests/support is merged, swap openApp() for its helpers.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8')
  .replace(/\sintegrity="[^"]*"/g, ''); // the stubbed supabase-js would fail SRI
const ORIGIN = 'https://stagetimer.test';
const ANON_PREFIX = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbWpwc3F1aGR6eHZzeW1sZHBxIiwicm9sZSI6ImFub24i';
const SUPA_STUB = `window.supabase={createClient(){const ch={on(){return ch},subscribe(){return ch}};return{
  auth:{onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}},getSession:async()=>({data:{session:null}}),
        setSession:async()=>({data:{session:null}}),signOut:async()=>({}),refreshSession:async()=>({data:{session:null}})},
  channel(){return ch},removeChannel(){},
  from(){const q={select(){return q},eq(){return q},then(r){r({data:[],error:null})}};return q}}}};`;

function project(data) {
  return {
    id: 'P1', name: 'Test', company_id: 'C1',
    data: Object.assign({
      stages: [{ id: 's1', name: 'Main' }, { id: 's2', name: 'Second' }],
      days: [{ id: 'd1', name: 'Friday', date: '2026-06-19' }, { id: 'd2', name: 'Saturday', date: '2026-06-20' }],
      // The operator is browsing another stage + day: share links must ignore that.
      activeStage: 's2', activeDay: 'd2', timerMode: 'live', fohNotes: {},
      shows: [
        { id: 'a', stage: 's1', day: 'd1', artist: 'Alpha', date: '2026-06-19', start: '22:00:00', end: '23:00:00', startsAt: '2026-06-19T22:00:00', endsAt: '2026-06-19T23:00:00' },
        { id: 'c', stage: 's1', day: 'd1', artist: 'Cancelled', date: '2026-06-19', start: '23:00:00', end: '23:30:00', cancelled: true },
        { id: 'b', stage: 's1', day: 'd1', artist: 'Bravo', date: '2026-06-19', start: '23:30:00', end: '01:30:00' },
        { id: 'h', stage: 's1', day: 'd2', artist: 'Hidden', date: '2026-06-20', start: '20:00:00', end: '21:00:00', hidden: true },
        { id: 'd', stage: 's1', day: 'd2', artist: 'Delta', date: '2026-06-20', start: '21:00:00', end: '22:00:00' },
      ],
    }, data || {}),
  };
}

// Opens a share link at a fixed festival time. opts.rpc: 'ok' | 'missing' | '500' | 'hold'.
async function openApp(browser, { mode = 'stage', at, data, rpc = 'ok', timezoneId = 'Europe/Amsterdam', query = '&sid=s1' }) {
  const context = await browser.newContext({ serviceWorkers: 'block', timezoneId, viewport: { width: 1280, height: 720 } });
  if (context.routeWebSocket) await context.routeWebSocket(/.*/, ws => ws.close());
  const page = await context.newPage();
  const st = { rpc: 0, legacy: 0, nonAnon: 0, unexpected: [], held: [], errors: [] };
  page.on('pageerror', e => st.errors.push(e.message));
  await page.clock.install({ time: new Date(at) });
  const body = JSON.stringify(project(data));
  await context.route('**/*', async route => {
    const req = route.request(), u = req.url();
    if (u.startsWith(ORIGIN + '/app.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: APP_HTML });
    if (u.includes('/vendor/supabase.js') || u.includes('supabase-js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPA_STUB });
    if (u.includes('/rpc/get_shared_project')) {
      st.rpc++;
      if (!(req.headers()['authorization'] || '').includes(ANON_PREFIX)) st.nonAnon++;
      if (rpc === 'missing') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202","message":"Could not find the function public.get_shared_project(p_id) in the schema cache"}' });
      if (rpc === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
      if (rpc === 'hold' && st.rpc > 2) { st.held.push(route); return; } // early fetch + load answer, polls hang
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    if (u.includes('/rest/v1/projects?id=eq.P1')) { st.legacy++; return route.fulfill({ status: 200, contentType: 'application/json', body: '[' + body + ']' }); }
    if (u.includes('/rest/v1/') && req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { date: new Date(at).toUTCString() }, body: '' });
    if (!u.startsWith(ORIGIN) && !u.startsWith('https://bamjpsquhdzxvsymldpq.supabase.co/')) st.unexpected.push(u);
    return route.fulfill({ status: 404, body: '' });
  });
  // A kiosk that was once logged in: an expired user token is still stored.
  await page.addInitScript(() => localStorage.setItem('st_auth_v1', JSON.stringify({ access_token: 'expired.user.jwt', refresh_token: 'x' })));
  await page.goto(`${ORIGIN}/app.html?mode=${mode}&pid=P1${query}`);
  await page.clock.runFor(2000);
  return { page, context, st };
}
const sv = page => page.evaluate(() => ({
  artist: document.getElementById('sv-artist').textContent,
  cd: document.getElementById('sv-cd').textContent,
  next: document.getElementById('sv-next-name').textContent,
  day: G.activeDay, stage: G.activeStage,
}));

test.describe('Stage View data feed', () => {
  test('own stage + today, live across midnight, cancelled never live', async ({ browser }) => {
    const { page, context, st } = await openApp(browser, { at: '2026-06-19T22:30:00+02:00' });
    expect(await sv(page)).toMatchObject({ artist: 'Alpha', next: 'Bravo', day: 'd1', stage: 's1' });
    // (openApp already ran the clock 2s: it is 22:30:02)
    await page.clock.fastForward(35 * 60e3); await page.clock.runFor(1000); // 23:05:03, cancelled slot
    expect((await sv(page)).artist).toBe('Bravo');           // next up, not "Cancelled"
    await page.clock.fastForward(85 * 60e3); await page.clock.runFor(1000); // 00:30:04
    expect(await sv(page)).toMatchObject({ artist: 'Bravo', cd: '59:56', day: 'd1' });
    expect(st.errors).toEqual([]);
    expect(st.unexpected).toEqual([]);
    await context.close();
  });
  test('hidden shows never reach the next-show fallback', async ({ browser }) => {
    const { page, context } = await openApp(browser, { at: '2026-06-20T02:00:00+02:00' });
    expect(await sv(page)).toMatchObject({ artist: 'Delta' }); // Hidden 20:00 is earlier but hidden
    await context.close();
  });
  test('device time zone does not matter', async ({ browser }) => {
    const { page, context } = await openApp(browser, { at: '2026-06-20T00:30:00+02:00', timezoneId: 'America/New_York' });
    expect(await sv(page)).toMatchObject({ artist: 'Bravo', cd: '59:58' }); // 00:30:02, ends 01:30
    expect(await page.evaluate(() => document.getElementById('sv-clock').textContent)).toBe('00:30:02');
    await context.close();
  });
  test('legacy project without any dates: 07:00 rule', async ({ browser }) => {
    const data = {
      days: [{ id: 'd1', name: 'Day 1' }], activeDay: 'd1', activeStage: 's1',
      shows: [{ id: 'x', stage: 's1', day: 'd1', artist: 'Late', start: '01:00:00', end: '02:00:00' }],
    };
    const { page, context } = await openApp(browser, { at: '2026-06-20T01:30:00+02:00', data });
    expect(await sv(page)).toMatchObject({ artist: 'Late', cd: '29:58' }); // 01:30:02, ends 02:00
    await context.close();
  });
});

test.describe('public poll', () => {
  test('anon key only, one tick loop, one request in flight', async ({ browser }) => {
    const { page, context, st } = await openApp(browser, { at: '2026-06-19T22:30:00+02:00', rpc: 'hold' });
    // The first poll is hanging (held) since openApp's 2s run.
    expect(st.held.length).toBe(1);
    const before = st.rpc;
    await page.clock.runFor(4000);                 // 4 more poll ticks while it hangs
    expect(st.rpc - before).toBe(0);               // none started
    st.held.splice(0).forEach(r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(project()) }));
    expect(st.nonAnon).toBe(0);
    const ticks = await page.evaluate(async () => {
      window.__n = 0; const o = window.updateClock; window.updateClock = function () { window.__n++; return o.apply(this, arguments); };
    }).then(() => page.clock.runFor(1000)).then(() => page.evaluate(() => window.__n));
    expect(ticks).toBe(4);                         // 250ms tick runs once, not twice
    expect(await page.evaluate(() => typeof window.__stLastSyncOk)).toBe('number');
    await context.close();
  });
  test('no rebuild when nothing changed', async ({ browser }) => {
    const { page, context } = await openApp(browser, { mode: 'backstage', at: '2026-06-19T22:30:00+02:00' });
    await page.evaluate(() => { window.__row = document.querySelector('#bs-body .bs-row'); });
    await page.clock.runFor(5000);
    expect(await page.evaluate(() => window.__row === document.querySelector('#bs-body .bs-row'))).toBe(true);
    await context.close();
  });
  test('falls back to the direct read only when the RPC is missing', async ({ browser }) => {
    let r = await openApp(browser, { at: '2026-06-19T22:30:00+02:00', rpc: 'missing' });
    await r.page.clock.runFor(3000);
    expect((await sv(r.page)).artist).toBe('Alpha');
    expect(r.st.rpc).toBe(1);                      // asked once, then remembered
    expect(r.st.legacy).toBeGreaterThan(2);
    await r.context.close();
    r = await openApp(browser, { at: '2026-06-19T22:30:00+02:00', rpc: '500' });
    expect(r.st.legacy).toBe(0);                   // a server error is not "missing"
    await r.context.close();
    r = await openApp(browser, { at: '2026-06-19T22:30:00+02:00' });
    expect(r.st.legacy).toBe(0);
    await r.context.close();
  });
  test('public timeline never shows hidden shows', async ({ browser }) => {
    const { page, context } = await openApp(browser, { mode: 'timeline', at: '2026-06-20T19:30:00+02:00', query: '' });
    const txt = await page.evaluate(() => document.getElementById('tl-content').textContent);
    expect(txt).toContain('Delta');
    expect(txt).not.toContain('Hidden');
    await context.close();
  });
});

test.describe('timer logic in the page', () => {
  test('manual timer: start, pause, corrections, resume, next, reset', async ({ browser }) => {
    const { page, context } = await openApp(browser, { at: '2026-06-19T22:30:00+02:00' });
    const ev = f => page.evaluate(f);
    const rem = () => ev(() => Math.round(mRem() / 1000));
    await ev(() => { G.timerMode = 'manual'; mReset(); });
    expect(await ev(() => M.showId)).toBe('a');    // cues the live show, not the first of the day
    await ev(() => mPP()); await page.clock.runFor(10000);
    expect(await rem()).toBe(3590);
    await ev(() => nudge(60)); expect(await rem()).toBe(3650);
    await ev(() => mPP()); await page.clock.runFor(5000);
    expect(await rem()).toBe(3650);                // paused: no jump, no drift
    await ev(() => nudge(60)); expect(await rem()).toBe(3710); // +1 min = +1 min
    await ev(() => mPP()); await page.clock.runFor(2000);
    expect(await rem()).toBe(3708);
    await ev(() => mNext()); expect(await ev(() => M.showId)).toBe('b'); // skips cancelled
    await ev(() => mStop()); expect(await ev(() => M.state)).toBe('idle');
    await context.close();
  });
  test('one-off timer 23:00-01:00 is live after midnight', async ({ browser }) => {
    const { page, context } = await openApp(browser, { at: '2026-06-20T00:30:00+02:00' });
    const r = await page.evaluate(() => {
      const t = { date: '2026-06-19', start: '23:00:00', end: '01:00:00' };
      return [isOTLive(t), Math.round(otRemSec(t))];
    });
    expect(r).toEqual([true, 1798]); // 00:30:02, ends 01:00
    await context.close();
  });
  test('changing a day date: inherited shows move, own-dated shows stay', async ({ browser }) => {
    const data = {
      shows: [
        { id: 'own', stage: 's1', day: 'd1', artist: 'Own', date: '2026-06-19', start: '22:00:00', end: '23:00:00', startsAt: '2026-06-19T22:00:00', endsAt: '2026-06-19T23:00:00' },
        { id: 'inh', stage: 's1', day: 'd1', artist: 'Inherited', start: '22:00:00', end: '23:00:00' },
      ],
    };
    const { page, context } = await openApp(browser, { at: '2026-06-18T22:30:00+02:00', data });
    const r = await page.evaluate(() => {
      const eff = dayDateChangeEffect('d1', '2026-06-18');
      G.days.find(d => d.id === 'd1').date = '2026-06-18';
      return {
        moved: eff.moved.map(s => s.id), kept: eff.keptOffDay.map(s => s.id),
        liveInh: _showIsLive(G.shows.find(s => s.id === 'inh')), liveOwn: _showIsLive(G.shows.find(s => s.id === 'own')),
      };
    });
    expect(r).toEqual({ moved: ['inh'], kept: ['own'], liveInh: true, liveOwn: false });
    await context.close();
  });
});
