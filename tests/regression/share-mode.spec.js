// Regression: share links read get_shared_project(p_id, p_mode) - MIGRATIES
// step 9 (last item) / share_link_rpcs PHASE B prerequisite.
//
//  * every public mode asks for its own p_mode (early <head> fetch + polls);
//  * fallback chain 2-arg -> 1-arg -> direct table read, only on "function
//    missing" (404 / PGRST202), remembered per session; never on 401 / 5xx;
//  * the stripped payload holds no photos, crew, notes, FOH notes, memberIds
//    or logo where the mode does not render them (field matrix in
//    tests/support/share-modes.js, checked against the SQL here);
//  * every view renders exactly the same DOM on the stripped feed as on the
//    full legacy blob;
//  * get_shared_project_version: poll the version, fetch the project only
//    when it changed (and once a minute), __stLastSyncOk unchanged.
// Stage View pixels on the stripped feed: tests/booth (stripped feed).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams, festivalData } = require('../support/seed');
const { SHARE_MODES, SHARE_FIELD_MATRIX, stripProjectData } = require('../support/share-modes');

const S = FESTIVAL.stages;
const PID = FESTIVAL.projectId;
const AT = ams(FESTIVAL.dates.d1, '16:00');   // DJ O'Neil (note, crew, photo, FOH note) live on Main
const RPC = '/rest/v1/rpc/get_shared_project';
const VER = '/rest/v1/rpc/get_shared_project_version';
const SID = { stage: S.main, backstage: S.main, foh: S.main };
const VIEW = { stage: '#sv', backstage: '#bs-body', foh: '#foh-col-body', timeline: '#tl', overview: '#stov', wall: '#wv-body', checkin: '#ci' };
const SQL_FILE = path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261013100000_share_link_rpcs.sql');

const reads = (backend) => backend.calls({ method: 'POST', path: RPC });
const tableReads = (backend) => backend.calls({ method: 'GET', path: '/rest/v1/projects' });
const variant = (c) => Object.keys(c.body || {}).sort().join(',');
const open = (st, mode, extra = {}) => st.gotoPublic({ mode, sid: SID[mode], at: AT, paused: true, ...extra });

// One second of fake time (one poll), then wait until that poll is applied.
async function pollStep(page) {
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => window.__stLastSyncOk === Date.now()), { message: 'poll applied' }).toBe(true);
}

test.use({ viewport: { width: 1280, height: 800 } });

test.describe('every mode asks for its own p_mode', () => {
  for (const mode of SHARE_MODES) {
    test(mode, async ({ page, st, backend }) => {
      await open(st, mode);
      await pollStep(page);
      await pollStep(page);
      const calls = reads(backend);
      expect(calls.length).toBeGreaterThanOrEqual(3);   // early fetch + two polls
      expect(calls.map(variant)).toEqual(calls.map(() => 'p_id,p_mode'));
      expect(calls.map((c) => c.body.p_mode)).toEqual(calls.map(() => mode));
      expect(calls.map((c) => c.body.p_id)).toEqual(calls.map(() => PID));
      expect(tableReads(backend)).toEqual([]);
    });
  }
});

test.describe('stripped payload', () => {
  for (const mode of SHARE_MODES) {
    test(`${mode}: only what the mode renders`, async ({ page, st }) => {
      await open(st, mode);
      await pollStep(page);
      const row = JSON.parse(await page.evaluate(() => _pvLastText));
      expect(row.company_id).toBeNull();
      expect(row.data).toEqual(stripProjectData(festivalData(), mode));
      const text = JSON.stringify(row);
      expect(text).not.toContain('data:image');            // no photo, no logo, ever
      expect(row.data.memberIds).toEqual([]);
      const shows = row.data.shows;
      const has = (k) => shows.some((s) => k in s);
      expect.soft(has('photo'), 'photo').toBe(false);
      expect.soft(has('crew'), 'crew').toBe(mode === 'foh');
      expect.soft(has('note'), 'note').toBe(mode === 'backstage');
      expect.soft(Object.keys(row.data.fohNotes).length > 0, 'fohNotes').toBe(mode === 'foh' || mode === 'backstage');
      if (mode !== 'foh') expect(text).not.toContain('Bram');            // crew name
      if (mode !== 'backstage') expect(text).not.toContain('USB backup'); // show note
      // What every mode needs for the clock and overlays is still there.
      for (const k of ['stages', 'days', 'shows', 'svModes', 'cue', 'blackout', 'timerMode']) expect(row.data).toHaveProperty(k);
      expect(shows.find((s) => s.id === 'm2')).toMatchObject({ artist: "DJ O'Neil", genre: 'House', booth: 'B', startsAt: '2026-07-10T15:30:00' });
    });
  }
  test('unknown mode gets the strictest set', async ({ backend }) => {
    const r = await backend._rpc('get_shared_project', { p_id: PID, p_mode: 'nope' });
    expect(r.json.data).toEqual(stripProjectData(festivalData(), 'strict'));
    expect(JSON.stringify(r.json)).not.toMatch(/data:image|Bram|USB backup|Extra monitor/);
  });
});

