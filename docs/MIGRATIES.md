# Migraties: draaiboek

Dit draaiboek geldt voor BOUWPLAN §S, §4.5 en het edge-function-deel van §4.6.

**Status:** geen enkele migratie hieronder is op productie toegepast. Thijs voert ze zelf uit, stap voor stap, in de Supabase SQL-editor.

Elk SQL-bestand heeft bovenaan een kop met:

- het doel;
- de voorwaarden;
- de volgorde;
- verificatiequeries;
- een `ROLLBACK`-blok.

Dit document zet alles in één volgorde.


> **STAP 0, URGENT: UITGEVOERD op 13-10-2026 door Thijs via de SQL-editor. Tabelcheck: anon_insert/update/delete = false voor beide tabellen. Kolomcheck: 0 rijen.**
>
> Bestand: `supabase/migrations/20261013080000_urgent_anon_write_lockdown.sql`.
> Vandaag kan iedereen met de publieke anon-key alle gebruikers en workspaces verwijderen of rollen aanpassen.
> Deze migratie trekt alleen anon-schrijfrechten op `app_users` en `companies` in. De live-app schrijft die tabellen nooit als anon, en `projects` blijft ongemoeid.
> Lokaal getest: na de migratie geeft `delete` als anon "permission denied". Rollback staat in het bestand.


> **BLOKKADE vóór `rls_enable` en share-link PHASE B (13-10-2026):** de iPad-app **Stagetimer Booth** (`nl.stagetimer.booth`) haalt projectdata op een nog onbekende manier op.
> Leest hij `projects` rechtstreeks met de anon-key, dan breekt `rls_enable` elk iPad-boothscherm.
> Eerst vaststellen, via de broncode of een netwerk-trace van de app (bijvoorbeeld met Proxyman), welke endpoints en welke velden hij gebruikt. Pas daarna deze stappen uitvoeren.

## Spelregels

1. **Nooit `supabase db push`.** De bestandsnamen staan niet in de volgorde waarin ze moeten draaien, en de hotfix bestaat uit delen die je los moet uitvoeren. `db push` zou alles in één keer toepassen.
2. **Eén stap per keer**, op een rustig moment. **Nooit tijdens een live show.** Kijk eerst in de projecten of er vandaag of vanavond een festival draait.
3. **Maak vóór elke stap een backup.** Gebruik Dashboard → Database → Backups, of `pg_dump` van `projects`, `app_users` en `companies`. Zet PITR aan als dat kan.
4. Houd het `ROLLBACK`-blok van de stap open in een tweede tabblad van de SQL-editor.
5. De voorwaarden worden gecontroleerd. Bijna elk bestand begint met een `do $$ … raise exception …`-blok dat afbreekt als een eerdere stap ontbreekt. Een foutmelding met "apply X first" betekent dus: verkeerde volgorde, er is niets veranderd.
6. De bestanden zijn **idempotent**: twee keer draaien kan geen kwaad. Uitzonderingen staan bij de stap.
7. Na elke stap: zet in `#ops` of in een notitie welke stap op welk tijdstip is gedaan.
8. **Functierechten.** Supabase geeft anon en authenticated standaard direct EXECUTE op elke nieuwe functie in `public`. `revoke ... from public` haalt dat dus niet weg. Elk bestand trekt EXECUTE daarom expliciet in bij anon en authenticated en geeft het alleen terug voor wat de app echt aanroept. Na alle stappen mag anon alleen nog `get_shared_project` (beide varianten), `set_show_arrived` en `get_shared_project_version` uitvoeren. Ingelogde gebruikers krijgen daarnaast de admin-, save- en herstel-RPC's, plus `caller_role` en `caller_company_id` (die gebruiken de RLS-policies). Controle (de query staat ook in de kop van `rls_prep`):
   ```sql
   select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and has_function_privilege('anon', p.oid, 'execute') order by 1;
   ```
9. De CLI-migratiehistorie (`supabase_migrations.schema_migrations`) loopt hierdoor niet gelijk met de map. Dat is bewust. Voer **niet** `supabase migration repair` uit zonder overleg.

## De bestanden

| Bestand | Inhoud | Toestand |
|---|---|---|
| `20261013080000_urgent_anon_write_lockdown.sql` | anon mag `app_users` en `companies` niet meer schrijven of verwijderen (stap 0, urgent) | nieuw |
| `20261013090000_hotfix_setup_token.sql` | `setup_pending`-kolom (deel 1), kolomrechten en realtime-kolomlijst op companies, met een check op de replica identity (deel 2), verificatie (deel 3) | herzien: kop met volgorde |
| `20260819111158_rls_prep.sql` | helpers voor de beller (`caller_role()` geeft nooit NULL), guards als allowlist, `admin_set_user_role`, `admin_delete_company`, `role NOT NULL DEFAULT 'operator'` en een unieke `lower(email)` | herschreven |
| `20261013100000_share_link_rpcs.sql` | `get_shared_project(p_id)` (legacy) en `get_shared_project(p_id, p_mode)` (gestript per modus), `set_show_arrived` op veldniveau | nieuw; de RPC's kwamen uit rls_prep |
| `20260819111228_rls_enable.sql` | RLS aan, policies, kolom-allowlists, anon zonder tabelrechten | herschreven |
| `20261013110000_project_versioning.sql` | `projects.version`, `save_project`, `patch_show`, `get_shared_project_version` | nieuw |
| `20261013120000_project_history_soft_delete.sql` | `project_versions`, soft delete en de RPC's voor herstel | nieuw |
| `20261013130000_plan_enforcement.sql` | trigger die het abonnement en de stage-limiet afdwingt; standaard **log**-modus | nieuw |
| `20261013140000_signup_tokens.sql` | §S.5: tokens gehasht, met verloopdatum, eenmalig en met lockout (fase A); fase B als commentaar | nieuw |
| `20261013150000_photo_storage.sql` | Storage-bucket `project-media` (publiek lezen, max. 1 MB, jpeg/png/webp), `can_edit_project_media`, policies op `storage.objects` | nieuw |
| `supabase/functions/send-push/` | OneSignal via de server | nieuw, alleen broncode |

## Volgorde

