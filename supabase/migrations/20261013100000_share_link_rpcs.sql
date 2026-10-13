-- ═══════════════════════════════════════════════════════════════════════
-- Share-link RPCs: get_shared_project (legacy 1-arg + per-mode 2-arg) and a
-- field-level set_show_arrived.
--
-- STATUS: NOT APPLIED. Run by hand. Runbook: docs/MIGRATIES.md.
--
-- PURPOSE
--   Public viewers (?mode=stage|backstage|foh|timeline|overview|wall|checkin
--   &pid=...) have no session. Once RLS is on they have no table access, so
--   the one project behind a share link is served through these functions.
--   (These definitions used to live in rls_prep; this file supersedes them.)
--
--   get_shared_project(p_id)          LEGACY. Unchanged output (full data
--                                     blob). Kept so app versions that are
--                                     already deployed / cached keep working.
--   get_shared_project(p_id, p_mode)  NEW. Same shape {id,name,company_id,data}
--                                     but data only contains what that mode
--                                     renders (company_id is always null):
--
--     field (in data)      stage backstage foh timeline overview wall checkin
--     fohNotes               -      yes     yes    -        -      -     -
--     shows[].note           -      yes      -     -        -      -     -
--     shows[].crew           -       -      yes    -        -      -     -
--     shows[].photo          -       -       -     -        -      -     -
--     memberIds              -       -       -     -        -      -     -
--     logo                   -      yes     yes    -        -      -     -
--   ("-" = stripped; fohNotes -> {}, memberIds -> [], others removed.)
--   The JS twin of this matrix is tests/support/share-modes.js (the mock
--   backend serves the 2-arg call with it; tests/regression/share-mode.spec.js
--   checks this table and keep_* below against it).
--
--   Kept for EVERY mode (needed by the shared time model, the cue/blackout
--   overlays and what each screen draws; nothing personal or large):
--     stages[] (id, name)          all modes (stage name, stage columns)
--     days[] (id, name, date)      all modes (festival day, day labels)
--     shows[] id, stage, day, artist, date, start, end, startsAt, endsAt,
--             endsNextDay, cancelled, hidden
--                                  all modes (live / next / done maths)
--     shows[].genre                stage (#sv-genre)
--     shows[].booth                backstage, foh, timeline (booth badge)
--     shows[].type                 backstage, foh (item-type badge)
--     shows[].priority             wall, timeline, overview (star / tint)
--     shows[].arrived, arrivedAt   checkin, overview, timeline (check-in dot)
--     activeStage, activeDay       all (fallback when the link has no sid /
--                                  no day is dated today)
--     timerMode                    loadG default; harmless
--     svModes                      stage (countdown / clock / countup / blank)
--     cue                          stage, backstage, foh (_renderCueOverlay)
--     blackout                     every mode (blackout overlay; wall cells)
--     branding {logoBackstage, logoFoh, logoBackdrop}
--                                  backstage, foh (where the customer logo
--                                  shows); three booleans, harmless elsewhere
--   Verified against app.html on 2026-10-13 by reading renderSV (+ _svMode,
--   _renderCueOverlay, renderBlackout), renderBS (notesBlock: fohNotes +
--   note, no crew), renderFOH (fohCrewHTML + fohNotesHTML, no show note),
--   renderTL, renderOV, renderWV / tickWV and renderCI: none of the last
--   four reads note, crew or fohNotes; Stage View reads none of the six.
--   Photos are only used by the operator timer panel and editor drawer,
--   memberIds only by the operator crew picker / push, logo only by
--   refreshLogo on Backstage and FOH (customer logo top-left, 2026-10-13,
--   feature/project-logo; Stage View, Wall and the rest never show it).
--   Proof: the booth suite runs every public Stage
--   View state on this stripped feed against the unchanged baseline, and
--   share-mode.spec.js renders every mode on both feeds and compares the DOM.
--   Unknown modes get the strictest set.
--
--   set_show_arrived(...)  Same signature and return shape as before (a data
--   object with a shows array, which ciToggleArrived adopts), but:
--     * writes ONLY shows[i].arrived / shows[i].arrivedAt via jsonb_set on the
--       current row value, inside one UPDATE under the row lock - never a
--       blob computed earlier;
--     * no-op (no write, no realtime event, no version bump, no history row)
--       when the show is already in the requested state, so double taps and
--       retries are free;
--     * lock_timeout 3s: a burst of check-ins fails fast instead of queueing;
--     * arrivedAt is clamped to server time when the device clock is > 12h
--       off;
--     * returns the checkin-mode view of the data (no fohNotes/crew/notes/
--       photos), not the full blob.
--
-- APP CHANGE to use the per-mode version:
--   1. DONE: save()/_pushProject are a no-op when PUBLIC_MODE is set (except
--      the check-in RPC). Before that, a logged-in operator who opened a
--      share link in the same browser, or (before RLS) any anonymous FOH
--      viewer pressing a crew-status button, PATCHed G back to projects -
--      with the stripped data that would wipe photos, notes and crew.
--   2. DONE (branch feature/share-link-p-mode): the <head> early fetch,
--      loadPublicView and the 1-second poll call {p_id, p_mode: PUBLIC_MODE}.
--      Fallback chain: 2-arg missing (404 / PGRST202) -> {p_id} -> direct
--      table read; the variant that answered is remembered per page session;
--      401 / 5xx / timeouts never fall back. PostgREST picks the overload by
--      argument names; p_mode has NO default on purpose (a default would make
--      {p_id} ambiguous between the two).
--   3. After that release has been live for a few days (cached tabs
--      reloaded) AND the blocker below is cleared, apply PHASE B at the
--      bottom of this file so the legacy 1-arg call stops returning the full
--      blob to anonymous callers.
--
-- PRECONDITIONS
--   * projects(id, name, company_id, data jsonb) exists (checked).
--   * Apply BEFORE deploying app.html from improve/2026-10-13: that version
--     loads every share link through get_shared_project.
--   Does not need rls_prep; works with RLS on or off.
--
-- APPLY ORDER: after hotfix PART 1, before the improve/2026-10-13 deploy,
--   before rls_enable (which checks for these functions). Safe any time,
--   including during a show (CREATE OR REPLACE FUNCTION only).
--
-- VERIFY
--   select jsonb_typeof(public.get_shared_project('<pid>') -> 'data');      -- object
--   select (public.get_shared_project('<pid>','stage') -> 'data') ? 'fohNotes',
--          public.get_shared_project('<pid>','stage') -> 'data' -> 'fohNotes'; -- true, {}
--   select octet_length(public.get_shared_project('<pid>')::text),
--          octet_length(public.get_shared_project('<pid>','stage')::text);  -- 2nd much smaller with photos
--   -- arrived toggle, then toggle back (inside a transaction to leave no trace):
--   begin; select public.set_show_arrived('<pid>','<show id>', true, null) -> 'shows' -> 0; rollback;
--   -- helpers are not callable by clients (both false):
--   select has_function_privilege('anon','public._strip_project_data(jsonb,text)','execute'),
--          has_function_privilege('anon','public._project_is_live(text)','execute');
--
-- ROLLBACK
--   drop function if exists public.get_shared_project(text, text);
--   -- set_show_arrived / get_shared_project(text): restore the previous
--   -- definitions from git (git show dd48671:supabase/migrations/20260819111158_rls_prep.sql),
--   -- or simply leave these: they are backward compatible.
--   drop function if exists public._strip_project_data(jsonb, text);  -- only after the two above
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'projects'
                    and column_name = 'data' and data_type = 'jsonb') then
    raise exception 'share_link_rpcs: public.projects.data must exist and be jsonb';
  end if;
