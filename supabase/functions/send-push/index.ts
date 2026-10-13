// send-push: send a OneSignal push notification on behalf of a logged-in
// Stagetimer user, without the OneSignal REST key ever reaching a browser.
//
// SOURCE ONLY - not deployed. Deploy steps: supabase/functions/README.md.
//
// Request (POST, JSON) - mirrors what app.html scheduleProjectPushes() sends
// to OneSignal today, plus project_id (and optionally show_id):
//   {
//     "project_id": "<projects.id>",                      // required
//     "show_id": "<show id>",                             // optional, idempotency
//     "include_external_user_ids": ["<app_users.id>", ...], // required, 1..100
//     "headings": { "en": "...", "nl": "..." },           // required, en required
//     "contents": { "en": "...", "nl": "..." },           // required, en required
//     "send_after": "2026-10-13T21:50:00.000Z"            // optional, <= 48h ahead
//   }
//   "app_id" and "channel_for_external_user_ids" are accepted and ignored:
//   the server decides both.
//
// Checks, in order:
//   1. Authorization: Bearer <user access token> (the app's _jwt()). The
//      token is verified by Supabase Auth (/auth/v1/user); the anon key and
//      expired tokens are rejected.
//   2. The caller is resolved exactly like the RLS policies do, through the
//      public.current_app_user() RPC called WITH the caller's token
//      (requires the rls_prep migration).
//   3. The caller may act on the project: same workspace as the project, or
//      role admin / super_admin.
//   4. Every target user exists and belongs to the PROJECT's workspace.
//   5. Payload limits (lengths, recipients, send_after window) and a small
//      per-caller rate limit (per function instance).
//
// Response: 200 {ok:true, id, recipients} | 4xx/5xx {ok:false, error}
//
// Env (Supabase provides SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY automatically):
//   ONESIGNAL_APP_ID     required
//   ONESIGNAL_REST_KEY   required (the NEW, rotated key - never the one that
//                        was in app.html)
//   ONESIGNAL_API_URL    optional, default https://api.onesignal.com/notifications?c=push
//   ALLOWED_ORIGINS      optional, comma list, default
//                        https://stagetimer.nl,https://www.stagetimer.nl

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OS_APP_ID = Deno.env.get("ONESIGNAL_APP_ID") ?? "";
const OS_REST_KEY = Deno.env.get("ONESIGNAL_REST_KEY") ?? "";
const OS_API_URL = Deno.env.get("ONESIGNAL_API_URL") ??
  "https://api.onesignal.com/notifications?c=push";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://stagetimer.nl,https://www.stagetimer.nl")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RECIPIENTS = 100;
const MAX_HEADING = 200;
const MAX_CONTENT = 1000;
const MAX_AHEAD_MS = 48 * 3600 * 1000;
const RATE_PER_MINUTE = 60; // notifications per caller per minute, per instance
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type AppUser = { id: string; role: string | null; company_id: string | null; email: string | null };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ── Rate limit (best effort: per isolate, resets on cold start) ─────────
const hits = new Map<string, number[]>();
function rateLimited(key: string, cost: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length + cost > RATE_PER_MINUTE) {
    hits.set(key, recent);
    return true;
  }
  for (let i = 0; i < cost; i++) recent.push(now);
  hits.set(key, recent);
  return false;
}

// ── Supabase helpers (plain fetch, no SDK) ──────────────────────────────
async function verifyUser(jwt: string): Promise<{ email: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new HttpError(401, "invalid or expired session");
  const user = await res.json();
  if (!user?.email) throw new HttpError(401, "session has no email");
  return { email: String(user.email) };
}

async function currentAppUser(jwt: string): Promise<AppUser> {
  // Same resolution as the RLS policies (JWT email -> app_users), evaluated
  // by Postgres with the caller's own token.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/current_app_user`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) throw new HttpError(403, "cannot resolve caller");
  const row = await res.json();
  if (!row?.id) throw new HttpError(403, "no Stagetimer user for this login");
  return row as AppUser;
}

async function serviceGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new HttpError(502, `database read failed (${res.status})`);
  return await res.json() as T;
}

// ── Validation ──────────────────────────────────────────────────────────
function checkLangMap(v: unknown, field: string, max: number): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, `${field} must be an object`);
  const out: Record<string, string> = {};
  for (const [lang, text] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(lang)) throw new HttpError(400, `${field}: bad language key`);
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, `${field}.${lang} must be text`);
    if (text.length > max) throw new HttpError(400, `${field}.${lang} too long (max ${max})`);
    out[lang] = text;
  }
  if (!out.en) throw new HttpError(400, `${field}.en is required`);
  return out;
}

