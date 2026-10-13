// Timed FOH notes are cues for front of house: they count down and alert in
// the FOH view only. Backstage shows the show's own note, never those cues,
// and its share link does not even receive them.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const AT = ams('2026-07-10', '16:00');   // DJ O'Neil live on Main, with a timed FOH note

test('public Backstage shows the show note but no FOH cues', async ({ page, st, backend }) => {
  await st.gotoPublic({ mode: 'backstage', sid: FESTIVAL.stages.main, at: AT });
  await expect(page.locator('#bs-body')).toContainText("Bring O'Neil's USB backup");
  await expect(page.locator('#bs-body')).not.toContainText('Extra monitor for DJ O');
  const shared = backend.calls({ path: '/rest/v1/rpc/get_shared_project' }).filter(c => c.body && c.body.p_mode === 'backstage');
  expect(shared.length).toBeGreaterThan(0);
});

test('public FOH still shows the timed cue', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'foh', sid: FESTIVAL.stages.main, at: AT });
  await expect(page.locator('#foh')).toContainText('Extra monitor for DJ O');
});

test.describe('operator', () => {
  test.use({ stAuth: 'admin' });
  test('in-app Backstage has no FOH cues', async ({ page, st }) => {
    await st.gotoApp({ at: AT });
    await st.openProject();
    await page.evaluate(() => openBS());
    await expect(page.locator('#bs-body')).toContainText("Bring O'Neil's USB backup");
    await expect(page.locator('#bs-body')).not.toContainText('Extra monitor for DJ O');
  });
});