end $$;

-- ── Helpers ────────────────────────────────────────────────────────────
-- Is this project visible to share links? Honours projects.deleted_at when
-- the soft-delete migration has added it (built from the live schema so
-- re-running this file after that migration does not undo it).
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'projects' and column_name = 'deleted_at') then
    execute $f$
      create or replace function public._project_is_live(p_id text)
      returns boolean language sql stable security definer set search_path = public
      as $b$ select exists (select 1 from public.projects p where p.id::text = p_id and p.deleted_at is null) $b$ $f$;
  else
    execute $f$
      create or replace function public._project_is_live(p_id text)
      returns boolean language sql stable security definer set search_path = public
      as $b$ select exists (select 1 from public.projects p where p.id::text = p_id) $b$ $f$;
  end if;
end $$;
-- Internal helpers: only called from the SECURITY DEFINER RPCs below.
-- Supabase grants EXECUTE on new functions to anon/authenticated directly,
-- so they are revoked by name, not only from public.
revoke all on function public._project_is_live(text) from public, anon, authenticated;

-- Strip what a public mode does not render. Pure function, no table access.
create or replace function public._strip_project_data(p_data jsonb, p_mode text)
returns jsonb
language plpgsql
immutable
as $$
declare
  keep_foh   boolean := p_mode in ('backstage', 'foh', 'legacy');
  keep_note  boolean := p_mode in ('backstage', 'legacy');
  keep_crew  boolean := p_mode in ('foh', 'legacy');
  keep_logo  boolean := p_mode in ('backstage', 'foh', 'legacy');
  drop_show  text[]  := array['photo'];
  out        jsonb;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return p_data;
  end if;
  if not keep_note then drop_show := array_append(drop_show, 'note'); end if;
  if not keep_crew then drop_show := array_append(drop_show, 'crew'); end if;

  out := case when keep_logo then p_data else p_data - 'logo' end;
  if out ? 'memberIds' then out := jsonb_set(out, '{memberIds}', '[]'::jsonb); end if;
  if not keep_foh and out ? 'fohNotes' then out := jsonb_set(out, '{fohNotes}', '{}'::jsonb); end if;

  if jsonb_typeof(out -> 'shows') = 'array' then
    out := jsonb_set(out, '{shows}', (
      select coalesce(jsonb_agg(case when jsonb_typeof(s) = 'object' then s - drop_show else s end
                                order by ord), '[]'::jsonb)
      from jsonb_array_elements(out -> 'shows') with ordinality t(s, ord)));
  end if;
  return out;