`app vX` verwijst naar de app-versie die live moet staan. "improve" betekent `app.html` van branch `improve/2026-10-13` of later.

### Stap 0: vaststellen (alleen lezen)

- Voer de S.1-queries uit BOUWPLAN uit: of RLS aan staat, welke grants er zijn, het aantal open tokens en de kolomlijst van companies.
- Zet de backend in git: `supabase db pull` en `supabase functions download …`. Dit staat uitgewerkt in `supabase/functions/README.md`. **Dit is de belangrijkste openstaande actie.** Zonder de echte schema- en functiebroncode blijven de punten onder "Niet verifieerbaar" open.
- Controleer met deze query of er dubbele e-mailadressen zijn. Stap 2 breekt anders af:
  ```sql
  select lower(email), count(*), string_agg(id::text, ', ')
    from public.app_users group by 1 having count(*) > 1;
  ```
- Controleer of `app_users.role` en `companies.id` tekst zijn. De migraties nemen dat aan:
  ```sql
  select table_name, column_name, data_type from information_schema.columns
   where table_schema='public' and table_name in ('projects','app_users','companies')
   order by table_name, ordinal_position;
  ```
- Kijk welke replica identity `companies` heeft en of de tabel in de realtime-publicatie zit. Stap 5 hangt daarvan af:
  ```sql
  select relreplident from pg_class where oid = 'public.companies'::regclass;   -- d, f of i
  select attnames from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'companies';
  ```

### Stap 1: hotfix deel 1, `setup_pending` (app: elke versie)

- **Wat:** voer het blok `PART 1` van `20261013090000_hotfix_setup_token.sql` uit.
- **Wanneer:** altijd. Er komt alleen een kolom bij. Het herschrijven van de tabel duurt bij companies een fractie van een seconde.
- **Controle:** `select count(*) filter (where setup_pending) from companies;` geeft hetzelfde getal als de S.1-telling.
- **Rollback:** `alter table public.companies drop column if exists setup_pending;`

### Stap 2: `rls_prep` (app: elke versie)

- **Wat:** voer `20260819111158_rls_prep.sql` in zijn geheel uit.
- **Voorwaarde:** edge functions die `app_users` of `companies` **schrijven** doen dat met de **service_role-key**. Kijk dat na in de broncode uit stap 0. Een functie die met de anon-key of het JWT van de gebruiker schrijft, wordt vanaf nu geweigerd.
- **Wat er verandert:** RLS staat nog uit. Wel kunnen clients die geen admin zijn geen rollen, e-mailadressen, `company_id` of billingkolommen meer wijzigen. Ze kunnen ook geen rijen meer toevoegen aan `app_users` of `companies`. Zo'n rij invoegen kan nu nog met de anon-key: dat is het "super_admin-rij invoegen"-lek. Lege rollen worden `operator`. Een dubbel e-mailadres invoegen faalt voortaan.
- **Timing:** een korte lock op `app_users`. Niet tijdens een show.
- **Controle:** zie de kop van het bestand. Log daarna in de app in als operator, hernoem jezelf en controleer dat het werkt. Laat een admin een rol wijzigen. Met de huidige app gaat dat via een directe PATCH, en dat werkt nog.
- **Rollback:** zie het `ROLLBACK`-blok. Dat verwijdert de triggers en RPC's, de index en NOT NULL.

### Stap 3: `share_link_rpcs` (app: elke versie)

- **Wat:** voer `20261013100000_share_link_rpcs.sql` uit, **zonder** het blok PHASE B onderaan. Dat blok is commentaar en draait dus niet mee.
- **Waarom nu:** de improve-app laadt **elke** deellink via `get_shared_project`. Zonder deze stap toont elke publieke weergave "Project not found".
- **Timing:** altijd. Het gaat alleen om `CREATE OR REPLACE FUNCTION`.
- **Controle:**
  ```sql
  select public.get_shared_project('<pid>') ->> 'name';
  select octet_length(public.get_shared_project('<pid>')::text) volledig,
         octet_length(public.get_shared_project('<pid>','stage')::text) stage;
  ```
- **Rollback:** `drop function public.get_shared_project(text, text);`. De andere twee functies zijn achterwaarts compatibel en mogen blijven.

**Veldmatrix van `get_shared_project(p_id, p_mode)`.** Gecontroleerd tegen elke publieke renderer in `app.html`: `renderSV` (met `_svMode`, cue en blackout), `renderBS`, `renderFOH`, `renderTL`, `renderOV`, `renderWV`/`tickWV`, `renderCI`, `renderSM`, `renderDres` en `renderLNG`. Elke modus houdt wat hij toont. De migratie hoefde niet te veranderen.

| Veld in `data` | stage | backstage | foh | timeline | overview | wall | checkin | stagemanager | dressing | lounge |
|---|---|---|---|---|---|---|---|---|---|---|
| `fohNotes` | - | - | ja | - | - | - | - | - | - | - |
| `shows[].note` | - | ja | - | - | - | - | - | - | - | - |
| `shows[].crew` | - | - | ja | - | - | - | - | - | - | - |
| `shows[].photo` | - | - | - | - | - | - | - | - | - | ja |
| `memberIds` | - | - | - | - | - | - | - | - | - | - |
| `logo` | - | ja | ja | - | - | - | - | - | ja | ja |
| `shows[].rider` | - | - | - | - | - | - | ja | ja | - | - |
| `shows[].bgImage` | - | - | - | - | - | - | - | - | ja | - |
| `shows[].arrived` (+ `arrivedAt`) | ja | ja | ja | ja | ja | ja | ja | ja | ja | - |
| `shows[].bgVideo` | ja | ja | ja | ja | ja | ja | ja | ja | ja | - |

