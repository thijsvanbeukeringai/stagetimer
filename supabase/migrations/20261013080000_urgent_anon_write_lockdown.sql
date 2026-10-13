-- ═══════════════════════════════════════════════════════════════════════
-- URGENT, standalone: anonymous visitors may no longer write to app_users
-- or companies.
--
-- Today (RLS off) anyone holding the public anon key - it is in the page
-- source - can DELETE every user and workspace, or UPDATE roles and billing
-- fields. Safe to apply right now, before anything else in docs/MIGRATIES.md:
--   * The live app (main) and the improve branch only write these two tables
--     as a logged-in user (role `authenticated`) or through edge functions
--     (service_role). Neither is affected.
--   * Reads are NOT touched here (the app still reads both tables; reads are
--     closed by the setup_token hotfix and rls_enable later).
--   * `projects` is NOT touched: the live app still saves projects with the
--     anon key, so revoking there would break every customer's saves. That
--     table is only closed by the new app + rls_enable.
--
-- Known edge case: if the live app's supabase client lost its session (the
-- "hang" scenario), an admin action such as renaming a workspace would now
-- fail with "permission denied" instead of silently writing as anon. Reload
-- and log in again fixes it.
--
-- Run in the Supabase SQL editor; any time is fine, also during a live show:
-- no customer-facing path depends on these grants.
--
-- Rollback (restores today's open state):
--   grant insert, update, delete on public.app_users, public.companies to anon;
-- ═══════════════════════════════════════════════════════════════════════

revoke insert, update, delete, truncate on public.app_users from anon;
revoke insert, update, delete, truncate on public.companies from anon;

-- Verify: expect false for every column below.
select t.tbl,
       has_table_privilege('anon', t.tbl, 'insert') as anon_insert,
       has_table_privilege('anon', t.tbl, 'update') as anon_update,
       has_table_privilege('anon', t.tbl, 'delete') as anon_delete
  from (values ('public.app_users'), ('public.companies')) t(tbl);

-- Column-level UPDATE grants survive a table-level revoke. Expect 0 rows:
select table_name, column_name, privilege_type
  from information_schema.column_privileges
 where grantee = 'anon' and table_schema = 'public'
   and table_name in ('app_users', 'companies')
   and privilege_type in ('INSERT', 'UPDATE');
-- If rows come back, revoke those columns explicitly, e.g.:
--   revoke update (role) on public.app_users from anon;
--
-- From outside, with the anon key in $ANON, expect HTTP 401/403 (never 204):
--   curl -s -o /dev/null -w "%{http_code}\n" -X DELETE \
--     "https://bamjpsquhdzxvsymldpq.supabase.co/rest/v1/app_users?id=eq.__does_not_exist__" \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
