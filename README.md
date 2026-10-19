# Stagetimer

Realtime productie-timing voor festivals en events. Eén applicatie met meerdere views (bediening, FOH, backstage, Stage View, tijdlijn, overzicht, Control Wall en artiest-check-in) bovenop één gedeelde dataset in Supabase. Het product draait op [stagetimer.nl](https://stagetimer.nl).

> **Stand van deze README:** branch `improve/2026-10-13` (verbeterronde oktober 2026, zie `BOUWPLAN.md`). Wat hier staat is gebouwd en lokaal getest, maar **niet automatisch live**. Deployen en de backendmigraties uitvoeren doet Thijs zelf, in de volgorde van `docs/MIGRATIES.md`.

---

## Wat het doet

Stagetimer regelt het kloksysteem voor producties met meerdere podia en meerdere dagen. Je voert per podium per dag de lineup in (artiest, start, einde, booth, crew, foto, notitie) en de applicatie laat voor elke rol een afgestemde view zien:

| View | Voor wie | Inhoud |
|---|---|---|
| **Bediening** | Operator / stage manager | Timerpaneel (live of handmatig), planning, tijdcorrecties, cues en blackout |
| **FOH** | Front-of-house / regie | Grote aftelklok van de actieve show, programma-strook, voortgangsbalk |
| **Backstage** | Crew achter het podium | Kaartenlijst per show met countdown, crew, notities, foto |
| **Stage View** | Op podium / monitor (het "boothscreen") | Fullscreen artiest + resttijd, leesbaar op afstand. Modi: countdown, clock, countup, blank |
| **Tijdlijn** | Coördinatie | Horizontale Gantt-view over alle podia, met now-lijn en kleur per booth |
| **Overzicht** | Productieleider / gedeeld scherm | Alle podia in één blik: live status, volgende artiest, aftelklokken |
| **Control Wall** | Vaste wandschermen in de regieruimte | Raster per podium, kleurgestuurd, leesbaar op 3 tot 5 meter |
| **Check-in** | Artist liaison | Artiesten als "aangekomen" markeren |

Elke view behalve de bediening is ook beschikbaar als **deellink** zonder login. Alle deellinks zijn alleen-lezen, behalve check-in: die mag aankomsten opslaan en verder niets.

## Belangrijkste features

- **Multi-podium, multi-dag**: stages en dagen per project, binnen de limiet van het abonnement.
- **Festivaldag van 07:00 tot 07:00, Europe/Amsterdam**: een show om 01:30 hoort bij de avond ervoor, ongeacht de tijdzone van het apparaat.
- **Realtime sync** via Supabase Realtime, gefilterd op het open project, met een terugval-poll als realtime wegvalt.
- **Geen stil dataverlies**: opslaan voegt eerst samen met de serverversie, mislukte saves blijven staan en worden opnieuw geprobeerd (zie *Opslaan en sync*).
- **Persoonlijke selecties**: podium, dag en timermodus horen bij het apparaat, niet bij het project. Een operator die naar Dag 3 bladert, trekt andere schermen niet mee.
- **Prioriteit, geannuleerd en verborgen** per show. Geannuleerde shows worden nooit "live"; verborgen shows zijn nooit zichtbaar op deellinks.
- **Crew per show** (VJ, Light, Sound, SFX, Laser), notities, foto's.
- **Lineup-import** via JSON: eerst een voorbeeld van wat er wordt toegevoegd of vervangen, pas daarna toepassen. Vervangt alleen binnen (dag, podium).
- **Tijdcorrecties** met expliciete keuze (alle volgende shows verschuiven / alleen de volgende show / annuleren) en een voorbeeld van de nieuwe tijden.
- **Cues en blackout** naar een gekozen podium; **losse timers** (one-off) met hetzelfde middernachtmodel als shows.
- **Bericht naar booth** (telefoon-eerst sheet, knop *Message booth* / *Booth*): podium of alle podia, presets, vrije tekst (max. 40 tekens), duur, wissen en blackout, met **ontvangstbevestiging** ("Delivered to 1 of 1 Main Stage screen · seen 22:41:05") en het aantal boothschermen online. Zie *Booth link*.
- **Push-meldingen** voor crew via de edge function `send-push` (zie *Tech stack*).
- **Kleedkamerscherm** per artiest (deellink `mode=dressing`): een grote countdown naar de show over een eigen achtergrondvideo of -foto, tijdens de show de resterende settijd, daarna een bedankscherm met het klantlogo. Zie *Kleedkamerscherm* hieronder.
- **Wake lock** op FOH, Backstage, Stage View, Tijdlijn, Overzicht, Control Wall, Stage manager en het kleedkamerscherm, zodat monitoren niet op zwart gaan.
- **Offline opstarten**: de app-shell (HTML, supabase-js, fonts, iconen) staat in de service-worker-cache. Een opgeslagen login blijft geldig als de auth-server even onbereikbaar is.
- **Toegankelijke dialogen**: één dialoogcomponent (`stDialog`) met focus trap, Escape en focus-terugkeer, in plaats van `alert()`/`confirm()`/`prompt()`.

## Tech stack

- **Frontend**: één HTML-bestand, `app.html` (~11.400 regels, alles inline). Geen build step, geen framework, geen bundler.
- **supabase-js**: lokaal in `vendor/supabase.js` (2.112.3, UMD), met SRI-hash in `app.html`. Bijwerken staat beschreven in het commentaar boven de `<script>`-tag.
- **Fonts**: zelf gehost in `fonts/` (Inter, JetBrains Mono, Geist, Geist Mono) via `fonts/fonts.css`. Geen Google Fonts meer.
- **Service worker**: één worker, `sw.js`, op scope `/`. HTML is network-first; de cache springt alleen in als het netwerk faalt. Op `stagetimer.nl` importeert `sw.js` de OneSignal SW-SDK (`importScripts`), zodat OneSignal en de app-cache niet meer om dezelfde scope vechten. `OneSignalSDKWorker.js` staat er alleen nog voor oude registraties; niets registreert hem meer.
- **Database en realtime**: [Supabase](https://supabase.com) (Postgres, projectdata als JSONB).
- **Auth**: Supabase Auth met e-mail en wachtwoord. REST-calls gaan direct via `fetch` met een harde timeout; `supa.auth.*` wordt nooit onbegrensd afgewacht (die calls zijn in productie blijven hangen).
- **Edge functions**: bestaande functies voor signup, Stripe-portal, leden en vouchers (broncode nog niet in git, zie `supabase/functions/README.md`). Nieuw en alleen als broncode: `supabase/functions/send-push`. De client verstuurt crew-pushmeldingen alleen nog via die functie, met het JWT van de gebruiker. Zolang hij niet gedeployed is, worden er geen pushmeldingen verstuurd en ziet de operator één keer "Push is not configured yet".
- **Push**: OneSignal Web SDK v16, alleen geladen op `stagetimer.nl` en nooit op deellinks.
- **Hosting**: [Vercel](https://vercel.com), statisch (`outputDirectory: "."`, geen build). `.vercelignore` houdt `tests/`, `supabase/`, `docs/`, `*.md`, `package*.json` en de dev-scripts uit de publieke site.
- **Landing page**: `index.html`, los van de app.

### Data model

Alles van één project leeft in één rij in de tabel `projects`, als JSONB in de kolom `data`:

```jsonc
{
  "stages":  [ { "id", "name", "emoji" } ],
  "days":    [ { "id", "name", "date" } ],          // date: "YYYY-MM-DD" (optioneel)
  "shows":   [ { "id", "stage", "day", "artist",
                 "start", "end",                     // "HH:MM:SS", festivaltijd
                 "date", "startsAt", "endsAt", "endsNextDay",   // ISO-model, festivaltijd zonder zone
                 "booth", "genre", "type", "note", "photo", "crew", "rider",
                 "bgVideo", "bgImage",                // kleedkamerscherm, optioneel
                 "cancelled", "priority", "hidden", "arrived", "arrivedAt" } ],
  "fohNotes":  { "<showId>": [ ... ] },
  "memberIds": [ ... ],
  "svModes":   { "<stageId>": "countdown" | "clock" | "countup" | "blank" },
  "cue":       { "text", "color", "stageId", ... } | null,
  "blackout":  false,
  "logo":      null,                                 // data: URL of Storage-URL: klantlogo op Backstage / FOH
  "branding":  { "logoBackstage": true, "logoFoh": false, "logoBackdrop": false },   // waar het logo staat; witte plaat achter donkere logo's
  "activeStage", "activeDay", "timerMode",          // legacy, zie hieronder
  "_rev":      "<client-rev>"                        // nieuw, zie Opslaan en sync
}
```

- Een show hoort via `day` bij een day-object. Het tijdstip volgt uit `startsAt`/`endsAt`, anders uit `date` (of de datum van de dag) plus `start`/`end`, anders (oude projecten zonder datums) uit de 07:00-regel. Een einde op of vóór de start valt op de volgende dag.
- **Foto's (`show.photo`) en logo (`logo`)**: een `data:`-URL (base64, oud en terugval) **of** de publieke URL van een object in de Storage-bucket `project-media`: `https://<ref>.supabase.co/storage/v1/object/public/project-media/<pid>/<32 hex>.jpg`. Beide zijn gewoon een `<img src>`, dus elke weergave en elke oudere client werkt met allebei. Een nieuwe foto gaat na het verkleinen naar Storage (`_uploadMedia`, met het JWT van de gebruiker). Mislukt dat (bucket bestaat nog niet, offline, geen recht, deellink, uitgelogd), dan blijft de foto base64 in de blob, precies zoals vroeger. Bestaande base64-foto's van het open project verhuist de app op de achtergrond, drie per 20 s (`movePhotosToStorage`). Een vervangen of weggehaalde foto wordt na een geslaagde save uit de bucket verwijderd, behalve als een andere show hem nog gebruikt. Shows of projecten verwijderen laat de foto's staan, zodat herstellen uit de historie blijft werken. De bucket komt uit migratie `20261013150000_photo_storage.sql` (stap 16 in `docs/MIGRATIES.md`).
- **Projectlogo (`logo` + `branding`)**: de eigenaar uploadt het per project via het logo-icoon in de dashboardrij of Project settings → Project logo. Het staat linksboven op Backstage (standaard aan) en, als dat aan staat, op FOH, in de app en op de backstage/foh-deellinks; het stagetimer.nl-merk blijft in dezelfde header staan. Stage View, Wall en de andere schermen tonen het nooit. Alleen een `data:image/(png|jpeg|webp|gif)`-URL of een URL uit de eigen bucket `project-media` wordt getoond (`_safeLogoSrc`). Een donker logo op een transparante achtergrond krijgt bij upload automatisch een witte plaat (`logoBackdrop`, uit te zetten). Een logo uit de tijd dat logo's niet getoond werden (geen `branding`) blijft verborgen tot de eigenaar het aanzet.
- **Kleedkamerscherm (`show.bgVideo`, `show.bgImage`)**: `bgVideo` is een https-link naar een eigen videobestand van de klant (MP4, max. 2000 tekens, gecontroleerd door `_safeVideoSrc`); de video zelf staat nooit in de blob en ook niet in de bucket. `bgImage` is een achtergrondfoto en gaat door dezelfde verklein- en uploadroute als `show.photo` (Storage-URL, of base64 zolang de bucket ontbreekt). Beide sleutels ontbreken als ze leeg zijn. Geen YouTube: de voorwaarden van YouTube verbieden iets over de speler heen, en embeds werken niet in de iOS-app.
- **`_rev`**: elke save zet een door de client gegenereerde revisie. Daarmee herkent een tabblad zijn eigen realtime-echo's. Oude clients nemen de sleutel gewoon mee.
- **Selecties per apparaat**: `activeStage`, `activeDay` en `timerMode` staan per project in `localStorage` onder `st_sel_<pid>`. De velden in de blob blijven voor compatibiliteit. `activeDay` wordt alleen nog naar de blob geschreven als dat geen monitor van een live dag kan trekken (geen dag gedateerd op vandaag, of de operator kiest de dag van vandaag). `activeStage` en `timerMode` worden niet meer geschreven.
- **Companies**: de client leest een expliciete kolomlijst (`COMPANY_COLS`), nooit `select=*` en nooit `setup_token`. "Awaiting activation" komt uit de afgeleide kolom `setup_pending`. Bestaat die kolom nog niet (migratie niet toegepast), dan leest de app zonder die kolom verder.
- **Versies en soft delete**: `projects.version` (met `save_project`/`patch_show`), `deleted_at` (soft delete) en `project_versions` (historie) staan in de migraties onder `supabase/migrations/` (stap 6 en 7 van `docs/MIGRATIES.md`). De app herkent ze zelf en gebruikt ze zodra ze bestaan; daarvoor werkt hij zoals voorheen. `patch_show` wordt nog niet gebruikt.

Overige `localStorage`-sleutels: `st_app_v1` (offline kopie van projecten, companies en users), `st_auth_v1` (sessie), `st_active_proj`, `st_current_user`, `st_wall_theme`, `st_wall_day_override`, `st_foh_sound` (FOH-piep bij getimede notities, per apparaat, standaard uit), en alleen in de native app: `st_native_role_v1` (waar dit toestel voor is: `{role:'crew'}`, `{role:'booth'}` tijdens het instellen, of `{role:'booth',pid,sid}`: dan opent de app meteen die Stage View) en `st_native_booth_cache_v1` (laatste projectdata van het boothscherm, zonder foto's en logo, max. ~1,5 MB, zodat een koude start zonder netwerk de show toch toont).

## Structuur

```
.
├── app.html                  # De volledige applicatie (alles inline)
├── index.html                # Landing page op /
├── sw.js                     # De enige service worker (app-shell cache + OneSignal op productie)
├── OneSignalSDKWorker.js     # Legacy, alleen voor oude registraties
├── vendor/supabase.js        # supabase-js 2.112.3, lokaal
├── fonts/                    # Zelf gehoste fonts + fonts.css
├── manifest.json, *.png/svg  # PWA-iconen
├── vercel.json               # Rewrite /app → /app.html, headers, CSP (report-only)
├── .vercelignore             # Dev-bestanden buiten de publieke site
├── .devserver.py             # Lokale server met de /app-rewrite
├── supabase/migrations/      # Voorbereide migraties (NIET toegepast)
├── supabase/functions/       # Edge function-broncode (send-push)
├── supabase/email-templates/ # Auth-e-mails
├── docs/MIGRATIES.md         # Draaiboek: volgorde, timing, rollback
├── tests/                    # Playwright-harnas (offline), zie tests/README.md
└── BOUWPLAN.md               # Plan van de verbeterronde
```

`app.html` is ingedeeld met sectiemarkeringen `// ══ NAAM` (UTILS, SUPABASE, APP STATE, SAVE / SYNC, PURE TIME MODULE, DIALOGS, STAGE VIEW, PUBLIC VIEWS, AUTH, INIT, ...). Zoek op functienaam; regelnummers verschuiven.

### URL-structuur

- `/`: landing page
- `/app`: de applicatie (rewrite naar `app.html`)
- `/app?mode=timeline&pid=<projectId>`: tijdlijn
- `/app?mode=overview&pid=<projectId>`: overzicht
- `/app?mode=wall&pid=<projectId>`: Control Wall
- `/app?mode=checkin&pid=<projectId>`: artiest-check-in (mag aankomsten opslaan)
- `/app?mode=stage&pid=<projectId>&sid=<stageId>`: Stage View
- `/app?mode=backstage&pid=<projectId>&sid=<stageId>`: backstage
- `/app?mode=foh&pid=<projectId>&sid=<stageId>`: FOH
- `/app?mode=stagemanager&pid=<projectId>&sid=<stageId>`: stage manager (mag aankomsten opslaan)
- `/app?mode=dressing&pid=<projectId>&shid=<showId>`: kleedkamerscherm van één artiest
- `/app?signup=success&cid=…&t=…`: afronden van een signup na betaling
- `/festival-dashboard.html`: redirect naar `/app` (het oude bestand is weg)

Deellinks laden het project via de RPC `get_shared_project(p_id)`, altijd met de anon-key (nooit met een verlopen JWT van een eerder ingelogd apparaat). Bestaat de RPC nog niet (404 / `PGRST202`), dan leest de app de rij direct uit `projects`, zoals productie dat nu doet, en onthoudt dat voor de sessie. Al bestaande deellinks blijven dus werken, voor en na de migratie.

Een deellink pollt één keer per seconde, één verzoek tegelijk, en rendert alleen opnieuw als de data of de tijdsafhankelijke toestand verandert. Het scherm kiest zelf zijn dag (de festivaldag van vandaag) en podium (`sid`). Deellinks slaan nooit de blob op; check-in schrijft via de RPC `set_show_arrived`, met een terugval naar lezen-wijzigen-schrijven zolang die RPC ontbreekt.

### Kleedkamerscherm

`?mode=dressing&pid=<projectId>&shid=<showId>` (sectie `// ══ DRESSING ROOM`, root `#dres`) staat op een iPad of tv in de kleedkamer van één artiest. Vóór de show: artiestnaam, "Friday · Main Stage · 21:30", *Showtime in* en een grote countdown (meer dan een dag: "N days"); tijdens de show *On stage now* met de resterende settijd; daarna een rustig bedankscherm: het klantlogo (altijd, los van de branding-schakelaars van Backstage/FOH; witte plaat als `logoBackdrop` aan staat), "Thank you so much for the amazing show!", de artiest en "— Thanks from the artist team". Die twee teksten zijn per festival aan te passen via het projectmenu → *Dressing room screen* (`data.dressing = {thanks, signature}`, elk max. 160 tekens, `_dresTexts`; leeg of ontbrekend = de standaardtekst, het streepje voor de afzender zet het scherm zelf). De tijd komt uit het rooster (`_showIv` + `nowMs()`); een handmatige timer bestaat alleen in het tabblad van de operator en wordt nooit gesynct. Achtergrond: de video (`<video muted loop playsinline autoplay>`, `src` alleen opnieuw gezet als `bgVideo` verandert), anders de foto, anders donker; een video die niet afspeelt of 15 s stokt valt terug op de foto. Na de show stopt de video en ligt de foto gedimd achter de tekst. Een verborgen show heeft gewoon zijn kleedkamerscherm (de link noemt de show), een geannuleerde show toont een neutrale melding, een verwijderde show "This artist is no longer in the schedule…". Niets op het scherm is aanklikbaar; de native app gebruikt 3 s vasthouden linksboven als verborgen uitgang. De links staan per podium (ingeklapt, per dag) in het deeldialoog en per show in de showeditor. Server: `get_shared_project(p_id,'dressing')` houdt `logo` en `shows[].bgImage` (stap 3 in `docs/MIGRATIES.md`); vóór die migratie werkt het scherm op de volledige legacy-feed.

## Opslaan en sync

De code staat in de sectie `// ══ SAVE / SYNC` van `app.html`; het commentaar bovenaan is de referentie.

1. `save()` schrijft de lokale cache, zet `_pendingPush[id]` en start na 300 ms een push. `save({immediate:true})` pusht direct.
2. `_pushProject()` is een wachtrij met één save tegelijk per project. Wijzigingen die binnenkomen terwijl een push onderweg is, worden samengevoegd tot één vervolg-push.
3. `_pushOnce()` haalt eerst de verse rij op en doet een **3-weg merge** (`_mergeData`) per id en per veld: basis = de laatste versie die de server aan dit tabblad bevestigde, lokaal = dit apparaat, server = de verse kopie. Daarna schrijft hij het resultaat met een nieuwe `_rev`:
   - **met migratie `project_versioning`**: via `save_project`, dat alleen schrijft als de rij nog op de gelezen `version` staat. Schreef een ander apparaat ertussen, dan komt de serverrij terug, wordt opnieuw samengevoegd en opnieuw verstuurd (begrensd). Realtime-echo's met een `version` die niet nieuwer is, worden genegeerd;
   - **zonder die migratie** (kolom of RPC ontbreekt, per sessie onthouden): een PATCH, zoals voorheen.
4. **Verwijderen**: een show of dag die lokaal ontbreekt maar op de server staat, wordt alleen verwijderd als hij bewust is weggehaald (`_markIntentionalRemoval`: verwijderen, dag verwijderen, import). Anders is het verouderde data en komt hij terug, met een melding.
5. **Wipe guard**: een lege lokale lineup overschrijft nooit een gevulde server. Realtime-berichten zonder `data` worden genegeerd en het project wordt opnieuw opgehaald. `save_project` heeft dezelfde bewaking op de server; de app stuurt `p_force` alleen als alles wat leeg raakt bewust is verwijderd.
6. **Fouten**: een mislukte save houdt `_pendingPush` vast (en de `beforeunload`-waarschuwing) en probeert opnieuw na 1, 2, 5, 10 en daarna elke 30 s, en meteen bij `online` of als het tabblad weer zichtbaar wordt. Bij een 401 wordt het token één keer ververst. Een weigering op de planlimiet (`PT402`) haalt de geweigerde stage(s) lokaal weg en slaat de rest alsnog op.
7. **Opslagstatus**: `setSaveState('saved' | 'saving' | 'unsaved', detail)` stuurt het event `st:savestate`. Het bedieningsscherm toont dat op elk formaat als label *Saved / Saving… / Not saved* (tik voor de reden); de oude sync-stip zit daarin. De stip is nooit groen als een save mislukte of de wipe guard ingreep.
8. **Cache**: `localStorage` vol (base64-foto's)? Dan wordt de offline kopie zonder foto's bewaard; de server-push hangt nooit van de cache af. Storage-URL's zijn kort en blijven altijd in de cache. De foto's zelf cachet alleen de browser (de service worker laat andere origins met rust): een toestel dat offline opstart zonder die cache, toont de timerfoto niet. Het fotovak klapt dan in. De Stage View toont geen foto's.
9. **Na een onderbreking** (offline, slaapstand, realtime opnieuw verbonden): eerst openstaande wijzigingen pushen, anders het open project opnieuw ophalen. Zonder realtime pollt de app elke 30 s.
10. **Verwijderen van projecten**: met migratie `project_history_soft_delete` gaat een project naar *Recently deleted* (30 dagen herstelbaar, ook de versiegeschiedenis per project voor company_admin en hoger); zonder die migratie blijft het de harde DELETE.

### Booth link (ontvangstbevestiging en aanwezigheid)

Code: `// ══ BOOTH LINK` en `// ══ MESSAGE BOOTH` in `app.html` (BOUWPLAN 5A/5D).

- Per open project één Realtime-kanaal `st-proj-<pid>` met alleen **broadcast** en **presence**. Geen `postgres_changes`, geen schrijfactie in de database, geen migratie.
- Boothschermen (deellink `mode=stage` en de Stage View in de app) melden zich via presence (`role:'booth'`, `stageId`, korte apparaat-id, `mode`). Zodra een cue op het scherm staat, sturen ze een broadcast `cue-ack` met het `id` van de cue (`G.cue.id`, nieuw, oude clients negeren het). Stage View zelf verandert niet.
- De bediening telt schermen en acks per cue. Geen ack binnen 3 s terwijl er schermen online zijn: waarschuwing. Zonder Realtime gaat de cue gewoon via `save()` en zegt de bon "Delivery unknown".
- **Beveiliging:** de inhoud van een cue komt alleen uit het opgeslagen project. De bediening luistert alleen naar `cue-ack`, `ack-request` en presence, valideert elk veld en toont alleen een aantal en een tijd. Het is een publiek kanaal: wie de `pid` kent, kan een ack of aanwezigheid vervalsen (niet een cue sturen). De bon is dus een signaal, geen bewijs.
- **Supabase:** Realtime broadcast en presence moeten aan staan voor het project (standaard zo). Later aanscherpen kan met *private channels* plus Realtime Authorization (RLS-policies op `realtime.messages`): alleen ingelogde leden van het project mogen dan `ack-request` sturen en lezen, boothschermen krijgen een eigen token.

## Tijdmodel

Alles staat tussen `// ══ PURE TIME MODULE ─ begin` en `─ end` in `app.html`: pure functies, geen DOM, geen netwerk. De unit-tests knippen dat blok op die markeringen uit het bestand.

- **Klok**: `nowMs()` = apparaatklok + serveroffset. `syncServerTime()` leest de `Date`-header van Supabase bij de start en elke 60 s. De offset blijft 0 zolang het apparaat binnen de resolutie van de header klopt, dus een goed ingesteld apparaat ziet geen sprong. Gebruik `nowMs()`, nooit `Date.now()`, voor alles wat met showtijden te maken heeft.
- **Tijdzone**: festivaltijden zijn Europe/Amsterdam (`festivalTZ()`), welke zone het apparaat ook heeft. Helpers: `amsParts`, `amsDateStr`, `amsTimeStr`, `amsWallToMs`, `parseFestivalISO`.
- **Festivaldag**: 07:00 tot 07:00 (`festivalDayOf`, `festivalDayStr`).
- **Show-interval**: `showIntervalMs` / `_showIv`; welke shows mogen tellen: `showAllowed(s, 'list' | 'live', isPublic)`; live en volgende: `pickLiveShow`, `pickNextShow`, `curShow`, `nxtShow`.
- **Zomer-/wintertijd**: een tijd die twee keer voorkomt is de eerste; een tijd die niet bestaat schuift een uur op.
- **Handmatige timer**: één model van deadline plus gepauzeerde resttijd (`mtRemaining`, `mtToggle`, `mtAdjust`).

## Auth flow

1. Bij het inloggen gaat een directe REST-call naar `/auth/v1/token`. De sessie wordt bewaard in `st_auth_v1` (access + refresh token). Elke REST-call gebruikt dat token (`_jwt()`), anders de anon-key.
2. **`st_auth_v1` blijft synchroon met supabase-js**: een listener op `TOKEN_REFRESHED` / `SIGNED_IN` / `USER_UPDATED` schrijft het nieuwe token bij, en alleen vooruit (een ouder token overschrijft nooit een nieuwer). Bij een 401 ververst `_refreshAuthToken()` één keer en wordt de call herhaald.
3. **Opstarten** ("auth init v2", lineair): geen opgeslagen sessie → loginscherm. Wel een sessie → `/auth/v1/user` controleren, zo nodig verversen. Weigert de server het token, dan wordt het gewist. Is de server **onbereikbaar** (geen netwerk, timeout, 5xx), dan blijft de login staan en start de app offline vanuit de cache; bij `online` wordt het token ververst en de data opnieuw geladen.
4. **Reset- en uitnodigingslinks**: de e-mails linken via Supabase terug met de sessie in de hash (`#access_token=…&type=recovery|invite`). De app verwerkt die zelf (supa draait met `detectSessionInUrl:false`), haalt de tokens direct uit de adresbalk en opent het formulier voor een nieuw wachtwoord. Verlopen of gebruikte links geven een leesbare melding.
5. Minimale wachtwoordlengte is overal 8 (`PW_MIN`). Uitloggen meldt de sessie eerst bij de server af (zodat het refresh-token ongeldig wordt) en wist daarna de lokale tokens.

## Lokaal draaien

Geen build step. Serveer de map en open `/app.html`:

```bash
python3 .devserver.py          # http://localhost:5500/app (doet ook de /app-rewrite)
# of
python3 -m http.server 8000    # http://localhost:8000/app.html
```

Let op: `SUPA_URL` en `SUPA_KEY` staan hardcoded in `app.html`. Een lokaal geserveerde app praat dus met de **productie-Supabase**. Inloggen en opslaan raakt echte data. Gebruik voor ontwikkelwerk het testharnas, dat alles mockt.

## Tests

Playwright, volledig offline. Elk verzoek naar een niet-localhost-adres wordt gemockt of afgebroken, en een afgebroken verzoek laat de test falen. Details staan in `tests/README.md`; de dekking per functie in `tests/INVENTARIS.md`.

```bash
npm ci
npx playwright install chromium webkit   # eenmalig per machine
npm test                                 # alles: smoke, unit, regressie en booth, in chromium + webkit
npm run test:booth                       # alleen de Stage View-pixelvergelijking
npm run test:node                        # node-scripts tests/unit/*.test.js (merge, save-queue)
ST_PORT=5611 ST_BROWSERS=chromium npx playwright test tests/regression   # deelset, eigen poort
```

**Booth-baseline**: de Stage View-screenshots komen uit commit `845eb0d` en worden pixel-exact vergeleken. Een verschil betekent dat het boothscreen veranderd is, en dat mag niet. **Genereer de baseline nooit opnieuw (`npm run test:update-baseline`) om een verschil weg te werken.** Zoek de oorzaak en herstel die.

## Deployen

Vercel deployt `main` automatisch. Er gaat niets rechtstreeks naar `main`: werk op een branch, Thijs mergt en deployt.

- **Verhoog `SW_VERSION` in `sw.js` bij elke deploy** die `app.html`, `vendor/`, `fonts/` of de iconen wijzigt. Dan installeert de browser de nieuwe worker, ruimt hij de oude caches op en zien open bedieningsschermen "New version available". Deellinks herladen alleen als het tabblad verborgen is, nooit midden in een show in beeld.
- **Backendmigraties**: alleen in de volgorde van `docs/MIGRATIES.md`, stap voor stap in de Supabase SQL-editor, met backup en rollback bij de hand en nooit tijdens een live show. **Nooit `supabase db push`** (de bestandsnamen staan niet in uitvoeringsvolgorde en sommige bestanden bestaan uit delen die los moeten draaien). Geen enkele migratie in de repo is op productie toegepast.
- **Edge functions**: `send-push` deployen volgens `supabase/functions/README.md` (eerst de OneSignal-key roteren).
- De CSP in `vercel.json` staat op report-only.

## Caveats

- **Foto's staan in de JSONB-rij** als base64 tot stap 16 van `docs/MIGRATIES.md` is uitgevoerd. Ze worden client-side verkleind (artiestfoto's naar max. 900 px, JPEG 82%; logo's naar max. 600 px), maar een project met veel foto's blijft een grote blob, en elke save en elke deellink-poll draagt die mee. Daarna komen ze in de publieke bucket `project-media`: wie een foto-URL heeft, kan die foto zonder inloggen openen (de URL is niet te raden en er is geen anonieme lijst). Zet daar dus niets vertrouwelijks in.
- **Resterend race-venster (tot stap 6)**: zonder migratie `project_versioning` is lezen, samenvoegen en schrijven niet atomair. Een schrijfactie van een ander apparaat die in de ~100 ms tussen onze GET en PATCH landt, wordt dan nog overschreven. De app gebruikt `save_project` vanzelf zodra de migratie is toegepast, en dan is het venster dicht.
- **Deellinks zijn bescherming-door-kennis van de `pid`**: wie de URL heeft, kan meekijken (en bij check-in aankomsten wijzigen). Er zijn nog geen intrekbare tokens per link. Gebruik ze niet voor echt vertrouwelijke projecten.
- **RLS en kolomrechten** staan klaar in de migraties, maar zijn pas actief als Thijs ze uitvoert. Tot die tijd hangt de afscherming van de backend af van de huidige productie-instellingen.
