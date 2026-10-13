// Unit-style checks of pure time logic, run inside the real app.html.
//
// app.html has no modules yet, so pure helpers are reached as page globals
// after a public view has booted (no login needed). When BOUWPLAN 4.1 moves
// them into js/time.js, these can import the module directly in node.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

test.beforeEach(async ({ st }) => {
  await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main, at: ams(FESTIVAL.dates.d1, '16:00') });
});

test('t2s / durSec / s2cdH', async ({ page }) => {
  const r = await page.evaluate(() => ({
    t2s: t2s('01:02:03'),
    overnight: durSec('23:00:00', '01:30:00'),
    sameDay: durSec('15:30:00', '16:30:00'),
    cdShort: s2cdH(65),
    cdLong: s2cdH(3725),
    cdNeg: s2cdH(-5),
  }));
  expect(r).toEqual({ t2s: 3723, overnight: 9000, sameDay: 3600, cdShort: '01:05', cdLong: '1:02:05', cdNeg: '-00:05' });
});

test('overnight show: ISO model and legacy model agree', async ({ page }) => {
  const r = await page.evaluate(() => {
    const iso = G.shows.find((s) => s.id === 'm6');          // 23:00-01:30, startsAt/endsAt
    const legacy = { ...iso, startsAt: undefined, endsAt: undefined, endsNextDay: undefined, date: undefined };
    const f = (d) => d && d.toISOString();
    return { iso: [f(_showStartsAt(iso)), f(_showEndsAt(iso))], legacy: [f(_showStartsAt(legacy)), f(_showEndsAt(legacy))], dur: _showDurationSec(iso) };
  });
  expect(r.iso).toEqual(['2026-07-10T21:00:00.000Z', '2026-07-10T23:30:00.000Z']);
  expect(r.legacy).toEqual(r.iso);
  expect(r.dur).toBe(9000);
});

test('curShow / nxtShow at a fixed clock', async ({ page, st }) => {
  await st.freezeAt(ams(FESTIVAL.dates.d1, '16:00:30.400'));
  const res = await page.evaluate((stage) => {
    const shows = getShows(stage, G.activeDay);
    const c = curShow(shows), n = nxtShow(shows);
    return { cur: c && c.s.artist, next: n && n.s.artist, startsIn: n && n.startsIn };
  }, FESTIVAL.stages.main);
  expect(res).toEqual({ cur: "DJ O'Neil", next: 'The <b>html</b> & "Quotes" Band', startsIn: 3570 });
});