- `-` betekent gestript: `fohNotes` wordt `{}`, `memberIds` wordt `[]` en de rest verdwijnt. `company_id` is altijd `null`.
- Alles anders blijft in elke modus staan. Het gaat om stages, days, de tijden en vlaggen van shows, `genre`, `booth`, `type`, `priority`, `arrived`, `activeStage`/`activeDay`, `timerMode`, `svModes`, `cue`, `blackout` en `branding` (drie booleans: waar het klantlogo staat). Het tijdmodel, de overlays en de schermen hebben die nodig, en er zit niets persoonlijks of groots in.
- `shows[].rider` (`{drinks, tech}`, vrije tekst, max. 2000 tekens per veld) is de rider van de artiest: drank/hospitality en technische eisen. Alleen de check-in-balie (`checkin`) en de stagemanager (`stagemanager`, nieuwe modus: `?mode=stagemanager&pid=..&sid=..`) krijgen hem; elke andere modus niet, ook stage, foh en backstage niet. `set_show_arrived` geeft de checkin-weergave terug en houdt de rider dus ook. Een onbekende modus valt op de strengste set (zonder rider). Let op: een database met een oudere versie van dit bestand kent `rider` niet en stript het dus nergens, dan krijgt elke modus de rider mee. Is stap 3 al eerder uitgevoerd, voer hem dan opnieuw uit voordat de rider-feature live gaat (feature/rider-data, 13-10-2026); het is alleen `CREATE OR REPLACE`, dus veilig, ook tijdens een show.
- De Stage View leest geen van de zeven gestripte velden. Foto's gebruikt alleen het operatorpaneel, `memberIds` alleen de crewkiezer en push. `logo` toont alleen Backstage en FOH (klantlogo linksboven, branch `feature/project-logo`, 13-10-2026); daarom houden `backstage` en `foh` (en de legacy/PHASE B-variant) het veld, alle andere modi niet. Wordt deze stap uitgevoerd met een oudere versie van het bestand (logo overal gestript), dan tonen de deellinks gewoon geen logo; er breekt niets. Een base64-logo (zolang stap 16 niet is uitgevoerd) reist mee in elke backstage/foh-poll; na stap 16 is het een URL van ~120 bytes.
- `dressing` (kleedkamerscherm, `?mode=dressing&pid=..&shid=<show-id>`, branch `dressing/web`, 19-10-2026) toont de countdown van één artiest over een achtergrondvideo (`shows[].bgVideo`, een https-link naar een eigen videobestand van de klant, max. 2000 tekens, nergens gestript) of -foto (`shows[].bgImage`), en na de show een bedankscherm met het klantlogo. Daarom houdt `dressing` het `logo` (los van de branding-schakelaars) en als enige modus `shows[].bgImage`: zolang stap 16 niet is uitgevoerd kan dat een base64-foto van een paar honderd kB zijn, en die hoort niet in elke booth-poll. Wordt stap 3 uitgevoerd met een oudere versie van dit bestand, dan valt `dressing` op `strict`: geen logo en geen achtergrondfoto, het scherm toont dan alleen tekst en de video; er breekt niets. De video zelf staat nooit in de blob en niet in de bucket van stap 16 (alleen afbeeldingen): het is een link naar een bestand dat de klant zelf host. Was stap 3 al eerder uitgevoerd, voer hem dan opnieuw uit voordat het kleedkamerscherm live gaat (alleen `CREATE OR REPLACE`, veilig tijdens een show). Controle:
  ```sql
  select (public.get_shared_project('<pid>','stage') -> 'data') ? 'logo',
         (public.get_shared_project('<pid>','dressing') -> 'data') ? 'logo',
         jsonb_path_exists(public.get_shared_project('<pid>','stage') -> 'data', '$.shows[*].bgImage'),
         jsonb_path_exists(public.get_shared_project('<pid>','dressing') -> 'data', '$.shows[*].bgImage');
  -- f, t, f, t (t alleen als het project een logo / een show een achtergrondfoto heeft)
  ```
- `lounge` (artist lounge, `?mode=lounge&pid=..&sid=<stage-id>`, branch `feature/artist-lounge`, 23-10-2026) is het tv-scherm in de artiestenlounge van één stage: wie nu op het podium staat (met foto, grote witte countdown en tijdlijn van de set) en wie er daarna komen, met het klantlogo (`branding.logoLounge`, standaard aan) en een accentkleur (`branding.accent`, een hexkleur uit het Project logo-venster). Het is de **enige** modus die `shows[].photo` (de artiestenfoto) krijgt: zolang stap 16 niet is uitgevoerd kan dat per act een base64-foto van een paar honderd kB zijn, dus geen ander scherm pollt ze. Omdat het alleen krijgt wat het toont, mist het als enige modus ook `arrived`/`arrivedAt` en `bgVideo`; alle andere modi houden die zoals voorheen (een onbekende modus, `strict`, verliest ze ook). De legacy/PHASE B-set krijgt géén foto's: de lounge bestaat alleen in app-versies die `p_mode` meesturen, en zonder de 2-argumentvariant geeft de 1-argumentvariant nog de volledige blob. **Stap 3 moet opnieuw worden uitgevoerd voordat de lounge live gaat** (alleen `CREATE OR REPLACE`, veilig tijdens een show). Tot dan: zonder 2-argumentvariant krijgt de lounge via de 1-argumentvariant alles en werkt hij volledig; met een oudere versie van dit bestand valt `lounge` op `strict` en toont het scherm initialen in plaats van foto's en geen logo; er breekt niets. Controle:
  ```sql
  select jsonb_path_exists(public.get_shared_project('<pid>','backstage') -> 'data', '$.shows[*].photo'),
         jsonb_path_exists(public.get_shared_project('<pid>','lounge') -> 'data', '$.shows[*].photo'),
         (public.get_shared_project('<pid>','lounge') -> 'data') ? 'logo',
         jsonb_path_exists(public.get_shared_project('<pid>','lounge') -> 'data', '$.shows[*].arrived');
  -- f, t, t, f (t alleen als een show een foto / het project een logo heeft)
  ```
