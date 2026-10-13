# Working on Stagetimer (rules for AI agents)

Stagetimer is a paid SaaS for live festival timing. Customers run it during live shows, so a broken build means a stage without a clock. The whole app is `app.html` (~11.4k lines, everything inline, no build step), served statically by Vercel, with Supabase as the backend. `README.md` (Dutch) describes the architecture: data model, save/sync, time model, auth. `BOUWPLAN.md` is the current improvement plan, `docs/MIGRATIES.md` the migration runbook, `tests/README.md` the test harness.

## Hard rules

1. **The Stage View (boothscreen) is frozen.** Layout, font sizes, colours, animations, clock, progress bar and display modes must stay pixel-identical. Fixing its *data* (which show, which time) is allowed; changing how it looks is not. `npm run test:booth` must stay green.
   - Scope new CSS away from `#sv` and its `#sv-*` children: use a view prefix (`vw-`, `st-dlg`, ...) or a container selector (`#foh`, `#bs`, `#tl`, `#stov`, `#wv`, `#ci`, `#dash`). No global rules on `button`, `body`, `*`, fonts or `:root` tokens that Stage View inherits.
   - Colour-blind status labels, `prefers-reduced-motion`, zoom and similar accessibility work apply **outside** Stage View only.
   - **Never regenerate the booth baseline** (`npm run test:update-baseline`) to make a diff go away. A diff means the boothscreen changed: find and fix the cause.
2. **Never contact production.** Tests run fully offline: the harness mocks Supabase, OneSignal and Stripe, aborts every non-localhost request and fails the test on it. Keep it that way: mock new endpoints in `tests/support/mock-backend.js`. Do not run the app against production to "try something": `app.html` hardcodes the production `SUPA_URL`, so logging in on a local server reads and writes real customer data. No real invites, pushes, emails or payments.
3. **Never push to `main`, never deploy.** Work on a branch with small commits; Thijs reviews, merges and deploys. Vercel auto-deploys `main`.
4. **Backend migrations are prepared, not applied.** Files in `supabase/migrations/` have not been run on production. Never run `supabase db push`, `supabase migration repair` or anything against the live project. A new migration gets a header (goal, prerequisites, order, verification queries, `ROLLBACK` block), is idempotent, and gets a step in `docs/MIGRATIES.md`. App code that needs a new RPC or column must keep working without it (detect `404`/`PGRST202` or `42703` and fall back; see `_rpcFnMissing`, `_companiesWithout`, `_fetchSharedProjectRaw`).
5. **Keep everything that exists working**: all features, existing projects, and every share link (`?mode=…&pid=…[&sid=…]`). No new product features, no framework, no bundler, no rewrite.
6. **Never read `companies.setup_token`.** Select companies with `COMPANY_COLS`, never `select=*`.
7. Nothing under `tests/`, `supabase/`, `docs/` or `*.md` is deployed (`.vercelignore`). Anything new at the repo root **is** public unless you add it there.

## Language and style

- **App UI text is English.** Docs are Dutch (`README.md`, `BOUWPLAN.md`, `docs/MIGRATIES.md`, `tests/INVENTARIS.md`, `supabase/functions/README.md`); `tests/README.md`, this file and code comments are English.
- House style in `app.html`: dense code, short functions on one line where they fit, no new dependencies. Comments explain **why** (the bug it prevents, the production incident, the constraint), not what the next line does. Match the surrounding code.
- Every `catch` either handles the error or logs `console.warn('[area] what failed:', e)`. No new empty `catch(e){}`.
- No `alert()` / `confirm()` / `prompt()`: use `stDialog`.
- Do not add `localStorage` keys casually; existing ones are listed in `README.md`.

## Where things live in `app.html`

Sections start with `// ══ NAME`. Find them with `grep -n '// ══' app.html`; line numbers shift, so search by name.

