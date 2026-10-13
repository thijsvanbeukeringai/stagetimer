// Boot without a reachable auth server must keep the stored login.
// Before: _authProbe/_authRefresh returned null on a network error exactly
// like on a rejected token, and init wiped st_auth_v1 -> an operator whose
// venue wifi dropped was thrown back to the login screen.
const { test, expect } = require('../support/fixtures');
const { ams } = require('../support/seed');

test.describe('offline boot', () => {
  test.use({ stAuth: 'admin' });

  test('auth server unreachable: keeps the login and starts from cache', async ({ page, st, backend }) => {
    await st.gotoApp({ at: ams('2026-07-10', '16:00') });   // first visit fills the local cache
    await st.openProject('Zomerfeest 2026');
    const before = await page.evaluate(() => localStorage.getItem('st_auth_v1'));
    expect(before).toBeTruthy();

    for (const path of ['/auth/v1/user', '/auth/v1/token', '/rest/v1/companies', '/rest/v1/app_users', '/rest/v1/projects']) {
      backend.failNext({ path, abort: 'failed', times: 20 });
    }
    await page.reload();

    await expect(page.locator('#login')).not.toHaveClass(/open/);
    await expect(page.locator('#loader')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('st_auth_v1'))).toBe(before);
    // The cached project is still there to work with.
    expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('st_app_v1') || '{}').projects || []).length)).toBeGreaterThan(0);
  });

  test('token rejected by the auth server: wipes it and shows login', async ({ page, st, backend }) => {
    backend.auth.refreshFails = true;
    // Read the seeded token on a same-origin page that doesn't boot the app.
    await page.goto('/manifest.json');
    const tok = await page.evaluate(() => JSON.parse(localStorage.getItem('st_auth_v1')).access_token);
    backend.auth.invalidTokens.add(tok);
    await st.installClock(ams('2026-07-10', '16:00'));
    await page.goto('/app.html');
    await expect(page.locator('#login')).toHaveClass(/open/);
    expect(await page.evaluate(() => localStorage.getItem('st_auth_v1'))).toBeNull();
  });
});
