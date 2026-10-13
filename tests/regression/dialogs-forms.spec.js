// Regression tests: dialog component, time corrections, cues / manual mode,
// show editor validation, day management, account & workspace forms.
//
// The operator app runs logged in against a fully mocked backend (see
// _operator.js): nothing reaches a real server, edge functions such as
// invite-member are mocks, so no invite or email is ever sent.
const { test, expect, openOperator, dlg, projectPatches } = require('./_operator');

test.describe('dialog component', () => {
  test('labelled, focus trap, Escape cancels, focus returns to the trigger', async ({ page, st, backend }) => {
    await openOperator({ page, st });
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
  });
  test('form: inline field errors, Enter submits, async errors keep it open', async ({ page, st, backend }) => {
    await openOperator({ page, st });
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
  });
});

test.describe('existing modals', () => {
  test('dialog role, Escape closes only the modal, focus returns', async ({ page, st }) => {
    await openOperator({ page, st }, { open: false });
    const btn = page.getByRole('button', { name: 'New project' });
    await btn.focus();                 // keyboard user (Safari does not focus clicked buttons)
    await page.keyboard.press('Enter');
    const modal = page.getByRole('dialog', { name: 'New project' });
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(page.locator('#dash')).toHaveClass(/open/);
    await expect(btn).toBeFocused();
  });
});

test.describe('show editor', () => {
  test('field errors sit next to the field, invalid seconds are not corrected', async ({ page, st, backend }) => {
    await openOperator({ page, st });
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
  });
  test('automatic end adjustment is announced in the duration preview', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    await page.evaluate(() => openDrawer('b'));               // 23:00-23:30
    await page.fill('#f-start-time', '23:45');
    await page.locator('#f-start-time').dispatchEvent('change');
    await expect(page.locator('#f-end-time')).toHaveValue('01:15');
    await expect(page.locator('#dur-txt')).toContainText('End moved to 01:15 the next day (start + 1h 30m)');
    await page.fill('#f-end-time', '01:00');
    await expect(page.locator('#dur-txt')).not.toContainText('End moved');
  });
  test('overlap on the same stage warns; Go back keeps editing, Save anyway saves', async ({ page, st, backend }) => {
    await openOperator({ page, st });
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
  });
  test('closing with unsaved changes asks first', async ({ page, st, backend }) => {
    await openOperator({ page, st });
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
  });
  test('delete show names the show and uses a danger button', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    await page.evaluate(() => { delShow('b'); });
    const d = dlg(page);
    await expect(d.locator('.st-dlg-msg')).toContainText('"Bravo" (23:00–23:30)');
    await d.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => G.shows.some(s => s.id === 'b'))).toBe(true);
    await page.evaluate(() => { delShow('b'); });
    await d.getByRole('button', { name: 'Delete show' }).click();
    await expect(d).toHaveCount(0);
    expect(await page.evaluate(() => G.shows.some(s => s.id === 'b'))).toBe(false);
  });
});

// Alpha 22:00-23:00 is live at 22:30, Bravo 23:00-23:30 is back-to-back,
// Charlie 23:30-00:30 follows.
const times = page => page.evaluate(() => Object.fromEntries(G.shows.filter(s => s.day === 'd1').map(s => [s.id, s.startsAt + '/' + s.endsAt])));
const ORIG = {
  a: '2026-06-19T22:00:00/2026-06-19T23:00:00',
  b: '2026-06-19T23:00:00/2026-06-19T23:30:00',
  c: '2026-06-19T23:30:00/2026-06-20T00:30:00',
};
test.describe('time correction', () => {
  test('Cancel and Escape really cancel', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    const d = dlg(page);
    await page.getByRole('button', { name: '+5 min' }).click();
    await expect(d.locator('.st-dlg-title')).toHaveText('Adjust "Alpha" by +5 min');
    await d.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(d).toHaveCount(0);
    expect(await times(page)).toEqual(ORIG);
    await page.getByRole('button', { name: '+5 min' }).click();
    await expect(d).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    expect(await times(page)).toEqual(ORIG);
    expect(projectPatches(backend).length).toBe(0); // nothing was saved
  });
  test('preview, then "Shift all following shows"', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    const d = dlg(page);
    await page.getByRole('button', { name: '+5 min' }).click();
    const shift = d.getByRole('button', { name: /Shift all following shows/ });
    await expect(shift).toContainText('Bravo23:00–23:30 → 23:05–23:35');
    await expect(shift).toContainText('Charlie23:30–00:30 → 23:35–00:35');
    await expect(shift).toBeFocused();
    expect(await times(page)).toEqual(ORIG); // preview only
    await shift.click();
    expect(await times(page)).toEqual({
      a: '2026-06-19T22:00:00/2026-06-19T23:05:00',
      b: '2026-06-19T23:05:00/2026-06-19T23:35:00',
      c: '2026-06-19T23:35:00/2026-06-20T00:35:00',
    });
  });
  test('preview, then "Only the next show absorbs it"', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    const d = dlg(page);
    await page.getByRole('button', { name: '-1 min' }).click();
    const absorb = d.getByRole('button', { name: /Only the next show absorbs it/ });
    await expect(absorb).toContainText('Bravo23:00–23:30 → 22:59–23:30');
    await expect(absorb).not.toContainText('Charlie');
    await absorb.click();
    expect(await times(page)).toEqual({
      a: '2026-06-19T22:00:00/2026-06-19T22:59:00',
      b: '2026-06-19T22:59:00/2026-06-19T23:30:00',
      c: ORIG.c,
    });
  });
  test('absorbing is offered as impossible when the next slot would vanish', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    const d = dlg(page);
    await page.evaluate(() => { adjustLiveShow(30); });
    const absorb = d.getByRole('button', { name: /Only the next show absorbs it/ });
    await expect(absorb).toBeDisabled();
    await expect(absorb).toContainText('"Bravo" would have no time left');
    await page.keyboard.press('Escape');
    expect(await times(page)).toEqual(ORIG);
  });
});

