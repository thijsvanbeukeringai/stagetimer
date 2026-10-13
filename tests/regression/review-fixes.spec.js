// Regression tests for the review findings of 2026-10-13 (sync, auth,
// security). One test per fixed bug; every request is mocked.
const { test, expect, openOperator, dlg, projectData } = require('./_operator');
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

test.describe('security: ids from the blob never execute', () => {
  const EVIL = 'x"><img src=x onerror=window.__xss=1>';
  test.use({
    stSeed: { mutate(seed) {
      const data = projectData();
      data.shows.find((s) => s.id === 'b').id = EVIL;
      data.fohNotes = { [EVIL]: [{ id: "n'1", text: 'Check monitor', time: '23:05', color: '#ffe600' }] };
      seed.projects[0].data = data;
      return seed;
    } },
  });

  test('operator list: no execution, notes work, ids are normalised and saved', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    await expect(page.locator('#slist')).toContainText('Bravo');
    await expect(page.locator('#slist')).toContainText('Check monitor');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    // The id got a deterministic safe replacement, references followed it.
    const ids = await page.evaluate(() => G.shows.map((s) => s.id));
    expect(ids).not.toContain(EVIL);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
    const bravo = await page.evaluate(() => G.shows.find((s) => s.artist === 'Bravo').id);
    expect(await page.evaluate((id) => (G.fohNotes[id] || []).map((n) => n.text), bravo)).toEqual(['Check monitor']);
    await expect.poll(() => backend.project(PID).data.shows.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(backend.project(PID).data.shows.length).toBe(4);
    // The note delete button (formerly '${nt.id}') works.
    await page.locator('.foh-note-del').first().click();
    await expect(page.locator('#slist')).not.toContainText('Check monitor');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('share link (FOH): no execution', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'foh', sid: 's1', at: new Date('2026-06-19T22:30:00+02:00') });
    await expect(page.locator('body')).toContainText('Bravo');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('voucher ids in inline handlers are JS-escaped', async ({ page, st }) => {
    await openOperator({ page, st }, { open: false });
    const id = `pr'o"mo<img src=x onerror=window.__xss=1>`;
    await page.evaluate((vid) => {
      window.__args = [];
      window.archiveVoucher = (x) => window.__args.push(['archive', x]);
      window.activateVoucher = (x) => window.__args.push(['activate', x]);
      window.copyVoucherCode = (x) => window.__args.push(['copy', x]);
      document.getElementById('admin').classList.add('open');
      _vouchers = [{ id: vid, code: 'SUMMER', active: true, timesRedeemed: 0, coupon: { percentOff: 10, duration: 'once' } },
        { id: vid, code: 'WINTER', active: false, timesRedeemed: 0, coupon: { percentOff: 10, duration: 'once' } }];
      renderVouchers();
      document.querySelectorAll('#admin-voucher-list button').forEach((b) => b.click());
    }, id);
    expect(await page.evaluate(() => window.__args)).toEqual([['copy', id], ['archive', id], ['copy', id], ['activate', id]]);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

test.describe('companies with column grants (setup_token hidden)', () => {
  test('workspace rename asks for select=id and succeeds', async ({ page, st, backend }) => {
    backend.hiddenColumns = { companies: ['setup_token'] };
    await openOperator({ page, st }, { open: false });
    await page.evaluate(() => { renderSettingsPage(); document.getElementById('ws-settings-name').value = 'Zomerfeest Events'; return saveWorkspaceName('co-fest'); });
    expect(await page.evaluate(() => document.getElementById('ws-settings-status').textContent)).toBe('Saved.');
    expect(backend.table('companies').find((c) => c.id === 'co-fest').name).toBe('Zomerfeest Events');
    const patch = backend.calls({ method: 'PATCH', path: '/rest/v1/companies' }).pop();
    expect(patch.query.select).toBe('id');
  });
  test.describe('as super admin', () => {
    test.use({ stAuth: 'super' });
    test('delete workspace (direct-write fallback) succeeds', async ({ page, st, backend }) => {
      backend.hiddenColumns = { companies: ['setup_token'] };
      await openOperator({ page, st }, { open: false });
      await page.evaluate(() => { delCompany('co-other'); });
      const d = dlg(page);
      await d.getByRole('button', { name: 'Delete workspace' }).click();
      await expect.poll(() => backend.table('companies').some((c) => c.id === 'co-other')).toBe(false);
      const del = backend.calls({ method: 'DELETE', path: '/rest/v1/companies' }).pop();
      expect(del.query.select).toBe('id');
    });
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

const { FESTIVAL: _F, ams: _ams } = require('../support/seed');
// Id normalisation must never touch legitimate legacy ids: share links carry
// the stage id in &sid=, so rewriting e.g. an id with a space or an emoji
// would leave a booth screen blank.
baseTest.describe('legacy stage ids survive id normalisation', () => {
  const LEGACY = 'Main Stage 🎪 #1';
  const relabel = (backend) => backend.updateProject(_F.projectId, (d) => {
    d.stages.forEach(s => { if (s.id === _F.stages.main) s.id = LEGACY; });
    d.shows.forEach(s => { if (s.stage === _F.stages.main) s.stage = LEGACY; });
    if (d.activeStage === _F.stages.main) d.activeStage = LEGACY;
  });
  baseTest('share link with &sid=<legacy id> still shows the live act', async ({ page, st, backend }) => {
    relabel(backend);
    await st.gotoPublic({ mode: 'stage', sid: LEGACY, at: _ams('2026-07-10', '16:00') });
    await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
  });
  baseTest.describe('operator', () => {
    baseTest.use({ stAuth: 'admin' });
    baseTest('opening the project keeps the legacy id (no rewrite, no save)', async ({ page, st, backend }) => {
      relabel(backend);
      await st.gotoApp({ at: _ams('2026-07-10', '16:00') });
      await st.openProject();
      await page.waitForTimeout(500);
      expect(await page.evaluate(id => G.stages.some(s => s.id === id), LEGACY)).toBe(true);
      expect(backend.project(_F.projectId).data.stages.some(s => s.id === LEGACY)).toBe(true);
    });
  });
});
