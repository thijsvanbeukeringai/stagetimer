-- ═══════════════════════════════════════════════════════════════════════
-- Project history (project_versions) + soft delete (projects.deleted_at)
-- + restore RPCs.
--
-- STATUS: NOT APPLIED. Run by hand. Runbook: docs/MIGRATIES.md (BOUWPLAN 4.5.6).
--
-- PURPOSE
--   Today a wipe, a bad import or a deleted project is only recoverable via a
--   Supabase backup. After this migration:
--   * public.project_versions keeps snapshots of the OLD row (data, name,
--     other columns) written by an AFTER UPDATE/DELETE trigger on projects.
--       - DELETE (hard delete, what the current app does): always snapshotted.
--       - UPDATE: snapshotted when the last snapshot of that project is older
--         than history_min_interval_seconds (default 300 s), OR the update
--         removes shows or stages, OR it toggles deleted_at. So at most ~12
--         snapshots per hour of editing, plus one for every destructive edit.
--         Check-ins and other small edits are absorbed by the interval.
--     Retention (both caps apply): newest history_keep_count (50) per
--     project AND younger than history_keep_days (30). The latest DELETE
--     snapshot of a project is exempt from the count cap (it is the restore
--     point) but not from the 30 days. After 30 days deleted data is really
--     gone (AVG-friendly; PITR/backups are the longer-term net).
--     Pruning: per project on every snapshot (count cap) + prune_project_versions()
--     daily via pg_cron when that extension is installed (age cap).
--   * projects.deleted_at / deleted_by + RPCs:
--       soft_delete_project(p_id)         -> {ok}
--       restore_project(p_id)             -> {ok, source:'soft'|'history'}
--                                            (undo soft delete, or re-create
--                                            a HARD-deleted project from its
--                                            last DELETE snapshot)
--       list_deleted_projects()           -> rows for the caller's workspace
--       list_project_versions(p_id)       -> metadata only (no data)
--       restore_project_version(p_version_id) -> {ok, version}
--       purge_deleted_projects()          -> machine only (cron), hard-deletes
--                                            projects soft-deleted > 30 days
--     Access rule = the RLS rule (own workspace, or admin/super_admin).
--     Restores bypass the plan-limit trigger (the data existed before).
--   * Soft-deleted projects disappear from share links, save_project,
--     patch_show and set_show_arrived (_project_is_live is redefined).
--
--   The table has RLS enabled, NO policies and NO grants for anon /
--   authenticated: only the SECURITY DEFINER functions above read it.
--
-- STORAGE NOTE: snapshots hold the full data blob, including base64 photos.
--   Worst case per project ~= 50 x blob size. Check after a week:
--     select pg_size_pretty(pg_total_relation_size('public.project_versions'));
--   Lower history_keep_count or raise history_min_interval_seconds in
--   public.backend_settings if it grows too fast.
--
-- APP CHANGES (other agent) - NOT needed for this migration to be safe:
--   * Until the app changes, nothing soft-deletes: deleteProject still hard
--     deletes, and the DELETE snapshot makes that restorable for 30 days
--     (via restore_project(p_id) in the SQL editor or a future admin UI).
--   * To switch to soft delete:
--       - deleteProject: rpc('soft_delete_project', {p_id}) instead of DELETE.
--       - loadAPPRemote: _restGet('projects', ...) must filter
--         `deleted_at=is.null` (append &deleted_at=is.null to the URL).
--       - _pushProject peek + any other projects reads: same filter.
--       - setupRealtime: an UPDATE whose payload.new.deleted_at is set must be
--         handled like a DELETE (remove from APP.projects, close if active).
--       - Optional "Recently deleted" list: rpc('list_deleted_projects') +
--         rpc('restore_project', {p_id}).
--     Later, once every client filters, the RLS select policy can add
--     `and deleted_at is null` (see the commented block at the end).
--
-- PRECONDITIONS
--   * rls_prep, share_link_rpcs, project_versioning applied (checked).
--
-- APPLY ORDER: after project_versioning. Independent of rls_enable and
--   plan_enforcement. ADD COLUMN is metadata-only; brief ACCESS EXCLUSIVE
--   lock on projects -> not during a live show.
--
-- VERIFY
--   select key, value from public.backend_settings order by key;
--   select tgname from pg_trigger where tgrelid = 'public.projects'::regclass and not tgisinternal;
--   -- make an edit in the app, wait > 5 min, make another, then:
--   select project_id, version, op, changed_at, changed_by
--     from public.project_versions order by id desc limit 10;
--   select has_table_privilege('authenticated','public.project_versions','select');  -- false
--   select * from cron.job where jobname like 'stagetimer_%';   -- if pg_cron exists
--
-- ROLLBACK (history is lost on drop; export it first if needed:
--   copy (select * from public.project_versions) to stdout ...)
--   select cron.unschedule('stagetimer_prune_project_versions');   -- if scheduled
--   select cron.unschedule('stagetimer_purge_deleted_projects');   -- if scheduled
--   drop trigger if exists projects_history on public.projects;
--   drop function if exists public.projects_history(), public.prune_project_versions(),
--     public.purge_deleted_projects(), public.soft_delete_project(text),
--     public.restore_project(text), public.list_deleted_projects(),
--     public.list_project_versions(text), public.restore_project_version(bigint);
--   drop table if exists public.project_versions;
--   -- restore the previous helpers:
--   create or replace function public._project_is_live(p_id text) returns boolean
--     language sql stable security definer set search_path = public
--     as $f$ select exists (select 1 from public.projects p where p.id::text = p_id) $f$;
--   -- (re-run the projects_version_bump definition from project_versioning)
--   -- deleted_at/deleted_by: first un-delete or hard-delete soft-deleted
--   -- rows, then: alter table public.projects drop column deleted_at, drop column deleted_by;
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.caller_role()') is null then
    raise exception 'project_history: apply rls_prep first';
  end if;
  if to_regprocedure('public._project_is_live(text)') is null then
    raise exception 'project_history: apply share_link_rpcs first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'projects' and column_name = 'version') then
    raise exception 'project_history: apply project_versioning first';
  end if;