test.describe('cues and manual mode (operator side)', () => {
  test('target stage, active cue, duration and blackout are visible', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    await expect(page.locator('#cue-target')).toContainText('Cues go to the Main screens');
    await expect(page.locator('#cue-clear')).toBeDisabled();
    await page.locator('#cue-presets').getByRole('button', { name: 'WRAP UP' }).click();
    await page.clock.runFor(500);
    await expect(page.locator('#cue-status')).toContainText('On air: WRAP UP');
    await expect(page.locator('#cue-status')).toContainText('stays until you press Clear');
    await expect(page.locator('#cue-presets [data-cue="WRAP UP"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#cue-presets [data-cue="READY"]')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => G.cue.stageId)).toBe('s1');
    // Another stage selected: the cue is still on air on Main, and says so.
    await page.evaluate(() => { G.activeStage = 's2'; renderAll(); });
    await page.clock.runFor(500);
    await expect(page.locator('#cue-status')).toContainText('On air on Main (not this stage): WRAP UP');
    await expect(page.locator('#cue-target')).toContainText('Cues go to the Second screens');
    await expect(page.locator('#cue-presets [data-cue="WRAP UP"]')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#cue-clear').click();
    await page.clock.runFor(500);
    await expect(page.locator('#cue-status')).toHaveText('No active cue');
    // A temporary cue says how long it stays.
    await page.evaluate(() => sendCue('STRETCH', 'amber', 10000));
    await page.clock.runFor(2000);
    await expect(page.locator('#cue-status')).toContainText('disappears in 8s');
    // Blackout: pressed state + explicit status line.
    await expect(page.locator('#blackout-status')).toBeHidden();
    await page.locator('#blackout-btn').click();
    await page.clock.runFor(500);
    await expect(page.locator('#blackout-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#blackout-status')).toBeVisible();
    await expect(page.locator('#blackout-status')).toContainText('Blackout is ON');
  });
  test('manual mode: cards never reset; Cue / prev / next / reset ask while a timer runs', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    const d = dlg(page);
    await page.locator('#mb-man').click();
    expect(await page.evaluate(() => M.showId)).toBe('a');
    await page.locator('#btn-pp').click();               // start
    await page.clock.runFor(5000);
    // Tapping a card does nothing to the timer.
    await page.locator('#slist .scard').nth(1).click({ position: { x: 5, y: 5 } });
    expect(await page.evaluate(() => [M.showId, M.state])).toEqual(['a', 'running']);
    await expect(d).toHaveCount(0);
    // The explicit Cue button asks first.
    await page.getByRole('button', { name: 'Cue Bravo on the timer' }).click();
    await expect(d.locator('.st-dlg-title')).toHaveText('Reset the running timer?');
    await expect(d.locator('.st-dlg-msg')).toContainText('"Alpha" is running');
    await d.getByRole('button', { name: 'Keep the timer' }).click();
    expect(await page.evaluate(() => [M.showId, M.state])).toEqual(['a', 'running']);
    await page.getByRole('button', { name: 'Cue Bravo on the timer' }).click();
    await d.getByRole('button', { name: 'Cue and reset' }).click();
    expect(await page.evaluate(() => [M.showId, M.state])).toEqual(['b', 'idle']);
    // Idle: next / reset need no confirmation.
    await page.getByRole('button', { name: 'Cue the next show (resets the timer)' }).click();
    await expect(d).toHaveCount(0);
    expect(await page.evaluate(() => M.showId)).toBe('c');
    // Running: reset asks, Escape keeps the timer.
    await page.locator('#btn-pp').click();
    await page.clock.runFor(3000);
    await page.getByRole('button', { name: 'Reset the timer to the full show length' }).click();
    await expect(d).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => M.state)).toBe('running');
  });
});

