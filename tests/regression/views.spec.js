// Regression: the control views (FOH, Backstage, Timeline, Overview, Control
// Wall, Check-in) and the share-link dialog - BOUWPLAN 3.5 (briefing §8) and
// B3 (wake lock). Stage View is covered by tests/booth and is not touched here.
//
// Fixture: the festival project gets a lineup built for these views. On
// Friday 22:30 Alpha is live on Main Stage, Foxtrot and Golf overlap in The
// Tent, a cancelled act sits in Main's 23:00 slot and Club Stage only plays on
// Saturday (so the public Overview shows two different days).
//
// Screenshots: VIEWS_SHOTS=<label> also writes every view at 390 / 768 / 1440
// to tests/output/views/<label>/ (gitignored). With BASE_ROOT=<export of an
// older commit> the same run produces the "before" set.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams, show } = require('../support/seed');

const S = FESTIVAL.stages;
const D = FESTIVAL.days;
const FRI = FESTIVAL.dates.d1, SAT = FESTIVAL.dates.d2;
const PID = FESTIVAL.projectId;
const AT = ams(FRI, '22:30');

function viewData() {
  return {
    stages: [
      { id: S.main, name: 'Main Stage' },
      { id: S.tent, name: 'The Tent' },
      { id: S.club, name: 'Club Stage' },
    ],
    days: [{ id: D.d1, name: 'Vrijdag', date: FRI }, { id: D.d2, name: 'Zaterdag', date: SAT }],
    shows: [
      show('e', S.main, D.d1, FRI, '18:00', '19:00', 'Early'),
      show('x', S.main, D.d1, FRI, '20:00', '21:00', 'Hidden act', { hidden: true }),
      show('a', S.main, D.d1, FRI, '21:30', '23:00', 'Alpha', {
        booth: 'A', crew: { light: { name: 'Lou', status: 'present' }, sound: { name: 'Sam', status: 'otw' } },
      }),
      show('c', S.main, D.d1, FRI, '23:00', '23:30', 'Cancelled act', { cancelled: true }),
      show('b', S.main, D.d1, FRI, '23:30', '01:30', "O'Neil <b>bold</b>", { priority: true }),
      show('f', S.tent, D.d1, FRI, '22:00', '23:30', 'Foxtrot'),
      show('g', S.tent, D.d1, FRI, '23:00', '00:00', 'Golf overlaps', { arrived: true, arrivedAt: AT.getTime() - 3600e3 }),
      show('k', S.club, D.d2, SAT, '20:00', '21:00', 'Kilo'),
      show('d', S.main, D.d2, SAT, '21:00', '22:00', 'Delta'),
    ],
    // A note colour that tries to break out of style="" must never load anything.
    fohNotes: { a: [{ id: 'n1', text: 'Mic <check>', time: '22:40', color: '#fff;background-image:url(https://evil.test/x.png)' }] },
    activeStage: S.tent, activeDay: D.d2, timerMode: 'live', memberIds: [], svModes: {}, cue: null, blackout: false,
  };
}
const viewSeed = (patch) => ({
  mutate(seed) {
    const p = seed.projects.find((x) => x.id === PID);
    p.data = viewData();
    if (patch) patch(p.data);
    return seed;
  },
});
test.use({ stSeed: viewSeed() });

// Wake lock stub: records every request and lets a test drop the lock.
const WAKE_STUB = () => {
  window.__wl = [];
  const make = () => {
    const ls = [];
    return { released: false, addEventListener: (t, f) => { if (t === 'release') ls.push(f); }, release: async function () { this.released = true; ls.forEach((f) => f()); }, _fire() { ls.forEach((f) => f()); } };
  };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async (type) => { const s = make(); window.__wl.push({ type, s }); return s; } } });
};

