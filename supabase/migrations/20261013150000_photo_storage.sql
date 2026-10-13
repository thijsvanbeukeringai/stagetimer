-- ═══════════════════════════════════════════════════════════════════════
-- Artist photos and project logos in Supabase Storage instead of base64
-- inside projects.data.
--
-- STATUS: NOT APPLIED. Run by hand (SQL editor). Runbook: docs/MIGRATIES.md
-- (step 16).
--
-- WHY
--   Photos are base64 JPEGs inside the project JSONB blob. Every save,
--   every realtime message, every public poll and the local cache carry
--   them: a festival with 80 photos is a multi-megabyte blob on every
--   change. This file creates a Storage bucket the app uploads to instead;
--   the blob then only holds the object's URL (~120 bytes per photo).
--
-- WHAT
--   * Bucket `project-media`: PUBLIC read, 1 MB per object, image/jpeg,
--     image/png, image/webp only.
--     Object names: `<project id>/<32 hex random>.<jpg|png|webp>`.
--   * public.can_edit_project_media(p_project_id text) -> boolean
--     Same access rule as saving the project (RLS projects_update /
--     save_project): the project's workspace is the caller's workspace, or
--     the caller is admin / super_admin. SECURITY DEFINER, so it works with
--     RLS on projects on or off and never recurses into it. EXECUTE for
--     `authenticated` only (storage policies run as the caller).
--   * storage.objects policies for `authenticated`, bucket project-media
--     only: INSERT / UPDATE (name must match the pattern above and its
--     first folder must be a project the caller may edit), SELECT / DELETE
--     under such a project prefix (Storage needs SELECT for a delete).
--     `anon` gets NO policy: share links read photos through the public
--     URL (`/storage/v1/object/public/...`), which bypasses policies, but
--     cannot list, upload, overwrite or delete anything.
--
-- PUBLIC BUCKET vs SIGNED URLS (decision: public)
--   + Stage View, FOH, backstage and the other share links are anonymous
--     and poll for minutes or days. A public URL works for them without a
--     token, survives reloads, is CDN-cached and needs no extra round trip.
--   + Exposure is the same as today: every share link already receives the
--     full base64 photo inside the project data.
--   - Anyone who has a URL can fetch that photo, forever, without logging in.
--     The 128-bit random file name makes URLs unguessable and there is no
--     anonymous listing, but a URL that leaked (copied out of a share link,
--     browser history) cannot be revoked except by deleting the object;
--     the CDN may keep serving it for up to the cache max-age (30 days, set
--     by the app on upload).
--   - Signed URLs would expire and could be revoked, but every anonymous
--     viewer would need a signing endpoint (RPC or edge function with the
--     service key), URLs change per fetch (no caching, blob churn on every
--     poll) and an offline booth loses its photos when they expire.
--   Artist promo photos are public material in practice, so public read
--   is the pragmatic choice. Do NOT store anything private in this bucket.
--
-- PRECONDITIONS (checked below)
--   * rls_prep applied (caller_role / caller_company_id).
--   * Storage enabled (schema storage with tables buckets and objects).
--   NOT checkable from SQL, Thijs must confirm first:
--   * The iPad app "Stagetimer Booth" (nl.stagetimer.booth): once this file
--     is applied, NEW photos arrive as https URLs in show.photo instead of
--     data: URLs. If that app decodes show.photo as base64 it shows no
--     photo (or worse) for those shows. Check its source / a network trace
--     (see the RLS blocker note in docs/MIGRATIES.md) before applying.
--
-- APPLY ORDER
--   after rls_prep (step 2). Independent of rls_enable, versioning,
--   history and plan_enforcement. Any time, also during a show (only new
--   objects; nothing existing is locked or rewritten).
--   The app (branch feature/photo-storage or later) detects the bucket on
--   its own: until this file is applied every upload answers "Bucket not
--   found" and the app keeps storing base64 exactly as before.
--
-- VERIFY
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'project-media';
--     -- project-media | t | 1048576 | {image/jpeg,image/png,image/webp}
--   select policyname, cmd from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and policyname like 'project_media_%' order by 1;
--     -- 4 rows: delete, insert, select, update
--   select has_function_privilege('anon','public.can_edit_project_media(text)','execute'),           -- false
--          has_function_privilege('authenticated','public.can_edit_project_media(text)','execute');  -- true
--   In the app (logged in): open a show, add a photo, save. The blob holds
--     https://<ref>.supabase.co/storage/v1/object/public/project-media/<pid>/<hex>.jpg
--   and that URL opens in a private browser window. Then:
--   select name, metadata->>'size', metadata->>'mimetype' from storage.objects
--    where bucket_id = 'project-media' order by created_at desc limit 5;
--   Size of the blobs, before/after the background conversion (the app moves
--   a few base64 photos per 20 s of the open project):
--   select id, pg_size_pretty(octet_length(data::text)::bigint) from public.projects order by 2 desc;
--   Orphaned objects (no project references them any more; deleting shows
--   or projects does not delete their photos, so restores keep working):
--   select o.name from storage.objects o
--    where o.bucket_id = 'project-media'
--      and not exists (select 1 from public.projects p
--                       where p.id::text = split_part(o.name, '/', 1)
--                         and strpos(p.data::text, o.name) > 0);
--
-- ROLLBACK
--   The app falls back to base64 for NEW photos as soon as uploads fail, but
--   photos already stored as URLs keep pointing at the bucket: do not drop
--   the bucket while projects reference it. Stop new uploads only:
--     drop policy if exists project_media_insert on storage.objects;
--     drop policy if exists project_media_update on storage.objects;
--   Full removal (only after no project data references the bucket, see the
--   orphan query; objects must be deleted through the Storage API or the
--   dashboard first, Storage refuses to drop a non-empty bucket):
--     drop policy if exists project_media_select on storage.objects;
--     drop policy if exists project_media_delete on storage.objects;
--     drop function if exists public.can_edit_project_media(text);
--     delete from storage.buckets where id = 'project-media';
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.caller_role()') is null or to_regprocedure('public.caller_company_id()') is null then
    raise exception 'photo_storage: apply rls_prep first';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'photo_storage: Supabase Storage is not enabled (storage.buckets / storage.objects missing)';
  end if;
  if to_regprocedure('storage.foldername(text)') is null then
    raise exception 'photo_storage: storage.foldername(text) missing (unexpected Storage version)';
  end if;
