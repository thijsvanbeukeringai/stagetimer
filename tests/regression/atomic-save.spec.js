// Atomic save (save_project, migration project_versioning) and soft delete
// (migration project_history_soft_delete), BOUWPLAN 1.1f / 4.5.5 / 4.5.6.
// Both migrations are prepared, not applied: the app must keep the old
// GET+PATCH save and the hard delete while they are missing, and switch over
// by itself once they exist. The mock emulates the migrations only when a
// test enables them (backend.enableProjectVersioning / enableSoftDelete).
const { test, expect, openOperator, dlg } = require('./_operator');
const { AppDriver } = require('../support/fixtures');

const PID = 'proj-fest';
const SMALL = 'proj-small';
const SAVE_RPC = '/rest/v1/rpc/save_project';
const rtReady = (backend) => expect.poll(() => backend.realtime.subscriberCount('projects')).toBeGreaterThan(0);
const patches = (backend) => backend.calls({ method: 'PATCH', path: '/rest/v1/projects' });
const saveCalls = (backend) => backend.calls({ method: 'POST', path: SAVE_RPC });
const artist = (backend, id, pid = PID) => backend.project(pid).data.shows.find((s) => s.id === id).artist;
const edit = (page, id, name) => page.evaluate(([i, n]) => { G.shows.find((s) => s.id === i).artist = n; save({ immediate: true }); }, [id, name]);
const saved = (page) => expect.poll(() => page.evaluate(() => getSaveState().state)).toBe('saved');

test.describe('atomic save: save_project', () => {
  test('a save goes through save_project and the version goes up by one per save', async ({ page, st, backend }) => {
    backend.enableProjectVersioning();
    await openOperator({ page, st });
    const v0 = backend.project(PID).version;
    await edit(page, 'a', 'Alpha 1');
    await expect.poll(() => artist(backend, 'a')).toBe('Alpha 1');
    expect(backend.project(PID).version).toBe(v0 + 1);
    await edit(page, 'b', 'Bravo 1');
    await expect.poll(() => artist(backend, 'b')).toBe('Bravo 1');
    expect(backend.project(PID).version).toBe(v0 + 2);
    await saved(page);
    expect(patches(backend)).toHaveLength(0);
    expect(saveCalls(backend).at(-1).body).toMatchObject({ p_id: PID, p_expected_version: v0 + 1 });
    expect(saveCalls(backend).at(-1).body).not.toHaveProperty('p_force');
    expect(await page.evaluate((pid) => APP.projects.find((p) => p.id === pid).version, PID)).toBe(v0 + 2);
  });

  test('a write that lands between our read and our save comes back as a conflict, is merged, and both edits survive', async ({ page, st, backend }) => {
    backend.enableProjectVersioning();
    await openOperator({ page, st });
    // Another device writes right after our GET: exactly the window GET+PATCH lost.
    let raced = false;
    backend.setRpc('save_project', (body, rec, b) => {
      if (!raced) { raced = true; b.updateProject(PID, (d) => { d.shows.find((s) => s.id === 'e').artist = 'Echo (other device)'; }); }
      return b._rpcSaveProject(body, rec);
    });
    await edit(page, 'a', 'Alpha (here)');
    await expect.poll(() => artist(backend, 'a')).toBe('Alpha (here)');
    expect(artist(backend, 'e')).toBe('Echo (other device)');
    expect(backend.saveConflicts).toBe(1);
    expect(saveCalls(backend)).toHaveLength(2);
    await saved(page);
    expect(await page.evaluate(() => G.shows.find((s) => s.id === 'e').artist)).toBe('Echo (other device)');
  });

  test('two screens saving at the same moment: the later one gets a conflict and keeps both edits', async ({ page, st, backend, context }) => {
    backend.enableProjectVersioning();
    await openOperator({ page, st });
    const page2 = await context.newPage();
    const st2 = new AppDriver(page2, backend);
    st2._clock = true;   // the context already has the fake clock
    await st2.gotoApp();
    await st2.openProject('Zomerfeest 2026');
    // Hold the first screen's save at the server until the second one has saved.
    backend.failNext({ method: 'POST', path: SAVE_RPC, delayMs: 1500 });
    const before = saveCalls(backend).length;
    await edit(page, 'a', 'Alpha (screen 1)');
    await expect.poll(() => saveCalls(backend).length).toBe(before + 1);
    await edit(page2, 'b', 'Bravo (screen 2)');
    await expect.poll(() => artist(backend, 'b')).toBe('Bravo (screen 2)');
    await expect.poll(() => artist(backend, 'a'), { timeout: 8000 }).toBe('Alpha (screen 1)');
    expect(artist(backend, 'b')).toBe('Bravo (screen 2)');
    expect(backend.saveConflicts).toBeGreaterThanOrEqual(1);
    await saved(page);
    await page2.close();
  });

  test('a realtime event that is not newer than our version is ignored; a newer one is applied', async ({ page, st, backend }) => {
    backend.enableProjectVersioning();
    await openOperator({ page, st });
    await rtReady(backend);
    await edit(page, 'a', 'Alpha 1');
    await saved(page);
    const v = backend.project(PID).version;
    await expect.poll(() => page.evaluate((pid) => APP.projects.find((p) => p.id === pid).version, PID)).toBe(v);
    await page.evaluate(() => { window.__adopted = []; const o = _adoptServer; _adoptServer = function (...a) { window.__adopted.push(a[3]); return o.apply(this, a); }; });
    const rec = (mut, version) => { const r = JSON.parse(JSON.stringify(backend.project(PID))); mut(r.data); r.version = version; return r; };
    // A late event (our own echo, or one the save already merged).
    backend.realtime.push({ table: 'projects', type: 'UPDATE', record: rec((d) => { d.shows.find((s) => s.id === 'e').artist = 'Stale'; }, v), old_record: { id: PID } });
    // A genuinely newer write from elsewhere.
    backend.updateProject(PID, (d) => { d.shows.find((s) => s.id === 'c').artist = 'Charlie (elsewhere)'; });
    backend.realtime.push({ table: 'projects', type: 'UPDATE', record: rec(() => {}, v + 1), old_record: { id: PID } });
    await expect.poll(() => page.evaluate(() => G.shows.find((s) => s.id === 'c').artist)).toBe('Charlie (elsewhere)');
    expect(await page.evaluate(() => window.__adopted)).toEqual([v + 1]);
    expect(await page.evaluate(() => G.shows.find((s) => s.id === 'e').artist)).toBe('Echo');
  });

  test('deleting the last stage on purpose passes the server wipe guard with p_force', async ({ page, st, backend }) => {
    backend.enableProjectVersioning();
    await openOperator({ page, st }, { open: false });
    await st.openProject('Kleine Clubnacht');
    await page.clock.runFor(500);
    await page.evaluate(() => { delStage('stg-solo'); });
    await dlg(page).getByRole('button', { name: 'Delete stage' }).click();
    await expect.poll(() => backend.project(SMALL).data.stages.length).toBe(0);
    await saved(page);
    expect(saveCalls(backend).at(-1).body).toMatchObject({ p_id: SMALL, p_force: true });
  });

  test('a would_wipe answer keeps the server version and says so, like the client wipe guard', async ({ page, st, backend }) => {
    backend.enableProjectVersioning();
    await openOperator({ page, st });
    // The server guard is the second line behind the client one; it is hard
    // to reach through the UI, so the answer is simulated.
    backend.setRpc('save_project', (body, rec, b) => ({ json: { ok: false, error: 'would_wipe', version: b.project(PID).version } }));
    await edit(page, 'a', 'Alpha (refused)');
    await expect.poll(() => page.evaluate(() => getSaveState().state)).toBe('unsaved');
    expect(await page.evaluate(() => getSaveState().detail)).toMatch(/server version was kept/);
    expect(artist(backend, 'a')).toBe('Alpha');
    expect(await page.evaluate(() => G.shows.find((s) => s.id === 'a').artist)).toBe('Alpha');
  });
});

