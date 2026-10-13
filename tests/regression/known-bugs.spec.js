// Regression specs for bugs listed in BOUWPLAN.md.
//
// Convention: a bug that is known but NOT fixed yet is written as a real test
// wrapped in test.fail(). While the bug exists the suite stays green; the
// moment someone fixes it, Playwright reports "expected to fail, but passed",
// and the fixer flips test.fail -> test so it guards the fix from then on.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL } = require('../support/seed');

test.describe('BOUWPLAN 1.5', () => {
  test.use({ stAuth: 'admin' });

  test('crew selection is saved (toggleCrewMember called undefined saveProj)', async ({ page, st, backend }) => {
    await st.gotoApp();
    await st.openProject();
    await page.locator('#admin-dd > button').click();
    await page.locator('#admin-dd').getByRole('button', { name: 'Manage crew' }).click();
    await page.locator('#crew-list label', { hasText: 'Anouk Admin' }).locator('input').check();
    await expect.poll(() => {
      const p = backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).pop();
      return p && p.body.data.memberIds;
    }, { timeout: 3000 }).toContain(FESTIVAL.users.admin.id);
  });
});
