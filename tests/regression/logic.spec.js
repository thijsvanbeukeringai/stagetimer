// Regression specs for the logic fixes of fix/logic-batch-2026-10-13
// (BOUWPLAN fase 1/4: festival time in the editor, crew pushes via send-push,
// plan enforcement PT402, rls_prep admin RPCs, share-link first load, SW
// update notice, Wall day label, timer photo). Shared fixtures: every
// request goes to the MockBackend, nothing reaches a real server.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const P = FESTIVAL.projectId;
const fieldIds = ['f-start-date', 'f-start-time', 'f-start-sec', 'f-end-date', 'f-end-time', 'f-end-sec'];
const dialogs = page => { const seen = []; page.on('dialog', d => { seen.push(d.message()); d.accept().catch(() => {}); }); return seen; };
const serverShow = (backend, id) => backend.project(P).data.shows.find(s => s.id === id);

// ── 1. Show editor reads / writes festival (Amsterdam) time ─────────────
for (const timezoneId of ['Europe/Amsterdam', 'America/New_York', 'Asia/Tokyo']) {
  test.describe(`show editor on a device in ${timezoneId}`, () => {
    test.use({ stAuth: 'admin', timezoneId });
    test('round trip keeps festival wall time', async ({ page, st, backend }) => {
      await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
      await st.openProject();
      const fields = () => page.evaluate(ids => ids.map(id => document.getElementById(id).value), fieldIds);
      // Existing overnight show: 23:00 -> 01:30 next day, as stored.
      await page.evaluate(() => openDrawer('m6'));
      expect(await fields()).toEqual(['2026-07-10', '23:00', '00', '2026-07-11', '01:30', '00']);
      await page.evaluate(() => saveShow());          // unchanged save: nothing moves
      expect(await page.evaluate(() => G.shows.find(s => s.id === 'm6'))).toMatchObject({
        date: '2026-07-10', start: '23:00:00', end: '01:30:00', startsAt: '2026-07-10T23:00:00', endsAt: '2026-07-11T01:30:00', endsNextDay: true });
      // Edit m3 across midnight, with seconds.
      await page.evaluate(() => {
        openDrawer('m3');
        const set = (id, v) => { document.getElementById(id).value = v; };
        set('f-start-time', '23:30'); set('f-start-sec', '15');
        set('f-end-date', '2026-07-11'); set('f-end-time', '01:15'); set('f-end-sec', '00');
        updDur();
      });
      await expect(page.locator('#dur-txt')).toHaveText('Duration: 1h 44m 45s · ends next day');
      await page.evaluate(() => saveShow());
      await expect.poll(() => serverShow(backend, 'm3').startsAt).toBe('2026-07-10T23:30:15');
      expect(serverShow(backend, 'm3')).toMatchObject({ date: '2026-07-10', start: '23:30:15', end: '01:15:00', endsAt: '2026-07-11T01:15:00', endsNextDay: true });
      // New show on Main / Friday: starts where the last one (m3 now, 23:30) ends, 90 min.
      await page.evaluate(() => { G.activeStage = 'stg-main'; G.activeDay = 'day-fri'; openDrawer(null); });
      expect(await fields()).toEqual(['2026-07-11', '01:15', '00', '2026-07-11', '02:45', '00']);
      // New show on an empty day: the current festival hour.
      await page.evaluate(() => { G.shows = G.shows.filter(s => !(s.stage === 'stg-main' && s.day === 'day-sat')); G.activeDay = 'day-sat'; openDrawer(null); });
      expect((await fields()).slice(0, 3)).toEqual(['2026-07-10', '16:00', '00']);
    });
  });
}

// ── 4 + 6. Wall day label, timer panel photo ────────────────────────────
test.describe('display details', () => {
  test.use({ stAuth: 'admin', timezoneId: 'America/Los_Angeles' });
  test('Wall day label is the festival date west of Greenwich', async ({ page, st }) => {
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
    expect(await page.evaluate(() => [_wvDayLabel({ name: 'Vrijdag', date: '2026-07-10' }), _wvDayLabel({ name: 'Zondag', date: '2026-11-01' })]))
      .toEqual(['Geplande tijden vrijdag — 10 juli', 'Geplande tijden zondag — 1 november']);
  });
  test('timer panel photo: src only assigned when it changes', async ({ page, st }) => {
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });   // m2 (with photo) is live on Main
    await st.openProject();
    await expect(page.locator('#tp-photo-wrap')).toHaveClass(/has-photo/);
    await page.evaluate(() => {
      const img = document.getElementById('tp-photo');
      const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      window.__srcSets = 0;
      Object.defineProperty(img, 'src', { configurable: true, get() { return d.get.call(this); }, set(v) { window.__srcSets++; d.set.call(this, v); } });
    });
    await st.advance(3000);                       // 12 ticks
    expect(await page.evaluate(() => window.__srcSets)).toBe(0);
    await page.evaluate(() => { G.shows.find(s => s.id === 'm2').photo = ''; });
    await st.advance(1000);
    expect(await page.evaluate(() => window.__srcSets)).toBe(1);
    await expect(page.locator('#tp-photo-wrap')).not.toHaveClass(/has-photo/);
  });
});

