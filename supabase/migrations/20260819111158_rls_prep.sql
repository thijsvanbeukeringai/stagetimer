-- ═══════════════════════════════════════════════════════════════════════
-- RLS rollout, step 1 of 2: identity helpers, column guards, admin RPCs and
-- app_users hygiene (role NOT NULL, unique email).
--
-- STATUS: NOT APPLIED to production. Run by hand (SQL editor), never with
-- `supabase db push` (that would also run rls_enable and the hotfix in one go).
-- Full runbook: docs/MIGRATIES.md.
--
-- PURPOSE
--   Puts in place everything rls_enable needs, without turning RLS on:
--   * current_app_user() / caller_role() / caller_company_id(): "who is
--     calling", resolved exactly like app.html does (JWT email -> app_users).
--     caller_role() never returns NULL ('' when unknown), so a NULL role can
--     no longer slip through `not in (...)` checks.
--   * Column guards (BEFORE INSERT/UPDATE triggers) on app_users and
--     companies. They are an ALLOWLIST: a client may only change
--     app_users.name (own row / admins), app_users.role + company_id (admins,
--     via admin_set_user_role / admin_delete_company), companies.name
--     (company_admin of that workspace, admins) and
--     companies.live_stages_override (admins). Everything else - all billing
--     columns, setup_token, email, id - can only be written by machine
--     callers (service_role edge functions, SQL editor, migrations).
--   * admin_set_user_role() and admin_delete_company(): rls_enable only
--     grants UPDATE(name) on app_users, so role changes and the "detach users
--     on workspace delete" step need a server-side path.
--   * app_users.role NOT NULL DEFAULT 'operator' (NULLs backfilled).
--   * Unique index on lower(app_users.email) - current_app_user() resolves by
--     email, so a duplicate would make identity ambiguous.
--
--   The share-link RPCs (get_shared_project, set_show_arrived) used to live in
--   this file. They moved to 20261013100000_share_link_rpcs.sql.
--
-- WHAT CHANGES FOR CLIENTS WHEN THIS IS APPLIED (RLS still off)
--   * Non-admin clients can no longer change role/company_id/email/billing
--     columns or INSERT into app_users/companies (closes "anon key inserts a
--     super_admin row"). The current app never does that except as admin.
--   * Edge functions that write app_users/companies with the anon key or a
--     user JWT instead of the service_role key WILL BE REJECTED. Verify the
--     function source first (see docs/MIGRATIES.md, "niet verifieerbaar").
--   * An insert of a duplicate email (any case) into app_users now fails.
--   * Clients can call admin_set_user_role / admin_delete_company (logged in)
--     and caller_role / caller_company_id (logged in, needed by the RLS
--     policies). Every other function in this file is not executable by
--     anon or authenticated.
--   * anon writes on app_users/companies are revoked by step 0
--     (20261013080000_urgent_anon_write_lockdown.sql), not by this file; the
--     guards here cover INSERT/UPDATE only, never DELETE.
--
-- PRECONDITIONS
--   * Tables public.app_users(id, email, role, company_id, name),
--     public.companies(id, name), public.projects(id, company_id, data jsonb)
--     exist (checked below; the migration aborts otherwise).
--   * No two app_users share an email case-insensitively (checked below; the
--     migration aborts and lists them - merge/delete duplicates first).
--   * S.1 checks from BOUWPLAN.md done.
--
-- APPLY ORDER (see docs/MIGRATIES.md for the full list)
--   after:  hotfix_setup_token PART 1
--   before: deploying app.html from improve/2026-10-13 (or later)
--   before: rls_enable
--   Safe to run during normal operation; avoid a live show anyway (it takes
--   a short ACCESS EXCLUSIVE lock on app_users for SET NOT NULL + index).
--
-- VERIFY (run after applying)
--   select count(*) from public.app_users where role is null;            -- 0
--   select column_default, is_nullable from information_schema.columns
--    where table_schema='public' and table_name='app_users' and column_name='role';
--                                              -- 'operator'::text | NO
--   select indexname from pg_indexes where indexname='app_users_email_lower_key';
--   select tgname from pg_trigger where tgname in
--     ('app_users_guard_columns','companies_guard_columns') and not tgisinternal;
--   select proname from pg_proc where proname in
--     ('current_app_user','caller_role','caller_company_id','_caller_is_machine',
--      'admin_set_user_role','admin_delete_company');
--   -- EXECUTE allowlist (Supabase grants EXECUTE on new functions to anon and
--   -- authenticated directly; every file revokes that for internal helpers).
--   -- After ALL files: anon may only run get_shared_project (both),
--   -- set_show_arrived and get_shared_project_version. Functions in public
--   -- that are not Stagetimer's (extensions etc.) may show up too.
--   select p.oid::regprocedure from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and has_function_privilege('anon', p.oid, 'execute') order by 1;
--   select has_function_privilege('authenticated','public.current_app_user()','execute'),   -- false
--          has_function_privilege('authenticated','public.caller_role()','execute');        -- true (RLS policies)
--   -- Guard smoke test (should FAIL with insufficient_privilege):
--   begin;
--     select set_config('request.jwt.claims','{"role":"authenticated","email":"nobody@example.invalid"}', true);
--     update public.companies set subscription_status = 'guard-smoke-test' where id = (select id from public.companies limit 1);
--     (a value no row has: 'active' on an already active company changes
--      nothing, so the guard has nothing to block and it falsely passes)
--   rollback;
--
-- ROLLBACK
--   drop trigger if exists app_users_guard_columns on public.app_users;
--   drop trigger if exists companies_guard_columns on public.companies;
--   drop function if exists public.guard_app_users_columns();
--   drop function if exists public.guard_companies_columns();
--   drop function if exists public.admin_set_user_role(text, text);
--   drop function if exists public.admin_delete_company(text);
--   drop index if exists public.app_users_email_lower_key;
--   alter table public.app_users alter column role drop not null;
--   alter table public.app_users alter column role drop default;
--   -- Helpers are harmless to leave; drop them only after rls_enable is rolled
--   -- back AND share_link_rpcs no longer reference them:
--   -- drop function if exists public.caller_role(), public.caller_company_id(),
--   --   public.current_app_user(), public._caller_is_machine(),
--   --   public._changed_columns(jsonb, jsonb, regclass);
--   (Backfilled NULL roles stay 'operator'; that is the safe value.)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0. Preconditions ───────────────────────────────────────────────────
do $$
declare missing text;
begin
  select string_agg(v.t || '.' || v.c, ', ') into missing
  from (values ('app_users','id'), ('app_users','email'), ('app_users','role'),
               ('app_users','company_id'), ('app_users','name'),
               ('companies','id'), ('companies','name'),
               ('projects','id'), ('projects','company_id'), ('projects','data')) v(t, c)
  where not exists (select 1 from information_schema.columns ic
                     where ic.table_schema = 'public' and ic.table_name = v.t and ic.column_name = v.c);
  if missing is not null then
    raise exception 'rls_prep precondition failed, missing columns: %', missing;
  end if;
end $$;

-- Duplicate e-mails (case-insensitive) make identity ambiguous. Abort and list
-- them; fix by hand (keep the row whose id is referenced by projects.created_by
-- / OneSignal external ids), then re-run this file.
do $$
declare dups text;
begin
  select string_agg(format('%s (%s rows: %s)', e, n, ids), '; ') into dups
  from (select lower(email) e, count(*) n, string_agg(id::text, ', ') ids
          from public.app_users
         where email is not null
         group by lower(email)
        having count(*) > 1) d;
  if dups is not null then
    raise exception 'duplicate app_users emails, resolve before applying: %', dups;
  end if;
end $$;

-- ── 1. app_users.role: NOT NULL DEFAULT 'operator' ─────────────────────
-- Backfill first (NULL role was the hole: `NULL not in (...)` is NULL, which
-- an IF treats as false, so the old guard let a NULL-role user pass).
do $$
declare n int;
begin
  -- No JWT claims in the SQL editor, so the guard trigger (if already
  -- present from an earlier run) treats this as a machine write.
  update public.app_users set role = 'operator' where role is null or role = '';
  get diagnostics n = row_count;
  raise notice 'app_users: backfilled % NULL/empty role(s) to operator', n;
end $$;
alter table public.app_users alter column role set default 'operator';
alter table public.app_users alter column role set not null;

-- ── 2. Unique e-mail ───────────────────────────────────────────────────
create unique index if not exists app_users_email_lower_key
  on public.app_users (lower(email));

-- ── 3. Who is calling? ─────────────────────────────────────────────────
-- app.html resolves the current user by matching the JWT email against
-- app_users (see loadCurrentUser), not by auth.uid() - app_users.id is not
-- guaranteed to be the auth user id. Everything below uses the same rule.
create or replace function public.current_app_user()
returns public.app_users
language sql
stable
security definer
set search_path = public
as $$
  select u.*
  from public.app_users u
  where lower(u.email) = lower(nullif(auth.jwt() ->> 'email', ''))
  limit 1
$$;
comment on function public.current_app_user() is
  'The app_users row belonging to the caller, resolved by JWT email. SECURITY DEFINER so RLS policies on app_users cannot recurse into themselves.';

-- Role of the caller, '' when unknown. NEVER NULL: every check can use plain
-- `in (...)` / `<>` without a NULL slipping through.
create or replace function public.caller_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select nullif(u.role, '') from public.current_app_user() u), '')
$$;

