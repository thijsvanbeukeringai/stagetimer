// Feature: artist rider per show (feature/rider-data, 2026-10-13).
// Contract: show.rider = {drinks, tech}, both optional free text, multi-line,
// trimmed, max 2000 characters each; absent / {} / empty = no rider.
//
//  * show editor: two labelled fields, inline length check, unsaved-changes
//    guard, saved through saveShow; only the fields edited in the drawer are
//    written (a peer's edit of the other field survives);
//  * schedule card: a "Rider" chip with the text as tooltip, escaped;
//  * lineup import: drinks / tech or rider:{drinks,tech} per act / row,
//    validated, listed in the preview;
//  * share links: only p_mode checkin and stagemanager receive it (matrix in
//    tests/support/share-modes.js = supabase/migrations/20261013100000);
//    set_show_arrived answers with the check-in view, rider included.
// The merge per subfield itself: tests/unit/rider-merge.test.js.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');
const { SHARE_MODES } = require('../support/share-modes');

const PID = FESTIVAL.projectId;
const S = FESTIVAL.stages;
const MID_SHOW = ams(FESTIVAL.dates.d1, '16:00');   // DJ O'Neil (m2, has a rider) live on Main
const RPC = '/rest/v1/rpc/get_shared_project';
const XSS_D = '<img src=x onerror="window.__xss=1"> & "quotes"';
const XSS_T = '"><script>window.__xss=2</script>\nline two';

const srv = (backend, id) => backend.project(PID).data.shows.find((s) => s.id === id);
const local = (page, id) => page.evaluate((x) => G.shows.find((s) => s.id === x), id);
const card = (page, artist) => page.locator('#slist .scard', { has: page.locator('.scard-name', { hasText: artist }) });
const dlg = (page) => page.locator('.st-dlg[role="dialog"]');
async function saved(page) { await page.evaluate(() => _whenSaved(APP.activeProjectId)); }