// ── 2 + 3. Crew pushes through send-push ─────────────────────────────────
test.describe('crew pushes via send-push', () => {
  test.use({ stAuth: 'admin', timezoneId: 'America/New_York',
    stSeed: { mutate(seed) { seed.projects[0].data.memberIds = [FESTIVAL.users.operator.id, FESTIVAL.users.admin.id]; } } });
  test('scheduled from end / endsAt / stage in festival time, user token, never OneSignal directly', async ({ page, st, backend }) => {
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '20:00') });
    await st.openProject();
    await expect.poll(() => backend.functionCalls('send-push').length).toBe(5);
    const calls = backend.functionCalls('send-push');
    // Friday shows that end after 20:10: m4, m6, t3, c1, c2 (After Midnight belongs to Friday).
    // Not: past shows, Cancelled Act (m5), Saturday shows.
    expect(calls.map(c => c.body.show_id).sort()).toEqual(['c1', 'c2', 'm4', 'm6', 't3']);
    const m6 = calls.find(c => c.body.show_id === 'm6');
    expect(m6.headers.authorization).toMatch(/^Bearer /);
    expect(m6.headers.authorization).not.toContain('"role":"anon"');
    expect(m6.body).toEqual({
      project_id: P, show_id: 'm6', include_external_user_ids: [FESTIVAL.users.operator.id, FESTIVAL.users.admin.id],
      headings: { en: 'Night Owl almost finished', nl: 'Night Owl almost finished' },
      contents: { en: 'Night Owl on Main Stage ends at 01:30 - about 10 min left.', nl: 'Night Owl on Main Stage ends at 01:30 - about 10 min left.' },
      send_after: '2026-07-10T23:20:00.000Z',              // 01:20 CEST
    });
    expect(backend.onesignal).toEqual([]);
    expect(await page.evaluate(() => typeof OS_REST_KEY)).toBe('undefined');
  });
  test('function not deployed (404): one operator notice, no retries', async ({ page, st, backend }) => {
    backend.setFunction('send-push', () => ({ status: 404, json: { code: 'NOT_FOUND', message: 'Requested function was not found' } }));
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '20:00') });
    await st.openProject();
    await expect(page.locator('#op-notices')).toContainText('Push is not configured yet');
    expect(backend.functionCalls('send-push').length).toBe(1);
    await page.evaluate(id => openProject(id), P);
    await st.advance(1000);
    await page.waitForTimeout(200);
    expect(backend.functionCalls('send-push').length).toBe(1);
  });
});

// ── 9. Server plan enforcement (PT402) ───────────────────────────────────
const pt402 = (details, message, hint) => ({ status: 402, json: { code: 'PT402', details, message, hint: JSON.stringify(hint) } });
test.describe('server plan enforcement (PT402)', () => {
  test.use({ stAuth: 'admin' });
  test('stage over the plan: removed again, operator told, the other edit saved, tab not stuck', async ({ page, st, backend }) => {
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
    await st.openProject();
    backend.failNext({ method: 'PATCH', path: '/rest/v1/projects', ...pt402('stage_limit_exceeded', 'Your plan includes 3 live stage(s). Remove a stage or upgrade to add more.', { op: 'UPDATE', limit: 3, stages_before: 3, stages_after: 4 }) });
    await page.evaluate(() => { G.stages.push({ id: 'stg-new', name: 'Silent Disco' }); G.shows.find(s => s.id === 'm3').note = 'timing fix'; save(); });
    await expect.poll(() => serverShow(backend, 'm3').note).toBe('timing fix');
    expect(backend.project(P).data.stages.map(s => s.id)).toEqual(['stg-main', 'stg-tent', 'stg-club']);
    await expect.poll(() => page.evaluate(() => [G.stages.length, getSaveState().state])).toEqual([3, 'saved']);
    await expect(page.locator('#op-notices')).toContainText('Your plan includes 3 live stage(s)');
    await expect(page.locator('#op-notices')).toContainText('"Silent Disco"');
    await page.evaluate(() => { G.shows.find(s => s.id === 'm3').note = 'later'; save(); });
    await expect.poll(() => serverShow(backend, 'm3').note).toBe('later');
  });
  test('project insert refused (subscription_required): clear message, nothing added', async ({ page, st, backend }) => {
    const seen = dialogs(page);
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
    backend.failNext({ method: 'POST', path: '/rest/v1/projects', ...pt402('subscription_required', 'This workspace has no active subscription or event pass.', { op: 'INSERT' }) });
    const before = await page.evaluate(() => APP.projects.length);
    await page.evaluate(() => { openProjModal(); document.getElementById('pm-name').value = 'New fest'; return createProject(); });
    await expect(page.locator('#limit-modal-ov')).toHaveClass(/open/);
    await expect(page.locator('#limit-modal-msg')).toHaveText('This workspace has no active subscription or event pass. The project was not created.');
    expect(await page.evaluate(() => APP.projects.length)).toBe(before);
    expect(seen).toEqual([]);
  });
});

