// Regression: Check-in screen in the app and the Stage manager screen (in the
// app and as share link mode=stagemanager). Owner request 2026-10-13: mark
// arrivals in the app; a stage-manager screen with the current / next show,
// arrival warnings and the rider (drinks + technical requirements).
//
// Data: the festival seed (tests/support/seed.js) carries show.rider on m2
// (DJ O'Neil, multi-line), m4 (markup that must stay text) and m6.
// Main Stage, Friday: m2 15:30-16:30, m3 17:00-18:15, m4 19:00-20:30, m6 23:00.
//
// Share-link specs run on the default per-mode feed (share-modes.js): checkin
// and stagemanager receive the rider, not the crew (crew shows in the app only).
//
// Screenshots: tests/output/sm/ (gitignored).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const S = FESTIVAL.stages;
const PID = FESTIVAL.projectId;
const FRI = FESTIVAL.dates.d1;
const at = (t) => ams(FRI, t);
const SHOTS = path.join(__dirname, '..', 'output', 'sm');
const shot = async (page, name) => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };
const card = (page, artist) => page.locator('#smv-body .smv-card', { hasText: artist });
const ciRow = (page, artist) => page.locator('.ci-row', { hasText: artist });
const innerText = (loc) => loc.evaluate((e) => e.innerText);
// No sideways scroll on the page or inside the given containers.
async function expectNoOverflow(page, sels) {
  const r = await page.evaluate((sels) => ({
    doc: document.scrollingElement.scrollWidth - window.innerWidth,
    els: sels.map((s) => { const e = document.querySelector(s); return e ? [s, e.scrollWidth - e.clientWidth] : [s, 'missing']; }),
  }), sels);
  expect(r.doc, 'page scrolls sideways').toBeLessThanOrEqual(0);
  for (const [s, d] of r.els) expect(d, `${s} overflows`).toBeLessThanOrEqual(0);
}
const withArrived = (ids, atMs) => ({
  mutate(seed) {
    const p = seed.projects.find((x) => x.id === PID);
    for (const s of p.data.shows) if (ids.includes(s.id)) { s.arrived = true; s.arrivedAt = atMs; }
    return seed;
  },
});

