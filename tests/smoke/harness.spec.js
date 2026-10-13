// Self-test of the harness: the mock really blocks production, failure
// injection works, and the served tree is the one we think it is.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

test('unmocked hosts are aborted and recorded as violations', async ({ page, st, backend }) => {
  await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main, at: ams(FESTIVAL.dates.d1, '16:00') });
  const res = await page.evaluate(() => fetch('https://example.com/x').then(() => 'reached', () => 'blocked'));
  expect(res).toBe('blocked');
  const res2 = await page.evaluate(() => fetch('https://bamjpsquhdzxvsymldpq.supabase.co/storage/v1/object/x').then(() => 'reached', () => 'blocked'));
  expect(res2).toBe('blocked');
  expect(backend.violations).toHaveLength(2);
  backend.violations.length = 0; // expected in this test only
});

test.describe('logged in', () => {
  test.use({ stAuth: 'admin' });

  test('injected 500 on save turns the sync dot red', async ({ page, st, backend }) => {
    await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') });
    await st.openProject();
    backend.failNext({ method: 'PATCH', path: '/rest/v1/projects', status: 500, json: { message: 'boom' } });
    await page.locator('#blackout-btn').click();
    await expect(page.locator('#sync-dot')).toHaveClass(/err/);
    expect(backend.calls({ method: 'PATCH' }).filter((r) => r.injected)).toHaveLength(1);
  });

  test('unknown column in select returns PostgREST 42703', async ({ page, st }) => {
    await st.gotoApp();
    const r = await page.evaluate(async () => {
      const res = await fetch(`${SUPA_URL}/rest/v1/companies?select=id,nope`, { headers: { apikey: SUPA_KEY } });
      return { status: res.status, body: await res.json() };
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('42703');
  });
});

test('served root is reported by the static server', async ({ request }) => {
  const r = await request.get('/__harness');
  expect((await r.json()).root).toBeTruthy();
});