test.describe('day management', () => {
  test('delete day names its shows and deletes them with it (no orphans)', async ({ page, st, backend }) => {
    await openOperator({ page, st });
    const d = dlg(page);
    await page.evaluate(() => openDayModal());
    await page.getByRole('button', { name: 'Delete Friday' }).click();
    await expect(d.locator('.st-dlg-title')).toHaveText('Delete "Friday" and its shows?');
    await expect(d.locator('.st-dlg-list')).toContainText('Alpha');
    await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await d.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => [G.days.length, G.shows.length])).toEqual([2, 4]);
    await page.getByRole('button', { name: 'Delete Friday' }).click();
    await d.getByRole('button', { name: 'Delete day and its 3 shows' }).click();
    await expect(d).toHaveCount(0);
    expect(await page.evaluate(() => [G.days.map(x => x.id), G.shows.map(x => x.id)])).toEqual([['d2'], ['e']]);
    await expect.poll(() => (backend.project('proj-fest').data.shows || []).map(x => x.id)).toEqual(['e']);
    // The last day cannot go.
    await page.evaluate(() => { delDay('d2'); });
    await expect(d.locator('.st-dlg-title')).toHaveText('Cannot delete the last day');
  });
  test('changing a day date shows the effect first; Cancel keeps the old date', async ({ page, st }) => {
    await openOperator({ page, st });
    const d = dlg(page);
    await page.evaluate(() => { G.shows.push({ id: 'leg', stage: 's1', day: 'd1', artist: 'Legacy', start: '20:00:00', end: '21:00:00' }); openDayModal(); });
    const dateInput = page.getByLabel('Date of Friday');
    await dateInput.fill('2026-06-18');
    await expect(d.locator('.st-dlg-title')).toHaveText('Change the date of "Friday"?');
    await expect(d.locator('.st-dlg-msg')).toHaveText('From Fri, Jun 19, 2026 to Thu, Jun 18, 2026.');
    await expect(d).toContainText('1 show moves to Thu, Jun 18, 2026');
    await expect(d).toContainText('3 shows have their own date and stay where they are');
    await d.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => G.days[0].date)).toBe('2026-06-19');
    await expect(dateInput).toHaveValue('2026-06-19');
    await dateInput.fill('2026-06-18');
    await d.getByRole('button', { name: 'Change date' }).click();
    expect(await page.evaluate(() => G.days.find(x => x.id === 'd1').date)).toBe('2026-06-18');
  });
  test('empty day names are reported, not silently dropped', async ({ page, st }) => {
    await openOperator({ page, st });
    await page.evaluate(() => openDayModal());
    await page.getByRole('button', { name: '+ Add' }).click();
    await expect(page.locator('#dm-name-err')).toHaveText('Enter a name for the day.');
    const name = page.getByLabel('Name of day 1');
    await name.fill('');
    await name.blur();
    await expect(page.locator('#day-list-err')).toContainText('A day needs a name: "Friday" was kept.');
    await expect(name).toHaveValue('Friday');
  });
});