- De matrix staat in de kop van het SQL-bestand. De JS-tweeling `tests/support/share-modes.js` voedt de mock-backend. `share-mode.spec.js` controleert dat de twee gelijk zijn.
- Lokaal gevalideerd op `supabase/postgres:17.6.1.167`: het bestand twee keer gedraaid, en de SQL-uitvoer per modus is gelijk aan de JS-strip. Dat gold ook voor een onbekende modus, de legacy-variant en de PHASE B-strip. Na de logo-wijziging (`keep_logo`) op 13-10-2026 opnieuw gevalideerd: twee keer gedraaid, alle negen modi (inclusief `strict` en `legacy`) gelijk aan de JS-strip, `logo` alleen in backstage, foh en legacy. Na de rider-wijziging (`keep_rider`, modus `stagemanager`) op 13-10-2026 opnieuw gevalideerd: twee keer gedraaid, alle acht modi plus `strict`, `legacy`, twee onbekende modi, de 1-argumentvariant en het antwoord van `set_show_arrived` gelijk aan de JS-strip; `rider` alleen in checkin, stagemanager, legacy en het `set_show_arrived`-antwoord; de controlequery uit de kop geeft `f, t, t`. Na de lounge-wijziging (`keep_photo`, `keep_arrived`, `keep_video`, modus `lounge`) op 23-10-2026 opnieuw gevalideerd: twee keer gedraaid, alle tien modi plus `strict`, een onbekende modus, `legacy`, de 1-argumentvariant (volledige blob) en het antwoord van `set_show_arrived` gelijk aan de JS-strip; de lounge-controlequery geeft `f, t, t, f`.

### Stap 4: app deployen (improve/2026-10-13)

- **Vereist:** stap 1 tot en met 3.
- Test daarna:
  - elke deellinkmodus (stage, backstage, foh, timeline, overview, wall, checkin, stagemanager);
  - check-in aan en uit;
  - inloggen;
  - opslaan;
  - het adminoverzicht met de "Awaiting activation"-badge.
- Wacht tot open tabbladen herladen zijn. `app.html` is no-store, dus het herladen van de pagina is genoeg. Monitors met een oude versie blijven tot dan bij `select=*`.

### Stap 5: hotfix deel 2, kolomrechten op companies (app: improve)

- **Wat:** voer de blokken `PART 2` en `PART 3` van de hotfix uit. Selecteer alleen die regels in de SQL-editor.
- **Voorwaarde:** stap 4 staat live en de tabbladen zijn herladen.
- **Timing:** **niet tijdens een show.** Een oude app met `select=*` op companies krijgt 403.
- **Anon-schrijfrechten:** PART 2 herhaalt de revoke van stap 0 (anon mag `app_users` en `companies` niet schrijven of verwijderen). Is stap 0 al gedaan, dan verandert dat niets.
- **Replica identity (belangrijk):** PART 2 haalt `setup_token` uit de realtime-publicatie met een kolomlijst. Staat `companies` op `REPLICA IDENTITY FULL` (stap 0 laat het zien als `f`), dan zou die kolomlijst **elke** UPDATE en DELETE op companies laten falen: de Stripe-webhook, finalize-signup, hernoemen, `admin_delete_company`. Daarom:
  - bij `d` of `i` wordt de kolomlijst gewoon gezet;
  - bij `f` slaat PART 2 de kolomlijst over en meldt dat met een NOTICE. `setup_token` blijft dan beschermd door de kolomrechten. Dat is de standaard en altijd veilig;
  - wil je bij `f` toch de kolomlijst, zet dan als eerste regel van het script `select set_config('stagetimer.companies_replica_identity_default', 'on', false);`. PART 2 zet companies dan op `REPLICA IDENTITY DEFAULT`. Gevolg: realtime-events op companies bevatten in `payload.old` alleen nog de primaire sleutel. De app gebruikt alleen `payload.new`. Controleer eerst of iets anders (database-webhooks, replicatie naar BI) de oude rij nodig heeft.
- **Controle:**
  - de verwachte uitkomsten staan in PART 3, ook de combinatie replica identity / kolomlijst (nooit `f` samen met een kolomlijst);
  - `begin; update public.companies set name = name where id = (select id from public.companies limit 1); rollback;` moet lukken;
  - met de anon-key moet `curl` 401 of 403 geven;
  - **realtime met een echte client.** Supabase Realtime leest de WAL zelf (wal2json) en houdt zich mogelijk niet aan de kolomlijst van de publicatie. Wat het wel toepast, zijn de kolomrechten en RLS van de abonnee. Test dat: log in de app in, voer in de browserconsole `supa.channel('t').on('postgres_changes',{event:'UPDATE',schema:'public',table:'companies'},p=>console.log(Object.keys(p.new))).subscribe()` uit, hernoem de workspace vanuit een tweede tabblad (als company_admin) en controleer dat `setup_token` **niet** in de gelogde sleutels staat.
- **Rollback:** zie de kop van de hotfix. Dit geldt alleen zolang `rls_enable` nog niet is toegepast. De rollback geeft anon geen schrijfrechten terug (dat is stap 0).
- **Volgorde:** `rls_enable` (stap 10) zet precies dezelfde rechten op companies. Stap 5 en stap 10 mogen dus in willekeurige volgorde. De tweede is voor companies een no-op. Doe stap 5 toch zo vroeg mogelijk: dit is de spoedfix.

### Stap 6: `project_versioning` (app: elke versie)

- **Wat:** voer `20261013110000_project_versioning.sql` uit.
- **Effect:** elke wijziging aan een project verhoogt `version`. Een app vanaf branch `feature/atomic-save-soft-delete` ziet de kolom en slaat vanaf dan op via `save_project` (zie stap 13); een oudere app merkt er niets van. `patch_show` en `get_shared_project_version` staan klaar maar worden nog niet gebruikt.
- **Timing:** een korte lock op `projects`. Niet tijdens een show.
- **Rollback:** zie de kop van het bestand.

### Stap 7: `project_history_soft_delete` (app: elke versie)

- **Wat:** voer `20261013120000_project_history_soft_delete.sql` uit.
- **Effect:** vanaf nu worden momentopnamen bewaard, maximaal één per vijf minuten per project. Daarnaast komt er altijd een momentopname bij het verwijderen van shows of stages en bij het verwijderen van een project. Een project dat de huidige app hard verwijdert, is nog 30 dagen te herstellen:
  ```sql
  -- in de SQL-editor (als machine; bekijk eerst wat er is)
  select * from public.project_versions where project_id = '<pid>' order by id desc;
  -- herstellen kan als ingelogde gebruiker via rpc('restore_project', {p_id}),
  -- of in de SQL-editor met de JWT-claims van een admin:
  begin;
    select set_config('request.jwt.claims', '{"role":"authenticated","email":"<admin e-mail>"}', true);
    select public.restore_project('<pid>');
  commit;
  ```
