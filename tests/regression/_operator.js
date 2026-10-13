// Small adapter on the shared harness (tests/support) for the dialog / form
// regression specs: a compact project (two stages, three back-to-back shows
// on Friday night) inside the seeded "Zomerfeest 2026", opened logged in.
// The mock backend aborts and reports any non-local request; edge functions
// (invite-member, remove-member, ...) are mocks, so no invite or email can
// ever be sent.
const { test: base, expect } = require('../support/fixtures');

function projectData(extra) {
  return Object.assign({
    stages: [{ id: 's1', name: 'Main' }, { id: 's2', name: 'Second' }],
    days: [{ id: 'd1', name: 'Friday', date: '2026-06-19' }, { id: 'd2', name: 'Saturday', date: '2026-06-20' }],
    activeStage: 's1', activeDay: 'd1', timerMode: 'live', fohNotes: {}, memberIds: [],
    shows: [
      { id: 'a', stage: 's1', day: 'd1', artist: 'Alpha', date: '2026-06-19', start: '22:00:00', end: '23:00:00', startsAt: '2026-06-19T22:00:00', endsAt: '2026-06-19T23:00:00' },
      { id: 'b', stage: 's1', day: 'd1', artist: 'Bravo', date: '2026-06-19', start: '23:00:00', end: '23:30:00', startsAt: '2026-06-19T23:00:00', endsAt: '2026-06-19T23:30:00' },
      { id: 'c', stage: 's1', day: 'd1', artist: 'Charlie', date: '2026-06-19', start: '23:30:00', end: '00:30:00', startsAt: '2026-06-19T23:30:00', endsAt: '2026-06-20T00:30:00' },
      { id: 'e', stage: 's1', day: 'd2', artist: 'Echo', date: '2026-06-20', start: '20:00:00', end: '21:00:00', startsAt: '2026-06-20T20:00:00', endsAt: '2026-06-20T21:00:00' },
    ],
  }, extra || {});
}

// test with the compact project as the seed; stAuth defaults to 'admin'
// (company_admin), override per describe with test.use({ stAuth }).
const test = base.extend({
  stAuth: ['admin', { option: true }],
  stSeed: [{ mutate(seed) { seed.projects[0].data = projectData(); return seed; } }, { option: true }],
  // Page errors and native dialogs (alert/confirm/prompt must be gone) fail the test.
  // The app asks for fullscreen on the first click on desktop browsers; in
  // fullscreen the browser itself consumes Escape (WebKit does, like Safari)
  // to leave fullscreen, so an Escape test would test the browser. Fullscreen
  // is a no-op here.
  pageProblems: [async ({ page }, use) => {
    await page.addInitScript(() => {
      const noop = function () { return Promise.resolve(); };
      Element.prototype.requestFullscreen = noop;
      Element.prototype.webkitRequestFullscreen = noop;
    });
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('dialog', (d) => { problems.push('native dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    await use(problems);
    expect(problems, 'page errors / native dialogs').toEqual([]);
  }, { auto: true }],
});

// Boot logged in at a festival moment (default Friday 22:30, Alpha live).
// open:false stays on the workspace dashboard.
async function openOperator({ page, st }, { at = '2026-06-19T22:30:00+02:00', open = true, viewport } = {}) {
  if (viewport) await page.setViewportSize(viewport);
  await st.gotoApp({ at: new Date(at) });
  if (open) {
    await st.openProject('Zomerfeest 2026');
    await page.clock.runFor(500);
  }
}
const dlg = (page) => page.locator('.st-dlg[role="dialog"]');
const projectPatches = (backend) => backend.calls({ method: 'PATCH', path: '/rest/v1/projects' });

module.exports = { test, expect, openOperator, dlg, projectData, projectPatches };
