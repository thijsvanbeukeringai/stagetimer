// Screenshot harness for the operator control screen and Stage View.
//
//   node tests/tools/ui-capture.js <label> [app.html path]
//
// Writes PNGs to tests/output/<label>/ (gitignored). Every request is answered
// locally: app.html and its assets come from disk, supabase-js is stubbed, the
// share-link RPC is a fixture, and ANY other request is aborted and reported
// (the run fails), so nothing can reach production.
//
// For eyeballing before/after layouts at the BOUWPLAN sizes (320 ... 1440,
// 1024x600, 844x390). The Stage View sv-* shots are for reference only: the
// pixel-exact boothscreen check is tests/booth (npm run test:booth).
const fs = require('fs');
const os = require('os');
const path = require('path');
const alt = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright-st');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(alt)) process.env.PLAYWRIGHT_BROWSERS_PATH = alt;
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..', '..');
const label = process.argv[2] || 'run';
const appPath = process.argv[3] || path.join(ROOT, 'app.html');
const OUT = path.join(ROOT, 'tests', 'output', label);
fs.mkdirSync(OUT, { recursive: true });

const APP_HTML = fs.readFileSync(appPath, 'utf8').replace(/\sintegrity="[^"]*"/g, '');
const ORIGIN = 'https://stagetimer.test';
const SUPA = 'https://bamjpsquhdzxvsymldpq.supabase.co/';
const SUPA_STUB = `window.supabase={createClient(){const ch={on(){return ch},subscribe(){return ch}};return{
  auth:{onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}},getSession:async()=>({data:{session:null}}),
        setSession:async()=>({data:{session:null}}),signOut:async()=>({}),refreshSession:async()=>({data:{session:null}})},
  channel(){return ch},removeChannel(){},
  from(){const q={select(){return q},eq(){return q},insert(){return q},update(){return q},then(r){r({data:[],error:null})}};return q}}}};`;

const LONG = 'Dimitri Vegas & Like Mike presents The Extraordinarily Long Artist Name Collective';
const crewFull = {
  vj: { name: 'Sanne de Vries', status: 'present' }, light: { name: 'Mo Haddad', status: 'otw' },
  sound: { name: 'Pieter-Jan van den Berg', status: '' }, sfx: { name: 'Lotte', status: 'unknown' },
  laser: { name: 'Kees', status: 'present' },
};
const show = (id, day, date, start, end, artist, extra) => Object.assign({ id, stage: 's1', day, date, start, end, artist }, extra || {});
function projectData() {
  return {
    stages: [{ id: 's1', name: 'Main Stage' }, { id: 's2', name: 'The Extraordinarily Long Named Second Stage Tent' }, { id: 's3', name: 'Club' }],
    days: [{ id: 'd1', name: 'Friday', date: '2026-06-19' }, { id: 'd2', name: 'Saturday', date: '2026-06-20' }, { id: 'd3', name: 'Sunday (empty)', date: '2026-06-21' }],
    activeStage: 's1', activeDay: 'd1', timerMode: 'live',
    fohNotes: {
      b: [{ id: 'n1', time: '23:50', text: 'Pyro cue at the drop, confirm with SFX before the second chorus', color: '#ffe600' },
        { id: 'n2', time: '', text: 'Guest list: +4', color: '#22c55e' }],
    },
    shows: [
      show('p', 'd1', '2026-06-19', '18:00:00', '19:00:00', 'Opening Act', { note: 'Line check 17:30', crew: { sound: { name: 'Pieter', status: 'present' } }, arrived: true }),
      show('c', 'd1', '2026-06-19', '19:00:00', '20:00:00', 'Cancelled Artist', { cancelled: true }),
      show('l', 'd1', '2026-06-19', '21:30:00', '23:00:00', LONG, { booth: 'A', type: 'live', priority: true, arrived: true, crew: crewFull,
        note: 'Long note: artist brings own DJM-V10, needs 2x CDJ-3000 linked, monitor wedges at max, no strobes during the first track.' }),
      show('h', 'd1', '2026-06-19', '23:00:00', '23:45:00', 'Hidden Guest', { hidden: true, booth: 'B' }),
      show('b', 'd1', '2026-06-19', '23:45:00', '01:30:00', 'Bravo (overnight)', { booth: 'B', crew: { vj: { name: 'Sanne', status: '' }, light: { name: 'Mo', status: 'present' } } }),
      show('z', 'd1', '2026-06-20', '01:30:00', '02:30:00', 'Closing', { type: 'break' }),
      show('s2a', 'd1', '2026-06-19', '22:00:00', '23:30:00', 'Second stage act', { stage: 's2' }),
      show('d2a', 'd2', '2026-06-20', '20:00:00', '21:00:00', 'Saturday One', {}),
    ],
  };
}
const PROJECT = { id: 'P1', name: 'Zomerfestival Amsterdam 2026 - Hoofdprogramma met een lange projectnaam', companyId: 'C1', data: projectData() };
const APP = { companies: [{ id: 'C1', name: 'Test Events BV' }], users: [{ id: 'U1', name: 'Olivia Operator', email: 'op@example.test', role: 'admin', companyId: 'C1' }], projects: [PROJECT], activeProjectId: 'P1', timers: [] };
const USER = { id: 'U1', name: 'Olivia Operator', email: 'op@example.test', role: 'admin', companyId: 'C1' };