- **`deleted_at` is van de server:** een trigger (`projects_lifecycle_guard`) weigert elke client-wijziging van `deleted_at` en `deleted_by`, ook met de anon-key vóór stap 10. Alleen `soft_delete_project`, `restore_project`, `restore_project_version` en machine-aanroepen (SQL-editor, service_role, cron) mogen dat. Zo kan niemand een project "30 dagen geleden verwijderd" maken zodat de nachtelijke purge het hard verwijdert. Een client die een project aanmaakt, begint altijd op `version` 0.
- **Herstel na de purge:** `restore_project` gebruikt de nieuwste momentopname van welke soort ook. Na een purge is dat de momentopname van het moment van weggooien, tot die na 30 dagen wordt opgeruimd.
- **pg_cron:** is die extensie actief, dan wordt het opruimen elke nacht ingepland. Anders verschijnt er een NOTICE. Zet pg_cron dan aan (Dashboard → Database → Extensions) en draai het bestand opnieuw.
- **Controle na een week:** `select pg_size_pretty(pg_total_relation_size('public.project_versions'));`
- **Rollback:** zie de kop van het bestand. Exporteer de historie eerst.

### Stap 8: `plan_enforcement` in log-modus (app: improve)

- **Wat:** voer `20261013130000_plan_enforcement.sql` uit. De modus staat dan op `log`: overtredingen worden alleen vastgelegd en niets wordt geblokkeerd.
- **Voorwaarde:** de improve-app staat live (stap 4). Die stuurt het JWT van de gebruiker mee bij het opslaan. De oude app gebruikt de anon-key, en dan ziet de server niet wie er opslaat (admin/super_admin).
- **Beslissing B2** is verwerkt: `trialing` telt als actief.
- **Controle:** vergelijk de `eff_limit` per workspace met het adminscherm. Gebruik daarvoor de query in de kop (in de SQL-editor). `company_stage_limit` en `company_can_create_projects` zijn bewust **niet** aanroepbaar voor anon of ingelogde gebruikers: ze accepteren elk company-id en zouden de abonnementsstatus van andere workspaces verraden. De app gebruikt ze niet.
- **Rollback:** `update public.backend_settings set value='off' where key='plan_enforcement';`. Dat werkt direct en zonder lock.

### Stap 9: app-release "RLS-ready"

Er moet een app-versie live staan met:

- **1.1h:** `onAuthStateChange` (`TOKEN_REFRESHED`, `SIGNED_IN`) ververst `st_auth_v1`. Bij een 401 één keer verversen en opnieuw proberen. **Zonder dit faalt na stap 10 elke save ongeveer een uur na het inloggen.**
- `changeUserRole` gebruikt `rpc('admin_set_user_role', {p_user_id, p_role})`.
- `delCompany` gebruikt `rpc('admin_delete_company', {p_company_id})` in plaats van drie losse requests.
- In `PUBLIC_MODE` doet `save()`/`_pushProject` niets, behalve de check-in-RPC.
- Publieke weergaven roepen `get_shared_project` aan met `{p_id, p_mode: PUBLIC_MODE}`. Dat geldt voor de early fetch in `<head>`, voor `loadPublicView` en voor de zeven polls.

> **GEDAAN in de app (branch `feature/share-link-p-mode`, 13 oktober 2026; nog niet gedeployed).** De early fetch in `<head>`, `loadPublicView` en de poll van elke deellinkmodus roepen `get_shared_project` aan met `{p_id, p_mode: PUBLIC_MODE}`. Terugvalketen:
>
> 1. `get_shared_project(p_id, p_mode)`: alleen de velden die de modus toont;
> 2. bestaat die niet (`404` of `PGRST202`): `get_shared_project(p_id)`, de volledige blob;
> 3. bestaat die ook niet: de rij direct uit `projects` lezen (zoals vroeger).
>
> De variant die antwoordt, onthoudt de pagina voor de rest van de sessie. Bij `401`, `5xx` of een timeout valt de app **nooit** terug: hij houdt de laatste data en telt een mislukte sync (`window.__stLastSyncOk` blijft staan).
>
> Bestaat `get_shared_project_version` (stap 6), dan pollt de view elke seconde alleen dat getal en haalt het project pas op als de versie verandert, plus minstens één keer per minuut. Zonder die functie pollt hij het hele project, zoals voorheen.
>
> **Bewijs dat de Stage View gelijk blijft:** `npm run test:booth` draait elke publieke Stage View-toestand twee keer tegen dezelfde baseline (gemaakt van 845eb0d, niet opnieuw gegenereerd): één keer met de legacy-feed (volledige blob) en één keer met de gestripte feed plus versiepoll. Beide zijn pixel-identiek. `tests/regression/share-mode.spec.js` laat elke modus met beide feeds renderen en vergelijkt de DOM.
>
> Stap 10 hangt hier niet van af. **Stap 11 (PHASE B) blijft geblokkeerd** door de iPad-app, zie daar.

Zie "App-wijzigingen" hieronder.

### Stap 10: `rls_enable` (app: stap 9)

- **Wat:** voer `20260819111228_rls_enable.sql` uit.
- **Voorwaarden:** stap 2, 3 en 1 zijn gecontroleerd. Stap 9 staat live en de tabbladen zijn herladen.
- **Timing:** een rustige doordeweekse ochtend, **nooit** met een show binnen 24 uur. Houd de rollback open.
- **Projects-kolommen:** ingelogde gebruikers mogen op `projects` alleen nog `data`, `name` en `company_id` wijzigen (wat de app PATCHt). `version`, `deleted_at` en `deleted_by` lopen via de RPC's.
- **Realtime:** blok 4c doet dezelfde replica-identitycheck als stap 5. Zie daar wat er bij `f` gebeurt.
- **Controle:**
  - de queries in de kop;
  - de realtime-test met een echte client uit stap 5, als die nog niet gedaan is;
  - in de app als operator, company_admin, admin en super_admin: project openen, opslaan, jezelf hernoemen, een rol wijzigen (admin), een workspace verwijderen (super_admin, met een testworkspace);
  - alle deellinks openen en een check-in doen;
  - realtime tussen twee ingelogde tabbladen.