// ── Navigation ────────────────────────────────────────────────────────────
test.describe('navigation', () => {
  test.use({ stAuth: 'admin' });
  test('desktop: Check-in and Stage manager sit with the other views', async ({ page, st }) => {
    await st.gotoApp({ at: at('15:45') });
    await st.openProject();
    const nav = page.locator('#hdr-views');
    await expect(nav.getByRole('button', { name: 'Check-in' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Stage manager' })).toBeVisible();
    for (const w of [1024, 768, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expectNoOverflow(page, ['#hdr-row2']);
      await shot(page, `header-${w}.png`);
    }
    await nav.getByRole('button', { name: 'Check-in' }).click();
    await expect(page.locator('#ci')).toHaveClass(/open/);
    await page.locator('#ci-close-btn').click();
    await expect(page.locator('#ci')).not.toHaveClass(/open/);
    await nav.getByRole('button', { name: 'Stage manager' }).click();
    await expect(page.locator('#smv')).toHaveClass(/open/);
    await expect(page.locator('#smv-title')).toHaveText('Stage manager · Main Stage');
    await page.keyboard.press('Escape');
    await expect(page.locator('#smv')).not.toHaveClass(/open/);
  });

  test('mobile: Check-in in the bottom nav, both in the Views menu', async ({ page, st }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await st.gotoApp({ at: at('15:45') });
    await st.openProject();
    const tab = page.locator('#mob-nav .mob-nav-btn[data-nav="ci"]');
    await expect(tab).toBeVisible();
    await expect(tab).toHaveText('Check-in');
    await expectNoOverflow(page, ['#mob-nav']);
    await tab.click();
    await expect(page.locator('#ci')).toHaveClass(/open/);
    await expect(tab).toHaveClass(/active/);
    await page.locator('#ci-close-btn').click();
    await page.locator('#admin-dd > .hbtn').click();
    const menu = page.locator('#admin-dd .dd-menu');
    await expect(menu.getByRole('button', { name: 'Artist check-in' })).toBeVisible();
    await menu.getByRole('button', { name: 'Stage manager' }).click();
    await expect(page.locator('#smv')).toHaveClass(/open/);
  });
});

// ── Check-in in the app ───────────────────────────────────────────────────
test.describe('check-in in the app', () => {
  test.use({ stAuth: 'admin' });

  test('opens on the active stage and day; arrival saves through the save queue; rider keeps its line breaks', async ({ page, st, backend }) => {
    await st.gotoApp({ at: at('15:45') });
    await st.openProject();
    await page.locator('#hdr-ci-btn').click();
    await expect(page.locator('#ci-ssel')).toHaveValue(S.main);
    await expect(page.locator('.ci-stage-name')).toHaveText(['Main Stage']);
    await expect(page.locator('#ci-dtabs .day-pills button[aria-pressed="true"]')).toHaveText('Vrijdag');

    const row = ciRow(page, "DJ O'Neil");
    await expect(row.locator('.vw-chip')).toHaveText(['Live']);
    await expect(row.locator('.ci-booth')).toHaveText('Booth B');
    await expect(row).toContainText('Not arrived yet');
    const drinks = row.locator('.ci-rider-drinks .ci-rider-v');
    expect(await innerText(drinks)).toBe('6x Club-Mate\nStill water, no ice');
    expect(await innerText(row.locator('.ci-rider-tech .ci-rider-v'))).toBe('2x CDJ-3000 + DJM-900NXS2\nBooth monitor left');
    expect(await drinks.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('pre-wrap');
    // A show without a rider gets no empty rider box.
    await expect(ciRow(page, 'Opening Act').locator('.ci-rider')).toHaveCount(0);

    const btn = row.getByRole('button', { name: 'Mark arrived' });
    const box = await btn.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(56);
    await btn.click();
    await expect(row.locator('.ci-toggle')).toHaveText(/Arrived/);
    await expect(row).toContainText(/Checked in at 15:4\d/);
    await expect.poll(() => backend.project(PID).data.shows.find((s) => s.id === 'm2').arrived).toBe(true);
    expect(typeof backend.project(PID).data.shows.find((s) => s.id === 'm2').arrivedAt).toBe('number');
    // The app saves through its own queue, never the anonymous RPC.
    expect(backend.calls({ path: '/rest/v1/rpc/set_show_arrived' })).toEqual([]);
    // The schedule card follows.
    await page.locator('#ci-close-btn').click();
    await expect(page.locator('.scard .sc-arrived.on')).toHaveCount(1);
  });

  test('search by artist and "All stages"', async ({ page, st }) => {
    await st.gotoApp({ at: at('15:45') });
    await st.openProject();
    await page.locator('#hdr-ci-btn').click();
    await page.locator('#ci-ssel').selectOption('');
    await expect(page.locator('.ci-stage-name')).toHaveText(['Club Stage', 'Main Stage', 'The Tent']);
    await page.locator('#ci-search').fill('tent');
    await expect(page.locator('.ci-row .ci-artist-name')).toHaveText(['Tent Band (legacy)', 'Late Tent']);
    await page.locator('#ci-search').fill('zzz');
    await expect(page.locator('#ci-grid .vw-empty-title')).toHaveText('No artist matches “zzz”');
    await page.locator('#ci-search').fill('');
    await page.locator('#ci-ssel').selectOption(S.tent);
    await expect(page.locator('.ci-stage-name')).toHaveText(['The Tent']);
    // Picking a stage here is the operator's stage choice, like on the other views.
    expect(await st.eval(() => G.activeStage)).toBe(S.tent);
  });

  test('390 and 1440: no sideways scroll', async ({ page, st }) => {
    for (const [w, h] of [[390, 844], [1440, 900]]) {
      await page.setViewportSize({ width: w, height: h });
      if (w === 390) { await st.gotoApp({ at: at('15:45') }); await st.openProject(); }
      await page.evaluate(() => openCI());
      await expect(page.locator('#ci')).toHaveClass(/open/);
      await expectNoOverflow(page, ['#ci-hdr', '#ci-tools', '#ci-body']);
      await shot(page, `checkin-app-${w}.png`);
    }
  });
});

// ── Check-in share link ───────────────────────────────────────────────────
test.describe('check-in share link', () => {
  test('shows the rider, as text', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'checkin', at: at('15:45') });
    await expect(page.locator('#ci-ssel')).toHaveValue('');
    const row = ciRow(page, "DJ O'Neil");
    expect(await innerText(row.locator('.ci-rider-drinks .ci-rider-v'))).toBe('6x Club-Mate\nStill water, no ice');
    const m4 = ciRow(page, 'Headliner Priority');
    await expect(m4.locator('.ci-rider-drinks .ci-rider-v')).toContainText('Champagne <b>Brut</b> & "ice"');
    await expect(m4.locator('.ci-rider-drinks .ci-rider-v')).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(m4.locator('.ci-rider-tech .ci-rider-v')).toContainText('<script>window.__xss=1</script>');
    await expect(page.locator('#ci-grid img, #ci-grid script, #ci-grid .ci-rider b')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    // Search works on the share link too.
    await page.locator('#ci-search').fill('neil');
    await expect(page.locator('.ci-row')).toHaveCount(1);
    for (const w of [390, 1440]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
      await page.locator('#ci-search').fill(w === 390 ? '' : 'neil');
      await expectNoOverflow(page, ['#ci-hdr', '#ci-tools', '#ci-body']);
      await shot(page, `checkin-public-${w}.png`);
    }
  });

  test('a picked day sticks across polls', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'checkin', at: at('15:45') });
    await page.locator('#ci-dtabs .day-pills button', { hasText: 'Zaterdag' }).click();
    await st.advance(3000);
    await expect(page.locator('#ci-grid')).toContainText('Day Two Opener');
    await expect(page.locator('#ci-grid')).not.toContainText("DJ O'Neil");
  });
});