test.describe('atomic save: before the migration', () => {
  test('no version column: the old GET+PATCH path, save_project is never called', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    await edit(page, 'a', 'Alpha old path');
    await expect.poll(() => artist(backend, 'a')).toBe('Alpha old path');
    await saved(page);
    expect(saveCalls(backend)).toHaveLength(0);
    expect(patches(backend).length).toBeGreaterThan(0);
  });

  test('version column without save_project: falls back to PATCH once and remembers it', async ({ page, st, backend }) => {
    backend.enableProjectVersioning({ rpc: false });
    await openOperator({ page, st });
    await edit(page, 'a', 'Alpha 1');
    await expect.poll(() => artist(backend, 'a')).toBe('Alpha 1');
    await edit(page, 'b', 'Bravo 1');
    await expect.poll(() => artist(backend, 'b')).toBe('Bravo 1');
    await saved(page);
    expect(saveCalls(backend)).toHaveLength(1);
    expect(patches(backend)).toHaveLength(2);
  });
});

test.describe('soft delete', () => {
  const row = (page, name) => page.locator('#proj-grid tr', { hasText: name });
  const deleted = (page) => page.locator('#dash-deleted');

  test('delete moves a project to Recently deleted, restore brings it back', async ({ page, st, backend }) => {
    backend.enableSoftDelete();
    await openOperator({ page, st }, { open: false });
    await expect(row(page, 'Kleine Clubnacht')).toHaveCount(1);
    await expect(deleted(page)).toBeHidden();
    await row(page, 'Kleine Clubnacht').getByTitle('Delete').click();
    const d = dlg(page);
    await expect(d).toContainText('You can restore it from Recently deleted for 30 days.');
    await d.getByRole('button', { name: 'Delete project' }).click();
    await expect(row(page, 'Kleine Clubnacht')).toHaveCount(0);
    expect(backend.project(SMALL).deleted_at).toBeTruthy();
    expect(backend.calls({ method: 'DELETE', path: '/rest/v1/projects' })).toHaveLength(0);
    await expect(deleted(page)).toBeVisible();
    await expect(deleted(page)).toContainText('Recently deleted');
    await expect(deleted(page)).toContainText('Kleine Clubnacht');
    await expect(deleted(page)).toContainText('restored for 30 days');
    await expect(deleted(page)).toContainText('by admin@zomerfeest.test');
    await deleted(page).getByRole('button', { name: 'Restore Kleine Clubnacht' }).click();
    await expect(row(page, 'Kleine Clubnacht')).toHaveCount(1);
    await expect(deleted(page)).toBeHidden();
    expect(backend.project(SMALL).deleted_at).toBeNull();
  });

  test('probe failed (soft delete unknown): warns as permanent, still soft-deletes when the RPC is there', async ({ page, st, backend }) => {
    backend.enableSoftDelete();
    backend.failNext({ path: '/rest/v1/rpc/list_deleted_projects', status: 500, times: 10 });
    await openOperator({ page, st }, { open: false });
    await row(page, 'Kleine Clubnacht').getByTitle('Delete').click();
    const d = dlg(page);
    await expect(d).toContainText('This cannot be undone.');
    await d.getByRole('button', { name: 'Delete project' }).click();
    await expect(row(page, 'Kleine Clubnacht')).toHaveCount(0);
    expect(backend.project(SMALL).deleted_at).toBeTruthy();
    expect(backend.calls({ method: 'DELETE', path: '/rest/v1/projects' })).toHaveLength(0);
  });

  test('soft-deleted projects are not loaded; a soft delete elsewhere closes the open project', async ({ page, st, backend }) => {
    backend.enableSoftDelete();
    backend.project(SMALL).deleted_at = '2026-06-18T10:00:00.000Z';
    backend.project(SMALL).deleted_by = 'admin@zomerfeest.test';
    await openOperator({ page, st });
    expect(await page.evaluate((id) => APP.projects.some((p) => p.id === id), SMALL)).toBe(false);
    expect(backend.calls({ method: 'GET', path: '/rest/v1/projects' }).some((r) => r.query.deleted_at === 'is.null')).toBe(true);
    await rtReady(backend);
    const rec = { ...JSON.parse(JSON.stringify(backend.project(PID))), deleted_at: '2026-06-19T20:31:00.000Z', version: backend.project(PID).version + 1 };
    backend.realtime.push({ table: 'projects', type: 'UPDATE', record: rec, old_record: { id: PID } });
    await expect.poll(() => page.evaluate((id) => APP.projects.some((p) => p.id === id), PID)).toBe(false);
    await expect(page.locator('#op-notices')).toContainText('This project was deleted');
  });

  test('before the migration: hard delete with the permanent warning, no Recently deleted', async ({ page, st, backend }) => {
    await openOperator({ page, st }, { open: false });
    await row(page, 'Kleine Clubnacht').getByTitle('Delete').click();
    const d = dlg(page);
    await expect(d).toContainText('This cannot be undone.');
    await d.getByRole('button', { name: 'Delete project' }).click();
    await expect(row(page, 'Kleine Clubnacht')).toHaveCount(0);
    expect(backend.project(SMALL)).toBeUndefined();
    expect(backend.calls({ method: 'DELETE', path: '/rest/v1/projects' })).toHaveLength(1);
    await expect(deleted(page)).toBeHidden();
    // The probe ran once and is remembered; no history buttons either.
    expect(backend.calls({ path: '/rest/v1/rpc/list_deleted_projects' })).toHaveLength(1);
    await expect(page.locator('#proj-grid').getByTitle('Version history')).toHaveCount(0);
  });

  test('version history: a company admin puts an earlier copy back', async ({ page, st, backend }) => {
    backend.enableSoftDelete();
    backend.updateProject(PID, (d) => { d.shows.find((s) => s.id === 'a').artist = 'Alpha (bad import)'; });
    await openOperator({ page, st }, { open: false });
    await row(page, 'Zomerfeest 2026').getByTitle('Version history').click();
    const d = dlg(page);
    await expect(d).toContainText('Earlier copies of "Zomerfeest 2026"');
    await d.locator('.st-dlg-opt').first().click();
    const c = dlg(page);
    await expect(c.locator('.st-dlg-title')).toHaveText('Restore this version?');
    await c.getByRole('button', { name: 'Restore version' }).click();
    await expect.poll(() => artist(backend, 'a')).toBe('Alpha');
    await expect.poll(() => page.evaluate((pid) => APP.projects.find((p) => p.id === pid).data.shows.find((s) => s.id === 'a').artist, PID)).toBe('Alpha');
  });
});
