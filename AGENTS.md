# AGENTS.md

The working rules for AI agents on this repo live in **[CLAUDE.md](CLAUDE.md)**. Read it before changing anything; it applies to every agent, not only Claude.

The non-negotiables, in short:

1. **Stage View (the boothscreen) is frozen.** It must stay pixel-identical: `npm run test:booth` stays green. Never regenerate the booth baseline to hide a diff, and keep new CSS away from `#sv` / `#sv-*`.
2. **Never contact production.** Tests are fully offline (non-localhost requests are aborted and fail the test). A locally served `app.html` talks to the production Supabase, so do not log in or save against it.
3. **Never push to `main` and never deploy.** Work on a branch; Thijs merges and deploys.
4. **Migrations in `supabase/migrations/` are prepared, not applied.** Never run `supabase db push` or anything against the live project; follow `docs/MIGRATIES.md`.
5. **App UI text is English**; keep the house style of `app.html` (dense code, comments explain why) and reuse the existing helpers listed in CLAUDE.md.

Tests: `npm ci`, then `ST_PORT=<free port> npm test` (see `tests/README.md`).
