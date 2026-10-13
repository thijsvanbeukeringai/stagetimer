// Unit tests for the FOH cue helpers in the PURE TIME MODULE of app.html:
// fohCueAtMs (note wall time -> instant, relative to its show), fohCueState
// (upcoming / approaching / imminent / due / past) and fohCueCdText.
// Same loader as time.spec.js: the module is cut out by its markers and run
// in a node vm context.
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
const C = (name) => vm.runInContext(name, T);          // module-level const
const ams = (iso) => T.parseFestivalISO(iso);
const iv = (s, base, anchor) => T.showIntervalMs(s, base || null, anchor || null);
const cue = (time, show, base, anchor, day) => T.fohCueAtMs(time, iv(show, base, anchor), day);

test.describe('fohCueAtMs', () => {
  test('a note inside a dated daytime show is that day', () => {
    const s = { start: '15:30:00', end: '16:30:00' };
    expect(cue('15:45', s, '2026-07-10')).toBe(ams('2026-07-10T15:45:00'));
    expect(cue('13:27:34', { start: '13:00:00', end: '14:00:00' }, '2026-07-10')).toBe(ams('2026-07-10T13:27:34'));
    expect(cue('9:05', { start: '09:00:00', end: '10:00:00' }, '2026-07-10')).toBe(ams('2026-07-10T09:05:00'));
    // a pre-show cue just before the start stays on the same evening
    expect(cue('15:20', s, '2026-07-10')).toBe(ams('2026-07-10T15:20:00'));
  });

  test('overnight: after midnight is the next calendar day (07:00 rule)', () => {
    const s = { start: '23:00:00', end: '01:30:00' };
    expect(cue('00:30', s, '2026-07-10')).toBe(ams('2026-07-11T00:30:00'));
    expect(cue('22:55', s, '2026-07-10')).toBe(ams('2026-07-10T22:55:00'));
    expect(cue('23:59:59', s, '2026-07-10')).toBe(ams('2026-07-10T23:59:59'));
    // explicit timestamps (current drawer model) give the same answer
    const x = { start: '23:00:00', end: '01:30:00', startsAt: '2026-07-10T23:00:00', endsAt: '2026-07-11T01:30:00' };
    expect(cue('01:00', x)).toBe(ams('2026-07-11T01:00:00'));
    // a show that itself starts after midnight (dated on the calendar day)
    const late = { start: '00:30:00', end: '02:00:00' };
    expect(cue('01:15', late, '2026-07-11')).toBe(ams('2026-07-11T01:15:00'));
    expect(cue('23:50', late, '2026-07-11')).toBe(ams('2026-07-10T23:50:00'));
    // a tie (02:00 halfway between a day set's end and its next start) is the night after
    expect(cue('02:00', { start: '08:00:00', end: '20:00:00' }, '2026-07-10')).toBe(ams('2026-07-11T02:00:00'));
  });

  test('sunrise set: a 07:30 cue on a 06:00-08:00 set stays that morning', () => {
    expect(cue('07:30', { start: '06:00:00', end: '08:00:00' }, '2026-07-11')).toBe(ams('2026-07-11T07:30:00'));
  });

  test('legacy show without any date: anchored to today\'s festival day', () => {
    const s = { start: '23:00:00', end: '01:00:00' };
    expect(cue('00:15', s, null, '2026-07-10')).toBe(ams('2026-07-11T00:15:00'));
    const early = { start: '02:00:00', end: '03:00:00' }; // before 07:00 = the next calendar day
    expect(cue('02:30', early, null, '2026-07-10')).toBe(ams('2026-07-11T02:30:00'));
    // no interval at all: the plain 07:00 rule on the given day
    expect(T.fohCueAtMs('20:00', { startMs: NaN, endMs: NaN }, '2026-07-10')).toBe(ams('2026-07-10T20:00:00'));
    expect(T.fohCueAtMs('03:00', null, '2026-07-10')).toBe(ams('2026-07-11T03:00:00'));
    expect(T.fohCueAtMs('07:00', null, '2026-07-10')).toBe(ams('2026-07-10T07:00:00'));
  });

  test('invalid times give NaN', () => {
    const s = { start: '15:30:00', end: '16:30:00' };
    for (const bad of ['', null, undefined, 'abc', '25:00', '12:60', '12:00:60', '12', '1230', '12:3']) {
      expect(Number.isNaN(cue(bad, s, '2026-07-10')), String(bad)).toBe(true);
    }
    expect(Number.isNaN(T.fohCueAtMs('12:00', null, null))).toBe(true);
    expect(Number.isNaN(T.fohCueAtMs('12:00', null, 'not-a-date'))).toBe(true);
  });
});

test.describe('fohCueState', () => {
  const at = ams('2026-07-10T15:45:00');
  const st = (deltaMs) => T.fohCueState(at, at - deltaMs);
  test('thresholds are the named constants', () => {
    expect([C('FOH_CUE_WARN_S'), C('FOH_CUE_ALERT_S'), C('FOH_CUE_NOW_S')]).toEqual([60, 10, 15]);
  });
  test('upcoming > 60 s, approaching <= 60 s, imminent <= 10 s, due 0..15 s, then past', () => {
    expect(st(3600e3).key).toBe('upcoming');
    expect(st(60001)).toEqual({ key: 'upcoming', sec: 61 });
    expect(st(60000)).toEqual({ key: 'approaching', sec: 60 });
    expect(st(45000)).toEqual({ key: 'approaching', sec: 45 });
    expect(st(10001)).toEqual({ key: 'approaching', sec: 11 });
    expect(st(10000)).toEqual({ key: 'imminent', sec: 10 });
    expect(st(1)).toEqual({ key: 'imminent', sec: 1 });
    expect(st(0).key).toBe('due');
    expect(st(-14999).key).toBe('due');
    expect(st(-15000).key).toBe('past');
    expect(st(-3600e3).key).toBe('past');
  });
  test('no time, no state', () => {
    expect(T.fohCueState(NaN, at).key).toBe('');
    expect(T.fohCueState(undefined, at).key).toBe('');
  });
  test('countdown text', () => {
    expect(T.fohCueCdText(45)).toBe('in 0:45');
    expect(T.fohCueCdText(7)).toBe('in 0:07');
    expect(T.fohCueCdText(60)).toBe('in 1:00');
    expect(T.fohCueCdText(725)).toBe('in 12:05');
    expect(T.fohCueCdText(-3)).toBe('in 0:00');
  });
});
