// Unit tests for the PURE TIME MODULE in app.html.
// The module is lifted out of app.html by its begin/end markers and run in a
// node vm context - no browser, no network.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadModule() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
  const a = html.indexOf('// ══ PURE TIME MODULE ─ begin');
  const b = html.indexOf('// ══ PURE TIME MODULE ─ end');
  if (a < 0 || b < a) throw new Error('time module markers not found in app.html');
  const ctx = { console, Intl, Date, Map, Math, String, Number, isNaN, Array, Object };
  vm.createContext(ctx);
  vm.runInContext(html.slice(a, b), ctx);
  return ctx;
}
const T = loadModule();
const ams = iso => T.parseFestivalISO(iso);          // festival wall time → ms
const utc = iso => Date.parse(iso);                   // explicit instant → ms
const iv = (s, base, anchor) => T.showIntervalMs(s, base || null, anchor || null);
const live = (i, at) => at >= i.startMs && at < i.endMs;

test.describe('festival time (Europe/Amsterdam)', () => {
  test('wall time is Amsterdam whatever the zone', () => {
    expect(ams('2026-06-20T23:00:00')).toBe(utc('2026-06-20T21:00:00Z')); // CEST
    expect(ams('2026-01-10T23:00')).toBe(utc('2026-01-10T22:00:00Z'));    // CET
    expect(ams('2026-06-20T23:00:00Z')).toBe(utc('2026-06-20T23:00:00Z')); // explicit zone honoured
    expect(Number.isNaN(ams('2026-06-20T25:00'))).toBe(true);
  });
  test('DST: October hour twice = first, March gap = one hour later', () => {
    expect(ams('2026-10-25T02:30:00')).toBe(utc('2026-10-25T00:30:00Z')); // 02:30 CEST
    expect(ams('2026-03-29T02:30:00')).toBe(utc('2026-03-29T01:30:00Z')); // = 03:30 CEST
    // a 01:00-04:00 set lasts 4h in October, 2h in March
    const oct = iv({ start: '01:00:00', end: '04:00:00' }, '2026-10-25');
    expect(oct.endMs - oct.startMs).toBe(4 * 3600e3);
    const mar = iv({ start: '01:00:00', end: '04:00:00' }, '2026-03-29');
    expect(mar.endMs - mar.startMs).toBe(2 * 3600e3);
  });
  test('festival day runs 07:00-07:00', () => {
    expect(T.festivalDayOf(utc('2026-06-20T04:59:59Z'))).toBe('2026-06-19'); // 06:59:59 CEST
    expect(T.festivalDayOf(utc('2026-06-20T05:00:00Z'))).toBe('2026-06-20'); // 07:00 CEST
    expect(T.festivalDayOf(utc('2026-10-25T05:59:00Z'))).toBe('2026-10-24'); // 06:59 CET, DST night
    expect(T.addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
  });
  test('formatting', () => {
    expect(T.amsTimeStr(utc('2026-06-20T22:05:09Z'), true)).toBe('00:05:09');
    expect(T.amsDateStr(utc('2026-06-20T22:05:09Z'))).toBe('2026-06-21');
  });
});

test.describe('show intervals', () => {
  test('explicit startsAt/endsAt win', () => {
    const i = iv({ start: '10:00:00', end: '11:00:00', startsAt: '2026-06-20T23:00:00', endsAt: '2026-06-21T01:30:00' }, '2026-01-01');
    expect(i.startMs).toBe(ams('2026-06-20T23:00:00'));
    expect(i.endMs).toBe(ams('2026-06-21T01:30:00'));
  });
  test('dated 23:00-01:30 runs past midnight', () => {
    const i = iv({ start: '23:00:00', end: '01:30:00' }, '2026-06-20');
    expect(live(i, ams('2026-06-21T00:45:00'))).toBe(true);
    expect(live(i, ams('2026-06-21T01:30:00'))).toBe(false);
    expect(live(i, ams('2026-06-20T22:59:59'))).toBe(false);
  });
  test('legacy dateless shows: 07:00 rule on today\'s festival day', () => {
    const anchor = '2026-06-20';
    const late = iv({ start: '01:00:00', end: '02:00:00' }, null, anchor);
    expect(late.startMs).toBe(ams('2026-06-21T01:00:00'));
    const eve = iv({ start: '22:00:00', end: '01:30:00' }, null, anchor);
    expect(eve.startMs).toBe(ams('2026-06-20T22:00:00'));
    expect(eve.endMs).toBe(ams('2026-06-21T01:30:00'));
    const dawn = iv({ start: '06:00:00', end: '08:00:00' }, null, anchor);
    expect(dawn.endMs - dawn.startMs).toBe(2 * 3600e3);
    // no date and no anchor: unknown, never live
    expect(Number.isNaN(iv({ start: '22:00:00', end: '23:00:00' }).startMs)).toBe(true);
  });
  test('endsNextDay from imports is honoured', () => {
    const i = iv({ start: '01:00:00', end: '02:00:00', endsNextDay: false }, null, '2026-06-20');
    expect(i.endMs - i.startMs).toBe(3600e3);
  });
});

test.describe('show filter + picks', () => {
  const S = (id, s, e, extra) => Object.assign({ id, startsAt: s, endsAt: e }, extra || {});
  const shows = [
    S('a', '2026-06-20T22:00:00', '2026-06-20T23:00:00'),
    S('c', '2026-06-20T23:00:00', '2026-06-20T23:30:00', { cancelled: true }),
    S('h', '2026-06-20T23:30:00', '2026-06-21T00:00:00', { hidden: true }),
    S('b', '2026-06-21T00:00:00', '2026-06-21T01:30:00'),
  ];
  const ivOf = s => iv(s);
  test('cancelled never live/next; hidden only off share links', () => {
    const op = shows.filter(s => T.showAllowed(s, 'live', false));
    const pub = shows.filter(s => T.showAllowed(s, 'live', true));
    expect(T.pickLiveShow(op, ivOf, ams('2026-06-20T23:10:00'))).toBe(null);
    expect(T.pickNextShow(op, ivOf, ams('2026-06-20T23:10:00')).s.id).toBe('h');
    expect(T.pickNextShow(pub, ivOf, ams('2026-06-20T23:10:00')).s.id).toBe('b');
    expect(T.showAllowed(shows[2], 'list', true)).toBe(false);
    expect(T.showAllowed(shows[1], 'list', true)).toBe(true); // timeline keeps it, struck through
  });
  test('live after midnight', () => {
    expect(T.pickLiveShow(shows, ivOf, ams('2026-06-21T00:30:00')).s.id).toBe('b');
  });
});

test('one-off timer 23:00-01:00 is live after midnight', () => {
  const i = T.otIntervalMs({ date: '2026-06-20', start: '23:00:00', end: '01:00:00' });
  expect(live(i, ams('2026-06-21T00:30:00'))).toBe(true);
  expect(live(i, ams('2026-06-21T01:00:00'))).toBe(false);
});

test.describe('manual timer model', () => {
  const MIN = 60e3;
  test('start / pause / resume / reset', () => {
    let t = T.mtIdle(60 * MIN);
    expect(T.mtRemaining(t, 0)).toBe(60 * MIN);
    t = T.mtToggle(t, 1000);                     // start
    expect(T.mtRemaining(t, 11000)).toBe(60 * MIN - 10000);
    t = T.mtToggle(t, 11000);                    // pause
    expect(t.state).toBe('paused');
    expect(T.mtRemaining(t, 99999)).toBe(60 * MIN - 10000);
    t = T.mtToggle(t, 50000);                    // resume
    expect(T.mtRemaining(t, 52000)).toBe(60 * MIN - 12000);
    t = T.mtIdle(60 * MIN);
    expect(t.state).toBe('idle');
  });
  test('+1 min while paused adds exactly 1 min', () => {
    let t = T.mtToggle(T.mtIdle(10 * MIN), 0);
    t = T.mtToggle(t, MIN);                      // paused with 9 min
    t = T.mtAdjust(t, MIN);
    expect(T.mtRemaining(t, 5 * MIN)).toBe(10 * MIN);
    t = T.mtToggle(t, 5 * MIN);                  // resume
    expect(T.mtRemaining(t, 6 * MIN)).toBe(9 * MIN);
  });
  test('pausing after a correction does not jump', () => {
    let t = T.mtToggle(T.mtIdle(10 * MIN), 0);
    t = T.mtAdjust(t, -2 * MIN);                 // running correction
    const before = T.mtRemaining(t, 3 * MIN);
    t = T.mtToggle(t, 3 * MIN);                  // pause
    expect(T.mtRemaining(t, 3 * MIN)).toBe(before);
    t = T.mtToggle(t, 4 * MIN);                  // resume
    expect(T.mtRemaining(t, 4 * MIN)).toBe(before);
  });
  test('corrections while idle change the planned length once', () => {
    const t = T.mtAdjust(T.mtIdle(10 * MIN), 5 * MIN);
    expect(T.mtRemaining(t, 0)).toBe(15 * MIN);
    expect(t.durationMs).toBe(15 * MIN);
  });
});

test('poll gate: one in flight, stale answers dropped', () => {
  const g = T.makePollGate();
  const n1 = g.begin();
  expect(n1).toBeGreaterThan(0);
  expect(g.begin()).toBe(0);                     // busy
  g.end();
  const n2 = g.begin(); g.end();
  expect(g.accept(n2)).toBe(true);
  expect(g.accept(n1)).toBe(false);              // older than applied
});

test('server clock offset: stable when consistent, 0 when device is right', () => {
  const H = 1_000_000_000_000;                  // server Date header (whole second)
  expect(T.clockOffsetFromSample(0, H + 100, H + 300, H)).toBe(0);
  expect(T.clockOffsetFromSample(400, H + 100, H + 300, H)).toBe(400);   // still fits: keep
  const off = T.clockOffsetFromSample(0, H - 60000, H - 59800, H);       // device 60s behind
  expect(off).toBeGreaterThan(59000);
  expect(off).toBeLessThan(61000);
  expect(T.clockOffsetFromSample(7, 10, 5, H)).toBe(7);                   // nonsense sample ignored
});
