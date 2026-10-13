-- ═══════════════════════════════════════════════════════════════════════
-- Optimistic concurrency for projects: projects.version + save_project()
-- + patch_show() + get_shared_project_version().
--
-- STATUS: NOT APPLIED. Run by hand. Runbook: docs/MIGRATIES.md (BOUWPLAN
-- 1.1f / 4.5.5).
--
-- PURPOSE
--   Today every save PATCHes the whole data blob: last write wins, and a
--   stale tab can silently overwrite a colleague's edits.
--   * projects.version bigint NOT NULL DEFAULT 0. A BEFORE UPDATE trigger
--     sets it to old.version + 1 whenever data / name / company_id change
--     (and keeps it unchanged otherwise). Clients can never set it: whatever
--     they send is overwritten. Existing direct PATCHes (current app) keep
--     working and bump the version too, so the RPCs below also detect
--     conflicts with old-style writers.
--   * save_project(p_id, p_expected_version, p_data [, p_name, p_force])
--       -> {ok:true, version}
--       -> {ok:false, conflict:true, version, name, data}   (server row)
--       -> {ok:false, error:'would_wipe', version}          (see below)
--       -> {ok:false, error:'deleted'}                       (soft-deleted)
--     The write happens only if the row is still at p_expected_version.
--     Wipe guard: refuses to replace a non-empty shows/stages array with an
--     empty one unless p_force => true (server-side twin of the client
--     wipe-guard, BOUWPLAN 1.1a).
--   * patch_show(p_id, p_show_id, p_fields) -> {ok:true, version, show}
--     Merge-friendly single-show edit: shallow-merges p_fields into that
--     show (`show || p_fields`; JSON null sets a field to null; "id" is
--     ignored) under the row lock. No expected version needed: two operators
--     editing different shows, or different fields of one show, both win.
--     -> {ok:false, error:'show_not_found', version} when the show is gone.
--   * get_shared_project_version(p_id) -> bigint (anon too). Lets public
--     views poll a few bytes and fetch the full project only on change
--     (BOUWPLAN 4.3).
--   Both write RPCs are SECURITY DEFINER with the SAME access rule as the
--   RLS policies: caller's workspace == project's workspace, or caller is
--   admin/super_admin. Anonymous callers are always refused.
--
-- PRECONDITIONS
--   * rls_prep applied (caller_role / caller_company_id).
--   * share_link_rpcs applied (_project_is_live).
--   * projects.data is jsonb (checked).
--   Works with RLS on or off.
--
-- APPLY ORDER
--   after rls_prep + share_link_rpcs; before project_history_soft_delete.
--   Independent of rls_enable and plan_enforcement.
--   The app does not need to change for this migration; it just starts
--   bumping versions. ADD COLUMN with a constant default is metadata-only on
--   PG 11+ (no table rewrite), but it takes a brief ACCESS EXCLUSIVE lock:
--   apply outside a live show.
--
-- APP CHANGE (other agent) to benefit:
--   * Keep `version` per project in APP (it comes back in select=* / realtime).
--   * _pushProject: rpc('save_project', {p_id, p_expected_version, p_data,
--     p_name}). On {conflict:true}: merge per show id against the returned
--     data (BOUWPLAN 1.1f) and retry with the returned version; never drop
--     the local edit silently. On {error:'would_wipe'}: adopt server state
--     and tell the user, as the client guard does today.
--   * Single-show edits (crew status, notes on a show, check-in by operator,
--     time correction of one show): rpc('patch_show', ...).
--   * Realtime/poll echo: ignore payloads whose version <= the version we
--     already have.
--
-- VERIFY
--   select column_name, data_type, column_default, is_nullable from information_schema.columns
--    where table_schema='public' and table_name='projects' and column_name='version';
--   -- as a logged-in user in the app console:
--   --   await _rpc('save_project',{p_id:APP.activeProjectId,p_expected_version:-1,p_data:G})
--   --   -> {ok:false, conflict:true, version:N, ...}   (and nothing written)
--   select id, version from public.projects order by version desc limit 5;
--   select has_function_privilege('anon','public.save_project(text,bigint,jsonb,text,boolean)','execute'),  -- false
--          has_function_privilege('authenticated','public._caller_can_write_project(text)','execute'),     -- false
--          has_function_privilege('anon','public.get_shared_project_version(text)','execute');            -- true
--
-- ROLLBACK
--   drop function if exists public.save_project(text, bigint, jsonb, text, boolean);
--   drop function if exists public.patch_show(text, text, jsonb);
--   drop function if exists public.get_shared_project_version(text);
--   drop trigger  if exists projects_version_bump on public.projects;
--   drop function if exists public.projects_version_bump();
--   alter table public.projects drop column if exists version;   -- only if
--     project_history_soft_delete is not applied (it records versions) and
--     no app version reads it.
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.caller_role()') is null or to_regprocedure('public.caller_company_id()') is null then
    raise exception 'project_versioning: apply rls_prep first';
  end if;
  if to_regprocedure('public._project_is_live(text)') is null then
    raise exception 'project_versioning: apply share_link_rpcs first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'projects'
                    and column_name = 'data' and data_type = 'jsonb') then
    raise exception 'project_versioning: public.projects.data must be jsonb';
  end if;