- **Rollback:** zie de kop. RLS gaat dan uit en de tabelrechten komen terug. Companies blijft wel beperkt, en anon krijgt op `app_users` alleen leesrecht terug (stap 0 blijft staan).

### Stap 11: `share_link_rpcs` PHASE B (een paar dagen na stap 9)

- **NIET UITVOEREN: GEBLOKKEERD.** De app-kant is klaar (branch `feature/share-link-p-mode`, zie stap 9): `p_mode` wordt overal meegestuurd met de terugvalketen 2 argumenten → 1 argument → tabel (`404`/`PGRST202` → volgende). De booth-suite bewijst dat de Stage View met gestripte data pixel-identiek is. Uitvoeren mag pas als aan álle voorwaarden is voldaan:
  1. die release staat live;
  2. hij staat er een paar dagen, zodat gecachte tabbladen herladen zijn;
  3. **de blokkade bovenaan is opgeheven.** De iPad-app **Stagetimer Booth** (`nl.stagetimer.booth`) haalt projectdata op een nog onbekende manier op. Roept hij `get_shared_project(p_id)` aan en heeft hij foto's of `memberIds` nodig, dan breekt PHASE B elk iPad-boothscherm. Leest hij `projects` direct, dan breekt `rls_enable` hem. Stel eerst vast welke endpoints en velden hij gebruikt (broncode of netwerk-trace).
- Voer het commentaarblok onderaan `20261013100000_share_link_rpcs.sql` uit. De legacy-aanroep met één argument geeft dan geen foto's, `memberIds` of `company_id` meer terug (het logo en de rider wel: Backstage en FOH tonen het logo, check-in en stagemanager de rider).
- **Rollback:** voer de LEGACY-definitie uit hetzelfde bestand opnieuw uit.

### Stap 12: `plan_enforcement` naar `enforce`

Dit kan als aan beide voorwaarden is voldaan:

- `plan_violations` laat een week lang geen terechte klanten zien;
- de app handelt HTTP 402 / `stage_limit_exceeded` af. Concreet: de afgewezen stage lokaal weghalen en de operator een melding tonen. Anders blijft elke volgende save van dat tabblad falen, ook tijdscorrecties tijdens een show.

```sql
update public.backend_settings set value='enforce', updated_at=now() where key='plan_enforcement';
```

**Rollback:** zet de waarde terug op `log`.

### Stap 13: app gebruikt versies, historie en soft delete (geen SQL)

**Gedaan in de app** (branch `feature/atomic-save-soft-delete`), met terugval. Dezelfde app werkt vóór en na stap 6 en 7; er is geen vlag en geen tweede release nodig:

- **Opslaan:** `_pushOnce` leest `version` mee met de verse rij en schrijft via `save_project` (compare-and-swap). Bij `{conflict:true}` wordt per show-id opnieuw samengevoegd met de teruggegeven serverrij en opnieuw verstuurd (maximaal 4 pogingen, daarna de gewone retry met backoff). `{error:'would_wipe'}` wordt afgehandeld als de wipe guard van de client: de serverversie blijft staan en de operator ziet *Not saved*. `p_force` gaat alleen mee als elke show of stage die leeg zou raken bewust is verwijderd (`_markIntentionalRemoval`). `{error:'deleted'}` haalt het project uit de lijst.
- **Terugval:** geeft de select op `version` een 42703, of bestaat `save_project` niet (404/PGRST202), dan blijft het die sessie bij GET + PATCH zoals nu.
- **Echo's:** realtime-berichten met `version <=` de eigen versie worden genegeerd. Het eigen `_rev` blijft daarnaast werken.
- **Verwijderen:** `deleteProject` gebruikt `soft_delete_project` als `list_deleted_projects` bestaat; anders de harde DELETE met de waarschuwing "cannot be undone". Lezen van projecten (`loadAPPRemote`, de verse rij bij opslaan en ophalen) filtert `deleted_at=is.null` zodra die kolom bestaat (42703 → zonder filter). Een realtime UPDATE met `deleted_at` geldt als verwijderd.
- **Dashboard:** sectie *Recently deleted* (alleen als de RPC bestaat en er iets in staat) met de verwijderdatum, wie het deed, de resterende dagen en *Restore* (`restore_project`). Voor company_admin en hoger een knop *Version history* per project (`list_project_versions`, `restore_project_version`, met bevestiging).
- **Nog niet gedaan:** edits van één show via `patch_show`. Pas de policy uit het commentaarblok onderaan het historiebestand pas toe als alle open tabbladen deze app-versie draaien.

### Stap 14: signup-tokens (§S.5)

1. Voer fase A van `20261013140000_signup_tokens.sql` uit. Dat is altijd veilig: niets leest de tokens nog.
2. Pas de edge functions aan. Pas dit kan als de broncode in git staat (stap 0):
   - `signup-checkout` gebruikt `issue_signup_token`;
   - `finalize-signup` gebruikt `consume_signup_token`, plus een limiet per IP.
3. Test een volledige signup op een testworkspace.
4. Voer fase B uit (commentaarblok). Die geeft binnen dezelfde transactie leesrecht op de opnieuw aangemaakte kolom `setup_pending` en zet hem in de realtime-kolomlijst als die er is. Zonder dat leesrecht faalt de companies-select van de app met "permission denied". Controleer daarna met de query onder het blok en open het adminoverzicht.

**Rollback** per fase staat in het bestand.

### Stap 15: `send-push` (los van de rest, na rls_prep)

Zie `supabase/functions/README.md`:

1. Roteer de OneSignal-key.
2. Zet de secrets.
3. Deploy de functie.
4. Test.

**De app is al omgezet** (branch `fix/logic-batch-2026-10-13`): `OS_REST_KEY` staat niet meer in `app.html` en `scheduleProjectPushes` stuurt alleen nog via `functions/v1/send-push`, met het JWT van de gebruiker. Er is geen vlag meer. Gevolg:

- **Tot `send-push` gedeployed is en de key geroteerd is, worden er geen crew-pushmeldingen verstuurd.** De functie antwoordt dan 404. De operator ziet één keer de melding "Push is not configured yet" en de app probeert het die sessie niet opnieuw.
- Zodra stap 1 tot en met 4 gedaan zijn, werkt het versturen weer, zonder nieuwe app-release.
- Tegelijk is de oude bug gerepareerd: de app las `s.endTime` en `show.stageId` (bestaan niet) en rekende vanaf middernacht van het toestel. Nu gebruikt hij het echte eindtijdstip van de show (`endsAt`, of datum + `end`, ook over middernacht) in festivaltijd, en `show.stage`. Afgelaste shows krijgen geen melding.