test.describe('every view renders the same on the stripped feed', () => {
  for (const mode of SHARE_MODES) {
    test(mode, async ({ page, st, backend }) => {
      backend.shareFeed('legacy');
      await open(st, mode);
      const full = await page.locator(VIEW[mode]).innerHTML();
      expect(reads(backend).some((c) => variant(c) === 'p_id')).toBe(true);
      backend.shareFeed('modes');
      await open(st, mode);
      expect(await page.locator(VIEW[mode]).innerHTML()).toBe(full);
      expect(await page.evaluate(() => window._sharedProjectVia)).toBe('mode');   // decided by the early fetch
    });
  }
  test('the data itself is on screen', async ({ page, st }) => {
    await open(st, 'backstage');
    await expect(page.locator('#bs-body')).toContainText("Bring O'Neil's USB backup");
    await expect(page.locator('#bs-body')).toContainText("Extra monitor for DJ O'Neil");
    await open(st, 'foh');
    await expect(page.locator('.foh-crew-row', { hasText: 'Bram' })).toContainText('On the way');
    await expect(page.locator('#foh-col-body')).toContainText("Extra monitor for DJ O'Neil");
    await open(st, 'stage');
    await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
    await expect(page.locator('#sv-genre')).toHaveText('House');
  });
});

test.describe('fallback chain', () => {
  test('no 2-arg variant: get_shared_project(p_id), remembered', async ({ page, st, backend }) => {
    backend.shareFeed('legacy');
    await open(st, 'foh');
    for (let i = 0; i < 3; i++) await pollStep(page);
    await expect(page.locator('#foh-col-body')).toContainText('Bram');
    // early fetch: 2-arg (404), 1-arg; then every poll goes straight to 1-arg
    expect(reads(backend).map(variant)).toEqual(['p_id,p_mode', 'p_id', 'p_id', 'p_id', 'p_id']);
    expect(tableReads(backend)).toEqual([]);
  });
  test('no RPC at all: direct table read, remembered', async ({ page, st, backend }) => {
    backend.shareFeed('table');
    await open(st, 'stage');
    for (let i = 0; i < 3; i++) await pollStep(page);
    await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
    expect(reads(backend).map(variant)).toEqual(['p_id,p_mode', 'p_id']);
    expect(tableReads(backend).length).toBe(4);   // early fetch + three polls
  });
  test('the 2-arg variant disappears mid-session: next poll uses p_id', async ({ page, st, backend }) => {
    await open(st, 'stage');
    await pollStep(page);
    backend.shareFeed('legacy');
    const before = reads(backend).length;
    await pollStep(page);
    await pollStep(page);
    expect(reads(backend).slice(before).map(variant)).toEqual(['p_id,p_mode', 'p_id', 'p_id']);
    expect(await page.evaluate(() => _sharedProjectVia)).toBe('pid');
  });
  for (const status of [401, 500, 503]) {
    test(`${status} is not "missing": no fallback`, async ({ page, st, backend }) => {
      await open(st, 'backstage');
      await pollStep(page);
      backend.failNext({ path: RPC, status, json: { message: `injected ${status}` }, times: 3 });
      const before = reads(backend).length;
      const okBefore = await page.evaluate(() => window.__stLastSyncOk);
      for (let i = 0; i < 3; i++) {
        await page.clock.runFor(1000);
        await expect.poll(() => reads(backend).length).toBe(before + i + 1);
      }
      expect(reads(backend).slice(before).map(variant)).toEqual(['p_id,p_mode', 'p_id,p_mode', 'p_id,p_mode']);
      expect(tableReads(backend)).toEqual([]);
      expect(await page.evaluate(() => [window.__stLastSyncOk, _sharedProjectVia])).toEqual([okBefore, 'mode']);
      await expect(page.locator('#bs-body')).toContainText("DJ O'Neil");   // last data kept
      await pollStep(page);                                                 // recovers on the same variant
      expect(reads(backend).at(-1).body.p_mode).toBe('backstage');
    });
  }
  test('401 at boot never reads the table or the 1-arg variant', async ({ page, st, backend }) => {
    backend.failNext({ path: RPC, status: 401, json: { message: 'JWT expired' }, times: 10 });
    await st.installClock(AT, { paused: true });
    await page.goto(`/app.html?mode=wall&pid=${PID}`);
    await expect.poll(() => reads(backend).length).toBeGreaterThanOrEqual(2);   // early fetch + load
    await page.clock.runFor(5000);
    expect(reads(backend).map(variant).every((v) => v === 'p_id,p_mode')).toBe(true);
    expect(tableReads(backend)).toEqual([]);
  });
});

