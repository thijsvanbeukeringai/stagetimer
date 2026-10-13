// Project export (GDPR art. 20 data portability, BOUWPLAN "Buiten de scope:
// Juridisch"): Project settings > "Export project (JSON)" downloads the open
// project as JSON. Must contain the project as stored (incl. inline photos) and
// nothing from the company row (billing ids, setup_token).
const fs = require('fs');
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

const MID_SHOW = ams(FESTIVAL.dates.d1, '16:00');

for (const role of ['admin', 'operator']) {
  test.describe(`as ${role}`, () => {
    test.use({ stAuth: role });
    // The dashboard lists only projects the user created (or legacy ones without
    // created_by); give the operator a project it can open.
    if (role === 'operator') test.use({ stSeed: { mutate(seed) { seed.projects[0].created_by = FESTIVAL.users.operator.id; } } });

    test(`export project JSON downloads the open project (${role})`, async ({ page, st }) => {
      await st.gotoApp({ at: MID_SHOW });
      await st.openProject('Zomerfeest 2026');
      await page.locator('#admin-dd > button').click();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#admin-dd').getByRole('button', { name: 'Export project (JSON)' }).click(),
      ]);
      expect(download.suggestedFilename()).toBe('Zomerfeest 2026-2026-07-10.json');
      const text = fs.readFileSync(await download.path(), 'utf8');
      const out = JSON.parse(text);
      expect(out).toMatchObject({ app: 'Stagetimer', schemaVersion: 1, project: { id: FESTIVAL.projectId, name: 'Zomerfeest 2026' } });
      expect(Number.isNaN(Date.parse(out.exportedAt))).toBe(false);
      expect(Object.keys(out.project).sort()).toEqual(['data', 'id', 'name']);
      const shows = out.project.data.shows;
      expect(shows.length).toBe(15);
      expect(shows.find((s) => s.artist === "DJ O'Neil").photo).toMatch(/^data:image\/png;base64,/);
      expect(out.project.data.stages.map((s) => s.name)).toContain('The Tent');
      for (const secret of ['setup_token', 'SECRET-SETUP-TOKEN', 'stripe_', 'cus_mock', 'sub_mock', 'subscription_', 'company_id']) {
        expect(text).not.toContain(secret);
      }
    });
  });
}