// ── Timeline ──────────────────────────────────────────────────────────────
test.describe('timeline', () => {
  test('desktop: axis and stage labels stay visible while scrolling, overlaps get their own lane', async ({ page, st }) => {
    await page.setViewportSize({ width: 900, height: 260 });
    await st.gotoPublic({ mode: 'timeline', at: AT });
    const sc = page.locator('#tl-scroll');
    await sc.evaluate((el) => { el.scrollLeft = 600; el.scrollTop = 120; });
    const geo = await page.evaluate(() => {
      const sc = document.getElementById('tl-scroll').getBoundingClientRect();
      const ruler = document.querySelector('.tl-ruler').getBoundingClientRect();
      const lbl = [...document.querySelectorAll('.tl-stage-lbl')].map((e) => e.getBoundingClientRect()).find((r) => r.top >= sc.top + 40 && r.bottom <= sc.bottom);
      const hit = document.elementFromPoint(lbl.left + 30, lbl.top + lbl.height / 2);
      return { scTop: sc.top, scLeft: sc.left, rulerTop: ruler.top, lblLeft: lbl.left, lblOnTop: !!hit.closest('.tl-stage-lbl'), scrolled: document.getElementById('tl-scroll').scrollTop };
    });
    expect(geo.scrolled).toBeGreaterThan(0);
    expect(Math.round(geo.rulerTop)).toBe(Math.round(geo.scTop));   // time axis sticks to the top
    expect(Math.round(geo.lblLeft)).toBe(Math.round(geo.scLeft));   // stage names stick to the left
    expect(geo.lblOnTop).toBe(true);                                // not covered by blocks / now line
    await expect(page.locator('#tl-now-lbl')).toBeAttached();       // now time is part of the sticky axis

    const box = (name) => page.locator('.tl-block', { hasText: name }).boundingBox();
    const fox = await box('Foxtrot'), golf = await box('Golf overlaps');
    expect(fox.x + fox.width).toBeGreaterThan(golf.x);              // they do overlap in time...
    expect(fox.y + fox.height <= golf.y || golf.y + golf.height <= fox.y).toBe(true); // ...but not on screen
    await expect(page.locator('.tl-block', { hasText: 'Cancelled act' })).toContainText('Cancelled');
    await expect(page.locator('.tl-block', { hasText: 'Cancelled act' })).toHaveClass(/tl-cancelled/);
    // Shows on a stage without overlaps keep the classic single lane.
    expect((await box('Alpha')).height).toBeGreaterThan(50);
  });

  test('mobile 390: cancelled shows are marked cancelled, never live', async ({ page, st }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await st.gotoPublic({ mode: 'timeline', at: ams(FRI, '23:10') }); // inside the cancelled slot
    const row = page.locator('.tl-m-row', { hasText: 'Cancelled act' });
    await expect(row).toHaveClass(/tl-cancelled/);
    await expect(row.locator('.vw-chip')).toHaveText('Cancelled');
    await expect(row.locator('.vw-live')).toHaveCount(0);
    expect(await row.locator('div', { hasText: /^Cancelled act$/ }).evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('line-through');
    await expect(page.locator('.tl-m-row', { hasText: 'Foxtrot' }).locator('.vw-chip')).toHaveText('Live');
    await expect(page.locator('.tl-m-row', { hasText: 'Early' }).locator('.vw-chip')).toHaveText('Done');
    // hidden shows never reach a share link
    await expect(page.locator('#tl-content')).not.toContainText('Hidden act');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

// ── Overview ──────────────────────────────────────────────────────────────
test('overview names the day per stage when stages show different days', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'overview', at: AT });
  await expect(page.locator('#stov-daylbl')).toHaveText('Stages show different days');
  await expect(page.locator(`#stovname-${S.club} .stov-day`)).toHaveText('Sat 11 Jul');
  await expect(page.locator(`#stovname-${S.main} .stov-day`)).toHaveText('Fri 10 Jul');
  await expect(page.locator(`#stovst-${S.main}`)).toHaveText('Live');
  await expect(page.locator(`#stovst-${S.club}`)).toHaveText('Next · Sat 20:00');
  await expect(page.locator(`#stovname-${S.club} .stov-day`)).toHaveAttribute('title', 'This stage shows Zaterdag · Sat 11 Jul');
  // The chip is readable, not cut off by the stage-name column - also on a phone.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const fits = await page.locator('.stov-day').evaluateAll((els) => els.every((c) => {
      const r = c.getBoundingClientRect(), p = c.parentElement.getBoundingClientRect();
      return r.width > 20 && r.right <= p.right + 0.5 && r.left >= p.left - 0.5;
    }));
    expect(fits, `day chips fit at ${width}`).toBe(true);
  }
});
test.describe('overview, one day for every stage', () => {
  test.use({ stSeed: viewSeed((d) => { d.shows = d.shows.filter((s) => s.stage !== S.club); }) });
  test('the header names the day, cards carry no day chip', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'overview', at: AT });
    await expect(page.locator('#stov-daylbl')).toHaveText('Vrijdag · Fri 10 Jul');
    await expect(page.locator('.stov-day')).toHaveCount(0);
  });
});