| Marker | What |
|---|---|
| `UTILS` | `uid`, `escH`, `safeColor`, countdown formatters |
| `SUPABASE` | client, `_jwt`, `_rpc`, `st_auth_v1` sync, `_refreshAuthToken`, `_friendlyError`, `_jsArg`, `_opNotice` |
| `APP STATE (multi-project)` | cache load, `_restGet`, `COMPANY_COLS` / `_mapCompany`, `loadAPPRemote`, `loadG`, per-device selections (`st_sel_<pid>`) |
| `SAVE / SYNC` | `save`, `_pushProject` / `_pushOnce`, 3-way merge `_mergeData`, `_markIntentionalRemoval`, `setSaveState`, realtime |
| `PURE TIME MODULE ─ begin` … `─ end` | clock, Europe/Amsterdam, 07:00 festival day, show intervals, manual timer model, `makePollGate` |
| `MANUAL TIMER`, `RENDER TIMER PANEL`, `RENDER SCHEDULE` | operator control screen |
| `RIDER` | `show.rider = {drinks, tech}` helpers: `riderOf(s)` (trimmed strings), `hasRider(s)`, `RIDER_MAX`; share links: only `checkin` / `stagemanager` receive it |
| `BOOTH LINK`, `MESSAGE BOOTH` | delivery receipts + screen presence over Realtime broadcast/presence; the phone-first "Message booth" sheet (just above `TICK`) |
| `DIALOGS (stDialog)` | the one dialog component |
| `VIEW HELPERS`, `FOH`, `BACKSTAGE`, `STAGE VIEW`, `STAGE OVERVIEW`, `TIMELINE VIEW` | screens; the Wall is the block headed `// CONTROL ROOM WALL` (no `══` name marker), the server clock is `SERVER TIME SYNC` right below it |
| `JSON IMPORT`, `DAY MANAGEMENT`, `STAGE MANAGEMENT`, `DASHBOARD` | planning and back office |
| `ONESIGNAL`, `SHARE LINKS`, `ARTIST CHECK-IN`, `PUBLIC VIEW MODE`, `PUBLIC VIEWS (share links): data feed` | push and share-link screens |
| `AUTH`, `INIT`, `AUTH INIT v2` | login, start-up, auth links, service-worker registration |

**These markers are load-bearing.** The unit tests cut code out of `app.html` by exact marker text: `// ══ APP STATE (multi-project)`, `// ══ PURE TIME MODULE ─ begin` / `─ end`, `// ── 3-way merge (pure` / `// ── end 3-way merge`, plus `function _friendlyError(`, `// In-flight tracker so the 1s poll` and `function copyLink(btn,url){`. Renaming or moving them breaks the tests; keep the time module and the merge free of DOM, globals and network.

## Helpers to reuse (do not write a second version)

