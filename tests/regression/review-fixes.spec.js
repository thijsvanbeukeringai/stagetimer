// Regression tests for the review findings of 2026-10-13 (sync, auth,
// security). One test per fixed bug; every request is mocked.
const { test, expect, openOperator, dlg } = require('./_operator');
const { test: baseTest } = require('../support/fixtures');

const PID = 'proj-fest';
const subOf = (tok) => { try { return JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8')).sub || null; } catch { return null; } };
const rtReady = (backend) => expect.poll(() => backend.realtime.subscriberCount('projects')).toBeGreaterThan(0);

test.describe('stale object after a dialog (realtime update while it is open)', () => {
  test('saveShow: "Save anyway" after a remote update still reaches the server', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    await rtReady(backend);
    await page.evaluate(() => openDrawer('b'));
    await page.fill('#f-start-time', '22:45');
    await page.locator('#dr-save').click();
    const d = dlg(page);
    await expect(d.locator('.st-dlg-title')).toHaveText('This show overlaps another show');
    // Another device edits a different show; loadG() replaces every object in G.
    expect(backend.updateProject(PID, (data) => { data.shows.find((s) => s.id === 'e').artist = 'Echo (other device)'; data._rev = 'foreign-1'; }, { broadcast: true })).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => G.shows.find((s) => s.id === 'e').artist)).toBe('Echo (other device)');
    await d.getByRole('button', { name: 'Save anyway' }).click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    await expect.poll(() => backend.project(PID).data.shows.find((s) => s.id === 'b').start).toBe('22:45:00');
    expect(backend.project(PID).data.shows.find((s) => s.id === 'e').artist).toBe('Echo (other device)');
  });

  test('setDayDate: "Change date" after a remote update still reaches the server', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    await rtReady(backend);
    await page.evaluate(() => { G.shows.push({ id: 'leg', stage: 's1', day: 'd1', artist: 'Legacy', start: '20:00:00', end: '21:00:00' }); save({ immediate: true }); openDayModal(); });
    await expect.poll(() => backend.project(PID).data.shows.some((s) => s.id === 'leg')).toBe(true);
    await page.getByLabel('Date of Friday').fill('2026-06-18');
    const d = dlg(page);
    await expect(d.locator('.st-dlg-title')).toHaveText('Change the date of "Friday"?');
    backend.updateProject(PID, (data) => { data.shows.find((s) => s.id === 'e').artist = 'Echo (other device)'; data._rev = 'foreign-2'; }, { broadcast: true });
    await expect.poll(() => page.evaluate(() => G.shows.find((s) => s.id === 'e').artist)).toBe('Echo (other device)');
    await d.getByRole('button', { name: 'Change date' }).click();
    await expect.poll(() => backend.project(PID).data.days.find((x) => x.id === 'd1').date).toBe('2026-06-18');
  });
});

test.describe('sync', () => {
  test('_refetchProject: a refetch requested while one is in flight is not dropped', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    await rtReady(backend);
    // Change 1 on the server; the GET it triggers answers late with that state.
    backend.updateProject(PID, (data) => { data.shows.find((s) => s.id === 'e').artist = 'One'; data._rev = 'foreign-a'; });
    const snap = JSON.parse(JSON.stringify(backend.project(PID)));
    backend.failNext({ method: 'GET', path: '/rest/v1/projects', url: 'select=id,name,data', delayMs: 1500, status: 200, json: [{ id: snap.id, name: snap.name, data: snap.data }] });
    const gets = () => backend.calls({ method: 'GET', path: '/rest/v1/projects' }).filter((r) => /select=id,name,data/.test(r.url)).length;
    const before = gets();
    // Realtime without the (TOASTed) blob -> the app refetches.
    const noData = () => backend.realtime.push({ table: 'projects', type: 'UPDATE', record: { id: PID, name: snap.name }, old_record: { id: PID } });
    expect(noData()).toBeGreaterThan(0);
    await expect.poll(gets).toBe(before + 1);
    // Change 2 lands while the first GET is still out.
    backend.updateProject(PID, (data) => { data.shows.find((s) => s.id === 'a').artist = 'Two'; data._rev = 'foreign-b'; });
    noData();
    await expect.poll(() => page.evaluate(() => G.shows.find((s) => s.id === 'a').artist), { timeout: 8000 }).toBe('Two');
    expect(await page.evaluate(() => G.shows.find((s) => s.id === 'e').artist)).toBe('One');
  });

  test('delStage: deleting the last stage of an empty project is saved, not refused by the wipe guard', async ({ page, st, backend }) => {
    await openOperator({ page, st }, { open: false });
    await st.openProject('Kleine Clubnacht');
    await page.clock.runFor(500);
    await page.evaluate(() => { delStage('stg-solo'); });
    const d = dlg(page);
    await expect(d.locator('.st-dlg-title')).toHaveText('Delete this stage?');
    await d.getByRole('button', { name: 'Delete stage' }).click();
    await expect.poll(() => backend.project('proj-small').data.stages.length).toBe(0);
    await expect.poll(() => page.evaluate(() => getSaveState().state)).toBe('saved');
    expect(await page.evaluate(() => G.stages.length)).toBe(0);
  });

  test('plan limit (PT402): a refused new stage takes its unsaved shows with it, no orphans', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    backend.failNext({
      method: 'PATCH', path: '/rest/v1/projects', status: 402,
      json: { code: 'PT402', details: 'stage_limit_exceeded', message: 'Your plan includes 2 live stages.', hint: '{"limit":2,"stages_before":2,"stages_after":3}' },
    });
    const res = await page.evaluate(() => importLineup([
      { stage: 'Third', artist: 'New One', start: '2026-06-19T20:00', end: '2026-06-19T21:00' },
      { stage: 'Third', artist: 'New Two', start: '2026-06-19T21:00', end: '2026-06-19T22:00' },
      { stage: 'Main', artist: 'Main Extra', start: '2026-06-20T12:00', end: '2026-06-20T13:00' },
    ]));
    expect(res.error).toBeFalsy();
    await expect(page.locator('#op-notices')).toContainText('with the 2 shows planned on it');
    await expect.poll(() => page.evaluate(() => getSaveState().state)).toBe('saved');
    const data = backend.project(PID).data;
    const stageIds = data.stages.map((s) => s.id);
    expect(stageIds).toEqual(['s1', 's2']);
    expect(data.shows.filter((s) => !stageIds.includes(s.stage))).toEqual([]);
    expect(data.shows.map((s) => s.artist)).toContain('Main Extra');
    expect(await page.evaluate(() => G.shows.filter((s) => !G.stages.some((x) => x.id === s.stage)).length)).toBe(0);
  });
});