-- Workspace of the caller as text, NULL when none. '' (the app's "detached"
-- marker) is mapped to NULL so detached users never match detached projects.
create or replace function public.caller_company_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif((select u.company_id::text from public.current_app_user() u), '')
$$;

-- EXECUTE: Supabase's default privileges grant EXECUTE on every new public
-- function DIRECTLY to anon and authenticated, so `revoke ... from public`
-- alone revokes nothing for them. Every file therefore revokes from all
-- three and re-grants only what a client really calls.
-- caller_role / caller_company_id are used inside the RLS policies of
-- rls_enable, which are evaluated as `authenticated`: that role needs
-- EXECUTE. Nested calls (caller_role -> current_app_user, guard triggers ->
-- helpers) run as the SECURITY DEFINER owner and need no client grant.
revoke all on function public.current_app_user()  from public, anon, authenticated;
revoke all on function public.caller_role()       from public, anon, authenticated;
revoke all on function public.caller_company_id() from public, anon, authenticated;
grant execute on function public.caller_role()       to authenticated;
grant execute on function public.caller_company_id() to authenticated;

-- Machine callers manage billing/identity columns on purpose: no JWT at all
-- (SQL editor, migrations, pg_cron) or the service_role key (edge functions,
-- Stripe webhook).
create or replace function public._caller_is_machine()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('request.jwt.claims', true), '') = ''
      or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
