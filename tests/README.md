# Stagetimer test harness

Playwright, fully offline. Nothing in this folder is deployed (`.vercelignore`).

```bash
npm install
npx playwright install chromium webkit   # once per machine
npm test                       # everything (smoke + unit + regression + booth), chromium + webkit
npm run test:smoke             # tests/smoke only
npm run test:booth             # Stage View pixel comparison against the 845eb0d baseline
npm run test:update-baseline   # regenerate the booth baseline FROM 845eb0d (rarely!)
npm run test:node              # plain node scripts tests/unit/*.test.js (not Playwright)
npx playwright test tests/unit --project=chromium   # any subset
```

Env: `ST_PORT` (default 5599; give each parallel worktree its own port, a busy port fails loudly instead of testing another tree), `ST_BROWSERS=chromium` (skip webkit), `BASE_ROOT` (serve another directory, used by the baseline script).
CI: `.github/workflows/tests.yml` runs `npm run test:node` and `npx playwright test` (all projects, chromium + webkit, incl. booth) on every push and pull request, on `macos-latest` because the booth baseline is `-darwin`. It deploys nothing and needs no secrets. On failure the `playwright-report` artifact holds the HTML report and traces. A booth diff that only shows up on CI can be a runner font/rasteriser difference: investigate, never regenerate the baseline to make it pass.

If the shared browser cache is locked by another install, put browsers in `~/Library/Caches/ms-playwright-st` (`PLAYWRIGHT_BROWSERS_PATH=~/Library/Caches/ms-playwright-st npx playwright install chromium webkit`); `playwright.config.js` picks that up automatically.

## Layout

| Folder | What goes there |
|---|---|
| `tests/support/` | `mock-backend.js` (fake Supabase + realtime stub + Storage bucket `project-media`: `backend.storage.objects`, `backend.storage.bucketMissing`), `seed.js` (festival data, `demoSeed`), `mock-server.js` (the same fake over real HTTP/WS for the iOS simulator, see below), `fixtures.js` (`test`, `expect`, `st` driver), `static-server.mjs`, local fonts, baseline script |
| `tests/booth/` | Stage View baseline. **Do not regenerate to make a failure go away.** A diff means the boothscreen changed, which BOUWPLAN forbids. |
| `tests/smoke/` | One coarse test per screen/function. Should survive refactors. |
| `tests/unit/` | Playwright picks up `*.spec.js` only; `*.test.js` are plain node scripts run by `npm run test:node`. Pure logic (time model, parsers). Today they run inside the page against app.html globals; once logic moves to `js/*.js` modules, plain node tests (`import` the module inside a Playwright test file) are fine too. |
| `tests/regression/` | One test per fixed bug, named after the BOUWPLAN item. Known-but-unfixed bugs: write the real test and wrap it in `test.fail(...)`; when your fix lands Playwright reports "expected to fail but passed": flip it to `test(...)`. |
| `tests/INVENTARIS.md` | Function/screen inventory (Dutch) with the covering test. Update it when you add coverage. |

## Writing a spec

```js
const { test, expect } = require('../support/fixtures');
const { FESTIVAL, ams } = require('../support/seed');

test('public stage view', async ({ page, st, backend }) => {
  await st.gotoPublic({ mode: 'stage', sid: FESTIVAL.stages.main, at: ams('2026-07-10', '16:00') });
  await expect(page.locator('#sv-artist')).toHaveText("DJ O'Neil");
});

test.describe('logged in', () => {
  test.use({ stAuth: 'admin' });          // 'admin' (company_admin) | 'operator' | 'super' | 'other'
  test('save', async ({ page, st, backend }) => {
    await st.gotoApp({ at: ams('2026-07-10', '16:00') });
    await st.openProject('Zomerfeest 2026');
    // ... act ...
    await expect.poll(() => backend.calls({ method: 'PATCH', path: '/rest/v1/projects' }).length).toBe(1);
  });
});
```