### Stap 16: `photo_storage`, foto's naar Storage (app: feature/photo-storage of later)

- **Wat:** voer `20261013150000_photo_storage.sql` uit.
- **Voorwaarden:**
  - stap 2 (`rls_prep`); het bestand controleert dat zelf;
  - Storage staat aan in het project (Dashboard → Storage). Het bestand breekt af als `storage.buckets` ontbreekt;
  - **de iPad-app Stagetimer Booth.** Na deze stap krijgen nieuwe foto's in `show.photo` een https-URL in plaats van een `data:`-URL. Leest die app `photo` als base64, dan toont hij voor die shows geen foto (of erger). Stel eerst vast hoe hij `photo` gebruikt, net als bij de RLS-blokkade bovenaan.
- **Timing:** altijd, ook tijdens een show. Er komt alleen een bucket met policies bij; bestaande rijen worden niet aangeraakt.
- **Wat er daarna gebeurt (app):**
  - een nieuwe artiestfoto of logo gaat na het verkleinen naar `project-media/<pid>/<random>.jpg`, met het JWT van de gebruiker. In de blob komt alleen de URL (~120 bytes in plaats van 30-150 kB per foto);
  - bestaande base64-foto's van het **open** project verhuizen op de achtergrond, drie per 20 seconden, met een gewone save. Foto's onder 2 kB blijven inline. Een project verhuist dus pas als iemand het opent;
  - zonder bucket (vóór deze stap), offline of bij een weigering blijft de app base64 opslaan, precies zoals nu. Na "Bucket not found" probeert een tabblad het tien minuten niet opnieuw;
  - deellinks uploaden nooit en tonen beide vormen; oude app-versies ook (het is gewoon een `<img src>`). Wel laat een oude app bij het weghalen van een foto het object staan (wees-object);
  - een vervangen of weggehaalde foto wordt na een geslaagde save uit de bucket verwijderd. Shows en projecten verwijderen laat de objecten staan, zodat herstellen uit `project_versions` blijft werken.
- **Publiek of gesigneerd:** gekozen is publiek lezen. Deellinks zijn anoniem en pollen dagenlang; gesigneerde URL's verlopen, vragen een extra endpoint en veranderen bij elke poll. De afweging staat in de kop van het bestand. Gevolg: wie een foto-URL heeft, kan de foto zonder inloggen openen tot het object weg is (en de CDN-cache, max. 30 dagen, verlopen is). Anoniem een lijst opvragen, uploaden of verwijderen kan niet.
- **Controle:** de queries in de kop. Voeg daarna in de app een foto toe aan een show, sla op en open de URL uit de blob in een privévenster. Meet na een paar dagen de blobgrootte met de query in de kop.
- **Rollback:** zie de kop. Nieuwe uploads stoppen = de insert- en update-policy weghalen; de app valt dan vanzelf terug op base64. De bucket zelf pas weghalen als geen project er nog naar verwijst (wees-query in de kop).
- **Lokaal getest (13-10-2026):** `supabase/postgres:17.6.1.167` met `storage-api` v1.72.1 in Docker (eigen netwerk, niets van productie), aangenomen schema plus de echte `rls_prep`. Het bestand twee keer achter elkaar gedraaid. Met echte JWT's via de Storage-API: lid uploadt in eigen project (200) en de publieke URL werkt zonder token; een lid van een andere workspace, anon en een losgekoppelde gebruiker worden geweigerd; een admin mag; geneste paden, niet-hex namen, `text/plain`, 1,1 MB en overschrijven worden geweigerd; anon en een vreemde gebruiker kunnen niet verwijderen of opsommen; het eigen object verwijderen werkt. Zonder bucket antwoordt Storage HTTP 400 `Bucket not found`; daar valt de app op terug.

## App-wijzigingen die bij deze migraties horen

| Waarom | Wat in `app.html` | Uiterlijk vóór |
|---|---|---|
| Token verloopt na een uur | 1.1h: `onAuthStateChange` → `saveAuthSession`, en bij een 401 verversen en opnieuw proberen | stap 10 |
| Alleen `UPDATE(name)` op app_users | **gedaan:** `changeUserRole` → `_rpc('admin_set_user_role',{p_user_id:id,p_role:newRole})`; alleen als de RPC nog niet bestaat (404/PGRST202) de oude directe update. Een company_admin mag, net als nu in de app, binnen de eigen workspace rollen wisselen tussen operator en company_admin (afgedwongen door de guard-trigger); admin/super_admin blijven voorbehouden aan admins | stap 10 |
| Detach via een RPC | **gedaan:** `delCompany` → `_rpc('admin_delete_company',{p_company_id:id})`, met dezelfde terugval; de RPC is alleen voor super_admin, net als de bestaande delete-policy | stap 10 |
| Companies hernoemen alleen door company_admin en admins | **gedaan:** operators zien het naamveld in de workspace-instellingen alleen-lezen, zonder opslaan-knop | stap 10 |
| Gestripte deellinkdata | **gedaan** (branch `feature/share-link-p-mode`): `save()` en `_pushProject` doen niets in `PUBLIC_MODE`; `{p_id, p_mode: PUBLIC_MODE}` in de early fetch, `loadPublicView` en de poll, met terugval 2 → 1 argument → tabel; de booth-suite draait op de legacy- én de gestripte feed. Stap 11 blijft geblokkeerd door de iPad-app | stap 11 |
| Abonnement in trial | `_effectiveStageLimit`: `trialing` gelijk aan `active` (B2); eventueel in `canCreateProject` ook pass en `past_due` gelijktrekken met de server | stap 12 |
| Plan-limiet van de server | **gedaan:** HTTP 402 (of 400) met `PT402`: bij `stage_limit_exceeded` haalt de app de nieuwste stage(s) die de server nog niet had lokaal weg (tot het aantal past), markeert ze als bewust verwijderd, toont `message` aan de operator en slaat direct opnieuw op. Bij `subscription_required` op een nieuw project legt het limietvenster uit dat het project niet is aangemaakt | stap 12 |
| Conflictdetectie | **gedaan:** opslaan via `save_project` met hermerge bij een conflict; echo's met `version <=` de eigen versie genegeerd. Terugval naar GET + PATCH als de kolom of de RPC ontbreekt. **Niet gedaan:** `patch_show` | stap 13 |
| Soft delete | **gedaan:** `soft_delete_project` (terugval: harde DELETE); filter `&deleted_at=is.null` in `loadAPPRemote` en `_fetchProjectRow` zodra de kolom bestaat; realtime UPDATE met `deleted_at` = verwijderd; *Recently deleted* met herstel en *Version history* in het dashboard | stap 13 |
| Goedkoop pollen (§4.3) | **gedaan** (zelfde branch): publieke views pollen `get_shared_project_version` en halen het project alleen op als de versie verandert (plus minstens één keer per minuut). Zonder de functie (vóór stap 6) blijft het de volle poll | optioneel, na stap 6 |
| Foto's uit de blob | **gedaan** (branch `feature/photo-storage`): upload naar `project-media` met terugval op base64 zolang de bucket ontbreekt, opruimen bij vervangen/weghalen, achtergrondconversie van het open project | stap 16 |
| Push | **gedaan:** alleen nog `send-push`; `OS_REST_KEY` verwijderd; de `endTime`/`stageId`-bug in `scheduleProjectPushes` gerepareerd. Pushen werkt weer zodra stap 15 gedaan is | stap 15 |

