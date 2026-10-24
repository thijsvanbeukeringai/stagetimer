// Backstage in the Artist lounge design, with the technical info (owner
// request 2026-10-24: "Backstage may look the same as the Artist lounge, but
// WITH the technical info"). In the app (#bs) and as share link
// ?mode=backstage&pid=..&sid=<stage>: NOW ON STAGE / NEXT ON STAGE hero with
// the act's photo, big white countdown and timeline; COMING UP cards; the
// project logo and accent colour; plus per act the technical rider
// (riderOf(s).tech, line breaks kept) and the show note. Never the drinks
// rider, never the timed FOH cues.
//
// Data: festival seed, Main Stage Friday (10 Jul 2026):
//   m1 Opening Act 14:00-15:00 · m2 DJ O'Neil 15:30-16:30 (note, tech + drinks
//   rider, FOH cue) · m3 The <b>html</b> Band 17:00-18:15 · m4 Headliner
//   19:00-20:30 (tech rider with markup) · m5 cancelled · m6 Night Owl
//   (drinks only). The Tent: t1 Hidden Guest 15:00-16:00 (hidden).
//
// Screenshots: tests/output/bs/ (gitignored).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, LOUNGE_PHOTOS, LOUNGE_LOGO, ams } = require('../support/seed');

const PID = FESTIVAL.projectId;
const S = FESTIVAL.stages;
const at = (t, d = FESTIVAL.dates.d1) => ams(d, t);
const SHOTS = path.join(__dirname, '..', 'output', 'bs');
const shot = async (page, name) => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };
const PHOTO_OF = { m1: 0, m2: 1, m3: 2, m4: 3, m6: 4 };
const LONG_TECH = Array.from({ length: 9 }, (_, i) => `Line ${i + 1}: stage box channel ${i + 1}`).join('\n');

const showIn = (d, id) => d.shows.find((s) => s.id === id);
const crew = (fn) => ({
  mutate(seed) {
    const d = seed.projects.find((p) => p.id === PID).data;
    for (const [id, i] of Object.entries(PHOTO_OF)) showIn(d, id).photo = LOUNGE_PHOTOS[i];
    d.logo = LOUNGE_LOGO;
    d.branding = { logoBackstage: true, logoFoh: false, logoBackdrop: false };
    showIn(d, 'm3').rider = { tech: LONG_TECH };
    showIn(d, 'm3').note = 'Load-in via gate 4';
    if (fn) fn(d);
    return seed;
  },
});
const openBSPublic = (st, t, { sid = S.main } = {}) => st.gotoPublic({ mode: 'backstage', sid, at: at(t), paused: true });
const BS = (page) => page.locator('#bs');
const hero = (page) => page.locator('#bs .lng-hero');
const card = (page, name) => page.locator('#bs .lng-card', { hasText: name });

// Nothing sideways; on the TV layouts nothing below the screen either.
async function expectFits(page, { vertical = true } = {}) {
  const r = await page.evaluate((vertical) => {
    const out = [];
    const sel = '#bs-hdr > *:not([hidden]), #bs .lng-hero, #bs .lng-hero .lng-ph, #bs .lng-name, #bs .lng-cd, #bs .lng-tl, #bs .lng-info, #bs .lng-card, #bs .lng-card-cd, #bs .lng-later, #bs .vw-empty';
    for (const e of document.querySelectorAll(sel)) {
      const b = e.getBoundingClientRect();
      if (!b.width && !b.height) continue;
      if (b.left < -0.5 || b.right > innerWidth + 0.5 || (vertical && b.bottom > innerHeight + 0.5) || e.scrollWidth > e.clientWidth + 1) out.push(`${e.id || e.className} ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.right)}x${Math.round(b.bottom)} sw=${e.scrollWidth} cw=${e.clientWidth}`);
    }
    // the hero's parts never overlap each other
    const q = (s) => document.querySelector(s)?.getBoundingClientRect();
    const [ph, main, tl] = [q('#bs .lng-hero .lng-ph'), q('#bs .lng-hero-main'), q('#bs .lng-tl')];
    const hit = (a, b) => a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    if (hit(ph, main)) out.push('photo overlaps the countdown column');
    if (hit(main, tl) || hit(ph, tl)) out.push('hero overlaps its timeline');
    return { doc: document.scrollingElement.scrollWidth - innerWidth, out };
  }, vertical);
  expect(r.doc, 'page scrolls sideways').toBeLessThanOrEqual(0);
  expect(r.out, 'out of the screen').toEqual([]);
}

