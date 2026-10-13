// FOH cue alerts: timed FOH notes ("15:45 Extra monitor") count down and stand
// out as their moment nears, in the in-app FOH view and on the public FOH link.
//   upcoming (> 60 s) -> approaching (<= 60 s, amber, "in 0:45")
//   -> imminent (<= 10 s, red, pulsing, "in 0:07") -> due (0..15 s, "NOW")
//   -> past (dimmed, time struck through, "Done").
// The state is patched in place by the 250 ms tick: the note element is never
// rebuilt. Time is driven with a paused page.clock and targets at x.5 s, so the
// last tick (every 250 ms) always lands inside the intended second.
//
// Screenshots of every state at 1440 and 390 go to tests/output/foh-cues/
// (gitignored) on every run.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');
const op = require('./_operator');

const S = FESTIVAL.stages;
const FRI = FESTIVAL.dates.d1;
const XSS = '<img src=x onerror="window.__xss=1"> Vuurwerk';

// DJ O'Neil (Main, 15:30-16:30) is live; n1 is the seed's 15:45 note (HH:MM),
// nx a second cue with seconds and hostile text, nt a note without a time.
const cueSeed = (extra) => ({
  mutate(seed) {
    const d = seed.projects.find((p) => p.id === FESTIVAL.projectId).data;
    d.fohNotes.m2 = [
      { id: 'n1', text: "Extra monitor for DJ O'Neil", time: '15:45', color: '#ffe600' },
      { id: 'nx', text: XSS, time: '15:47:30', color: '#ff4d4d' },
      { id: 'nt', text: 'No time on this one', time: '', color: '#4db8ff' },
    ];
    if (extra) extra(d);
    return seed;
  },
});

const shotDir = path.join(__dirname, '..', 'output', 'foh-cues');
async function shot(page, testInfo, name) {
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, `${testInfo.project.name}-${name}.png`) });
}

// Walk n1 through every state; returns after "past".
async function walkStates(page, { onState } = {}) {
  const row = page.locator('.foh-cue[data-nid="n1"]');
  const badge = row.locator('.foh-cue-st');
  const steps = [
    // [ms to run, class, badge text]
    [0, 'cue-upcoming', null],
    [60_000, 'cue-approaching', '⏱in 1:00'],        // 15:44:00.5 (the caller ran 0.5 s)
    [15_000, 'cue-approaching', '⏱in 0:45'],        // 15:44:15.5
    [38_000, 'cue-imminent', '⚠in 0:07'],           // 15:44:53.5
    [7_000, 'cue-due', '▶NOW'],                      // 15:45:00.5
    [16_000, 'cue-past', '✓Done'],                   // 15:45:16.5
  ];
  for (const [ms, cls, text] of steps) {
    if (ms) await page.clock.runFor(ms);
    await expect(row).toHaveClass(new RegExp(`\\b${cls}\\b`));
    if (text === null) await expect(badge).toBeHidden();
    else { await expect(badge).toBeVisible(); await expect(badge).toHaveText(text); }
    if (onState) await onState(cls.replace('cue-', ''), text);
  }
}

