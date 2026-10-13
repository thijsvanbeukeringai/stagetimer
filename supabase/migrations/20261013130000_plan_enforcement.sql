-- ═══════════════════════════════════════════════════════════════════════
-- Server-side plan enforcement on projects: subscription gate on INSERT,
-- live-stage limit on stage-count INCREASES.
--
-- STATUS: NOT APPLIED. Run by hand. Runbook: docs/MIGRATIES.md (BOUWPLAN 4.5.4).
--
-- PURPOSE
--   Today the plan is only enforced in app.html (canCreateProject,
--   checkStageLimit), so anyone with a session (or, before RLS, the anon key)
--   can create projects and stages regardless of payment. This adds a BEFORE
--   INSERT OR UPDATE trigger on projects. It is a trigger, not an RLS policy,
--   so it works whether or not rls_enable has been applied, and it returns a
--   readable error.
--
--   1. INSERT gate. A new project needs its workspace to have
--        subscription_status in ('active','trialing','past_due')
--        or an unexpired event pass (pass_expires_at > now()),
--      unless the caller is admin / super_admin (as canCreateProject).
--      'trialing' counts as active (decision B2). NOTE the app is stricter
--      today (blocks past_due, ignores passes); the server is the floor.
--
--   2. Stage limit, mirroring app.html _effectiveStageLimit exactly, except
--      that 'trialing' is treated like 'active' (B2):
--        caller super_admin                    -> unlimited
--        workspace not found / project detached -> 1
--        companies.live_stages_override set    -> override   (0 = locked)
--        pass_expires_at > now()               -> unlimited
--        status active|trialing|past_due AND plan_slug set
--                                              -> live_stages_limit (NULL = unlimited)
--        otherwise                             -> 0
--      Checked ONLY when a write INCREASES the number of entries in
--      data->'stages'. A project that is already over its limit (legacy
--      plans, lapsed subscription mid-festival, an admin lowering the
--      override) can always be saved, edited and shrunk - it just cannot
--      grow. Live-show safety first.
--
--   Machine callers (service_role, SQL editor, cron) and the restore RPCs
--   (stagetimer.skip_plan_guard) are never checked.
--
--   EXECUTE: nothing in this file is callable by anon or authenticated.
--   company_stage_limit / company_can_create_projects accept any company id,
--   so granting them would leak other workspaces' billing state.
--
-- ENFORCEMENT MODE  (public.backend_settings key 'plan_enforcement')
--   'log'     DEFAULT. Violations are written to public.plan_violations and
--             the write SUCCEEDS. Run like this for at least a week.
--   'enforce' Violations raise SQLSTATE PT402 (PostgREST answers HTTP 402),
--             DETAIL 'subscription_required' or 'stage_limit_exceeded'.
--   'off'     Trigger does nothing.
--   Switch:   update public.backend_settings set value='enforce', updated_at=now()
--              where key='plan_enforcement';
--
--   LIVE-SHOW WARNING for 'enforce': the current app sends the WHOLE project
--   on every save. If a save is rejected because it adds a stage, every
--   following save of that tab (including time corrections during a show)
--   is rejected too until the stage is removed locally. So only switch to
--   'enforce' when (a) plan_violations stays empty for real customers and
--   (b) the app handles HTTP 402 / 'stage_limit_exceeded' by removing the
--   rejected stage and telling the operator (other agent). A stale tab that
--   still holds a stage a colleague deleted also counts as an "increase";
--   save_project (version check) is the real fix for that.
--
-- PRECONDITIONS
--   * rls_prep applied (caller_role, _caller_is_machine) - checked.
--   * companies has subscription_status, plan_slug, live_stages_limit,
--     live_stages_override, pass_expires_at - checked.
--   * The LIVE app sends the user JWT on project writes (improve/2026-10-13
--     or later). With the old app (anon key on saves) super_admin/admin
--     bypasses cannot work, because the caller is anonymous.
--
-- APPLY ORDER: after rls_prep and the app deploy above. Independent of
--   rls_enable / versioning / history. CREATE TRIGGER takes a brief lock on
--   projects: not during a live show. In 'log' mode it cannot block anything.
--
-- VERIFY
--   select key, value from public.backend_settings where key = 'plan_enforcement';  -- log
--   select id, name, subscription_status, plan_slug, live_stages_limit, live_stages_override,
--          pass_expires_at, public.company_stage_limit(id::text) eff_limit,
--          public.company_can_create_projects(id::text) can_create
--     from public.companies order by name;
--   -- Compare eff_limit with what the admin screen shows per workspace.
--   -- Projects that are ALREADY over their limit (allowed to stay that way):
--   select p.id, p.name, c.name company, public._json_array_len(p.data->'stages') stages,
--          public.company_stage_limit(p.company_id::text) lim
--     from public.projects p left join public.companies c on c.id::text = p.company_id::text
--    where public.company_stage_limit(p.company_id::text) is not null
--      and public._json_array_len(p.data->'stages') > public.company_stage_limit(p.company_id::text);
--   -- No client can call the plan helpers (all false):
--   select has_function_privilege('authenticated','public.company_stage_limit(text)','execute'),
--          has_function_privilege('authenticated','public.company_can_create_projects(text)','execute'),
--          has_function_privilege('anon','public._plan_violation(text,text,text,jsonb)','execute');
--   -- After a week in 'log' mode:
--   select kind, company_id, count(*), max(at) from public.plan_violations group by 1,2 order by 4 desc;
--
-- ROLLBACK
--   update public.backend_settings set value = 'off' where key = 'plan_enforcement';  -- instant, no lock
--   -- full removal:
--   drop trigger if exists projects_plan_guard on public.projects;
--   drop function if exists public.projects_plan_guard(), public._plan_violation(text, text, text, jsonb),
--     public.company_stage_limit(text), public.company_can_create_projects(text);
--   drop table if exists public.plan_violations;
--   delete from public.backend_settings where key = 'plan_enforcement';
-- ═══════════════════════════════════════════════════════════════════════

