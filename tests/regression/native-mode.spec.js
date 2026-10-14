// BOUWPLAN FASE 6 step 2 (+ the JS half of step 3): native mode in app.html.
//
// The iOS app is a Capacitor shell that serves app.html from
// capacitor://localhost and injects window.Capacitor before page scripts run.
// Here a fake Capacitor (isNativePlatform() === true, recording plugins) and a
// fake cordova OneSignal plugin are injected before load; every plugin call is
// recorded in Node through an exposed binding, so calls made just before a
// navigation (logout, deep link) are kept. The same assertions run without the
// fake to prove the web path is unchanged. Nothing leaves localhost.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const PID = FESTIVAL.projectId;
const MAIN = FESTIVAL.stages.main;
const AT = ams(FESTIVAL.dates.d1, '16:00');
const OS_APP_ID = '5778eb83-1c2c-4ffd-b085-4236b5bd0188';
const TOPIC = `st-proj-${PID}`;

// Install the fake native shell. Returns the live list of recorded calls
// [{plugin, fn, arg}].
async function goNative(page) {
  const calls = [];
  await page.exposeBinding('__natRec', (_src, rec) => { calls.push(rec); });
  await page.addInitScript(() => {
    const rec = (plugin, fn, arg) => { try { window.__natRec({ plugin, fn, arg: arg === undefined ? null : JSON.parse(JSON.stringify(arg)) }); } catch (e) { /* binding gone during unload */ } };
    const mk = (plugin, fns) => Object.fromEntries(fns.map((fn) => [fn, (arg) => { rec(plugin, fn, arg); return Promise.resolve(); }]));
    window.__natListeners = {};
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        App: { addListener(ev, cb) { rec('App', 'addListener', ev); window.__natListeners[ev] = cb; return Promise.resolve({ remove() {} }); } },
        Haptics: mk('Haptics', ['impact', 'notification']),
        Share: mk('Share', ['share']),
        StatusBar: mk('StatusBar', ['setStyle']),
        SplashScreen: mk('SplashScreen', ['hide']),
        KeepAwake: mk('KeepAwake', ['keepAwake', 'allowSleep']),
      },
    };
    const os = (fn, arg) => rec('OneSignal', fn, arg);
    window.plugins = {
      OneSignal: {
        initialize: (id) => os('initialize', id),
        login: (id) => os('login', id),
        logout: () => os('logout'),
        User: { addTags: (t) => os('User.addTags', t) },
        Notifications: {
          requestPermission: (fallback) => { os('Notifications.requestPermission', fallback); return Promise.resolve(true); },
          getPermissionAsync: () => Promise.resolve(false),
          addEventListener: (ev) => os('Notifications.addEventListener', ev),
        },
      },
    };
  });
  return calls;
}
const callsOf = (calls, plugin, fn) => calls.filter((c) => c.plugin === plugin && (!fn || c.fn === fn));

// Count service-worker calls without ever registering one (the pending promise
// stops the app's registration flow right there).
const spyServiceWorker = (page) => page.addInitScript(() => {
  window.__swCalls = 0;
  const sw = navigator.serviceWorker;
  if (!sw) return;
  for (const fn of ['register', 'getRegistration']) sw[fn] = () => { window.__swCalls++; return new Promise(() => {}); };
});

async function shareUrls(page) {
  await page.evaluate((pid) => openShareModal(pid), PID);
  await expect(page.locator('#share-ov')).toHaveClass(/open/);
  return page.locator('#share-stage-list .share-link-url').allTextContents();
}