test.describe('public FOH link', () => {
  test.use({ stSeed: cueSeed() });

  for (const [w, h] of [[1440, 900], [390, 844]]) {
    test(`states, countdown, announcements and element identity (${w})`, async ({ page, st }, testInfo) => {
      await page.setViewportSize({ width: w, height: h });
      await st.gotoPublic({ mode: 'foh', sid: S.main, at: ams(FRI, '15:43:00'), paused: true });
      await page.clock.runFor(500);
      const row = page.locator('.foh-cue[data-nid="n1"]');
      await expect(row).toBeVisible();
      await page.evaluate(() => {
        window.__row = document.querySelector('.foh-cue[data-nid="n1"]');
        window.__body = document.getElementById('foh-col-body').firstElementChild;
      });
      const seen = [];
      await walkStates(page, {
        onState: async (state) => {
          seen.push(state);
          // Same element, same list: classes and text were patched, nothing rebuilt.
          expect(await page.evaluate(() => window.__row === document.querySelector('.foh-cue[data-nid="n1"]')
            && window.__body === document.getElementById('foh-col-body').firstElementChild)).toBe(true);
          if (state === 'approaching' && !seen.includes('approaching-said')) {
            seen.push('approaching-said');
            await expect(page.locator('#foh-cue-live')).toHaveText("Cue in 1:00: Extra monitor for DJ O'Neil (15:45)");
          }
          if (state === 'due') await expect(page.locator('#foh-cue-alert')).toHaveText("Cue now: Extra monitor for DJ O'Neil (15:45)");
          await shot(page, testInfo, `${w}-${state}${state === 'approaching' && seen.filter((x) => x === 'approaching').length > 1 ? '-45s' : ''}`);
        },
      });
      expect(seen.filter((s) => !s.endsWith('-said'))).toEqual(['upcoming', 'approaching', 'approaching', 'imminent', 'due', 'past']);
      // Live regions are present and hidden from sight, not from screen readers.
      await expect(page.locator('#foh-cue-live')).toHaveAttribute('aria-live', 'polite');
      await expect(page.locator('#foh-cue-alert')).toHaveAttribute('aria-live', 'assertive');
      // Past stays readable: struck-through time, dimmed, not hidden.
      expect(await row.locator('.foh-note-time').evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('line-through');
      expect(Number(await row.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(1);
      await expect(row).toContainText("Extra monitor for DJ O'Neil");
      // A note without a time never gets a state.
      const plain = page.locator('.foh-note-item', { hasText: 'No time on this one' });
      await expect(plain).not.toHaveClass(/foh-cue/);
      await expect(plain.locator('.foh-cue-st')).toHaveCount(0);
    });
  }

  test('hostile note text stays text through every state', async ({ page, st }) => {
    await st.gotoPublic({ mode: 'foh', sid: S.main, at: ams(FRI, '15:46:20'), paused: true });
    const row = page.locator('.foh-cue[data-nid="nx"]');
    await page.clock.runFor(10_500);                       // 15:46:30.5: 60 s to go
    await expect(row).toHaveClass(/cue-approaching/);
    await page.clock.runFor(60_000);                       // due
    await expect(row).toHaveClass(/cue-due/);
    await expect(row.locator('.foh-note-txt')).toHaveText(XSS);
    await expect(page.locator('#foh-cue-alert')).toContainText(XSS);
    expect(await page.locator('#foh img[src="x"]').count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('reduced motion: no pulse or flash, still a strong static highlight', async ({ page, st }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await st.gotoPublic({ mode: 'foh', sid: S.main, at: ams(FRI, '15:44:50'), paused: true });
    const row = page.locator('.foh-cue[data-nid="n1"]');
    await page.clock.runFor(3_500);                        // 15:44:53.5 imminent
    await expect(row).toHaveClass(/cue-imminent/);
    const css = (el) => ({ name: getComputedStyle(el).animationName, n: el.getAnimations().length, bg: getComputedStyle(el).backgroundColor });
    let c = await row.evaluate(css);
    expect(c.name).toBe('none');
    expect(c.n).toBe(0);
    expect(c.bg).not.toBe('rgba(0, 0, 0, 0)');
    await page.clock.runFor(7_000);                        // due
    await expect(row).toHaveClass(/cue-due/);
    c = await row.evaluate(css);
    expect(c.name).toBe('none');
    expect(c.n).toBe(0);
    await expect(row.locator('.foh-cue-st')).toHaveText('▶NOW');
  });

  test('with motion the imminent cue pulses and the due cue flashes', async ({ page, st }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await st.gotoPublic({ mode: 'foh', sid: S.main, at: ams(FRI, '15:44:50'), paused: true });
    const row = page.locator('.foh-cue[data-nid="n1"]');
    await page.clock.runFor(3_500);
    await expect(row).toHaveClass(/cue-imminent/);
    expect(await row.evaluate((e) => getComputedStyle(e).animationName)).toBe('fohCuePulse');
    await page.clock.runFor(7_000);
    await expect(row).toHaveClass(/cue-due/);
    expect(await row.evaluate((e) => getComputedStyle(e).animationName)).toBe('fohCueFlash');
  });
});

test.describe('scroll into view', () => {
  // A cue on a show far down the list (Night Owl, 23:00) that falls due this
  // afternoon: off-screen in a short window.
  test.use({ stSeed: cueSeed((d) => { d.fohNotes.m6 = [{ id: 'far', text: 'Check the night crew', time: '15:44:30', color: '#ffe600' }]; }) });
  const inView = (page) => page.evaluate(() => {
    const el = document.querySelector('.foh-cue[data-nid="far"]'), b = document.getElementById('foh-col-body').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
  });

  test('an approaching cue off-screen is brought into view once', async ({ page, st }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });  // instant scroll, no real-time animation
    await page.setViewportSize({ width: 1440, height: 420 });
    await st.gotoPublic({ mode: 'foh', sid: S.main, at: ams(FRI, '15:43:00'), paused: true });
    await page.clock.runFor(500);
    expect(await inView(page)).toBe(false);
    await page.clock.runFor(29_500);                       // 15:43:30.5: 60 s to go
    await expect(page.locator('.foh-cue[data-nid="far"]')).toHaveClass(/cue-approaching/);
    await expect.poll(() => inView(page)).toBe(true);
    // Scrolled away again in the same state: left alone (once per state change).
    await page.evaluate(() => { document.getElementById('foh-col-body').scrollTop = 0; });
    await page.clock.runFor(5_000);
    expect(await inView(page)).toBe(false);
  });

  test('not while the user is scrolling the list', async ({ page, st }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 420 });
    await st.gotoPublic({ mode: 'foh', sid: S.main, at: ams(FRI, '15:43:28'), paused: true });
    await page.clock.runFor(500);
    await page.locator('#foh-col-body').hover();
    await page.mouse.wheel(0, 1);                          // the user is in the list
    await page.waitForFunction(() => _fohUserAt > 0);      // wheel events arrive asynchronously
    await page.evaluate(() => { document.getElementById('foh-col-body').scrollTop = 0; });
    await page.clock.runFor(2_000);                        // approaching, 2 s after the wheel
    await expect(page.locator('.foh-cue[data-nid="far"]')).toHaveClass(/cue-approaching/);
    expect(await inView(page)).toBe(false);
  });
});

test.describe('in-app FOH (operator)', () => {
  op.test.use({
    stSeed: { mutate(seed) {
      seed.projects[0].data = op.projectData({ fohNotes: { a: [{ id: 'q1', text: 'Vuurwerk', time: '22:40:00', color: '#ffe600' }] } });
      return seed;
    } },
  });
  // Records beeps instead of playing them.
  const AUDIO_STUB = () => {
    window.__beeps = [];
    class FakeCtx {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; window.__actx = (window.__actx || 0) + 1; }
      resume() { return Promise.resolve(); }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (d) => d }; }
      createOscillator() { const o = { type: '', frequency: { value: 0 }, connect: (g) => g, start: () => window.__beeps.push(o.frequency.value), stop() {} }; return o; }
    }
    window.AudioContext = FakeCtx;
  };

  op.test('same states in the app; sound alert is off by default and beeps only when switched on', async ({ page, st }) => {
    await page.addInitScript(AUDIO_STUB);
    await op.openOperator({ page, st });
    await page.locator('#hdr-foh-btn').click();
    await expect(page.locator('#foh.open')).toBeVisible();
    await page.clock.pauseAt(new Date('2026-06-19T22:38:30+02:00'));
    await page.clock.runFor(30_500);                       // 22:39:00.5
    const row = page.locator('.foh-cue[data-nid="q1"]');
    await expect(row).toHaveClass(/cue-approaching/);
    await expect(row.locator('.foh-cue-st')).toHaveText('⏱in 1:00');
    // Off by default: nothing created, nothing played.
    const snd = page.locator('#foh .foh-snd');
    await expect(snd).toHaveText('🔕 Sound alert: Off');
    await expect(snd).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => window.__actx || 0)).toBe(0);
    await page.clock.runFor(50_000);                       // imminent
    await expect(row).toHaveClass(/cue-imminent/);
    expect(await page.evaluate(() => window.__beeps.length)).toBe(0);
    // Switch on (a user gesture): a confirmation beep, then one at due.
    await snd.click();
    await expect(snd).toHaveText('🔔 Sound alert: On');
    await expect(snd).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('st_foh_sound'))).toBe('1');
    expect(await page.evaluate(() => window.__beeps.length)).toBe(1);
    await page.clock.runFor(10_000);                       // 22:40:00.5 due
    await expect(row).toHaveClass(/cue-due/);
    await expect(row.locator('.foh-cue-st')).toHaveText('▶NOW');
    expect(await page.evaluate(() => window.__beeps.length)).toBe(3); // two-tone at due
    await page.clock.runFor(16_000);
    await expect(row).toHaveClass(/cue-past/);
    expect(await page.evaluate(() => window.__beeps.length)).toBe(3);
    // Off again: removed from storage.
    await snd.click();
    expect(await page.evaluate(() => localStorage.getItem('st_foh_sound'))).toBeNull();
  });
});
