-- ═══════════════════════════════════════════════════════════════════════
-- RLS rollout, step 2 of 2: turn it on.
--
-- DO NOT apply this until the app.html that talks to get_shared_project /
-- set_show_arrived and sends the user JWT on every REST call is live.
-- Before this migration, anyone holding the public anon key (it is in the
-- page source) could read and write every row in these three tables.
--
-- Rollback, if a live event goes sideways:
--   alter table public.projects  disable row level security;
--   alter table public.app_users disable row level security;
--   alter table public.companies disable row level security;
--   grant all on public.projects, public.app_users, public.companies to anon;
-- ═══════════════════════════════════════════════════════════════════════

alter table public.projects  enable row level security;
alter table public.app_users enable row level security;
alter table public.companies enable row level security;

-- ── projects ───────────────────────────────────────────────────────────
-- A user sees the projects of their own workspace. Platform admins see all.
-- Anonymous share-link viewers do NOT match here - they go through
-- get_shared_project() instead.
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (
    company_id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  );

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    company_id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  );

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (
    company_id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  )
  with check (
    company_id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  );

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete to authenticated
  using (
    company_id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  );

-- ── app_users ──────────────────────────────────────────────────────────
-- Colleagues in the same workspace are visible (the crew picker and the
-- members list need that). Platform admins see everyone. Which COLUMNS may
-- change is enforced by app_users_guard_columns, not here.
drop policy if exists app_users_select on public.app_users;
create policy app_users_select on public.app_users
  for select to authenticated
  using (
    lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    or company_id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  );

drop policy if exists app_users_update on public.app_users;
create policy app_users_update on public.app_users
  for update to authenticated
  using (
    lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  )
  with check (
    lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  );

-- Creating and deleting users runs through the invite-member / remove-member
-- edge functions on the service_role key, which bypasses RLS. No client-side
-- insert or delete policy on purpose.

-- ── companies ──────────────────────────────────────────────────────────
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated
  using (
    id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  );

-- Renaming your own workspace is allowed; every billing column is blocked by
-- companies_guard_columns.
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies
  for update to authenticated
  using (
    id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  )
  with check (
    id = (select company_id from public.current_app_user())
    or (select role from public.current_app_user()) in ('admin', 'super_admin')
  );

drop policy if exists companies_insert on public.companies;
create policy companies_insert on public.companies
  for insert to authenticated
  with check ((select role from public.current_app_user()) = 'super_admin');

drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies
  for delete to authenticated
  using ((select role from public.current_app_user()) = 'super_admin');

-- ── Take the anon role off the tables entirely ─────────────────────────
-- Belt and braces on top of RLS: anonymous visitors keep exactly two doors,
-- get_shared_project() and set_show_arrived(), and no table access at all.
-- Note this also stops Realtime from delivering postgres_changes to public
-- share views - they fall back to their existing 1-second poll.
revoke all on public.projects  from anon;
revoke all on public.app_users from anon;
revoke all on public.companies from anon;
