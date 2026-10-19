// Dressing room screen (owner request 2026-10-19): share link
// ?mode=dressing&pid=<project>&shid=<show>. One artist: "Showtime in" a big
// countdown, "On stage now" with the time left in the set, then a calm
// thank-you with the customer's logo. Behind it the customer's own video
// (show.bgVideo, an https link: muted, looping <video>) or background photo
// (show.bgImage). No YouTube (its terms forbid overlays on the player).
//
// Data: festival seed, Main Stage Friday. m3 "The <b>html</b> & "Quotes" Band"
// 17:00-18:15 (markup that must stay text), m5 cancelled, t1 hidden (Tent
// 15:00-16:00), m8 Saturday 20:00. Test videos come from the mock host
// media.stagetimer.test (tests/support/mock-backend.js): /clip.webm is a real
// 1 s VP8 clip, /missing.mp4 a 404, /slow.mp4 never answers.
//
// Screenshots: tests/output/dres/ (gitignored).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, PHOTO_PNG, ams } = require('../support/seed');

const PID = FESTIVAL.projectId;
const at = (t, d = FESTIVAL.dates.d1) => ams(d, t);
const VID = 'https://media.stagetimer.test/clip.webm';
const SLOW = 'https://media.stagetimer.test/slow.mp4';
const BROKEN = 'https://media.stagetimer.test/missing.mp4';
const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const BAND = 'The <b>html</b> & "Quotes" Band';
const RPC = '/rest/v1/rpc/get_shared_project';
const SHOTS = path.join(__dirname, '..', 'output', 'dres');
const shot = async (page, name) => { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };

const seedWith = (fn) => ({ mutate(seed) { fn(seed.projects.find((p) => p.id === PID).data); return seed; } });
const showIn = (d, id) => d.shows.find((s) => s.id === id);
const openDres = (st, shid, t, opts = {}) => st.gotoPublic({ mode: 'dressing', at: typeof t === 'string' ? at(t) : t, paused: true, extra: `&shid=${encodeURIComponent(shid)}`, ...opts });
const main = (page) => page.locator('#dres-main');
const video = (page) => page.locator('#dres-video');
// One second of fake time (one poll), then wait until that poll is applied.
async function pollStep(page) {
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => window.__stLastSyncOk === Date.now()), { message: 'poll applied' }).toBe(true);
}
// Count every src written to a <video>/<audio>: the video must not be reset
// by ticks or polls, only when show.bgVideo changes.
const spyVideoSrc = (page) => page.addInitScript(() => {
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  window.__srcSets = [];
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get: d.get, set(v) { window.__srcSets.push(v); d.set.call(this, v); } });
});

