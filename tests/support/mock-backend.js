// In-memory mock of everything app.html talks to over the network.
//
// One MockBackend per browser context (the fixture in fixtures.js wires it up
// automatically). It intercepts EVERY non-localhost request:
//
//   bamjpsquhdzxvsymldpq.supabase.co
//     /rest/v1/<table>      fake PostgREST (projects, companies, app_users)
//     /rest/v1/rpc/<fn>     get_shared_project, set_show_arrived (+ custom)
//     /rest/v1/  (HEAD)     server clock for the Wall (date header)
//     /auth/v1/*            password / refresh grant, user, logout, recover
//     /functions/v1/*       edge functions: recorded, configurable, never real
//     wss /realtime/v1/websocket   Phoenix stub, push postgres_changes at will
//   cdn.jsdelivr.net        supabase-js UMD served from node_modules (same bytes, SRI ok)
//   fonts.googleapis/gstatic   local copies in tests/support/fonts
//   *.onesignal.com         recorded, answered with a dummy 200, never real
//   anything else           ABORTED and recorded as a violation -> test fails
//
// Nothing here can reach production: unknown hosts/paths are aborted, and the
// websocket route never calls connectToServer().
const fs = require('fs');
const path = require('path');

const SUPA_HOST = 'bamjpsquhdzxvsymldpq.supabase.co';
const SUPABASE_UMD_PATH = '/npm/@supabase/supabase-js@2.112.3/dist/umd/supabase.js';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FONTS_DIR = path.join(__dirname, 'fonts');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS',
  'access-control-expose-headers': 'content-range, date, x-supabase-api-version',
};

// Column lists per table. Unknown columns in select/filters/bodies get the same
// errors PostgREST gives (42703 / PGRST204), which is what app.html's
// _isMissingColumn fallback keys on.
const SCHEMA = {
  projects: ['id', 'name', 'company_id', 'created_at', 'created_by', 'data'],
  app_users: ['id', 'name', 'email', 'role', 'company_id', 'created_at'],
  companies: [
    'id', 'name', 'stripe_customer_id', 'stripe_subscription_id', 'subscription_status', 'subscription_tier',
    'project_limit', 'current_period_end', 'trial_ends_at', 'last_paid_at', 'pending_name', 'pending_email',
    'setup_token', 'setup_pending', 'extra_seats', 'seat_subscription_item_id', 'plan_slug', 'live_stages_limit',
    'live_stages_override', 'pass_slug', 'pass_expires_at', 'created_at',
  ],
};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Deterministic, decodable (unsigned) JWT. exp = 2100-01-01 so the fake clock never expires it. */
function mockJwt(user, extra = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: `https://${SUPA_HOST}/auth/v1`, sub: user.id, aud: 'authenticated', role: 'authenticated',
    email: user.email, iat: 1767225600, exp: 4102444800, session_id: `sess-${user.id}`,
    app_metadata: { provider: 'email' }, user_metadata: {}, ...extra,
  };
  return `${b64url(header)}.${b64url(payload)}.mock-signature`;
}

/** The value app.html keeps in localStorage.st_auth_v1 for a logged-in user. */
function authBackupFor(user) {
  return JSON.stringify({ access_token: mockJwt(user), refresh_token: `rt-${user.id}` });
}

// ── PostgREST helpers ────────────────────────────────────────────────────
function pgError(status, code, message, extra = {}) {
  return { status, json: { code, details: null, hint: null, message, ...extra } };
}

function parseSelect(sel) {
  if (!sel || sel === '*') return '*';
  return sel.split(',').map((raw) => {
    let s = raw.trim();
    let alias = null;
    const ci = s.indexOf(':');
    if (ci > 0 && s[ci + 1] !== ':') { alias = s.slice(0, ci); s = s.slice(ci + 1); }
    s = s.split('::')[0];
    return { col: s, alias: alias || s };
  });
}

