// BOUWPLAN FASE 6 step 4: Live Activity (lock screen + Dynamic Island).
//
// The iOS app exposes a local plugin Capacitor.Plugins.StLiveActivity
// (native/ios/App/App/StLiveActivityPlugin.swift). Here a fake Capacitor with
// a recording StLiveActivity is injected before load; every call goes to Node
// through an exposed binding, so a call made right before a navigation
// (logout) is kept. What is asserted: the activity follows this device's
// selected stage and timer panel, the plugin is called only when the picture
// changes (never per tick), and share links / the web never touch it.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const S = FESTIVAL.stages;
const D1 = FESTIVAL.dates.d1;
const AT = ams(D1, '16:00');
const ms = (time) => ams(D1, time).getTime();

// Fake native shell with only the Live Activity plugin. Returns the live list
// of recorded calls [{fn, arg}].
async function goNative(page, { available = true } = {}) {
  const calls = [];
  await page.exposeBinding('__laRec', (_src, rec) => { calls.push(rec); });
  await page.addInitScript((avail) => {
    const rec = (fn, arg) => { try { window.__laRec({ fn, arg: arg === undefined ? null : JSON.parse(JSON.stringify(arg)) }); } catch (e) { /* binding gone during unload */ } };
    const fn = (name, result) => (arg) => { rec(name, arg); return Promise.resolve(result); };
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        StLiveActivity: { isAvailable: fn('isAvailable', { available: avail }), start: fn('start'), update: fn('update'), end: fn('end') },
      },
    };
  }, available);
  return calls;
}
const only = (calls, ...fns) => calls.filter((c) => fns.includes(c.fn));
const last = (calls, fn) => only(calls, fn).slice(-1)[0];
const offset = (page) => page.evaluate(() => _clockOffsetMs);

test.describe('logged in', () => {
  test.use({ stAuth: 'admin' });

  test('follows the selected stage: start with the live show, no calls on plain ticks, update on show change, new activity on stage switch, end on logout', async ({ page, st }) => {
    const calls = await goNative(page);
    await st.gotoApp({ at: AT });
    await st.openProject();
    // Main Stage at 16:00: DJ O'Neil 15:30-16:30 is live.
    await expect.poll(() => last(calls, 'start')?.arg?.showName).toBe("DJ O'Neil");
    const off = await offset(page);
    expect(last(calls, 'start').arg).toEqual({
      stageName: 'Main Stage', showName: "DJ O'Neil", nextName: 'The <b>html</b> & "Quotes" Band',
      phase: 'live', overrun: false, manual: false,
      startsAt: ms('15:30') - off, endsAt: ms('16:30') - off,
    });
    expect(only(calls, 'isAvailable')).toHaveLength(1);

    // Plain ticks (the countdown moves, nothing else does): no plugin calls.
    const n = calls.length;
    await st.advance(20_000);
    expect(calls.length).toBe(n);

    // 16:31: DJ O'Neil is over, the next Main Stage show is upcoming.
    await page.clock.fastForward(30 * 60_000);
    await st.advance(2000);
    await expect.poll(() => only(calls, 'update').length).toBe(1);
    expect(last(calls, 'update').arg).toMatchObject({
      stageName: 'Main Stage', showName: 'The <b>html</b> & "Quotes" Band', nextName: 'Headliner Priority',
      phase: 'upcoming', startsAt: ms('17:00') - off, endsAt: ms('18:15') - off,
    });
    expect(calls.length).toBe(n + 1);

    // Stage switch: the stage name is static on an activity, so a new one starts.
    await page.locator('#stage-sel').selectOption(S.tent);
    await expect.poll(() => only(calls, 'start').length).toBe(2);
    expect(last(calls, 'start').arg).toMatchObject({ stageName: 'The Tent', showName: 'Tent Band (legacy)', phase: 'live', endsAt: ms('17:30') - off });

    // Logout ends it before the page reloads.
    await page.evaluate(() => doLogout());
    await expect.poll(() => only(calls, 'end').length).toBe(1);
  });

  test('manual timer: the countdown target is the timer panel\'s own deadline, frozen while idle or paused', async ({ page, st }) => {
    const calls = await goNative(page);
    await st.gotoApp({ at: AT });
    await st.openProject();
    await expect.poll(() => only(calls, 'start').length).toBe(1);

    await page.locator('#mb-man').click();
    await expect.poll(() => last(calls, 'update')?.arg?.phase).toBe('ready');
    const ready = last(calls, 'update').arg;
    expect(ready).toMatchObject({ showName: "DJ O'Neil", manual: true });
    expect(ready.endsAt - ready.pausedAt).toBe(60 * 60_000);   // idle: the full planned length

    await page.locator('#btn-pp').click();                    // Start
    await expect.poll(() => last(calls, 'update')?.arg?.phase).toBe('live');
    const live = last(calls, 'update').arg;
    const m = await page.evaluate(() => ({ deadline: M.deadlineMs - _clockOffsetMs, duration: M.durationMs }));
    expect(live).toMatchObject({ manual: true, overrun: false, endsAt: m.deadline, startsAt: m.deadline - m.duration });
    // A running manual timer ticks on the lock screen by itself: no calls.
    const n = calls.length;
    await st.advance(5000);
    expect(calls.length).toBe(n);

    await page.locator('#btn-pp').click();                    // Pause
    await expect.poll(() => last(calls, 'update')?.arg?.phase).toBe('paused');
    const remaining = await page.evaluate(() => M.remainingMs);
    const paused = last(calls, 'update').arg;
    expect(paused.endsAt - paused.pausedAt).toBe(remaining);
  });

  test('Live Activities unavailable (iPad, switched off): asked once, never started', async ({ page, st }) => {
    const calls = await goNative(page, { available: false });
    await st.gotoApp({ at: AT });
    await st.openProject();
    await expect.poll(() => only(calls, 'isAvailable').length).toBe(1);
    await st.advance(5000);
    expect(only(calls, 'start', 'update', 'end')).toEqual([]);
    expect(only(calls, 'isAvailable')).toHaveLength(1);
  });

  test('web (no Capacitor): nothing runs', async ({ page, st }) => {
    await st.gotoApp({ at: AT });
    await st.openProject();
    await st.advance(3000);
    expect(await page.evaluate(() => ({ avail: _la.avail, key: _la.key, on: _la.on }))).toEqual({ avail: undefined, key: null, on: false });
  });
});

test('share link (?mode=stage): the plugin is never called', async ({ page, st }) => {
  const calls = await goNative(page);
  await st.gotoPublic({ mode: 'stage', sid: S.main, at: AT });
  await st.advance(5000);
  expect(calls).toEqual([]);
});
