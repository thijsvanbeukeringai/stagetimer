// BOUWPLAN FASE 6 step 6: the native app's third device role, "Dressing room
// screen". Set up like a booth (share link or project code), then tied to one
// artist's show instead of a stage; from then on the app opens that show's
// ?mode=dressing&pid&shid share link. The dressing screen itself (#dres) is
// built separately, so these specs assert on the URL, the stored role and the
// offline copy, never on the screen's contents. Booth and crew flows stay as
// they are (native-booth-mode.spec.js).
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');
const { goNative, barStyles } = require('../support/native-shell');

const PID = FESTIVAL.projectId;
const S = FESTIVAL.stages;
const AT = ams(FESTIVAL.dates.d1, '16:00');
const ROLE = 'st_native_role_v1';
const CACHE = 'st_native_booth_cache_v1';

const role = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), ROLE);
const copyOf = (page) => page.evaluate((k) => localStorage.getItem(k), CACHE);
const dressingUrl = (pid, shid) => new RegExp(`/app\\.html\\?mode=dressing&pid=${pid}&shid=${shid}$`);

async function launch(page, st, at = AT) {
  await st.installClock(at);
  await page.goto('/app.html');
}
async function presetRole(page, value) {
  await page.goto('/manifest.json');
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [ROLE, value]);
}
async function setUpDressing(page, code) {
  await page.getByRole('button', { name: /^Dressing room screen/ }).click();
  await page.getByLabel('Paste a share link or project code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}
// The share-link page has loaded its project (the dressing screen may not exist on this branch).
async function expectDressingLink(page, pid, shid) {
  await page.waitForURL(dressingUrl(pid, shid));
  await page.waitForFunction(() => document.body.classList.contains('public-mode'));
  await expect(page.locator('#nat-role')).toBeHidden();
  await expect(page.locator('#login')).not.toHaveClass(/open/);
}
async function hold(page, st, x, y, ms) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await st.advance(ms);
  await page.mouse.up();
}

const FRIDAY = ['Opening Act', "DJ O'Neil", 'Tent Band (legacy)', 'The <b>html</b> & "Quotes" Band', 'Headliner Priority',
  'Club Opener', 'Cancelled Act', 'Late Tent', 'Night Owl', 'After Midnight'];
const SATURDAY = ['Day Two Opener', 'Tent Saturday', 'Saturday Headliner', 'Club Closing'];

test('native: the chooser offers Booth, Dressing room and Crew & control', async ({ page, st }) => {
  await goNative(page);
  await launch(page, st);
  const chooser = page.locator('#nat-role');
  await expect(chooser.locator('.nat-step[data-for="choose"] .nat-opt .nat-opt-t')).toHaveText(['Booth screen', 'Dressing room screen', 'Crew & control']);
  await expect(chooser.getByRole('button', { name: /^Dressing room screen/ })).toContainText("Counts down to one artist's show, over their own video or photo. No login needed.");
  expect(await role(page)).toBeNull();
});

test('native: Dressing room with a project code shows the artists by day (today first), then opens the chosen show', async ({ page, st, backend }) => {
  const calls = await goNative(page);
  await launch(page, st);
  await page.getByRole('button', { name: /^Dressing room screen/ }).click();
  await expect(page.getByRole('heading', { name: 'Dressing room screen' })).toBeVisible();
  await expect(page.getByLabel('Paste a share link or project code')).toHaveAttribute('placeholder', 'https://stagetimer.nl/app?mode=dressing&pid=…');
  expect(await role(page)).toEqual({ role: 'dressing' });
  await page.getByLabel('Paste a share link or project code').fill(PID);
  await page.getByRole('button', { name: 'Continue' }).click();

  const picker = page.locator('#nat-role');
  await expect(picker.getByRole('heading', { name: 'Pick an artist' })).toBeVisible();
  await expect(picker.locator('#nat-artists-proj')).toHaveText('Zomerfeest 2026');
  // Friday is today (16:00 on day 1); hidden shows are never offered; festival-night order.
  await expect(picker.locator('.nat-day')).toHaveText(['Vrijdag · Fri 10 Jul · Today', 'Zaterdag · Sat 11 Jul']);
  await expect(picker.locator('.nat-artist .nat-opt-t')).toHaveText([...FRIDAY, ...SATURDAY]);
  await expect(picker.locator('.nat-artist').filter({ hasText: 'Cancelled Act' })).toContainText('Main Stage · 21:00 · Cancelled');
  await expect(picker.locator('.nat-artist').filter({ hasText: 'After Midnight' })).toContainText('Club Stage · 00:30');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  // The set-up read the project like the dressing share link will: anon key, dressing mode.
  const setup = backend.calls({ method: 'POST', path: '/rest/v1/rpc/get_shared_project' })[0];
  expect(setup.body).toEqual({ p_id: PID, p_mode: 'dressing' });
  expect(setup.headers.authorization).toBe(`Bearer ${setup.headers.apikey}`);

  // Back to the code, and on again.
  await picker.getByRole('button', { name: '← Back' }).click();
  await expect(page.getByLabel('Paste a share link or project code')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await picker.getByRole('button', { name: /^Late Tent/ }).click();
  await expectDressingLink(page, PID, 't3');
  expect(await role(page)).toEqual({ role: 'dressing', pid: PID, shid: 't3' });
  expect(JSON.parse(await copyOf(page)).pid).toBe(PID);
  expect(barStyles(calls).every((s) => s === 'DARK')).toBe(true);

  // Every next launch of the app goes straight to that show's link.
  await page.goto('/app.html');
  await expectDressingLink(page, PID, 't3');
});

test('native: on the second festival day that day is listed first', async ({ page, st }) => {
  await goNative(page);
  await launch(page, st, ams(FESTIVAL.dates.d2, '15:00'));
  await setUpDressing(page, `stagetimer.nl/app?mode=foh&pid=${PID}&sid=${S.main}`);
  const picker = page.locator('#nat-role');
  await expect(picker.locator('.nat-day')).toHaveText(['Zaterdag · Sat 11 Jul · Today', 'Vrijdag · Fri 10 Jul']);
  await expect(picker.locator('.nat-artist .nat-opt-t')).toHaveText([...SATURDAY, ...FRIDAY]);
});

test('native: a pasted dressing link opens its artist directly; a project without shows says so', async ({ page, st }) => {
  await goNative(page);
  await launch(page, st);
  await setUpDressing(page, FESTIVAL.smallProjectId);
  await expect(page.locator('#nat-err')).toHaveText("This project has no shows yet. Ask the operator to add the artist's show, then try again.");
  expect(new URL(page.url()).search).toBe('');

  await page.getByLabel('Paste a share link or project code').fill(`  https://www.stagetimer.nl/app.html?mode=dressing&pid=${PID}&shid=m8  `);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expectDressingLink(page, PID, 'm8');
  expect(await role(page)).toEqual({ role: 'dressing', pid: PID, shid: 'm8' });
});

test('native: link parsing: only a stage link picks the stage, only a dressing link the artist', async ({ page, st }) => {
  await goNative(page);
  await launch(page, st);
  const parsed = await page.evaluate((pid) => [
    `https://stagetimer.nl/app?mode=stage&pid=${pid}&sid=stg-main&shid=m1`,
    `stagetimer.nl/app?mode=dressing&pid=${pid}&sid=stg-main&shid=m1`,
    `https://stagetimer.nl/app?mode=foh&pid=${pid}&sid=stg-main&shid=m1`,
    `https://stagetimer.nl/app?mode=dressing&pid=${pid}&shid=bad%20id`,
    pid,
  ].map(_natParseBoothCode), PID);
  expect(parsed).toEqual([
    { pid: PID, sid: 'stg-main', shid: null },
    { pid: PID, sid: null, shid: 'm1' },
    { pid: PID, sid: null, shid: null },
    { pid: PID, sid: null, shid: null },
    { pid: PID, sid: null, shid: null },
  ]);
});

test('native: killed mid set-up, the next launch reopens the dressing room set-up', async ({ page, st }) => {
  await goNative(page);
  await presetRole(page, { role: 'dressing' });
  await launch(page, st);
  await expect(page.getByRole('heading', { name: 'Dressing room screen' })).toBeVisible();
  await expect(page.getByLabel('Paste a share link or project code')).toBeFocused();
  // Back: the question is open again.
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page.getByRole('heading', { name: 'How will this device be used?' })).toBeVisible();
  expect(await role(page)).toBeNull();
  // And the booth set-up still says Booth screen.
  await page.getByRole('button', { name: /^Booth screen/ }).click();
  await expect(page.getByRole('heading', { name: 'Booth screen' })).toBeVisible();
  await expect(page.getByLabel('Paste a share link or project code')).toHaveAttribute('placeholder', 'https://stagetimer.nl/app?mode=stage&pid=…');
});

test('native: hidden exit on a dressing room screen: Change artist and Switch to Crew & control', async ({ page, st }) => {
  await goNative(page);
  await presetRole(page, { role: 'dressing', pid: PID, shid: 'm2' });
  await launch(page, st);
  await expectDressingLink(page, PID, 'm2');
  const dlg = page.locator('.st-dlg');

  await hold(page, st, 20, 20, 1500);
  await hold(page, st, 200, 20, 4000);
  await expect(dlg).toHaveCount(0);

  await hold(page, st, 20, 20, 3100);
  await expect(dlg.getByRole('heading', { name: 'Dressing room screen' })).toBeVisible();
  await expect(dlg.getByRole('button')).toHaveText(['Cancel', 'Change artist', 'Switch to Crew & control']);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);

  // Change artist: the picker with the current show marked; Cancel goes back.
  await hold(page, st, 20, 20, 3100);
  await dlg.getByRole('button', { name: 'Change artist' }).click();
  const picker = page.locator('#nat-role');
  await expect(picker.getByRole('heading', { name: 'Pick an artist' })).toBeVisible();
  await expect(picker.locator('.nat-artist[aria-current="true"]')).toContainText("DJ O'Neil");
  await expect(picker.locator('.nat-artist[aria-current="true"]')).toContainText('On this screen now');
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();   // not "Cancelled Act"
  await expect(picker).toBeHidden();
  expect(page.url()).toMatch(dressingUrl(PID, 'm2'));

  await hold(page, st, 20, 20, 3100);
  await dlg.getByRole('button', { name: 'Change artist' }).click();
  await picker.getByRole('button', { name: /^Saturday Headliner/ }).click();
  await expectDressingLink(page, PID, 'm8');
  expect(await role(page)).toEqual({ role: 'dressing', pid: PID, shid: 'm8' });

  await hold(page, st, 20, 20, 3100);
  await dlg.getByRole('button', { name: 'Switch to Crew & control' }).click();
  await page.waitForURL(/\/app\.html$/);
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#nat-role')).toBeHidden();
  expect(await role(page)).toEqual({ role: 'crew' });
  expect(await copyOf(page)).toBeNull();
});