test.describe('operator', () => {
  test.use({ stAuth: 'admin' });
  test.beforeEach(async ({ page }) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('dialog', (d) => { problems.push('native dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    page.__problems = problems;
  });
  test.afterEach(async ({ page }) => { expect(page.__problems, 'page errors / native dialogs').toEqual([]); });

  test('editor: rider is saved, edited and cleared', async ({ page, st, backend }) => {
    await st.gotoApp({ at: MID_SHOW });
    await st.openProject();
    await page.evaluate(() => openDrawer('m1'));
    const drawer = page.locator('#drawer');
    await expect(drawer.getByLabel('Drinks / hospitality')).toHaveValue('');
    await expect(drawer.getByLabel('Technical requirements')).toHaveValue('');
    await expect(drawer.getByLabel('Drinks / hospitality')).toHaveAttribute('placeholder', /Club-Mate/);
    await drawer.getByLabel('Drinks / hospitality').fill('  Water\nBeer  ');
    await drawer.getByLabel('Technical requirements').fill('Vocal mic');
    await page.locator('#dr-save').click();
    await expect(drawer).not.toHaveClass(/open/);
    await saved(page);
    expect(srv(backend, 'm1').rider).toEqual({ drinks: 'Water\nBeer', tech: 'Vocal mic' });
    // Reopen: the stored (trimmed) text is back in the fields.
    await page.evaluate(() => openDrawer('m1'));
    await expect(drawer.getByLabel('Drinks / hospitality')).toHaveValue('Water\nBeer');
    await drawer.getByLabel('Drinks / hospitality').fill('   ');
    await page.locator('#dr-save').click();
    await saved(page);
    expect(srv(backend, 'm1').rider).toEqual({ tech: 'Vocal mic' });
    // Clearing the last field leaves {} (= no rider), so a merge keeps a
    // field a peer added meanwhile; the chip is gone.
    await page.evaluate(() => openDrawer('m1'));
    await drawer.getByLabel('Technical requirements').fill('');
    await page.locator('#dr-save').click();
    await saved(page);
    expect(srv(backend, 'm1').rider).toEqual({});
    await expect(card(page, 'Opening Act').locator('.sc-rider')).toHaveCount(0);
    // A new show without rider text gets no rider key at all.
    await page.locator('#new-show-btn').click();
    await page.locator('#f-a').fill('No Rider Act');
    await page.locator('#dr-save').click();
    await saved(page);
    expect(backend.project(PID).data.shows.find((s) => s.artist === 'No Rider Act')).not.toHaveProperty('rider');
  });

  test('editor: a field left alone keeps what a peer saved meanwhile (merge per field)', async ({ page, st, backend }) => {
    await st.gotoApp({ at: MID_SHOW });
    await st.openProject();
    await page.evaluate(() => openDrawer('m2'));
    // Peer edits tech while this drawer is open; this device has not seen it.
    backend.updateProject(PID, (d) => { d.shows.find((s) => s.id === 'm2').rider.tech = 'Peer: turntables'; });
    await page.locator('#f-rider-drinks').fill('Local: only water');
    await page.locator('#dr-save').click();
    await saved(page);
    expect(srv(backend, 'm2').rider).toEqual({ drinks: 'Local: only water', tech: 'Peer: turntables' });
    // Same with the peer's edit already on this device (realtime) while the
    // drawer was open: the stale value in the untouched field is not written.
    await page.evaluate(() => openDrawer('m2'));
    backend.updateProject(PID, (d) => { d.shows.find((s) => s.id === 'm2').rider.drinks = 'Peer: cola'; }, { broadcast: true });
    await expect.poll(() => local(page, 'm2').then((s) => s.rider.drinks)).toBe('Peer: cola');
    await expect(page.locator('#f-rider-drinks')).toHaveValue('Local: only water');   // drawer not repainted
    await page.locator('#f-rider-tech').fill('Local: CDJs');
    await page.locator('#dr-save').click();
    await saved(page);
    expect(srv(backend, 'm2').rider).toEqual({ drinks: 'Peer: cola', tech: 'Local: CDJs' });
  });

  test('editor: length is checked inline and blocks saving', async ({ page, st, backend }) => {
    await st.gotoApp({ at: MID_SHOW });
    await st.openProject();
    await page.evaluate(() => openDrawer('m1'));
    const f = page.locator('#f-rider-tech');
    await f.fill('x'.repeat(1599));
    await expect(page.locator('#f-rider-tech-cnt')).toHaveText('');
    await f.fill('x'.repeat(2001));
    await expect(page.locator('#f-rider-tech-err')).toHaveText('Technical requirements is 2,001 characters. Keep it to 2,000 (1 too many).');
    await expect(f).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#f-rider-tech-cnt')).toHaveText('2,001 / 2,000');
    await expect(page.locator('#f-rider-tech-cnt')).toHaveClass(/over/);
    const patches = backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).length;
    await page.locator('#dr-save').click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    await expect(f).toBeFocused();
    expect((await local(page, 'm1')).rider).toBeUndefined();
    expect(backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).length).toBe(patches);
    // Exactly the limit after trimming is fine.
    await f.fill('  ' + 'y'.repeat(2000) + '\n');
    await expect(page.locator('#f-rider-tech-err')).toBeHidden();
    await expect(f).not.toHaveAttribute('aria-invalid', 'true');
    await page.locator('#dr-save').click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    await saved(page);
    expect(srv(backend, 'm1').rider.tech).toBe('y'.repeat(2000));
  });

  test('editor: rider edits count as unsaved changes', async ({ page, st }) => {
    await st.gotoApp({ at: MID_SHOW });
    await st.openProject();
    await page.evaluate(() => openDrawer('m2'));
    await page.clock.runFor(300);
    await expect(page.locator('#f-rider-drinks')).toHaveValue('6x Club-Mate\nStill water, no ice');
    await page.locator('#f-rider-tech').fill('Changed');
    await page.keyboard.press('Escape');
    await expect(dlg(page).locator('.st-dlg-title')).toHaveText('Discard changes?');
    await dlg(page).getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('#f-rider-tech')).toHaveValue('Changed');
    await page.locator('#dr-cancel').click();
    await dlg(page).getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    expect((await local(page, 'm2')).rider.tech).toBe('2x CDJ-3000 + DJM-900NXS2\nBooth monitor left');
    // Unchanged rider: closes without asking.
    await page.evaluate(() => openDrawer('m2'));
    await page.keyboard.press('Escape');
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    await expect(dlg(page)).toHaveCount(0);
  });

  for (const width of [1280, 390]) {
    test(`schedule card: rider chip with tooltip (${width}px)`, async ({ page, st }) => {
      await page.setViewportSize({ width, height: 844 });
      await st.gotoApp({ at: MID_SHOW });
      await st.openProject();
      const chip = card(page, "DJ O'Neil").locator('.sc-rider');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText(/Rider/);
      expect(await chip.getAttribute('title')).toBe('Drinks: 6x Club-Mate\nStill water, no ice\nTech: 2x CDJ-3000 + DJM-900NXS2\nBooth monitor left');
      await expect(chip.locator('.vh')).toHaveText(' (drinks and technical)');
      await expect(card(page, 'Opening Act').locator('.sc-rider')).toHaveCount(0);
      // No layout break: the chip sits inside its card, the page does not scroll sideways.
      const [c, k] = await Promise.all([chip.boundingBox(), card(page, "DJ O'Neil").boundingBox()]);
      expect(c.x).toBeGreaterThanOrEqual(k.x);
      expect(c.x + c.width).toBeLessThanOrEqual(k.x + k.width + 0.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }

  test.describe('rider text is escaped', () => {
    test.use({ stSeed: { mutate(seed) { seed.projects[0].data.shows.find((s) => s.id === 'm1').rider = { drinks: XSS_D, tech: XSS_T }; } } });
    test('chip tooltip and editor show it as text', async ({ page, st }) => {
      await st.gotoApp({ at: MID_SHOW });
      await st.openProject();
      const k = card(page, 'Opening Act');
      expect(await k.locator('.sc-rider').getAttribute('title')).toBe(`Drinks: ${XSS_D}\nTech: ${XSS_T}`);
      await expect(k.locator('img, script')).toHaveCount(0);
      await page.evaluate(() => openDrawer('m1'));
      await expect(page.locator('#f-rider-drinks')).toHaveValue(XSS_D);
      await expect(page.locator('#f-rider-tech')).toHaveValue(XSS_T);
      await expect(page.locator('#drawer img[src="x"]')).toHaveCount(0);
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });
  });

  test('import: drinks / tech and rider:{} per act, checked, listed in the preview', async ({ page, st, backend }) => {
    await st.gotoApp({ at: MID_SHOW });
    await st.openProject();
    await page.evaluate(() => openJSONModal());
    await expect(page.locator('#json-modal-ov')).toContainText('Optional rider per act');
    const lineup = {
      sunday: {
        date: '2026-07-12',
        stages: [{
          stage: 'Rider Stage',
          acts: [
            { time: '16:00-17:00', artist: 'Flat Keys', drinks: ' Water \n Beer ', tech: 'Two mics' },
            { time: '17:00-18:00', artist: 'Nested Rider', rider: { drinks: XSS_D } },
            { time: '18:00-19:00', artist: 'Flat Wins', drinks: 'flat', rider: { drinks: 'nested', tech: 'nested tech' } },
            { time: '19:00-20:00', artist: 'Plain Act' },
            { time: '20:00-21:00', artist: 'Too Long', tech: 'z'.repeat(2001) },
            { time: '21:00-22:00', artist: 'Bad Rider', rider: 'water please' },
            { time: '22:00-23:00', artist: 'Bad Drinks', drinks: ['water'] },
          ],
        }],
      },
    };
    await page.locator('#json-input-area').fill(JSON.stringify(lineup));
    await page.locator('#json-import-btn').click();
    const pv = page.locator('#json-import-preview');
    await expect(pv).toContainText('Rider for 3 shows:');
    await expect(pv).toContainText('Flat Keys · Drinks: Water Beer · Tech: Two mics');   // whitespace-normalised
    await expect(pv).toContainText(`Nested Rider · Drinks: ${XSS_D}`);
    await expect(pv.locator('img')).toHaveCount(0);
    await expect(pv).toContainText('Too Long): "tech" is 2,001 characters, the maximum is 2,000');
    await expect(pv).toContainText('Bad Rider): "rider" must be an object like {"drinks":"…","tech":"…"}');
    await expect(pv).toContainText('Bad Drinks): "drinks" must be text');
    await expect(page.locator('#json-import-btn')).toHaveText('Confirm import (4)');
    await page.locator('#json-import-btn').click();
    await expect(pv).toContainText('Saved.');
    const by = (a) => backend.project(PID).data.shows.find((s) => s.artist === a);
    expect(by('Flat Keys').rider).toEqual({ drinks: 'Water \n Beer', tech: 'Two mics' });
    expect(by('Nested Rider').rider).toEqual({ drinks: XSS_D });
    expect(by('Flat Wins').rider).toEqual({ drinks: 'flat', tech: 'nested tech' });
    expect(by('Plain Act')).not.toHaveProperty('rider');
    for (const a of ['Too Long', 'Bad Rider', 'Bad Drinks']) expect(by(a)).toBeUndefined();
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('import: flat rows take drinks / tech too', async ({ page, st, backend }) => {
    await st.gotoApp({ at: MID_SHOW });
    await st.openProject();
    const r = await page.evaluate(() => importLineup([
      { stage: 'Flat Stage', artist: 'Row Rider', start: '2026-07-12T16:00', end: '17:00', drinks: 'Tea', tech: 42 },
      { stage: 'Flat Stage', artist: 'Row Plain', start: '2026-07-12T17:00', end: '18:00', rider: {} },
    ]));
    expect(r).toMatchObject({ imported: 2, invalid: [] });
    await saved(page);
    const by = (a) => backend.project(PID).data.shows.find((s) => s.artist === a);
    expect(by('Row Rider').rider).toEqual({ drinks: 'Tea', tech: '42' });
    expect(by('Row Plain')).not.toHaveProperty('rider');
  });
});

test.describe('share links', () => {
  const RIDER = { drinks: '6x Club-Mate\nStill water, no ice', tech: '2x CDJ-3000 + DJM-900NXS2\nBooth monitor left' };
  const SID = { stage: S.main, backstage: S.main, foh: S.main, stagemanager: S.main };
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const mode of SHARE_MODES) {
    const gets = mode === 'checkin' || mode === 'stagemanager';
    test(`${mode}: ${gets ? 'receives' : 'never receives'} the rider`, async ({ page, st, backend }) => {
      await st.gotoPublic({ mode, sid: SID[mode], at: MID_SHOW, paused: true });
      const calls = backend.calls({ method: 'POST', path: RPC });
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.map((c) => c.body.p_mode)).toEqual(calls.map(() => mode));
      const row = await page.evaluate(() => window._earlyPublicFetch);
      const m2 = row.data.shows.find((s) => s.id === 'm2');
      if (gets) expect(m2.rider).toEqual(RIDER);
      else {
        expect(m2).not.toHaveProperty('rider');
        expect(JSON.stringify(row)).not.toMatch(/"rider"|Club-Mate|CDJ-3000/);
        expect(await page.evaluate(() => JSON.stringify(G))).not.toContain('Club-Mate');
      }
    });
  }

  test('legacy 1-arg call still returns everything; unknown modes nothing', async ({ backend }) => {
    const legacy = await backend._rpc('get_shared_project', { p_id: PID });
    expect(legacy.json.data.shows.find((s) => s.id === 'm2').rider).toEqual(RIDER);
    const unknown = await backend._rpc('get_shared_project', { p_id: PID, p_mode: 'stage-manager' });
    expect(JSON.stringify(unknown.json)).not.toContain('rider');
  });

  test('checkin: a tap keeps the rider (set_show_arrived answers with the check-in view)', async ({ page, st, backend }) => {
    await st.gotoPublic({ mode: 'checkin', at: MID_SHOW });
    const row = page.locator('.ci-row', { hasText: "DJ O'Neil" });
    await row.getByRole('button', { name: 'Mark arrived' }).click();
    await expect(row.getByRole('button', { name: /Arrived/ })).toBeVisible();
    await expect.poll(() => backend.calls({ method: 'POST', path: '/rest/v1/rpc/set_show_arrived' }).length).toBe(1);
    const res = await backend._rpc('set_show_arrived', { p_id: PID, p_show_id: 'm2', p_arrived: true, p_arrived_at: null });
    expect(res.json.shows.find((s) => s.id === 'm2').rider).toEqual(RIDER);
    expect(JSON.stringify(res.json)).not.toMatch(/USB backup|Bram|data:image/);
    // The adopted answer keeps the rider on the screen's data.
    expect((await local(page, 'm2')).rider).toEqual(RIDER);
    expect(srv(backend, 'm2').rider).toEqual(RIDER);
  });
});