## Niet verifieerbaar zonder het echte schema

Lokaal is alles getest tegen een **aangenomen** schema. Dat is gebeurd op `supabase/postgres:17.6.1.167` en PostgREST 16.2 in Docker, zonder verbinding met productie. Wat getest is:

- de volgorde van stap 1 tot en met 10, ook in een andere volgorde;
- alles twee keer draaien;
- dat de controles op voorwaarden afbreken;
- de guards per rol;
- RLS-reads via PostgREST;
- het kiezen van de juiste `get_shared_project`-variant per argument;
- dat `PT402` een HTTP 402 geeft;
- conflict, wipe-guard, `patch_show`, momentopnamen, soft delete, herstel uit de historie, log- en enforce-modus;
- lockout van tokens;
- (13-10, review-fixes) met `companies` op `REPLICA IDENTITY DEFAULT`, op `FULL` en op `FULL` met opt-in: UPDATE en DELETE op companies als service_role en postgres blijven werken; de oude kolomlijst bij `FULL` gaf "Column list used by the publication does not cover the replica identity" en een nieuwe run van PART 2 repareert dat;
- anon en authenticated kunnen geen interne helper aanroepen (41 aanroepen, allemaal "permission denied"); anon kan alleen de vier deellink-RPC's uitvoeren; triggers werken nog voor ingelogde gebruikers;
- een operator kan `deleted_at`, `deleted_by` en `version` niet wijzigen (kolomrechten na stap 10, trigger ervoor); `data` en `name` wel; soft delete, purge en daarna `restore_project` uit de momentopname van het weggooien;
- company_admin hernoemt de eigen workspace, een operator niet;
- fase B van de signup-tokens: de app-select met `setup_pending` werkt daarna nog.

Deze aannames moet Thijs bevestigen. Het makkelijkst gaat dat met `supabase db pull` en een commit:

1. `projects.id`, `projects.company_id`, `app_users.id`, `app_users.company_id` en `companies.id` zijn **tekst**. `''` betekent "losgekoppeld". Is `company_id` een uuid, dan falen `admin_delete_company` en `delCompany` op `''`.
2. `projects.data` is **jsonb**. Dit wordt gecontroleerd.
3. `app_users.role` is tekst met de waarden `operator`, `company_admin`, `admin` en `super_admin`. Andere waarden blijven bestaan, maar geven geen rechten.
4. `companies.pass_expires_at` is een timestamp of een ISO-string. Beide worden ondersteund. `live_stages_limit` en `live_stages_override` zijn getallen.
5. Er bestaan op productie **geen** eerdere policies of triggers op deze tabellen die botsen. S.1 laat zien of RLS al aan staat.
6. **Edge functions:**
   - schrijven ze naar `app_users` en `companies` met de service_role-key?
   - gebruikt `invite-member` `role: null`? (Dat wordt `operator`, dus het is veilig.)
   - voegt `invite-member` dubbele e-mailadressen toe? (Dat faalt nu.)
   - maakt `signup-checkout` companies aan met de service_role-key?
7. **Realtime:** zit `companies` in de publicatie `supabase_realtime`, en met welke replica identity (stap 0)? Kolomlijsten werken pas vanaf PG 15. De configuratie zegt 17. Bij `REPLICA IDENTITY FULL` slaan stap 5 en 10 de kolomlijst standaard over (zie stap 5). Of Supabase Realtime de kolomlijst überhaupt gebruikt, is niet zeker; de kolomrechten zijn de echte bescherming. Test het met een echte client (stap 5).
8. Is pg_cron beschikbaar?
9. **auto_expose:** nieuwe tabellen (`project_versions`, `plan_violations`, `backend_settings`) krijgen hoe dan ook expliciet geen rechten voor anon en authenticated. Dat is correct, ongeacht deze instelling.
10. De opslag van `project_versions` hangt af van de grootte van de blobs met base64-foto's. Meet dat na stap 7.
11. Ondersteunt de productieversie van PostgREST `PT402`? Lokaal met 16.2 werkt het. Anders wordt het HTTP 400 met dezelfde body.

## Lokaal opnieuw testen (optioneel)

```bash
docker run -d --name st-migtest -e POSTGRES_PASSWORD=postgres public.ecr.aws/supabase/postgres:17.6.1.167
# laad eerst een fixture met de bovenstaande aannames en een auth.jwt() die request.jwt.claims leest,
# daarna de bestanden in de volgorde van dit document met: psql -v ON_ERROR_STOP=1 -f <bestand>
docker rm -f st-migtest
```

Gebruik na `supabase db pull` het echte `remote_schema.sql` als fixture in plaats van de aannames.