test.describe('dressing room copy for an offline cold start', () => {
  // Full blob on the feed (legacy backend), so the logo, photos and
  // backgrounds really reach the page. bgVideo is the customer's own MP4 URL:
  // only the URL is kept, the video is streamed.
  const LOGO = 'https://bamjpsquhdzxvsymldpq.supabase.co/storage/v1/object/public/project-media/proj-fest/logo.png';
  const BG = 'https://bamjpsquhdzxvsymldpq.supabase.co/storage/v1/object/public/project-media/proj-fest/bg-m8.jpg';
  const VIDEO = 'https://bamjpsquhdzxvsymldpq.supabase.co/storage/v1/object/public/project-media/proj-fest/bg-m8.mp4';
  test.use({ stSeed: { mutate(seed) {
    const d = seed.projects[0].data;
    d.logo = LOGO;
    Object.assign(d.shows.find((s) => s.id === 'm8'), { bgImage: BG, bgVideo: VIDEO });
    d.shows.find((s) => s.id === 'm7').bgImage = `data:image/png;base64,${'C'.repeat(4000)}`;
  } } });

  test('native: the copy keeps logo, bgImage and bgVideo (no photos, no big data: URLs) and serves an offline cold start', async ({ page, st, backend }) => {
    backend.shareFeed('legacy');
    await goNative(page);
    await launch(page, st);
    await setUpDressing(page, `https://stagetimer.nl/app?mode=dressing&pid=${PID}&shid=m8`);
    await expectDressingLink(page, PID, 'm8');
    const copy = JSON.parse(await copyOf(page));
    expect(copy.pid).toBe(PID);
    expect(copy.proj.data.logo).toBe(LOGO);
    const m8 = copy.proj.data.shows.find((s) => s.id === 'm8');
    expect([m8.bgImage, m8.bgVideo]).toEqual([BG, VIDEO]);
    expect(copy.proj.data.shows.find((s) => s.id === 'm7').bgImage).toBeUndefined();
    expect(JSON.stringify(copy)).not.toContain('"photo"');
    expect(JSON.stringify(copy)).not.toContain('data:image');

    // Venue wifi down at boot: the project comes from the copy.
    backend.failNext({ path: 'get_shared_project', abort: 'failed', times: 10000 });
    backend.updateProject(PID, (d) => { d.shows.find((s) => s.id === 'm8').artist = 'Renamed Headliner'; });
    await page.goto('/app.html');
    await expectDressingLink(page, PID, 'm8');
    expect(await page.evaluate(() => G.shows.find((s) => s.id === 'm8').artist)).toBe('Saturday Headliner');
    expect(await page.evaluate(() => G.logo)).toBe(LOGO);
  });

  test('native: a booth copy still drops the logo, even a short Storage URL', async ({ page, st, backend }) => {
    backend.shareFeed('legacy');
    await goNative(page);
    await launch(page, st);
    await page.getByRole('button', { name: /^Booth screen/ }).click();
    await page.getByLabel('Paste a share link or project code').fill(`https://stagetimer.nl/app?mode=stage&pid=${PID}&sid=${S.main}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/mode=stage/);
    await expect(page.locator('#sv')).toHaveClass(/open/);
    const copy = JSON.parse(await copyOf(page));
    expect(copy.proj.data.logo).toBeUndefined();
    expect(copy.proj.data.shows.find((s) => s.id === 'm8').bgImage).toBe(BG);
  });
});

test.describe('logged in', () => {
  test.use({ stAuth: 'admin' });

  test('native: "Use as dressing room screen" logs out and opens the dressing room set-up', async ({ page, st }) => {
    await goNative(page);
    await st.gotoApp({ at: AT });
    await page.getByRole('button', { name: 'Account settings' }).first().click();
    await expect(page.getByRole('button', { name: 'Use as booth screen' })).toBeVisible();
    await page.getByRole('button', { name: 'Use as dressing room screen' }).click();
    const dlg = page.locator('.st-dlg');
    await expect(dlg.getByRole('heading', { name: 'Use as dressing room screen?' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Use as dressing room screen' }).click();
    await page.waitForURL(/\/app\.html$/);
    await expect(page.getByRole('heading', { name: 'Dressing room screen' })).toBeVisible();
    await expect(page.getByLabel('Paste a share link or project code')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('st_auth_v1'))).toBeNull();
    expect(await role(page)).toEqual({ role: 'dressing' });
  });

  test('native: both device items sit in the account menu', async ({ page, st }) => {
    await goNative(page);
    await st.gotoApp({ at: AT });
    const items = await page.evaluate(() => [...document.querySelectorAll('[data-nat-only]')].map((el) => el.textContent.trim()));
    expect(items).toEqual(['Use this device as a booth screen', 'Use this device as a dressing room screen',
      'Use this device as a booth screen', 'Use this device as a dressing room screen']);
  });

  test('web: no dressing room item on the account page', async ({ page, st }) => {
    await st.gotoApp({ at: AT });
    await page.getByRole('button', { name: 'Account settings' }).first().click();
    await expect(page.locator('#ws-profile-pw-save')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use as dressing room screen' })).toHaveCount(0);
  });
});

test('web: a dressing share link keeps no copy and installs no hidden exit', async ({ page, st }) => {
  await st.installClock(AT);
  await page.goto(`/app.html?mode=dressing&pid=${PID}&shid=m2`);
  await page.waitForFunction(() => document.body.classList.contains('public-mode'));
  await hold(page, st, 20, 20, 3100);
  await expect(page.locator('.st-dlg')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('st_native')))).toEqual([]);
});
