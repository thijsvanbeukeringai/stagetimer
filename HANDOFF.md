# Overdracht: verbeterronde 13 okt 2026 (gepauzeerd)

Lees eerst: `BOUWPLAN.md`, `CLAUDE.md` en `docs/MIGRATIES.md`.

## Stand

**Branch `improve/2026-10-13`** (tip `34e4d67`) bevat alles van fase S tot en met 4: spoedfix `setup_token`, sync/opslag, timer, import/auth, dialogen, bedieningsscherm/mobiel, weergaven, statische bestanden, docs en testharnas.

Laatste volledige controle:
- 164 Playwright-tests geslaagd;
- 48 node-tests geslaagd;
- **boothscreen 66/66 pixel-identiek** in Chromium en WebKit.

**Niets is gepusht, gedeployd of op productie uitgevoerd.**

## Nog samen te voegen (werk staat in worktrees onder `.claude/worktrees/`)

1. **`worktree-agent-af9124585825d6b70`**: commit `f370caa`, timer.spec deterministisch gemaakt (140/140 groen onder zware CPU-belasting). Klaar, alleen nog mergen.
2. **`worktree-agent-a43850c6a987231da`**: gestopt tijdens het werk. Bevat **ongecommitte** wijzigingen in `app.html`. Eerst bekijken, dan afmaken of opnieuw doen. Opdracht van deze agent:
   - Review #1 (Medium-High): een object wordt vóór `await stDialog` vastgepakt in `saveShow` en `setDayDate`. Komt er tijdens de dialoog een realtime-update binnen, dan gaat de bewerking stil verloren. Oplossing: na elke `await` opnieuw opzoeken op id. Alle `await stDialog`-plekken nalopen.
   - Review #2: `_refetchProject` gooit een refetch weg zolang er al één loopt. Oplossing: een pending-vlag zetten en de refetch opnieuw draaien.
   - Review #3: `delStage` en de stage-dedup bij import roepen `_markIntentionalRemoval` niet aan.
   - Review #4: `_dropRefusedStages` laat geïmporteerde shows als wees achter.
   - Review #6: offline-herstel luistert alleen naar `online`. Ook proberen bij `visibilitychange` en met een backoff-timer.
   - Review #7: behandel HTTP 429 en 408 bij de auth-probe als netwerkfout.
   - Review #5 (alleen docs): de app stuurt nog géén `p_mode`. Stap 9 en PHASE B in MIGRATIES markeren als NIET klaar.
   - **XSS HIGH**: ongeëscapete show-id's (`id="scd-${s.id}"` en `delFohnNote('${s.id}','${nt.id}')`) in de planningskaarten. Daarnaast alle inline handlers nalopen en id's normaliseren in `loadG`.
   - XSS LOW: voucher-id's in het superadmin-paneel via `_jsArg`.
   - `vercel.json`: CSP `frame-ancestors 'none'` botst met de XFO-uitzondering voor `?mode=`.
   - `_restWrite`: voeg `&select=id` toe. Zonder dat breekt workspace hernoemen na hotfix PART 2 (42501).
3. **`worktree-agent-ae3b6bca3ec9fbdf2`**: SQL-fixes gestopt vóór de eerste wijziging, dus opnieuw doen:
   - HIGH: REPLICA IDENTITY FULL plus een publicatie-kolomlijst laat alle UPDATE/DELETE op companies falen.
   - Helperfuncties zijn uitvoerbaar door anon/authenticated (Supabase default privileges): expliciet `revoke execute`.
   - `deleted_at`/`version` op projects zijn door clients schrijfbaar.
   - **Anon kan nú in productie `app_users` en `companies` DELETEN.** Maak een losse, direct toepasbare `revoke delete ... from anon`.
   - De `setup_pending`-grant gaat verloren in PHASE B van `signup_tokens`.

## Niet afgerond

- **Controle of alle functies behouden zijn:** gestopt zonder rapport. Opnieuw draaien: diff van functies, handlers en id's tussen `main` en de branch, plus bereikbaarheid op 390 en 1440 px.
- **Tweede XSS/CSP/SW-review en tweede SQL-review:** gestopt. De bevindingen van de eerste reviews staan hierboven.

## Acties voor Thijs (buiten de code)

- Draai de controle uit `BOUWPLAN.md` §S.1 (RLS en `setup_token` leesbaar?) en roteer de OneSignal-key.
- `supabase db pull` en `supabase functions download`, daarna committen.
- Open besluiten:
  - Moet "podium verwijderen" ook de shows van dat podium verwijderen?
  - Mogen share-links in een iframe/embed (CSP)?
  - Uitloggen: alleen dit apparaat, of overal?
  - Tijdzone vast op Amsterdam: akkoord?

## Werkwijze

- Elke agent werkt in een eigen worktree en begint met `git reset --hard improve/2026-10-13`.
- Elke agent krijgt een eigen `ST_PORT`.
- Nooit `pkill`.
- Booth-suite groen houden.
- Merge altijd met `--no-ff` naar `improve/2026-10-13`.
