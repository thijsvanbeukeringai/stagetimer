-- ═══════════════════════════════════════════════════════════════════════
-- BOUWPLAN §S.5 (preparation): signup tokens out of companies, hashed,
-- expiring, single-use, with a failed-attempt lockout.
--
-- STATUS: NOT APPLIED. Run by hand. Runbook: docs/MIGRATIES.md.
--
-- WHY
--   companies.setup_token is a plaintext, non-expiring, reusable secret on a
--   table clients can reach. The hotfix hides it with column grants; this
--   moves it out of reach altogether:
--   * private.signup_tokens: one row per company, only the SHA-256 of the
--     token is stored, expires_at (default 7 days), used_at, failed-attempt
--     counter + locked_until. Schema `private` is not exposed by PostgREST
--     and has no grants for anon/authenticated.
--   * public.issue_signup_token(p_company_id [, p_ttl])  -> text (raw token)
--   * public.consume_signup_token(p_company_id, p_token) -> jsonb
--       {ok:true} once; afterwards / when wrong / expired / locked:
--       {ok:false, reason:'invalid'|'expired'|'used'|'locked'}
--     Compares sha256(input) = stored hash (the stored value is a digest
--     of a 256-bit random token, so the comparison leaks nothing useful
--     about the secret: effectively constant-time with respect to it).
--     After 10 wrong attempts within an hour the token locks for 1 hour.
--   Both functions are EXECUTE-able by service_role only (edge functions).
--   Per-IP rate limiting has to live in finalize-signup itself (the DB does
--   not see the client IP) - see docs/MIGRATIES.md.
--
-- PHASES
--   PHASE A (this file, safe any time): table + functions + backfill of the
--     existing companies.setup_token values (hashed, expiring 7 days from
--     now). Nothing reads them yet; companies.setup_token stays as it is.
--   ----> Thijs: change the edge functions (source not in the repo yet):
--         signup-checkout: token := rpc('issue_signup_token', {p_company_id})
--                          and put THAT in the success URL (still &t=...).
--                          Keep writing companies.setup_token too for one
--                          release, so setup_pending keeps working.
--         finalize-signup: replace the setup_token comparison with
--                          rpc('consume_signup_token', {p_company_id, p_token});
--                          proceed only on ok:true; add a per-IP limit.
--   PHASE B (commented at the bottom): stop storing setup_token in companies
--     and drive setup_pending from private.signup_tokens.
--
-- PRECONDITIONS: companies.id and companies.setup_token exist (checked).
-- APPLY ORDER: after the hotfix (any time). Independent of the RLS files.
--
-- VERIFY
--   select count(*) from private.signup_tokens;               -- = open setup tokens
--   select has_function_privilege('authenticated', 'public.consume_signup_token(text,text)', 'execute'); -- false
--   begin;
--     select public.issue_signup_token('<company id>') as t \gset
--     select public.consume_signup_token('<company id>', :'t');   -- {"ok": true}
--     select public.consume_signup_token('<company id>', :'t');   -- {"ok": false, "reason": "used"}
--   rollback;
--
-- ROLLBACK (PHASE A): finalize-signup must be back on companies.setup_token first.
--   drop function if exists public.issue_signup_token(text, interval), public.consume_signup_token(text, text);
--   drop table if exists private.signup_tokens;
--   drop schema if exists private;   -- only if nothing else lives there
-- ═══════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'companies' and column_name = 'setup_token') then
    raise exception 'signup_tokens: companies.setup_token not found (already migrated?)';
  end if;
end $$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.signup_tokens (
  company_id      text primary key,
  token_hash      bytea       not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  failed_attempts int         not null default 0,
  last_failed_at  timestamptz,
  locked_until    timestamptz
);
revoke all on private.signup_tokens from public, anon, authenticated;

-- Backfill: existing open tokens get 7 more days from now.
insert into private.signup_tokens (company_id, token_hash, expires_at)
select c.id::text, sha256(convert_to(c.setup_token, 'UTF8')), now() + interval '7 days'
  from public.companies c
 where nullif(c.setup_token, '') is not null
on conflict (company_id) do nothing;

create or replace function public.issue_signup_token(p_company_id text, p_ttl interval default interval '7 days')
returns text
language plpgsql
volatile
security definer
set search_path = public, private
as $$
declare v_token text;
begin
  if not exists (select 1 from public.companies where id::text = p_company_id) then
    raise exception 'company % not found', p_company_id using errcode = 'no_data_found';
  end if;
  -- 2 x 122 random bits from gen_random_uuid() (core PG 13+, CSPRNG).
  v_token := translate(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'),
                              'base64'), '+/=', '-_');
  insert into private.signup_tokens (company_id, token_hash, expires_at)
  values (p_company_id, sha256(convert_to(v_token, 'UTF8')), now() + p_ttl)
  on conflict (company_id) do update
    set token_hash = excluded.token_hash, created_at = now(), expires_at = excluded.expires_at,
        used_at = null, failed_attempts = 0, last_failed_at = null, locked_until = null;
  return v_token;
end
$$;

create or replace function public.consume_signup_token(p_company_id text, p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private
as $$
declare r private.signup_tokens%rowtype;
begin
  select * into r from private.signup_tokens where company_id = p_company_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;
  if r.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  if r.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if p_token is null or sha256(convert_to(p_token, 'UTF8')) <> r.token_hash then
    update private.signup_tokens
       set failed_attempts = case when last_failed_at > now() - interval '1 hour' then failed_attempts + 1 else 1 end,
           last_failed_at  = now(),
           locked_until    = case when last_failed_at > now() - interval '1 hour' and failed_attempts + 1 >= 10
                                  then now() + interval '1 hour' else locked_until end
     where company_id = p_company_id;
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  update private.signup_tokens set used_at = now() where company_id = p_company_id;
  return jsonb_build_object('ok', true);
end
$$;

revoke all on function public.issue_signup_token(text, interval) from public, anon, authenticated;
revoke all on function public.consume_signup_token(text, text)   from public, anon, authenticated;
grant execute on function public.issue_signup_token(text, interval) to service_role;
grant execute on function public.consume_signup_token(text, text)   to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- PHASE B - DO NOT RUN until both edge functions use the RPCs above and a
-- full signup has been tested end to end.
--
-- begin;
--   -- setup_pending becomes a plain column maintained from signup_tokens.
--   alter table public.companies drop column if exists setup_pending;
--   alter table public.companies add column setup_pending boolean not null default false;
--   update public.companies c set setup_pending = exists (
--     select 1 from private.signup_tokens t
--      where t.company_id = c.id::text and t.used_at is null and t.expires_at > now());
--   create or replace function private.sync_setup_pending() returns trigger
--   language plpgsql security definer set search_path = public, private as $f$
--   begin
--     update public.companies set setup_pending = (new.used_at is null and new.expires_at > now())
--      where id::text = new.company_id;
--     return null;
--   end $f$;
--   create trigger signup_tokens_sync after insert or update on private.signup_tokens
--     for each row execute function private.sync_setup_pending();
--   update public.companies set setup_token = null where setup_token is not null;
--   -- Re-run rls_enable block 4b + 4c (column grants / realtime list are a
--   -- snapshot and setup_pending was re-created).
-- commit;
-- Expired-but-unused tokens leave setup_pending true until the next token
-- write; the admin badge treats them as "awaiting activation", which is
-- what they are. Later: drop column companies.setup_token.
-- ═══════════════════════════════════════════════════════════════════════
