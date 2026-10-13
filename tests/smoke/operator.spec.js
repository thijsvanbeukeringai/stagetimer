// Smoke: the logged-in operator screens. One test per major screen/function,
// so a refactor that breaks wiring fails loudly. Assertions stay coarse
// (visible + key text + the save reaching the backend); details belong in
// tests/regression.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const PID = FESTIVAL.projectId;
const MID_SHOW = ams(FESTIVAL.dates.d1, '16:00'); // "DJ O'Neil" live on Main Stage

test.use({ stAuth: 'admin' });

/** Last PATCH body sent for the festival project (the full row incl. data). */
function lastSaved(backend) {
  const patches = backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).filter((r) => r.query.id === `eq.${PID}`);
  return patches.length ? patches[patches.length - 1].body : null;
}

test.beforeEach(async ({ st }) => {
  await st.gotoApp({ at: MID_SHOW });
});

test('dashboard lists the workspace projects', async ({ page }) => {
  const grid = page.locator('#proj-grid');
  await expect(grid).toContainText('Zomerfeest 2026');
  await expect(grid).toContainText('Kleine Clubnacht');
  await expect(grid.locator('tr', { hasText: 'Zomerfeest 2026' })).toContainText('15'); // show count
});

test('open project shows the schedule and live timer', async ({ page, st }) => {
  await st.openProject();
  const list = page.locator('#slist');
  await expect(list).toContainText("DJ O'Neil");
  await expect(list).toContainText('Opening Act');
  await expect(list).toContainText('Night Owl');
  // html in artist names is shown as text, never parsed
  await expect(list).toContainText('The <b>html</b> & "Quotes" Band');
  expect(await page.locator('#slist b').count()).toBe(0);
  await expect(page.locator('#tpanel')).toContainText("DJ O'Neil");
});

test('show editor opens, edits and saves to the backend', async ({ page, st, backend }) => {
  await st.openProject();
  const card = page.locator('#slist .scard', { hasText: "DJ O'Neil" }).first();
  await card.hover();
  await card.getByRole('button', { name: /^Edit / }).click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(page.locator('#f-a')).toHaveValue("DJ O'Neil");
  await page.locator('#f-n').fill('Deep House set, bring USB');
  await page.locator('#dr-save').click();
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  await expect.poll(() => lastSaved(backend)?.data?.shows?.find((s) => s.id === 'm2')?.note).toBe('Deep House set, bring USB');
  expect(backend.project(PID).data.shows.find((s) => s.id === 'm2').note).toBe('Deep House set, bring USB');
});

test('new show via the editor is created', async ({ page, st, backend }) => {
  await st.openProject();
  await page.locator('#new-show-btn').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await page.locator('#f-a').fill('Smoke Test Act');
  await page.locator('#dr-save').click();
  await expect(page.locator('#slist')).toContainText('Smoke Test Act');
  await expect.poll(() => (lastSaved(backend)?.data?.shows || []).some((s) => s.artist === 'Smoke Test Act')).toBe(true);
});

test('FOH screen', async ({ page, st }) => {
  await st.openProject();
  await page.locator('#hdr-foh-btn').click();
  await expect(page.locator('#foh')).toHaveClass(/open/);
  await expect(page.locator('#foh-sname')).toHaveText('Main Stage');
  await expect(page.locator('#foh')).toContainText("DJ O'Neil");
  await expect(page.locator('#foh')).toContainText("Extra monitor for DJ O'Neil"); // FOH note
});

test('Backstage screen', async ({ page, st }) => {
  await st.openProject();
  await page.locator('#hdr-bs-btn').click();
  await expect(page.locator('#bs')).toHaveClass(/open/);
  await expect(page.locator('#bs-sname')).toHaveText('Main Stage');
  await expect(page.locator('#bs')).toContainText("DJ O'Neil");
});

test('Stage View (in-app) and display modes', async ({ page, st, backend }) => {
  await st.openProject();
  await page.locator('.dm-btn[data-mode="clock"]').click();
  await expect.poll(() => lastSaved(backend)?.data?.svModes?.[FESTIVAL.stages.main]).toBe('clock');
  await page.locator('.dm-btn[data-mode="countdown"]').click();
  await page.locator('#hdr-sv-btn').click();
  await expect(page.locator('#sv')).toHaveClass(/open/);
  await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
  await expect(page.locator('#sv-cd')).toHaveText(/^\d\d:\d\d$/);
});

test('Timeline screen', async ({ page, st }) => {
  await st.openProject();
  await page.locator('#hdr-tl-btn').click();
  await expect(page.locator('#tl')).toHaveClass(/open/);
  await expect(page.locator('#tl')).toContainText('Main Stage');
  await expect(page.locator('#tl')).toContainText("DJ O'Neil");
});

test('Overview screen', async ({ page, st }) => {
  await st.openProject();
  await page.locator('#hdr-ov-btn').click();
  await expect(page.locator('#stov')).toHaveClass(/open/);
  await expect(page.locator('#stov-grid')).toContainText('Main Stage');
  await expect(page.locator('#stov-grid')).toContainText('The Tent');
  await expect(page.locator('#stov-grid')).toContainText('Club Stage');
});

