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
-- Relation to 20261013080000_urgent_anon_write_lockdown.sql (runbook step 0):
-- that file already revoked every anon write on app_users and companies.
-- PART 2 re-asserts it (one idempotent revoke) so this hotfix never leaves
-- anon able to DELETE users or workspaces, even if step 0 was skipped.
--
-- REALTIME AND REPLICA IDENTITY (read before PART 2)
--   PART 2d narrows the supabase_realtime publication to every companies
--   column except setup_token. On PG 15+ a publication column list must
--   cover the table's replica identity; with REPLICA IDENTITY FULL it never
--   does, and then EVERY UPDATE/DELETE on companies fails ("column list used
--   by the publication does not cover the replica identity"): Stripe
--   webhook activation, finalize-signup, renames, admin_delete_company.
--   So 2d checks pg_class.relreplident first:
--     'd' (default, primary key) / 'i' (index): column list applied.
--     'f' (FULL), DEFAULT BEHAVIOUR: column list NOT applied (a NOTICE says
--         so; an earlier broken list is repaired). setup_token is still
--         protected by the column SELECT grant of 2b.
--     'f' with opt-in: run this first in the same SQL editor script
--           select set_config('stagetimer.companies_replica_identity_default', 'on', false);
--         2d then switches companies to REPLICA IDENTITY DEFAULT and applies
--         the list. Consequence: realtime UPDATE/DELETE events on companies
--         carry only the primary key in payload.old (and logical-replication
--         consumers lose the old row). app.html is not affected: its only
--         companies subscription is UPDATE and _onCompanyChange reads
--         payload.new only. Check other consumers (database webhooks, BI
--         replication) before opting in.
--   The column list is defence in depth, not the real protection: Supabase
--   Realtime postgres_changes decodes WAL itself (wal2json) and may ignore
--   publication column lists. What it does honour is the subscriber's
--   column SELECT privilege + RLS. VERIFY AFTER PART 2 with a real client:
--   log in to the app (any role), in the browser console run
--     supa.channel('t').on('postgres_changes',{event:'UPDATE',schema:'public',
--       table:'companies'},p=>console.log(Object.keys(p.new))).subscribe()
--   then rename that workspace (as company_admin, from another tab) and
--   check that the logged keys do NOT include setup_token.
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
--   grant select on public.companies to anon, authenticated;
--   grant update on public.companies to authenticated;
--   -- (anon writes stay revoked: that is step 0, not part of this hotfix)
--   -- and re-add companies to the realtime publication without a column list:
--   alter publication supabase_realtime drop table public.companies;
--   alter publication supabase_realtime add table public.companies;
--   -- only if you opted in to the replica identity switch:
--   alter table public.companies replica identity full;
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
--     authenticated keeps INSERT/DELETE (admin "create/delete company"; the
--     rls_prep guard and later the RLS policies limit them to super_admin).

-- 2c'. anon never writes users or workspaces (the app only does so logged
--     in, edge functions use service_role). Same as step 0
--     (20261013080000_urgent_anon_write_lockdown.sql); repeated here so this
--     hotfix is complete on its own. Idempotent.
revoke insert, update, delete, truncate on public.app_users from anon;
revoke insert, update, delete, truncate on public.companies from anon;