end $$;

-- ── Column + trigger ───────────────────────────────────────────────────
alter table public.projects add column if not exists version bigint not null default 0;

-- Also counts deleted_at once project_history_soft_delete has added it
-- (built from the live schema, so re-running this file never undoes that).
do $$
declare extra text := '';
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'projects' and column_name = 'deleted_at') then
    extra := ' or new.deleted_at is distinct from old.deleted_at';
  end if;
  execute format($f$
    create or replace function public.projects_version_bump()
    returns trigger
    language plpgsql
    as $b$
    begin
      new.version := old.version;  -- never client-controlled
      if new.data is distinct from old.data
         or new.name is distinct from old.name
         or new.company_id is distinct from old.company_id%s then
        new.version := old.version + 1;
      end if;
      return new;
    end
    $b$ $f$, extra);
end $$;

drop trigger if exists projects_version_bump on public.projects;
create trigger projects_version_bump
  before update on public.projects
  for each row execute function public.projects_version_bump();
-- Trigger functions need no EXECUTE grant to fire.
revoke all on function public.projects_version_bump() from public, anon, authenticated;

-- ── Access rule shared by the RPCs (mirrors the RLS policies) ──────────
create or replace function public._caller_can_write_project(p_company_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.caller_role() in ('admin', 'super_admin')
      or (public.caller_company_id() is not null and nullif(p_company_id, '') = public.caller_company_id())
$$;
revoke all on function public._caller_can_write_project(text) from public, anon, authenticated;

create or replace function public._json_array_len(p jsonb)
returns int
language sql
immutable
as $$
  select case when jsonb_typeof(p) = 'array' then jsonb_array_length(p) else 0 end
$$;
-- Internal helpers (also used by history / plan_enforcement): called only
-- from SECURITY DEFINER functions and triggers. Supabase grants EXECUTE on
-- new functions to anon/authenticated directly, hence revoked by name.
revoke all on function public._json_array_len(jsonb) from public, anon, authenticated;

-- ── save_project ───────────────────────────────────────────────────────
create or replace function public.save_project(
  p_id text,
  p_expected_version bigint,
  p_data jsonb,
  p_name text default null,
  p_force boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  v_row public.projects%rowtype;
  v_version bigint;
begin
  if p_id is null or p_expected_version is null then
    raise exception 'p_id and p_expected_version are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'p_data must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row from public.projects p where p.id::text = p_id for update;
  if not found or not public._caller_can_write_project(v_row.company_id::text) then
    -- Same answer for "missing" and "not yours": no existence oracle.
    raise exception 'project % not found or not accessible', p_id using errcode = 'insufficient_privilege';
  end if;
  if not public._project_is_live(p_id) then
    return jsonb_build_object('ok', false, 'error', 'deleted');
  end if;

  if v_row.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'version', v_row.version,
                              'name', v_row.name, 'data', v_row.data);
  end if;

  if not coalesce(p_force, false) and (
       (public._json_array_len(v_row.data -> 'shows')  > 0 and public._json_array_len(p_data -> 'shows')  = 0)
    or (public._json_array_len(v_row.data -> 'stages') > 0 and public._json_array_len(p_data -> 'stages') = 0)) then
    return jsonb_build_object('ok', false, 'error', 'would_wipe', 'version', v_row.version);
  end if;

  update public.projects p
     set data = p_data,
         name = coalesce(nullif(p_name, ''), p.name)
   where p.id = v_row.id
  returning p.version into v_version;

  return jsonb_build_object('ok', true, 'version', v_version);
end
$$;

comment on function public.save_project(text, bigint, jsonb, text, boolean) is
  'Compare-and-swap save of a whole project. Returns {ok,version} or {ok:false,conflict:true,version,name,data}.';

-- ── patch_show ─────────────────────────────────────────────────────────
create or replace function public.patch_show(p_id text, p_show_id text, p_fields jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  v_row     public.projects%rowtype;
  v_idx     int;
  v_show    jsonb;
  v_version bigint;
begin
  if p_id is null or p_show_id is null then
    raise exception 'p_id and p_show_id are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'p_fields must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row from public.projects p where p.id::text = p_id for update;
  if not found or not public._caller_can_write_project(v_row.company_id::text) then
    raise exception 'project % not found or not accessible', p_id using errcode = 'insufficient_privilege';
  end if;
  if not public._project_is_live(p_id) then
    return jsonb_build_object('ok', false, 'error', 'deleted');
  end if;

  select ord - 1, el into v_idx, v_show
  from jsonb_array_elements(case when jsonb_typeof(v_row.data -> 'shows') = 'array'
                                 then v_row.data -> 'shows' else '[]'::jsonb end)
       with ordinality t(el, ord)
  where el ->> 'id' = p_show_id
  limit 1;
  if v_idx is null then
    return jsonb_build_object('ok', false, 'error', 'show_not_found', 'version', v_row.version);
  end if;

  v_show := v_show || (p_fields - 'id');
  if v_show = (v_row.data -> 'shows' -> v_idx) then
    return jsonb_build_object('ok', true, 'version', v_row.version, 'show', v_show);  -- no-op
  end if;

  update public.projects p
     set data = jsonb_set(p.data, array['shows', v_idx::text], v_show, false)
   where p.id = v_row.id
  returning p.version into v_version;

  return jsonb_build_object('ok', true, 'version', v_version, 'show', v_show);
end
$$;

comment on function public.patch_show(text, text, jsonb) is
  'Merge p_fields into one show (shallow, id immutable) under the row lock. For single-show edits that must not clobber concurrent edits elsewhere in the project.';

-- ── get_shared_project_version (cheap poll for public views) ───────────
create or replace function public.get_shared_project_version(p_id text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select p.version from public.projects p
  where p.id::text = p_id and public._project_is_live(p_id)
$$;

revoke all on function public.save_project(text, bigint, jsonb, text, boolean) from public, anon, authenticated;
revoke all on function public.patch_show(text, text, jsonb)                     from public, anon, authenticated;
revoke all on function public.get_shared_project_version(text)                  from public, anon, authenticated;
grant execute on function public.save_project(text, bigint, jsonb, text, boolean) to authenticated;
grant execute on function public.patch_show(text, text, jsonb)                     to authenticated;
grant execute on function public.get_shared_project_version(text)                  to anon, authenticated;
