// Smoke: the legal draft pages (privacy.html, voorwaarden.html) load offline
// (self-hosted fonts only; the backend fixture fails on any non-localhost
// request), log no console errors, fit a phone without sideways scrolling,
// carry the CONCEPT banner, and are linked from the landing page footer.
const { test, expect } = require('../support/fixtures');

for (const [file, heading] of [['privacy.html', 'Privacyverklaring'], ['voorwaarden.html', 'Algemene voorwaarden']]) {
  for (const width of [390, 1440]) {
    test(`${file} renders at ${width}px`, async ({ page }) => {
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(String(e)));
      const failed = [];
      page.on('requestfailed', (r) => failed.push(r.url()));
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${file}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.getByRole('note')).toContainText('CONCEPT — laat controleren door een jurist');
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.check('16px Geist'))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(errors).toEqual([]);
      expect(failed).toEqual([]);
    });
  }
}

test('landing page footer links to both legal pages', async ({ page }) => {
  await page.goto('/index.html');
  const foot = page.locator('footer');
  await expect(foot.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy.html');
  await expect(foot.getByRole('link', { name: 'Voorwaarden' })).toHaveAttribute('href', '/voorwaarden.html');
});
