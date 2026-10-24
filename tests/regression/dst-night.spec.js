// The night the clocks go back (25 Oct 2026, 03:00 CEST -> 02:00 CET): a time
// in the repeated hour's SECOND pass is stored with its offset and survives
// an unchanged save in the show editor (Thijs, 24-10: AMF lineup in summer
// time, event ends 05:00 winter time).
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');
const P = FESTIVAL.projectId;
const seedWith = (fn) => ({ mutate(seed) { fn(seed.projects.find((p) => p.id === P).data); return seed; } });

test('festivalISO: offset only for the second pass of the repeated hour', async ({ page, st }) => {
  await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main, at: ams('2026-07-10', '16:00') });
  const r = await page.evaluate(() => [
    festivalISO(Date.parse('2026-10-25T00:09:00Z')),   // 02:09 CEST, first pass
    festivalISO(Date.parse('2026-10-25T01:09:00Z')),   // 02:09 CET, second pass
    festivalISO(Date.parse('2026-10-25T02:10:00Z')),   // 03:10 CET
    festivalISO(Date.parse('2026-07-10T14:00:00Z')),   // summer, plain
    parseFestivalISO('2026-10-25T02:09:00+01:00') === Date.parse('2026-10-25T01:09:00Z'),
  ]);
  expect(r).toEqual(['2026-10-25T02:09:00', '2026-10-25T02:09:00+01:00', '2026-10-25T03:10:00', '2026-07-10T16:00:00', true]);
});

test.describe('editor', () => {
  test.use({ stAuth: 'admin', stSeed: seedWith((d) => {
    const s = d.shows.find((x) => x.id === 'm2');
    Object.assign(s, { date: '2026-10-25', start: '01:34:00', end: '02:09:00', startsAt: '2026-10-25T01:34:00', endsAt: '2026-10-25T02:09:00+01:00', endsNextDay: false });
    d.days.find((x) => x.id === s.day).date = '2026-10-24';
  }) });
  test('unchanged save keeps the second-pass end (95 min, not 35)', async ({ page, st, backend }) => {
    await st.gotoApp({ at: ams('2026-10-24', '20:00') });
    await st.openProject();
    await page.evaluate(() => openDrawer('m2'));
    expect(await page.locator('#f-end-time').inputValue()).toBe('02:09');
    await page.evaluate(() => saveShow());
    await expect.poll(() => backend.project(P).data.shows.find((x) => x.id === 'm2').endsAt).toBe('2026-10-25T02:09:00+01:00');
    const min = await page.evaluate(() => { const iv = _showIv(G.shows.find((x) => x.id === 'm2')); return Math.round((iv.endMs - iv.startMs) / 60000); });
    expect(min).toBe(95);
  });
});
