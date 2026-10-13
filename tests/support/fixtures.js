// Playwright fixtures for Stagetimer specs.
//
//   const { test, expect } = require('../support/fixtures');
//
//   test('anon public view', async ({ page, backend, st }) => {
//     await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main, at: ams('2026-07-10', '16:00') });
//   });
//
//   test.describe('logged in', () => {
//     test.use({ stAuth: 'admin' });          // 'admin' | 'operator' | 'super' | 'other'
//     test('dash', async ({ st }) => { await st.gotoApp(); });
//   });
//
// Fixtures:
//   backend  (auto) MockBackend attached to the context BEFORE any page loads.
//            Fails the test if anything tried to reach an unmocked host.
//   stSeed   option: full seed object (default festivalSeed()) or { mutate(seed) }
//            to tweak the festival seed (functions can't be passed to test.use directly).
//   stAuth   option: null (anonymous) or a key of FESTIVAL.users. Pre-seeds
//            localStorage.st_auth_v1 via storageState, exactly like a returning user.
//   st       helpers bound to page+backend (see AppDriver below).
const base = require('@playwright/test');
const { MockBackend, authBackupFor } = require('./mock-backend');
const { festivalSeed, FESTIVAL, ams } = require('./seed');

class AppDriver {
  constructor(page, backend) {
    this.page = page;
    this.backend = backend;
  }

  /** Install the fake clock (must happen before the first navigation). */
  async installClock(at) {
    if (this._clock) return;
    this._clock = true;
    await this.page.clock.install({ time: at || ams(FESTIVAL.dates.d1, '16:00') });
  }

  /** Open a public share view: /app.html?mode=..&pid=..[&sid=..] and wait until it rendered. */
  async gotoPublic({ mode, pid = FESTIVAL.projectId, sid, at, extra = '' } = {}) {
    await this.installClock(at);
    const qs = new URLSearchParams({ mode, pid });
    if (sid) qs.set('sid', sid);
    await this.page.goto(`/app.html?${qs}${extra}`);
    await this.page.waitForFunction(() => document.body.classList.contains('public-mode'));
    await this.page.locator('#loader').waitFor({ state: 'hidden' });
  }

  /** Boot the logged-in app (needs test.use({stAuth})) and wait for the dashboard with remote data. */
  async gotoApp({ at } = {}) {
    await this.installClock(at);
    await this.page.goto('/app.html');
    await this.page.locator('#dash.open').waitFor();
    await this.page.waitForFunction(() => window._remoteLoaded === true);
  }

  /** From the dashboard, open a project by visible name and wait for the operator screen. */
  async openProject(name = 'Zomerfeest 2026') {
    await this.page.locator('#proj-grid tr', { hasText: name }).first().click();
    await this.page.locator('#dash').waitFor({ state: 'hidden' });
    await this.page.locator('#app').waitFor();
  }

  /** Advance fake time and let the 250 ms tick + 1 s polls run. */
  async advance(ms = 1000) { await this.page.clock.runFor(ms); }

  /**
   * Freeze the clock so the last 250 ms tick lands deterministically before `at`.
   * Jumps to at-1000ms, pauses, then runs 1 s of timers (4 ticks, 1 poll).
   */
  async freezeAt(at) {
    const t = at instanceof Date ? at.getTime() : at;
    await this.page.clock.pauseAt(t - 1000);
    await this.page.clock.runFor(1000);
    // Poll responses resolve in real time, but they carry identical data and
    // render at the same frozen Date.now(), so the DOM is stable from here on.
    await this.page.evaluate(() => document.fonts.ready.then(() => true));
    // Let finite CSS transitions (progress bar width, countdown colour, .5 s)
    // run out in real time so the compositor has settled before a screenshot.
    // Polled from Node: page timers are faked and paused.
    // Require three quiet polls in a row: a transition may only be created on
    // the next style recalc, and the last frame needs a moment to rasterise.
    const deadline = Date.now() + 3000;
    let quiet = 0;
    while (Date.now() < deadline && quiet < 3) {
      await new Promise((r) => setTimeout(r, 60));
      const running = await this.page.evaluate(() => document.getAnimations()
        .filter((a) => a.playState === 'running' && a.effect && a.effect.getTiming().iterations !== Infinity).length);
      quiet = running ? 0 : quiet + 1;
    }
  }

  /** Read app globals (G, APP, CURRENT_USER...) - handy for assertions. */
  async eval(fn, arg) { return this.page.evaluate(fn, arg); }
}

const test = base.test.extend({
  stSeed: [undefined, { option: true }],
  stAuth: [null, { option: true }],

  storageState: async ({ stAuth, baseURL }, use) => {
    if (!stAuth) return use(undefined);
    const user = FESTIVAL.users[stAuth];
    if (!user) throw new Error(`stAuth: unknown user key "${stAuth}" (use ${Object.keys(FESTIVAL.users).join(', ')})`);
    const origin = new URL(baseURL).origin;
    await use({ cookies: [], origins: [{ origin, localStorage: [{ name: 'st_auth_v1', value: authBackupFor(user) }] }] });
  },

  backend: [async ({ context, stSeed }, use, testInfo) => {
    const backend = new MockBackend();
    let seed = festivalSeed();
    if (stSeed && typeof stSeed.mutate === 'function') seed = stSeed.mutate(seed) || seed;
    else if (stSeed) seed = stSeed;
    backend.seed(seed);
    await backend.attach(context);
    await use(backend);
    if (backend.violations.length) {
      await testInfo.attach('network-violations', { body: backend.violations.join('\n'), contentType: 'text/plain' });
    }
    base.expect(backend.violations, 'Unmocked network traffic (tests must never reach production)').toEqual([]);
  }, { auto: true }],

  st: async ({ page, backend }, use) => {
    await use(new AppDriver(page, backend));
  },
});

module.exports = { test, expect: base.expect, AppDriver };
