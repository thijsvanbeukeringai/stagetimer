// "New stage" next to "New show", and auto fullscreen as a per-device choice.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

// Record fullscreen requests instead of really entering fullscreen.
const recordFullscreen = (page) => page.addInitScript(() => {
  window.__fsCalls = 0;
  const fake = function () { window.__fsCalls++; return Promise.resolve(); };
  Element.prototype.requestFullscreen = fake;
  Element.prototype.webkitRequestFullscreen = fake;
});

test.describe('operator', () => {
  test.use({ stAuth: 'admin' });

  test('New stage sits next to New show and adds a stage', async ({ page, st, backend }) => {
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
    await st.openProject();
    const btn = page.locator('#new-stage-btn');
    await expect(btn).toBeVisible();
    await expect(page.locator('#new-show-btn')).toBeVisible();
    await btn.click();
    await expect(page.locator('#stage-modal-ov')).toBeVisible();
    await expect(page.locator('#sm-name')).toBeFocused();
    await page.locator('#sm-name').fill('Silent Disco');
    await page.locator('#sm-name').press('Enter');
    await expect.poll(() => (backend.project(FESTIVAL.projectId).data.stages || []).map(s => s.name)).toContain('Silent Disco');
  });

  test('New stage is reachable on a phone', async ({ page, st }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
    await st.openProject();
    await page.locator('#new-stage-btn').scrollIntoViewIfNeeded();
    await expect(page.locator('#new-stage-btn')).toBeVisible();
  });

  test('no automatic fullscreen in the app by default; the menu turns it on', async ({ page, st }) => {
    await recordFullscreen(page);
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
    await st.openProject();
    await page.mouse.click(5, 300);
    expect(await page.evaluate(() => window.__fsCalls)).toBe(0);
    expect(await page.evaluate(() => stFullscreen.auto())).toBe(false);
    // Turning it on is remembered for this device and applies on the next load.
    await page.evaluate(() => stFullscreen.setAuto(true));
    await expect(page.locator('[data-fs="auto"] .fs-lbl').first()).toHaveText('Auto fullscreen: On');
    await page.reload();
    await page.mouse.click(5, 300);
    await expect.poll(() => page.evaluate(() => window.__fsCalls)).toBe(1);
    // Manual toggle still works when auto is off.
    await page.evaluate(() => stFullscreen.setAuto(false));
    await page.evaluate(() => { window.__fsCalls = 0; stFullscreen.toggle(); });
    expect(await page.evaluate(() => window.__fsCalls)).toBe(1);
  });
});

test('kiosk share link (Stage View) keeps auto fullscreen on by default', async ({ page, st }) => {
  await recordFullscreen(page);
  await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main, at: ams(FESTIVAL.dates.d1, '16:00') });
  await page.mouse.click(5, 5);
  await expect.poll(() => page.evaluate(() => window.__fsCalls)).toBe(1);
});

test.describe('rename stage', () => {
  test.use({ stAuth: 'admin' });
  test('Manage stages: Rename keeps the stage id (shows and share links stay)', async ({ page, st, backend }) => {
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
    await st.openProject();
    await page.locator('#new-stage-btn').click();
    await page.getByRole('button', { name: 'Rename Main Stage' }).click();
    const d = page.locator('.st-dlg[role="dialog"]');
    await d.locator('input').fill('Mainstage');
    await d.locator('.st-dlg-ft button').last().click();
    await expect.poll(() => backend.project(FESTIVAL.projectId).data.stages.find(s => s.id === FESTIVAL.stages.main).name).toBe('Mainstage');
    expect(backend.project(FESTIVAL.projectId).data.shows.some(s => s.stage === FESTIVAL.stages.main)).toBe(true);
  });
});