end
$$;
revoke all on function public._strip_project_data(jsonb, text) from public, anon, authenticated;

-- ── Read path ──────────────────────────────────────────────────────────
-- LEGACY: unchanged output, for app versions already out there. Knowing the
-- pid is enough (same exposure as today), but it can no longer be turned into
-- "select * from projects". Narrowed in PHASE B below.
create or replace function public.get_shared_project(p_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'company_id', p.company_id, 'data', p.data)
  from public.projects p
  where p.id::text = p_id
    and public._project_is_live(p_id)
$$;
comment on function public.get_shared_project(text) is
  'LEGACY share-link read (full data). Superseded by get_shared_project(p_id, p_mode); narrowed by PHASE B of 20261013100000_share_link_rpcs.sql.';

create or replace function public.get_shared_project(p_id text, p_mode text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'id', p.id,
           'name', p.name,
           'company_id', null,   -- public views do not need it
           'data', public._strip_project_data(
                     p.data,
                     case when p_mode in ('stage','backstage','foh','timeline','overview','wall','checkin')
                          then p_mode else 'strict' end))
  from public.projects p
  where p.id::text = p_id
    and public._project_is_live(p_id)
$$;
comment on function public.get_shared_project(text, text) is
  'Share-link read for one public mode: only the fields that mode renders. Explicit output shape so future columns are not exposed by accident.';

revoke all on function public.get_shared_project(text)       from public, anon, authenticated;
revoke all on function public.get_shared_project(text, text) from public, anon, authenticated;
grant execute on function public.get_shared_project(text)       to anon, authenticated;
grant execute on function public.get_shared_project(text, text) to anon, authenticated;

-- ── Write path (artist check-in) ───────────────────────────────────────
-- mode=checkin lets anyone with the link flip the "arrived" flag. This is
-- the ONLY write anonymous visitors get, limited to two fields of one show.
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
set lock_timeout = '3s'
as $$
declare
  v_data   jsonb;
  v_idx    int;
  v_show   jsonb;
  v_now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_at     jsonb;