end $$;

-- ── Settings (shared with plan_enforcement; no client access) ──────────
create table if not exists public.backend_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.backend_settings enable row level security;
revoke all on public.backend_settings from anon, authenticated;
insert into public.backend_settings (key, value) values
  ('history_min_interval_seconds', '300'),
  ('history_keep_count', '50'),
  ('history_keep_days', '30')
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
revoke all on function public._setting(text, text) from public;

-- ── Soft delete columns ────────────────────────────────────────────────
alter table public.projects add column if not exists deleted_at timestamptz;
alter table public.projects add column if not exists deleted_by text;
create index if not exists projects_deleted_at_idx on public.projects (deleted_at) where deleted_at is not null;

create or replace function public._project_is_live(p_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.projects p where p.id::text = p_id and p.deleted_at is null)
$$;
revoke all on function public._project_is_live(text) from public;

create or replace function public.projects_version_bump()
returns trigger
language plpgsql
as $$
begin
  new.version := old.version;  -- never client-controlled
  if new.data is distinct from old.data
     or new.name is distinct from old.name
     or new.company_id is distinct from old.company_id
     or new.deleted_at is distinct from old.deleted_at then
    new.version := old.version + 1;
  end if;
  return new;
end
$$;

-- ── History table ──────────────────────────────────────────────────────
create table if not exists public.project_versions (
  id           bigint generated always as identity primary key,
  project_id   text        not null,
  company_id   text,
  version      bigint,
  op           text        not null check (op in ('UPDATE', 'DELETE')),
  name         text,
  data         jsonb,
  row_meta     jsonb,       -- every other projects column of the OLD row
  changed_at   timestamptz not null default now(),
  changed_by   text,        -- JWT email, else JWT role, else 'sql'
  reason       text         -- 'interval' | 'shrink' | 'soft_delete' | 'forced' | 'delete'
);
create index if not exists project_versions_project_idx
  on public.project_versions (project_id, changed_at desc, id desc);
alter table public.project_versions enable row level security;
revoke all on public.project_versions from anon, authenticated;

create or replace function public._caller_label()
returns text
language sql
stable
as $$
  select coalesce(nullif(auth.jwt() ->> 'email', ''), nullif(auth.jwt() ->> 'role', ''), 'sql')
$$;

create or replace function public.projects_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
  v_last   timestamptz;
  v_keep   int;