async function idempotencyKey(parts: string[]): Promise<string> {
  // Deterministic UUID-shaped key: re-opening a project re-schedules the same
  // notifications; OneSignal drops duplicates with the same key (30 days).
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|"))),
  );
  digest[6] = (digest[6] & 0x0f) | 0x50; // version nibble (name-based style)
  digest[8] = (digest[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ── Handler ─────────────────────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" }, origin);

  try {
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !OS_APP_ID || !OS_REST_KEY) {
      throw new HttpError(500, "send-push is not configured");
    }

    // 1. Authenticate.
    const auth = req.headers.get("Authorization") ?? "";
    const jwt = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!jwt || jwt === ANON_KEY) throw new HttpError(401, "login required");
    await verifyUser(jwt);
    const caller = await currentAppUser(jwt);

    // Body.
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "request too large");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid JSON");
    }

    const projectId = String(body.project_id ?? "");
    if (!ID_RE.test(projectId)) throw new HttpError(400, "project_id required");
    const showId = body.show_id == null ? "" : String(body.show_id);
    if (showId && !ID_RE.test(showId)) throw new HttpError(400, "bad show_id");

    const targets = Array.isArray(body.include_external_user_ids)
      ? [...new Set((body.include_external_user_ids as unknown[]).map(String))]
      : [];
    if (!targets.length) throw new HttpError(400, "include_external_user_ids required");
    if (targets.length > MAX_RECIPIENTS) throw new HttpError(400, `max ${MAX_RECIPIENTS} recipients`);
    if (!targets.every((t) => ID_RE.test(t))) throw new HttpError(400, "bad user id");

    const headings = checkLangMap(body.headings, "headings", MAX_HEADING);
    const contents = checkLangMap(body.contents, "contents", MAX_CONTENT);

    let sendAfter: string | undefined;
    if (body.send_after != null && body.send_after !== "") {
      const t = Date.parse(String(body.send_after));
      if (Number.isNaN(t)) throw new HttpError(400, "bad send_after");
      const now = Date.now();
      if (t < now - 60_000) throw new HttpError(400, "send_after is in the past");
      if (t > now + MAX_AHEAD_MS) throw new HttpError(400, "send_after is more than 48h ahead");
      sendAfter = new Date(t).toISOString();
    }

    // 2/3. Project access (same rule as RLS).
    const projects = await serviceGet<{ id: string; company_id: string | null }[]>(
      `projects?select=id,company_id&id=eq.${encodeURIComponent(projectId)}&limit=1`,
    );
    const project = projects[0];
    const projectCompany = project?.company_id ? String(project.company_id) : "";
    const callerCompany = caller.company_id ? String(caller.company_id) : "";
    const isPlatformAdmin = caller.role === "admin" || caller.role === "super_admin";
    if (!project || !(isPlatformAdmin || (callerCompany !== "" && callerCompany === projectCompany))) {
      throw new HttpError(403, "project not found or not accessible");
    }
    if (!projectCompany) throw new HttpError(403, "project has no workspace");

    // 4. Every target must be a member of the project's workspace.
    const inList = targets.map((t) => `"${t}"`).join(",");
    const members = await serviceGet<{ id: string }[]>(
      `app_users?select=id&company_id=eq.${encodeURIComponent(projectCompany)}&id=in.(${encodeURIComponent(inList)})`,
    );
    const memberIds = new Set(members.map((m) => String(m.id)));
    const outsiders = targets.filter((t) => !memberIds.has(t));
    if (outsiders.length) {
      throw new HttpError(403, `${outsiders.length} recipient(s) are not in this workspace`);
    }

    // 5. Rate limit.
    if (rateLimited(String(caller.id), 1)) throw new HttpError(429, "too many notifications, try again in a minute");

    const key = await idempotencyKey([
      projectId,
      showId,
      sendAfter ?? "",
      [...targets].sort().join(","),
      contents.en,
    ]);

    const osRes = await fetch(OS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Key ${OS_REST_KEY}`,
      },
      body: JSON.stringify({
        app_id: OS_APP_ID,
        target_channel: "push",
        include_aliases: { external_id: targets },
        headings,
        contents,
        ...(sendAfter ? { send_after: sendAfter } : {}),
        idempotency_key: key,
      }),
    });
    const osBody = await osRes.json().catch(() => ({}));
    if (!osRes.ok) {
      console.warn("[send-push] OneSignal error", osRes.status, JSON.stringify(osBody).slice(0, 500));
      throw new HttpError(502, `push provider rejected the request (${osRes.status})`);
    }
    return json(200, { ok: true, id: osBody?.id ?? null, recipients: targets.length }, origin);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { ok: false, error: e.message }, origin);
    console.error("[send-push] unexpected", e);
    return json(500, { ok: false, error: "internal error" }, origin);
  }
}

Deno.serve(handle);