// Auth specs boot the full festival seed (no operator adapter needed).
baseTest.describe('auth at boot', () => {
  baseTest.use({ stAuth: 'admin' });

  baseTest('429 / 408 from the auth server keep the stored login', async ({ page, st, backend }) => {
    backend.failNext({ path: '/auth/v1/user', status: 429, times: 50, json: { message: 'rate limited' } });
    backend.failNext({ path: '/auth/v1/token', status: 429, times: 50, json: { message: 'rate limited' } });
    await st.installClock(new Date('2026-07-10T16:00:00+02:00'));
    await page.goto('/app.html');
    await expect(page.locator('#loader')).toBeHidden();
    await expect(page.locator('#login')).not.toHaveClass(/open/);
    expect(await page.evaluate(() => localStorage.getItem('st_auth_v1'))).toBeTruthy();
  });

  baseTest('408 on the refresh after a rejected probe keeps the stored login', async ({ page, st, backend }) => {
    await page.goto('/manifest.json');
    const tok = await page.evaluate(() => JSON.parse(localStorage.getItem('st_auth_v1')).access_token);
    backend.auth.invalidTokens.add(tok);
    backend.failNext({ path: '/auth/v1/token', status: 408, times: 50, json: { message: 'timeout' } });
    await st.installClock(new Date('2026-07-10T16:00:00+02:00'));
    await page.goto('/app.html');
    await expect(page.locator('#loader')).toBeHidden();
    await expect(page.locator('#login')).not.toHaveClass(/open/);
    expect(await page.evaluate(() => localStorage.getItem('st_auth_v1'))).toBeTruthy();
  });

  baseTest('offline boot: re-auth retries on a timer (no online event) and realtime rejoins as the user', async ({ page, st, backend }) => {
    await st.gotoApp({ at: new Date('2026-07-10T16:00:00+02:00') });   // fills the local cache
    await st.openProject('Zomerfeest 2026');
    // Captive portal: everything fails, but navigator.onLine stays true.
    for (const path of ['/auth/v1/user', '/auth/v1/token', '/rest/v1/companies', '/rest/v1/app_users', '/rest/v1/projects']) {
      backend.failNext({ path, status: 503, times: 1000 });
    }
    await page.reload();
    await expect(page.locator('#loader')).toBeHidden();
    await expect(page.locator('#login')).not.toHaveClass(/open/);
    const mark = backend.realtime.messages.length;
    const tokenPosts = () => backend.calls({ method: 'POST', path: '/auth/v1/token' }).filter((r) => !r.injected).length;
    backend.clearFailures();
    const userJoined = () => backend.realtime.messages.slice(mark)
      .some((m) => (m.event === 'phx_join' || m.event === 'access_token') && m.payload && subOf(m.payload.access_token) === 'usr-admin');
    // First retry is due 15 s after boot; drive the fake clock past it.
    for (let i = 0; i < 40 && !(tokenPosts() && userJoined()); i++) {
      await page.clock.runFor(1000);
      await page.waitForTimeout(50);
    }
    expect(tokenPosts()).toBeGreaterThan(0);
    expect(userJoined()).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('st_auth_v1'))).toBeTruthy();
  });
});
