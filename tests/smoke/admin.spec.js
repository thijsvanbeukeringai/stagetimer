// Smoke: platform admin page (super_admin). Edge functions are mocked:
// nothing reaches Stripe, nothing sends a real invite.
const { test, expect } = require('../support/fixtures');

test.use({ stAuth: 'super' });

test('admin page lists companies, users and vouchers', async ({ page, st, backend }) => {
  backend.setFunction('manage-voucher', (body) => (body.action === 'list'
    ? { vouchers: [{ id: 'promo_mock', code: 'FESTIVAL10', active: true, percent_off: 10, duration: 'once', times_redeemed: 0 }] }
    : { ok: true }));
  await st.gotoApp();
  const adminLink = page.locator('#dash-admin-btn, #dash-admin-tab').filter({ visible: true }).first();
  await expect(adminLink).toBeVisible();
  await adminLink.click();
  const admin = page.locator('#admin');
  await expect(admin).toHaveClass(/open/);
  await expect(admin).toContainText('Zomerfeest Events BV');
  await expect(admin).toContainText('Awaiting Activation BV');
  await expect(admin).toContainText('Awaiting activation'); // setup_pending badge
  await expect(admin).toContainText('admin@zomerfeest.test');
  await expect(admin).toContainText('FESTIVAL10');
  expect(backend.functionCalls('manage-voucher')[0].body).toEqual({ action: 'list' });
  // S.2: the explicit column list never contains setup_token, so the secret never leaves the mock.
  for (const r of backend.calls({ path: '/rest/v1/companies' })) expect(r.query.select || '').not.toContain('setup_token');
  const secretSeen = await page.evaluate(() => JSON.stringify(APP).includes('SECRET-SETUP-TOKEN') || (localStorage.getItem('st_app_v1') || '').includes('SECRET-SETUP-TOKEN'));
  expect(secretSeen).toBe(false);
});

test.describe('as company_admin', () => {
  test.use({ stAuth: 'admin' });
  test('admin entry is hidden', async ({ page, st }) => {
    await st.gotoApp();
    await expect(page.locator('#dash-admin-btn')).toBeHidden();
    await expect(page.locator('#dash-admin-tab')).toBeHidden();
  });
});