function parseValue(v) {
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function matchFilter(row, col, opExpr) {
  let negate = false;
  let expr = opExpr;
  if (expr.startsWith('not.')) { negate = true; expr = expr.slice(4); }
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  const val = row[col];
  const sv = val == null ? val : String(val);
  let res;
  switch (op) {
    case 'eq': res = sv === raw; break;
    case 'neq': res = sv !== raw; break;
    case 'gt': res = Number(val) > Number(raw) || (isNaN(Number(raw)) && sv > raw); break;
    case 'gte': res = Number(val) >= Number(raw) || (isNaN(Number(raw)) && sv >= raw); break;
    case 'lt': res = Number(val) < Number(raw) || (isNaN(Number(raw)) && sv < raw); break;
    case 'lte': res = Number(val) <= Number(raw) || (isNaN(Number(raw)) && sv <= raw); break;
    case 'is': res = parseValue(raw) === null ? val == null : val === parseValue(raw); break;
    case 'in': {
      const list = raw.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
      res = list.includes(sv);
      break;
    }
    case 'like':
    case 'ilike': {
      const re = new RegExp('^' + raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*') + '$', op === 'ilike' ? 'i' : '');
      res = re.test(sv || '');
      break;
    }
    default: throw new Error(`mock PostgREST: unsupported operator ${op}`);
  }
  return negate ? !res : res;
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

class RealtimeStub {
  constructor(backend) {
    this.backend = backend;
    this.sockets = [];
    this.nextId = 1000;
    this.messages = []; // every client->server frame (decoded), for assertions
  }

  async _onSocket(ws) {
    const conn = { ws, channels: new Map(), vsn: new URL(ws.url()).searchParams.get('vsn') || '1.0.0', open: true };
    this.sockets.push(conn);
    ws.onMessage((raw) => this._onMessage(conn, raw));
    ws.onClose(() => { conn.open = false; });
  }

  _decode(conn, raw) {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    const v = JSON.parse(text);
    if (Array.isArray(v)) { conn.vsn = '2.0.0'; const [join_ref, ref, topic, event, payload] = v; return { join_ref, ref, topic, event, payload }; }
    conn.vsn = '1.0.0';
    return v;
  }

  _send(conn, { join_ref = null, ref = null, topic, event, payload }) {
    if (!conn.open) return;
    const frame = conn.vsn === '2.0.0'
      ? JSON.stringify([join_ref, ref, topic, event, payload])
      : JSON.stringify({ join_ref, ref, topic, event, payload });
    conn.ws.send(frame);
  }

  _onMessage(conn, raw) {
    let msg;
    try { msg = this._decode(conn, raw); } catch { return; }
    this.messages.push(msg);
    const reply = (response = {}, status = 'ok') =>
      this._send(conn, { join_ref: msg.join_ref, ref: msg.ref, topic: msg.topic, event: 'phx_reply', payload: { status, response } });
    switch (msg.event) {
      case 'heartbeat': return reply({});
      case 'phx_join': {
        if (this.backend.realtimeJoinError) return reply({ reason: this.backend.realtimeJoinError }, 'error');
        const pcs = (msg.payload && msg.payload.config && msg.payload.config.postgres_changes) || [];
        const bindings = pcs.map((f) => ({ id: this.nextId++, event: f.event, schema: f.schema, table: f.table, filter: f.filter }));
        conn.channels.set(msg.topic, { joinRef: msg.join_ref || msg.ref, bindings });
        reply({ postgres_changes: bindings });
        this._send(conn, { topic: msg.topic, event: 'system', payload: { channel: msg.topic.replace(/^realtime:/, ''), extension: 'postgres_changes', message: 'Subscribed to PostgreSQL', status: 'ok' } });
        return;
      }
      case 'phx_leave':
        conn.channels.delete(msg.topic);
        return reply({});
      default:
        // access_token, broadcast, presence...: acknowledge if a reply is expected.
        if (msg.ref) reply({});
    }
  }

  /** Number of joined channels that listen to `table` (across all pages in the context). */
  subscriberCount(table) {
    let n = 0;
    for (const c of this.sockets) if (c.open) for (const ch of c.channels.values()) if (ch.bindings.some((b) => b.table === table || b.table === '*')) n++;
    return n;
  }

  /**
   * Push a postgres_changes event to every subscribed page.
   * type: 'INSERT' | 'UPDATE' | 'DELETE'. Returns how many channels received it.
   */
  push({ table = 'projects', type = 'UPDATE', record = {}, old_record = {}, schema = 'public' }) {
    let delivered = 0;
    for (const conn of this.sockets) {
      if (!conn.open) continue;
      for (const [topic, ch] of conn.channels) {
        const ids = ch.bindings
          .filter((b) => (b.schema === schema || b.schema === '*') && (b.table === table || b.table === '*' || b.table == null) && (b.event === '*' || String(b.event).toUpperCase() === type))
          .map((b) => b.id);
        if (!ids.length) continue;
        const cols = SCHEMA[table] || Object.keys(record);
        this._send(conn, {
          join_ref: ch.joinRef, topic, event: 'postgres_changes',
          payload: {
            ids,
            data: {
              schema, table, type, commit_timestamp: new Date().toISOString(), errors: null,
              columns: cols.map((name) => ({ name, type: name === 'data' ? 'jsonb' : 'text' })),
              record: type === 'DELETE' ? undefined : record,
              old_record: type === 'INSERT' ? undefined : old_record,
            },
          },
        });
        delivered++;
      }
    }
    return delivered;
  }
}

class MockBackend {
  constructor() {
    this.db = { projects: [], companies: [], app_users: [] };
    this.schema = clone(SCHEMA);
    this.requests = [];      // every intercepted request {method,url,host,path,query,body,headers}
    this.violations = [];    // unmocked traffic -> fixture fails the test
    this.rules = [];         // failure injection, see failNext()
    this.functionHandlers = {};
    this.rpcHandlers = {};
    this.authUsers = {};
    this.auth = {
      loginError: null,          // e.g. {status:400, error:'invalid_grant', error_description:'Invalid login credentials'}
      refreshFails: false,
      recover: { status: 200, json: {} },
      invalidTokens: new Set(),  // access tokens /auth/v1/user should reject (401)
    };
    this.serverNow = null;       // Date|number for the HEAD /rest/v1/ date header (Wall clock sync)
    this.realtimeJoinError = null;
    this.realtime = new RealtimeStub(this);
    this.onesignal = [];
  }

  // ── seeding & inspection ───────────────────────────────────────────────
  seed(data) {
    this.db.projects = clone(data.projects || []);
    this.db.companies = clone(data.companies || []);
    this.db.app_users = clone(data.app_users || []);
    this.authUsers = clone(data.authUsers || {});
    return this;
  }
  project(id) { return this.db.projects.find((p) => p.id === id); }
  table(name) { return this.db[name]; }

  /** Mutate a project's data server-side; optionally fan it out over realtime. */
  updateProject(id, mutate, { broadcast = false } = {}) {
    const p = this.project(id);
    if (!p) throw new Error(`no project ${id}`);
    const old = clone(p);
    mutate(p.data, p);
    if (broadcast) return this.realtime.push({ table: 'projects', type: 'UPDATE', record: clone(p), old_record: { id: old.id } });
    return 0;
  }

  /** Filter recorded requests: calls({method:'PATCH', path:/projects/}) */
  calls({ method, host, path: p, url } = {}) {
    return this.requests.filter((r) =>
      (!method || r.method === method) &&
      (!host || r.host === host) &&
      (!p || (p instanceof RegExp ? p.test(r.path) : r.path === p)) &&
      (!url || (url instanceof RegExp ? url.test(r.url) : r.url.includes(url))));
  }
  functionCalls(name) { return this.calls({ path: `/functions/v1/${name}` }); }

  /**
   * Inject a failure for matching requests. Rules are checked in order.
   *   { method, path: RegExp|string, url: RegExp|string, times = 1,
   *     status, json, body, headers,   // respond with this instead
   *     hang: true,                     // never answer (client timeout path)
   *     abort: 'failed'|'timedout'|..., // network error
   *     delayMs }                       // answer normally, but late (real ms)
   */
  failNext(rule) {
    this.rules.push({ times: 1, ...rule, hits: 0 });
    return this;
  }
  clearFailures() { this.rules = []; }
  setFunction(name, handler) { this.functionHandlers[name] = handler; return this; }
  setRpc(name, handler) { this.rpcHandlers[name] = handler; return this; }

  // ── wiring ─────────────────────────────────────────────────────────────
  async attach(context) {
    const isExternal = (u) => {
      const h = u.hostname;
      return !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]');
    };
    await context.route(isExternal, (route) => this._handle(route));
    if (typeof context.routeWebSocket === 'function') {
      // Any websocket: realtime gets the stub, everything else is closed.
      await context.routeWebSocket(/.*/, (ws) => {
        const u = new URL(ws.url());
        if (u.hostname === SUPA_HOST && u.pathname.startsWith('/realtime/v1/websocket')) return this.realtime._onSocket(ws);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return ws.connectToServer();
        this.violations.push(`WS ${ws.url()}`);
        ws.close({ code: 1008, reason: 'blocked by test harness' });
      });
    } else {
      throw new Error('Playwright without routeWebSocket: realtime would hit the real server. Upgrade @playwright/test.');
    }
  }

  async _handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = null;
    const raw = req.postData();
    if (raw != null) { try { body = JSON.parse(raw); } catch { body = raw; } }
    const rec = {
      method, url: req.url(), host: url.hostname, path: url.pathname,
      query: Object.fromEntries(url.searchParams), body, headers: await req.allHeaders().catch(() => req.headers()),
      at: Date.now(),
    };
    this.requests.push(rec);

    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    // failure injection
    const rule = this.rules.find((r) => r.hits < r.times &&
      (!r.method || r.method === method) &&
      (!r.path || (r.path instanceof RegExp ? r.path.test(url.pathname) : url.pathname.includes(r.path))) &&
      (!r.url || (r.url instanceof RegExp ? r.url.test(req.url()) : req.url().includes(r.url))));
    if (rule) {
      rule.hits++;
      rec.injected = true;
      if (rule.hang) return new Promise(() => {});
      if (rule.abort) return route.abort(rule.abort);
      if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
      if (rule.status) {
        return route.fulfill({
          status: rule.status,
          headers: { ...CORS, 'content-type': 'application/json', ...(rule.headers || {}) },
          body: rule.body != null ? rule.body : JSON.stringify(rule.json || { message: `injected ${rule.status}` }),
        });
      }
    }

    try {
      const res = await this._dispatch(url, method, body, rec);
      if (!res) return; // already handled
      const headers = { ...CORS, ...(res.headers || {}) };
      if (res.json !== undefined) {
        headers['content-type'] = headers['content-type'] || 'application/json; charset=utf-8';
        return route.fulfill({ status: res.status || 200, headers, body: JSON.stringify(res.json) });
      }
      if (res.path) return route.fulfill({ status: res.status || 200, headers, path: res.path });
      return route.fulfill({ status: res.status || 200, headers, body: res.body == null ? '' : res.body });
    } catch (e) {
      if (e && e.violation) {
        this.violations.push(e.violation);
        return route.abort('blockedbyclient').catch(() => {});
      }
      this.violations.push(`mock crashed on ${method} ${req.url()}: ${e && e.stack}`);
      return route.fulfill({ status: 500, headers: CORS, body: 'mock error' });
    }
  }

  _violation(msg) { const e = new Error(msg); e.violation = msg; throw e; }

  async _dispatch(url, method, body, rec) {
    const h = url.hostname;
    if (h === SUPA_HOST) return this._supabase(url, method, body, rec);
    if (h === 'cdn.jsdelivr.net') {
      if (url.pathname === SUPABASE_UMD_PATH) {
        return { path: path.join(REPO_ROOT, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), headers: { 'content-type': 'application/javascript; charset=utf-8' } };
      }
      return this._violation(`unmocked CDN ${url.href}`);
    }
    if (h === 'fonts.googleapis.com') return { path: path.join(FONTS_DIR, 'google-fonts.css'), headers: { 'content-type': 'text/css; charset=utf-8' } };
    if (h === 'fonts.gstatic.com') {
      const f = path.join(FONTS_DIR, 'gstatic', url.pathname);
      if (fs.existsSync(f)) return { path: f, headers: { 'content-type': 'font/woff2' } };
      return this._violation(`missing local font ${url.href} (re-download into tests/support/fonts)`);
    }
    if (/(^|\.)onesignal\.com$/.test(h)) {
      // Never real. Recorded so specs can assert what *would* have been pushed.
      this.onesignal.push(rec);
      if (h === 'cdn.onesignal.com') return { body: '/* OneSignal SDK stubbed by test harness */', headers: { 'content-type': 'application/javascript' } };
      return { json: { id: 'mock-notification', recipients: 0 } };
    }
    return this._violation(`unmocked external request ${method} ${url.href}`);
  }

  async _supabase(url, method, body, rec) {
    const p = url.pathname;
    if (p === '/rest/v1/' || p === '/rest/v1') {
      const now = this.serverNow != null ? new Date(this.serverNow) : null;
      return { status: 200, headers: now ? { date: now.toUTCString() } : {}, body: '' };
    }
    if (p.startsWith('/rest/v1/rpc/')) return this._rpc(p.slice('/rest/v1/rpc/'.length), body, rec);
    if (p.startsWith('/rest/v1/')) return this._postgrest(p.slice('/rest/v1/'.length), method, url, body, rec);
    if (p.startsWith('/auth/v1/')) return this._auth(p.slice('/auth/v1/'.length), method, url, body, rec);
    if (p.startsWith('/functions/v1/')) {
      const name = p.slice('/functions/v1/'.length);
      const handler = this.functionHandlers[name];
      if (handler) {
        const r = await handler(body, rec, this);
        return r && (r.status || r.json !== undefined || r.body !== undefined) ? r : { json: r == null ? {} : r };
      }
      return { json: { ok: true, mocked: name } };
    }
    if (p.startsWith('/storage/v1/')) return this._violation(`unmocked storage call ${method} ${url.href}`);
    return this._violation(`unmocked supabase path ${method} ${url.href}`);
  }

  // ── RPC ────────────────────────────────────────────────────────────────
  async _rpc(fn, body, rec) {
    if (this.rpcHandlers[fn]) return this.rpcHandlers[fn](body, rec, this);
    if (fn === 'get_shared_project') {
      const pr = this.db.projects.find((x) => String(x.id) === String(body && body.p_id));
      return { json: pr ? clone({ id: pr.id, name: pr.name, company_id: pr.company_id, data: pr.data }) : null };
    }
    if (fn === 'set_show_arrived') {
      const pr = this.db.projects.find((x) => String(x.id) === String(body.p_id));
      if (!pr || !Array.isArray(pr.data && pr.data.shows)) return pgError(400, 'P0002', `project ${body.p_id} has no shows array`);
      const s = pr.data.shows.find((x) => x.id === body.p_show_id);
      if (!s) return pgError(400, 'P0002', `show ${body.p_show_id} not found in project ${body.p_id}`);
      s.arrived = !!body.p_arrived;
      s.arrivedAt = body.p_arrived_at == null ? null : body.p_arrived_at;
      return { json: clone(pr.data) };
    }
    return pgError(404, 'PGRST202', `Could not find the function public.${fn} in the schema cache`);
  }

  // ── PostgREST ──────────────────────────────────────────────────────────
  _postgrest(table, method, url, body, rec) {
    if (!this.db[table]) return pgError(404, '42P01', `relation "public.${table}" does not exist`);
    const cols = this.schema[table];
    const q = url.searchParams;
    const prefer = (rec.headers.prefer || '').toLowerCase();
    const accept = (rec.headers.accept || '').toLowerCase();

    const filters = [];
    for (const [k, v] of q.entries()) {
      if (RESERVED.has(k)) continue;
      if (k === 'or' || k === 'and') throw new Error('mock PostgREST: or/and filters not supported');
      if (!cols.includes(k)) return pgError(400, '42703', `column ${table}.${k} does not exist`);
      filters.push([k, v]);
    }
    const select = parseSelect(q.get('select'));
    if (select !== '*') {
      for (const s of select) if (!cols.includes(s.col)) return pgError(400, '42703', `column ${table}.${s.col} does not exist`);
    }
    const project = (row) => {
      const out = {};
      if (select === '*') { for (const c of cols) out[c] = row[c] === undefined ? null : row[c]; return out; }
      for (const s of select) out[s.alias] = row[s.col] === undefined ? null : row[s.col];
      return out;
    };
    const matches = (row) => filters.every(([k, v]) => matchFilter(row, k, v));
    const respond = (rows, status = 200) => {
      const headers = {};
      if (prefer.includes('count=exact')) headers['content-range'] = `0-${Math.max(0, rows.length - 1)}/${rows.length}`;
      if (accept.includes('application/vnd.pgrst.object+json')) {
        if (rows.length !== 1) return pgError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', { details: `The result contains ${rows.length} rows` });
        return { status, headers, json: rows[0] };
      }
      return { status, headers, json: rows };
    };
    const checkBody = (obj) => {
      for (const k of Object.keys(obj)) if (!cols.includes(k)) return pgError(400, 'PGRST204', `Could not find the '${k}' column of '${table}' in the schema cache`);
      return null;
    };
    const wantRep = prefer.includes('return=representation');

    if (method === 'GET' || method === 'HEAD') {
      let rows = this.db[table].filter(matches);
      const order = q.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        rows = rows.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      const off = Number(q.get('offset') || 0);
      const lim = q.get('limit');
      rows = rows.slice(off, lim != null ? off + Number(lim) : undefined);
      return respond(rows.map(project));
    }
    if (method === 'PATCH') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return pgError(400, 'PGRST102', 'Invalid body');
      const err = checkBody(body); if (err) return err;
      const rows = this.db[table].filter(matches);
      for (const r of rows) Object.assign(r, clone(body));
      return wantRep ? respond(rows.map(project)) : { status: 204, body: '' };
    }
    if (method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const upsert = prefer.includes('resolution=merge-duplicates');
      const out = [];
      for (const item of list) {
        const err = checkBody(item); if (err) return err;
        const existing = item.id != null && this.db[table].find((r) => String(r.id) === String(item.id));
        if (existing) {
          if (!upsert) return pgError(409, '23505', `duplicate key value violates unique constraint "${table}_pkey"`);
          Object.assign(existing, clone(item));
          out.push(existing);
        } else {
          const row = {};
          for (const c of cols) row[c] = null;
          Object.assign(row, clone(item));
          this.db[table].push(row);
          out.push(row);
        }
      }
      return wantRep ? respond(out.map(project), 201) : { status: 201, body: '' };
    }
    if (method === 'DELETE') {
      const del = this.db[table].filter(matches);
      if (!filters.length) return pgError(400, '21000', 'DELETE requires a WHERE clause');
      this.db[table] = this.db[table].filter((r) => !del.includes(r));
      return wantRep ? respond(del.map(project)) : { status: 204, body: '' };
    }
    return pgError(405, 'PGRST000', `method ${method} not supported by mock`);
  }

  // ── Auth (GoTrue) ──────────────────────────────────────────────────────
  _userJson(u) {
    return {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
      email_confirmed_at: '2026-01-01T10:00:00Z', confirmed_at: '2026-01-01T10:00:00Z',
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.user_metadata || {},
      identities: [], created_at: '2026-01-01T10:00:00Z', updated_at: '2026-01-01T10:00:00Z',
    };
  }
  _session(u) {
    return {
      access_token: mockJwt(u), token_type: 'bearer', expires_in: 3600,
      expires_at: 4102444800, refresh_token: `rt-${u.id}`, user: this._userJson(u),
    };
  }
  _userFromBearer(rec) {
    const auth = rec.headers.authorization || '';
    const tok = auth.replace(/^Bearer\s+/i, '');
    if (!tok || this.auth.invalidTokens.has(tok)) return null;
    try {
      const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
      if (payload.role !== 'authenticated') return null;
      return Object.values(this.authUsers).find((u) => u.id === payload.sub) || null;
    } catch { return null; }
  }

  _auth(sub, method, url, body, rec) {
    const grant = url.searchParams.get('grant_type');
    if (sub === 'token' && grant === 'password') {
      if (this.auth.loginError) return { status: this.auth.loginError.status || 400, json: this.auth.loginError };
      const u = this.authUsers[(body && body.email || '').toLowerCase()];
      if (!u || u.password !== body.password) return { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' } };
      return { json: this._session(u) };
    }
    if (sub === 'token' && grant === 'refresh_token') {
      const id = String(body && body.refresh_token || '').replace(/^rt-/, '');
      const u = Object.values(this.authUsers).find((x) => x.id === id);
      if (this.auth.refreshFails || !u) return { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found', code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' } };
      return { json: this._session(u) };
    }
    if (sub === 'user') {
      const u = this._userFromBearer(rec);
      if (!u) return { status: 401, json: { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature' } };
      if (method === 'PUT') {
        if (body && body.password) u.password = body.password;
        if (body && body.data) u.user_metadata = { ...(u.user_metadata || {}), ...body.data };
      }
      return { json: this._userJson(u) };
    }
    if (sub === 'logout') return { status: 204, body: '' };
    if (sub === 'recover') return { status: this.auth.recover.status || 200, json: this.auth.recover.json || {} };
    if (sub === 'otp' || sub === 'verify' || sub === 'resend') return { json: {} };
    if (sub === 'settings') return { json: { external: { email: true }, disable_signup: true } };
    return this._violation(`unmocked auth endpoint ${method} ${url.href}`);
  }
}

module.exports = { MockBackend, RealtimeStub, mockJwt, authBackupFor, SUPA_HOST, SCHEMA };