test.describe('account and workspace', () => {
  test('invite: one form, inline checks, mocked invite-member gets the right payload', async ({ page, st, backend }) => {
    await openOperator({ page, st }, { open: false });
    await page.getByRole('button', { name: 'Subscription' }).first().click();
    await page.getByRole('button', { name: /Invite member/ }).click();
    const d = dlg(page);
    await expect(d.locator('.st-dlg-title')).toHaveText('Invite a member to Zomerfeest Events BV');
    await expect(d.getByLabel('Full name')).toBeFocused();
    const send = d.getByRole('button', { name: /Send invite/ });
    await expect(send).toContainText('€');
    await send.click();
    await expect(d.locator('[data-field="name"] .st-dlg-err')).toHaveText('Enter the full name.');
    await expect(d.locator('[data-field="email"] .st-dlg-err')).toHaveText('Enter an email address.');
    await d.getByLabel('Full name').fill("Rosa O'Hara");
    await d.getByLabel('Email address').fill('rosa@');
    await send.click();
    await expect(d.locator('[data-field="email"] .st-dlg-err')).toContainText('Enter a valid email address');
    await d.getByLabel('Email address').fill('operator@zomerfeest.test');
    await send.click();
    await expect(d.locator('[data-field="email"] .st-dlg-err')).toHaveText('A user with this email address already exists.');
    expect(backend.functionCalls('invite-member').length).toBe(0);
    // Server refuses: the message stays in the dialog, nothing is lost.
    backend.setFunction('invite-member', () => ({ status: 400, json: { error: 'Seat limit reached' } }));
    await d.getByLabel('Email address').fill('rosa@zomerfeest.test');
    await send.click();
    await expect(d.locator('.st-dlg-formerr')).toHaveText('Could not send the invite: Seat limit reached');
    await expect(d.getByLabel('Full name')).toHaveValue("Rosa O'Hara");
    // Accepted.
    backend.setFunction('invite-member', (body) => ({ message: `Invite sent to ${body.email}.` }));
    await send.click();
    await expect(d.locator('.st-dlg-title')).toHaveText('Invite sent');
    await expect(d.locator('.st-dlg-msg')).toHaveText('Invite sent to rosa@zomerfeest.test.');
    const calls = backend.functionCalls('invite-member');
    expect(calls.length).toBe(2);
    expect(calls[1].body).toEqual({ workspaceId: 'co-fest', name: "Rosa O'Hara", email: 'rosa@zomerfeest.test', role: 'operator' });
    expect(calls[1].headers.authorization).toMatch(/^Bearer /);
    await d.getByRole('button', { name: 'OK' }).click();
    await expect(d).toHaveCount(0);
  });
  test('password rule is shown and checked next to the field', async ({ page, st }) => {
    await openOperator({ page, st }, { open: false });
    await page.getByRole('button', { name: 'Account settings' }).first().click();
    await expect(page.locator('#ws-profile-pw-rule')).toHaveText('Use at least 8 characters.');
    await page.locator('#ws-profile').getByLabel('New password').fill('short');
    await page.locator('#ws-profile').getByLabel('Repeat password').fill('short');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.locator('#ws-profile-pw-err')).toHaveText('Password must be at least 8 characters.');
    await expect(page.locator('#ws-profile-pw')).toBeFocused();
    await page.locator('#ws-profile-pw').fill('long-enough-1');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.locator('#ws-profile-pw2-err')).toHaveText('Passwords do not match.');
    await page.locator('#ws-profile-pw2').fill('long-enough-1');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.locator('#ws-profile-pw-status')).toHaveText('Password updated.');
  });
  test('rename project is a form dialog with saving and error states', async ({ page, st, backend }) => {
    await openOperator({ page, st }, { open: false });
    await page.locator('#proj-grid tr', { hasText: 'Zomerfeest 2026' }).getByTitle('Rename').click();
    const d = dlg(page);
    await expect(d.getByLabel('Project name')).toHaveValue('Zomerfeest 2026');
    backend.failNext({ method: 'PATCH', path: '/rest/v1/projects', status: 500 });
    await d.getByLabel('Project name').fill('Zomerfeest 2027');
    await d.getByRole('button', { name: 'Save name' }).click();
    await expect(d.locator('.st-dlg-formerr')).toContainText('Renaming the project failed');
    await d.getByRole('button', { name: 'Save name' }).click();
    await expect(d).toHaveCount(0);
    await expect(page.locator('#proj-grid')).toContainText('Zomerfeest 2027');
    expect(backend.project('proj-fest').name).toBe('Zomerfeest 2027');
  });
  test.describe('as operator', () => {
    test.use({ stAuth: 'operator' });
    test('member management is only offered to workspace admins', async ({ page, st }) => {
      await openOperator({ page, st }, { open: false });
      await page.getByRole('button', { name: 'Subscription' }).first().click();
      await expect(page.locator('#ws-subscription-body')).toContainText('Only workspace admins can invite or remove members');
      await expect(page.getByRole('button', { name: /Invite member/ })).toHaveCount(0);
      await page.getByRole('button', { name: 'Workspace settings' }).first().click();
      await expect(page.locator('#ws-settings-name')).toBeDisabled();
    });
  });
});
