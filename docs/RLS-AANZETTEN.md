# RLS aanzetten: kortste route

Besluit Thijs, 20-10-2026: **RLS moet aan.** Dit is de kortste veilige route vanuit de huidige productiestand (alleen stap 0 uitgevoerd). Details, rollbacks en achtergrond staan in `docs/MIGRATIES.md`; de stapnummers hieronder verwijzen daarnaar. Thijs voert alles zelf uit in de Supabase SQL-editor. Claude komt niet aan productie.

**Waarom:** zolang RLS uit staat, kan iedereen met de publieke anon-key (staat in de paginabron) alle projecten van alle klanten lezen en waarschijnlijk wijzigen of verwijderen, en alle gebruikers en workspaces lezen.

## 1. Poorten: alles moet "ja" zijn

| # | Vraag | Hoe controleren | Stand |
|---|---|---|---|
| a | Staat er een "RLS-ready" app live (stap 9)? | `main` (aea9569, live sinds 14-10) bevat: ververst `st_auth_v1` bij `TOKEN_REFRESHED` en bij een 401, `admin_set_user_role`, `admin_delete_company`, `p_mode` op elke deellink, `save()` doet niets op deellinks. | **ja** (gecontroleerd in de code op 20-10) |
| b | Schrijven alle edge functions naar `app_users` / `companies` met de **service_role-key**? | Dashboard → Edge Functions → per functie de code: de client moet gemaakt worden met `SUPABASE_SERVICE_ROLE_KEY`. Functies: `finalize-signup`, `signup-checkout`, `invite-member`, `remove-member`, `manage-voucher`, `portal-link`, `create-auth-user`, `delete-auth-user`, de Stripe-webhook. | **open** (staan niet in git) |
| c | Oude iPad-app *Stagetimer Booth*: accepteren we dat oude installaties kunnen breken? | Leest die app `projects` rechtstreeks met de anon-key, dan toont hij na stap 10 niets meer. Alternatief: eerst een netwerk-trace (Proxyman) op een iPad met de oude app. | **besluit nodig** |
| d | Klopt het schema met de aannames? | Query hieronder (stap A): `id`/`company_id`-kolommen en `role` zijn tekst, `data` is jsonb, geen dubbele e-mailadressen. | **open** |
| e | Geen show binnen 24 uur na stap 10? | AMF is dit weekend. Dus stap 10 uiterlijk **donderdagochtend** (dan zijn er nog dagen om te herstellen), of **maandag** na AMF. | **plannen** |

Stap B t/m D (hieronder) breken niets en werken met elke app-versie. Die kunnen dus ook al als b/c/d nog open zijn. Alleen stap E (RLS zelf) wacht op alle poorten.

## 1b. Twee extra tabellen (Security Advisor, 20-10-2026)

De Security Advisor meldt ook `public.stripe_processed_events` en `public._shows_backup_20260720` zonder RLS. Onze migraties kennen die tabellen niet; ze blijven dus open, ook na stap E. De app gebruikt ze niet (hele codebase doorzocht). Los van de rest, nu al veilig:

```sql
alter table public.stripe_processed_events enable row level security;
alter table public._shows_backup_20260720 enable row level security;
revoke all on public.stripe_processed_events from anon, authenticated;
revoke all on public._shows_backup_20260720 from anon, authenticated;
```
Controle: de volgende Stripe-webhook slaagt (de webhook hoort met de service_role-key te werken, die RLS negeert). Terugdraaien: `disable row level security` en `grant all ... to anon, authenticated`.

**Niet doen:** de door de Advisor voorgestelde `ENABLE ROW LEVEL SECURITY` op `projects`, `app_users` en `companies` los uitvoeren. Zonder de policies uit stap C t/m E mag dan niemand meer iets: geen login, geen project, elke deellink en booth op zwart.

Productie heeft vier migraties in zijn historie die niet in git staan (20260522082505, 20260522084554, 20260526010539, 20260730073449; gezien bij `supabase db pull` op 20-10). Die kunnen policies, triggers of kolommen bevatten. Daarom eerst het schema ophalen met `supabase db dump --linked -f remote_schema.sql` (geen historiecheck, alleen lezen) en **nooit** `supabase migration repair` uitvoeren.

## 2. Volgorde

Werk met twee tabbladen in de SQL-editor: één voor de stap, één met het `ROLLBACK`-blok van dat bestand klaar. Nooit tijdens een show.

### Stap A: vaststellen (alleen lezen, MIGRATIES stap 0)

```sql
-- RLS-stand en anon-rechten
select relname, relrowsecurity from pg_class
 where relnamespace='public'::regnamespace and relname in ('projects','app_users','companies');
select table_name, privilege_type from information_schema.role_table_grants
 where grantee='anon' and table_schema='public' and table_name in ('projects','app_users','companies')
 order by 1,2;
-- schema-aannames (poort d)
select table_name, column_name, data_type from information_schema.columns
 where table_schema='public' and table_name in ('projects','app_users','companies')
 order by table_name, ordinal_position;
select lower(email), count(*) from public.app_users group by 1 having count(*) > 1;   -- moet leeg zijn
-- realtime / replica identity (nodig bij stap E, blok 4c)
select relreplident from pg_class where oid = 'public.companies'::regclass;
```

### Stap B: kolom `setup_pending` (MIGRATIES stap 1)
Blok `PART 1` van `supabase/migrations/20261013090000_hotfix_setup_token.sql`.

### Stap C: `rls_prep` (MIGRATIES stap 2)
Heel `supabase/migrations/20260819111158_rls_prep.sql`. Korte lock op `app_users`. Daarna: inloggen, jezelf hernoemen, een rol wijzigen als admin.

### Stap D: deellink-RPC's (MIGRATIES stap 3)
`supabase/migrations/20261013100000_share_link_rpcs.sql`, **zonder** het PHASE B-blok onderaan (dat is commentaar). Alleen `CREATE OR REPLACE`, veilig. Daarna elke deellinksoort één keer openen (stage, backstage, foh, timeline, overview, wall, checkin, stagemanager) en een check-in aan/uit zetten.

### Stap E: RLS aan (MIGRATIES stap 10), pas als poort a t/m e "ja" zijn
`supabase/migrations/20260819111228_rls_enable.sql`. Het bestand controleert zelf of B, C en D gedaan zijn en breekt anders af.

Controle direct erna:
```sql
select relname, relrowsecurity from pg_class
 where relnamespace='public'::regnamespace and relname in ('projects','app_users','companies');   -- alle drie true
select has_table_privilege('anon','public.projects','select'),                                   -- false
       has_column_privilege('authenticated','public.companies','setup_token','select');          -- false
```
Dan in de app (10 minuten):
1. inloggen als operator: project openen, iets wijzigen, opslaan, pagina herladen: wijziging staat er;
2. als company_admin: workspace hernoemen;
3. als admin: een rol wijzigen;
4. alle deellinks openen, een check-in doen;
5. twee ingelogde tabbladen: wijziging komt binnen in het andere tabblad (realtime);
6. een uur later nog eens opslaan (tokenverversing).

Gaat er iets mis: het `ROLLBACK`-blok uit de kop van `rls_enable` draaien. RLS gaat dan weer uit; stap 0 blijft staan.

## 3. Daarna (niet nodig voor RLS)
Stap 5 (kolomrechten `companies`), 6, 7 en 8 uit MIGRATIES kunnen los daarna. Stap 11 (PHASE B) blijft geblokkeerd tot de oude iPad-app uitgezocht of uitgefaseerd is.