Prefer role/text selectors; use ids only where the app has no accessible name.

### Fixtures
- `backend` (automatic): a fresh `MockBackend` seeded with `festivalSeed()` per test. **Every non-localhost request is mocked or aborted**; an aborted one is a *violation* and fails the test. Real Supabase/OneSignal/Stripe can never be reached.
- `stAuth`: pre-seeds `localStorage.st_auth_v1` with a valid-looking JWT for that seed user, exactly like a returning user.
- `stSeed`: replace the seed (`test.use({ stSeed: mySeed })`) or tweak it: `test.use({ stSeed: { mutate(seed) { seed.projects[0].data.blackout = true; } } })`.
- `st`: `installClock(at, {paused})`, `gotoPublic({mode,pid,sid,at,paused})`, `gotoApp({at})`, `openProject(name)`, `advance(ms)`, `freezeAt(date)`, `serverClockFollowsPage()`.

### Clock
`page.clock` is installed before load. Time runs normally until you call `st.freezeAt(t)` (pause at t-1 s, run 1 s of timers, wait for CSS transitions). `st.advance(ms)` runs timers, including the 250 ms tick and the 1 s public poll. For exact countdowns at arbitrary steps, boot frozen instead: `gotoPublic({ ..., paused: true })` starts the page at exactly `at` and only `runFor`/`fastForward` move it (see `tests/regression/timer.spec.js`); wait for network effects with `expect.poll`, never a sleep. Use a `.400` ms offset when you assert rounded countdowns (see booth spec).

### Backend controls
```js
backend.project('proj-fest').data            // server-side state (after saves)
backend.calls({ method, path, url, host })   // recorded requests: { method, path, query, body, headers, injected }
backend.functionCalls('invite-member')
backend.failNext({ method: 'PATCH', path: '/rest/v1/projects', status: 500 })   // also: status 401, hang: true, abort: 'failed', delayMs, times
backend.setFunction('portal-link', (body) => ({ url: 'https://example.invalid' }))  // edge functions: default {ok:true}
backend.setRpc('get_shared_project', (body) => ({ json: null }))
backend.shareFeed('legacy' | 'modes' | 'version' | 'table')  // which share-link RPCs exist (default 'modes': both
                                             // get_shared_project variants, 2-arg stripped per tests/support/share-modes.js;
                                             // 'version' adds get_shared_project_version, 'table' has none)
backend.auth.loginError = { status: 400, error: 'invalid_grant', error_description: 'x' }
backend.auth.refreshFails = true; backend.auth.invalidTokens.add(token); backend.auth.recover = { status: 500, json: {...} }
backend.schema.companies = backend.schema.companies.filter(c => c !== 'setup_pending')  // simulate pre-migration DB -> 42703
backend.hiddenColumns = { companies: ['setup_token'] }  // column grants: select=*, implicit RETURNING * or the column -> 42501
backend.serverNow = date                     // Date header for the Wall's server-clock sync (or a function; st.serverClockFollowsPage() answers with the page's fake clock)
backend.updateProject(id, (data) => { ... }, { broadcast: true })  // edit as "another device" + push realtime UPDATE
backend.realtime.push({ table: 'projects', type: 'UPDATE', record, old_record })
backend.realtime.subscriberCount('projects')
backend.realtime.presenceOf('st-proj-proj-fest')                 // tracked presence metas [{key, role, stageId, ...}]
backend.realtime.broadcastsOf('cue-ack')                         // client broadcasts {topic, event, payload, via}
backend.realtime.sendBroadcast('st-proj-proj-fest', 'cue-ack', {...})  // inject a broadcast as "someone else"
backend.realtime.restBroadcasts                                  // supabase-js REST fallback sends (should stay empty)
backend.realtimeDown = true                                      // every realtime websocket is closed on connect
await backend.attach(await browser.newContext({...}))            // a second context (e.g. an anonymous booth) on the same backend
backend.onesignal                            // requests that would have gone to OneSignal
```
Fake PostgREST supports `select` (column lists, aliases), `eq/neq/in/is/gt/gte/lt/lte/like/ilike/not.`, `order`, `limit`, `offset`, `Prefer: return=representation|count=exact|resolution=merge-duplicates`, single-object `Accept`, and returns 42703 / PGRST204 for unknown columns.

