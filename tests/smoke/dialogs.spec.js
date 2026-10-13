// Smoke: the flows that used to run through confirm() / prompt() and now go
// through the stDialog component. Coarse: the dialog appears, Cancel changes
// nothing, the confirm reaches the (mocked) backend. Edge functions are mocks:
// nothing reaches Stripe, no invite or email is sent.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const PID = FESTIVAL.projectId;
const dialog = (page) => page.locator('form.st-dlg[role="dialog"]');
const savedData = (backend) => backend.project(PID).data;

// Native dialogs must be gone: any alert/confirm/prompt fails the test.
let nativeDialogs = [];
test.beforeEach(async ({ page }) => {
  nativeDialogs = [];
  page.on('dialog', (d) => { nativeDialogs.push(d.message()); d.dismiss().catch(() => {}); });
});
test.afterEach(() => { expect(nativeDialogs, 'native alert/confirm/prompt').toEqual([]); });

test.describe('as company admin', () => {
  test.use({ stAuth: 'admin' });
  test.beforeEach(async ({ st }) => { await st.gotoApp({ at: ams(FESTIVAL.dates.d1, '16:00') }); });

  test('delete show: cancel keeps it, confirm saves without it', async ({ page, st, backend }) => {
    await st.openProject();
    const card = page.locator('#slist .scard', { hasText: 'Opening Act' }).first();
    await card.hover();
    await card.getByRole('button', { name: 'Delete Opening Act' }).click();
    await expect(dialog(page)).toContainText('Delete this show?');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#slist')).toContainText('Opening Act');
    await card.hover();
    await card.getByRole('button', { name: 'Delete Opening Act' }).click();
    await dialog(page).getByRole('button', { name: 'Delete show' }).click();
    await expect.poll(() => savedData(backend).shows.some((s) => s.id === 'm1')).toBe(false);
  });

  test('delete day takes its shows; delete stage keeps behaviour', async ({ page, st, backend }) => {
    await st.openProject();
    await page.evaluate(() => openDayModal());
    await page.getByRole('button', { name: 'Delete Zaterdag' }).click();
    await dialog(page).getByRole('button', { name: /Delete day and its 4 shows/ }).click();
    await expect.poll(() => savedData(backend).days.map((d) => d.id)).toEqual([FESTIVAL.days.d1]);
    expect(savedData(backend).shows.some((s) => s.day === FESTIVAL.days.d2)).toBe(false);
    await page.evaluate(() => { closeDayModal(); openStageModal(); });
    await page.locator('#stage-list').getByTitle('Delete this stage').last().click();
    await expect(dialog(page)).toContainText('Delete this stage?');
    await dialog(page).getByRole('button', { name: 'Delete stage' }).click();
    await expect.poll(() => savedData(backend).stages.length).toBe(2);
  });

  test('delete project from the dashboard', async ({ page, backend }) => {
    const row = page.locator('#proj-grid tr', { hasText: 'Kleine Clubnacht' });
    await row.getByTitle('Delete').click();
    await expect(dialog(page)).toContainText('"Kleine Clubnacht" is deleted for everyone');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    expect(backend.calls({ method: 'DELETE', path: '/rest/v1/projects' }).length).toBe(0);
    await row.getByTitle('Delete').click();
    await dialog(page).getByRole('button', { name: 'Delete project' }).click();
    await expect(page.locator('#proj-grid')).not.toContainText('Kleine Clubnacht');
    expect(backend.calls({ method: 'DELETE', path: '/rest/v1/projects' }).length).toBe(1);
  });

  test('remove member calls the mocked remove-member', async ({ page, backend }) => {
    backend.setFunction('remove-member', () => ({ ok: true, seatDecremented: true }));
    await page.getByRole('button', { name: 'Subscription' }).first().click();
    await page.getByRole('button', { name: "Remove Owen O'Perator" }).click();
    await expect(dialog(page)).toContainText("Remove Owen O'Perator?");
    await dialog(page).getByRole('button', { name: 'Remove member' }).click();
    await expect(dialog(page)).toContainText('The member was removed and the seat released.');
    expect(backend.functionCalls('remove-member')[0].body).toEqual({ userId: FESTIVAL.users.operator.id });
  });
});

test.describe('as super admin', () => {
  test.use({ stAuth: 'super' });
  test('platform admin: rename workspace, change role, remove user', async ({ page, st, backend }) => {
    backend.setFunction('manage-voucher', () => ({ vouchers: [] }));
    backend.setFunction('remove-member', () => ({ ok: true }));
    await st.gotoApp();
    await page.locator('#dash-admin-btn, #dash-admin-tab').filter({ visible: true }).first().click();
    await expect(page.locator('#admin-title')).toHaveText('Platform admin · All workspaces');
    await page.getByRole('button', { name: 'Rename Awaiting Activation BV' }).click();
    await dialog(page).getByLabel('Workspace name').fill('Activated BV');
    await dialog(page).getByRole('button', { name: 'Save name' }).click();
    await expect(page.locator('#admin-co-list')).toContainText('Activated BV');
    await expect.poll(() => backend.db.companies.find((c) => c.id === FESTIVAL.otherCompanyId).name).toBe('Activated BV');
    await page.getByLabel('Role of Other Owner').selectOption('operator');
    await expect.poll(() => backend.db.app_users.find((u) => u.id === FESTIVAL.users.other.id).role).toBe('operator');
    await page.getByRole('button', { name: 'Remove Other Owner' }).click();
    await dialog(page).getByRole('button', { name: 'Remove user' }).click();
    await expect.poll(() => backend.functionCalls('remove-member').length).toBe(1);
  });
});