// ── Empty states ──────────────────────────────────────────────────────────
const emptyTitle = (page) => page.locator('.vw-empty .vw-empty-title');
async function expectLegible(page) {
  const c = await page.locator('.vw-empty .vw-empty-title').first().evaluate((e) => getComputedStyle(e).color);
  const sub = await page.locator('.vw-empty .vw-empty-sub').first().evaluate((e) => getComputedStyle(e).color);
  for (const col of [c, sub]) {
    const a = /rgba\([^)]*,\s*([\d.]+)\)/.exec(col);
    expect(a ? Number(a[1]) : 1).toBeGreaterThanOrEqual(0.6); // was rgba(255,255,255,.2)
  }
}
test.describe('empty states', () => {
  test('wrong day: a stage that only plays on another day', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'backstage', sid: S.club, at: AT });
    await expect(emptyTitle(page)).toHaveText('No shows on Vrijdag · Fri 10 Jul');
    await expect(page.locator('.vw-empty')).toContainText('Next show: Kilo · Zaterdag · Sat 11 Jul 20:00');
    await expectLegible(page);
  });
  test('programme finished', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'foh', sid: S.main, at: ams(SAT, '02:00') }); // still Friday's festival night
    await expect(emptyTitle(page)).toHaveText('Programme finished');
    await expect(page.locator('.vw-empty')).toContainText('All shows on Vrijdag · Fri 10 Jul are done.');
    await st.gotoPublic({ mode: 'backstage', sid: S.main, at: ams(SAT, '02:00') });
    await expect(emptyTitle(page)).toHaveText('Programme finished');
  });
  test.describe('nothing planned', () => {
    test.use({ stSeed: viewSeed((d) => { d.stages.push({ id: 'stg-empty', name: 'Empty Stage' }); }) });
    test('stage without any show', async ({ page, st }) => {
      await st.gotoPublic({ mode: 'foh', sid: 'stg-empty', at: AT });
      await expect(emptyTitle(page)).toHaveText('No shows planned');
      await expectLegible(page);
    });
  });
  test('load error is not "not found", and it recovers by itself', async ({ page, st, backend }) => {
    backend.failNext({ path: '/rest/v1/rpc/get_shared_project', status: 503, times: 3 });
    await st.installClock(AT);
    await page.goto(`/app.html?mode=overview&pid=${PID}`);
    await expect(page.locator('#loader .vw-empty-title')).toHaveText('Could not load the programme');
    await expect(page.locator('#loader')).not.toContainText('Project not found');
    await st.advance(6000);
    await expect(page.locator('#stov')).toHaveClass(/open/);
    await expect(page.locator('#stov-grid')).toContainText('Main Stage');
  });
});

// ── Stale feed ────────────────────────────────────────────────────────────
test.describe('last sync', () => {
  for (const [mode, sid] of [['backstage', S.main], ['foh', S.main], ['overview'], ['wall'], ['timeline'], ['checkin']]) {
    test(`${mode}: shows "Last sync" only when the feed is stale`, async ({ page, st, backend }) => {
      await st.gotoPublic({ mode, sid, at: AT });
      await st.advance(3000);
      await expect(page.locator('.vw-sync:visible')).toHaveCount(0);
      backend.failNext({ path: '/rest/v1/rpc/get_shared_project', status: 500, times: 1000 });
      await st.advance(13000);
      await expect(page.locator('.vw-sync:visible')).toHaveCount(1);
      await expect(page.locator('.vw-sync:visible')).toHaveText(/^Last sync 1\ds ago$/);
      backend.clearFailures();
      await st.advance(2000);
      await expect(page.locator('.vw-sync:visible')).toHaveCount(0);
    });
  }
  test('never on Stage View', async ({ page, st, backend }) => {
    await st.gotoPublic({ mode: 'stage', sid: S.main, at: AT });
    backend.failNext({ path: '/rest/v1/rpc/get_shared_project', status: 500, times: 1000 });
    await st.advance(15000);
    await expect(page.locator('.vw-sync:visible')).toHaveCount(0);
    await expect(page.locator('#sv .vw-sync')).toHaveCount(0);
  });
});