test('cues, blackout and quick adjust reach the backend', async ({ page, st, backend }) => {
  await st.openProject();
  await page.getByRole('button', { name: 'WRAP UP' }).click();
  await expect.poll(() => lastSaved(backend)?.data?.cue?.text).toBe('WRAP UP');
  await expect(page.locator('#cue-status')).toContainText('WRAP UP');
  await page.locator('#blackout-btn').click();
  await expect.poll(() => lastSaved(backend)?.data?.blackout).toBe(true);
  await page.locator('#blackout-btn').click();
  await expect.poll(() => lastSaved(backend)?.data?.blackout).toBe(false);
  await page.getByRole('button', { name: '+5 min' }).click();
  // The correction shows its preview first; nothing is saved before a choice.
  await page.getByRole('dialog').getByRole('button', { name: /Shift all following shows/ }).click();
  await expect.poll(() => lastSaved(backend)?.data?.shows?.find((s) => s.id === 'm2')?.end).toBe('16:35:00');
});

test('manual timer mode toggles', async ({ page, st }) => {
  await st.openProject();
  await page.locator('#mb-man').click();
  await expect(page.locator('#tbar')).toHaveClass(/vis/);
  await page.locator('#mb-live').click();
  await expect(page.locator('#tbar')).not.toHaveClass(/vis/);
});

test('crew, stage and day management dialogs open', async ({ page, st }) => {
  await st.openProject();
  for (const [item, ov, text] of [
    ['Manage stages', '#stage-modal-ov', 'The Tent'],
    ['Manage crew', '#crew-modal-ov', null],
    ['Manage days', '#day-modal-ov', 'Zaterdag'],
  ]) {
    await page.locator('#admin-dd > button').click();
    await page.locator('#admin-dd').getByRole('button', { name: item }).click();
    await expect(page.locator(ov)).toBeVisible();
    if (text) expect(await page.locator(ov).evaluate((el) => el.innerText + ' ' + [...el.querySelectorAll('input')].map((i) => i.value).join(' '))).toContain(text);
    await page.locator(ov).click({ position: { x: 5, y: 5 } }); // backdrop closes
    await expect(page.locator(ov)).toBeHidden();
  }
});

test('import dialog opens', async ({ page, st }) => {
  await st.openProject();
  await page.locator('#admin-dd > button').click();
  await page.locator('#admin-dd').getByRole('button', { name: 'Import lineup' }).click();
  await expect(page.locator('#json-modal-ov')).toBeVisible();
  await expect(page.locator('#json-input-area')).toBeVisible();
  await page.locator('#json-modal-ov').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#json-modal-ov')).toBeHidden();
});

test('realtime update from another device repaints the schedule', async ({ page, st, backend }) => {
  await st.openProject();
  await expect.poll(() => backend.realtime.subscriberCount('projects')).toBeGreaterThan(0);
  const n = backend.updateProject(PID, (d) => { d.shows.find((s) => s.id === 'm1').artist = 'Renamed Elsewhere'; }, { broadcast: true });
  expect(n).toBeGreaterThan(0);
  await expect(page.locator('#slist')).toContainText('Renamed Elsewhere');
});

test('share-link dialog lists every public URL', async ({ page }) => {
  await page.locator('#proj-grid tr', { hasText: 'Zomerfeest 2026' }).getByTitle('Share links').click();
  const list = page.locator('#share-stage-list');
  await expect(page.locator('#share-ov')).toHaveClass(/open/);
  for (const mode of ['timeline', 'overview', 'checkin', 'wall']) await expect(list).toContainText(`mode=${mode}&pid=${PID}`);
  await expect(list).toContainText(`mode=stage&pid=${PID}&sid=${FESTIVAL.stages.main}`);
  await expect(list).toContainText(`mode=backstage&pid=${PID}&sid=${FESTIVAL.stages.tent}`);
  await expect(list).toContainText(`mode=foh&pid=${PID}&sid=${FESTIVAL.stages.club}`);
});

test('one-off timer can be created from the dashboard', async ({ page }) => {
  await page.getByRole('button', { name: /one-off timer|New timer/i }).filter({ visible: true }).first().click();
  await expect(page.locator('#ot-modal-ov')).toBeVisible();
  await page.locator('#otm-artist').fill('Speech Burgemeester');
  await page.locator('#otm-date').fill(FESTIVAL.dates.d1);
  await page.locator('#otm-start').fill('16:30');
  await page.locator('#otm-end').fill('16:45');
  await page.getByRole('button', { name: 'Save timer' }).click();
  await expect(page.locator('#ot-modal-ov')).toBeHidden();
  await expect(page.locator('#dash')).toContainText('Speech Burgemeester');
});

test('workspace sections: subscription, settings, profile', async ({ page }) => {
  for (const [section, text] of [['subscription', 'Active'], ['settings', 'Workspace'], ['profile', 'Account settings']]) {
    await page.locator(`.ws-sb-link[data-section="${section}"], .ws-tab[data-section="${section}"]`).filter({ visible: true }).first().click();
    await expect(page.locator(`#ws-${section}`)).toBeVisible();
    await expect(page.locator(`#ws-${section}`)).toContainText(text);
  }
});