// ── 8. Admin writes via the rls_prep RPCs ────────────────────────────────
test.describe('admin writes before RLS (rls_prep RPCs)', () => {
  test.use({ stAuth: 'super' });
  const op = FESTIVAL.users.operator.id;
  const roleOf = (backend, id) => backend.db.app_users.find(u => u.id === id).role;
  test('changeUserRole uses admin_set_user_role', async ({ page, st, backend }) => {
    backend.setRpc('admin_set_user_role', (b, rec, be) => { be.db.app_users.find(u => u.id === b.p_user_id).role = b.p_role; return { json: { ok: true, id: b.p_user_id, role: b.p_role } }; });
    await st.gotoApp();
    await page.evaluate(id => changeUserRole(id, 'company_admin'), op);
    expect(backend.calls({ path: '/rest/v1/rpc/admin_set_user_role' }).map(c => c.body)).toEqual([{ p_user_id: op, p_role: 'company_admin' }]);
    expect(backend.calls({ method: 'PATCH', path: '/rest/v1/app_users' })).toEqual([]);
    expect(roleOf(backend, op)).toBe('company_admin');
  });
  test('changeUserRole falls back to the direct write only while the RPC is missing', async ({ page, st, backend }) => {
    await st.gotoApp();                                   // mock: admin_set_user_role -> 404 PGRST202
    await page.evaluate(id => changeUserRole(id, 'company_admin'), op);
    expect(backend.calls({ path: '/rest/v1/rpc/admin_set_user_role' }).length).toBe(1);
    expect(backend.calls({ method: 'PATCH', path: '/rest/v1/app_users' }).length).toBe(1);
    expect(roleOf(backend, op)).toBe('company_admin');
  });
  test('changeUserRole: a refusal is shown, never retried as a direct write', async ({ page, st, backend }) => {
    const seen = dialogs(page);
    backend.setRpc('admin_set_user_role', () => ({ status: 403, json: { code: '42501', message: 'insufficient privileges to change a user role' } }));
    await st.gotoApp();
    await page.evaluate(id => changeUserRole(id, 'company_admin'), op);
    expect(backend.calls({ method: 'PATCH', path: '/rest/v1/app_users' })).toEqual([]);
    expect(roleOf(backend, op)).toBe('operator');
    expect(seen).toEqual(["Changing the role failed: you don't have permission for this."]);
  });
  test('delCompany uses admin_delete_company, falls back while it is missing', async ({ page, st, backend }) => {
    dialogs(page);
    backend.setRpc('admin_delete_company', (b, rec, be) => { be.db.companies = be.db.companies.filter(c => c.id !== b.p_company_id); return { json: { ok: true, users_detached: 1, projects_detached: 0, deleted: 1 } }; });
    await st.gotoApp();
    await page.evaluate(id => delCompany(id), FESTIVAL.otherCompanyId);
    expect(backend.calls({ path: '/rest/v1/rpc/admin_delete_company' }).map(c => c.body)).toEqual([{ p_company_id: FESTIVAL.otherCompanyId }]);
    expect(backend.calls({ method: 'DELETE' })).toEqual([]);
    expect(await page.evaluate(id => APP.companies.some(c => c.id === id), FESTIVAL.otherCompanyId)).toBe(false);
  });
  test('delCompany without the RPC: the old three requests', async ({ page, st, backend }) => {
    dialogs(page);
    await st.gotoApp();
    await page.evaluate(id => delCompany(id), FESTIVAL.otherCompanyId);
    expect(backend.calls({ method: 'DELETE', path: '/rest/v1/companies' }).length).toBe(1);
    expect(backend.calls({ method: 'PATCH', path: '/rest/v1/app_users' }).length).toBe(1);
    expect(backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).length).toBeGreaterThanOrEqual(1);
  });
});
test.describe('companies before the setup_pending column exists', () => {
  test.use({ stAuth: 'super' });
  test('reads the list without that column, never select=*', async ({ page, st, backend }) => {
    backend.schema.companies = backend.schema.companies.filter(c => c !== 'setup_pending');
    await st.gotoApp();
    await page.evaluate(() => openAdmin());
    await expect.poll(() => backend.calls({ path: '/rest/v1/companies' }).filter(c => c.method === 'GET').length).toBeGreaterThanOrEqual(3);
    for (const c of backend.calls({ path: '/rest/v1/companies' })) {
      expect(c.query.select || '').not.toBe('*');
      expect(c.query.select || '').not.toContain('setup_token');
    }
    expect(await page.evaluate(() => APP.companies.map(c => c.id).sort())).toEqual([FESTIVAL.companyId, FESTIVAL.otherCompanyId].sort());
  });
});
for (const [role, editable] of [['operator', false], ['admin', true]]) {
  test.describe(`workspace settings as ${role}`, () => {
    test.use({ stAuth: role });
    test(`workspace name ${editable ? 'editable' : 'read-only'}`, async ({ page, st }) => {
      await st.gotoApp();
      await page.evaluate(() => renderSettingsPage());
      expect(await page.evaluate(() => [document.getElementById('ws-settings-name').disabled, !!document.querySelector('#ws-settings-body .ws-btn-primary')]))
        .toEqual([!editable, editable]);
    });
  });
}