- **HTML escaping**: `escH(s)` for text and attribute values in template strings. `_jsArg(v)` for a value inside an inline handler: `onclick="fn(${_jsArg(id)})"` (handles `O'Neil`; `'${escH(x)}'` does not). `safeColor(c, fallback)` for colours from data that land in `style=""`.
- **Dialogs**: `stDialog.alert / confirm / prompt / form / choice / open`, all Promise-based, accessible, focus-trapped.
- **Errors for humans**: `_friendlyError(e, 'Saving')` for any failed request; `humanError(e, action)` on the save/load path (adds offline, storage-full and plan-limit cases). Non-blocking operator messages: `_opNotice(msg, {key, sticky, actionLabel, onAction})` (never on share links or over Stage View).
- **Time**: `nowMs()` (server-corrected), never `Date.now()` for show timing. `festivalDayOf(ms)` / `festivalDayStr()`, `amsDateStr` / `amsTimeStr` / `amsParts` / `parseFestivalISO`, `showIntervalMs` / `_showIv`, `showAllowed(s, 'list'|'live', isPublic)`, `pickLiveShow` / `pickNextShow`, `curShow` / `nxtShow`. View status wording: `vwStatusKey` / `vwChips` / `vwDayLabel`.
- **Saving**: change `G`, then call `save()` (`save({immediate:true})` when it must go out now). Never PATCH the project blob yourself. Show `setSaveState` / `_refreshSaveState` rather than painting the sync dot. When the user deliberately removes shows, days or stages, call `_markIntentionalRemoval(showIds, {days, stages})` **before** `save()`, or the merge restores them as "stale". `_whenSaved(pid)` resolves when the push settled.
- **Requests**: `_restGet` / `_sbFetch` / `_rpc` (user JWT, timeout, one refresh on 401). Share-link screens use the anon key only (`_rpc` does that when `PUBLIC_MODE` and `pid` are set). Never await `supa.auth.*` without `_withTimeout`.
- **Share-link screens never save the blob** (`save()` returns in `PUBLIC_MODE`); check-in writes through `set_show_arrived`.
- **Booth link** (`// ══ BOOTH LINK`, phase 5D): one Realtime channel `st-proj-<pid>` with broadcast + presence only (no `postgres_changes`, no DB write). Booth screens track presence and broadcast `cue-ack {cueId, stageId, device, at}`; operators count them. Cue content never travels over it (only from `G.cue` in the saved project) and every incoming field is validated. It needs Realtime broadcast/presence enabled on the Supabase project (the default); it is a public channel, so acks can be faked by anyone with the pid: tighten later with private channels + Realtime Authorization. Never `send()` on a channel that is not `SUBSCRIBED` (supabase-js would fall back to a REST POST); use `_pcSend`.

## Tests

```bash
npm ci
npx playwright install chromium webkit                  # once per machine
ST_PORT=5612 npm test                                   # everything, chromium + webkit
ST_PORT=5612 ST_BROWSERS=chromium npx playwright test tests/regression/logic.spec.js
ST_PORT=5612 npm run test:booth                         # Stage View pixel baseline
npm run test:node                                       # tests/unit/*.test.js (sync merge / queue, plain node)
```

- `ST_PORT` (default 5599): give every parallel worktree its own port. A busy port fails loudly instead of testing another tree.
- Run at least the specs you touched plus `test:booth` before you report a change as done; run `npm test` for anything in sync, time, auth or shared CSS.
- **Adding a regression test**: one test per fixed bug in `tests/regression/`, named after the BOUWPLAN item, using `tests/support/fixtures` (`test`, `expect`, `st`, `backend`) and `seed.js`. Assert on server state with `backend.project(...)` / `backend.calls(...)`; drive time with `st.installClock` / `st.freezeAt` / `st.advance`, not real waits. A known bug you are not fixing: write the real test wrapped in `test.fail(...)`; flip it to `test(...)` when the fix lands. Pure logic goes in `tests/unit/`. Update `tests/INVENTARIS.md` when you add coverage.
- Every non-localhost request in a test must be mocked; an unmocked one fails the test as a network violation.

## Shipping notes (for whoever prepares a deploy)

- `sw.js`: bump `SW_VERSION` once per deploy that changes `app.html`, `vendor/`, `fonts/` or icons; add new shell files to `PRECACHE`.
- Upgrading supabase-js: replace `vendor/supabase.js`, recompute the SRI hash on the `<script>` tag (instructions in the comment above it) and bump `SW_VERSION`.
- Backend: follow `docs/MIGRATIES.md` step by step. App changes that depend on a migration must say which step they need.
- Known limits, do not "fix" by surprise: photos are base64 in the JSONB blob until migration step 16 (`photo_storage`) is applied, after that new ones are Storage URLs (`_uploadMedia`; `show.photo` may hold either form, keep every renderer accepting both); the GET-merge-PATCH save keeps a ~100 ms race until migration `project_versioning` is applied (the app then switches to `save_project` by itself); share links are protected only by knowing the `pid`.
