// BOOTHSCREEN / STAGE VIEW visual baseline.
//
// BOUWPLAN hard rule: Stage View stays visually identical (layout, font sizes,
// colours, animations, clock, progress bar, display modes). These snapshots
// were generated from commit 845eb0d (before any improvement work) with
// `npm run test:update-baseline`; every later tree must match them pixel-exact.
//
// Determinism:
//  - page.clock is installed before load; each state is reached with
//    st.freezeAt(t), which pauses at t-1 s and runs exactly 1 s of timers.
//    Every t ends in .400 s so the last 250 ms tick lands in (t-250, t] and
//    all Math.round/ceil in renderSV give the same digits on every run.
//  - toHaveScreenshot uses animations:'disabled' (config): the infinite
//    blink (.ot, last 30 s) and the cue pulse are captured at their first
//    keyframe; finite transitions (bar width / colour .5 s) at their end.
//    Whether the blink/pulse is applied at all is pinned by the style
//    fingerprint JSON snapshot next to every screenshot set.
//  - Fonts are served from tests/support/fonts (exact Google Fonts files).
//
// Stage View has no "overtime" counter in live mode: curShow() stops
// returning a show at its end time. The `overtime` state therefore captures
// what the booth really shows 10 s after the end (the next show's start
// time), which is exactly the behaviour that must not change visually.
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');
const { fingerprint } = require('./fingerprint');

const S = FESTIVAL.stages;
const D1 = FESTIVAL.dates.d1;
const D2 = FESTIVAL.dates.d2;

const VIEWPORTS = {
  '1920x1080': { width: 1920, height: 1080 },
  '1280x720': { width: 1280, height: 720 },
  '390x844': { width: 390, height: 844 },
};
const MODES = ['countdown', 'clock', 'countup', 'blank'];

// Main Stage, Friday: "DJ O'Neil" 15:30-16:30, next "The <b>html</b>..." at 17:00.
const TIMES = [
  ['before', ams(D1, '15:20:00.400')],   // between shows, next starts 15:30
  ['mid', ams(D1, '16:00:00.400')],      // 30:00 left, green
  ['last10', ams(D1, '16:22:00.400')],   // 8:00 left, orange
  ['last5', ams(D1, '16:26:00.400')],    // 4:00 left, red
  ['last30', ams(D1, '16:29:45.400')],   // 0:15 left, red + blink
  ['overtime', ams(D1, '16:30:10.400')], // 10 s past the end
];
const LOAD_AT = new Date(TIMES[0][1].getTime() - 60_000);

// The ONLY tolerance in this suite. Right after a show ends the progress bar
// transitions from ~100 % to 0 %; Chromium then sometimes leaves a raster
// residue of <= 6 pixels, 1-3 colour levels off, at the fractional right end of
// the bar track (seen at 390x844). It is bistable between runs, not a visual
// change. Everything else is maxDiffPixels 0 / threshold 0 (playwright.config.js).
const shotOpts = (label) => (label === 'overtime' ? { maxDiffPixels: 12 } : {});

function withMode(stageId, mode, patch = {}) {
  return {
    mutate(seed) {
      const p = seed.projects.find((x) => x.id === FESTIVAL.projectId);
      p.data.svModes = { ...(p.data.svModes || {}), [stageId]: mode };
      Object.assign(p.data, patch);
      return seed;
    },
  };
}