end $$;

begin;

-- ── 1. Bucket ──────────────────────────────────────────────────────────
-- file_size_limit / allowed_mime_types are enforced by the Storage API on
-- upload (413 / 415-style errors); the app compresses to well under 1 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-media', 'project-media', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 2. Who may write under a project prefix ────────────────────────────
-- Same rule as saving the project blob. company_id '' (detached) never
-- matches: caller_company_id() is NULL for users without a workspace.
create or replace function public.can_edit_project_media(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_project_id, '') <> ''
     and exists (
       select 1 from public.projects p
        where p.id::text = p_project_id
          and (public.caller_role() in ('admin', 'super_admin')
               or (public.caller_company_id() is not null
                   and nullif(p.company_id::text, '') = public.caller_company_id()))
     )
$$;
comment on function public.can_edit_project_media(text) is
  'True when the caller may write Storage objects under <project id>/ in bucket project-media: same rule as saving the project.';
-- Supabase grants EXECUTE on new public functions to anon/authenticated
-- directly; revoke by name and give it back to authenticated only (the
-- storage.objects policies below run as the caller).
revoke all on function public.can_edit_project_media(text) from public, anon, authenticated;
grant execute on function public.can_edit_project_media(text) to authenticated;

-- ── 3. storage.objects policies (bucket project-media only) ────────────
-- Name pattern: exactly one folder (the project id) and a random file
-- name the app generates, so nobody can plant `other/../x` or long paths.
drop policy if exists project_media_insert on storage.objects;
create policy project_media_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-media'
    and name ~ '^[^/]+/[0-9a-f]{32}\.(jpg|png|webp)$'
    and public.can_edit_project_media((storage.foldername(name))[1])
  );

drop policy if exists project_media_update on storage.objects;
create policy project_media_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'project-media'
    and public.can_edit_project_media((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'project-media'
    and name ~ '^[^/]+/[0-9a-f]{32}\.(jpg|png|webp)$'
    and public.can_edit_project_media((storage.foldername(name))[1])
  );

-- SELECT is needed by the Storage API for delete (and upsert); it only
-- covers the caller's own projects. Public reads go through
-- /object/public/..., which does not consult these policies.
drop policy if exists project_media_select on storage.objects;
create policy project_media_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-media'
    and public.can_edit_project_media((storage.foldername(name))[1])
  );

drop policy if exists project_media_delete on storage.objects;
create policy project_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-media'
    and public.can_edit_project_media((storage.foldername(name))[1])
  );

commit;