// ── Same names / labels everywhere, escaped data ──────────────────────────
test('status words and dates are the same on every view; data is text', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'backstage', sid: S.main, at: AT });
  await expect(page.locator('#bs-body .bs-live .bs-badge')).toContainText('Live');
  await expect(page.locator('#bs-body')).toContainText("O'Neil <b>bold</b>");
  expect(await page.locator('#bs-body b').count()).toBe(0);
  await st.gotoPublic({ mode: 'foh', sid: S.main, at: AT });
  await expect(page.locator('.foh-now-lbl')).toContainText('Live · 21:30–23:00');
  await expect(page.locator('#foh-col-body')).toContainText("O'Neil <b>bold</b>");
  await expect(page.locator('#foh-col-body')).toContainText('Mic <check>');
  // crew status says what the icons mean
  await expect(page.locator('.foh-crew-row', { hasText: 'Lou' })).toContainText('On site');
  await expect(page.locator('.foh-crew-row', { hasText: 'Sam' })).toContainText('On the way');
  await expect(page.locator('.foh-crew-row', { hasText: 'Lou' }).getByRole('button', { name: 'Light: On site' })).toHaveAttribute('aria-pressed', 'true');
  // the injected note colour was dropped, not applied
  expect(await page.locator('.foh-note-item').getAttribute('style')).not.toContain('evil');
  await st.gotoPublic({ mode: 'wall', at: AT });
  await expect(page.locator('#wv-day')).toHaveText('Vrijdag · Fri 10 Jul');
  await expect(page.locator(`#wvp-${S.main}`)).toHaveText('Live');
  await expect(page.locator('#wv-body')).toContainText("O'Neil <b>bold</b>");
  expect(await page.locator('#wv-body b').count()).toBe(0);
});

// ── No rebuild when nothing changed ───────────────────────────────────────
test('overview, wall, FOH and backstage keep their DOM across poll refreshes', async ({ page, st }) => {
  for (const [mode, sid, sel] of [['overview', null, `#stovc-${S.main}`], ['wall', null, `#wvc-${S.main}`], ['foh', S.main, '.foh-srow'], ['backstage', S.main, '#bs-body .bs-row']]) {
    await st.gotoPublic({ mode, sid, at: AT });
    await page.evaluate((s) => { window.__el = document.querySelector(s); }, sel);
    await st.advance(31000); // crosses a 30 s render step of the public poll
    expect(await page.evaluate((s) => window.__el === document.querySelector(s) && document.contains(window.__el), sel), mode).toBe(true);
  }
});