const SIZES = [
  { name: '320x568', width: 320, height: 568, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '700x900', width: 700, height: 900, mobile: true },
  { name: '720x900', width: 720, height: 900, mobile: true },
  { name: '768x1024', width: 768, height: 1024, mobile: true },
  { name: '1024x768', width: 1024, height: 768, mobile: true },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x600', width: 1024, height: 600 },
  { name: '844x390', width: 844, height: 390, mobile: true },
];
const AT = '2026-06-19T22:30:00+02:00';

const violations = [];
const errors = [];
async function newPage(browser, size, at) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1,
    isMobile: !!size.mobile, hasTouch: !!size.mobile, timezoneId: 'Europe/Amsterdam', serviceWorkers: 'block', locale: 'en-GB',
  });
  if (context.routeWebSocket) await context.routeWebSocket(/.*/, ws => ws.close());
  const row = { data: projectData() };
  await context.route('**/*', async route => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN + '/app.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: APP_HTML });
    if (u.includes('/vendor/supabase.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPA_STUB });
    if (u.startsWith(ORIGIN + '/')) {
      const p = path.join(ROOT, decodeURIComponent(new URL(u).pathname));
      if (p.startsWith(ROOT) && fs.existsSync(p) && fs.statSync(p).isFile()) return route.fulfill({ status: 200, path: p });
      return route.fulfill({ status: 404, body: '' });
    }
    if (u.startsWith(SUPA)) {
      if (u.includes('/rpc/get_shared_project')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'P1', name: PROJECT.name, company_id: 'C1', data: projectData() }) });
      if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers: { date: new Date(at).toUTCString() }, body: '' });
      // The operator's own project row: read for the merge, PATCHed on save.
      if (u.includes('/rest/v1/projects?id=eq.P1')) {
        const req = route.request();
        if (req.method() === 'PATCH') { try { row.data = JSON.parse(req.postData()).data; } catch (_) {} }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'P1', name: PROJECT.name, data: row.data }]) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    violations.push(u);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(size.name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(size.name + ' console: ' + m.text()); });
  await page.clock.install({ time: new Date(at) });
  return { context, page };
}

