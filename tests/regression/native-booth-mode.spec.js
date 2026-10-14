// BOUWPLAN FASE 6 step 5: first launch of the native app asks what the device
// is for (Booth screen / Crew & control); a booth screen is set up with a
// share link or project code and from then on opens that stage's Stage View
// through the existing public path (?mode=stage&pid&sid), offline too.
//
// The app ships as an update of the iPad app "Stagetimer Booth", whose users
// paste a code once and get a locked countdown screen: that workflow must keep
// working. Native mode runs on the fake Capacitor shell from
// tests/support/native-shell.js; the web keeps none of it (last tests).
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');
const { goNative, barStyles } = require('../support/native-shell');

const PID = FESTIVAL.projectId;
const S = FESTIVAL.stages;
const AT = ams(FESTIVAL.dates.d1, '16:00');
const ROLE = 'st_native_role_v1';
const CACHE = 'st_native_booth_cache_v1';

const role = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), ROLE);
const stageUrl = (pid, sid) => new RegExp(`/app\\.html\\?mode=stage&pid=${pid}&sid=${sid}$`);

// First launch of the app on this device, to the chooser.
async function launch(page, st) {
  await st.installClock(AT);
  await page.goto('/app.html');
}
// Store a role before the app starts (a same-origin page that does not boot the app).
async function presetRole(page, value) {
  await page.goto('/manifest.json');
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [ROLE, value]);
}
async function setUpBooth(page, code) {
  await page.getByRole('button', { name: /^Booth screen/ }).click();
  await page.getByLabel('Paste a share link or project code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}
async function expectStageView(page, pid, sid, stageName) {
  await page.waitForURL(stageUrl(pid, sid));
  await page.waitForFunction(() => document.body.classList.contains('public-mode'));
  await expect(page.locator('#sv')).toHaveClass(/open/);
  await expect(page.locator('#sv-top')).toHaveText(stageName);
  await expect(page.locator('#loader')).toBeHidden();
}
// Hold the mouse (primary pointer) still at x,y for ms of fake time.
async function hold(page, st, x, y, ms) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await st.advance(ms);
  await page.mouse.up();
}

test('native: first launch shows the chooser; Crew & control goes to the login form and is remembered', async ({ page, st }) => {
  const calls = await goNative(page);
  await launch(page, st);
  const chooser = page.locator('#nat-role');
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole('heading', { name: 'How will this device be used?' })).toBeVisible();
  await expect(chooser.getByRole('button', { name: /^Booth screen/ })).toContainText("Shows one stage's countdown. No login needed.");
  await expect(chooser.getByRole('button', { name: /^Crew & control/ })).toContainText('Log in to run the show, message the booth and get alerts.');
  expect(barStyles(calls)).toEqual(['DARK']);
  expect(await role(page)).toBeNull();

  await chooser.getByRole('button', { name: /^Crew & control/ }).click();
  await expect(chooser).toBeHidden();
  await expect(page.locator('#login')).toHaveClass(/open/);
  await expect(page.locator('#li-email')).toBeVisible();
  expect(await role(page)).toEqual({ role: 'crew' });

  // The question is asked once: the next launch is the normal login.
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
  await expect(chooser).toBeHidden();
});

test('native: Booth with a stage share link opens that Stage View; every next launch goes straight there', async ({ page, st, backend }) => {
  const calls = await goNative(page);
  await launch(page, st);
  await setUpBooth(page, `  https://www.stagetimer.nl/app.html?mode=stage&pid=${PID}&sid=${S.tent}  `);
  await expectStageView(page, PID, S.tent, 'The Tent');
  await expect(page.locator('#sv-artist')).toContainText('Tent Band');
  expect(await role(page)).toEqual({ role: 'booth', pid: PID, sid: S.tent });
  // The set-up read the project like a stage share link does: anon key, stage fields.
  const setup = backend.calls({ method: 'POST', path: '/rest/v1/rpc/get_shared_project' })[0];
  expect(setup.body).toEqual({ p_id: PID, p_mode: 'stage' });
  expect(setup.headers.authorization).toBe(`Bearer ${setup.headers.apikey}`);
  expect(barStyles(calls).at(-1)).toBe('DARK');

  // Cold start of the app (the bundled page without a query): no chooser, no login, the stage.
  await page.goto('/app.html');
  await expectStageView(page, PID, S.tent, 'The Tent');
  await expect(page.locator('#nat-role')).toBeHidden();
  await expect(page.locator('#login')).not.toHaveClass(/open/);
});