do $$
declare missing text;
begin
  if to_regprocedure('public.caller_role()') is null or to_regprocedure('public._caller_is_machine()') is null then
    raise exception 'plan_enforcement: apply rls_prep first';
  end if;
  select string_agg(c, ', ') into missing
  from unnest(array['subscription_status','plan_slug','live_stages_limit','live_stages_override','pass_expires_at']) c
  where not exists (select 1 from information_schema.columns ic
                     where ic.table_schema = 'public' and ic.table_name = 'companies' and ic.column_name = c);
  if missing is not null then
    raise exception 'plan_enforcement: companies is missing columns %', missing;
  end if;
end $$;

-- ── Settings + violation log ───────────────────────────────────────────
create table if not exists public.backend_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.backend_settings enable row level security;
revoke all on public.backend_settings from anon, authenticated;
insert into public.backend_settings (key, value) values ('plan_enforcement', 'log')
on conflict (key) do nothing;

create or replace function public._setting(p_key text, p_default text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.backend_settings where key = p_key), p_default)
$$;
-- Supabase grants EXECUTE on new functions to anon/authenticated directly,
-- so every helper in this file is revoked by name, not only from public.
revoke all on function public._setting(text, text) from public, anon, authenticated;

create or replace function public._json_array_len(p jsonb)
returns int
language sql
immutable
as $$
  select case when jsonb_typeof(p) = 'array' then jsonb_array_length(p) else 0 end
$$;
revoke all on function public._json_array_len(jsonb) from public, anon, authenticated;

create table if not exists public.plan_violations (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  kind        text not null,        -- 'subscription_required' | 'stage_limit_exceeded'
  mode        text not null,        -- mode at the time ('log' rows were allowed through)
  project_id  text,
  company_id  text,
  caller      text,
  detail      jsonb
);
create index if not exists plan_violations_at_idx on public.plan_violations (at desc);
alter table public.plan_violations enable row level security;
revoke all on public.plan_violations from anon, authenticated;

