// Project logo (co-branding), feature/project-logo.
//
// The owner uploads a logo per project from the dashboard row (or Project
// settings). It shows top-left on Backstage (default on) and, when switched
// on, on FOH: in the app and on the backstage / foh share links. The
// stagetimer.nl mark stays in the same header. Stage View, the Wall and the
// other share modes never get the logo (get_shared_project p_mode matrix,
// tests/support/share-modes.js). Only data:image/* or our own Storage URL is
// ever rendered.
const zlib = require('zlib');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');
const { SHARE_MODES } = require('../support/share-modes');

const PID = FESTIVAL.projectId;
const AT = ams(FESTIVAL.dates.d1, '16:00');
const URL_RE = /^https:\/\/bamjpsquhdzxvsymldpq\.supabase\.co\/storage\/v1\/object\/public\/project-media\/proj-fest\/[0-9a-f]{32}\.png$/;
const ROW_BTN = 'Project logo of Zomerfeest 2026';

// ── Real, decodable RGBA PNGs (the app draws them on a canvas).
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function rgbaPng(w, h, px) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A wide logo: a bar of "ink" in the middle, transparent around it.
const inkLogo = (rgb) => rgbaPng(240, 60, (x, y) => (y > 15 && y < 45 && x > 10 && x < 230 ? [...rgb, 255] : [0, 0, 0, 0]));
const WHITE_LOGO = inkLogo([255, 255, 255]);   // white on transparent: fine on the dark screens
const NAVY_LOGO = inkLogo([27, 20, 100]);      // dark ink on transparent: needs the white plate
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

const patches = (backend) => backend.calls({ method: 'PATCH', path: '/rest/v1/projects' });
const serverData = (backend) => backend.project(PID).data;
const box = (loc) => loc.boundingBox();
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function openLogoDialog(page) {
  await page.getByRole('button', { name: ROW_BTN }).click();
  const dlg = page.getByRole('dialog', { name: 'Project logo' });
  await expect(dlg).toBeVisible();
  return dlg;
}
async function upload(page, dlg, buffer, name = 'logo.png', mimeType = 'image/png') {
  const chooser = page.waitForEvent('filechooser');
  await dlg.getByRole('button', { name: /^(Upload|Replace) logo$/ }).click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}
// Header of a view: customer logo top-left, stagetimer.nl mark visible, nothing overlapping.
async function expectCoBranded(page, view) {
  const root = page.locator(`#${view}`);
  await expect(root).toHaveClass(/vw-logo-on/);
  const logo = page.locator(`#vw-logo-${view}`);
  const mark = page.locator(`#${view} .vw-st-mark`);
  const clock = page.locator(`#${view}-clock`);
  await expect(logo).toBeVisible();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('aria-label', 'Powered by stagetimer.nl');
  await expect.poll(() => logo.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
  const [l, m, c] = [await box(logo), await box(mark), await box(clock)];
  expect(l.x).toBeLessThan(40);
  expect(l.y).toBeLessThan(40);
  expect(l.height).toBeLessThanOrEqual(36);
  expect(overlap(l, m) || overlap(l, c) || overlap(m, c)).toBe(false);
  // Every visible header item stays inside the viewport and none overlap the logo.
  const vw = page.viewportSize().width;
  const items = await page.locator(`#${view}-hdr > *`).evaluateAll((els) => els
    .filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none')
    .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, x: r.x, y: r.y, width: r.width, height: r.height }; }));
  for (const it of items) {
    expect(it.x + it.width, `${it.id} inside the viewport`).toBeLessThanOrEqual(vw + 0.5);
    if (!/vw-logo/.test(it.id)) expect(overlap(it, l), `${it.id} clear of the logo`).toBe(false);
  }
}
async function expectNoLogo(page, view) {
  await expect(page.locator(`#${view}`)).not.toHaveClass(/vw-logo-on/);
  await expect(page.locator(`#vw-logo-${view}`)).toBeHidden();
  await expect(page.locator(`#${view} .vw-st-mark`)).toBeHidden();
}