// ── Stage manager share link ──────────────────────────────────────────────
test.describe('stage manager share link', () => {
  test.describe('with an arrived act', () => {
    test.use({ stSeed: withArrived(['m2'], at('14:50').getTime()) });
    test('current show with countdown to its end, next shows with start countdowns, rider', async ({ page, st }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await st.gotoPublic({ mode: 'stagemanager', sid: S.main, at: at('15:45:00.400'), paused: true });
      await expect(page.locator('#smv')).toHaveClass(/open/);
      await expect(page.locator('#smv-ssel')).toBeHidden();
      await expect(page.locator('#smv-close-btn')).toBeHidden();
      const now = page.locator('.smv-col-now .smv-card');
      await expect(now).toHaveCount(1);
      await expect(now.locator('.smv-artist')).toHaveText("DJ O'Neil");
      await expect(now.locator('.smv-cd-lbl')).toHaveText('Ends in');
      await expect(now.locator('.smv-cd')).toHaveText('45:00');
      await expect(now.locator('.smv-booth')).toHaveText('Booth B');
      await expect(now.locator('.smv-time')).toHaveText('15:30–16:30');
      await expect(now.locator('.smv-arr-txt')).toHaveText('Arrived 14:50');
      await expect(now).toHaveClass(/smv-lvl-ok/);
      expect(await innerText(now.locator('.smv-rider-drinks .smv-rider-v'))).toBe('6x Club-Mate\nStill water, no ice');
      expect(await innerText(now.locator('.smv-rider-tech .smv-rider-v'))).toBe('2x CDJ-3000 + DJM-900NXS2\nBooth monitor left');
      // The share link does not receive crew; the app shows it (see below).
      await expect(now.locator('.smv-crew')).toHaveCount(0);

      const next = page.locator('.smv-col-next .smv-card .smv-artist');
      await expect(next).toHaveText(['The <b>html</b> & "Quotes" Band', 'Headliner Priority', 'Night Owl']);
      const m3 = card(page, 'Quotes');
      await expect(m3.locator('.smv-cd-lbl')).toHaveText('Starts in');
      await expect(m3.locator('.smv-cd')).toHaveText('1:15:00');
      await expect(m3.locator('.smv-arr-txt')).toHaveText('Not arrived');
      await expect(m3.locator('.smv-rider-v.none')).toHaveText(['Not specified', 'Not specified']);
      await expect(card(page, 'Night Owl').locator('.smv-rider-tech .smv-rider-v')).toHaveText('Not specified');
      await expect(card(page, 'Night Owl').locator('.smv-rider-drinks .smv-rider-v')).toHaveText('Espresso');
      // Cancelled shows are not on it.
      await expect(page.locator('#smv-body')).not.toContainText('Cancelled Act');

      await page.clock.runFor(2000);
      await expect(now.locator('.smv-cd')).toHaveText('44:58');
      await expect(m3.locator('.smv-cd')).toHaveText('1:14:58');
      await expectNoOverflow(page, ['#smv-hdr', '#smv-body']);
      await shot(page, 'stagemanager-public-1440.png');
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoOverflow(page, ['#smv-hdr', '#smv-body']);
      await shot(page, 'stagemanager-public-390.png');
    });
  });

  test('arrival warnings: amber within 60 min, red within 15 min and once the show started', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'stagemanager', sid: S.main, at: at('15:59:00.400'), paused: true });
    const m3 = card(page, 'Quotes');
    await expect(m3).toHaveClass(/smv-lvl-wait/);
    await expect(m3.locator('.smv-arr-why')).toHaveText('');
    await page.clock.fastForward(2 * 60_000);   // 16:01 - starts in 59 min
    await page.clock.runFor(500);
    await expect(m3).toHaveClass(/smv-lvl-warn/);
    await expect(m3.locator('.smv-arr-why')).toHaveText('Starts within 60 min');
    await expect(m3.locator('.smv-arr-txt')).toHaveText('Not arrived');
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, 'stagemanager-warn-1440.png');
    await page.clock.fastForward(45 * 60_000);  // 16:46 - starts in 14 min, DJ O'Neil finished
    await page.clock.runFor(500);
    await expect(m3).toHaveClass(/smv-lvl-late/);
    await expect(m3.locator('.smv-arr-why')).toHaveText('Starts within 15 min');
    await expect(page.locator('.smv-col-now .smv-idle')).toHaveText('No show on stage right now');
    await shot(page, 'stagemanager-late-1440.png');
    await page.clock.fastForward(15 * 60_000);  // 17:01 - on stage, still not checked in
    await page.clock.runFor(500);
    const now = page.locator('.smv-col-now .smv-card');
    await expect(now.locator('.smv-artist')).toHaveText('The <b>html</b> & "Quotes" Band');
    await expect(now).toHaveClass(/smv-lvl-late/);
    await expect(now.locator('.smv-arr-why')).toHaveText('Show has started');
    await expect(now.locator('.smv-cd-lbl')).toHaveText('Ends in');
  });

  test('marking an arrival uses set_show_arrived and clears the warning', async ({ page, st, backend }) => {
    await st.gotoPublic({ mode: 'stagemanager', sid: S.main, at: at('16:50') });
    const m3 = card(page, 'Quotes');
    await expect(m3).toHaveClass(/smv-lvl-late/);
    await m3.getByRole('button', { name: 'Mark arrived' }).click();
    await expect(m3).toHaveClass(/smv-lvl-ok/);
    await expect(m3.locator('.smv-arr-txt')).toHaveText(/^Arrived 16:5\d$/);
    await expect.poll(() => backend.calls({ path: '/rest/v1/rpc/set_show_arrived' }).length).toBe(1);
    expect(backend.calls({ path: '/rest/v1/rpc/set_show_arrived' })[0].body).toMatchObject({ p_id: PID, p_show_id: 'm3', p_arrived: true });
    expect(backend.project(PID).data.shows.find((s) => s.id === 'm3').arrived).toBe(true);
    expect(backend.calls({ method: 'PATCH' })).toEqual([]);
    await st.advance(2000);
    await expect(page.locator('#smv-body')).not.toContainText('Saving…');
    const btn = m3.locator('.smv-toggle');
    expect((await btn.boundingBox()).height).toBeGreaterThanOrEqual(56);
  });

  test('markup in a rider stays text', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'stagemanager', sid: S.main, at: at('18:30') });
    const m4 = card(page, 'Headliner Priority');
    await expect(m4.locator('.smv-rider-drinks .smv-rider-v')).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(m4.locator('.smv-rider-tech .smv-rider-v')).toContainText('<script>window.__xss=1</script>');
    await expect(page.locator('#smv-body img, #smv-body script, #smv-body .smv-rider b, #smv-body .smv-artist b')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('keeps the screen awake', async ({ page, st }) => {
    await page.addInitScript(() => {
      window.__wl = [];
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async (type) => { window.__wl.push(type); return { addEventListener() {}, release: async () => {} }; } } });
    });
    await st.gotoPublic({ mode: 'stagemanager', sid: S.club, at: at('12:00') });
    await expect(page.locator('#smv-body')).toContainText('Club Opener');
    await expect.poll(() => page.evaluate(() => window.__wl)).toEqual(['screen']);
  });

  test('empty state when the stage has nothing left today', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'stagemanager', sid: S.tent, at: ams(FESTIVAL.dates.d2, '23:59') });
    await expect(page.locator('#smv-body .vw-empty-title')).toHaveText('Programme finished');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoOverflow(page, ['#smv-hdr', '#smv-body']);
    await shot(page, 'stagemanager-empty-390.png');
  });
});