// ── 10. Service worker update notice ─────────────────────────────────────
const fireSwUpdate = page => page.evaluate(() => {
  window.__applied = 0;
  window.dispatchEvent(new CustomEvent('st:sw-update', { detail: { apply() { window.__applied++; return true; } } }));
});
test.describe('service worker update notice', () => {
  test.describe('control screen', () => {
    test.use({ stAuth: 'admin' });
    test('non-blocking notice, hidden in Stage View, Reload applies', async ({ page, st }) => {
      await st.gotoApp();
      await st.openProject();
      await fireSwUpdate(page);
      await fireSwUpdate(page);                          // announced twice: one notice
      const n = page.locator('#op-notices .op-notice');
      await expect(n).toHaveCount(1);
      await expect(n).toContainText('New version available');
      await page.evaluate(() => openSV());
      await expect(page.locator('#op-notices')).toBeHidden();
      await page.evaluate(() => closeSV());
      await expect(page.locator('#op-notices')).toBeVisible();
      await n.getByRole('button', { name: 'Reload' }).click();
      expect(await page.evaluate(() => window.__applied)).toBe(1);
      await expect(n).toHaveCount(0);
    });
  });
  test('share link (Stage View): no notice', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main });
    await fireSwUpdate(page);
    expect(await page.evaluate(() => [!!document.getElementById('op-notices'), window.__applied])).toEqual([false, 0]);
  });
});

// ── 5. Share link: first fetch fails ─────────────────────────────────────
test.describe('share link first load', () => {
  const RPC = '/rest/v1/rpc/get_shared_project';
  const open = async (page, st) => {
    await page.addInitScript(() => {   // page-clock timestamps of the share-link fetches
      window.__rpcTimes = [];
      const f = window.fetch;
      window.fetch = function (u) { if (String(u).includes('/rpc/get_shared_project')) window.__rpcTimes.push(Date.now()); return f.apply(this, arguments); };
    });
    await st.installClock(ams(FESTIVAL.dates.d1, '16:00'));
    await page.goto(`/app.html?mode=stage&pid=${P}&sid=${FESTIVAL.stages.main}`);
  };
  test('server errors at boot: "Connecting…", backoff, then Stage View as normal', async ({ page, st, backend }) => {
    backend.failNext({ path: RPC, status: 503, times: 2 });   // early fetch + first load
    backend.failNext({ path: RPC, status: 502 });             // retry 1
    backend.failNext({ path: RPC, hang: true });              // retry 2: the client's 8s timeout
    await open(page, st);
    await expect(page.locator('#loader')).toContainText('Connecting…');
    await expect(page.locator('#loader')).not.toContainText('not found');
    for (let t = 0; backend.calls({ path: RPC }).length < 5 && t < 60000; t += 250) { await st.advance(250); await page.waitForTimeout(15); }
    const times = await page.evaluate(() => window.__rpcTimes);
    const gaps = times.slice(1, 5).map((t, i) => t - times[i]);
    // backoff 1s, 2s, then 8s timeout + 4s
    [0, 1000, 2000, 12000].forEach((g, i) => { expect(gaps[i]).toBeGreaterThanOrEqual(g - 50); expect(gaps[i]).toBeLessThanOrEqual(g + 1000); });
    await page.locator('#loader').waitFor({ state: 'hidden' });
    await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
  });
  test('no such project: "Project not found.", no retries', async ({ page, st, backend }) => {
    backend.setRpc('get_shared_project', () => ({ json: null }));
    await open(page, st);
    await expect(page.locator('#loader')).toHaveText('Project not found.');
    await st.advance(10000);
    expect(backend.calls({ path: RPC }).length).toBe(2);   // early fetch + load
  });
});
