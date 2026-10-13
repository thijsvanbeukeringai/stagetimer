// BOUWPLAN FASE 5A + 5D: "Message booth" crew sheet, delivery receipts and
// booth-screen presence over Realtime broadcast + presence (no DB writes).
//
// Two browser contexts share one MockBackend (and so one realtime stub): the
// logged-in operator, and an anonymous booth screen on the public share link
// (?mode=stage). Nothing leaves localhost.
const fs = require('fs');
const path = require('path');
const { test, expect, AppDriver } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const PID = FESTIVAL.projectId;
const TOPIC = `st-proj-${PID}`;
const MAIN = FESTIVAL.stages.main;
const TENT = FESTIVAL.stages.tent;
const AT = ams(FESTIVAL.dates.d1, '16:00');
const OUT = path.join(__dirname, '..', 'output', 'phase5');

test.use({ stAuth: 'admin' });

// Page errors and native dialogs fail the test (operator and booth pages).
// Fullscreen is a no-op: the app requests it on the first click on desktop
// browsers, and in fullscreen WebKit itself consumes Escape (see _operator.js).
async function watchProblems(page, problems) {
  await page.addInitScript(() => {
    const noop = function () { return Promise.resolve(); };
    Element.prototype.requestFullscreen = noop;
    Element.prototype.webkitRequestFullscreen = noop;
  });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('dialog', (d) => { problems.push('native dialog: ' + d.message()); d.dismiss().catch(() => {}); });
}

async function openOperator(page, st, problems, viewport) {
  await watchProblems(page, problems);
  if (viewport) await page.setViewportSize(viewport);
  await st.gotoApp({ at: AT });
  await st.openProject('Zomerfeest 2026');
  await page.clock.runFor(500);
}

async function openSheet(page) {
  const narrow = (page.viewportSize() || {}).width < 700;
  await page.locator(narrow ? '#cm-fab' : '#hdr-msg-btn').click();
  await expect(page.locator('#cm-ov')).toHaveClass(/open/);
  await page.clock.runFor(300);
}

// An anonymous booth screen (public Stage View link) in its own context,
// attached to the same mock backend as the operator.
async function openBooth(browser, backend, problems, { sid = MAIN } = {}) {
  const u = test.info().project.use;
  const ctx = await browser.newContext({
    baseURL: u.baseURL, timezoneId: u.timezoneId, locale: u.locale, colorScheme: u.colorScheme,
    serviceWorkers: 'block', viewport: { width: 1280, height: 720 },
  });
  await backend.attach(ctx);
  const page = await ctx.newPage();
  await watchProblems(page, problems);
  const st = new AppDriver(page, backend);
  await st.gotoPublic({ mode: 'stage', sid, at: AT });
  await expect.poll(() => backend.realtime.presenceOf(TOPIC).filter((p) => p.role === 'booth').length).toBeGreaterThan(0);
  return { ctx, page, st };
}

const serverCue = (backend) => backend.project(PID).data.cue;