test.describe('version poll (get_shared_project_version)', () => {
  test('project fetched only when the version changed', async ({ page, st, backend }) => {
    backend.shareFeed('version');
    await open(st, 'stage');
    await pollStep(page);                                // first poll: version + full fetch
    const full0 = reads(backend).length;
    for (let i = 0; i < 4; i++) await pollStep(page);    // unchanged: version only
    expect(reads(backend).length).toBe(full0);
    expect(backend.calls({ method: 'POST', path: VER }).length).toBe(5);
    backend.updateProject(PID, (d) => { d.cue = { text: 'STAND BY', color: 'blue', stageId: S.main, sentAt: AT.getTime(), durationMs: null }; });
    await pollStep(page);
    expect(reads(backend).length).toBe(full0 + 1);
    expect(reads(backend).at(-1).body.p_mode).toBe('stage');
    await expect(page.locator('#cue-overlay')).toHaveText('STAND BY');
    await pollStep(page);
    expect(reads(backend).length).toBe(full0 + 1);
  });
  test('a full fetch at least once a minute', async ({ page, st, backend }) => {
    backend.shareFeed('version');
    await open(st, 'wall');
    await pollStep(page);
    const full0 = reads(backend).length;
    await page.clock.runFor(61000);
    await pollStep(page);
    expect(reads(backend).length).toBeGreaterThan(full0);
  });
  test('version poll failure is a failed sync, not a fallback', async ({ page, st, backend }) => {
    backend.shareFeed('version');
    await open(st, 'timeline');
    await pollStep(page);
    const okBefore = await page.evaluate(() => window.__stLastSyncOk);
    const full0 = reads(backend).length;
    backend.failNext({ path: VER, status: 500, times: 2 });
    for (let i = 1; i <= 2; i++) {
      await page.clock.runFor(1000);
      await expect.poll(() => backend.calls({ method: 'POST', path: VER }).filter((c) => c.injected).length).toBe(i);
    }
    expect(await page.evaluate(() => [window.__stLastSyncOk, _pvVerAvail])).toEqual([okBefore, true]);
    expect(reads(backend).length).toBe(full0);
    await pollStep(page);
  });
  test('no version function: probed once, then the full poll as before', async ({ page, st, backend }) => {
    await open(st, 'overview');                          // default mock: no get_shared_project_version
    for (let i = 0; i < 3; i++) await pollStep(page);
    expect(backend.calls({ method: 'POST', path: VER }).length).toBe(1);
    expect(reads(backend).length).toBe(4);               // early fetch + one per poll
  });
});

test('field matrix in the SQL equals the mock / spec matrix', () => {
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  // Header table: "--     <field>   - yes ..." in the column order of the header line.
  const head = /^--\s+field \(in data\)\s+(.+)$/m.exec(sql);
  expect(head, 'matrix header in the SQL comment').not.toBeNull();
  const cols = head[1].trim().split(/\s+/);
  expect(cols).toEqual([...SHARE_MODES]);
  const rows = {};
  for (const field of Object.keys(SHARE_FIELD_MATRIX)) {
    const m = new RegExp(`^--\\s+${field.replace(/[[\].]/g, '\\$&')}\\s+((?:(?:yes|-)\\s*){${cols.length}})$`, 'm').exec(sql);
    expect(m, `matrix row for ${field}`).not.toBeNull();
    rows[field] = m[1].trim().split(/\s+/).map((v, i) => (v === 'yes' ? cols[i] : null)).filter(Boolean);
  }
  const fromJs = Object.fromEntries(Object.entries(SHARE_FIELD_MATRIX).map(([f, ms]) => [f, ms.filter((m) => m !== 'legacy')]));
  expect(rows).toEqual(fromJs);
  // And the function body uses the same lists.
  const keep = (name) => {
    const m = new RegExp(`${name}\\s+boolean := p_mode in \\(([^)]*)\\)`).exec(sql);
    return m ? m[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort() : null;
  };
  expect(keep('keep_foh')).toEqual([...SHARE_FIELD_MATRIX.fohNotes].sort());
  expect(keep('keep_note')).toEqual([...SHARE_FIELD_MATRIX['shows[].note']].sort());
  expect(keep('keep_crew')).toEqual([...SHARE_FIELD_MATRIX['shows[].crew']].sort());
});