for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`public stage view ${vpName}`, () => {
    test.use({ viewport });

    for (const mode of MODES) {
      test.describe(() => {
        test.use({ stSeed: withMode(S.main, mode) });
        test(`${mode} through a show`, async ({ page, st }) => {
          await st.gotoPublic({ mode: 'stage', sid: S.main, at: LOAD_AT });
          const fp = {};
          for (const [label, at] of TIMES) {
            await st.freezeAt(at);
            await expect(page).toHaveScreenshot(`public-${mode}-${label}-${vpName}.png`, shotOpts(label));
            fp[label] = await fingerprint(page);
          }
          expect(JSON.stringify(fp, null, 2)).toMatchSnapshot(`public-${mode}-${vpName}.json`);
        });
      });
    }

    // Extra booth states, countdown mode. Each needs its own stage / time / data.
    const EXTRA = [
      { name: 'overnight', sid: S.main, at: ams(D2, '00:45:00.400') },                 // "Night Owl" 23:00-01:30
      { name: 'cue-wrapup', sid: S.main, at: ams(D1, '16:00:00.400'),
        patch: { cue: { text: 'WRAP UP', color: 'red', stageId: S.main, sentAt: ams(D1, '15:59:00').getTime(), durationMs: null } } },
      { name: 'blackout', sid: S.main, at: ams(D1, '16:00:00.400'), patch: { blackout: true } },
      { name: 'hidden-skipped', sid: S.tent, at: ams(D1, '15:30:00.400') },           // hidden show live, public view skips it
      { name: 'next-day', sid: S.tent, at: ams(D2, '03:00:00.400') },                  // nothing left today -> date + time
      { name: 'idle', sid: S.club, at: ams('2026-07-12', '03:00:00.400') },            // nothing left at all
    ];
    for (const x of EXTRA) {
      test.describe(() => {
        test.use({ stSeed: withMode(x.sid, 'countdown', x.patch) });
        test(`state ${x.name}`, async ({ page, st }) => {
          await st.gotoPublic({ mode: 'stage', sid: x.sid, at: new Date(x.at.getTime() - 60_000) });
          await st.freezeAt(x.at);
          await expect(page).toHaveScreenshot(`public-state-${x.name}-${vpName}.png`);
          expect(JSON.stringify(await fingerprint(page), null, 2)).toMatchSnapshot(`public-state-${x.name}-${vpName}.json`);
        });
      });
    }
  });

  test.describe(`in-app stage view ${vpName}`, () => {
    test.use({ viewport, stAuth: 'admin' });
    test('countdown through a show', async ({ page, st }) => {
      await st.gotoApp({ at: LOAD_AT });
      await st.openProject('Zomerfeest 2026');
      await page.getByRole('button', { name: /Stage View/ }).filter({ visible: true }).first().click();
      await page.locator('#sv.open').waitFor();
      const fp = {};
      for (const [label, at] of TIMES) {
        await st.freezeAt(at);
        await expect(page).toHaveScreenshot(`inapp-countdown-${label}-${vpName}.png`, shotOpts(label));
        fp[label] = await fingerprint(page);
      }
      expect(JSON.stringify(fp, null, 2)).toMatchSnapshot(`inapp-countdown-${vpName}.json`);
    });
  });
}

// Photos as Storage URLs (migration 20261013150000_photo_storage): the same
// image the baseline embeds as base64 (m2 "DJ O'Neil", live in these states),
// now served from the mocked bucket. Compared against the EXISTING base64
// snapshots and fingerprints (no new snapshot names): the booth must be
// pixel-identical whichever form show.photo takes.
const { PHOTO_PNG } = require('../support/seed');
const PHOTO_NAME = `${FESTIVAL.projectId}/${'0f'.repeat(16)}.png`;
const PHOTO_URL = `https://bamjpsquhdzxvsymldpq.supabase.co/storage/v1/object/public/project-media/${PHOTO_NAME}`;
const photoAsUrl = (mode) => ({
  mutate(seed) {
    if (mode) withMode(S.main, mode).mutate(seed);
    seed.projects.find((x) => x.id === FESTIVAL.projectId).data.shows.find((s) => s.id === 'm2').photo = PHOTO_URL;
    return seed;
  },
});
const servePhoto = (backend) => backend.storage.objects.set(PHOTO_NAME, { buf: Buffer.from(PHOTO_PNG.split(',')[1], 'base64'), type: 'image/png' });

test.describe('photo from a Storage URL 1920x1080', () => {
  test.use({ viewport: VIEWPORTS['1920x1080'] });

  test.describe(() => {
    test.use({ stSeed: photoAsUrl('countdown') });
    test('public countdown matches the base64 baseline', async ({ page, st, backend }) => {
      servePhoto(backend);
      await st.gotoPublic({ mode: 'stage', sid: S.main, at: LOAD_AT });
      const fp = {};
      for (const [label, at] of TIMES) {
        await st.freezeAt(at);
        await expect(page).toHaveScreenshot(`public-countdown-${label}-1920x1080.png`, shotOpts(label));
        fp[label] = await fingerprint(page);
      }
      expect(JSON.stringify(fp, null, 2)).toMatchSnapshot('public-countdown-1920x1080.json');
    });
  });

  test.describe(() => {
    test.use({ stAuth: 'admin', stSeed: photoAsUrl(null) });
    test('in-app countdown matches the base64 baseline (timer panel loads the URL)', async ({ page, st, backend }) => {
      servePhoto(backend);
      await st.gotoApp({ at: LOAD_AT });
      await st.openProject('Zomerfeest 2026');
      await page.getByRole('button', { name: /Stage View/ }).filter({ visible: true }).first().click();
      await page.locator('#sv.open').waitFor();
      const fp = {};
      for (const [label, at] of TIMES) {
        await st.freezeAt(at);
        await expect(page).toHaveScreenshot(`inapp-countdown-${label}-1920x1080.png`, shotOpts(label));
        fp[label] = await fingerprint(page);
        // m2 is live: the timer panel behind the Stage View really loaded the photo from the bucket.
        if (label === 'mid') expect(await page.evaluate(() => [document.getElementById('tp-photo').src, document.getElementById('tp-photo').naturalWidth])).toEqual([PHOTO_URL, 1]);
      }
      expect(JSON.stringify(fp, null, 2)).toMatchSnapshot('inapp-countdown-1920x1080.json');
      expect(backend.calls({ method: 'GET', path: `/storage/v1/object/public/project-media/${PHOTO_NAME}` }).length).toBeGreaterThan(0);
    });
  });
});
