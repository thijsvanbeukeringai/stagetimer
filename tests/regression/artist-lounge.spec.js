// Artist lounge (owner request 2026-10-23, for Amsterdam Music Festival): the
// TV in the artist lounge of one stage. In the app (Views) and as share link
// ?mode=lounge&pid=..&sid=<stage>. Backstage's information, made for artists
// reading it from 3-5 m: NOW ON STAGE with the act's photo, a big white
// countdown and the set's own timeline; between acts NEXT ON STAGE; the acts
// coming up with photo, start time, "starts in" and where they sit in the
// day; the project logo (bigger than on Backstage) and an accent colour.
//
// Data: festival seed, Main Stage Friday (10 Jul 2026):
//   m1 Opening Act 14:00-15:00 (A) · m2 DJ O'Neil 15:30-16:30 (B)
//   m3 The <b>html</b> & "Quotes" Band 17:00-18:15 (A) · m4 Headliner 19:00-20:30
//   m5 Cancelled Act 21:00-22:30 (cancelled) · m6 Night Owl 23:00-01:30 (B)
// The Tent: t1 Hidden Guest 15:00-16:00 (hidden), t2 16:00-17:30, t3 22:00.
// Photos: LOUNGE_PHOTOS (five small JPEGs) put on the Main Stage acts here.
//
// Screenshots: tests/output/lounge/ (gitignored).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, LOUNGE_PHOTOS, LOUNGE_LOGO, ams, show } = require('../support/seed');

const PID = FESTIVAL.projectId;
const S = FESTIVAL.stages;
const at = (t, d = FESTIVAL.dates.d1) => ams(d, t);
const BAND = 'The <b>html</b> & "Quotes" Band';
const SHOTS = path.join(__dirname, '..', 'output', 'lounge');
const shot = async (page, name) => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };
const PHOTO_OF = { m1: 0, m2: 1, m3: 2, m4: 3, m6: 4 };

const showIn = (d, id) => d.shows.find((s) => s.id === id);
// Photos on the Main Stage acts, the logo on the lounge, plus fn(data).
const lounge = (fn) => ({
  mutate(seed) {
    const d = seed.projects.find((p) => p.id === PID).data;
    for (const [id, i] of Object.entries(PHOTO_OF)) showIn(d, id).photo = LOUNGE_PHOTOS[i];
    d.logo = LOUNGE_LOGO;
    d.branding = { logoBackstage: true, logoFoh: false, logoBackdrop: false };
    showIn(d, 'm2').bgVideo = 'https://media.stagetimer.test/clip.webm';
    showIn(d, 'm2').arrived = true; showIn(d, 'm2').arrivedAt = at('15:00').getTime();
    if (fn) fn(d);
    return seed;
  },
});
const openLounge = (st, t, { sid = S.main, ...opts } = {}) => st.gotoPublic({ mode: 'lounge', sid, at: typeof t === 'string' ? at(t) : t, paused: true, ...opts });
const L = (page) => page.locator('#lng');
const hero = (page) => page.locator('#lng .lng-hero');
const cards = (page) => page.locator('#lng .lng-card');
const tx = (page, sel) => page.locator(sel).first().evaluate((e) => e.style.transform);
const left = (page, sel) => page.locator(sel).first().evaluate((e) => e.style.left);
// translateX(<n>%) as a number.
const txPct = async (page, sel) => Number(/^translateX\((-?[\d.]+)%\)$/.exec(await tx(page, sel))[1]);