// ── States ────────────────────────────────────────────────────────────────
test.describe('states', () => {
  test('before: artist, day · stage · time, "Showtime in" and a ticking countdown; no video, no photo', async ({ page, st, backend }) => {
    await openDres(st, 'm3', '16:00:00.400');
    await expect(page.locator('#dres')).toHaveClass(/open/);
    await expect(page.locator('#dres')).toHaveAttribute('data-state', 'before');
    await expect(main(page).locator('.dres-artist')).toHaveText(BAND);   // escaped, not markup
    await expect(main(page).locator('b')).toHaveCount(0);
    await expect(main(page).locator('.dres-meta')).toHaveText('Friday · Main Stage · 17:00');
    await expect(main(page).locator('.dres-lbl')).toHaveText('Showtime in');
    await expect(main(page).locator('.dres-cd')).toHaveText('1:00:00');
    await st.advance(1000);
    await expect(main(page).locator('.dres-cd')).toHaveText('59:59');
    await page.clock.fastForward(58 * 60 * 1000);   // jump; then one tick
    await st.advance(250);
    await expect(main(page).locator('.dres-cd')).toHaveText('01:59');
    await expect(video(page)).toHaveCount(0);
    await expect(page.locator('#dres-img')).toHaveCount(0);
    // the feed asked for this mode, on every request
    const calls = backend.calls({ method: 'POST', path: RPC });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((c) => c.body.p_mode)).toEqual(calls.map(() => 'dressing'));
    expect(page.url()).toContain(`mode=dressing&pid=${PID}&shid=m3`);
  });

  test('flips to "On stage now" at the start and counts the set down', async ({ page, st }) => {
    await openDres(st, 'm3', '16:59:58.400');
    await expect(main(page).locator('.dres-cd')).toHaveText('00:02');
    await st.advance(1000);
    await expect(main(page).locator('.dres-cd')).toHaveText('00:01');
    await st.advance(1000);
    await expect(page.locator('#dres')).toHaveAttribute('data-state', 'live');
    await expect(main(page).locator('.dres-lbl')).toHaveText('On stage now');
    await expect(main(page).locator('.dres-cd')).toHaveText('1:15:00');
    await expect(main(page).locator('.dres-sub')).toHaveText('left in the set');
  });

  test('live: remaining set time', async ({ page, st }) => {
    await openDres(st, 'm3', '17:30:00.400');
    await expect(main(page).locator('.dres-lbl')).toHaveText('On stage now');
    await expect(main(page).locator('.dres-cd')).toHaveText('45:00');
    await st.advance(1000);
    await expect(main(page).locator('.dres-cd')).toHaveText('44:59');
  });

  test('more than a day ahead: "N days" and the date', async ({ page, st }) => {
    await openDres(st, 'm8', '16:00:00.400');   // Saturday 20:00, 28 h ahead
    await expect(main(page).locator('.dres-meta')).toHaveText('Saturday · Main Stage · 20:00');
    await expect(main(page).locator('.dres-cd')).toHaveText('1 day');
    await expect(main(page).locator('.dres-sub')).toHaveText('Sat 11 Jul · 20:00');
  });

  test('after: calm thank-you, signed by the artist team; no logo = text only', async ({ page, st }) => {
    await openDres(st, 'm3', '18:20:00.400');
    await expect(page.locator('#dres')).toHaveAttribute('data-state', 'after');
    await expect(main(page).locator('.dres-ty')).toHaveText('Thank you so much for the amazing show!');
    await expect(main(page).locator('.dres-artist')).toHaveText(BAND);
    await expect(main(page).locator('.dres-sig')).toHaveText('— Thanks from the artist team');
    await expect(main(page).locator('.dres-logo')).toHaveCount(0);
    await expect(main(page).locator('.dres-cd')).toHaveCount(0);
    await expect(page.locator('#dres-media')).toBeEmpty();
  });

  test('a show that is gone (or a wrong shid): friendly message', async ({ page, st, backend }) => {
    await openDres(st, 'nope', '16:00');
    await expect(main(page)).toHaveText('This artist is no longer in the schedule. Ask the production team for a new link.');
    await openDres(st, 'm3', '16:00:00.400');
    await expect(main(page).locator('.dres-lbl')).toHaveText('Showtime in');
    backend.updateProject(PID, (d) => { d.shows = d.shows.filter((s) => s.id !== 'm3'); });
    await pollStep(page);
    await expect(main(page)).toHaveText(/no longer in the schedule/);
  });

  test('cancelled: neutral message, no countdown', async ({ page, st }) => {
    await openDres(st, 'm5', '16:00');
    await expect(page.locator('#dres')).toHaveAttribute('data-state', 'cancelled');
    await expect(main(page).locator('.dres-artist')).toHaveText('Cancelled Act');
    await expect(main(page).locator('.dres-note')).toHaveText('This show has been cancelled. Ask the production team for details.');
    await expect(main(page).locator('.dres-cd')).toHaveCount(0);
  });

  test('hidden from public screens: still on its own dressing room link', async ({ page, st, backend }) => {
    await openDres(st, 't1', '15:30:00.400');
    await expect(main(page).locator('.dres-artist')).toHaveText('Hidden Guest');
    await expect(main(page).locator('.dres-lbl')).toHaveText('On stage now');
    await expect(main(page).locator('.dres-cd')).toHaveText('30:00');
    await pollStep(page);
    const row = JSON.parse(await page.evaluate(() => _pvLastText));
    expect(row.data.shows.find((s) => s.id === 't1').hidden).toBe(true);   // the feed keeps it
    expect(backend.violations).toEqual([]);
  });

  test('a project that does not exist: the shared "Project not found."', async ({ page, st, backend }) => {
    backend.setRpc('get_shared_project', () => ({ json: null }));
    await st.installClock(at('16:00'));
    await page.goto(`/app.html?mode=dressing&pid=missing&shid=m3`);
    await expect(page.locator('#loader')).toHaveText('Project not found.');
  });

  test('kiosk: keeps the screen awake (re-acquired after the tab returns), no pinch-zoom', async ({ page, st }) => {
    await page.addInitScript(() => {
      window.__wl = [];
      const make = () => { const ls = []; return { addEventListener: (t, f) => { if (t === 'release') ls.push(f); }, release: async () => {}, _fire() { ls.forEach((f) => f()); } }; };
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async (type) => { const s = make(); window.__wl.push({ type, s }); return s; } } });
    });
    await openDres(st, 'm3', '16:00:00.400');
    await expect.poll(() => page.evaluate(() => window.__wl.map((x) => x.type))).toEqual(['screen']);
    await page.evaluate(() => { window.__wl[0].s._fire(); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => page.evaluate(() => window.__wl.length)).toBe(2);
    await expect(page.locator('meta[name=viewport]')).toHaveAttribute('content', /maximum-scale=1\.0, user-scalable=no/);
  });

  test('nothing to tap; the top-left corner is free for the native hidden exit', async ({ page, st }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openDres(st, 'm3', '16:00:00.400');
    expect(await page.locator('#dres').locator('a,button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[onclick]').count()).toBe(0);
    const hits = await page.evaluate(() => {
      const out = [];
      for (let x = 2; x < 120; x += 20) for (let y = 2; y < 120; y += 20) {
        for (const el of document.elementsFromPoint(x, y)) if (el.closest('a,button,input,select,textarea') || getComputedStyle(el).cursor === 'pointer') out.push(el.tagName + '#' + el.id);
      }
      return out;
    });
    expect(hits).toEqual([]);
  });
});