test.use({ viewport: { width: 1920, height: 1080 }, stSeed: crew() });

test('share link: lounge hero with photo, tech rider and note; no drinks, no FOH cues', async ({ page, st, backend }) => {
  await openBSPublic(st, '16:00:00');
  await expect(BS(page)).toHaveClass(/open/);
  const h = hero(page);
  await expect(h).toHaveClass(/lng-live/);
  await expect(h.locator('.lng-badge')).toHaveText('Now on stage');
  await expect(h.locator('.lng-name')).toHaveText("DJ O'Neil");
  await expect(h.locator('.lng-cd')).toHaveText('30:00');
  expect(await h.locator('.lng-cd').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 255, 255)');
  // the photo comes with the backstage feed now
  const img = h.locator('.lng-ph img');
  await expect(img).toHaveAttribute('src', LOUNGE_PHOTOS[1]);
  await expect.poll(() => img.evaluate((e) => e.complete && e.naturalWidth)).toBe(240);
  // tech rider in full, line breaks kept; the show note
  const tech = h.locator('.lng-info-tech');
  await expect(tech.locator('.lng-info-k')).toHaveText('Technical requirements');
  expect(await tech.locator('.lng-info-v').evaluate((e) => e.innerText)).toBe('2x CDJ-3000 + DJM-900NXS2\nBooth monitor left');
  await expect(h.locator('.lng-info-note .lng-info-v')).toHaveText("Bring O'Neil's USB backup");
  // never the drinks rider, never the timed FOH cue - not on screen, not in the feed
  await expect(BS(page)).not.toContainText('Club-Mate');
  await expect(BS(page)).not.toContainText('Extra monitor for DJ O');
  const m2 = await page.evaluate(() => G.shows.find((s) => s.id === 'm2'));
  expect(m2.rider).toEqual({ tech: '2x CDJ-3000 + DJM-900NXS2\nBooth monitor left' });
  expect(await page.evaluate(() => JSON.stringify(G))).not.toContain('Club-Mate');
  expect(await page.evaluate(() => Object.keys(G.fohNotes || {}).length)).toBe(0);
  const calls = backend.calls({ method: 'POST', path: '/rest/v1/rpc/get_shared_project' });
  expect(calls.map((c) => c.body.p_mode)).toEqual(calls.map(() => 'backstage'));
  // the stagetimer.nl mark: one fixed mark bottom-right, none in the header
  await expect(page.locator('#st-pub-mark')).toBeVisible();
  await expect(page.locator('#bs .vw-st-mark')).toBeHidden();
  await expect(page.locator('#bs-close-btn')).toBeHidden();
  await expect(page.locator('#bs-ssel')).toBeHidden();
  await expect(page.locator('#bs-day')).toHaveText(/^Backstage · /);
  await expect(page.locator('#bs-clock')).toHaveText('16:00:00');
  await expect(page.locator('#vw-logo-bs')).toBeVisible();
  await expectFits(page);
  await shot(page, '1920x1080-live.png');
});

