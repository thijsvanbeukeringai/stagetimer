// Photos and logos in Supabase Storage (migration 20261013150000_photo_storage,
// docs/MIGRATIES.md step 16) instead of base64 inside projects.data.
//
// The mock backend serves bucket project-media with the migration's policies;
// backend.storage.bucketMissing = true answers "Bucket not found" like
// production before the migration is applied.
const zlib = require('zlib');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const PID = FESTIVAL.projectId;
const AT = ams(FESTIVAL.dates.d1, '16:00');
const URL_RE = /^https:\/\/bamjpsquhdzxvsymldpq\.supabase\.co\/storage\/v1\/object\/public\/project-media\/proj-fest\/[0-9a-f]{32}\.(jpg|png)$/;

// A real, decodable PNG of random noise (noise does not compress, so the
// photo is a realistic tens of KB after the app's JPEG compression).
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function noisePng(w, h, seed = 1) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = seed;
  for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; raw[i] = i % (w * 3 + 1) === 0 ? 0 : x >> 16; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (buf, type = 'image/png') => `data:${type};base64,${buf.toString('base64')}`;
const projectPatches = (backend) => backend.calls({ method: 'PATCH', path: '/rest/v1/projects' });
const storageCalls = (backend, method) => backend.calls({ method, path: /^\/storage\/v1\/object\/project-media\// });
const serverShow = (backend, id) => backend.project(PID).data.shows.find((s) => s.id === id);

async function openOperator(page, st) {
  await st.gotoApp({ at: AT });
  await st.openProject();
  await page.clock.runFor(500);
}
// Pick a photo for show `id` in the drawer, wait for compression + upload, save.
async function uploadPhoto(page, id, png = noisePng(300, 300)) {
  const before = await page.evaluate((x) => { openDrawer(x); return _photoB64; }, id);
  await page.locator('#drawer.open').waitFor();
  await page.setInputFiles('#f-photo', { name: 'artist.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction((b) => _photoB64 && _photoB64 !== b && !_photoUp, before);
  await page.locator('#dr-save').click();
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
}

test.describe('logged in', () => {
  test.use({ stAuth: 'admin' });

  test('a new photo goes to Storage; the blob holds its URL and the save stays small', async ({ page, st, backend }) => {
    await openOperator(page, st);
    const before = JSON.stringify(backend.project(PID).data).length;
    await uploadPhoto(page, 'm1');
    await expect.poll(() => serverShow(backend, 'm1').photo).toMatch(URL_RE);
    const url = serverShow(backend, 'm1').photo;
    const name = url.split('/project-media/')[1];
    const obj = backend.storage.objects.get(name);
    expect(obj.type).toBe('image/jpeg');
    expect(obj.buf.length).toBeGreaterThan(5000);          // the real compressed photo
    expect(obj.buf.subarray(0, 2).toString('hex')).toBe('ffd8');   // JPEG magic
    // Uploaded with the user's token, never the anon key.
    const up = storageCalls(backend, 'POST')[0];
    expect(JSON.parse(Buffer.from(up.headers.authorization.split('.')[1], 'base64url')).role).toBe('authenticated');
    // The save payload grew by roughly the URL, not by the photo.
    const patch = projectPatches(backend).at(-1);
    const after = JSON.stringify(patch.body.data).length;
    expect(after - before).toBeLessThan(400);
    expect(obj.buf.length).toBeGreaterThan((after - before) * 20);
    // The timer panel and the drawer render the URL.
    await page.evaluate(() => openDrawer('m1'));
    await expect(page.locator('#photo-preview')).toHaveAttribute('src', url);
    await expect.poll(() => page.evaluate(() => document.getElementById('photo-preview').naturalWidth)).toBeGreaterThan(0);
  });

  test('bucket missing: the photo is stored inline as before, and the app stops asking', async ({ page, st, backend }) => {
    backend.storage.bucketMissing = true;
    await openOperator(page, st);
    const before = JSON.stringify(backend.project(PID).data).length;
    await uploadPhoto(page, 'm1');
    await expect.poll(() => serverShow(backend, 'm1').photo).toMatch(/^data:image\/jpeg;base64,/);
    const after = JSON.stringify(projectPatches(backend).at(-1).body.data).length;
    expect(after - before).toBeGreaterThan(5000);           // the base64 photo itself
    expect(storageCalls(backend, 'POST')).toHaveLength(1);
    expect(backend.storage.objects.size).toBe(0);
    // A second photo in the same session does not retry the missing bucket.
    await uploadPhoto(page, 'm3', noisePng(200, 200, 7));
    await expect.poll(() => serverShow(backend, 'm3').photo).toMatch(/^data:image\/jpeg;base64,/);
    expect(storageCalls(backend, 'POST')).toHaveLength(1);
  });

  test('upload refused (not a member / offline): inline fallback, nothing lost', async ({ page, st, backend }) => {
    await openOperator(page, st);
    backend.failNext({ method: 'POST', path: /^\/storage\/v1\/object\/project-media\//, abort: 'failed' });
    await uploadPhoto(page, 'm1');
    await expect.poll(() => serverShow(backend, 'm1').photo).toMatch(/^data:image\/jpeg;base64,/);
    // A network error is not "bucket missing": the next photo tries Storage again.
    await uploadPhoto(page, 'm3', noisePng(200, 200, 7));
    await expect.poll(() => serverShow(backend, 'm3').photo).toMatch(URL_RE);
  });

  test('removing or replacing a photo deletes the old object after the save; a discarded upload is deleted too', async ({ page, st, backend }) => {
    await openOperator(page, st);
    await uploadPhoto(page, 'm1');
    await expect.poll(() => serverShow(backend, 'm1').photo).toMatch(URL_RE);
    const first = serverShow(backend, 'm1').photo.split('/project-media/')[1];

    // Replace: new object, old one deleted once the save landed.
    await uploadPhoto(page, 'm1', noisePng(300, 300, 3));
    await expect.poll(() => serverShow(backend, 'm1').photo).not.toContain(first);
    const second = serverShow(backend, 'm1').photo.split('/project-media/')[1];
    await expect.poll(() => backend.storage.objects.has(first)).toBe(false);
    expect(backend.storage.objects.has(second)).toBe(true);

    // Remove with the X and save.
    await page.evaluate(() => openDrawer('m1'));
    await page.locator('#f-photo-clear').click();
    await page.locator('#dr-save').click();
    await expect.poll(() => serverShow(backend, 'm1').photo).toBe('');
    await expect.poll(() => backend.storage.objects.has(second)).toBe(false);

    // Upload, then discard the drawer: the unsaved object is deleted.
    await page.evaluate(() => openDrawer('m3'));
    await page.setInputFiles('#f-photo', { name: 'a.png', mimeType: 'image/png', buffer: noisePng(120, 120, 9) });
    await page.waitForFunction(() => _photoTemp.length === 1 && !_photoUp);
    const tmp = await page.evaluate(() => _photoTemp[0].split('/project-media/')[1]);
    expect(backend.storage.objects.has(tmp)).toBe(true);
    await page.evaluate(() => closeDrawer(true));
    await expect.poll(() => backend.storage.objects.has(tmp)).toBe(false);
    expect(serverShow(backend, 'm3').photo).toBe('');
    expect(backend.storage.objects.size).toBe(0);
  });

  test('a photo shared by two shows (duplicated) is not deleted while still in use', async ({ page, st, backend }) => {
    await openOperator(page, st);
    await uploadPhoto(page, 'm1');
    await expect.poll(() => serverShow(backend, 'm1').photo).toMatch(URL_RE);
    const url = serverShow(backend, 'm1').photo;
    await page.evaluate((u) => { G.shows.find((s) => s.id === 'm3').photo = u; save({ immediate: true }); }, url);
    await expect.poll(() => serverShow(backend, 'm3').photo).toBe(url);
    await page.evaluate(() => openDrawer('m1'));
    await page.locator('#f-photo-clear').click();
    await page.locator('#dr-save').click();
    await expect.poll(() => serverShow(backend, 'm1').photo).toBe('');
    await page.clock.runFor(1000);
    expect(storageCalls(backend, 'DELETE')).toHaveLength(0);
    expect(backend.storage.objects.size).toBe(1);
  });
});

test.describe('moving existing base64 photos to Storage', () => {
  const BIG = dataUrl(noisePng(64, 64, 5));          // ~12 KB inline PNG
  const LOGO = dataUrl(noisePng(40, 40, 6));
  test.use({
    stAuth: 'admin',
    stSeed: {
      mutate(seed) {
        const d = seed.projects.find((p) => p.id === PID).data;
        for (const id of ['m1', 'm3', 'm4', 'm6']) d.shows.find((s) => s.id === id).photo = BIG;
        d.logo = LOGO;
        return seed;
      },
    },
  });

  test('converts a few per run, keeps the bytes, is idempotent and shrinks the blob', async ({ page, st, backend }) => {
    await openOperator(page, st);
    const sizeBefore = JSON.stringify(backend.project(PID).data).length;
    await page.clock.runFor(20_000);                   // first run: 3 photos
    await expect.poll(() => ['m1', 'm3', 'm4'].map((id) => URL_RE.test(serverShow(backend, id).photo))).toEqual([true, true, true]);
    expect(serverShow(backend, 'm6').photo).toBe(BIG);
    await page.clock.runFor(20_000);                   // second run: the last photo + the logo
    await expect.poll(() => URL_RE.test(serverShow(backend, 'm6').photo) && URL_RE.test(backend.project(PID).data.logo || '')).toBe(true);
    // Same bytes, same type (no re-encoding of existing photos).
    const name = serverShow(backend, 'm6').photo.split('/project-media/')[1];
    expect(backend.storage.objects.get(name).type).toBe('image/png');
    expect(dataUrl(backend.storage.objects.get(name).buf)).toBe(BIG);
    // The tiny seed photo of m2 stays inline (not worth an object).
    expect(serverShow(backend, 'm2').photo).toMatch(/^data:image\/png/);
    expect(backend.storage.objects.size).toBe(5);
    // Idempotent: further runs upload nothing.
    const n = storageCalls(backend, 'POST').length;
    await page.clock.runFor(60_000);
    expect(storageCalls(backend, 'POST')).toHaveLength(n);
    expect(JSON.stringify(backend.project(PID).data).length).toBeLessThan(sizeBefore - 4 * 10_000);
  });

  test('bucket missing: nothing changes, one probe per 10 minutes', async ({ page, st, backend }) => {
    backend.storage.bucketMissing = true;
    await openOperator(page, st);
    await page.clock.runFor(120_000);
    expect(storageCalls(backend, 'POST')).toHaveLength(1);
    expect(serverShow(backend, 'm1').photo).toBe(BIG);
    expect(projectPatches(backend)).toHaveLength(0);
  });

  test('a photo edited during the upload is not overwritten', async ({ page, st, backend }) => {
    await openOperator(page, st);
    backend.failNext({ method: 'POST', path: /^\/storage\/v1\/object\/project-media\//, delayMs: 800 });
    const run = page.evaluate(() => movePhotosToStorage(1));
    await page.evaluate(() => { G.shows.find((s) => s.id === 'm1').photo = ''; });
    expect(await run).toBe(0);
    await expect.poll(() => backend.storage.objects.size).toBe(0);   // the orphan upload is deleted again
  });
});

test.describe('public views', () => {
  const PNG = noisePng(48, 48, 11);
  const name = `${PID}/${'ab'.repeat(16)}.png`;
  test.use({
    stSeed: {
      mutate(seed) {
        seed.projects.find((p) => p.id === PID).data.shows.find((s) => s.id === 'm2').photo =
          `https://bamjpsquhdzxvsymldpq.supabase.co/storage/v1/object/public/project-media/${name}`;
        return seed;
      },
    },
  });

  for (const mode of ['stage', 'foh', 'backstage', 'timeline', 'overview', 'wall', 'checkin']) {
    test(`${mode} renders a project whose photos are Storage URLs and never uploads`, async ({ page, st, backend }) => {
      backend.storage.objects.set(name, { buf: PNG, type: 'image/png' });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const sid = ['stage', 'foh', 'backstage'].includes(mode) ? FESTIVAL.stages.main : undefined;
      await st.gotoPublic({ mode, sid, at: AT });
      await page.clock.runFor(45_000);                 // polls + two conversion ticks
      const r = await page.evaluate(async () => [await _uploadMedia('proj-fest', 'data:image/png;base64,' + 'A'.repeat(4000)), await movePhotosToStorage()]);
      expect(r).toEqual([null, 0]);
      expect(storageCalls(backend, 'POST')).toHaveLength(0);
      expect(storageCalls(backend, 'DELETE')).toHaveLength(0);
      expect(errors).toEqual([]);
    });
  }

  test.describe('in the app', () => {
    test.use({ stAuth: 'admin' });
    test('timer panel shows the Storage photo of the live show', async ({ page, st, backend }) => {
      backend.storage.objects.set(name, { buf: PNG, type: 'image/png' });
      await openOperator(page, st);                    // 16:00: m2 (with photo) is live on Main
      await expect(page.locator('#tp-photo-wrap')).toHaveClass(/has-photo/);
      await expect(page.locator('#tp-photo')).toHaveAttribute('src', /project-media\/proj-fest\/(ab){16}\.png$/);
      await expect.poll(() => page.evaluate(() => document.getElementById('tp-photo').naturalWidth)).toBe(48);
    });
    test('a Storage photo that fails to load collapses instead of a broken image', async ({ page, st }) => {
      // no object in the bucket: the URL answers 400 not_found
      await openOperator(page, st);
      await expect(page.locator('#tp-photo-wrap')).not.toHaveClass(/has-photo/);
    });
  });
});