// ── Video and photo ───────────────────────────────────────────────────────
test.describe('background video', () => {
  test.use({ stSeed: seedWith((d) => { showIn(d, 'm3').bgVideo = VID; showIn(d, 'm3').bgImage = PHOTO_PNG; showIn(d, 'm2').bgVideo = BROKEN; showIn(d, 'm2').bgImage = PHOTO_PNG; }) });

  test('a muted, looping, inline <video> with that src; plays behind the text', async ({ page, st, browserName }) => {
    await openDres(st, 'm3', '16:00:00.400');
    const v = video(page);
    await expect(v).toHaveCount(1);
    for (const a of ['muted', 'loop', 'playsinline', 'autoplay', 'disablepictureinpicture']) await expect(v).toHaveAttribute(a, '');
    await expect(v).toHaveAttribute('preload', 'auto');
    expect(await v.evaluate((e) => [e.muted, e.defaultMuted, e.loop, e.src, getComputedStyle(e).objectFit, getComputedStyle(e).pointerEvents])).toEqual([true, true, true, VID, 'cover', 'none']);
    await expect(page.locator('#dres-img')).toHaveCount(0);   // the video wins over the photo
    // Playwright's Chromium decodes VP8; whether WebKit does is up to the build.
    if (browserName === 'chromium') await expect(v).toHaveClass(/\bon\b/);
    await expect(main(page).locator('.dres-cd')).toHaveText('1:00:00');   // never waits for the video
  });

  test('ticks and polls never touch the video; a changed bgVideo resets only its src', async ({ page, st, backend }) => {
    await spyVideoSrc(page);
    await openDres(st, 'm3', '16:00:00.400');
    await expect(video(page)).toHaveCount(1);
    await page.evaluate(() => { document.getElementById('dres-video').__mark = 1; });
    for (let i = 0; i < 3; i++) await pollStep(page);
    backend.updateProject(PID, (d) => { showIn(d, 'm1').artist = 'Renamed Elsewhere'; showIn(d, 'm3').start = '17:00:00'; });
    await pollStep(page);
    await st.advance(2000);
    expect(await page.evaluate(() => [document.getElementById('dres-video').__mark, window.__srcSets])).toEqual([1, [VID]]);
    backend.updateProject(PID, (d) => { showIn(d, 'm3').bgVideo = SLOW; });
    await pollStep(page);
    await expect.poll(() => page.evaluate(() => window.__srcSets)).toEqual([VID, SLOW]);
    expect(await page.evaluate(() => [document.getElementById('dres-video').__mark, document.getElementById('dres-video').src])).toEqual([1, SLOW]);
    await st.advance(3000);
    expect(await page.evaluate(() => window.__srcSets)).toEqual([VID, SLOW]);
  });

  test('a video that cannot play falls back to the photo; the countdown is unaffected', async ({ page, st }) => {
    await openDres(st, 'm2', '15:00:00.400');
    await expect(page.locator('#dres-img')).toHaveClass(/\bon\b/);
    await expect(video(page)).toBeHidden();
    expect(await page.locator('#dres-img').evaluate((e) => [e.getAttribute('src'), e.classList.contains('dres-dim')])).toEqual([PHOTO_PNG, false]);
    await expect(main(page).locator('.dres-cd')).toHaveText('30:00');
  });

  test('removing the video shows the photo; removing both leaves it dark', async ({ page, st, backend }) => {
    await openDres(st, 'm3', '16:00:00.400');
    await expect(video(page)).toHaveCount(1);
    backend.updateProject(PID, (d) => { delete showIn(d, 'm3').bgVideo; });
    await pollStep(page);
    await expect(video(page)).toBeHidden();
    expect(await video(page).evaluate((e) => e.hasAttribute('src'))).toBe(false);
    await expect(page.locator('#dres-img')).toHaveAttribute('src', PHOTO_PNG);
    backend.updateProject(PID, (d) => { delete showIn(d, 'm3').bgImage; });
    await pollStep(page);
    await expect(page.locator('#dres-img')).toHaveCount(0);
  });

  test('after the show the video pauses and hides; the photo dims behind the thank-you', async ({ page, st }) => {
    await openDres(st, 'm3', '18:14:58.400');
    await expect(video(page)).toBeVisible();
    await st.advance(2000);
    await expect(page.locator('#dres')).toHaveAttribute('data-state', 'after');
    expect(await video(page).evaluate((e) => [e.hidden, e.paused])).toEqual([true, true]);
    await expect(page.locator('#dres-img')).toHaveClass(/dres-dim/);
    await expect(page.locator('#dres-img')).toHaveAttribute('src', PHOTO_PNG);
  });

  test('the same screen on the full legacy feed', async ({ page, st, backend }) => {
    backend.shareFeed('legacy');
    await spyVideoSrc(page);
    await openDres(st, 'm3', '16:00:00.400');
    await expect(video(page)).toHaveAttribute('src', VID);
    await pollStep(page);
    expect(await page.evaluate(() => window.__srcSets)).toEqual([VID]);
  });
});

