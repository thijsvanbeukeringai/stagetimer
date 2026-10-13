// Smoke: login boot, session restore, wrong password, password reset, logout.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL } = require('../support/seed');

const U = FESTIVAL.users;

test.describe('anonymous boot', () => {
  test('no stored session shows the login form', async ({ page, st }) => {
    await st.installClock();
    await page.goto('/app.html');
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expect(page.locator('#loader')).toBeHidden();
  });

  test('password login lands on the workspace dashboard', async ({ page, st, backend }) => {
    await st.installClock();
    await page.goto('/app.html');
    await page.locator('#li-email').fill(U.admin.email);
    await page.locator('#li-pw').fill(U.admin.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.locator('#dash.open')).toBeVisible();
    await expect(page.locator('#proj-grid')).toContainText('Zomerfeest 2026');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('st_auth_v1')));
    expect(stored.access_token).toBeTruthy();
    expect(backend.calls({ path: '/auth/v1/token' })[0].query.grant_type).toBe('password');
    // The logged-in REST loads travel on the user's JWT, not the anon key.
    const proj = backend.calls({ method: 'GET', path: '/rest/v1/projects' })[0];
    expect(proj.headers.authorization).toBe(`Bearer ${stored.access_token}`);
  });

  test('wrong password shows an error and stays on login', async ({ page, st }) => {
    await st.installClock();
    await page.goto('/app.html');
    await page.locator('#li-email').fill(U.admin.email);
    await page.locator('#li-pw').fill('nope');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.locator('#login-err')).toContainText('Invalid login credentials');
    await expect(page.locator('#dash')).not.toHaveClass(/open/);
  });

  test('forgot password sends a recover request', async ({ page, st, backend }) => {
    await st.installClock();
    await page.goto('/app.html');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await page.locator('#li-reset-email').fill(U.admin.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.locator('#reset-ok')).toBeVisible();
    await expect.poll(() => backend.calls({ method: 'POST', path: '/auth/v1/recover' }).length).toBe(1);
  });
});

test.describe('returning user', () => {
  test.use({ stAuth: 'admin' });

  test('stored session boots straight into the dashboard', async ({ page, st, backend }) => {
    await st.gotoApp();
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#proj-grid')).toContainText('Kleine Clubnacht');
    expect(backend.calls({ method: 'GET', path: '/auth/v1/user' }).length).toBeGreaterThan(0);
    // S.2 regression: the client never asks for setup_token.
    const asked = backend.calls({ path: '/rest/v1/companies' }).map((r) => r.query.select || '');
    expect(asked.length).toBeGreaterThan(0);
    for (const sel of asked) expect(sel).not.toContain('setup_token');
  });

  test('expired access token is refreshed', async ({ page, st, backend }) => {
    const stale = require('../support/mock-backend').mockJwt(U.admin);
    backend.auth.invalidTokens.add(stale);
    // The refreshed token is the same deterministic JWT, so un-revoke it once
    // the refresh grant has been used.
    const orig = backend._auth.bind(backend);
    backend._auth = (sub, method, url, body, rec) => {
      if (sub === 'token' && url.searchParams.get('grant_type') === 'refresh_token') backend.auth.invalidTokens.clear();
      return orig(sub, method, url, body, rec);
    };
    await st.gotoApp();
    expect(backend.calls({ path: '/auth/v1/token' }).some((r) => r.query.grant_type === 'refresh_token')).toBe(true);
  });

  test('logout clears the stored session', async ({ page, st }) => {
    await st.gotoApp();
    await page.locator('#dash').getByRole('button', { name: /Log out/i }).filter({ visible: true }).first().click();
    await page.waitForURL((u) => !u.pathname.startsWith('/app'));
    const stored = await page.evaluate(() => localStorage.getItem('st_auth_v1'));
    expect(stored).toBeNull();
  });
});