test('native: Booth with a project code (or another mode\'s link) shows the stage picker, then opens the chosen stage', async ({ page, st }) => {
  await goNative(page);
  await launch(page, st);
  // A FOH link names the project, not the booth's stage: pick one.
  await setUpBooth(page, `stagetimer.nl/app?mode=foh&pid=${PID}&sid=${S.main}`);
  const picker = page.locator('#nat-role');
  await expect(picker.getByRole('heading', { name: 'Pick a stage' })).toBeVisible();
  await expect(picker.locator('#nat-proj')).toHaveText('Zomerfeest 2026');
  await expect(picker.locator('.nat-stage')).toHaveText(['Main Stage', 'The Tent', 'Club Stage']);
  await picker.getByRole('button', { name: '← Back' }).click();
  await expect(page.getByLabel('Paste a share link or project code')).toBeVisible();

  // The bare project code.
  await page.getByLabel('Paste a share link or project code').fill(PID);
  await page.getByRole('button', { name: 'Continue' }).click();
  await picker.getByRole('button', { name: 'Club Stage' }).click();
  await expectStageView(page, PID, S.club, 'Club Stage');
  expect(await role(page)).toEqual({ role: 'booth', pid: PID, sid: S.club });
});

test('native: a project with one stage needs no picker', async ({ page, st }) => {
  await goNative(page);
  await launch(page, st);
  await setUpBooth(page, FESTIVAL.smallProjectId);
  await expectStageView(page, FESTIVAL.smallProjectId, 'stg-solo', 'Solo Stage');
});

test('native: a bad code, an unknown project or no network give a friendly message and keep the set-up open', async ({ page, st, backend }) => {
  await goNative(page);
  await launch(page, st);
  const err = page.locator('#nat-err');
  await setUpBooth(page, 'hello world!');
  await expect(err).toHaveText(/^That is not a Stagetimer share link or project code\./);
  expect(backend.calls({ path: '/rest/v1/rpc/get_shared_project' })).toHaveLength(0);

  await page.getByLabel('Paste a share link or project code').fill('https://stagetimer.nl/app?mode=stage&pid=nosuchproject&sid=x');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(err).toHaveText('No project found for this link or code. Check it with the operator and try again.');

  backend.failNext({ path: '/rest/v1/rpc/get_shared_project', abort: 'failed' });
  await page.getByLabel('Paste a share link or project code').fill(PID);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(err).toHaveText('Loading the project failed: no connection to the server. Check your internet connection and try again.');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  expect(new URL(page.url()).search).toBe('');
  expect(await role(page)).toEqual({ role: 'booth' });

  // Back to the question: the role is open again.
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page.getByRole('heading', { name: 'How will this device be used?' })).toBeVisible();
  expect(await role(page)).toBeNull();
});

test.describe('booth copy for an offline cold start', () => {
  // Full blob on the feed (legacy backend), so photos and the logo really
  // reach the page: the copy on the device must leave them out.
  test.use({ stSeed: { mutate(seed) { seed.projects[0].data.logo = `data:image/png;base64,${'B'.repeat(4000)}`; } } });

  test('native: offline cold start shows the copied show, then follows the live feed again', async ({ page, st, backend }) => {
    backend.shareFeed('legacy');
    await goNative(page);
    await launch(page, st);
    await setUpBooth(page, `https://stagetimer.nl/app?mode=stage&pid=${PID}&sid=${S.main}`);
    await expectStageView(page, PID, S.main, 'Main Stage');
    await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
    const copy = await page.evaluate((k) => localStorage.getItem(k), CACHE);
    expect(copy).toContain("DJ O'Neil");
    expect(copy).not.toContain('"photo"');
    expect(copy).not.toContain('data:image');
    expect(JSON.parse(copy).pid).toBe(PID);

    // Venue wifi down at boot: every feed request fails.
    backend.failNext({ path: 'get_shared_project', abort: 'failed', times: 10000 });
    backend.updateProject(PID, (d) => { d.shows.find((s) => s.id === 'm2').artist = 'DJ Renamed'; });
    await page.goto('/app.html');
    await expectStageView(page, PID, S.main, 'Main Stage');
    await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
    await expect(page.locator('#sv-cd')).toBeVisible();

    // Network back: the existing 1 s poll picks up the live project.
    backend.clearFailures();
    await st.advance(2000);
    await expect(page.locator('#sv-artist')).toHaveText('DJ Renamed');
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), CACHE)).toContain('DJ Renamed');
  });

  test('web: a stage share link keeps no copy and still says "Connecting…" offline', async ({ page, st, backend }) => {
    backend.shareFeed('legacy');
    await st.gotoPublic({ mode: 'stage', sid: S.main, at: AT });
    await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
    await st.advance(2000);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('st_native')))).toEqual([]);
    backend.failNext({ path: 'get_shared_project', abort: 'failed', times: 10000 });
    await page.reload();
    await expect(page.locator('#loader')).toContainText('Connecting…');
    await expect(page.locator('#sv')).not.toHaveClass(/open/);
  });
});