async function pollStep(page) {
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => window.__stLastSyncOk === Date.now()), { message: 'poll applied' }).toBe(true);
}
// Nothing sideways; on the TV layouts nothing below the screen either (the
// cards in the self-scrolling column may: the column itself must fit).
async function expectFits(page, { vertical = true } = {}) {
  const r = await page.evaluate((vertical) => {
    const out = [];
    const sel = '#lng-hdr > *:not([hidden]), #lng .lng-hero, #lng .lng-hero .lng-ph, #lng .lng-name, #lng .lng-cd, #lng .lng-tl, #lng .lng-card, #lng .lng-card-cd, #lng .lng-cards, #lng .vw-empty';
    for (const e of document.querySelectorAll(sel)) {
      const b = e.getBoundingClientRect();
      if (!b.width && !b.height) continue;
      if (b.left < -0.5 || b.right > innerWidth + 0.5 || (vertical && !e.closest('.lng-rows-in') && b.bottom > innerHeight + 0.5) || e.scrollWidth > e.clientWidth + 1) out.push(`${e.id || e.className} ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.right)}x${Math.round(b.bottom)} sw=${e.scrollWidth} cw=${e.clientWidth}`);
    }
    return { doc: document.scrollingElement.scrollWidth - innerWidth, out };
  }, vertical);
  expect(r.doc, 'page scrolls sideways').toBeLessThanOrEqual(0);
  expect(r.out, 'out of the screen').toEqual([]);
}

test.use({ viewport: { width: 1920, height: 1080 }, stSeed: lounge() });

// ── Now on stage ──────────────────────────────────────────────────────────
test.describe('now on stage', () => {
  test('hero: badge, photo, name, white countdown, timeline at 25% and 50%', async ({ page, st, backend }) => {
    await openLounge(st, '15:45:00');
    await expect(L(page)).toHaveClass(/open/);
    const h = hero(page);
    await expect(h).toHaveClass(/lng-live/);
    await expect(h.locator('.lng-badge')).toHaveText('Now on stage');
    await expect(h.locator('.lng-name')).toHaveText("DJ O'Neil");
    await expect(h.locator('.lng-meta')).toHaveText('15:30–16:30');   // no booth in the lounge (owner, 24-10)
    await expect(L(page).locator('.lng-booth')).toHaveCount(0);
    await expect(h.locator('.lng-cd-lbl')).toHaveText('Set ends in');
    await expect(h.locator('.lng-cd')).toHaveText('45:00');
    expect(await h.locator('.lng-cd').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 255, 255)');
    expect(await tx(page, '#lng .lng-tl-fill')).toBe('translateX(-75%)');
    expect(await left(page, '#lng .lng-tl-dot')).toBe('25%');
    await expect(h.locator('.lng-tl-el')).toHaveText('15:00 played');
    await expect(h.locator('.lng-tl-rem')).toHaveText('45:00 left');
    await expect(h.locator('.lng-tl-t')).toHaveText(['15:30', '16:30']);
    // the act's own photo, decoded, over the initials
    const img = h.locator('.lng-ph img');
    await expect(img).toHaveAttribute('src', LOUNGE_PHOTOS[1]);
    await expect.poll(() => img.evaluate((e) => e.complete && e.naturalWidth)).toBe(240);
    await expect(h.locator('.lng-mono')).toHaveText('DO');
    // half way
    await page.clock.fastForward(15 * 60 * 1000);
    await st.advance(250);
    await expect(h.locator('.lng-cd')).toHaveText('30:00');
    expect(await txPct(page, '#lng .lng-tl-fill')).toBeCloseTo(-50, 1);
    expect(parseFloat(await left(page, '#lng .lng-tl-dot'))).toBeCloseTo(50, 1);
    await expect(h.locator('.lng-tl-el')).toHaveText('30:00 played');
    // the feed asked for this mode, every time
    const calls = backend.calls({ method: 'POST', path: '/rest/v1/rpc/get_shared_project' });
    expect(calls.map((c) => c.body.p_mode)).toEqual(calls.map(() => 'lounge'));
  });

  test('countdown ticks in place: no rebuild, the photo element stays', async ({ page, st }) => {
    await openLounge(st, '16:00:00.400');
    await page.evaluate(() => { document.querySelector('#lng .lng-ph img').__keep = 1; });
    await st.advance(1000);
    await expect(hero(page).locator('.lng-cd')).toHaveText('29:59');
    await st.advance(2000);
    await expect(hero(page).locator('.lng-cd')).toHaveText('29:57');
    expect(await page.evaluate(() => document.querySelector('#lng .lng-ph img').__keep)).toBe(1);
  });

  test('last 5 minutes: the timeline turns amber, the countdown stays white', async ({ page, st }) => {
    await openLounge(st, '16:24:00');
    await expect(hero(page)).not.toHaveClass(/lng-final/);
    await page.clock.fastForward(60 * 1000);
    await st.advance(250);
    await expect(hero(page)).toHaveClass(/lng-final/);
    await expect(hero(page).locator('.lng-cd')).toHaveText('05:00');
    expect(await hero(page).locator('.lng-cd').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 255, 255)');
  });

  test('an act going off stage flips the hero to the next act', async ({ page, st }) => {
    await openLounge(st, '16:29:58.400');
    await expect(hero(page)).toHaveClass(/lng-live/);
    await st.advance(2000);
    await expect(hero(page)).toHaveClass(/lng-next/);
    await expect(hero(page).locator('.lng-name')).toHaveText(BAND);
  });
});

