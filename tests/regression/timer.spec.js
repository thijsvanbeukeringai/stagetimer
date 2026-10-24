// Regression tests: timer logic + public view data feed.
//
// Runs on the shared harness (tests/support): app.html comes from the static
// server (so BASE_ROOT=<export of an older commit> runs these checks against
// that build), every external request goes to the MockBackend, and the fixture
// fails the test on any unmocked traffic.
//
// Deterministic time: the page boots with its fake clock PAUSED at `at`
// (st.gotoPublic({ paused: true })), and only runFor / fastForward move it.
// Nothing here depends on how fast the machine is: countdowns are read on a
// frozen clock, network answers are awaited on the condition itself (a
// request reaching the mock, a poll being applied), never on a fixed sleep,
// and the HEAD clock-sync is answered with the page's own clock, so the
// server-offset logic always lands on 0 whatever the network latency.
const { test, expect } = require('../support/fixtures');

const PID = 'P1';
const ANON_PREFIX = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbWpwc3F1aGR6eHZzeW1sZHBxIiwicm9sZSI6ImFub24i';
const RPC_PATH = '/rest/v1/rpc/get_shared_project';

function project(data) {
  return {
    id: PID, name: 'Test', company_id: 'C1',
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

// Recorded requests (preflights excluded).
const rpcCalls = (backend) => backend.calls({ method: 'POST', path: RPC_PATH });
const legacyCalls = (backend) => backend.calls({ method: 'GET', path: '/rest/v1/projects' }).filter((r) => r.query.id === `eq.${PID}`);
const pollCalls = (backend) => rpcCalls(backend).length + legacyCalls(backend).length;

// Advance one second - four 250 ms ticks and one public poll - and wait until
// that poll has been answered AND applied, so the next step never finds it
// still in flight (the poll gate would skip it) and counts are exact.
// __stLastSyncOk is Date.now() of the last good poll; on the paused clock
// that equals "now" only once this step's poll is done. A build without that
// global (BASE_ROOT=<older commit>) falls back to "the request reached the mock".
async function pollStep(page, backend) {
  const before = pollCalls(backend);
  await page.clock.runFor(1000);
  await expect.poll(async () => {
    const r = await page.evaluate(() => ('__stLastSyncOk' in window ? window.__stLastSyncOk === Date.now() : null));
    return r === null ? pollCalls(backend) > before : r;
  }, { message: 'the poll of this second was answered and applied' }).toBe(true);
}

// Run fake time in 1 s steps until cond() holds (network answers arrive in
// real time; the app's retry timers need fake time to fire).
async function runUntil(page, cond, message) {
  await expect.poll(async () => {
    if (await cond()) return true;
    await page.clock.runFor(1000);
    return cond();
  }, { message, timeout: 15_000 }).toBe(true);
}

// Opens a share link with the clock frozen at `at`, then runs two seconds
// (two polls, both applied). rpc: 'ok' | 'missing' | '500'.
async function openApp({ page, backend, st }, { mode = 'stage', at, data, rpc = 'ok', sid = 's1' }) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  backend.seed({ projects: [project(data)] });
  st.serverClockFollowsPage();
  if (rpc === 'missing') {
    backend.setRpc('get_shared_project', () => ({ status: 404, json: { code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.get_shared_project(p_id) in the schema cache' } }));
  }
  if (rpc === '500') backend.setRpc('get_shared_project', () => ({ status: 500, json: { message: 'boom' } }));
  // A kiosk that was once logged in: an expired user token is still stored.
  await page.addInitScript(() => localStorage.setItem('st_auth_v1', JSON.stringify({ access_token: 'expired.user.jwt', refresh_token: 'x' })));
  if (rpc === '500') {
    // The project never loads, so there is no rendered view to wait for.
    await st.installClock(at, { paused: true });
    const qs = new URLSearchParams({ mode, pid: PID });
    if (sid) qs.set('sid', sid);
    await page.goto(`/app.html?${qs}`);
    return { errors };
  }
  await st.gotoPublic({ mode, pid: PID, sid, at, paused: true });
  await pollStep(page, backend);
  await pollStep(page, backend);
  return { errors };
}
const sv = (page) => page.evaluate(() => ({
  artist: document.getElementById('sv-artist').textContent,
  cd: document.getElementById('sv-cd').textContent,
  next: document.getElementById('sv-next-name').textContent,
  day: G.activeDay, stage: G.activeStage,
}));

test.use({ viewport: { width: 1280, height: 720 } });

test.describe('Stage View data feed', () => {
  test('own stage + today, live across midnight, cancelled never live', async ({ page, backend, st }) => {
    const { errors } = await openApp({ page, backend, st }, { at: '2026-06-19T22:30:00+02:00' });
    // Soft: each step is its own regression; report all of them.
    expect.soft(await sv(page)).toMatchObject({ artist: 'Alpha', next: 'Bravo', day: 'd1', stage: 's1' });
    // (openApp already ran the clock 2s: it is 22:30:02)
    await page.clock.fastForward(35 * 60e3); await page.clock.runFor(1000); // 23:05:03, cancelled slot
    expect.soft((await sv(page)).artist).toBe('Bravo');      // next up, not "Cancelled"
    await page.clock.fastForward(85 * 60e3); await page.clock.runFor(1000); // 00:30:04
    expect(await sv(page)).toMatchObject({ artist: 'Bravo', cd: '59:56', day: 'd1' });
    expect(errors).toEqual([]);
    // The clock sync ran (on load and after each jump) against a server that
    // agrees with this device: no correction.
    expect(backend.calls({ method: 'HEAD', path: '/rest/v1/' }).length).toBeGreaterThan(0);
    expect(await page.evaluate(() => _clockOffsetMs)).toBe(0);
    // Unmocked traffic fails the test in the backend fixture.
  });
  test('hidden shows never reach the next-show fallback', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { at: '2026-06-20T02:00:00+02:00' });
    expect(await sv(page)).toMatchObject({ artist: 'Delta' }); // Hidden 20:00 is earlier but hidden
  });
  test.describe('in New York', () => {
    test.use({ timezoneId: 'America/New_York' });
    test('device time zone does not matter', async ({ page, backend, st }) => {
      await openApp({ page, backend, st }, { at: '2026-06-20T00:30:00+02:00' });
      expect(await sv(page)).toMatchObject({ artist: 'Bravo', cd: '59:58' }); // 00:30:02, ends 01:30
      expect(await page.evaluate(() => document.getElementById('sv-clock').textContent)).toBe('00:30:02');
    });
  });
  test('legacy project without any dates: 07:00 rule', async ({ page, backend, st }) => {
    const data = {
      days: [{ id: 'd1', name: 'Day 1' }], activeDay: 'd1', activeStage: 's1',
      shows: [{ id: 'x', stage: 's1', day: 'd1', artist: 'Late', start: '01:00:00', end: '02:00:00' }],
    };
    await openApp({ page, backend, st }, { at: '2026-06-20T01:30:00+02:00', data });
    expect(await sv(page)).toMatchObject({ artist: 'Late', cd: '29:58' }); // 01:30:02, ends 02:00
  });
});

test.describe('public poll', () => {
  test('one 250ms tick loop on a share link', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { at: '2026-06-19T22:30:00+02:00' });
    await page.evaluate(() => {
      window.__n = 0; const o = window.updateClock; window.updateClock = function () { window.__n++; return o.apply(this, arguments); };
    });
    await page.clock.runFor(1000);
    expect(await page.evaluate(() => window.__n)).toBe(4); // 250ms tick runs once, not twice
  });
  test('anon key only, one request in flight', async ({ page, backend, st }) => {
    // Count get_shared_project fetches in the page, synchronously as the app
    // starts them: exact after every runFor, no network timing involved.
    await page.addInitScript(() => {
      window.__rpcStarted = 0;
      const f = window.fetch;
      window.fetch = function (input) {
        // Exactly this function: not the one-off get_shared_project_version probe.
        if (/\/rpc\/get_shared_project$/.test(String((input && input.url) || input))) window.__rpcStarted++;
        return f.apply(this, arguments);
      };
    });
    const started = () => page.evaluate(() => window.__rpcStarted);
    let holding = false;
    const held = [];
    backend.setRpc('get_shared_project', () => (holding
      ? new Promise((resolve) => held.push(resolve))
      : { json: project() }));
    await openApp({ page, backend, st }, { at: '2026-06-19T22:30:00+02:00' });

    holding = true;
    const before = await started();
    await page.clock.runFor(1000);                 // next poll starts ...
    expect(await started()).toBe(before + 1);
    await expect.poll(() => held.length, { message: 'the poll reached the mock and hangs' }).toBe(1);
    await page.clock.runFor(4000);                 // 4 more poll ticks while it hangs
    expect(await started()).toBe(before + 1);      // none started
    expect(held.length).toBe(1);

    holding = false;
    held.splice(0).forEach((resolve) => resolve({ json: project() }));
    // The answer is applied: last good sync = now (the frozen release time).
    await expect.poll(() => page.evaluate(() => window.__stLastSyncOk === Date.now())).toBe(true);
    await page.clock.runFor(1000);                 // the gate is free again: exactly one new poll
    expect(await started()).toBe(before + 2);
    await expect.poll(() => rpcCalls(backend).length).toBe(before + 2);

    const rest = backend.calls({ host: 'bamjpsquhdzxvsymldpq.supabase.co' })
      .filter((r) => r.path.startsWith('/rest/v1/') && r.method !== 'OPTIONS');
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.filter((r) => !(r.headers.authorization || '').includes(ANON_PREFIX)).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
  test('no rebuild when nothing changed', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { mode: 'backstage', at: '2026-06-19T22:30:00+02:00' });
    await page.evaluate(() => { window.__row = document.querySelector('#bs-body .lng-hero'); });
    expect(await page.evaluate(() => !!window.__row)).toBe(true);
    for (let i = 0; i < 5; i++) await pollStep(page, backend); // five polls, each answered + applied
    expect(await page.evaluate(() => window.__row === document.querySelector('#bs-body .lng-hero'))).toBe(true);
  });
  test('falls back to the direct read when the RPC is missing', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { at: '2026-06-19T22:30:00+02:00', rpc: 'missing' });
    for (let i = 0; i < 3; i++) await pollStep(page, backend);
    expect((await sv(page)).artist).toBe('Alpha');
    expect(rpcCalls(backend).length).toBe(2);      // each variant (p_id+p_mode, p_id) asked once, then remembered
    expect(legacyCalls(backend).length).toBe(6);   // boot read + one per poll (5 polls)
  });
  test('a server error is not "missing": no direct read', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { at: '2026-06-19T22:30:00+02:00', rpc: '500' });
    // Early fetch, then the first load attempt (it only starts once the early
    // fetch's 500 was handled). Wait until that second 500 was handled too:
    // a retry started, or the screen gave up. A fallback would have read by then.
    const handled = async () => rpcCalls(backend).length >= 3 || (rpcCalls(backend).length === 2
      && await page.evaluate(() => (document.getElementById('loader') || {}).textContent || '').then((t) => t.includes('Project not found')));
    await runUntil(page, handled, 'both 500 answers handled');
    expect(legacyCalls(backend).length).toBe(0);
  });
  test('the RPC working: no direct read', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { at: '2026-06-19T22:30:00+02:00' });
    expect(rpcCalls(backend).length).toBeGreaterThanOrEqual(3); // boot + two polls
    expect(legacyCalls(backend).length).toBe(0);
  });
  test('public timeline never shows hidden shows', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { mode: 'timeline', at: '2026-06-20T19:30:00+02:00', sid: null });
    const txt = await page.evaluate(() => document.getElementById('tl-content').textContent);
    expect(txt).toContain('Delta');
    expect(txt).not.toContain('Hidden');
  });
});