test.describe('only a video link that is safe to play', () => {
  test('_safeVideoSrc', async ({ page, st }) => {
    await openDres(st, 'm3', '16:00');
    const r = await page.evaluate(() => [
      'https://cdn.example.com/clips/intro.mp4', 'https://x.test/a b.mov?t=1#x', `${_MEDIA_PUB}proj-fest/abc.mp4`,
      'http://cdn.example.com/a.mp4', 'javascript:alert(1)', 'data:video/mp4;base64,AAAA', 'blob:https://x/1',
      'https://user:pw@cdn.example.com/a.mp4', '//cdn.example.com/a.mp4', 'cdn.example.com/a.mp4', '',
      'https://x.test/' + 'a'.repeat(2000), null, 42, { href: 'https://x.test' },
    ].map((v) => _safeVideoSrc(v)));
    expect(r).toEqual(['https://cdn.example.com/clips/intro.mp4', 'https://x.test/a b.mov?t=1#x', expect.stringContaining('/project-media/proj-fest/abc.mp4'),
      '', '', '', '', '', '', '', '', '', '', '', '']);
  });
  test.describe('a stored unsafe value never reaches the video', () => {
    test.use({ stSeed: seedWith((d) => { showIn(d, 'm3').bgVideo = 'javascript:alert(1)'; showIn(d, 'm3').bgImage = 'https://evil.example/pixel.png'; }) });
    test('no video element, no photo', async ({ page, st }) => {
      await openDres(st, 'm3', '16:00:00.400');
      await expect(video(page)).toHaveCount(0);
      await expect(page.locator('#dres-img')).toHaveCount(0);
      await expect(main(page).locator('.dres-cd')).toHaveText('1:00:00');
    });
  });
});