$$;

-- Columns whose value differs between OLD and NEW, ignoring generated
-- columns (their NEW value is not computed yet in a BEFORE trigger).
create or replace function public._changed_columns(p_old jsonb, p_new jsonb, p_table regclass)
returns text[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(k order by k), '{}')
  from (select jsonb_object_keys(coalesce(p_new, '{}'::jsonb)) as k
        union
        select jsonb_object_keys(coalesce(p_old, '{}'::jsonb))) keys
  where (p_new -> k) is distinct from (p_old -> k)
    and not exists (select 1 from pg_attribute a
                     where a.attrelid = p_table and a.attname = k and a.attgenerated <> '')
$$;

-- Internal: only called from the SECURITY DEFINER guard triggers below and
-- from projects_plan_guard (plan_enforcement), which run as the owner.
revoke all on function public._caller_is_machine()                     from public, anon, authenticated;
revoke all on function public._changed_columns(jsonb, jsonb, regclass) from public, anon, authenticated;

-- ── 4. Column guards (allowlist) ───────────────────────────────────────
-- RLS decides which ROWS you may touch, never which COLUMNS. Column grants
-- (rls_enable) are the first line; these triggers are the second line and
-- also protect the period between this file and rls_enable, when the anon
-- key still has table-wide grants.
create or replace function public.guard_app_users_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role    text;
  caller_company text;
  caller_email   text := lower(nullif(auth.jwt() ->> 'email', ''));
  is_self        boolean;
  col            text;