-- 2d. Realtime: publish companies WITHOUT setup_token (Postgres 15+ column
--     lists). Only touches the publication if companies is in it, and only
--     when the replica identity allows it (see REALTIME AND REPLICA IDENTITY
--     in the header). IDENTICAL to rls_enable block 4c.
do $$
declare
  cols      text;
  ident     "char";
  has_list  boolean;
  opt_in    boolean := coalesce(current_setting('stagetimer.companies_replica_identity_default', true), '') = 'on';
  uncovered text;
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'companies') then
    return;
  end if;
  select c.relreplident into ident from pg_class c where c.oid = 'public.companies'::regclass;
  select pr.prattrs is not null into has_list
    from pg_publication_rel pr join pg_publication p on p.oid = pr.prpubid
   where p.pubname = 'supabase_realtime' and pr.prrelid = 'public.companies'::regclass;

  -- FULL + a column list = every UPDATE/DELETE on companies fails.
  if ident = 'f' and not opt_in then
    if has_list then   -- repair the broken state an older version of this block left behind
      execute 'alter publication supabase_realtime drop table public.companies';
      execute 'alter publication supabase_realtime add table public.companies';
    end if;
    raise notice 'companies has REPLICA IDENTITY FULL: realtime column list NOT applied (it would break every UPDATE/DELETE on companies). setup_token stays protected by the column SELECT grant. Opt-in to switch to REPLICA IDENTITY DEFAULT: see the file header.';
    return;
  end if;
  if ident = 'f' then
    -- Opt-in. Realtime old records on companies then carry the primary key
    -- only; app.html (_onCompanyChange) reads payload.new only.
    execute 'alter table public.companies replica identity default';
    raise notice 'companies: REPLICA IDENTITY FULL -> DEFAULT (opt-in)';
    ident := 'd';
  end if;

  -- The replica identity (primary key / chosen index) must be inside the
  -- list. It always is, unless it uses setup_token or a generated column;
  -- anything unexpected: leave the publication alone.
  select string_agg(a.attname, ', ') into uncovered
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = 'public.companies'::regclass
     and ((ident = 'd' and i.indisprimary) or (ident = 'i' and i.indisreplident))
     and (a.attname = 'setup_token' or a.attgenerated <> '');
  if uncovered is not null or ident not in ('d', 'i') then
    raise notice 'companies: replica identity % (%) does not fit a column list; realtime column list NOT applied, the column grant still protects setup_token',
      ident, coalesce(uncovered, '-');
    return;
  end if;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'companies'
     and column_name <> 'setup_token'
     and is_generated = 'NEVER';          -- generated columns cannot be published
  execute 'alter publication supabase_realtime drop table public.companies';
  execute format('alter publication supabase_realtime add table public.companies (%s)', cols);
end $$;

commit;


-- ── PART 3: verify ─────────────────────────────────────────────────────
-- Expect: false, false, false, false
select has_column_privilege('anon',          'public.companies', 'setup_token', 'select') as anon_read,
       has_column_privilege('authenticated', 'public.companies', 'setup_token', 'select') as auth_read,
       has_column_privilege('anon',          'public.companies', 'setup_token', 'update') as anon_write,
       has_column_privilege('authenticated', 'public.companies', 'setup_token', 'update') as auth_write;
-- Expect: false, false, false (anon writes; same check as step 0)
select has_table_privilege('anon', 'public.companies', 'delete') as anon_del_companies,
       has_table_privilege('anon', 'public.app_users', 'delete') as anon_del_users,
       has_table_privilege('anon', 'public.companies', 'insert') as anon_ins_companies;
-- Replica identity vs. column list. Expect either
--   relreplident d/i  and setup_token NOT in attnames        (list applied), or
--   relreplident f    and has_list = false                   (list skipped, NOTICE seen)
-- NEVER relreplident f together with has_list = true.
select c.relreplident,
       pr.prattrs is not null as has_list,
       (select attnames from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'companies') as attnames
  from pg_class c
  left join pg_publication_rel pr on pr.prrelid = c.oid
       and pr.prpubid = (select oid from pg_publication where pubname = 'supabase_realtime')
 where c.oid = 'public.companies'::regclass;
-- Writes still work (Stripe webhook / finalize-signup path). Must succeed:
--   begin; update public.companies set name = name where id = (select id from public.companies limit 1); rollback;
-- Realtime: do the subscribed-client test from the header (setup_token must
-- not appear in payload.new).
-- From outside (anon key in $ANON), expect HTTP 401/403, never 200:
--   curl -s -o /dev/null -w "%{http_code}\n" \
--     "https://bamjpsquhdzxvsymldpq.supabase.co/rest/v1/companies?select=setup_token&limit=0" \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON"

-- ── Still open after this hotfix (tracked in BOUWPLAN.md §S.5) ─────────
-- * finalize-signup source is not in the repo: verify it clears the token on
--   use, expires it, compares in constant time, and is rate limited.
-- * Move tokens to a separate table without any client grants.
-- * RLS on companies is still the real fix for "everyone reads every company".