// ── Coming up ─────────────────────────────────────────────────────────────
test.describe('coming up', () => {
  test('next acts with photo, times, white "starts in" and a mini day timeline; cancelled left out', async ({ page, st }) => {
    await openLounge(st, '15:45:00');
    await expect(cards(page)).toHaveCount(3);
    await expect(cards(page).locator('.lng-card-name')).toHaveText([BAND, 'Headliner Priority', 'Night Owl']);
    await expect(cards(page).locator('.lng-card-cd')).toHaveText(['1:15:00', '3:15:00', '7:15:00']);
    await expect(cards(page).first().locator('.lng-card-meta')).toContainText('17:00–18:15');
    expect(await cards(page).locator('.lng-card-cd').first().evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 255, 255)');
    for (const [i, id] of ['m3', 'm4', 'm6'].entries()) await expect(cards(page).nth(i).locator('img')).toHaveAttribute('src', LOUNGE_PHOTOS[PHOTO_OF[id]]);
    await expect(L(page)).not.toContainText('Cancelled Act');
    // day on Main Stage 14:00-01:30 (690 min); 15:45 = 105 min in
    expect(parseFloat(await left(page, '#lng .lng-mini-now'))).toBeCloseTo(105 / 690 * 100, 2);
    const slot = await cards(page).first().locator('.lng-mini-slot').evaluate((e) => [e.style.left, e.style.width]);
    expect(slot).toEqual([`${(180 / 690 * 100).toFixed(2)}%`, `${(75 / 690 * 100).toFixed(2)}%`]);
    await expect(cards(page).first()).not.toHaveClass(/lng-soon/);
  });

});
test.describe('coming up (a long day)', () => {
  test.use({ stSeed: lounge((d) => { d.shows.push(show('m9', S.main, FESTIVAL.days.d1, FESTIVAL.dates.d2, '01:30', '03:00', 'Sunrise Session')); }) });
  test('every upcoming act is a full card (owner, 24-10); a column that does not fit scrolls by itself', async ({ page, st }) => {
    await openLounge(st, '13:00:00');
    await expect(hero(page)).toHaveClass(/lng-next/);
    await expect(hero(page).locator('.lng-name')).toHaveText('Opening Act');
    await expect(cards(page).locator('.lng-card-name')).toHaveText(["DJ O'Neil", BAND, 'Headliner Priority', 'Night Owl', 'Sunrise Session']);
    await expect(cards(page).last().locator('.lng-card-meta')).toContainText('01:30–03:00');
    await expect(cards(page).last().locator('.lng-card-cd')).toHaveText('12:30:00');
    await expect(cards(page).last().locator('.lng-ph')).toBeVisible();
    await expect(page.locator('#lng .lng-later, #lng .lng-row')).toHaveCount(0);
    await expect(page.locator('#lng .lng-cards > .lng-rows-in')).toHaveClass(/lng-scroll/);
    await expectFits(page);
    await shot(page, '1920x1080-all-cards.png');
  });
});
test.describe('coming up (soon)', () => {
  test.use({ stSeed: lounge((d) => { Object.assign(showIn(d, 'm3'), show('m3', S.main, FESTIVAL.days.d1, FESTIVAL.dates.d1, '16:35', '18:15', 'Soon Act', { booth: 'A', photo: LOUNGE_PHOTOS[2] })); }) });
  test('the act starting within 10 minutes gets the accent "Up next" highlight', async ({ page, st }) => {
    await openLounge(st, '16:24:00');
    await expect(cards(page).first().locator('.lng-card-name')).toHaveText('Soon Act');
    await expect(cards(page).first()).not.toHaveClass(/lng-soon/);
    await expect(cards(page).first().locator('.lng-tag')).toBeHidden();
    await page.clock.fastForward(60 * 1000);   // 16:25: starts in 10:00
    await st.advance(250);
    await expect(cards(page).first()).toHaveClass(/lng-soon/);
    await expect(cards(page).first().locator('.lng-tag')).toHaveText('Up next');
    await expect(cards(page).first().locator('.lng-tag')).toBeVisible();
    await expect(cards(page).nth(1)).not.toHaveClass(/lng-soon/);
    await shot(page, '1920x1080-final-minutes-up-next.png');
  });
});