-- ── Plan rules (mirror of app.html) ────────────────────────────────────
-- Effective live-stage limit of a workspace, independent of the caller.
-- NULL = unlimited. Mirrors _effectiveStageLimit minus the super_admin
-- short-cut (handled in the trigger) and with trialing = active (B2).
-- Columns are cast via text so this works whether pass_expires_at is a
-- timestamptz or an ISO string, and the limits are int or numeric.
create or replace function public.company_stage_limit(p_company_id text)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c record;
begin
  select co.subscription_status::text                         as status,
         nullif(co.plan_slug::text, '')                         as plan_slug,
         nullif(co.live_stages_limit::text, '')::numeric::int   as lim,
         nullif(co.live_stages_override::text, '')::numeric::int as ovr,
         nullif(co.pass_expires_at::text, '')::timestamptz      as pass_until
    into c
    from public.companies co
   where co.id::text = nullif(p_company_id, '');
  if not found then
    return 1;                                   -- app: if(!co) return 1
  end if;
  if c.ovr is not null then
    return c.ovr;                               -- admin override wins (0 = locked)
  end if;
  if c.pass_until is not null and c.pass_until > now() then
    return null;                                -- active event pass: unlimited
  end if;
  if c.status in ('active', 'trialing', 'past_due') and c.plan_slug is not null then
    return c.lim;                               -- NULL = unlimited plan
  end if;
  return 0;
end
$$;

create or replace function public.company_can_create_projects(p_company_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select co.subscription_status::text in ('active', 'trialing', 'past_due')
           or coalesce(nullif(co.pass_expires_at::text, '')::timestamptz > now(), false)
      from public.companies co
     where co.id::text = nullif(p_company_id, '')), false)
$$;

-- Not granted to clients: they take ANY company id and would tell one
-- workspace another one's plan state. Only the trigger (owner) and the SQL
-- editor use them; app.html computes its own limit from its own company row.
revoke all on function public.company_stage_limit(text)         from public, anon, authenticated;
revoke all on function public.company_can_create_projects(text) from public, anon, authenticated;

-- ── Violation handler ──────────────────────────────────────────────────
create or replace function public._plan_violation(p_kind text, p_project_id text, p_company_id text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_mode text := public._setting('plan_enforcement', 'log');
begin
  if v_mode = 'enforce' then
    raise exception using
      errcode = 'PT402',
      message = case p_kind
                  when 'stage_limit_exceeded' then
                    format('Your plan includes %s live stage(s). Remove a stage or upgrade to add more.',
                           coalesce(p_detail ->> 'limit', '?'))
                  else 'This workspace has no active subscription or event pass.'
                end,
      detail  = p_kind,
      hint    = p_detail::text;
  end if;
  insert into public.plan_violations (kind, mode, project_id, company_id, caller, detail)
  values (p_kind, v_mode, p_project_id, p_company_id,
          coalesce(nullif(auth.jwt() ->> 'email', ''), nullif(auth.jwt() ->> 'role', ''), 'sql'), p_detail);
end
$$;
revoke all on function public._plan_violation(text, text, text, jsonb) from public, anon, authenticated;

-- ── Trigger ────────────────────────────────────────────────────────────
create or replace function public.projects_plan_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  text;
  v_new   int;
  v_old   int;
  v_limit int;
begin
  if public._caller_is_machine()
     or current_setting('stagetimer.skip_plan_guard', true) = 'on'
     or public._setting('plan_enforcement', 'log') = 'off' then
    return new;
  end if;

  v_role := public.caller_role();   -- '' for anonymous / unknown callers

  if tg_op = 'INSERT'
     and v_role not in ('admin', 'super_admin')
     and not public.company_can_create_projects(new.company_id::text) then
    perform public._plan_violation('subscription_required', new.id::text, new.company_id::text,
                                   jsonb_build_object('op', tg_op));
  end if;

  v_new := public._json_array_len(new.data -> 'stages');
  v_old := case when tg_op = 'UPDATE' then public._json_array_len(old.data -> 'stages') else 0 end;

  -- Only an INCREASE is ever checked: existing projects over the limit keep
  -- saving normally.
  if v_new > v_old and v_role <> 'super_admin' then
    v_limit := public.company_stage_limit(new.company_id::text);
    if v_limit is not null and v_new > v_limit then
      perform public._plan_violation('stage_limit_exceeded', new.id::text, new.company_id::text,
                                     jsonb_build_object('op', tg_op, 'limit', v_limit,
                                                        'stages_before', v_old, 'stages_after', v_new));
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists projects_plan_guard on public.projects;
create trigger projects_plan_guard
  before insert or update on public.projects
  for each row execute function public.projects_plan_guard();
-- Trigger functions need no EXECUTE grant to fire.
revoke all on function public.projects_plan_guard() from public, anon, authenticated;
