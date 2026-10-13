-- ═══════════════════════════════════════════════════════════════════════
-- RLS rollout, step 2 of 2: turn it on, and replace table-wide grants with
-- column ALLOWLISTS.
--
-- STATUS: NOT APPLIED to production. Run by hand (SQL editor). Full runbook:
-- docs/MIGRATIES.md.
--
-- PURPOSE
--   Before this migration, anyone holding the public anon key (it is in the
--   page source) can read and write every row of projects, app_users and
--   companies. After it:
--   * anon: no table access at all. Public share links go through
--     get_shared_project() / set_show_arrived() (share_link_rpcs migration).
--   * authenticated: rows of their own workspace (admins: all), and only
--       app_users  UPDATE(name)
--       companies  SELECT(all columns except setup_token),
--                  UPDATE(name, live_stages_override)  [policy: company_admin
--                  of that workspace or admin; trigger: override = admins]
--     Role changes and workspace deletion go through admin_set_user_role()
--     and admin_delete_company() (rls_prep).
--
-- PRECONDITIONS (all checked below; the migration aborts otherwise)
--   * rls_prep applied (helpers + guards).
--   * share_link_rpcs applied (get_shared_project, set_show_arrived).
--   * hotfix_setup_token PART 1 applied (companies.setup_pending exists).
--   NOT checkable from SQL, Thijs must confirm before running:
--   * The live app.html sends the USER JWT on every REST call, refreshes the
--     st_auth_v1 copy on TOKEN_REFRESHED (BOUWPLAN 1.1h - otherwise every
--     save fails ~1 hour after login), uses admin_set_user_role /
--     admin_delete_company, and selects companies with an explicit column
--     list (no select=*).
--   * Every edge function that touches these tables uses the service_role
--     key (or only touches rows the caller may see).
--
-- APPLY ORDER
--   after:  hotfix PART 1, rls_prep, share_link_rpcs, app deploy (above)
--   any order relative to hotfix PART 2: both apply the identical companies
--   grants and realtime column list, so whichever runs second is a no-op.
--   TIMING: never during a live show. Tabs running an older app.html lose
--   access until reloaded. Do it on a quiet weekday morning and keep the
--   rollback block below open in a second SQL editor tab.
--
-- VERIFY
--   select relname, relrowsecurity from pg_class
--    where relnamespace = 'public'::regnamespace and relname in ('projects','app_users','companies');
--                                                     -- all true
--   select has_table_privilege('anon','public.projects','select'),          -- false
--          has_table_privilege('anon','public.companies','select'),         -- false
--          has_column_privilege('authenticated','public.companies','setup_token','select'), -- false
--          has_column_privilege('authenticated','public.app_users','role','update'),        -- false
--          has_column_privilege('authenticated','public.app_users','name','update');        -- true
--   select policyname, tablename from pg_policies where schemaname='public' order by 2,1;
--   From outside, with the anon key in $ANON (expect [] or 401, never rows):
--     curl -s "https://<ref>.supabase.co/rest/v1/projects?select=id&limit=1" \
--       -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
--   In the app: log in as operator, company_admin and super_admin; open a
--   project, save, rename yourself, open every share-link mode, check in.
--
-- ROLLBACK (restores the pre-RLS behaviour INCLUDING the hole; use only if a
-- live event goes sideways, then fix forward):
--   alter table public.projects  disable row level security;
--   alter table public.app_users disable row level security;
--   alter table public.companies disable row level security;
--   grant select, insert, update, delete on public.projects  to anon, authenticated;
--   grant select, insert, update, delete on public.app_users to anon, authenticated;
--   -- companies: deliberately NOT re-opened. authenticated keeps the
--   -- column-limited SELECT (no setup_token) + UPDATE(name, live_stages_override)
--   -- from block 4b, which is all the app needs; public views never read it.
--   The column-guard triggers from rls_prep stay active (they are the
--   safety net while RLS is off).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0. Preconditions ───────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.caller_role()') is null
     or to_regprocedure('public.caller_company_id()') is null
     or to_regprocedure('public.current_app_user()') is null then
    raise exception 'rls_enable: apply rls_prep first';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'companies_guard_columns' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgname = 'app_users_guard_columns' and not tgisinternal) then
    raise exception 'rls_enable: column guard triggers missing, apply rls_prep first';
  end if;
  if to_regprocedure('public.get_shared_project(text)') is null
     or to_regprocedure('public.set_show_arrived(text,text,boolean,bigint)') is null then
    raise exception 'rls_enable: apply share_link_rpcs first, or every public share link breaks';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'companies' and column_name = 'setup_pending') then
    raise exception 'rls_enable: apply hotfix_setup_token PART 1 first (companies.setup_pending)';
  end if;
end $$;

begin;

alter table public.projects  enable row level security;
alter table public.app_users enable row level security;
alter table public.companies enable row level security;