// ── Logo on the thank-you ─────────────────────────────────────────────────
test.describe('thank-you logo', () => {
  // branding switches the logo OFF on Backstage and FOH: the dressing room
  // shows it anyway (the customer's own thank-you to the artist).
  test.use({ stSeed: seedWith((d) => { d.logo = LOGO; d.branding = { logoBackstage: false, logoFoh: false, logoBackdrop: true }; showIn(d, 'm3').bgVideo = VID; }) });

  for (const feed of ['legacy', 'modes']) {
    test(`${feed} feed: centred logo on a white plate, then the text`, async ({ page, st, backend }) => {
      backend.shareFeed(feed);
      await openDres(st, 'm3', '18:20:00.400');
      const logo = main(page).locator('img.dres-logo');
      await expect(logo).toHaveAttribute('src', LOGO);
      await expect(logo).toHaveClass(/dres-plate/);
      await expect(logo).toHaveAttribute('alt', 'Zomerfeest 2026 logo');
      await expect(main(page).locator('.dres-ty')).toBeVisible();
      await expect(page.locator('#dres-media')).toBeEmpty();   // no photo, video stopped: dark
      const via = await page.evaluate(() => window._sharedProjectVia);
      expect(via).toBe(feed === 'legacy' ? 'pid' : 'mode');
    });
  }

  test('a server that strips the logo for this mode (older migration): text only', async ({ page, st, backend }) => {
    backend.setRpc('get_shared_project', (body) => {
      const p = backend.project(PID);
      const data = JSON.parse(JSON.stringify(p.data));
      delete data.logo;
      return { json: { id: p.id, name: p.name, company_id: null, data } };
    });
    await openDres(st, 'm3', '18:20:00.400');
    await expect(main(page).locator('.dres-ty')).toHaveText('Thank you so much for the amazing show!');
    await expect(main(page).locator('img')).toHaveCount(0);
  });

  test('the RPC: logo and background photo for dressing only', async ({ backend }) => {
    backend.updateProject(PID, (d) => { showIn(d, 'm3').bgImage = PHOTO_PNG; });
    const get = async (mode) => (await backend._rpc('get_shared_project', { p_id: PID, p_mode: mode })).json.data;
    const dres = await get('dressing'), stage = await get('stage');
    expect([dres.logo, showIn(dres, 'm3').bgImage, showIn(dres, 'm3').bgVideo]).toEqual([LOGO, PHOTO_PNG, VID]);
    expect(['logo' in stage, 'bgImage' in showIn(stage, 'm3'), showIn(stage, 'm3').bgVideo]).toEqual([false, false, VID]);
    for (const k of ['photo', 'rider', 'note', 'crew']) expect(dres.shows.some((s) => k in s), k).toBe(false);
  });
});

