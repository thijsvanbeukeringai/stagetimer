-- ═══════════════════════════════════════════════════════════════════════
-- HOTFIX: companies.setup_token must never reach a client.
--
-- setup_token is the one-time secret that finalize-signup accepts to set the
-- first password of a paid workspace. Anyone who can read it (or overwrite it)
-- can take that workspace over. Today the token reaches clients three ways:
--   1. REST/supabase-js `select=*` on companies (app.html loadAPPRemote etc.)
--   2. direct PATCH on companies (an attacker can set a token of their choice)
--   3. Realtime postgres_changes on companies (full row in every UPDATE event)
--
-- THIS FILE IS NOT APPLIED AUTOMATICALLY. Run it by hand in three parts, in
-- this exact order; part 3 breaks any app.html that still does select=*.
--
--   PART 1  add the derived flag              (safe any time)
--   ---->   apply 20261013100000_share_link_rpcs.sql (and rls_prep): the new
--           app.html loads EVERY public share link through the
--           get_shared_project RPC; without it all share links show
--           "Project not found".
--   ---->   deploy app.html from branch improve/2026-10-13 (selects explicit
--           columns incl. setup_pending, never setup_token), wait for open tabs
--           to reload (app.html is served no-store; a reload picks it up)
--   PART 2  revoke column access + trim realtime (do NOT run during a live show)
--   PART 3  verify
--
-- Relation to rls_enable: rls_enable block 4b/4c applies exactly the same
-- companies grants and realtime column list as PART 2 below, so PART 2 and
-- rls_enable may run in either order; the second one is a no-op for
-- companies. Full runbook: docs/MIGRATIES.md.
--
-- Verification of PART 1:
--   select column_name, is_generated from information_schema.columns
--    where table_schema='public' and table_name='companies' and column_name='setup_pending';
--   select count(*) filter (where setup_pending) from public.companies;  -- = S.1 count
--
-- Rollback of PART 1 only (safe while no app reads the column):
--   alter table public.companies drop column if exists setup_pending;
--
-- Rollback of PART 2 (restores today's behaviour, including the hole; only
-- meant for "the new app.html cannot load companies" before rls_enable - once
-- rls_enable is applied, roll that back instead and leave this in place):
--   grant select, update on public.companies to anon, authenticated;
--   -- and re-add companies to the realtime publication without a column list:
--   alter publication supabase_realtime drop table public.companies;
--   alter publication supabase_realtime add table public.companies;
-- ═══════════════════════════════════════════════════════════════════════


-- ── PART 1 ─────────────────────────────────────────────────────────────
-- Admin UI only needs to know "awaiting activation", not the token itself.
alter table public.companies
  add column if not exists setup_pending boolean
  generated always as (setup_token is not null and setup_token <> '') stored;

comment on column public.companies.setup_pending is
  'True while the workspace has not finished signup (setup_token set). Safe to expose; the token itself is not.';


-- ── PART 2 ─────────────────────────────────────────────────────────────
-- Run only after the new app.html is live.
begin;

-- 2a. No table-wide read/write for client roles.
revoke select, update on public.companies from anon, authenticated;

-- 2b. Logged-in users may read every column except setup_token. Built
--     dynamically so the grant matches the real production schema.
--     NOTE: columns added later are NOT readable until granted explicitly.
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'companies'
     and column_name <> 'setup_token';
  execute format('grant select (%s) on public.companies to authenticated', cols);
end $$;

-- 2c. The only columns app.html updates directly (rename workspace, admin
--     live-stage override). Everything else is written by edge functions with
--     the service role, which is not affected by these grants.
grant update (name, live_stages_override) on public.companies to authenticated;
--     anon gets nothing: public share views never read companies.
--     INSERT/DELETE grants are left as they are (admin "create/delete company").

-- 2d. Realtime: publish companies WITHOUT setup_token (Postgres 15+ column
--     lists). Only touches the publication if companies is in it.
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
       and is_generated = 'NEVER';          -- generated columns cannot be published
    execute 'alter publication supabase_realtime drop table public.companies';
    execute format('alter publication supabase_realtime add table public.companies (%s)', cols);
  end if;
end $$;

commit;


-- ── PART 3: verify ─────────────────────────────────────────────────────
-- Expect: false, false, false, false
select has_column_privilege('anon',          'public.companies', 'setup_token', 'select') as anon_read,
       has_column_privilege('authenticated', 'public.companies', 'setup_token', 'select') as auth_read,
       has_column_privilege('anon',          'public.companies', 'setup_token', 'update') as anon_write,
       has_column_privilege('authenticated', 'public.companies', 'setup_token', 'update') as auth_write;
-- Expect: setup_token NOT in the list
select attnames from pg_publication_tables
 where pubname = 'supabase_realtime' and tablename = 'companies';
-- From outside (anon key in $ANON), expect HTTP 401/403, never 200:
--   curl -s -o /dev/null -w "%{http_code}\n" \
--     "https://bamjpsquhdzxvsymldpq.supabase.co/rest/v1/companies?select=setup_token&limit=0" \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON"

-- ── Still open after this hotfix (tracked in BOUWPLAN.md §S.5) ─────────
-- * finalize-signup source is not in the repo: verify it clears the token on
--   use, expires it, compares in constant time, and is rate limited.
-- * Move tokens to a separate table without any client grants.
-- * RLS on companies is still the real fix for "everyone reads every company".