// ── Check-in ──────────────────────────────────────────────────────────────
test.describe('check-in', () => {
  test('a second tap while saving is ignored and visibly so', async ({ page, st, backend }) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    backend.setRpc('set_show_arrived', async (body, rec, be) => {
      await gate;
      const s = be.project(PID).data.shows.find((x) => x.id === body.p_show_id);
      s.arrived = !!body.p_arrived; s.arrivedAt = body.p_arrived_at;
      return { json: JSON.parse(JSON.stringify(be.project(PID).data)) };
    });
    await st.gotoPublic({ mode: 'checkin', at: AT });
    await expect(page.locator('.ci-legend')).toContainText('Arrived');
    await expect(page.locator('.ci-legend')).toContainText('Not arrived yet');
    const row = page.locator('.ci-row', { hasText: 'Foxtrot' });
    await expect(row).toContainText('Not arrived yet');
    await row.getByRole('button', { name: 'Mark arrived' }).click();
    const btn = row.locator('.ci-toggle');
    await expect(btn).toHaveText('Saving…');
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    await btn.dispatchEvent('click');                       // a disabled button swallows it...
    await page.evaluate(() => ciToggleArrived('f'));        // ...and the handler ignores it too
    await st.advance(2000);
    await expect(btn).toHaveText('Saving…');                // the poll does not undo the optimistic state
    expect(backend.calls({ path: '/rest/v1/rpc/set_show_arrived' }).length).toBe(1);
    release();
    await expect(btn).toHaveText(/Arrived/);
    await expect(btn).toBeEnabled();
    expect(backend.project(PID).data.shows.find((s) => s.id === 'f').arrived).toBe(true);
  });
  test('a failed save is explained in the row and reverted, no blocking alert', async ({ page, st, backend }) => {
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    backend.failNext({ path: '/rest/v1/rpc/set_show_arrived', status: 500 });
    await st.gotoPublic({ mode: 'checkin', at: AT });
    const row = page.locator('.ci-row', { hasText: 'Foxtrot' });
    await row.getByRole('button', { name: 'Mark arrived' }).click();
    await expect(row.locator('.ci-err')).toContainText('Saving the check-in failed');
    await expect(row.locator('.ci-err')).toContainText('tap the button to try again');
    await expect(row.getByRole('button', { name: 'Mark arrived' })).toBeEnabled();
    expect(dialogs).toEqual([]);
    await row.getByRole('button', { name: 'Mark arrived' }).click(); // retry works and clears the message
    await expect(row.locator('.ci-toggle')).toHaveText(/Arrived/);
    await expect(row.locator('.ci-err')).toHaveCount(0);
  });
  test('hidden shows are not offered on the share link', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'checkin', at: AT });
    await expect(page.locator('#ci-grid')).toContainText('Alpha');
    await expect(page.locator('#ci-grid')).not.toContainText('Hidden act');
    await expect(page.locator('#ci-grid')).not.toContainText('Cancelled act');
  });
});

// ── Wake lock (B3) ────────────────────────────────────────────────────────
test.describe('wake lock', () => {
  for (const [mode, sid] of [['foh', S.main], ['timeline'], ['overview'], ['wall'], ['backstage', S.main]]) {
    test(`${mode} keeps the screen awake and re-acquires after the tab comes back`, async ({ page, st }) => {
      await page.addInitScript(WAKE_STUB);
      await st.gotoPublic({ mode, sid, at: AT });
      await expect.poll(() => page.evaluate(() => window.__wl.length)).toBe(1);
      expect(await page.evaluate(() => window.__wl[0].type)).toBe('screen');
      // The browser drops the lock when the tab is hidden; coming back re-acquires it.
      await page.evaluate(() => { window.__wl[0].s._fire(); document.dispatchEvent(new Event('visibilitychange')); });
      await expect.poll(() => page.evaluate(() => window.__wl.length)).toBe(2);
    });
  }
  test('check-in does not hold a wake lock', async ({ page, st }) => {
    await page.addInitScript(WAKE_STUB);
    await st.gotoPublic({ mode: 'checkin', at: AT });
    await st.advance(1000);
    expect(await page.evaluate(() => window.__wl.length)).toBe(0);
  });
});