### Booth baseline
Generated from commit 845eb0d (`npm run test:update-baseline` adds a temporary `git worktree` of that commit, serves it as `BASE_ROOT`, runs the booth projects with `--update-snapshots=all`, and removes the worktree). Comparisons are pixel-exact (`maxDiffPixels: 0`, `threshold: 0`) with one documented exception: the `overtime` moment allows 12 pixels (and booth projects get 1 retry for a torn frame under heavy load, reported as "flaky"), because Chromium sometimes leaves a 1-3 colour-level raster residue at the end of the collapsing progress bar. Animations are captured with Playwright's `animations: 'disabled'`; every screenshot set has a JSON fingerprint of the computed styles (incl. `animation-name`, transitions, fonts, geometry) so a removed blink or pulse is still caught. Snapshots are per engine and per OS (`-darwin`); generating on Linux CI needs its own baseline from 845eb0d. Every public Stage View test runs twice against the same snapshots: on the `legacy` feed (full blob via `get_shared_project(p_id)`) and on the stripped feed (`get_shared_project(p_id, p_mode)` + version poll), so the baseline also proves Stage View is identical on stripped data. The feed assertions are skipped when `BASE_ROOT` serves another build (e.g. during `test:update-baseline`).

## Mock server (iOS simulator, phase 6)

`app.html` hardcodes the production `SUPA_URL`, so the native dev build rewrites it to a local URL and this server answers there. It is the same fake as above, not a second one: `MockBackend.handleRequest` serves HTTP and `RealtimeStub` serves a real `ws` websocket (wrapped to look like Playwright's `WebSocketRoute`).

```bash
npm run mock:server                                   # http://127.0.0.1:54321, demo seed
node tests/support/mock-server.js --port 54330 --seed festival   # --seed demo | festival | empty, --port 0 = any free port
```

- Serves `/rest/v1/*` (incl. `rpc/`, `HEAD /rest/v1/` with a `Date` header from this machine's clock), `/auth/v1/*`, `/functions/v1/*`, `/storage/v1/*`, `/realtime/v1/websocket`, `/realtime/v1/api/broadcast`. Anything else, and any Supabase endpoint the mock does not know, answers 404 JSON (`code: MOCK404`). Nothing is proxied; the file has no outbound network code.
- Bound to `127.0.0.1` only. CORS is open: it echoes `Origin` (`capacitor://localhost`) and the requested headers, because a wildcard never covers `Authorization` in a real browser. One log line per request; Ctrl-C exits cleanly. State is in memory and gone on exit.
- Seed `demo` (default): the festival from `seed.js`, shifted so Friday 16:00 is now (Main Stage and The Tent are live, every stage has a next show; Amsterdam time, festival day from 07:00), the company's plan active for a year. `festival`: the fixed July 2026 seed the specs use. `empty`: no projects.
- Login: `tests/support/mock-server.seed.json` (a `.test` address and a generated password, printed on startup). These are test values for this local fake only. The `FESTIVAL.users` from `seed.js` work too.
- Port clash: Supabase CLI (`supabase start`, e.g. in Docker/colima) also uses 54321 on all interfaces, and macOS still lets this server bind `127.0.0.1:54321` beside it. The server then prints a WARNING: `127.0.0.1` reaches the mock, but the LAN address reaches the other service, and so does `127.0.0.1` once the mock stops. Stop that service or pick another `--port` (and the same port in the dev build's `SUPA_URL`).
- `tests/smoke/mock-server.spec.js` starts the server on a free port, serves `app.html` with `SUPA_URL` pointed at it and logs in, opens a project and checks realtime through real HTTP/WS, with the network guard still active.
