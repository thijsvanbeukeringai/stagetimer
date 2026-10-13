// Regression tests: dialog component, time corrections, cues / manual mode,
// show editor validation, day management, account & workspace forms.
//
// Self-contained until the shared harness (tests/support) lands. The operator
// app runs logged in against a fully mocked backend: every request is
// answered by context.route below (auth, REST, edge functions), supabase-js is
// stubbed, WebSockets are closed, service workers blocked, and anything that
// is not the test origin or the mocked Supabase host is ABORTED and recorded
// in st.unexpected. Edge functions (invite-member, remove-member) are mocks:
// no invite or email can ever be sent.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP_HTML = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8')
  .replace(/\sintegrity="[^"]*"/g, ''); // the stubbed supabase-js would fail SRI
const ORIGIN = 'https://stagetimer.test';
const SUPA = 'https://bamjpsquhdzxvsymldpq.supabase.co';
const SUPA_STUB = `window.supabase={createClient(){const ch={on(){return ch},subscribe(){return ch}};return{
  auth:{onAuthStateChange(){return{data:{subscription:{unsubscribe(){}}}}},getSession:async()=>({data:{session:null}}),
        setSession:async()=>({data:{session:null}}),signOut:async()=>({}),refreshSession:async()=>({data:{session:null}}),
        updateUser:async()=>({data:{},error:null})},
  channel(){return ch},removeChannel(){},
  from(){const q={select(){return q},eq(){return q},insert(){return q},update(){return q},then(r){r({data:null,error:{message:'stubbed'}})}};return q}}}};`;

const USER = { id: 'U1', name: 'Olivia Operator', email: 'olivia@test.nl', role: 'company_admin', company_id: 'C1' };
const COMPANY = {
  id: 'C1', name: 'Test Events', subscription_status: 'active', plan_slug: 'team', project_limit: 5,
  current_period_end: '2027-01-01T00:00:00Z', last_paid_at: '2026-01-01T00:00:00Z', extra_seats: 1, setup_pending: false,
};
function projectData(extra) {
  return Object.assign({
    stages: [{ id: 's1', name: 'Main' }, { id: 's2', name: 'Second' }],
    days: [{ id: 'd1', name: 'Friday', date: '2026-06-19' }, { id: 'd2', name: 'Saturday', date: '2026-06-20' }],
    activeStage: 's1', activeDay: 'd1', timerMode: 'live', fohNotes: {},
    shows: [
      { id: 'a', stage: 's1', day: 'd1', artist: 'Alpha', date: '2026-06-19', start: '22:00:00', end: '23:00:00', startsAt: '2026-06-19T22:00:00', endsAt: '2026-06-19T23:00:00' },
      { id: 'b', stage: 's1', day: 'd1', artist: 'Bravo', date: '2026-06-19', start: '23:00:00', end: '23:30:00', startsAt: '2026-06-19T23:00:00', endsAt: '2026-06-19T23:30:00' },
      { id: 'c', stage: 's1', day: 'd1', artist: 'Charlie', date: '2026-06-19', start: '23:30:00', end: '00:30:00', startsAt: '2026-06-19T23:30:00', endsAt: '2026-06-20T00:30:00' },
      { id: 'e', stage: 's1', day: 'd2', artist: 'Echo', date: '2026-06-20', start: '20:00:00', end: '21:00:00', startsAt: '2026-06-20T20:00:00', endsAt: '2026-06-20T21:00:00' },
    ],
  }, extra || {});
}