begin
  if current_setting('stagetimer.skip_history', true) = 'on' then
    return null;
  end if;

  if tg_op = 'DELETE' then
    v_reason := 'delete';
  else
    if old.data is not distinct from new.data
       and old.name is not distinct from new.name
       and old.deleted_at is not distinct from new.deleted_at then
      return null;                                     -- nothing worth keeping
    end if;
    if current_setting('stagetimer.force_snapshot', true) = 'on' then
      v_reason := 'forced';
    elsif old.deleted_at is distinct from new.deleted_at then
      v_reason := 'soft_delete';
    elsif public._json_array_len(new.data -> 'shows')  < public._json_array_len(old.data -> 'shows')
       or public._json_array_len(new.data -> 'stages') < public._json_array_len(old.data -> 'stages') then
      v_reason := 'shrink';
    else
      select max(v.changed_at) into v_last from public.project_versions v where v.project_id = old.id::text;
      if v_last is not null
         and v_last > now() - make_interval(secs => public._setting('history_min_interval_seconds', '300')::int) then
        return null;                                   -- throttled
      end if;
      v_reason := 'interval';
    end if;
  end if;

  insert into public.project_versions (project_id, company_id, version, op, name, data, row_meta, changed_by, reason)
  values (old.id::text, nullif(old.company_id::text, ''), old.version, tg_op, old.name, old.data,
          to_jsonb(old) - 'data', public._caller_label(), v_reason);

  -- Count cap for this project (the newest DELETE snapshot is exempt).
  v_keep := public._setting('history_keep_count', '50')::int;
  delete from public.project_versions v
   where v.project_id = old.id::text
     and v.id not in (select x.id from public.project_versions x
                       where x.project_id = old.id::text
                       order by x.changed_at desc, x.id desc
                       limit v_keep)
     and v.id is distinct from (select max(y.id) from public.project_versions y
                                 where y.project_id = old.id::text and y.op = 'DELETE');
  return null;
end
$$;

drop trigger if exists projects_history on public.projects;
create trigger projects_history
  after update or delete on public.projects
  for each row execute function public.projects_history();

-- ── Cleanup ────────────────────────────────────────────────────────────
create or replace function public.prune_project_versions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n_age int; n_count int;
begin
  delete from public.project_versions
   where changed_at < now() - make_interval(days => public._setting('history_keep_days', '30')::int);
  get diagnostics n_age = row_count;

  delete from public.project_versions v
  using (select id,
                row_number() over (partition by project_id order by changed_at desc, id desc) rn,
                op,
                max(id) filter (where op = 'DELETE') over (partition by project_id) last_delete
           from public.project_versions) r
   where v.id = r.id
     and r.rn > public._setting('history_keep_count', '50')::int
     and r.id is distinct from r.last_delete;
  get diagnostics n_count = row_count;
  return n_age + n_count;
end
$$;

-- Hard-delete projects that have been in the bin longer than keep_days.
-- No snapshot: the user already had keep_days to restore.
create or replace function public.purge_deleted_projects()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  perform set_config('stagetimer.skip_history', 'on', true);
  delete from public.projects
   where deleted_at is not null
     and deleted_at < now() - make_interval(days => public._setting('history_keep_days', '30')::int);
  get diagnostics n = row_count;
  perform set_config('stagetimer.skip_history', 'off', true);
  return n;
end
$$;

revoke all on function public.prune_project_versions()  from public;
revoke all on function public.purge_deleted_projects()  from public;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('stagetimer_prune_project_versions', '17 4 * * *',
                          'select public.prune_project_versions()');
    perform cron.schedule('stagetimer_purge_deleted_projects', '27 4 * * *',
                          'select public.purge_deleted_projects()');
  else
    raise notice 'pg_cron not installed: run select public.prune_project_versions(), public.purge_deleted_projects(); periodically (or enable pg_cron and re-run this block)';
  end if;
end $$;