// ── Layout ────────────────────────────────────────────────────────────────
test.describe('layout', () => {
  test.use({ stSeed: seedWith((d) => { d.logo = LOGO; }) });
  for (const [w, h] of [[1024, 768], [768, 1024], [390, 844]]) {
    for (const t of ['16:00:00.400', '17:30:00.400', '18:20:00.400']) {
      test(`${w}x${h} at ${t.slice(0, 5)}: nothing overflows, the countdown fits`, async ({ page, st }) => {
        await page.setViewportSize({ width: w, height: h });
        await openDres(st, 'm3', t);   // one boot per test: the fake clock is installed once per page
        const r = await page.evaluate(() => {
          const els = [...document.querySelectorAll('#dres-main > *')];
          return { doc: document.scrollingElement.scrollWidth - innerWidth, out: els.filter((e) => { const b = e.getBoundingClientRect(); return b.left < 0 || b.right > innerWidth + 0.5 || b.top < 0 || b.bottom > innerHeight + 0.5 || e.scrollWidth > e.clientWidth + 1; }).map((e) => e.className) };
        });
        expect(r.doc).toBeLessThanOrEqual(0);
        expect(r.out, 'out of the screen').toEqual([]);
        await shot(page, `${w}x${h}-${t.slice(0, 5).replace(':', '')}.png`);
      });
    }
  }
});

// Simulator, 2026-10-20: the 3 s hold for the native app's hidden exit also
// started iOS text selection on this screen; its Copy/Look Up callout then
// swallowed the taps on the exit menu. Nothing on the screen is selectable.
test('nothing on the screen can be selected (the hidden-exit hold is a long press)', async ({ page, st }) => {
  await openDres(st, 'm3', '16:00:00.400');
  await expect(page.locator('#dres')).toHaveClass(/open/);
  const sel = await page.evaluate(() => [...document.querySelectorAll('#dres, #dres-main *')].map((e) => getComputedStyle(e).webkitUserSelect || getComputedStyle(e).userSelect));
  expect(new Set(sel)).toEqual(new Set(['none']));
});

// ── Thank-you wording per festival (data.dressing) ─────────────────────────
// Owner request 2026-10-20: the thank-you text is set per festival, e.g. for
// AMF in the Johan Cruijff ArenA. Empty = the defaults.
test.describe('thank-you wording per festival', () => {
  test.use({ stSeed: seedWith((d) => { d.logo = LOGO; d.dressing = { thanks: 'Thank you for an <b>unforgettable</b> night at AMF!', signature: '— With love from the AMF artist team' }; }) });
  test('the screen uses the project\'s words, escaped, without a double dash', async ({ page, st }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openDres(st, 'm3', '18:20:00.400');
    await expect(page.locator('#dres')).toHaveAttribute('data-state', 'after');
    await expect(main(page).locator('.dres-ty')).toHaveText('Thank you for an <b>unforgettable</b> night at AMF!');
    await expect(main(page).locator('b')).toHaveCount(0);
    await expect(main(page).locator('.dres-sig')).toHaveText('— With love from the AMF artist team');
    await shot(page, 'custom-thank-you.png');
  });
});
test('thank-you wording: blank or odd stored values fall back to the defaults', async ({ page, st }) => {
  const r = await (async () => { await openDres(st, 'm3', '18:20:00.400'); return page.evaluate(() => [_dresTexts({}), _dresTexts({ dressing: { thanks: '   ', signature: '—' } }), _dresTexts({ dressing: [] }), _dresTexts({ dressing: { thanks: 42, signature: 'x'.repeat(300) } })]); })();
  const def = { thanks: 'Thank you so much for the amazing show!', signature: 'Thanks from the artist team' };
  expect(r[0]).toEqual(def);
  expect(r[1]).toEqual(def);
  expect(r[2]).toEqual(def);
  expect(r[3]).toEqual({ thanks: def.thanks, signature: 'x'.repeat(160) });
});