// Opens the logged-in operator app. opts.invite: (body) => {status, json}.
async function openOperator(browser, { at = '2026-06-19T22:30:00+02:00', data, user, invite, viewport, open = true } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'Europe/Amsterdam', viewport: viewport || { width: 1280, height: 800 } });
  if (context.routeWebSocket) await context.routeWebSocket(/.*/, ws => ws.close());
  const page = await context.newPage();
  const u = Object.assign({}, USER, user || {});
  const st = { unexpected: [], errors: [], invites: [], patches: [], restWrites: [], data: projectData(data) };
  page.on('pageerror', e => st.errors.push(e.message));
  page.on('dialog', d => { st.errors.push('native dialog: ' + d.message()); d.dismiss(); });
  await page.clock.install({ time: new Date(at) });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('**/*', async route => {
    const req = route.request(), url = req.url(), m = req.method();
    if (url.startsWith(ORIGIN + '/app.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: APP_HTML });
    if (url.includes('/vendor/supabase.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPA_STUB });
    if (url.startsWith(SUPA + '/')) {
      const p = url.slice(SUPA.length);
      if (p.startsWith('/auth/v1/user')) return m === 'PUT' ? json(route, { id: u.id, email: u.email }) : json(route, { id: u.id, email: u.email });
      if (p.startsWith('/auth/v1/token')) return json(route, { access_token: 'user.jwt', refresh_token: 'r' });
      if (p.startsWith('/functions/v1/invite-member')) {
        const body = JSON.parse(req.postData() || '{}');
        st.invites.push({ body, auth: req.headers()['authorization'] });
        const r = invite ? invite(body) : { status: 200, json: { message: 'Invite sent to ' + body.email + '.' } };
        return json(route, r.json, r.status);
      }
      if (p.startsWith('/functions/v1/')) return json(route, { error: 'not mocked' }, 500);
      if (m === 'HEAD') return route.fulfill({ status: 200, headers: { date: new Date(at).toUTCString() }, body: '' });
      if (p.startsWith('/rest/v1/companies')) {
        if (m !== 'GET') { st.restWrites.push({ m, p, body: req.postData() }); return json(route, [COMPANY]); }
        return json(route, [COMPANY]);
      }
      if (p.startsWith('/rest/v1/app_users')) {
        if (m !== 'GET') { st.restWrites.push({ m, p, body: req.postData() }); return json(route, [u]); }
        return json(route, [u, { id: 'U2', name: 'Max Member', email: 'max@test.nl', role: 'operator', company_id: 'C1' }]);
      }
      if (p.startsWith('/rest/v1/projects')) {
        const row = { id: 'P1', name: 'Summer Fest', company_id: 'C1', created_by: null, created_at: '2026-01-01', data: st.data };
        if (m === 'PATCH') {
          const b = JSON.parse(req.postData() || '{}');
          st.patches.push(b);
          if (b.data) st.data = b.data;
          if (b.name) row.name = b.name;
          return json(route, [{ id: 'P1' }]);
        }
        if (m === 'DELETE') return json(route, [{ id: 'P1' }]);
        return json(route, [row]);
      }
      if (p.startsWith('/rest/v1/')) return json(route, []);
      st.unexpected.push(url);
      return route.abort();
    }
    if (url.startsWith(ORIGIN + '/')) {
      const f = path.join(ROOT, decodeURIComponent(new URL(url).pathname));
      if (f.startsWith(ROOT) && !f.includes('/tests/') && fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, path: f });
      return route.fulfill({ status: 404, body: '' });
    }
    st.unexpected.push(url);
    return route.abort();
  });
  await page.addInitScript(([uu]) => {
    localStorage.setItem('st_auth_v1', JSON.stringify({ access_token: 'user.jwt', refresh_token: 'r' }));
    localStorage.setItem('st_current_user', JSON.stringify({ id: uu.id, name: uu.name, email: uu.email, role: uu.role, companyId: uu.company_id }));
    localStorage.setItem('st_active_proj', 'P1');
  }, [u]);
  await page.goto(`${ORIGIN}/app.html`);
  await page.clock.runFor(1500);
  await expect(page.locator('#dash')).toHaveClass(/open/);
  if (open) {
    await page.evaluate(() => openProject('P1'));
    await page.clock.runFor(500);
  }
  return { page, context, st };
}
const dlg = page => page.locator('.st-dlg[role="dialog"]');
async function done({ context, st }) {
  expect(st.errors).toEqual([]);
  expect(st.unexpected).toEqual([]);
  await context.close();
}

test.describe('dialog component', () => {
  test('labelled, focus trap, Escape cancels, focus returns to the trigger', async ({ browser }) => {
    const r = await openOperator(browser);
    const { page } = r;
    await page.evaluate(() => {
      const b = document.createElement('button'); b.id = 'trig'; b.textContent = 'open';
      b.onclick = () => { window.__res = 'pending'; stDialog.confirm('Delete "<b>x</b>"?', { title: 'Delete show', okLabel: 'Delete show', danger: true }).then(v => { window.__res = v; }); };
      document.body.appendChild(b);
    });
    await page.locator('#trig').focus();
    await page.keyboard.press('Enter');
    const d = dlg(page);
    await expect(d).toBeVisible();
    await expect(d).toHaveAttribute('aria-modal', 'true');
    const labelId = await d.getAttribute('aria-labelledby');
    await expect(page.locator('#' + labelId)).toHaveText('Delete show');
    await expect(d.locator('.st-dlg-msg')).toHaveText('Delete "<b>x</b>"?'); // escaped, not markup
    // Destructive: the safe choice has focus, the danger button is marked.
    await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(d.getByRole('button', { name: 'Delete show' })).toHaveClass(/st-dlg-danger/);
    // Tab wraps inside the dialog, both ways.
    await page.keyboard.press('Tab');
    await expect(d.getByRole('button', { name: 'Delete show' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(d.getByRole('button', { name: 'Delete show' })).toBeFocused();
    // Escape cancels and closes only the dialog, focus back on the trigger.
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    expect(await page.evaluate(() => window.__res)).toBe(false);
    await expect(page.locator('#trig')).toBeFocused();
    // Enter on the confirm button confirms.
    await page.keyboard.press('Enter');
    await expect(d).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(d).toHaveCount(0);
    expect(await page.evaluate(() => window.__res)).toBe(true);
    await done(r);
  });
  test('form: inline field errors, Enter submits, async errors keep it open', async ({ browser }) => {
    const r = await openOperator(browser);
    const { page } = r;
    await page.evaluate(() => {
      window.__calls = 0;
      window.__p = stDialog.form({
        title: 'Rename', fields: [{ name: 'name', label: 'Name', required: true }],
        onSubmit: async v => { window.__calls++; if (window.__calls === 1) throw new Error('Server said no.'); return undefined; },
      });
    });
    const d = dlg(page);
    await expect(d.getByLabel('Name')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(d.locator('.st-dlg-err')).toHaveText('Name is required.');
    await expect(d.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');
    await page.keyboard.type('New name');
    await expect(d.locator('.st-dlg-err')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(d.locator('.st-dlg-formerr')).toHaveText('Server said no.');
    await page.keyboard.press('Enter'); // focus is on the submit button now
    expect(await page.evaluate(() => window.__p)).toEqual({ name: 'New name' });
    await expect(d).toHaveCount(0);
    await done(r);
  });
});