test.describe('owner (dashboard)', () => {
  test.use({ stAuth: 'admin' });

  test('upload from the dashboard row: Storage URL in the blob, previews, Backstage shows it top-left next to stagetimer.nl', async ({ page, st, backend }) => {
    await st.gotoApp({ at: AT });
    const dlg = await openLogoDialog(page);
    await expect(dlg.getByText('No logo yet')).toHaveCount(2);
    await expect(dlg.getByRole('checkbox', { name: /Show on Backstage/ })).toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: /Show on Front of House/ })).not.toBeChecked();
    await upload(page, dlg, WHITE_LOGO);
    await expect.poll(() => serverData(backend).logo || '').toMatch(URL_RE);
    const url = serverData(backend).logo;
    expect(serverData(backend).branding).toEqual({ logoBackstage: true, logoFoh: false, logoBackdrop: false });
    const obj = backend.storage.objects.get(url.split('/project-media/')[1]);
    expect(obj.type).toBe('image/png');
    expect(obj.buf.subarray(1, 4).toString()).toBe('PNG');
    // Preview on the dark production black and on white, with the same image.
    await expect(dlg.locator('img.st-logo-img')).toHaveCount(2);
    for (const img of await dlg.locator('img.st-logo-img').all()) await expect(img).toHaveAttribute('src', url);
    await expect(dlg.locator('.st-logo-sw.dark .vw-st-mark')).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Replace logo' })).toBeVisible();
    await expect(page.getByRole('button', { name: ROW_BTN })).toHaveClass(/has-logo/);
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(dlg).toBeHidden();

    await st.openProject();
    await page.evaluate(() => openBS());
    await expect(page.locator('#vw-logo-bs')).toHaveAttribute('src', url);
    await expect(page.locator('#vw-logo-bs')).toHaveAttribute('alt', 'Zomerfeest 2026 logo');
    await expectCoBranded(page, 'bs');
    await expect(page.locator('#bs')).not.toHaveClass(/vw-logo-bd/);
    // FOH is off by default.
    await page.evaluate(() => openFOH());
    await expectNoLogo(page, 'foh');
  });

  test('no Storage bucket yet: the logo stays inline (base64), as before', async ({ page, st, backend }) => {
    backend.storage.bucketMissing = true;
    await st.gotoApp({ at: AT });
    const dlg = await openLogoDialog(page);
    await upload(page, dlg, WHITE_LOGO);
    await expect.poll(() => serverData(backend).logo || '').toMatch(/^data:image\/png;base64,/);
    expect(backend.storage.objects.size).toBe(0);
    await expect(dlg.locator('.st-logo-sw.light img.st-logo-img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  });

  test('toggles: FOH on, Backstage off, white plate for dark ink (auto, can be switched off); Project settings opens the same dialog', async ({ page, st, backend }) => {
    await st.gotoApp({ at: AT });
    await st.openProject();
    await page.locator('#admin-dd > .hbtn').click();
    await page.getByRole('button', { name: 'Project logo' }).click();
    const dlg = page.getByRole('dialog', { name: 'Project logo' });
    await expect(dlg).toBeVisible();
    await upload(page, dlg, NAVY_LOGO);
    await expect.poll(() => serverData(backend).branding).toEqual({ logoBackstage: true, logoFoh: false, logoBackdrop: true });
    await expect(dlg.getByRole('checkbox', { name: /White plate/ })).toBeChecked();
    await expect(dlg.locator('.st-logo-sw.dark')).toHaveClass(/\bbd\b/);

    await dlg.getByRole('checkbox', { name: /Show on Front of House/ }).check();
    await expect.poll(() => serverData(backend).branding.logoFoh).toBe(true);
    await dlg.getByRole('checkbox', { name: /Show on Backstage/ }).uncheck();
    await expect.poll(() => serverData(backend).branding.logoBackstage).toBe(false);
    await dlg.getByRole('button', { name: 'Done' }).click();

    await page.evaluate(() => openFOH());
    await expectCoBranded(page, 'foh');
    await expect(page.locator('#foh')).toHaveClass(/vw-logo-bd/);
    expect(await page.locator('#vw-logo-foh').evaluate((i) => getComputedStyle(i).backgroundColor)).toBe('rgb(255, 255, 255)');
    await page.evaluate(() => openBS());
    await expectNoLogo(page, 'bs');

    // The plate is a suggestion: the owner can switch it off.
    await page.evaluate(() => { closeBS(); openProjectLogo(APP.activeProjectId); });
    await page.getByRole('dialog', { name: 'Project logo' }).getByRole('checkbox', { name: /White plate/ }).uncheck();
    await expect.poll(() => serverData(backend).branding.logoBackdrop).toBe(false);
    await page.getByRole('dialog', { name: 'Project logo' }).getByRole('button', { name: 'Done' }).click();
    await page.evaluate(() => openFOH());
    await expect(page.locator('#foh')).not.toHaveClass(/vw-logo-bd/);
  });

  test('remove: confirm, blob cleared, Storage object deleted after the save, screens drop it', async ({ page, st, backend }) => {
    await st.gotoApp({ at: AT });
    let dlg = await openLogoDialog(page);
    await upload(page, dlg, WHITE_LOGO);
    await expect.poll(() => serverData(backend).logo || '').toMatch(URL_RE);
    await dlg.getByRole('button', { name: 'Done' }).click();
    await st.openProject();
    await page.evaluate(() => openBS());
    await expectCoBranded(page, 'bs');

    await page.evaluate(() => { closeBS(); openProjectLogo(APP.activeProjectId); });
    dlg = page.getByRole('dialog', { name: 'Project logo' });
    await dlg.getByRole('button', { name: 'Remove logo' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove the logo?' });
    await confirm.getByRole('button', { name: 'Remove logo' }).click();
    await expect.poll(() => serverData(backend).logo).toBeNull();
    await expect.poll(() => backend.storage.objects.size).toBe(0);
    await expect(dlg.getByText('No logo yet')).toHaveCount(2);
    await expect(dlg.getByRole('button', { name: 'Remove logo' })).toBeHidden();
    await dlg.getByRole('button', { name: 'Done' }).click();
    await page.evaluate(() => openBS());
    await expectNoLogo(page, 'bs');
  });

  test('a logo from another device arrives over realtime', async ({ page, st, backend }) => {
    await st.gotoApp({ at: AT });
    await st.openProject();
    await page.evaluate(() => openBS());
    await expectNoLogo(page, 'bs');
    await expect.poll(() => backend.realtime.subscriberCount('projects')).toBeGreaterThan(0);
    backend.updateProject(PID, (d) => { d.logo = dataUrl(WHITE_LOGO); d.branding = { logoBackstage: true, logoFoh: false, logoBackdrop: false }; }, { broadcast: true });
    await expectCoBranded(page, 'bs');
  });

  test('a logo stored before logos were shown stays hidden until switched on', async ({ page, st, backend }) => {
    backend.updateProject(PID, (d) => { d.logo = dataUrl(WHITE_LOGO); });
    await st.gotoApp({ at: AT });
    const dlg = await openLogoDialog(page);
    await expect(dlg.getByRole('status')).toContainText('not shown yet');
    await expect(dlg.getByRole('checkbox', { name: /Show on Backstage/ })).not.toBeChecked();
    await dlg.getByRole('button', { name: 'Done' }).click();
    await st.openProject();
    await page.evaluate(() => openBS());
    await expectNoLogo(page, 'bs');
    await page.evaluate(() => { closeBS(); openProjectLogo(APP.activeProjectId); });
    await page.getByRole('dialog', { name: 'Project logo' }).getByRole('checkbox', { name: /Show on Backstage/ }).check();
    await expect.poll(() => serverData(backend).branding).toEqual({ logoBackstage: true, logoFoh: false, logoBackdrop: false });
    await page.getByRole('dialog', { name: 'Project logo' }).getByRole('button', { name: 'Done' }).click();
    await page.evaluate(() => openBS());
    await expectCoBranded(page, 'bs');
  });

  test('a file that is not an image is refused', async ({ page, st, backend }) => {
    await st.gotoApp({ at: AT });
    const dlg = await openLogoDialog(page);
    await upload(page, dlg, Buffer.from('<script>alert(1)</script>'), 'logo.html', 'text/html');
    await expect(page.getByRole('dialog', { name: 'Logo not added' })).toBeVisible();
    expect(patches(backend)).toEqual([]);
    expect(serverData(backend).logo).toBeUndefined();
  });

  test('390 px: logo, clock, stagetimer.nl mark and close button side by side, nothing overlaps', async ({ page, st, backend }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    backend.updateProject(PID, (d) => {
      d.logo = dataUrl(rgbaPng(600, 120, () => [255, 80, 120, 255]));   // wide, opaque
      d.branding = { logoBackstage: true, logoFoh: true, logoBackdrop: false };
    });
    await st.gotoApp({ at: AT });
    await st.openProject();
    for (const view of ['bs', 'foh']) {
      await page.evaluate((v) => (v === 'bs' ? openBS() : openFOH()), view);
      await expectCoBranded(page, view);
      const close = await box(page.locator(`#${view}-close-btn`));
      expect(overlap(close, await box(page.locator(`#${view} .vw-st-mark`)))).toBe(false);
      await expect(page.locator(`#st-brand-${view}`)).toBeHidden();   // its slot holds the customer logo
    }
  });
});

test.describe('share links', () => {
  test.use({ stSeed: { mutate(seed) {
    const d = seed.projects[0].data;
    d.logo = dataUrl(WHITE_LOGO);
    d.branding = { logoBackstage: true, logoFoh: true, logoBackdrop: false };
  } } });

  for (const [w, h] of [[390, 844], [1440, 900]]) {
    test(`backstage and foh show the logo, stage does not (${w}px)`, async ({ page, st }) => {
      await page.setViewportSize({ width: w, height: h });
      for (const [mode, view] of [['backstage', 'bs'], ['foh', 'foh']]) {
        await st.gotoPublic({ mode, sid: FESTIVAL.stages.main, at: AT });
        expect(await page.evaluate(() => window._sharedProjectVia)).toBe('mode');   // the stripped p_mode feed
        expect(await page.evaluate(() => G.logo)).toMatch(/^data:image\/png;base64,/);
        await expectCoBranded(page, view);
      }
      await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main, at: AT });
      expect(await page.evaluate(() => 'logo' in G)).toBe(false);
      await expect(page.locator('#sv img[src^="data:image/png"]')).toHaveCount(0);
      await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
    });
  }

  // dressing: the thank-you on the artist's dressing room screen (dressing-room.spec.js).
  test('only backstage, foh, dressing and lounge receive the logo from get_shared_project(p_id, p_mode)', async ({ backend }) => {
    for (const mode of [...SHARE_MODES, 'nope']) {
      const r = await backend._rpc('get_shared_project', { p_id: PID, p_mode: mode });
      expect('logo' in r.json.data, mode).toBe(['backstage', 'foh', 'dressing', 'lounge'].includes(mode));
    }
  });

  test('FOH switched off: the foh link shows no logo', async ({ page, st, backend }) => {
    backend.updateProject(PID, (d) => { d.branding.logoFoh = false; });
    await st.gotoPublic({ mode: 'foh', sid: FESTIVAL.stages.main, at: AT });
    await expectNoLogo(page, 'foh');
    await expect(page.locator('#foh-title')).toBeVisible();
  });

  test('a viewer cannot change the logo', async ({ page, st, backend }) => {
    await st.gotoPublic({ mode: 'backstage', sid: FESTIVAL.stages.main, at: AT });
    await expect(page.getByRole('button', { name: /Project logo/ })).toHaveCount(0);
    await page.evaluate(() => { openProjectLogo(PUBLIC_PID); _setLogoBranding(PUBLIC_PID, { logoBackstage: false }); removeProjectLogo(PUBLIC_PID); triggerLogoUpload(PUBLIC_PID); });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.clock.runFor(2000);
    expect(patches(backend)).toEqual([]);
    expect(backend.calls({ method: 'POST', path: /^\/storage\// })).toEqual([]);
    await expectCoBranded(page, 'bs');
  });
});

test.describe('only safe logo URLs are rendered', () => {
  const STORAGE = 'https://bamjpsquhdzxvsymldpq.supabase.co/storage/v1/object/public/project-media/';
  const BAD = {
    'javascript: URL': 'javascript:window.__xss=1',
    'another host': 'https://evil.example/logo.png',
    'markup': '"><img src=x onerror="window.__xss=1">',
    'data: HTML': 'data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9MTwvc2NyaXB0Pg==',
    'data: SVG': 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9IndpbmRvdy5fX3hzcz0xIi8+',
    'image data with a payload': 'data:image/png;base64,AAAA" onerror="window.__xss=1',
    'storage path escape': `${STORAGE}../../../auth/v1/user`,
    'storage URL with a query': `${STORAGE}proj-fest/x.png?x="><b>`,
    'not a string': { src: 'https://evil.example/x.png' },
  };
  for (const [name, logo] of Object.entries(BAD)) {
    test(name, async ({ page, st, backend }) => {
      backend.updateProject(PID, (d) => { d.logo = logo; d.branding = { logoBackstage: true, logoFoh: true }; });
      await st.gotoPublic({ mode: 'backstage', sid: FESTIVAL.stages.main, at: AT });
      await expectNoLogo(page, 'bs');
      expect(await page.locator('#vw-logo-bs').getAttribute('src')).toBeNull();
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(await page.evaluate((v) => _safeLogoSrc(v), logo)).toBe('');
      // (A request to evil.example would also fail the test as a network violation.)
    });
  }
  test('accepted: inline PNG / JPEG and this project-media bucket', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'backstage', sid: FESTIVAL.stages.main, at: AT });
    const ok = [dataUrl(WHITE_LOGO), 'data:image/jpeg;base64,/9j/4AAQ', `${STORAGE}proj-fest/0123456789abcdef0123456789abcdef.png`];
    for (const v of ok) expect(await page.evaluate((x) => _safeLogoSrc(x), v)).toBe(v);
  });
});