test.describe('logged in', () => {
  test.use({ stAuth: 'admin' });

  test('native: share links point at https://stagetimer.nl/app, Share opens the iOS sheet, Copy still copies', async ({ page, st }) => {
    const calls = await goNative(page);
    await st.gotoApp({ at: AT });
    // Start-up: status bar style once, deep-link listener registered.
    expect(callsOf(calls, 'StatusBar', 'setStyle')).toEqual([{ plugin: 'StatusBar', fn: 'setStyle', arg: { style: 'DARK' } }]);
    expect(callsOf(calls, 'App', 'addListener').map((c) => c.arg)).toEqual(['appUrlOpen']);

    const urls = await shareUrls(page);
    expect(urls).toContain(`https://stagetimer.nl/app?mode=timeline&pid=${PID}`);
    expect(urls).toContain(`https://stagetimer.nl/app?mode=stage&pid=${PID}&sid=${MAIN}`);
    for (const u of urls) expect(u).toMatch(/^https:\/\/stagetimer\.nl\/app\?mode=[a-z]+&pid=proj-fest(&sid=[A-Za-z0-9_-]+)?$/);

    const row = page.locator('.share-link-row[data-mode="foh"]').first();
    await row.getByRole('button', { name: /^Share FOH link/ }).click();
    await expect.poll(() => callsOf(calls, 'Share', 'share')).toEqual([{ plugin: 'Share', fn: 'share',
      arg: { title: 'Stagetimer · FOH', url: `https://stagetimer.nl/app?mode=foh&pid=${PID}&sid=${MAIN}` } }]);
    // Copy keeps working (clipboard), with the web URL.
    await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = (t) => { window.__copied.push(t); return Promise.resolve(); }; });
    await row.getByRole('button', { name: /^Copy FOH link/ }).click();
    await expect(row.getByRole('button', { name: /Copy FOH link/ })).toHaveText('✓ Copied');
    expect(await page.evaluate(() => window.__copied)).toEqual([`https://stagetimer.nl/app?mode=foh&pid=${PID}&sid=${MAIN}`]);
  });

  test('web: share links unchanged (this origin + /app.html), no Share button, no native calls', async ({ page, st, baseURL }) => {
    await st.gotoApp({ at: AT });
    const urls = await shareUrls(page);
    expect(urls).toContain(`${baseURL}/app.html?mode=timeline&pid=${PID}`);
    expect(urls).toContain(`${baseURL}/app.html?mode=stage&pid=${PID}&sid=${MAIN}`);
    expect(urls.every((u) => u.startsWith(`${baseURL}/app.html?mode=`))).toBe(true);
    await expect(page.locator('.share-native-btn')).toHaveCount(0);
    expect(await page.evaluate(() => IS_NATIVE)).toBe(false);
  });

  test('native: no purchase UI (subscription page, limit modal, stage limit); web keeps it', async ({ page, st }) => {
    await goNative(page);
    await st.gotoApp({ at: AT });
    await page.getByRole('button', { name: 'Subscription' }).first().click();
    const body = page.locator('#ws-subscription-body');
    await expect(body).toContainText('Current plan');
    await expect(body).toContainText('Active');
    await expect(body).not.toContainText('Manage billing in Stripe');
    await expect(body).not.toContainText('€');
    await expect(page.getByRole('button', { name: /Invite member/ })).toHaveCount(0);
    // Limit modal: the reason, no purchase / portal button. (The overlay
    // itself has no .open style today, so assert the button's own state.)
    for (const action of ['subscribe', 'upgrade', 'portal']) {
      await page.evaluate((a) => showLimitModal({ ok: false, action: a, reason: 'No subscription.', company: APP.companies[0] }), action);
      await expect(page.locator('#limit-modal-msg')).toHaveText('No subscription.');
      expect(await page.evaluate(() => document.getElementById('limit-modal-action').style.display)).toBe('none');
      await page.evaluate(() => closeLimitModal());
    }
    expect(await page.evaluate(() => canCreateProject && (APP.companies[0].subscriptionStatus = 'past_due', canCreateProject(APP.companies[0].id).reason)))
      .toBe('Workspace "Zomerfeest Events BV" has a past due payment.');
    // Stage limit and the server's PT402 text: no upgrade call to action.
    await page.evaluate(() => showWsSection('projects'));
    await st.openProject();
    const reason = await page.evaluate(() => { const co = _myCompanyRow(); co.liveStagesOverride = 3; return checkStageLimit().reason; });
    expect(reason).toBe('Your Festival plan includes 3 live stages. Remove a stage to add another.');
    expect(await page.evaluate(() => _planText({ kind: 'stage_limit_exceeded', message: 'Remove a stage or upgrade to add more.' })))
      .toBe('Your plan does not include more live stages.');
    // Billing entry points do nothing even when called directly.
    await page.evaluate(() => manageSubscription(APP.companies[0].id));
    await page.evaluate(() => openInviteMemberPrompt());
    await expect(page.locator('.st-dlg')).toHaveCount(0);
  });

  test('web: purchase UI present as before', async ({ page, st }) => {
    await st.gotoApp({ at: AT });
    await page.getByRole('button', { name: 'Subscription' }).first().click();
    await expect(page.locator('#ws-subscription-body')).toContainText('Manage billing in Stripe');
    await expect(page.getByRole('button', { name: /Invite member/ })).toHaveCount(1);
    await page.evaluate(() => showLimitModal({ ok: false, action: 'subscribe', reason: 'No subscription.', company: APP.companies[0] }));
    await expect(page.locator('#limit-modal-action')).toHaveText('Start subscription');
    expect(await page.evaluate(() => document.getElementById('limit-modal-action').style.display)).toBe('block');
    expect(await page.evaluate(() => _planText({ kind: 'stage_limit_exceeded', message: 'Remove a stage or upgrade to add more.' })))
      .toBe('Remove a stage or upgrade to add more.');
  });

  test('native: fullscreen menu items gone; web keeps them', async ({ page, st, browser, backend }) => {
    await goNative(page);
    await st.gotoApp({ at: AT });
    await expect(page.locator('[data-fs]')).toHaveCount(0);
    // No two separators touching in the account menu.
    expect(await page.evaluate(() => [...document.querySelectorAll('#user-dd .dd-sep')].some((s) => s.nextElementSibling && s.nextElementSibling.classList.contains('dd-sep')))).toBe(false);
    const u = test.info().project.use;
    const ctx = await browser.newContext({ baseURL: u.baseURL, timezoneId: u.timezoneId, locale: u.locale, serviceWorkers: 'block',
      storageState: await page.context().storageState() });
    await backend.attach(ctx);
    const web = await ctx.newPage();
    await web.goto('/app.html');
    await web.locator('#dash.open').waitFor();
    await expect(web.locator('[data-fs]')).toHaveCount(4);
    await ctx.close();
  });

  test('native: KeepAwake on FOH / Backstage open, allowSleep when the last one closes', async ({ page, st }) => {
    const calls = await goNative(page);
    await st.gotoApp({ at: AT });
    await st.openProject();
    expect(callsOf(calls, 'KeepAwake')).toEqual([]);
    await page.evaluate(() => openFOH());
    await expect.poll(() => callsOf(calls, 'KeepAwake').map((c) => c.fn)).toEqual(['keepAwake']);
    await page.evaluate(() => closeFOH());
    await expect.poll(() => callsOf(calls, 'KeepAwake').map((c) => c.fn)).toEqual(['keepAwake', 'allowSleep']);
    await page.evaluate(() => openBS());
    await page.evaluate(() => closeBS());
    await expect.poll(() => callsOf(calls, 'KeepAwake').map((c) => c.fn)).toEqual(['keepAwake', 'allowSleep', 'keepAwake', 'allowSleep']);
    // navigator.wakeLock is not used in native mode.
    expect(await page.evaluate(() => _wakeLock)).toBeNull();
  });

  test('native: OneSignal through the native plugin with the web app id and external id; prompt on the crew button; logout', async ({ page, st, backend }) => {
    const calls = await goNative(page);
    await st.gotoApp({ at: AT });
    await expect.poll(() => callsOf(calls, 'OneSignal', 'initialize').map((c) => c.arg)).toEqual([OS_APP_ID]);
    // The web path logs in with CURRENT_USER.id (initOneSignalUser); so does native.
    const webId = await page.evaluate(() => CURRENT_USER.id);
    expect(webId).toBe(FESTIVAL.users.admin.id);
    await expect.poll(() => callsOf(calls, 'OneSignal', 'login').map((c) => c.arg)).toEqual([webId]);
    expect(callsOf(calls, 'OneSignal', 'Notifications.requestPermission')).toEqual([]);   // no prompt at start
    expect(callsOf(calls, 'OneSignal', 'User.addTags')).toEqual([]);                      // the web sets no tags either
    expect(backend.onesignal).toEqual([]);                                                // no web SDK
    // Same prompt moment as the web: the crew modal's button.
    await st.openProject();
    await page.evaluate(() => openCrewModal());
    await expect(page.locator('#crew-perm-btn')).toHaveText('Allow push notifications on this device');
    await page.locator('#crew-perm-btn').click();
    await expect.poll(() => callsOf(calls, 'OneSignal', 'Notifications.requestPermission').map((c) => c.arg)).toEqual([true]);
    await expect(page.locator('#crew-perm-btn')).toHaveText('Push notifications: active on this device');
    // Sign out: OneSignal logout, then back to the bundled page (not '/').
    await page.evaluate(() => doLogout());
    await expect.poll(() => callsOf(calls, 'OneSignal', 'logout').length).toBe(1);
    await page.waitForURL(/\/app\.html$/);
  });

  test('native: haptics on cue, clear and blackout; success when a booth screen confirms', async ({ page, st, backend }) => {
    const calls = await goNative(page);
    await st.gotoApp({ at: AT });
    await st.openProject();
    await expect.poll(() => page.evaluate(() => _pc.status)).toBe('SUBSCRIBED');
    expect(callsOf(calls, 'Haptics')).toEqual([]);
    await page.locator('#cue-presets .cue-btn[data-cue="READY"]').click();
    await expect.poll(() => backend.project(PID).data.cue && backend.project(PID).data.cue.text).toBe('READY');
    expect(callsOf(calls, 'Haptics').map((c) => [c.fn, c.arg])).toEqual([['impact', { style: 'LIGHT' }]]);
    const id = backend.project(PID).data.cue.id;
    backend.realtime.sendBroadcast(TOPIC, 'cue-ack', { cueId: id, stageId: MAIN, device: 'bbooth01', at: 1 });
    backend.realtime.sendBroadcast(TOPIC, 'cue-ack', { cueId: id, stageId: MAIN, device: 'bbooth02', at: 1 });
    await expect.poll(() => callsOf(calls, 'Haptics', 'notification').map((c) => c.arg)).toEqual([{ type: 'SUCCESS' }]);
    await page.clock.runFor(1000);
    expect(callsOf(calls, 'Haptics', 'notification')).toHaveLength(1);   // once per cue, not per screen
    await page.locator('#cue-clear').click();
    await page.locator('#blackout-btn').click();
    expect(callsOf(calls, 'Haptics', 'impact')).toHaveLength(3);
  });

  test('web: no haptics or other native calls on the same actions', async ({ page, st }) => {
    await st.gotoApp({ at: AT });
    await st.openProject();
    await page.evaluate(() => { window.__natTouched = false; Object.defineProperty(window, 'Capacitor', { get() { window.__natTouched = true; return undefined; }, configurable: true }); });
    await page.locator('#cue-presets .cue-btn[data-cue="READY"]').click();
    await page.evaluate(() => { openFOH(); closeFOH(); });
    expect(await page.evaluate(() => window.__natTouched)).toBe(false);
  });
});