begin
  if tg_op = 'INSERT' then
    -- An explicit NULL would bypass the column default.
    new.role := coalesce(nullif(new.role, ''), 'operator');
  end if;

  if public._caller_is_machine() then
    return new;
  end if;

  caller_role    := public.caller_role();        -- '' when unknown, never NULL
  caller_company := public.caller_company_id();  -- NULL when none

  if tg_op = 'INSERT' then
    -- Normally invite-member (service_role) creates users. Clients only by
    -- the same RBAC the admin UI applies.
    if caller_role in ('admin', 'super_admin') then
      if new.role = 'super_admin' and caller_role <> 'super_admin' then
        raise exception 'only super_admin may grant super_admin' using errcode = 'insufficient_privilege';
      end if;
      return new;
    end if;
    if caller_role = 'company_admin' and caller_company is not null
       and new.company_id::text = caller_company
       and new.role in ('operator', 'company_admin') then
      return new;
    end if;
    raise exception 'insufficient privileges to create users' using errcode = 'insufficient_privilege';
  end if;

  -- UPDATE
  is_self := caller_email is not null and lower(old.email) = caller_email;

  foreach col in array public._changed_columns(to_jsonb(old), to_jsonb(new), tg_relid) loop
    if col = 'name' then
      if not (is_self or caller_role in ('admin', 'super_admin')) then
        raise exception 'you may only rename yourself' using errcode = 'insufficient_privilege';
      end if;
    elsif col = 'role' then
      -- Same RBAC as app.html changeUserRole: admins anywhere; a company_admin
      -- only inside their own workspace and only between operator and
      -- company_admin (never to or from admin/super_admin).
      if not (caller_role in ('admin', 'super_admin')
              or (caller_role = 'company_admin' and caller_company is not null
                  and old.company_id::text = caller_company
                  and old.role in ('operator', 'company_admin')
                  and new.role in ('operator', 'company_admin'))) then
        raise exception 'insufficient privileges to change a user role' using errcode = 'insufficient_privilege';
      end if;
      if (new.role = 'super_admin' or old.role = 'super_admin') and caller_role <> 'super_admin' then
        raise exception 'only super_admin may grant or revoke super_admin' using errcode = 'insufficient_privilege';
      end if;
    elsif col = 'company_id' then
      if caller_role not in ('admin', 'super_admin') then
        raise exception 'insufficient privileges to move a user between workspaces' using errcode = 'insufficient_privilege';
      end if;
    else
      -- email, id and every other column: machine callers only.
      raise exception 'column app_users.% cannot be changed from the client', col
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  return new;
end
$$;

drop trigger if exists app_users_guard_columns on public.app_users;
create trigger app_users_guard_columns
  before insert or update on public.app_users
  for each row execute function public.guard_app_users_columns();

create or replace function public.guard_companies_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role    text;
  caller_company text;
  col            text;
  -- Only used to give a precise error message; enforcement is the allowlist
  -- below (anything not name / live_stages_override is rejected).
  billing_keys text[] := array[
    'stripe_customer_id','stripe_subscription_id','subscription_status',
    'subscription_tier','plan_slug','project_limit','live_stages_limit',
    'current_period_end','trial_ends_at','last_paid_at','pass_slug',
    'pass_expires_at','extra_seats','seat_subscription_item_id',
    'setup_token','setup_pending','pending_name','pending_email'
  ];
