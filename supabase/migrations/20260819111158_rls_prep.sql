-- ═══════════════════════════════════════════════════════════════════════
-- RLS rollout, step 1 of 2: helpers, guards and the public share-link RPCs.
--
-- This migration changes NO access on its own - RLS stays off. It only puts
-- the pieces in place that app.html needs before step 2 can safely flip RLS
-- on. Apply this, deploy the matching app.html, verify share links still
-- work, then apply the _rls_enable migration.
-- ═══════════════════════════════════════════════════════════════════════

-- ── Who is calling? ────────────────────────────────────────────────────
-- app.html resolves the current user by matching the JWT email against
-- app_users (see loadCurrentUser), not by auth.uid() - app_users.id is not
-- guaranteed to be the auth user id. The policies below use the same rule so
-- they can never disagree with the app about who someone is.
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

revoke all on function public.current_app_user() from public;
grant execute on function public.current_app_user() to authenticated;

-- ── Share-link read path ───────────────────────────────────────────────
-- Public viewers (mode=stage/backstage/foh/timeline/overview/wall/checkin)
-- have no session. Once RLS is on they lose all table access, so the single
-- project behind a share link is served through this function instead. Same
-- exposure as today (knowing the pid is enough), but it can no longer be
-- turned into "select * from projects".
create or replace function public.get_shared_project(p_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'id', p.id,
           'name', p.name,
           'company_id', p.company_id,
           'data', p.data
         )
  from public.projects p
  where p.id::text = p_id
$$;

comment on function public.get_shared_project(text) is
  'Single project behind a share link, for anonymous viewers. Explicit column list so future columns are not exposed by accident.';

grant execute on function public.get_shared_project(text) to anon, authenticated;

-- ── Share-link write path (artist check-in) ────────────────────────────
-- mode=checkin lets anyone with the link flip the "arrived" flag. The client
-- used to do read-modify-write on the whole data blob, which could clobber
-- concurrent operator edits. Doing it here is atomic and, more importantly,
-- limits an anonymous writer to exactly these two fields on one show.
create or replace function public.set_show_arrived(
  p_id text,
  p_show_id text,
  p_arrived boolean,
  p_arrived_at bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_idx int;
  v_data jsonb;
begin
  select p.data into v_data from public.projects p where p.id::text = p_id for update;
  if v_data is null or jsonb_typeof(v_data -> 'shows') <> 'array' then
    raise exception 'project % has no shows array', p_id using errcode = 'no_data_found';
  end if;

  select ord - 1 into v_idx
  from jsonb_array_elements(v_data -> 'shows') with ordinality t(el, ord)
  where el ->> 'id' = p_show_id
  limit 1;

  if v_idx is null then
    raise exception 'show % not found in project %', p_show_id, p_id using errcode = 'no_data_found';
  end if;

  v_data := jsonb_set(
    v_data,
    array['shows', v_idx::text],
    (v_data -> 'shows' -> v_idx)
      || jsonb_build_object(
           'arrived', p_arrived,
           'arrivedAt', case when p_arrived_at is null then 'null'::jsonb else to_jsonb(p_arrived_at) end
         )
  );

  update public.projects set data = v_data where id::text = p_id;
  return v_data;
end
$$;

comment on function public.set_show_arrived(text, text, boolean, bigint) is
  'Atomically toggle one show''s arrived flag for the public check-in view. The only write anonymous visitors get.';

grant execute on function public.set_show_arrived(text, text, boolean, bigint) to anon, authenticated;

-- ── Column guards ──────────────────────────────────────────────────────
-- RLS decides which ROWS you may touch, never which COLUMNS. Without these
-- triggers a company_admin who may legitimately update their own app_users
-- row could simply set role = 'super_admin', and could flip their own
-- workspace to subscription_status = 'active'. Triggers are not bypassed by
-- RLS, only by callers we explicitly wave through below.
create or replace function public._caller_is_machine()
returns boolean
language sql
stable
as $$
  -- No JWT at all: psql, SQL editor, migrations. Or an edge function /
  -- webhook using the service_role key. Both manage these columns on purpose.
  select coalesce(current_setting('request.jwt.claims', true), '') = ''
      or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
$$;

create or replace function public.guard_app_users_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
begin
  if public._caller_is_machine() then
    return new;
  end if;

  select u.role into caller_role
  from public.app_users u
  where lower(u.email) = lower(nullif(auth.jwt() ->> 'email', ''))
  limit 1;

  if new.role is distinct from old.role then
    if caller_role not in ('admin', 'super_admin') then
      raise exception 'insufficient privileges to change a user role'
        using errcode = 'insufficient_privilege';
    end if;
    if new.role = 'super_admin' and caller_role <> 'super_admin' then
      raise exception 'only super_admin may grant super_admin'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.company_id is distinct from old.company_id then
    if caller_role not in ('admin', 'super_admin') then
      raise exception 'insufficient privileges to move a user between workspaces'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists app_users_guard_columns on public.app_users;
create trigger app_users_guard_columns
  before update on public.app_users
  for each row execute function public.guard_app_users_columns();

create or replace function public.guard_companies_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  k text;
  -- Everything Stripe and the signup flow own. Listed as keys rather than
  -- NEW.<col> so this works whichever of them actually exist on the table.
  billing_keys text[] := array[
    'stripe_customer_id','stripe_subscription_id','subscription_status',
    'subscription_tier','plan_slug','project_limit','live_stages_limit',
    'current_period_end','trial_ends_at','last_paid_at','pass_expires_at',
    'extra_seats','setup_token','pending_name','pending_email'
  ];
  new_j jsonb := to_jsonb(new);
  old_j jsonb := to_jsonb(old);
begin
  if public._caller_is_machine() then
    return new;
  end if;

  foreach k in array billing_keys loop
    if (new_j ? k) and (new_j -> k) is distinct from (old_j -> k) then
      raise exception 'column %.% is managed by billing and cannot be set from the client', tg_table_name, k
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  -- live_stages_override is the deliberate admin escape hatch, so it stays
  -- writable - but only for platform admins.
  if (new_j ? 'live_stages_override')
     and (new_j -> 'live_stages_override') is distinct from (old_j -> 'live_stages_override') then
    select u.role into caller_role
    from public.app_users u
    where lower(u.email) = lower(nullif(auth.jwt() ->> 'email', ''))
    limit 1;
    if caller_role not in ('admin', 'super_admin') then
      raise exception 'only platform admins may set live_stages_override'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists companies_guard_columns on public.companies;
create trigger companies_guard_columns
  before update on public.companies
  for each row execute function public.guard_companies_columns();