// ── Layout: TV 16:9 (1080p, 720p), portrait TV, phone ──────────────────────
test.describe('layout', () => {
  const SIZES = [[1920, 1080], [1280, 720], [1080, 1920], [390, 844]];
  const TIMES = [['16:00:00', 'live'], ['16:26:00', 'final-minutes'], ['16:45:00', 'changeover']];
  for (const [w, h] of SIZES) {
    for (const [t, name] of TIMES) {
      test(`${w}x${h} ${name}: nothing overflows`, async ({ page, st }) => {
        await page.setViewportSize({ width: w, height: h });
        await openLounge(st, t);
        await expect(hero(page)).toBeVisible();
        await expectFits(page, { vertical: w > 700 });
        await shot(page, `${w}x${h}-${name}.png`);
      });
    }
  }
  test('header: ~1.5x the Backstage header, logo up to ~56 px tall, stagetimer.nl mark visible', async ({ page, st }) => {
    await openLounge(st, '16:00:00');
    const hdr = await page.locator('#lng-hdr').boundingBox();
    expect(hdr.height).toBeGreaterThanOrEqual(74);   // Backstage: 50
    const logo = page.locator('#vw-logo-lng');
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('src', LOUNGE_LOGO);
    const lb = await logo.boundingBox();
    expect(lb.height).toBeGreaterThan(50);
    expect(lb.height).toBeLessThanOrEqual(56);
    await expect(page.locator('#st-pub-mark')).toBeVisible();
    await expect(page.locator('#st-pub-mark')).toHaveAttribute('aria-label', 'Powered by stagetimer.nl');
    await expect(page.locator('#lng-sname')).toHaveText('Main Stage');
    await expect(page.locator('#lng-day')).toHaveText('Vrijdag · Fri 10 Jul');
    await expect(page.locator('#lng-clock')).toHaveText('16:00:00');
    // a share link: no stage picker, no day tabs, no close button
    await expect(page.locator('#lng-ssel')).toBeHidden();
    await expect(page.locator('#lng-dtabs')).toBeHidden();
    await expect(page.locator('#lng-close-btn')).toBeHidden();
  });
  test('day finished: the shared empty state, styled for the lounge', async ({ page, st }) => {
    await openLounge(st, at('06:00', FESTIVAL.dates.d2));   // still Friday's festival day; Night Owl ended 01:30
    await expect(page.locator('#lng .vw-empty-title')).toHaveText('Programme finished');
    await expect(page.locator('#lng .vw-empty-sub')).toContainText('Next show: Day Two Opener');
    await expect(hero(page)).toHaveCount(0);
    await expectFits(page);
    await shot(page, '1920x1080-finished.png');
  });
});