async function openOperator(browser, size, at = AT) {
  const { context, page } = await newPage(browser, size, at);
  await page.addInitScript(([app, user]) => {
    localStorage.setItem('st_app_v1', JSON.stringify(app));
    localStorage.setItem('st_current_user', JSON.stringify(user));
  }, [APP, USER]);
  await page.goto(`${ORIGIN}/app.html`);
  await page.clock.runFor(500);
  await page.evaluate(() => {
    document.documentElement.classList.remove('no-session');
    document.getElementById('login').classList.remove('open');
    _hideLoader();
    if (typeof _showLogoutBtn === 'function') _showLogoutBtn(true);
    openProject('P1');
  });
  await page.clock.runFor(1500);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png'), animations: 'disabled', caret: 'hide' });

async function operatorShots(browser) {
  for (const size of SIZES) {
    const { context, page } = await openOperator(browser, size);
    await shot(page, `op-${size.name}`);
    // Manual mode, scrolled schedule, open menus: the states people complain about.
    if (size.name === '390x844' || size.name === '1440x900' || size.name === '768x1024') {
      await page.evaluate(() => ['slist', 'body', 'tpanel'].forEach(id => { const l = document.getElementById(id); if (l) l.scrollTop = 99999; }));
      await shot(page, `op-${size.name}-scrolled`);
      await page.evaluate(() => { ['slist', 'body', 'tpanel'].forEach(id => { const l = document.getElementById(id); if (l) l.scrollTop = 0; }); setMode('manual'); });
      await page.clock.runFor(300);
      await shot(page, `op-${size.name}-manual`);
      await page.evaluate(() => setMode('live'));
      // Mobile: the folded controls opened (only exists in the new layout).
      if (size.mobile && await page.evaluate(() => typeof toggleCtrlPanel === 'function')) {
        await page.evaluate(() => { toggleCtrlPanel(true); sendCue('WRAP UP', 'red'); });
        await page.clock.runFor(300);
        await shot(page, `op-${size.name}-controls`);
        await page.evaluate(() => toggleDD('admin-dd'));
        await shot(page, `op-${size.name}-menu`);
      }
    }
    if (size.name === '1440x900') {
      await page.evaluate(() => toggleDD('admin-dd'));
      await shot(page, `op-${size.name}-menu`);
      await page.evaluate(() => closeAllDD());
      await page.evaluate(() => setSaveState('unsaved', 'You are offline. Changes stay on this device.'));
      await shot(page, `op-${size.name}-unsaved`);
    }
    await context.close();
  }
}

// Stage View states. Each returns after renderSV has run.
const SV_STATES = [
  { name: 'countdown', at: AT },
  { name: 'last90s', at: '2026-06-19T22:58:30+02:00' },
  { name: 'blink', at: '2026-06-19T22:59:45+02:00' },
  { name: 'gap', at: '2026-06-19T20:30:00+02:00' },
  { name: 'clock', at: AT, mode: 'clock' },
  { name: 'countup', at: AT, mode: 'countup' },
  { name: 'blank', at: AT, mode: 'blank' },
  { name: 'idle', at: AT, day: 'd3' },
];
const SV_SIZES = [SIZES[1], SIZES[0], SIZES[4], SIZES[5], SIZES[6], SIZES[7], SIZES[8]];

async function svShots(browser) {
  for (const size of SV_SIZES) {
    for (const st of SV_STATES) {
      const { context, page } = await openOperator(browser, size, st.at);
      await page.evaluate(s => {
        if (s.day) setDay(s.day);
        if (s.mode) { G.svModes = { s1: s.mode }; }
        openSV(); renderSV();
      }, st);
      await page.clock.runFor(1200);
      await shot(page, `sv-op-${size.name}-${st.name}`);
      await context.close();
    }
    // Public share link (the booth itself).
    const { context, page } = await newPage(browser, size, AT);
    await page.goto(`${ORIGIN}/app.html?mode=stage&pid=P1&sid=s1`);
    await page.clock.runFor(2500);
    await page.evaluate(() => document.fonts.ready);
    await shot(page, `sv-pub-${size.name}`);
    const meta = await page.evaluate(() => document.querySelector('meta[name=viewport]').content);
    fs.writeFileSync(path.join(OUT, `sv-pub-${size.name}.viewport.txt`), meta);
    await context.close();
  }
}

async function dashShots(browser) {
  // One-off timers on the dashboard (overlap bug, §8).
  for (const size of [SIZES[1], SIZES[6]]) {
    const { context, page } = await openOperator(browser, size);
    await page.evaluate(() => {
      APP.timers = [
        { id: 't1', artist: 'Speech by the mayor of a very long municipality name', date: '2026-06-19', start: '22:00:00', end: '23:00:00', createdBy: 'U1', note: 'Mic 3' },
        { id: 't2', artist: 'Fireworks', date: '2026-06-20', start: '23:00:00', end: '23:15:00', createdBy: 'U1' },
      ];
      goToDash();
    });
    await page.clock.runFor(800);
    await page.evaluate(() => { const o = document.getElementById('ot-grid'); if (o) o.scrollIntoView(); });
    await shot(page, `dash-ot-${size.name}`);
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const only = process.env.ONLY || 'op,sv,dash';
  if (only.includes('op')) await operatorShots(browser);
  if (only.includes('sv')) await svShots(browser);
  if (only.includes('dash')) await dashShots(browser);
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'errors.json'), JSON.stringify({ violations, errors }, null, 2));
  console.log(`${label}: ${fs.readdirSync(OUT).filter(f => f.endsWith('.png')).length} screenshots in ${OUT}`);
  console.log('non-local requests (aborted):', violations.length, violations.slice(0, 5));
  console.log('page errors:', errors.length, errors.slice(0, 10));
  if (violations.length) process.exitCode = 1;
})();
