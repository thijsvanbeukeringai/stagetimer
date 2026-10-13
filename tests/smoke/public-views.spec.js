// Smoke: every public share-link view (?mode=...&pid=...[&sid=...]) boots
// anonymously, reads through the get_shared_project RPC and renders.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const S = FESTIVAL.stages;
const MID_SHOW = ams(FESTIVAL.dates.d1, '16:00');

function sharedReads(backend) {
  return backend.calls({ method: 'POST', path: '/rest/v1/rpc/get_shared_project' });
}

test('stage view (booth screen)', async ({ page, st, backend }) => {
  await st.gotoPublic({ mode: 'stage', sid: S.main, at: MID_SHOW });
  await expect(page.locator('#sv')).toHaveClass(/open/);
  await expect(page.locator('#sv-top')).toHaveText('Main Stage');
  await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
  await expect(page.locator('#sv-close-btn')).toBeHidden();
  await expect(page.locator('#app')).toBeHidden();
  expect(sharedReads(backend).length).toBeGreaterThan(0);
  // Public views never use table reads.
  expect(backend.calls({ path: /^\/rest\/v1\/(projects|companies|app_users)/ })).toEqual([]);
});

test('stage view picks up operator changes through the 1 s poll', async ({ page, st, backend }) => {
  await st.gotoPublic({ mode: 'stage', sid: S.main, at: MID_SHOW });
  backend.updateProject(FESTIVAL.projectId, (d) => { d.cue = { text: 'STAND BY', color: 'blue', stageId: S.main, sentAt: MID_SHOW.getTime(), durationMs: null }; });
  await st.advance(1500);
  await expect(page.locator('#cue-overlay')).toHaveText('STAND BY');
  await expect(page.locator('#cue-overlay')).toHaveClass(/cue-blue/);
});

test('backstage view', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'backstage', sid: S.main, at: MID_SHOW });
  await expect(page.locator('#bs')).toHaveClass(/open/);
  await expect(page.locator('#bs-sname')).toHaveText('Main Stage');
  await expect(page.locator('#bs')).toContainText("DJ O'Neil");
  await expect(page.locator('#bs-close-btn')).toBeHidden();
});

test('FOH view', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'foh', sid: S.main, at: MID_SHOW });
  await expect(page.locator('#foh')).toHaveClass(/open/);
  await expect(page.locator('#foh-sname')).toHaveText('Main Stage');
  await expect(page.locator('#foh')).toContainText("DJ O'Neil");
  await expect(page.locator('#foh-close-btn')).toBeHidden();
});

test('timeline view', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'timeline', at: MID_SHOW });
  await expect(page.locator('#tl')).toHaveClass(/open/);
  for (const name of ['Main Stage', 'The Tent', 'Club Stage']) await expect(page.locator('#tl')).toContainText(name);
  await expect(page.locator('#tl')).toContainText("DJ O'Neil");
});

test('overview view', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'overview', at: MID_SHOW });
  await expect(page.locator('#stov')).toHaveClass(/open/);
  for (const name of ['Main Stage', 'The Tent', 'Club Stage']) await expect(page.locator('#stov-grid')).toContainText(name);
});

test('control wall view', async ({ page, st, backend }) => {
  backend.serverNow = MID_SHOW;
  await st.gotoPublic({ mode: 'wall', at: MID_SHOW });
  await expect(page.locator('#wv')).toHaveClass(/open/);
  await expect(page.locator('#wv-project')).toContainText('Zomerfeest 2026');
  for (const name of ['Main Stage', 'The Tent', 'Club Stage']) await expect(page.locator('#wv-body')).toContainText(name);
  await expect(page.locator('#wv-body')).toContainText("DJ O'Neil");
  // server clock sync is a HEAD on /rest/v1/
  expect(backend.calls({ method: 'HEAD', path: '/rest/v1/' }).length).toBeGreaterThan(0);
});

test('check-in view marks an artist arrived through the RPC', async ({ page, st, backend }) => {
  await st.gotoPublic({ mode: 'checkin', at: MID_SHOW });
  await expect(page.locator('#ci')).toHaveClass(/open/);
  const row = page.locator('.ci-row', { hasText: "DJ O'Neil" });
  await row.getByRole('button', { name: 'Mark arrived' }).click();
  await expect(row.getByRole('button', { name: /Arrived/ })).toBeVisible();
  await expect.poll(() => backend.calls({ method: 'POST', path: '/rest/v1/rpc/set_show_arrived' }).length).toBe(1);
  const call = backend.calls({ path: '/rest/v1/rpc/set_show_arrived' })[0].body;
  expect(call).toMatchObject({ p_id: FESTIVAL.projectId, p_show_id: 'm2', p_arrived: true });
  expect(backend.project(FESTIVAL.projectId).data.shows.find((s) => s.id === 'm2').arrived).toBe(true);
  // The anonymous check-in never writes the projects table directly.
  expect(backend.calls({ method: 'PATCH' })).toEqual([]);
});

test('unknown project id shows "Project not found."', async ({ page, st }) => {
  await st.installClock(MID_SHOW);
  await page.goto('/app.html?mode=stage&pid=does-not-exist&sid=x');
  await expect(page.locator('#loader')).toContainText('Project not found.');
});