-- ── Soft delete / restore RPCs ─────────────────────────────────────────
create or replace function public.soft_delete_project(p_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_company text; v_deleted timestamptz;
begin
  select p.company_id::text, p.deleted_at into v_company, v_deleted
    from public.projects p where p.id::text = p_id for update;
  if not found or not public._caller_can_write_project(v_company) then
    raise exception 'project % not found or not accessible', p_id using errcode = 'insufficient_privilege';
  end if;
  if v_deleted is null then
    update public.projects set deleted_at = now(), deleted_by = public._caller_label() where id::text = p_id;
  end if;
  return jsonb_build_object('ok', true);
end
$$;

create or replace function public.restore_project(p_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_company text;
  v_deleted timestamptz;
  v_snap    public.project_versions%rowtype;
begin
  select p.company_id::text, p.deleted_at into v_company, v_deleted
    from public.projects p where p.id::text = p_id for update;
  if found then
    if not public._caller_can_write_project(v_company) then
      raise exception 'project % not found or not accessible', p_id using errcode = 'insufficient_privilege';
    end if;
    if v_deleted is not null then
      perform set_config('stagetimer.skip_plan_guard', 'on', true);
      update public.projects set deleted_at = null, deleted_by = null where id::text = p_id;
      perform set_config('stagetimer.skip_plan_guard', 'off', true);
    end if;
    return jsonb_build_object('ok', true, 'source', 'soft');
  end if;

  -- Hard-deleted: re-create from the newest DELETE snapshot.
  select * into v_snap from public.project_versions v
   where v.project_id = p_id and v.op = 'DELETE'
   order by v.id desc limit 1;
  if not found or not public._caller_can_write_project(v_snap.company_id) then
    raise exception 'no restorable copy of project % (or not accessible)', p_id using errcode = 'insufficient_privilege';
  end if;

  perform set_config('stagetimer.skip_plan_guard', 'on', true);
  insert into public.projects
  select * from jsonb_populate_record(
           null::public.projects,
           coalesce(v_snap.row_meta, '{}'::jsonb)
             || jsonb_build_object('id', v_snap.project_id, 'name', v_snap.name, 'data', v_snap.data,
                                   'deleted_at', null, 'deleted_by', null,
                                   'version', coalesce(v_snap.version, 0) + 1));
  perform set_config('stagetimer.skip_plan_guard', 'off', true);
  return jsonb_build_object('ok', true, 'source', 'history');
end
$$;

create or replace function public.list_deleted_projects()
returns table (id text, name text, company_id text, deleted_at timestamptz, deleted_by text, source text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id::text, p.name, p.company_id::text, p.deleted_at, p.deleted_by, 'soft'
    from public.projects p
   where p.deleted_at is not null
     and public._caller_can_write_project(p.company_id::text)
  union all
  select d.project_id, d.name, d.company_id, d.changed_at, d.changed_by, 'history'
    from (select distinct on (v.project_id) v.*
            from public.project_versions v
           where v.op = 'DELETE'
           order by v.project_id, v.id desc) d
   where not exists (select 1 from public.projects p where p.id::text = d.project_id)
     and public._caller_can_write_project(d.company_id)
  order by 4 desc
$$;

create or replace function public.list_project_versions(p_id text)
returns table (version_id bigint, version bigint, op text, name text, changed_at timestamptz,
               changed_by text, reason text, shows int, stages int)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, v.version, v.op, v.name, v.changed_at, v.changed_by, v.reason,
         public._json_array_len(v.data -> 'shows'), public._json_array_len(v.data -> 'stages')
    from public.project_versions v
   where v.project_id = p_id
     and public._caller_can_write_project(v.company_id)
   order by v.changed_at desc, v.id desc
$$;

-- Put an old snapshot back as the current data. The current state is
-- snapshotted first (forced), so a restore can itself be undone.
create or replace function public.restore_project_version(p_version_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_snap    public.project_versions%rowtype;
  v_company text;
  v_version bigint;
begin
  select * into v_snap from public.project_versions where id = p_version_id;
  if not found or not public._caller_can_write_project(v_snap.company_id) then
    raise exception 'version % not found or not accessible', p_version_id using errcode = 'insufficient_privilege';
  end if;
  select p.company_id::text into v_company from public.projects p where p.id::text = v_snap.project_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'project_deleted_use_restore_project');
  end if;
  if not public._caller_can_write_project(v_company) then
    raise exception 'project not accessible' using errcode = 'insufficient_privilege';
  end if;

  perform set_config('stagetimer.force_snapshot', 'on', true);
  perform set_config('stagetimer.skip_plan_guard', 'on', true);
  update public.projects p
     set data = v_snap.data, name = coalesce(v_snap.name, p.name), deleted_at = null, deleted_by = null
   where p.id::text = v_snap.project_id
  returning p.version into v_version;
  perform set_config('stagetimer.force_snapshot', 'off', true);
  perform set_config('stagetimer.skip_plan_guard', 'off', true);
  return jsonb_build_object('ok', true, 'version', v_version);
end
$$;

revoke all on function public.soft_delete_project(text)       from public;
revoke all on function public.restore_project(text)           from public;
revoke all on function public.list_deleted_projects()         from public;
revoke all on function public.list_project_versions(text)     from public;
revoke all on function public.restore_project_version(bigint) from public;
grant execute on function public.soft_delete_project(text)       to authenticated;
grant execute on function public.restore_project(text)           to authenticated;
grant execute on function public.list_deleted_projects()         to authenticated;
grant execute on function public.list_project_versions(text)     to authenticated;
grant execute on function public.restore_project_version(bigint) to authenticated;

-- ── LATER (after every client filters deleted_at) - do not run now ─────
-- Hides soft-deleted rows from table reads; the RPCs above still see them.
--   alter policy projects_select on public.projects using (
--     deleted_at is null and (
--       company_id::text = (select public.caller_company_id())
--       or (select public.caller_role()) in ('admin', 'super_admin')));
-- Rollback: re-run the projects_select policy from rls_enable.
