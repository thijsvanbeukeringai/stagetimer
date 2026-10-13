// BOUWPLAN fase 2 + 3.1/3.2: the operator control screen on phone, tablet and
// desktop. Layout guards (nothing off-screen, schedule not 0px high), the save
// status, naming, zoom, label sizes and touch targets.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const MID_SHOW = ams(FESTIVAL.dates.d1, '16:00');
test.use({ stAuth: 'admin' });

async function open(st) {
  await st.gotoApp({ at: MID_SHOW });
  await st.openProject();
}
const visibleBox = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
});

test.describe('phone 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('compact timer on top, schedule in view and scrollable', async ({ page, st }) => {
    await open(st);
    const firstCard = page.locator('#slist .scard').first();
    await expect(firstCard).toBeVisible();
    const card = await visibleBox(firstCard);
    expect(card.y).toBeLessThan(card.vh - 120);            // above the bottom nav, no scrolling needed
    const timer = await visibleBox(page.locator('#tinner'));
    expect(timer.h).toBeLessThan(220);                     // compact, not the whole screen
    // One scroll container: scrolling it keeps the timer pinned and moves the schedule.
    await page.locator('#body').evaluate((b) => { b.scrollTop = 600; });
    expect((await visibleBox(page.locator('#tinner'))).y).toBeCloseTo(timer.y, 0);
    expect(await page.locator('#body').evaluate((b) => b.scrollTop)).toBeGreaterThan(0);
  });

  test('extra controls fold away but stay reachable', async ({ page, st, backend }) => {
    await open(st);
    await expect(page.locator('#cue-panel')).toBeHidden();
    await expect(page.locator('#ctrl-summary')).toContainText('Stage View: Countdown');
    await page.locator('#ctrl-toggle').click();
    await expect(page.locator('#ctrl-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'WRAP UP' }).click();
    await expect(page.locator('#ctrl-summary')).toContainText('Cue: WRAP UP');
    await expect.poll(() => backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).length).toBeGreaterThan(0);
  });

  test('project settings, Overview and account in the gear menu', async ({ page, st }) => {
    await open(st);
    await expect(page.locator('#hdr-proj-name')).toHaveText('Zomerfeest 2026');
    await expect(page.locator('#save-status')).toContainText('Saved');
    await page.getByRole('button', { name: 'Project settings' }).click();
    const menu = page.locator('#admin-dd .dd-menu');
    for (const name of ['Manage stages', 'Manage days', 'Manage crew', 'Import lineup', 'Overview (all stages)', 'All projects', 'Log out']) {
      await expect(menu.getByRole('button', { name })).toBeVisible();
    }
    await expect(menu.getByRole('button', { name: 'Platform admin' })).toBeHidden(); // company admin, not super admin
    await menu.getByRole('button', { name: 'Overview (all stages)' }).click();
    await expect(page.locator('#stov')).toHaveClass(/open/);
  });

  test('touch targets are at least 44px', async ({ page, st }) => {
    await open(st);
    await page.locator('#ctrl-toggle').click();
    const small = await page.evaluate(() => [...document.querySelectorAll('#app button, #app select')]
      .filter((b) => b.offsetParent && getComputedStyle(b).visibility !== 'hidden')
      .map((b) => ({ t: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 30), h: b.getBoundingClientRect().height }))
      .filter((b) => b.h < 44));
    expect(small).toEqual([]);
  });
});

for (const vp of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1024, height: 600 }, { width: 844, height: 390 }]) {
  test(`header fits at ${vp.width}x${vp.height}: every view button on screen`, async ({ page, st }) => {
    await page.setViewportSize(vp);
    await open(st);
    for (const id of ['#hdr-bs-btn', '#hdr-foh-btn', '#hdr-sv-btn', '#hdr-tl-btn', '#hdr-ov-btn', '#admin-dd > button', '#save-status', '#stage-sel']) {
      const b = await visibleBox(page.locator(id));
      expect(b.w, id).toBeGreaterThan(0);
      expect(b.right, id).toBeLessThanOrEqual(vp.width);
      expect(b.x, id).toBeGreaterThanOrEqual(0);
    }
    // The schedule gets real height next to the timer panel.
    expect((await visibleBox(page.locator('#slist'))).h).toBeGreaterThan(150);
  });
}

test.describe('desktop 1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('order project > stage > day > views, names', async ({ page, st }) => {
    await open(st);
    const x = async (sel) => (await visibleBox(page.locator(sel))).x;
    const proj = await x('#hdr-proj'), stage = await x('#stage-sel'), day = await x('#day-dd'), views = await x('#hdr-views');
    expect(proj).toBeLessThan(stage);
    expect(stage).toBeLessThan(day);
    expect((await visibleBox(page.locator('#hdr-views'))).y).toBeGreaterThan((await visibleBox(page.locator('#day-dd'))).y);
    expect(views).toBeGreaterThanOrEqual(0);
    await expect(page.locator('#day-dd-label')).toContainText('Vrijdag ·');           // day name + date
    await page.getByRole('button', { name: 'Project settings' }).click();
    await expect(page.locator('#admin-dd .dd-menu')).toContainText('Project settings');
    await expect(page.locator('#hdr').getByText('Admin', { exact: true })).toHaveCount(0);
  });

  test('save status shows saving / not saved with the reason', async ({ page, st, backend }) => {
    await open(st);
    const pill = page.locator('#save-status');
    await expect(pill).toHaveText('Saved');
    backend.failNext({ method: 'PATCH', path: '/rest/v1/projects', status: 500, times: 20 });
    await page.locator('#blackout-btn').click();
    await expect(pill).toHaveText('Not saved');
    await expect(page.locator('#sync-dot')).toHaveClass(/err/);   // the old dot still follows
    await pill.click();
    await expect(page.locator('#save-detail')).toContainText(/retried automatically/);
  });

  test('schedule cards: status in words, actions without hover', async ({ page, st }) => {
    await open(st);
    const live = page.locator('#slist .scard', { hasText: "DJ O'Neil" }).first();
    await expect(live.locator('.sc-status')).toHaveText('Now');
    await expect(live.locator('.scard-cd')).toContainText('ends in');
    const edit = live.getByRole('button', { name: /^Edit / });
    expect(Number(await edit.evaluate((b) => getComputedStyle(b.parentElement).opacity))).toBeGreaterThan(0.5);
    await expect(page.locator('#tp-cdlbl')).toHaveText(/remaining/i);
  });

  test('no text below 11px on the control screen', async ({ page, st }) => {
    await open(st);
    const tiny = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#app *')) {
        if (!el.offsetParent || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 11) out.push(`${el.id || el.className} ${fs}px "${el.textContent.trim().slice(0, 20)}"`);
      }
      return out;
    });
    expect(tiny).toEqual([]);
  });
});

test.describe('zoom', () => {
  test('pinch-zoom allowed on the control screen, locked while Stage View is open', async ({ page, st }) => {
    await open(st);
    const meta = () => page.evaluate(() => document.querySelector('meta[name=viewport]').content);
    expect(await meta()).not.toContain('user-scalable');
    await page.locator('#hdr-sv-btn').click();
    expect(await meta()).toBe('width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
    await page.evaluate(() => closeSV());
    expect(await meta()).not.toContain('user-scalable');
  });
});

test('public Stage View link keeps the zoom lock from the first paint', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main, at: MID_SHOW });
  expect(await page.evaluate(() => document.querySelector('meta[name=viewport]').content))
    .toBe('width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
});