test.describe('timer logic in the page', () => {
  test('manual timer: start, pause, corrections, resume, next, reset', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { at: '2026-06-19T22:30:00+02:00' });
    const ev = (f) => page.evaluate(f);
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
  });
  test('one-off timer 23:00-01:00 is live after midnight', async ({ page, backend, st }) => {
    await openApp({ page, backend, st }, { at: '2026-06-20T00:30:00+02:00' });
    const r = await page.evaluate(() => {
      const t = { date: '2026-06-19', start: '23:00:00', end: '01:00:00' };
      return [isOTLive(t), Math.round(otRemSec(t))];
    });
    expect(r).toEqual([true, 1798]); // 00:30:02, ends 01:00
  });
  test('changing a day date: inherited shows move, own-dated shows stay', async ({ page, backend, st }) => {
    const data = {
      shows: [
        { id: 'own', stage: 's1', day: 'd1', artist: 'Own', date: '2026-06-19', start: '22:00:00', end: '23:00:00', startsAt: '2026-06-19T22:00:00', endsAt: '2026-06-19T23:00:00' },
        { id: 'inh', stage: 's1', day: 'd1', artist: 'Inherited', start: '22:00:00', end: '23:00:00' },
      ],
    };
    await openApp({ page, backend, st }, { at: '2026-06-18T22:30:00+02:00', data });
    const r = await page.evaluate(() => {
      const eff = dayDateChangeEffect('d1', '2026-06-18');
      G.days.find((d) => d.id === 'd1').date = '2026-06-18';
      return {
        moved: eff.moved.map((s) => s.id), kept: eff.keptOffDay.map((s) => s.id),
        liveInh: _showIsLive(G.shows.find((s) => s.id === 'inh')), liveOwn: _showIsLive(G.shows.find((s) => s.id === 'own')),
      };
    });
    expect(r).toEqual({ moved: ['inh'], kept: ['own'], liveInh: true, liveOwn: false });
  });
});