// ── Privacy: the lounge receives only what it shows ───────────────────────
test.describe('privacy', () => {
  test('payload: photos, logo, branding and times; no crew, notes, FOH notes, rider, members, video, arrival', async ({ page, st }) => {
    await openLounge(st, '16:00:00');
    await pollStep(page);
    const row = JSON.parse(await page.evaluate(() => _pvLastText));
    const text = JSON.stringify(row);
    for (const secret of ['Bram', 'USB backup', 'Extra monitor', 'Club-Mate', 'CDJ', 'clip.webm', '"crew"', '"note"', '"rider"', '"bgVideo"', '"arrived"', '"arrivedAt"', FESTIVAL.users.operator.id]) expect(text, secret).not.toContain(secret);
    expect(row.data.fohNotes).toEqual({});
    expect(row.data.memberIds).toEqual([]);
    expect(row.company_id).toBeNull();
    expect(row.data.logo).toBe(LOUNGE_LOGO);
    expect(row.data.shows.find((s) => s.id === 'm2').photo).toBe(LOUNGE_PHOTOS[1]);
    expect(row.data.branding).toEqual({ logoBackstage: true, logoFoh: false, logoBackdrop: false });
    const dom = await L(page).innerText();
    for (const secret of ['Bram', 'USB backup', 'Extra monitor', 'Club-Mate', 'Arrived']) expect(dom).not.toContain(secret);
  });

  test('hidden acts never show', async ({ page, st }) => {
    await openLounge(st, '15:30:00', { sid: S.tent });   // Hidden Guest (15:00-16:00) would be on stage
    await expect(page.locator('#lng-sname')).toHaveText('The Tent');
    await expect(hero(page)).toHaveClass(/lng-next/);
    await expect(hero(page).locator('.lng-name')).toHaveText('Tent Band (legacy)');
    await expect(L(page)).not.toContainText('Hidden Guest');
  });
  test('cancelled acts are never live or next', async ({ page, st }) => {
    await openLounge(st, '20:45:00');   // Main: Headliner ends 20:30, Cancelled Act 21:00-22:30
    await expect(hero(page).locator('.lng-name')).toHaveText('Night Owl');
    await expect(L(page)).not.toContainText('Cancelled Act');
    await page.clock.fastForward(30 * 60 * 1000);   // 21:15, inside the cancelled slot
    await st.advance(250);
    await expect(hero(page)).toHaveClass(/lng-next/);
    await expect(hero(page).locator('.lng-name')).toHaveText('Night Owl');
  });
});
test.describe('markup stays text', () => {
  test.use({ stSeed: lounge((d) => { showIn(d, 'm4').artist = '<img src=x onerror="window.__xss=1">Evil'; showIn(d, 'm4').booth = '<b>A</b>'; showIn(d, 'm4').photo = 'javascript:window.__xss=2'; }) });
  test('artist names and photo values cannot inject anything', async ({ page, st }) => {
    await openLounge(st, '17:30:00');
    await expect(hero(page).locator('.lng-name')).toHaveText(BAND);
    await expect(cards(page).first().locator('.lng-card-name')).toHaveText('<img src=x onerror="window.__xss=1">Evil');
    await expect(L(page).locator('b:not(.lng-tl-el b):not(.lng-tl-rem b), img:not([data-lng-ph]):not(.vw-logo):not(.vw-st-icon):not(.vw-st-word):not(.st-brand-icon):not(.st-brand-mark)')).toHaveCount(0);
    await expect(cards(page).first().locator('img')).toHaveCount(0);   // not a safe image: the initials
    await expect(cards(page).first().locator('.lng-mono')).toHaveText('IO');   // letters of the first and last word
    await st.advance(1000);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });
});

