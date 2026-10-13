// Regression tests: dialog component, time corrections, cues / manual mode,
// show editor validation, day management, account & workspace forms.
//
// The operator app runs logged in against a fully mocked backend (see
// _operator.js): nothing reaches a real server, edge functions such as
// invite-member are mocks, so no invite or email is ever sent.
const { test, expect } = require('@playwright/test');
const { openOperator, dlg, done } = require('./_operator');

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

test.describe('show editor', () => {
  test('field errors sit next to the field, invalid seconds are not corrected', async ({ browser }) => {
    const r = await openOperator(browser);
    const { page } = r;
    await page.locator('#new-show-btn').click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    await page.fill('#f-start-sec', '75');
    await page.locator('#dr-save').click();
    await expect(page.locator('#f-a-err')).toHaveText('Enter a name or artist.');
    await expect(page.locator('#f-start-err')).toHaveText('Seconds must be a whole number from 0 to 59.');
    await expect(page.locator('#f-a')).toBeFocused();
    await expect(page.locator('#f-start-sec')).toHaveValue('75'); // not clamped to 59
    await expect(page.locator('#f-start-sec')).toHaveAttribute('aria-invalid', 'true');
    // Labels: date / time / seconds are each labelled, for start and end.
    for (const l of ['Date', 'Time', 'Seconds']) await expect(page.locator('#drawer').getByLabel(l, { exact: true })).toHaveCount(2);
    expect(await page.evaluate(() => G.shows.length)).toBe(4);
    await done(r);
  });
  test('automatic end adjustment is announced in the duration preview', async ({ browser }) => {
    const r = await openOperator(browser);
    const { page } = r;
    await page.evaluate(() => openDrawer('b'));               // 23:00-23:30
    await page.fill('#f-start-time', '23:45');
    await page.locator('#f-start-time').dispatchEvent('change');
    await expect(page.locator('#f-end-time')).toHaveValue('01:15');
    await expect(page.locator('#dur-txt')).toContainText('End moved to 01:15 the next day (start + 1h 30m)');
    await page.fill('#f-end-time', '01:00');
    await expect(page.locator('#dur-txt')).not.toContainText('End moved');
    await done(r);
  });
  test('overlap on the same stage warns; Go back keeps editing, Save anyway saves', async ({ browser }) => {
    const r = await openOperator(browser);
    const { page } = r;
    await page.evaluate(() => openDrawer('b'));
    await page.fill('#f-start-time', '22:45');
    await expect(page.locator('#f-overlap')).toContainText('Overlaps with Alpha (22:00–23:00)');
    await page.locator('#dr-save').click();
    const d = dlg(page);
    await expect(d.locator('.st-dlg-title')).toHaveText('This show overlaps another show');
    await expect(d.locator('.st-dlg-list')).toContainText('Alpha');
    await d.getByRole('button', { name: 'Go back' }).click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    expect(await page.evaluate(() => G.shows.find(s => s.id === 'b').start)).toBe('23:00:00');
    await page.locator('#dr-save').click();
    await d.getByRole('button', { name: 'Save anyway' }).click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    expect(await page.evaluate(() => G.shows.find(s => s.id === 'b').start)).toBe('22:45:00');
    // A cancelled show does not overlap anything.
    await page.evaluate(() => openDrawer('b'));
    await page.locator('#dr-cancel-btn').click();
    await expect(page.locator('#f-overlap')).toBeHidden();
    await done(r);
  });
  test('closing with unsaved changes asks first', async ({ browser }) => {
    const r = await openOperator(browser);
    const { page } = r;
    // Unchanged: Escape closes straight away and focus returns.
    await page.locator('#new-show-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    await page.clock.runFor(300);
    await page.keyboard.press('Escape');
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    await expect(dlg(page)).toHaveCount(0);
    await expect(page.locator('#new-show-btn')).toBeFocused();
    // Changed: Escape asks; Keep editing keeps the text.
    await page.evaluate(() => openDrawer('a'));
    await page.fill('#f-a', 'Alpha (late)');
    await page.keyboard.press('Escape');
    const d = dlg(page);
    await expect(d.locator('.st-dlg-title')).toHaveText('Discard changes?');
    await d.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('#drawer')).toHaveClass(/open/);
    await expect(page.locator('#f-a')).toHaveValue('Alpha (late)');
    // Cancel button: same guard; Discard closes without saving.
    await page.locator('#dr-cancel').click();
    await d.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
    expect(await page.evaluate(() => G.shows.find(s => s.id === 'a').artist)).toBe('Alpha');
    await done(r);
  });
  test('delete show names the show and uses a danger button', async ({ browser }) => {
    const r = await openOperator(browser);
    const { page } = r;
    await page.evaluate(() => { delShow('b'); });
    const d = dlg(page);
    await expect(d.locator('.st-dlg-msg')).toContainText('"Bravo" (23:00–23:30)');
    await d.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => G.shows.some(s => s.id === 'b'))).toBe(true);
    await page.evaluate(() => { delShow('b'); });
    await d.getByRole('button', { name: 'Delete show' }).click();
    await expect(d).toHaveCount(0);
    expect(await page.evaluate(() => G.shows.some(s => s.id === 'b'))).toBe(false);
    await done(r);
  });
});