begin
  if p_id is null or p_show_id is null or p_arrived is null then
    raise exception 'p_id, p_show_id and p_arrived are required' using errcode = 'invalid_parameter_value';
  end if;
  if not public._project_is_live(p_id) then
    raise exception 'project % not found', p_id using errcode = 'no_data_found';
  end if;

  -- Lock the row so the index we compute cannot shift under us.
  select p.data into v_data from public.projects p where p.id::text = p_id for update;
  if v_data is null or jsonb_typeof(v_data -> 'shows') <> 'array' then
    raise exception 'project % has no shows array', p_id using errcode = 'no_data_found';
  end if;

  select ord - 1, el into v_idx, v_show
  from jsonb_array_elements(v_data -> 'shows') with ordinality t(el, ord)
  where el ->> 'id' = p_show_id
  limit 1;
  if v_idx is null then
    raise exception 'show % not found in project %', p_show_id, p_id using errcode = 'no_data_found';
  end if;

  -- Already in the requested state: nothing to write. (JS truthiness, as the
  -- client reads it with !!s.arrived.)
  if (coalesce(v_show -> 'arrived', 'null'::jsonb)
        not in ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb)) = p_arrived then
    return public._strip_project_data(v_data, 'checkin');
  end if;

  if p_arrived then
    v_at := to_jsonb(case when p_arrived_at between v_now_ms - 43200000 and v_now_ms + 43200000
                          then p_arrived_at else v_now_ms end);
  else
    v_at := 'null'::jsonb;
  end if;

  -- Field-level write computed from the row's current value (the same one
  -- we hold the lock on), never from a blob assembled earlier.
  update public.projects p
     set data = jsonb_set(
                  jsonb_set(p.data, array['shows', v_idx::text, 'arrived'], to_jsonb(p_arrived), true),
                  array['shows', v_idx::text, 'arrivedAt'], v_at, true)
   where p.id::text = p_id
  returning p.data into v_data;

  return public._strip_project_data(v_data, 'checkin');
end
$$;

comment on function public.set_show_arrived(text, text, boolean, bigint) is
  'Check-in share link: set shows[i].arrived/arrivedAt of one show. No-op when unchanged. Returns the checkin-mode data.';

revoke all on function public.set_show_arrived(text, text, boolean, bigint) from public, anon, authenticated;
grant execute on function public.set_show_arrived(text, text, boolean, bigint) to anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- PHASE B - DO NOT RUN with the rest of this file.
-- STATUS 2026-10-13: NOT READY - BLOCKED.
--   * App side: done on branch feature/share-link-p-mode (p_mode everywhere,
--     2-arg -> 1-arg -> table fallback chain; `npm run test:booth` runs every
--     public Stage View state on the stripped feed against the unchanged
--     baseline). Not deployed yet.
--   * BLOCKER: the iPad app "Stagetimer Booth" (nl.stagetimer.booth) loads
--     project data in a way that is not known yet. If it calls
--     get_shared_project(p_id) and needs photos or memberIds, or reads
--     projects directly, PHASE B (or rls_enable) breaks every iPad booth
--     screen. Establish its endpoints and fields first (source code or a
--     network trace, e.g. Proxyman). See docs/MIGRATIES.md.
-- Run only when (1) the app release that calls the 2-arg version everywhere
-- is live, (2) the app never saves in PUBLIC_MODE (done), (3) a few days have
-- passed so cached tabs reloaded, and (4) the iPad app is known to work with
-- the narrowed legacy output. After this, the legacy call returns the union
-- of what any public mode needs (fohNotes, notes, crew, logo) but no photos /
-- memberIds, and no company_id.
--
-- create or replace function public.get_shared_project(p_id text)
-- returns jsonb language sql stable security definer set search_path = public as $$
--   select jsonb_build_object('id', p.id, 'name', p.name, 'company_id', null,
--                             'data', public._strip_project_data(p.data, 'legacy'))
--   from public.projects p
--   where p.id::text = p_id and public._project_is_live(p_id)
-- $$;
--
-- Rollback of PHASE B: re-run the LEGACY definition above.
-- ═══════════════════════════════════════════════════════════════════════