// ── Photos ────────────────────────────────────────────────────────────────
test.describe('photo fallback', () => {
  test.use({ stSeed: lounge((d) => { showIn(d, 'm2').photo = 'data:image/jpeg;base64,AAAA'; showIn(d, 'm3').photo = 'https://elsewhere.example/p.jpg'; showIn(d, 'm4').photo = ''; }) });
  test('no photo, a foreign URL or one that fails: initials on the accent colour', async ({ page, st, backend }) => {
    const warns = [];
    page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
    await openLounge(st, '16:00:00');
    await expect(hero(page).locator('.lng-ph img')).toHaveCount(0);   // broken data: removed on error
    await expect(hero(page).locator('.lng-mono')).toHaveText('DO');
    await expect(hero(page).locator('.lng-mono')).toBeVisible();
    await expect(cards(page).nth(0).locator('img')).toHaveCount(0);   // foreign host: never loaded
    await expect(cards(page).nth(1).locator('img')).toHaveCount(0);
    await expect(cards(page).nth(1).locator('.lng-mono')).toHaveText('HP');
    await expect(cards(page).nth(2).locator('img')).toHaveCount(1);
    expect(warns.some((w) => w.includes('[lounge] an artist photo could not be loaded'))).toBe(true);
    expect(backend.violations).toEqual([]);
    await shot(page, '1920x1080-no-photos.png');
  });
});

// ── Accent colour ─────────────────────────────────────────────────────────
test.describe('accent colour', () => {
  test('default live red', async ({ page, st }) => {
    await openLounge(st, '16:00:00');
    expect(await L(page).evaluate((e) => getComputedStyle(e).getPropertyValue('--lng-ac').trim())).toBe('#ef4444');
    expect(await page.locator('#lng .lng-dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(239, 68, 68)');
  });
  test.describe('a chosen accent', () => {
    test.use({ stSeed: lounge((d) => { d.branding.accent = '#22C55E'; }) });
    test('data.branding.accent colours the glow, dot, highlights and initials', async ({ page, st }) => {
      await openLounge(st, '16:00:00');
      expect(await L(page).evaluate((e) => getComputedStyle(e).getPropertyValue('--lng-ac').trim())).toBe('#22c55e');
      expect(await page.locator('#lng .lng-dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(34, 197, 94)');
      expect(await page.locator('#lng .lng-badge').evaluate((e) => getComputedStyle(e).borderTopColor)).toBe('rgba(34, 197, 94, 0.75)');
      await shot(page, '1920x1080-accent-green.png');
    });
  });
  test.describe('a crafted value', () => {
    test.use({ stSeed: lounge((d) => { d.branding.accent = 'red;background:url(https://evil.example/x)'; }) });
    test('falls back to the default and never reaches a style', async ({ page, st, backend }) => {
      await openLounge(st, '16:00:00');
      expect(await L(page).evaluate((e) => e.getAttribute('style'))).not.toContain('evil');
      expect(await L(page).evaluate((e) => getComputedStyle(e).getPropertyValue('--lng-ac').trim())).toBe('#ef4444');
      expect(backend.violations).toEqual([]);
    });
  });
});

// ── Motion ────────────────────────────────────────────────────────────────
test.describe('motion', () => {
  const lngAnims = (page) => page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#lng'))
    .map((a) => ({ name: a.animationName || '', props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)) })));
  test('live: glow, drifting light and a pulsing dot, transform / opacity only', async ({ page, st }) => {
    await openLounge(st, '16:00:00');
    const a = await lngAnims(page);
    expect(a.map((x) => x.name).sort()).toEqual(['lng-drift', 'lng-glow', 'lng-ping']);
    for (const x of a) expect(x.props.every((p) => p === 'transform' || p === 'opacity'), `${x.name}: ${x.props}`).toBe(true);
  });
  test('prefers-reduced-motion: nothing moves', async ({ page, st }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openLounge(st, '16:00:00');
    await expect(hero(page)).toHaveClass(/lng-live/);
    expect(await lngAnims(page)).toEqual([]);
    // still the same clear picture: the glow ring is there, just still
    expect(await hero(page).evaluate((e) => getComputedStyle(e, '::before').opacity)).toBe('1');
  });
});