test('coming up: photos, countdowns, tech + note clamped to four lines; markup stays text', async ({ page, st }) => {
  await openBSPublic(st, '16:00:00');
  const band = card(page, 'The <b>html</b>');
  await expect(band.locator('.lng-card-cd')).toHaveText('1:00:00');
  await expect(band.locator('.lng-ph img')).toHaveAttribute('src', LOUNGE_PHOTOS[2]);
  const v = band.locator('.lng-info-tech .lng-info-v');
  const [h, lh, sh] = await v.evaluate((e) => [e.clientHeight, parseFloat(getComputedStyle(e).lineHeight), e.scrollHeight]);
  expect(h).toBeLessThanOrEqual(Math.ceil(lh * 4) + 1);   // four lines shown
  expect(sh).toBeGreaterThan(h);                          // the rest clamped, not overflowing
  await expect(band.locator('.lng-info-note')).toHaveText(/Load-in via gate 4/);
  const head = card(page, 'Headliner Priority');
  await expect(head.locator('.lng-info-tech .lng-info-v')).toContainText('<script>window.__xss=1</script>');
  await expect(head.locator('.it-badge')).toHaveCount(1);   // item type badge (crew)
  expect(await page.locator('#bs script, #bs img[src="x"]').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(BS(page)).not.toContainText('Champagne');
  // Night Owl has drinks only: no info block, no drinks. On a 1080p TV its
  // card does not fit under the two taller ones: it moves to "Later" instead
  // of being cut off.
  await expect(card(page, 'Night Owl').locator('.lng-info')).toHaveCount(0);
  await expect(card(page, 'Night Owl')).toBeHidden();
  await expect(page.locator('#bs .lng-later span:not([hidden])')).toHaveText(['23:00Night Owl']);
  await expect(page.locator('#bs .lng-later')).toBeVisible();
  await expect(BS(page)).not.toContainText('Espresso');
});

test('between acts: NEXT ON STAGE with its own tech rider', async ({ page, st }) => {
  await openBSPublic(st, '16:45:00');
  const h = hero(page);
  await expect(h).toHaveClass(/lng-next/);
  await expect(h.locator('.lng-badge')).toHaveText('Next on stage');
  await expect(h.locator('.lng-cd')).toHaveText('15:00');
  await expect(h.locator('.lng-info-tech .lng-info-v')).toContainText('Line 9: stage box channel 9');   // hero: in full
  await expectFits(page);
  await shot(page, '1920x1080-next.png');
});

test.describe('accent colour', () => {
  test.use({ stSeed: crew((d) => { d.branding.accent = '#22C55E'; }) });
  test('data.branding.accent colours Backstage like the lounge', async ({ page, st }) => {
    await openBSPublic(st, '16:00:00');
    expect(await BS(page).evaluate((e) => getComputedStyle(e).getPropertyValue('--lng-ac').trim())).toBe('#22c55e');
    expect(await page.locator('#bs .lng-dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(34, 197, 94)');
    expect(await page.locator('#bs .lng-info-tech').first().evaluate((e) => getComputedStyle(e).borderLeftColor)).toBe('rgb(34, 197, 94)');
  });
});
test('default accent: live red', async ({ page, st }) => {
  await openBSPublic(st, '16:00:00');
  expect(await page.locator('#bs .lng-dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(239, 68, 68)');
});

for (const [w, hgt, vertical] of [[1920, 1080, true], [1280, 720, true], [390, 844, false]]) {
  test(`fits at ${w}x${hgt}`, async ({ page, st }) => {
    await page.setViewportSize({ width: w, height: hgt });
    await openBSPublic(st, '16:00:00');
    await expect(hero(page).locator('.lng-info-tech')).toBeVisible();
    await expectFits(page, { vertical });
    if (w === 390) {
      // phone: hero first, then the list, nothing on top of each other
      const [hb, cb] = [await hero(page).boundingBox(), await page.locator('#bs .lng-col').boundingBox()];
      expect(cb.y).toBeGreaterThanOrEqual(hb.y + hb.height - 0.5);
      await shot(page, '390x844-live.png');
      await page.locator('#bs-body').evaluate((e) => { e.scrollTop = e.scrollHeight; });
      await shot(page, '390x844-list.png');
    }
    if (w === 1280) await shot(page, '1280x720-live.png');
  });
}

test.describe('in the app', () => {
  test.use({ stAuth: 'admin', viewport: { width: 1440, height: 900 } });
  test('operator Backstage: same screen, stage picker, hidden acts with a chip, no drinks or FOH cues', async ({ page, st }) => {
    await st.gotoApp({ at: at('15:20') });
    await st.openProject();
    await page.evaluate(() => openBS());
    await expect(BS(page)).toHaveClass(/open/);
    await expect(page.locator('#bs-ssel')).toBeVisible();
    await expect(page.locator('#bs-close-btn')).toBeVisible();
    await expect(hero(page).locator('.lng-name')).toHaveText("DJ O'Neil");   // next on Main
    await expect(hero(page).locator('.lng-info-tech')).toContainText('2x CDJ-3000');
    await expect(BS(page)).not.toContainText('Club-Mate');                    // G has it, the screen never shows it
    await expect(BS(page)).not.toContainText('Extra monitor for DJ O');
    await shot(page, 'in-app-1440x900.png');
    await page.locator('#bs-ssel').selectOption(S.tent);
    await expect(page.locator('#bs-sname')).toHaveText('The Tent');
    await expect(hero(page).locator('.lng-name')).toHaveText('Hidden Guest');   // crew sees hidden acts in the app
    await expect(hero(page).locator('.vw-chip.vw-hidden')).toHaveCount(1);
    // close + reopen: the countdown keeps moving (refs rebuilt)
    await page.evaluate(() => { closeBS(); openBS(); });
    const before = await hero(page).locator('.lng-cd').textContent();
    await st.advance(2000);
    await expect(hero(page).locator('.lng-cd')).not.toHaveText(before);
  });
});