// ── Stage manager in the app ──────────────────────────────────────────────
test.describe('stage manager in the app', () => {
  test.use({ stAuth: 'admin' });
  test('current / next, stage and day pickers, arrival through the save queue', async ({ page, st, backend }) => {
    await st.gotoApp({ at: at('16:10') });
    await st.openProject();
    await page.locator('#hdr-sm-btn').click();
    await expect(page.locator('#smv-ssel')).toHaveValue(S.main);
    const now = page.locator('.smv-col-now .smv-card');
    await expect(now.locator('.smv-artist')).toHaveText("DJ O'Neil");
    await expect(now.locator('.smv-cd')).toHaveText(/^(20|19):\d\d$/);
    await expect(now.locator('.smv-crew-i', { hasText: 'Bram' })).toContainText('On the way');
    await expect(now.locator('.smv-crew-i', { hasText: 'Anna' })).toContainText('On site');
    const m3 = card(page, 'Quotes');
    await expect(m3).toHaveClass(/smv-lvl-warn/);
    await m3.getByRole('button', { name: 'Mark arrived' }).click();
    await expect(m3).toHaveClass(/smv-lvl-ok/);
    await expect.poll(() => backend.project(PID).data.shows.find((s) => s.id === 'm3').arrived).toBe(true);
    expect(backend.calls({ path: '/rest/v1/rpc/set_show_arrived' })).toEqual([]);
    for (const w of [1440, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
      await expectNoOverflow(page, ['#smv-hdr', '#smv-body']);
      await shot(page, `stagemanager-app-${w}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // Another stage, then another day (no countdowns: it is not today).
    await page.locator('#smv-ssel').selectOption(S.tent);
    await expect(page.locator('#smv-title')).toHaveText('Stage manager · The Tent');
    await expect(page.locator('.smv-col-now .smv-artist')).toHaveText('Tent Band (legacy)');
    await page.locator('#smv-dtabs .day-pills button', { hasText: 'Zaterdag' }).click();
    await expect(page.locator('.smv-col-now')).toHaveCount(0);
    await expect(page.locator('.smv-h')).toHaveText('Shows on Zaterdag · Sat 11 Jul');
    await expect(card(page, 'Tent Saturday').locator('.smv-cd-lbl')).toHaveText('Sat 11 Jul');
    await expect(card(page, 'Tent Saturday').locator('.smv-cd')).toHaveText('18:00');
  });
});

// ── Share dialog ──────────────────────────────────────────────────────────
test.describe('share dialog', () => {
  test.use({ stAuth: 'admin' });
  test('lists a Stage manager link per stage that can change check-in', async ({ page, st }) => {
    await st.gotoApp({ at: at('15:45') });
    await page.evaluate((pid) => openShareModal(pid), PID);
    const rows = page.locator('.share-link-row[data-mode="stagemanager"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first().locator('.share-link-label')).toHaveText('Stage manager');
    await expect(rows.first().locator('.share-link-url')).toHaveText(new RegExp(`/app\\.html\\?mode=stagemanager&pid=${PID}&sid=${S.main}$`));
    await expect(rows.first().locator('.share-access')).toHaveText('Can change check-in');
    await expect(page.locator('.share-intro')).toContainText('Stage manager');
    await shot(page, 'share-dialog-1440.png');
  });
});

// Phone check-in shows the drinks, not the technical requirements (Thijs, 24-10).
test('check-in on a phone: drinks yes, technical requirements no', async ({ page, st }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await st.gotoPublic({ mode: 'checkin', at: require('../support/seed').ams('2026-07-10', '16:00') });
  await expect(page.locator('#ci .ci-rider-drinks').first()).toBeVisible();
  await expect(page.locator('#ci .ci-rider-tech').first()).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#ci .ci-rider-tech').first()).toBeVisible();
});