// ── Live data ─────────────────────────────────────────────────────────────
test('a change on the server reaches the lounge with the next poll', async ({ page, st, backend }) => {
  await openLounge(st, '16:00:00');
  await expect(hero(page).locator('.lng-name')).toHaveText("DJ O'Neil");
  backend.updateProject(PID, (d) => { showIn(d, 'm2').artist = 'DJ Renamed'; showIn(d, 'm3').photo = LOUNGE_PHOTOS[0]; });
  await pollStep(page);
  await expect(hero(page).locator('.lng-name')).toHaveText('DJ Renamed');
  await expect(cards(page).first().locator('img')).toHaveAttribute('src', LOUNGE_PHOTOS[0]);
});

test('kiosk: keeps the screen awake and goes full screen on the first touch by default', async ({ page, st }) => {
  await page.addInitScript(() => {
    window.__wl = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async (type) => { window.__wl.push(type); return { addEventListener() {}, release: async () => {} }; } } });
    window.__fs = 0;
    Element.prototype.requestFullscreen = function () { window.__fs++; return Promise.resolve(); };
  });
  await openLounge(st, '16:00:00');
  await expect.poll(() => page.evaluate(() => window.__wl)).toEqual(['screen']);
  expect(await page.evaluate(() => stFullscreen.auto())).toBe(true);
  await page.mouse.click(400, 400);
  await expect.poll(() => page.evaluate(() => window.__fs)).toBe(1);
  await expect(page.locator('link[rel=manifest]')).toHaveCount(0);   // share links: no web app manifest
});