// ── Operator side ─────────────────────────────────────────────────────────
test.describe('show editor', () => {
  test.use({ stAuth: 'admin' });
  const serverShow = (backend, id) => backend.project(PID).data.shows.find((s) => s.id === id);
  async function openEditor(page, st, id) {
    await st.gotoApp({ at: at('16:00') });
    await st.openProject();
    await page.evaluate((x) => openDrawer(x), id);
    await page.locator('#drawer.open').waitFor();
  }

  test('project menu: thank-you wording saved per festival, prefilled, cleared = defaults', async ({ page, st, backend }) => {
    await st.gotoApp({ at: at('16:00') });
    await st.openProject();
    await expect(page.locator('.dd-item[onclick*="openDressingSettings"]')).toHaveCount(1);
    await page.evaluate(() => { openDressingSettings(APP.activeProjectId); });
    const d = page.locator('.st-dlg[role="dialog"]');
    await expect(d).toBeVisible();
    await expect(d.getByLabel('Thank-you message')).toHaveAttribute('placeholder', 'Thank you so much for the amazing show!');
    await d.getByLabel('Thank-you message').fill('Thank you for an unforgettable night at AMF!');
    await d.getByLabel('Signed by').fill('— With love from the AMF artist team');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d).toHaveCount(0);
    await expect.poll(() => backend.project(PID).data.dressing).toEqual({ thanks: 'Thank you for an unforgettable night at AMF!', signature: 'With love from the AMF artist team' });
    await page.evaluate(() => { openDressingSettings(APP.activeProjectId); });
    await expect(d.getByLabel('Thank-you message')).toHaveValue('Thank you for an unforgettable night at AMF!');
    await d.getByLabel('Thank-you message').fill('');
    await d.getByLabel('Signed by').fill('');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => 'dressing' in backend.project(PID).data).toBe(false);
  });

  test('video link: checked while typing, saved as show.bgVideo, cleared = key removed', async ({ page, st, backend }) => {
    await openEditor(page, st, 'm3');
    await expect(page.locator('#f-video-hint')).toHaveText('Link to an MP4 video (muted, loops). Tip: keep it short and under ~50 MB.');
    await page.locator('#f-video').fill('http://cdn.example.com/a.mp4');
    await expect(page.locator('#f-video-err')).toHaveText(/starts with https:\/\//);
    await page.locator('#dr-save').click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);   // not saved
    await expect(page.locator('#f-video')).toBeFocused();
    await page.locator('#f-video').fill(`  ${VID}  `);
    await expect(page.locator('#f-video-err')).toBeHidden();
    await page.locator('#dr-save').click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    await expect.poll(() => serverShow(backend, 'm3').bgVideo).toBe(VID);
    await page.evaluate(() => openDrawer('m3'));
    await expect(page.locator('#f-video')).toHaveValue(VID);
    await page.locator('#f-video-clear').click();
    await expect(page.locator('#f-video')).toHaveValue('');
    await page.locator('#dr-save').click();
    await expect.poll(() => 'bgVideo' in serverShow(backend, 'm3')).toBe(false);
    expect(serverShow(backend, 'm3').artist).toBe(BAND);
  });

  test('background photo: compressed, uploaded like the artist photo, removed again', async ({ page, st, backend }) => {
    await openEditor(page, st, 'm3');
    await expect(page.locator('#f-bg-wrap')).toBeHidden();
    const png = Buffer.from(PHOTO_PNG.split(',')[1], 'base64');
    await page.setInputFiles('#f-bg', { name: 'bg.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => _bgImg && !_bgImgUp);
    await expect(page.locator('#f-bg-wrap')).toBeVisible();
    await page.locator('#dr-save').click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    await expect.poll(() => serverShow(backend, 'm3').bgImage || '').toMatch(/^(https:\/\/\S+\/project-media\/proj-fest\/[0-9a-f]{32}\.jpg|data:image\/jpeg;base64,)/);
    const url = serverShow(backend, 'm3').bgImage;
    expect(serverShow(backend, 'm3').photo).toBe('');   // the artist photo is untouched
    await page.evaluate(() => openDrawer('m3'));
    await expect(page.locator('#f-bg-wrap')).toBeVisible();
    await page.locator('#f-bg-clear').click();
    await page.locator('#dr-save').click();
    await expect.poll(() => 'bgImage' in serverShow(backend, 'm3')).toBe(false);
    if (url.startsWith('https:')) await expect.poll(() => backend.storage.objects.has(url.split('/project-media/')[1])).toBe(false);
  });

  test('not an image: the dialog says so, nothing changes', async ({ page, st }) => {
    await openEditor(page, st, 'm3');
    await page.setInputFiles('#f-bg', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.getByRole('alertdialog').or(page.getByRole('dialog', { name: /not added/ }))).toContainText('is not an image');
  });

  test('a saved show offers its dressing room link; a new show does not', async ({ page, st }) => {
    await openEditor(page, st, 'm3');
    const row = page.locator('#f-dres-link .share-link-row[data-mode="dressing"]');
    await expect(row.locator('.share-link-url')).toHaveText(/\/app\.html\?mode=dressing&pid=proj-fest&shid=m3$/);
    await expect(row.locator('.share-access')).toHaveText('Read-only');
    await expect(row.getByRole('button', { name: 'Copy Dressing room link link' })).toBeVisible();
    await page.evaluate(() => closeDrawer(true));
    await page.evaluate(() => openDrawer(null));
    await expect(page.locator('#f-dres-link')).toBeEmpty();
    await expect(page.locator('#f-video')).toHaveValue('');
  });

  test('lineup import: optional "video" per act', async ({ page, st }) => {
    await st.gotoApp({ at: at('16:00') });
    await st.openProject();
    const plan = await page.evaluate((vid) => _planLineupImport([
      { stage: 'Main Stage', artist: 'With video', start: '2026-07-12T12:00', end: '2026-07-12T13:00', video: vid },
      { stage: 'Main Stage', artist: 'Bad video', start: '2026-07-12T13:00', end: '2026-07-12T14:00', video: 'youtube.com/watch?v=x' },
      { stage: 'Main Stage', artist: 'No video', start: '2026-07-12T14:00', end: '2026-07-12T15:00' },
    ]), VID);
    expect(plan.shows.map((r) => [r.show.artist, r.show.bgVideo])).toEqual([['With video', VID], ['No video', undefined]]);
    expect(plan.invalid.map((r) => r.reason)).toEqual(['video "youtube.com/watch?v=x" is not an https link']);
  });
});