test('native: hidden exit (hold the top-left corner 3 s) opens the choice; Change stage and Switch to Crew & control', async ({ page, st }) => {
  const calls = await goNative(page);
  await presetRole(page, { role: 'booth', pid: PID, sid: S.main });
  await launch(page, st);
  await expectStageView(page, PID, S.main, 'Main Stage');
  const dlg = page.locator('.st-dlg');

  // Too short, or not in the corner: nothing.
  await hold(page, st, 20, 20, 1500);
  await hold(page, st, 640, 360, 4000);
  await hold(page, st, 200, 20, 4000);
  await expect(dlg).toHaveCount(0);
  // A drag is not a hold.
  await page.mouse.move(20, 20);
  await page.mouse.down();
  await page.mouse.move(90, 100, { steps: 4 });
  await st.advance(3500);
  await page.mouse.up();
  await expect(dlg).toHaveCount(0);

  await hold(page, st, 20, 20, 3100);
  await expect(dlg).toHaveCount(1);
  await expect(dlg.getByRole('heading', { name: 'Booth screen' })).toBeVisible();
  await expect(dlg.getByRole('button')).toHaveText(['Cancel', 'Change stage', 'Switch to Crew & control']);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#sv')).toHaveClass(/open/);

  // Change stage: the picker, current stage marked; Cancel goes back to it.
  await hold(page, st, 20, 20, 3100);
  await dlg.getByRole('button', { name: 'Change stage' }).click();
  const picker = page.locator('#nat-role');
  await expect(picker.getByRole('heading', { name: 'Pick a stage' })).toBeVisible();
  await expect(picker.locator('.nat-stage[aria-current="true"]')).toContainText('Main Stage');
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await expect(picker).toBeHidden();
  await hold(page, st, 20, 20, 3100);
  await dlg.getByRole('button', { name: 'Change stage' }).click();
  await picker.getByRole('button', { name: /^The Tent/ }).click();
  await expectStageView(page, PID, S.tent, 'The Tent');
  expect(await role(page)).toEqual({ role: 'booth', pid: PID, sid: S.tent });

  // Switch to Crew & control: the login form, and it sticks.
  await hold(page, st, 20, 20, 3100);
  await dlg.getByRole('button', { name: 'Switch to Crew & control' }).click();
  await page.waitForURL(/\/app\.html$/);
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#nat-role')).toBeHidden();
  expect(await role(page)).toEqual({ role: 'crew' });
  expect(await page.evaluate((k) => localStorage.getItem(k), CACHE)).toBeNull();
  expect(barStyles(calls).every((s) => s === 'DARK')).toBe(true);
});

test.describe('logged in', () => {
  test.use({ stAuth: 'admin' });

  test('native: status bar text follows the screen (light back office, dark control screens)', async ({ page, st }) => {
    const calls = await goNative(page);
    await st.gotoApp({ at: AT });
    await expect.poll(() => barStyles(calls)).toEqual(['DARK', 'LIGHT']);
    await st.openProject();
    await expect.poll(() => barStyles(calls)).toEqual(['DARK', 'LIGHT', 'DARK']);
    await page.evaluate(() => { openFOH(); closeFOH(); openSV(); });
    await st.advance(1000);
    expect(barStyles(calls)).toEqual(['DARK', 'LIGHT', 'DARK']);   // dark to dark: no call
    await page.evaluate(() => { closeSV(); goToDash(); });
    await expect.poll(() => barStyles(calls)).toEqual(['DARK', 'LIGHT', 'DARK', 'LIGHT']);
    // A returning crew device is not asked what it is for, and is recorded as crew.
    expect(await role(page)).toEqual({ role: 'crew' });
  });

  test('native: "Use this device as a booth screen" logs out and opens the booth set-up', async ({ page, st }) => {
    await goNative(page);
    await st.gotoApp({ at: AT });
    expect(await page.evaluate(() => [...document.querySelectorAll('[data-nat-only]')].map((el) => el.style.display))).toEqual(['', '']);
    await page.getByRole('button', { name: 'Account settings' }).first().click();
    await page.getByRole('button', { name: 'Use as booth screen' }).click();
    const dlg = page.locator('.st-dlg');
    await expect(dlg.getByRole('heading', { name: 'Use as booth screen?' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Use as booth screen' }).click();
    await page.waitForURL(/\/app\.html$/);
    await expect(page.getByLabel('Paste a share link or project code')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('st_auth_v1'))).toBeNull();
    expect(await role(page)).toEqual({ role: 'booth' });
    // Killed and relaunched mid set-up: the set-up again, not the login.
    await page.reload();
    await expect(page.getByLabel('Paste a share link or project code')).toBeVisible();
  });

  test('web: no booth item in the menus or account page, no role stored, no status bar calls', async ({ page, st }) => {
    await st.gotoApp({ at: AT });
    expect(await page.evaluate(() => [...document.querySelectorAll('[data-nat-only]')].map((el) => getComputedStyle(el).display))).toEqual(['none', 'none']);
    await page.getByRole('button', { name: 'Account settings' }).first().click();
    await expect(page.locator('#ws-profile-pw-save')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use as booth screen' })).toHaveCount(0);
    expect(await role(page)).toBeNull();
  });
});

test('web: no chooser, the login form as before', async ({ page, st }) => {
  await launch(page, st);
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#nat-role')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.classList.contains('nat-choose'))).toBe(false);
  expect(await role(page)).toBeNull();
});