test.describe('5A message booth sheet', () => {
  test('390x844: presets, free text, stage, duration, clear and blackout go through the saved project', async ({ page, st, backend }) => {
    const problems = [];
    await openOperator(page, st, problems, { width: 390, height: 844 });
    await openSheet(page);

    // Full-height sheet, no horizontal overflow, thumb-sized targets.
    const box = await page.locator('#cm').boundingBox();
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    expect(Math.round(box.height)).toBe(844);
    expect(await page.evaluate(() => document.getElementById('cm').scrollWidth <= 390)).toBe(true);
    for (const sel of ['#cm-send', '#cm-clear', '#cm-blackout', '#cm-stage', '#cm-text', '#cm-presets .cue-btn >> nth=0', '#cm .cm-x']) {
      const b = await page.locator(sel).boundingBox();
      expect(b.height, sel).toBeGreaterThanOrEqual(44);
    }
    // Default target is the active stage; the presets are the Floor cue panel's.
    await expect(page.locator('#cm-stage')).toHaveValue(MAIN);
    await expect(page.locator('#cm-presets .cue-btn')).toHaveText(['READY', '5 MIN', '1 MIN', 'WRAP UP', 'STAND BY', 'GO TO BREAK']);
    await expect(page.locator('#cm-text')).toHaveAttribute('maxlength', '40');
    await expect(page.locator('#cm-send')).toBeDisabled();
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'sheet-390.png') });

    // Preset: sent at once to the selected stage, until cleared.
    await page.locator('#cm-presets .cue-btn', { hasText: '5 MIN' }).click();
    await expect.poll(() => serverCue(backend) && serverCue(backend).text).toBe('5 MIN');
    const c1 = serverCue(backend);
    expect(c1).toMatchObject({ color: 'amber', stageId: MAIN, durationMs: null });
    expect(c1.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(typeof c1.sentAt).toBe('number');
    await expect(page.locator('#cm-presets .cue-btn', { hasText: '5 MIN' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#cm-onair-v')).toContainText('5 MIN');

    // Free text to another stage, 30 seconds.
    await page.locator('#cm-stage').selectOption(TENT);
    await page.locator('#cm .cm-seg label', { hasText: '30 s' }).click();
    await page.locator('#cm-text').fill('Stretch 2 min');
    await expect(page.locator('#cm-count')).toHaveText('13/40');
    await page.locator('#cm-send').click();
    await expect.poll(() => serverCue(backend).text).toBe('Stretch 2 min');
    const c2 = serverCue(backend);
    expect(c2).toMatchObject({ color: 'amber', stageId: TENT, durationMs: 30000 });
    expect(c2.id).not.toBe(c1.id);
    await expect(page.locator('#cm-text')).toHaveValue('');
    await expect(page.locator('#cm-onair-v')).toContainText('The Tent · disappears in');

    // All stages = stageId null (what every viewer already accepts).
    await page.locator('#cm-stage').selectOption('');
    await page.locator('#cm .cm-seg label', { hasText: 'Until cleared' }).click();
    await page.locator('#cm-text').press('Enter');   // empty: nothing is sent
    await page.locator('#cm-presets .cue-btn', { hasText: 'READY' }).click();
    await expect.poll(() => serverCue(backend).text).toBe('READY');
    expect(serverCue(backend)).toMatchObject({ stageId: null, color: 'green', durationMs: null });

    // Clear and blackout reuse clearCue / toggleBlackout.
    await page.locator('#cm-clear').click();
    await expect.poll(() => serverCue(backend)).toBeNull();
    await expect(page.locator('#cm-clear')).toBeDisabled();
    await page.locator('#cm-blackout').click();
    await expect.poll(() => backend.project(PID).data.blackout).toBe(true);
    await expect(page.locator('#cm-blackout')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#cm-bo-note')).toBeVisible();
    await page.locator('#cm-blackout').click();
    await expect.poll(() => backend.project(PID).data.blackout).toBe(false);

    // The cue length is capped where it is created, not only by maxlength.
    expect(await page.evaluate(() => { sendCue('X'.repeat(60), 'amber'); return G.cue.text.length; })).toBe(40);

    // Escape closes the sheet and focus returns to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(page.locator('#cm-ov')).not.toHaveClass(/open/);
    await expect(page.locator('#cm-fab')).toBeFocused();
    expect(problems).toEqual([]);
  });

  test('1440: side panel from the header, preset goes out', async ({ page, st, backend }) => {
    const problems = [];
    await openOperator(page, st, problems, { width: 1440, height: 900 });
    await expect(page.locator('#cm-fab')).toBeHidden();
    await openSheet(page);
    const box = await page.locator('#cm').boundingBox();
    expect(box.width).toBe(420);
    expect(box.x + box.width).toBe(1440);
    await page.screenshot({ path: path.join(OUT, 'sheet-1440.png') });
    await page.locator('#cm-presets .cue-btn', { hasText: 'WRAP UP' }).click();
    await expect.poll(() => serverCue(backend) && serverCue(backend).text).toBe('WRAP UP');
    expect(serverCue(backend)).toMatchObject({ stageId: MAIN, color: 'red' });
    // The Floor cue panel shows the same cue and its receipt line.
    await expect(page.locator('#cue-status')).toContainText('WRAP UP');
    await expect(page.locator('#cue-receipt')).toHaveText('No booth screens online for this stage');
    expect(problems).toEqual([]);
  });

  test('free text is shown as text, never as markup', async ({ page, st, backend }) => {
    const problems = [];
    await openOperator(page, st, problems, { width: 390, height: 844 });
    await openSheet(page);
    const evil = '<img src=x onerror="window.__xss=1">';
    await page.locator('#cm-text').fill(evil);
    await page.locator('#cm-send').click();
    await expect.poll(() => serverCue(backend) && serverCue(backend).text).toBe(evil);
    await page.clock.runFor(500);
    await expect(page.locator('#cm-onair-v')).toContainText(evil);
    expect(await page.locator('#cm img, #cue-panel img').count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

test.describe('5D delivery receipts and presence', () => {
  test('booth screen joins, acknowledges the cue; operator shows delivered + seen time', async ({ page, st, backend, browser }) => {
    const problems = [];
    await openOperator(page, st, problems, { width: 390, height: 844 });
    await openSheet(page);
    await expect(page.locator('#cm-presence')).toHaveText('No booth screens online for this stage');

    const booth = await openBooth(browser, backend, problems);
    const meta = backend.realtime.presenceOf(TOPIC).find((p) => p.role === 'booth');
    expect(meta).toMatchObject({ role: 'booth', stageId: MAIN, mode: 'link' });
    expect(meta.device).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(page.locator('#cm-presence')).toHaveText('1 booth screen online');
    // Presence is per stage.
    await page.locator('#cm-stage').selectOption(TENT);
    await expect(page.locator('#cm-presence')).toHaveText('No booth screens online for this stage');
    await page.locator('#cm-stage').selectOption('');
    await expect(page.locator('#cm-presence')).toHaveText('1 booth screen online (all stages)');
    await page.locator('#cm-stage').selectOption(MAIN);

    await page.locator('#cm-presets .cue-btn', { hasText: 'STAND BY' }).click();
    await expect.poll(() => serverCue(backend) && serverCue(backend).text).toBe('STAND BY');
    const cueId = serverCue(backend).id;
    // The booth shows it (same banner as always) and acknowledges it once.
    await expect(booth.page.locator('#cue-overlay')).toHaveText('STAND BY');
    await expect.poll(() => backend.realtime.broadcastsOf('cue-ack').map((b) => b.payload.cueId)).toContain(cueId);
    const ack = backend.realtime.broadcastsOf('cue-ack').find((b) => b.payload.cueId === cueId).payload;
    expect(ack).toMatchObject({ cueId, stageId: MAIN, device: meta.device });
    await expect(page.locator('#cm-receipt')).toHaveText(/^Delivered to 1 of 1 Main Stage screen · seen 16:0\d:\d\d$/);
    await expect(page.locator('#cm-receipt')).toHaveClass(/is-ok/);
    await expect(page.locator('#cue-receipt')).toHaveText(/^Delivered to 1 of 1 Main Stage screen · seen 16:0\d:\d\d$/);
    await page.screenshot({ path: path.join(OUT, 'sheet-390-delivered.png') });

    // Acks and presence only: no cue content, no REST fallback, no DB write by the booth.
    expect(backend.realtime.broadcasts.map((b) => b.event).every((e) => e === 'cue-ack' || e === 'ack-request')).toBe(true);
    expect(backend.realtime.restBroadcasts).toEqual([]);

    // The booth goes away: presence follows.
    await booth.ctx.close();
    await expect(page.locator('#cm-presence')).toHaveText('No booth screens online for this stage');
    expect(problems).toEqual([]);
  });

  test('no ack within 3 s while a screen is online: warning (page.clock)', async ({ page, st, backend, browser }) => {
    const problems = [];
    await openOperator(page, st, problems, { width: 1440, height: 900 });
    const booth = await openBooth(browser, backend, problems);
    // This booth is online but never confirms (a frozen or broken screen).
    await booth.page.evaluate(() => { window._pcAck = () => false; });
    await openSheet(page);
    await expect(page.locator('#cm-presence')).toHaveText('1 booth screen online');
    // Freeze the operator's clock: only runFor moves it from here.
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 200);
    await page.locator('#cm-presets .cue-btn', { hasText: '1 MIN' }).click();
    await page.clock.runFor(250);
    await expect(page.locator('#cm-receipt')).toHaveText('Sending to 1 Main Stage screen…');
    await page.clock.runFor(2500);
    await expect(page.locator('#cm-receipt')).toHaveText('Sending to 1 Main Stage screen…');
    await page.clock.runFor(500);
    await expect(page.locator('#cm-receipt')).toHaveText('No confirmation from the Main Stage screen after 3 s. Check the booth.');
    await expect(page.locator('#cm-receipt')).toHaveClass(/is-warn/);
    await booth.ctx.close();
    expect(problems).toEqual([]);
  });

  test('in-app Stage View on a logged-in device is a booth screen too', async ({ page, st, backend }) => {
    const problems = [];
    await openOperator(page, st, problems, { width: 1440, height: 900 });
    await page.locator('#hdr-sv-btn').click();
    await page.clock.runFor(500);
    await expect.poll(() => backend.realtime.presenceOf(TOPIC).map((p) => `${p.role}/${p.stageId}/${p.mode}`)).toEqual([`booth/${MAIN}/app`]);
    await page.evaluate(() => sendCue('READY', 'green'));
    await page.clock.runFor(500);
    const id = await page.evaluate(() => G.cue.id);
    await expect.poll(() => backend.realtime.broadcastsOf('cue-ack').map((b) => b.payload.cueId)).toContain(id);
    await expect(page.locator('#cue-receipt')).toContainText('Delivered to 1 of 1 Main Stage screen');
    // Leaving Stage View leaves presence.
    await page.evaluate(() => closeSV());
    await page.clock.runFor(500);
    await expect.poll(() => backend.realtime.presenceOf(TOPIC).length).toBe(0);
    expect(problems).toEqual([]);
  });

  test('Realtime unavailable: the cue still saves, receipt says "Delivery unknown"', async ({ page, st, backend }) => {
    backend.realtimeDown = true;
    const problems = [];
    await openOperator(page, st, problems, { width: 390, height: 844 });
    await openSheet(page);
    await expect(page.locator('#cm-presence')).toHaveText('Screen status unknown: no live link');
    await page.locator('#cm-presets .cue-btn', { hasText: 'WRAP UP' }).click();
    await expect.poll(() => serverCue(backend) && serverCue(backend).text).toBe('WRAP UP');
    await page.clock.runFor(4000);
    await expect(page.locator('#cm-receipt')).toHaveText(/^Delivery unknown: no live link to the booth screens\./);
    await expect(page.locator('#cm-receipt')).toHaveClass(/is-muted/);
    expect(backend.realtime.restBroadcasts).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('Realtime join refused: same graceful fallback', async ({ page, st, backend }) => {
    backend.realtimeJoinError = 'Unauthorized: realtime disabled (test)';
    const problems = [];
    await openOperator(page, st, problems, { width: 1440, height: 900 });
    await page.evaluate(() => sendCue('READY', 'green'));
    await expect.poll(() => serverCue(backend) && serverCue(backend).text).toBe('READY');
    await page.clock.runFor(4000);
    await expect(page.locator('#cue-receipt')).toHaveText(/^Delivery unknown/);
    expect(problems).toEqual([]);
  });

  test('anonymous broadcasts cannot send a cue or fake a receipt', async ({ page, st, backend, browser }) => {
    const problems = [];
    await openOperator(page, st, problems, { width: 1440, height: 900 });
    const booth = await openBooth(browser, backend, problems);
    await openSheet(page);
    await expect(page.locator('#cm-presence')).toHaveText('1 booth screen online');
    const patches0 = backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).length;

    // An anonymous page on the channel tries to push cue content.
    await booth.page.evaluate(() => _pc.chan.send({ type: 'broadcast', event: 'cue', payload: { text: 'HACKED', color: 'red', stageId: null } }));
    backend.realtime.sendBroadcast(TOPIC, 'cue', { text: 'HACKED 2', color: 'red' });
    await page.clock.runFor(1000);
    expect(await page.evaluate(() => G.cue)).toBeNull();
    await expect(page.locator('#cue-overlay')).toHaveText('');
    expect(backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).length).toBe(patches0);

    // Real cue for Main Stage; then forged acks.
    await booth.page.evaluate(() => { window._pcAck = () => false; });   // the real screen stays silent
    await page.locator('#cm-presets .cue-btn', { hasText: 'READY' }).click();
    await expect.poll(() => serverCue(backend) && serverCue(backend).text).toBe('READY');
    const id = serverCue(backend).id;
    const evil = '<img src=x onerror="window.__xss=1">';
    backend.realtime.sendBroadcast(TOPIC, 'cue-ack', { cueId: 'not-the-cue', stageId: MAIN, device: 'x1', at: 1 });
    backend.realtime.sendBroadcast(TOPIC, 'cue-ack', { cueId: id, stageId: TENT, device: 'x2', at: 1 });   // wrong stage
    backend.realtime.sendBroadcast(TOPIC, 'cue-ack', { cueId: id, stageId: MAIN, device: evil, at: 1 });  // invalid device
    backend.realtime.sendBroadcast(TOPIC, 'cue-ack', { cueId: evil, stageId: MAIN, device: 'x3' });
    backend.realtime.sendBroadcast(TOPIC, 'cue-ack', 'garbage');
    // A fake presence entry with markup is not counted either.
    await booth.page.evaluate((e) => _pc.chan.track({ role: 'booth', stageId: e, device: e }), evil);
    await page.clock.runFor(4000);
    await expect(page.locator('#cm-receipt')).not.toContainText('Delivered');
    expect(await page.evaluate(() => _pc.acks.dev.size)).toBe(0);
    expect(await page.locator('#cm img, #cue-panel img').count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.evaluate(() => G.cue.text)).toBe('READY');
    await booth.ctx.close();
    expect(problems).toEqual([]);
  });

  test('project switch leaves the old channel and joins the new one', async ({ page, st, backend }) => {
    const problems = [];
    await openOperator(page, st, problems, { width: 1440, height: 900 });
    const topics = () => backend.realtime.sockets.filter((c) => c.open).flatMap((c) => [...c.channels.keys()]).filter((t) => t.includes('st-proj-'));
    await expect.poll(topics).toEqual([`realtime:${TOPIC}`]);
    await page.evaluate(() => goToDash());
    await st.openProject('Kleine Clubnacht');
    await page.clock.runFor(500);
    await expect.poll(topics).toEqual([`realtime:st-proj-${FESTIVAL.smallProjectId}`]);
    expect(problems).toEqual([]);
  });
});