test.describe('logo switched off for the lounge', () => {
  test.use({ stSeed: lounge((d) => { d.branding.logoLounge = false; }) });
  test('no logo, the stagetimer.nl mark stays', async ({ page, st }) => {
    await openLounge(st, '16:00:00');
    await expect(page.locator('#vw-logo-lng')).toBeHidden();
    await expect(L(page)).not.toHaveClass(/vw-logo-on/);
    await expect(page.locator('#st-pub-mark')).toBeVisible();
  });
});
test.describe('dark logo on a white plate', () => {
  test.use({ stSeed: lounge((d) => { d.branding.logoBackdrop = true; }) });
  test('the plate is drawn behind the logo', async ({ page, st }) => {
    await openLounge(st, '16:00:00');
    await expect(L(page)).toHaveClass(/vw-logo-bd/);
    expect(await page.locator('#vw-logo-lng').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
  });
});

// ── In the app ────────────────────────────────────────────────────────────
test.describe('in the app', () => {
  test.use({ stAuth: 'admin', viewport: { width: 1440, height: 900 } });
  test('Views bar opens the lounge; stage picker and day tabs work; Escape closes', async ({ page, st }) => {
    await st.gotoApp({ at: at('16:00') });
    await st.openProject();
    await page.locator('#hdr-views').getByRole('button', { name: 'Artist lounge' }).click();
    await expect(L(page)).toHaveClass(/open/);
    await expect(hero(page).locator('.lng-name')).toHaveText("DJ O'Neil");
    await expect(page.locator('#lng-ssel')).toBeVisible();
    await expect(page.locator('#lng-close-btn')).toBeVisible();
    await page.locator('#lng-ssel').selectOption(S.tent);
    await expect(page.locator('#lng-sname')).toHaveText('The Tent');
    await expect(L(page)).not.toContainText('Hidden Guest');   // a preview of the TV: hidden stays hidden
    await expect(hero(page).locator('.lng-name')).toHaveText('Tent Band (legacy)');
    await shot(page, 'in-app-1440x900.png');
    await page.keyboard.press('Escape');
    await expect(L(page)).not.toHaveClass(/open/);
  });

  test('Share links: one "Artist lounge" row per stage, read-only', async ({ page, st, baseURL }) => {
    await st.gotoApp({ at: at('16:00') });
    await page.evaluate((pid) => openShareModal(pid), PID);
    const rows = page.locator('.share-link-row[data-mode="lounge"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first().locator('.share-link-label')).toHaveText('Artist lounge');
    await expect(rows.first().locator('.share-access')).toHaveText('Read-only');
    await expect(rows.first().locator('.share-link-url')).toHaveText(`${baseURL}/app.html?mode=lounge&pid=${PID}&sid=${S.main}`);
  });

  test('Project logo dialog: lounge toggle and accent colour (preset, custom, invalid)', async ({ page, st, backend }) => {
    const branding = () => backend.project(PID).data.branding;
    await st.gotoApp({ at: at('16:00') });
    await st.openProject();
    await page.evaluate(() => { openProjectLogo(APP.activeProjectId); });
    const dlg = page.getByRole('dialog', { name: 'Project logo' });
    await expect(dlg.getByRole('checkbox', { name: /Show on Artist lounge/ })).toBeChecked();
    await expect(dlg.getByRole('button', { name: 'Live red' })).toHaveAttribute('aria-pressed', 'true');
    await dlg.getByRole('button', { name: 'Live red' }).click();
    await expect.poll(branding).toEqual({ logoBackstage: true, logoFoh: false, logoBackdrop: false, accent: '#ef4444' });
    await expect(dlg.getByRole('button', { name: 'Live red' })).toHaveAttribute('aria-pressed', 'true');
    await dlg.getByRole('checkbox', { name: /Show on Artist lounge/ }).uncheck();
    await expect.poll(branding).toEqual({ logoBackstage: true, logoFoh: false, logoBackdrop: false, accent: '#ef4444', logoLounge: false });   // the colour stays
    const hex = dlg.getByRole('textbox', { name: 'Custom' });
    await expect(hex).toHaveValue('#ef4444');
    await hex.fill('not a colour');
    await hex.press('Enter');
    await expect(dlg.locator('.st-ac-msg')).toHaveText('Use a hex colour such as #ef4444.');
    await expect(dlg).toBeVisible();   // Enter did not close the dialog
    expect(branding().accent).toBe('#ef4444');
    await hex.fill('3B82F6');
    await hex.press('Enter');
    await expect.poll(() => branding().accent).toBe('#3b82f6');
    await expect(dlg.locator('.st-ac-msg')).toHaveText('');
    await expect(dlg.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
    await dlg.getByRole('checkbox', { name: /Show on Front of House/ }).check();
    await expect.poll(() => branding().logoFoh).toBe(true);
    expect(branding().accent).toBe('#3b82f6');   // other toggles keep the colour
    await shot(page, 'logo-dialog-accent.png');
    await dlg.getByRole('button', { name: 'Done' }).click();
    await page.evaluate(() => openLNG());
    expect(await L(page).evaluate((e) => getComputedStyle(e).getPropertyValue('--lng-ac').trim())).toBe('#3b82f6');
    await expect(page.locator('#vw-logo-lng')).toBeHidden();
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test('the Views menu has Artist lounge; the operator copy fits', async ({ page, st }) => {
      await st.gotoApp({ at: at('16:00') });
      await st.openProject();
      await page.locator('#admin-dd > .hbtn').click();
      await page.locator('#admin-dd .dd-item', { hasText: 'Artist lounge' }).click();
      await expect(L(page)).toHaveClass(/open/);
      await expect(page.locator('#st-brand-lng')).toBeVisible();
      await expectFits(page, { vertical: false });
      await shot(page, 'in-app-390x844.png');
      await page.locator('#lng-close-btn').click();
      await expect(L(page)).not.toHaveClass(/open/);
    });
  });
});

// Fullscreen button in the lounge header (Thijs, 23-10): visible, toggles the
// Fullscreen API, and fades out of the TV picture once fullscreen.
test('fullscreen button in the header', async ({ page, st }) => {
  await page.addInitScript(() => {
    window.__fs = 0;
    Element.prototype.requestFullscreen = function () { window.__fs++; return Promise.resolve(); };
    Object.defineProperty(document, 'fullscreenEnabled', { get: () => true, configurable: true });
  });
  await openLounge(st, '16:00:00');
  const btn = page.locator('#lng-fs-btn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', 'Enter fullscreen');
  const before = await page.evaluate(() => window.__fs);
  await btn.click();
  await expect.poll(() => page.evaluate(() => window.__fs)).toBe(before + 1);
});