test.describe('share dialog', () => {
  test.use({ stAuth: 'admin' });
  test('per stage, a collapsed list of dressing room links by day', async ({ page, st }) => {
    await st.gotoApp({ at: at('16:00') });
    await page.evaluate((pid) => openShareModal(pid), PID);
    const main = page.locator('.share-stage-block', { has: page.locator('.share-stage-name', { hasText: 'Main Stage' }) });
    const dres = main.locator('details.share-dres');
    await expect(dres).not.toHaveAttribute('open', '');
    await expect(dres.locator('summary')).toHaveText(/Dressing room screens\s+7 artists/);   // m1-m4, m6, m7, m8; not cancelled m5
    await dres.locator('summary').click();
    await expect(dres.locator('.share-dres-day')).toHaveText(['Vrijdag · Fri 10 Jul', 'Zaterdag · Sat 11 Jul']);
    const labels = await dres.locator('.share-link-label').allTextContents();
    expect(labels.slice(0, 2)).toEqual(['Opening Act · 14:00', "DJ O'Neil · 15:30"]);
    expect(labels.join('|')).not.toContain('Cancelled Act');
    await expect(dres.locator('.share-link-row[data-mode="dressing"]', { hasText: "DJ O'Neil" }).locator('.share-link-url')).toHaveText(/\?mode=dressing&pid=proj-fest&shid=m2$/);
    for (const a of await dres.locator('.share-access').allTextContents()) expect(a).toBe('Read-only');
    // a hidden show has its link (the artist's own screen)
    const tent = page.locator('.share-stage-block', { has: page.locator('.share-stage-name', { hasText: 'The Tent' }) });
    await expect(tent.locator('.share-link-row[data-mode="dressing"]', { hasText: 'Hidden Guest' })).toHaveCount(1);
  });
});