// ── Share dialog ──────────────────────────────────────────────────────────
test.describe('share dialog', () => {
  test.use({ stAuth: 'admin' });
  const open = async (page, st) => {
    await st.gotoApp({ at: AT });
    await page.evaluate((pid) => openShareModal(pid), PID);
    await expect(page.locator('#share-ov')).toHaveClass(/open/);
  };
  const row = (page, mode) => page.locator(`.share-link-row[data-mode="${mode}"]`).first();

  test('every link says what it allows; copy gives feedback', async ({ page, st }) => {
    await page.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
    });
    await open(page, st);
    await expect(row(page, 'checkin').locator('.share-access')).toHaveText('Can change check-in');
    for (const m of ['timeline', 'overview', 'wall', 'stage', 'backstage', 'foh']) await expect(row(page, m).locator('.share-access')).toHaveText('Read-only');
    // URLs are unchanged
    await expect(row(page, 'timeline').locator('.share-link-url')).toHaveText(/\/app\.html\?mode=timeline&pid=proj-fest$/);
    await expect(row(page, 'foh').locator('.share-link-url')).toHaveText(new RegExp(`\\?mode=foh&pid=proj-fest&sid=${S.main}$`));
    const btn = row(page, 'overview').getByRole('button', { name: 'Copy Overview link' });
    await btn.click();
    await expect(btn).toHaveText('✓ Copied');
    await expect(row(page, 'overview').locator('.share-copy-msg')).toHaveText('Link copied.');
    expect(await page.evaluate(() => window.__copied)).toEqual([await row(page, 'overview').locator('.share-link-url').textContent()]);
    await st.advance(2500);
    await expect(btn).toHaveText('Copy');
  });

  test('a refused clipboard selects the link and says how to copy it', async ({ page, st }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('NotAllowedError')) } });
      document.execCommand = () => false;
    });
    await open(page, st);
    const r = row(page, 'checkin');
    await r.getByRole('button', { name: 'Copy Artist check-in link' }).click();
    await expect(r.locator('.share-copy-msg')).toContainText('Could not copy automatically');
    await expect(r.locator('.share-copy-msg')).toContainText('press Ctrl+C');
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(await r.locator('.share-link-url').textContent());
    await expect(r.getByRole('button', { name: 'Copy Artist check-in link' })).toHaveText('Copy');
  });

  test('no clipboard API at all (http) still works through the fallback', async ({ page, st }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      window.__exec = 0; document.execCommand = (c) => { window.__exec++; return c === 'copy'; };
    });
    await open(page, st);
    const btn = row(page, 'wall').getByRole('button', { name: 'Copy Control Wall link' });
    await btn.click();
    await expect(btn).toHaveText('✓ Copied');
    expect(await page.evaluate(() => window.__exec)).toBe(1);
  });

  test('usable at 390 px: no sideways scroll, 44 px copy buttons', async ({ page, st }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, st);
    const m = await page.locator('#share-modal').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, w: e.getBoundingClientRect().width }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    expect(m.w).toBeLessThanOrEqual(390);
    const b = await row(page, 'timeline').getByRole('button').boundingBox();
    expect(b.height).toBeGreaterThanOrEqual(44);
  });
});

// ── Screenshots (opt-in) ──────────────────────────────────────────────────
const SHOTS = process.env.VIEWS_SHOTS;
test.describe('screenshots', () => {
  test.skip(!SHOTS, 'set VIEWS_SHOTS=<label> to write screenshots');
  const dir = () => { const d = path.join(__dirname, '..', 'output', 'views', SHOTS || 'x'); fs.mkdirSync(d, { recursive: true }); return d; };
  for (const [mode, sid] of [['foh', S.main], ['backstage', S.main], ['timeline'], ['overview'], ['wall'], ['checkin']]) {
    for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]]) {
      test(`${mode} ${w}`, async ({ page, st }) => {
        await page.setViewportSize({ width: w, height: h });
        await st.gotoPublic({ mode, sid, at: AT });
        await st.freezeAt(new Date(AT.getTime() + 3000));
        await page.screenshot({ path: path.join(dir(), `${mode}-${w}.png`) });
      });
    }
  }
  test('backstage empty (other day) 390', async ({ page, st }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await st.gotoPublic({ mode: 'backstage', sid: S.club, at: AT });
    await st.freezeAt(new Date(AT.getTime() + 3000));
    await page.screenshot({ path: path.join(dir(), 'backstage-empty-390.png') });
  });
  test.describe('logged in', () => {
    test.use({ stAuth: 'admin' });
    for (const [w, h] of [[390, 844], [1440, 900]]) {
      test(`share dialog ${w}`, async ({ page, st }) => {
        await page.setViewportSize({ width: w, height: h });
        await st.gotoApp({ at: AT });
        await page.evaluate((pid) => openShareModal(pid), PID);
        await page.screenshot({ path: path.join(dir(), `share-${w}.png`) });
      });
    }
  });
});
