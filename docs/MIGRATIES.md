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


> **STAP 0, URGENT (kan meteen, los van alles hieronder):** `supabase/migrations/20261013080000_urgent_anon_write_lockdown.sql`.
> Vandaag kan iedereen met de publieke anon-key alle gebruikers en workspaces verwijderen of rollen aanpassen.
> Deze migratie trekt alleen anon-schrijfrechten op `app_users` en `companies` in. De live-app schrijft die tabellen nooit als anon, en `projects` blijft ongemoeid.
> Lokaal getest: na de migratie geeft `delete` als anon "permission denied". Rollback staat in het bestand.

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

### Stap 4: app deployen (improve/2026-10-13)

- **Vereist:** stap 1 tot en met 3.
- Test daarna:
  - elke deellinkmodus (stage, backstage, foh, timeline, overview, wall, checkin);
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
- **Effect:** elke wijziging aan een project verhoogt `version`. De huidige app merkt daar niets van. `save_project`, `patch_show` en `get_shared_project_version` staan klaar voor de app.
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

- Voer het commentaarblok onderaan `20261013100000_share_link_rpcs.sql` uit. De legacy-aanroep met één argument geeft dan geen foto's, `memberIds`, logo of `company_id` meer terug.
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

- `_pushProject` gaat via `save_project`. Bij een conflict wordt per show-id samengevoegd en opnieuw geprobeerd.
- Edits van één show gaan via `patch_show`.
- Verwijderen gaat via `soft_delete_project`. Overal wordt gefilterd op `deleted_at=is.null`. Daarna kan de policy uit het commentaarblok onderaan het historiebestand worden toegepast.

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

## App-wijzigingen die bij deze migraties horen

| Waarom | Wat in `app.html` | Uiterlijk vóór |
|---|---|---|
| Token verloopt na een uur | 1.1h: `onAuthStateChange` → `saveAuthSession`, en bij een 401 verversen en opnieuw proberen | stap 10 |
| Alleen `UPDATE(name)` op app_users | **gedaan:** `changeUserRole` → `_rpc('admin_set_user_role',{p_user_id:id,p_role:newRole})`; alleen als de RPC nog niet bestaat (404/PGRST202) de oude directe update. Een company_admin mag, net als nu in de app, binnen de eigen workspace rollen wisselen tussen operator en company_admin (afgedwongen door de guard-trigger); admin/super_admin blijven voorbehouden aan admins | stap 10 |
| Detach via een RPC | **gedaan:** `delCompany` → `_rpc('admin_delete_company',{p_company_id:id})`, met dezelfde terugval; de RPC is alleen voor super_admin, net als de bestaande delete-policy | stap 10 |
| Companies hernoemen alleen door company_admin en admins | **gedaan:** operators zien het naamveld in de workspace-instellingen alleen-lezen, zonder opslaan-knop | stap 10 |
| Gestripte deellinkdata | `save()` en `_pushProject` doen niets in `PUBLIC_MODE`; daarna `{p_id, p_mode: PUBLIC_MODE}` in de early fetch, `loadPublicView` en de 7 polls | stap 11 |
| Abonnement in trial | `_effectiveStageLimit`: `trialing` gelijk aan `active` (B2); eventueel in `canCreateProject` ook pass en `past_due` gelijktrekken met de server | stap 12 |
| Plan-limiet van de server | **gedaan:** HTTP 402 (of 400) met `PT402`: bij `stage_limit_exceeded` haalt de app de nieuwste stage(s) die de server nog niet had lokaal weg (tot het aantal past), markeert ze als bewust verwijderd, toont `message` aan de operator en slaat direct opnieuw op. Bij `subscription_required` op een nieuw project legt het limietvenster uit dat het project niet is aangemaakt | stap 12 |
| Conflictdetectie | `save_project` en `patch_show` (zie de kop van het versioning-bestand); echo's met `version <=` de eigen versie negeren | stap 13 |
| Soft delete | `soft_delete_project`; filter `&deleted_at=is.null` in `_restGet('projects')` en de peek; in realtime een UPDATE met `deleted_at` behandelen als DELETE | stap 13 |
| Goedkoop pollen (§4.3) | publieke views pollen `get_shared_project_version` en halen het project alleen op als de versie verandert | optioneel |
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