test.describe('workspace without a subscription', () => {
  test.use({ stAuth: 'other' });
  test('native: the dashboard banner states it, without a payment link; web keeps "Start subscription"', async ({ page, st, browser, backend }) => {
    await goNative(page);
    await st.gotoApp({ at: AT });
    const banner = page.locator('#dash-sub-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText('"Awaiting Activation BV" does not have an active subscription.');
    await expect(banner.locator('a, button')).toHaveCount(0);

    const u = test.info().project.use;
    const ctx = await browser.newContext({ baseURL: u.baseURL, timezoneId: u.timezoneId, locale: u.locale, serviceWorkers: 'block',
      storageState: await page.context().storageState() });
    await backend.attach(ctx);
    const web = await ctx.newPage();
    await web.goto('/app.html');
    await web.locator('#dash.open').waitFor();
    await expect(web.locator('#dash-sub-banner a[href="/#pricing"]')).toHaveText('Start subscription');
    await ctx.close();
  });
});

test('native: no service worker is registered; the web registers one as before', async ({ page, st, browser, backend }) => {
  await goNative(page);
  await spyServiceWorker(page);
  await st.installClock(AT);
  await page.goto('/app.html');
  await page.locator('#login').waitFor();
  await st.advance(4000);
  expect(await page.evaluate(() => window.__swCalls)).toBe(0);

  const u = test.info().project.use;
  const ctx = await browser.newContext({ baseURL: u.baseURL, timezoneId: u.timezoneId, locale: u.locale, serviceWorkers: 'block' });
  await backend.attach(ctx);
  const web = await ctx.newPage();
  await spyServiceWorker(web);
  await web.clock.install({ time: AT.getTime() });
  await web.goto('/app.html');
  await web.locator('#login').waitFor();
  await web.clock.runFor(4000);
  expect(await web.evaluate(() => 'serviceWorker' in navigator)).toBe(true);
  await expect.poll(() => web.evaluate(() => window.__swCalls)).toBeGreaterThan(0);
  await ctx.close();
});

test('native: a Universal Link (appUrlOpen) to a share link opens that screen; other hosts are ignored', async ({ page, st }) => {
  const calls = await goNative(page);
  await st.installClock(AT);
  await page.goto('/app.html');
  await page.locator('#login').waitFor();
  expect(callsOf(calls, 'App', 'addListener').map((c) => c.arg)).toEqual(['appUrlOpen']);
  // Not ours: nothing happens.
  for (const url of ['https://evil.example/app?mode=stage&pid=x', 'https://stagetimer.nl/blog?mode=stage&pid=x', 'stagetimer://open?mode=stage&pid=x', 'not a url']) {
    expect(await page.evaluate((u) => _natOpenUrl(u), url)).toBe(false);
  }
  expect(new URL(page.url()).search).toBe('');
  // The operator start page initialised OneSignal, like the web does.
  expect(callsOf(calls, 'OneSignal', 'initialize')).toHaveLength(1);
  // A share link: the bundled page reloads with its query and shows Stage View.
  await page.evaluate((url) => window.__natListeners.appUrlOpen({ url }), `https://stagetimer.nl/app?mode=stage&pid=${PID}&sid=${MAIN}`);
  await page.waitForURL(new RegExp(`/app\\.html\\?mode=stage&pid=${PID}&sid=${MAIN}$`));
  await page.waitForFunction(() => document.body.classList.contains('public-mode'));
  await expect(page.locator('#sv')).toHaveClass(/open/);
  // Share-link screens never initialise OneSignal (like the web): still one.
  await st.advance(2000);
  expect(callsOf(calls, 'OneSignal', 'initialize')).toHaveLength(1);
});