-- ── 1. projects ────────────────────────────────────────────────────────
-- A user sees the projects of their own workspace. Platform admins see all.
-- Anonymous share-link viewers do NOT match here - they go through
-- get_shared_project() instead. caller_company_id() is NULL for users
-- without a workspace, so detached users never see detached ('') projects.
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (
    company_id::text = (select public.caller_company_id())
    or (select public.caller_role()) in ('admin', 'super_admin')
  );

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    company_id::text = (select public.caller_company_id())
    or (select public.caller_role()) in ('admin', 'super_admin')
  );
-- Plan enforcement (subscription / stage limit) is a trigger, see
-- 20261013130000_plan_enforcement.sql - it works with and without RLS and
-- gives a readable error instead of "violates row-level security policy".

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (
    company_id::text = (select public.caller_company_id())
    or (select public.caller_role()) in ('admin', 'super_admin')
  )
  with check (
    company_id::text = (select public.caller_company_id())
    or (select public.caller_role()) in ('admin', 'super_admin')
  );

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete to authenticated
  using (
    company_id::text = (select public.caller_company_id())
    or (select public.caller_role()) in ('admin', 'super_admin')
  );

-- ── 2. app_users ───────────────────────────────────────────────────────
-- Colleagues in the same workspace are visible (crew picker, members list).
-- Platform admins see everyone.
drop policy if exists app_users_select on public.app_users;
create policy app_users_select on public.app_users
  for select to authenticated
  using (
    lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    or company_id::text = (select public.caller_company_id())
    or (select public.caller_role()) in ('admin', 'super_admin')
  );

-- Only UPDATE(name) is granted (block 4); this policy limits it to your own
-- row, admins any row. role/company_id go through admin_set_user_role /
-- admin_delete_company (SECURITY DEFINER, own checks + guard trigger).
drop policy if exists app_users_update on public.app_users;
create policy app_users_update on public.app_users
  for update to authenticated
  using (
    lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    or (select public.caller_role()) in ('admin', 'super_admin')
  )
  with check (
    lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    or (select public.caller_role()) in ('admin', 'super_admin')
  );
-- Creating and deleting users runs through the invite-member / remove-member
-- edge functions on the service_role key, which bypasses RLS. No client-side
-- insert or delete policy on purpose.

-- ── 3. companies ───────────────────────────────────────────────────────
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated
  using (
    id::text = (select public.caller_company_id())
    or (select public.caller_role()) in ('admin', 'super_admin')
  );

-- Rename: company_admin of that workspace, or a platform admin. Operators
-- cannot. live_stages_override is additionally limited to admins by
-- companies_guard_columns; billing columns are not granted at all.
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies
  for update to authenticated
  using (
    (id::text = (select public.caller_company_id()) and (select public.caller_role()) = 'company_admin')
    or (select public.caller_role()) in ('admin', 'super_admin')
  )
  with check (
    (id::text = (select public.caller_company_id()) and (select public.caller_role()) = 'company_admin')
    or (select public.caller_role()) in ('admin', 'super_admin')
  );

drop policy if exists companies_insert on public.companies;
create policy companies_insert on public.companies
  for insert to authenticated
  with check ((select public.caller_role()) = 'super_admin');

drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies
  for delete to authenticated
  using ((select public.caller_role()) = 'super_admin');

-- ── 4. Grants: allowlists ──────────────────────────────────────────────
-- anon: nothing on any of the three tables. Its only doors are
-- get_shared_project() and set_show_arrived(). This also stops Realtime from
-- delivering postgres_changes to public share views; they poll instead.
revoke all on public.projects  from anon;
revoke all on public.app_users from anon;
revoke all on public.companies from anon;

-- 4a. app_users: read via policy, write only the display name.
revoke insert, update, delete on public.app_users from authenticated;
grant update (name) on public.app_users to authenticated;

-- 4b. companies: IDENTICAL to hotfix_setup_token PART 2, so the two can run
--     in either order. Every column except setup_token is readable (built
--     from the live schema). NOTE: columns added later are NOT readable until
--     this block is re-run.
revoke select, update on public.companies from authenticated;
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'companies'
     and column_name <> 'setup_token';
  execute format('grant select (%s) on public.companies to authenticated', cols);
end $$;
grant update (name, live_stages_override) on public.companies to authenticated;
-- INSERT/DELETE stay granted to authenticated; the policies above limit them
-- to super_admin (admin "create / delete workspace").

-- 4c. Realtime: publish companies WITHOUT setup_token (identical to hotfix
--     PART 2d). Only touches the publication if companies is in it.
do $$
declare cols text;
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime'
                and schemaname = 'public' and tablename = 'companies') then
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'companies'
       and column_name <> 'setup_token'
       and is_generated = 'NEVER';
    execute 'alter publication supabase_realtime drop table public.companies';
    execute format('alter publication supabase_realtime add table public.companies (%s)', cols);
  end if;
end $$;

commit;