begin
  if public._caller_is_machine() then
    return new;
  end if;

  caller_role    := public.caller_role();
  caller_company := public.caller_company_id();

  if tg_op = 'INSERT' then
    -- Admin "create workspace" is super_admin only (same as the RLS policy);
    -- signup-checkout creates companies with the service_role key.
    if caller_role <> 'super_admin' then
      raise exception 'only super_admin may create workspaces' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  foreach col in array public._changed_columns(to_jsonb(old), to_jsonb(new), tg_relid) loop
    if col = 'name' then
      if not (caller_role in ('admin', 'super_admin')
              or (caller_role = 'company_admin' and caller_company is not null and old.id::text = caller_company)) then
        raise exception 'only a company_admin of this workspace or a platform admin may rename it'
          using errcode = 'insufficient_privilege';
      end if;
    elsif col = 'live_stages_override' then
      -- The deliberate admin escape hatch.
      if caller_role not in ('admin', 'super_admin') then
        raise exception 'only platform admins may set live_stages_override' using errcode = 'insufficient_privilege';
      end if;
    elsif col = any (billing_keys) then
      raise exception 'column %.% is managed by billing and cannot be set from the client', tg_table_name, col
        using errcode = 'insufficient_privilege';
    else
      raise exception 'column %.% cannot be changed from the client', tg_table_name, col
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  return new;
end
$$;

drop trigger if exists companies_guard_columns on public.companies;
create trigger companies_guard_columns
  before insert or update on public.companies
  for each row execute function public.guard_companies_columns();

-- Trigger functions: Postgres does not check EXECUTE when a trigger fires,
-- so nobody needs it; revoked so they are not listed as client RPCs.
revoke all on function public.guard_app_users_columns() from public, anon, authenticated;
revoke all on function public.guard_companies_columns() from public, anon, authenticated;

-- ── 5. Admin RPCs (needed once rls_enable grants only UPDATE(name)) ────
-- Replaces app.html changeUserRole's direct PATCH of app_users.role.
create or replace function public.admin_set_user_role(p_user_id text, p_role text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text := public.caller_role();
  n int;
begin
  -- company_admin is allowed through here; the guard trigger on app_users
  -- limits them to operator <-> company_admin inside their own workspace,
  -- matching the existing admin UI.
  if v_role not in ('admin', 'super_admin', 'company_admin') then
    raise exception 'insufficient privileges to change a user role' using errcode = 'insufficient_privilege';
  end if;
  if p_role is null or p_role not in ('operator', 'company_admin', 'admin', 'super_admin') then
    raise exception 'unknown role %', p_role using errcode = 'invalid_parameter_value';
  end if;
  -- The guard trigger re-checks (super_admin rules) with the same caller.
  update public.app_users set role = p_role where id::text = p_user_id;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'user % not found', p_user_id using errcode = 'no_data_found';
  end if;
  return jsonb_build_object('ok', true, 'id', p_user_id, 'role', p_role);
end
$$;

-- Replaces app.html delCompany's three requests (detach users, detach
-- projects, delete company) with one atomic call. super_admin only, the same
-- rule as the companies_delete policy.
create or replace function public.admin_delete_company(p_company_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  n_users int; n_projects int; n_companies int;
begin
  if public.caller_role() <> 'super_admin' then
    raise exception 'only super_admin may delete a workspace' using errcode = 'insufficient_privilege';
  end if;
  if nullif(p_company_id, '') is null then
    raise exception 'company id required' using errcode = 'invalid_parameter_value';
  end if;
  -- '' is the app's existing "detached" marker (delCompany sets it too).
  update public.app_users set company_id = '' where company_id::text = p_company_id;
  get diagnostics n_users = row_count;
  update public.projects  set company_id = '' where company_id::text = p_company_id;
  get diagnostics n_projects = row_count;
  delete from public.companies where id::text = p_company_id;
  get diagnostics n_companies = row_count;
  return jsonb_build_object('ok', n_companies > 0, 'users_detached', n_users,
                            'projects_detached', n_projects, 'deleted', n_companies);
end
$$;

revoke all on function public.admin_set_user_role(text, text) from public, anon, authenticated;
revoke all on function public.admin_delete_company(text)      from public, anon, authenticated;
grant execute on function public.admin_set_user_role(text, text) to authenticated;
grant execute on function public.admin_delete_company(text)      to authenticated;
