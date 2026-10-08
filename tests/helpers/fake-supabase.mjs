// A fake Supabase project for Node tests: the slice of the supabase-js v2 client
// API that src/store-pwa.js uses, backed by one in-memory "server" that several
// fake devices can share. It reproduces the server semantics of supabase/schema.sql:
//   * updated_at is stamped by the server (distinct, increasing timestamps with
//     microseconds, "2026-10-08T07:00:00.123456+00:00"); clients never set it;
//   * last writer wins: an update with a smaller client_updated_ms keeps the old
//     row (the trigger returns NULL), an equal one is applied again;
//   * RLS: a signed-in user reads and writes only rows with user_id = auth.uid();
//     the anon role gets nothing;
//   * check constraints of the schema (type, amount, date range, id format, …);
//   * realtime postgres_changes events to subscribed channels (filter user_id=eq.<uid>).
// It can simulate network failure (whole server or one device), lost responses,
// rate limits, unconfirmed e-mail, revoked sessions and late-committed rows.

let seq = 0;
const uuid = () => {
  const h = (++seq).toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
};
export const FAKE_URL = "https://fake.supabase.co";
// header.payload.signature with payload {"role":"anon"}
export const FAKE_ANON_KEY = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ role: "anon", iss: "supabase" })).toString("base64url") + ".c2lnbmF0dXJl";
export const FAKE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url") + ".c2lnbmF0dXJl";

const TX_COLS = ["user_id", "id", "type", "amount", "category", "note", "date", "created_ms", "example", "deleted", "client_updated_ms", "updated_at"];

function tsUs(s) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(s));
  if (!m) throw new Error("fake supabase: bad timestamp " + s);
  return Date.parse(`${m[1]}T${m[2]}${m[4]}`) * 1000 + Number(((m[3] || "") + "000000").slice(0, 6));
}
function fmtUs(us) {
  const sec = Math.floor(us / 1e6);
  return new Date(sec * 1000).toISOString().slice(0, 19) + "." + String(us - sec * 1e6).padStart(6, "0") + "+00:00";
}
function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && s >= "1900-01-01" && s <= "2199-12-31";
}
const netError = () => ({ data: null, error: { message: "TypeError: fetch failed", details: "", hint: "", code: "" }, count: null, status: 0, statusText: "" });
const pgErr = (status, code, message) => ({ data: null, error: { message, details: null, hint: null, code }, count: null, status, statusText: "" });

class AuthError extends Error {
  constructor(name, message, status, code, extra = {}) { super(message); this.name = name; this.status = status; this.code = code; Object.assign(this, extra); this.__isAuthError = true; }
}
const authApi = (message, status, code, extra) => new AuthError("AuthApiError", message, status, code, extra);
const retryable = () => new AuthError("AuthRetryableFetchError", "fetch failed", 0, undefined);

export function createFakeSupabase({ url = FAKE_URL, anonKey = FAKE_ANON_KEY, requireConfirm = false } = {}) {
  const server = {
    url, anonKey, requireConfirm,
    users: new Map(),            // email → { id, email, password, confirmed }
    tokens: new Map(),           // access token → uid
    refresh: new Map(),          // refresh token → uid
    tables: { transactions: new Map(), budget_settings: new Map() },
    lastUs: Date.UTC(2026, 9, 8, 7, 0, 0) * 1000,
    offline: false,              // every request fails like fetch() without network
    dropNextResponse: false,     // the next write is applied but its response is lost
    rateLimitAuth: false,
    realtime: true,
    backdateNextMs: 0,           // next write gets updated_at this far in the past (a long transaction)
    hooks: { beforeUpsert: null, beforeSelect: null },
    changeListeners: new Set(),  // (table, [{ eventType, row, old }]) for adapters (e.g. a WebSocket mock)
    log: [],                     // { op, table, uid, rows | range }
    signOutScopes: [],
    emails: [],
    clients: [],
    channels: new Set(),

    addUser(email, password = "secret123", { confirmed = true } = {}) {
      const u = { id: uuid(), email, password, confirmed };
      server.users.set(email, u);
      return u;
    },
    confirm(email) { server.users.get(email).confirmed = true; },
    revokeUser(uid) {
      for (const [t, id] of server.tokens) if (id === uid) server.tokens.delete(t);
      for (const [t, id] of server.refresh) if (id === uid) server.refresh.delete(t);
    },
    issue(uid) {
      const access = "at-" + uid.slice(-4) + "-" + (++seq);
      const refresh = "rt-" + (++seq);
      server.tokens.set(access, uid);
      server.refresh.set(refresh, uid);
      const u = [...server.users.values()].find(x => x.id === uid);
      return { access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: 3600, user: { id: uid, email: u.email, aud: "authenticated" } };
    },
    recoveryLink(email) {
      const u = server.users.get(email);
      const s = server.issue(u.id);
      return `#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer&type=recovery`;
    },
    stamp() {
      server.lastUs = Math.max(server.lastUs + 1, Date.now() * 1000);
      return fmtUs(server.lastUs - server.backdateNextMs * 1000);
    },
    rows(table, uid) {
      return [...server.tables[table].values()].filter(r => !uid || r.user_id === uid).map(r => ({ ...r }));
    },
    // write a row as if from another client (bypasses the client library)
    put(table, row) { return applyUpsert(table, [row], row.user_id); },
    createClient(curl, key, options, win) {
      const client = new FakeClient(server, curl, key, options || {}, win);
      server.clients.push(client);
      return client;
    },
  };

  function checkTx(r) {
    const bad = name => pgErr(400, "23514", `new row for relation "transactions" violates check constraint "${name}"`);
    if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) return bad("transactions_id_format");
    if (r.type != null && !["income", "expense", "saving"].includes(r.type)) return bad("transactions_type_valid");
    if (r.amount != null && !(typeof r.amount === "number" && r.amount > 0 && r.amount < 1e10)) return bad("transactions_amount_range");
    if (r.category != null && String(r.category).length > 32) return bad("transactions_category_length");
    if (r.note != null && String(r.note).length > 200) return bad("transactions_note_length");
    if (r.date != null && !validDate(r.date)) return pgErr(400, "22008", `date/time field value out of range: "${r.date}"`);
    if (!(Number(r.created_ms ?? 0) >= 0 && Number(r.client_updated_ms ?? 0) >= 0)) return bad("transactions_ms_range");
    if (!r.deleted && (r.type == null || r.amount == null || r.date == null)) return bad("transactions_live_row_complete");
    if ("updated_at" in r) return null;   // the trigger overwrites it anyway
    return null;
  }

  function applyUpsert(table, rows, uid) {
    const map = server.tables[table];
    const changes = [];
    for (const input of rows) {
      const r = { ...input };
      if (r.user_id == null) r.user_id = uid;
      const key = table === "transactions" ? `${r.user_id}|${r.id}` : r.user_id;
      const old = map.get(key);
      if (old) {
        if (Number(r.client_updated_ms ?? 0) < Number(old.client_updated_ms)) continue;   // LWW: trigger returns NULL
        const next = { ...old, ...r, updated_at: server.stamp() };
        if (table === "transactions") { next.category ??= ""; next.note ??= ""; next.example ??= false; next.deleted ??= false; next.created_ms ??= 0; }
        map.set(key, next);
        changes.push({ eventType: "UPDATE", row: next, old });
      } else {
        const base = table === "transactions"
          ? { user_id: r.user_id, id: r.id, type: null, amount: null, category: "", note: "", date: null, created_ms: 0, example: false, deleted: false, client_updated_ms: 0 }
          : { user_id: r.user_id, data: {}, client_updated_ms: 0 };
        const next = { ...base, ...r, updated_at: server.stamp() };
        if (table === "transactions") { next.category ??= ""; next.note ??= ""; next.example ??= false; next.deleted ??= false; next.created_ms ??= 0; }
        map.set(key, next);
        changes.push({ eventType: "INSERT", row: next, old: null });
      }
    }
    server.backdateNextMs = 0;
    emitRealtime(table, changes);
    if (changes.length) for (const l of server.changeListeners) l(table, changes);
    return changes.length;
  }

  function emitRealtime(table, changes) {
    if (!server.realtime) return;
    for (const ch of server.channels) {
      if (ch.state !== "joined") continue;
      const uid = ch.client._uid();
      if (!uid) continue;
      for (const c of changes) {
        if (c.row.user_id !== uid) continue;                     // RLS on realtime
        for (const h of ch.handlers) {
          const f = h.filter;
          if (f.table !== table || (f.schema && f.schema !== "public")) continue;
          if (f.event && f.event !== "*" && f.event !== c.eventType) continue;
          if (f.filter && f.filter !== `user_id=eq.${c.row.user_id}`) continue;
          const payload = { schema: "public", table, commit_timestamp: c.row.updated_at, eventType: c.eventType, new: { ...c.row }, old: c.old ? { user_id: c.old.user_id, ...(c.old.id ? { id: c.old.id } : {}) } : {}, errors: null };
          setTimeout(() => { if (ch.state === "joined") h.cb(payload); }, 0);
        }
      }
    }
  }

  server._applyUpsert = applyUpsert;
  server._checkTx = checkTx;
  return server;
}

/* ── client ─────────────────────────────────────────────────────────────── */
class FakeClient {
  constructor(server, url, key, options, win) {
    this.server = server; this.url = url; this.key = key; this.options = options; this.win = win;
    this.removed = [];
    this.auth = new FakeAuth(this);
  }
  _down() { return this.server.offline || (this.win && (this.win.netDown || this.win.navigator?.onLine === false)); }
  _badKey() { return this.url !== this.server.url || this.key !== this.server.anonKey; }
  _uid() { const s = this.auth.session; return s ? this.server.tokens.get(s.access_token) || null : null; }
  from(table) { return new Query(this, table); }
  channel(name) {
    if (!this.server.realtime) throw new Error("realtime unavailable");
    return new FakeChannel(this, name);
  }
  removeChannel(ch) { this.removed.push(ch); ch._leave(); return Promise.resolve("ok"); }
  removeAllChannels() { for (const ch of [...this.server.channels]) if (ch.client === this) this.removeChannel(ch); return Promise.resolve([]); }
}

class FakeChannel {
  constructor(client, name) { this.client = client; this.name = name; this.handlers = []; this.state = "closed"; }
  on(type, filter, cb) {
    if (type !== "postgres_changes") throw new Error("fake channel: only postgres_changes");
    this.handlers.push({ filter, cb });
    return this;
  }
  subscribe(cb) {
    this.state = "joining";
    this.client.server.channels.add(this);
    setTimeout(() => { if (this.state === "joining") { this.state = "joined"; cb && cb("SUBSCRIBED"); } }, 0);
    this._cb = cb;
    return this;
  }
  // test helper: the socket dropped and came back
  reconnect() { setTimeout(() => this._cb && this.state === "joined" && this._cb("SUBSCRIBED"), 0); }
  _leave() { this.state = "closed"; this.client.server.channels.delete(this); }
  unsubscribe() { this._leave(); return Promise.resolve("ok"); }
}

class Query {
  constructor(client, table) {
    this.client = client; this.server = client.server; this.table = table;
    this.op = "select"; this.filters = []; this.orders = []; this.rangeV = null; this.payload = null; this.opts = {};
    if (!(table in this.server.tables)) this.missing = true;
  }
  select(cols = "*", opts = {}) { if (this.op === "select") this.cols = cols; this.selectOpts = opts; return this; }
  eq(col, v) { this.filters.push(["eq", col, v]); return this; }
  gt(col, v) { this.filters.push(["gt", col, v]); return this; }
  gte(col, v) { this.filters.push(["gte", col, v]); return this; }
  order(col, { ascending = true } = {}) { this.orders.push([col, ascending]); return this; }
  range(from, to) { this.rangeV = [from, to]; return this; }
  limit(n) { this.rangeV = [0, n - 1]; return this; }
  upsert(rows, opts = {}) { this.op = "upsert"; this.payload = rows; this.opts = opts; return this; }
  delete() { this.op = "delete"; return this; }
  then(resolve, reject) { return this._exec().then(resolve, reject); }

  _match(r) {
    for (const [op, col, v] of this.filters) {
      const a = r[col];
      if (op === "eq" && String(a) !== String(v)) return false;
      if (op === "gt" || op === "gte") {
        const cmp = col === "updated_at" ? tsUs(a) - tsUs(v) : Number(a) - Number(v);
        if (op === "gt" ? !(cmp > 0) : !(cmp >= 0)) return false;
      }
    }
    return true;
  }
  async _exec() {
    const s = this.server, c = this.client;
    await new Promise(r => setTimeout(r, 0));
    if (c._down()) return netError();
    if (c._badKey()) return pgErr(401, "", "Invalid API key");
    if (this.missing) return pgErr(404, "PGRST205", `Could not find the table 'public.${this.table}' in the schema cache`);
    const token = c.auth.session && c.auth.session.access_token;
    const uid = token ? s.tokens.get(token) : null;
    if (token && !uid) return pgErr(401, "PGRST301", "JWT expired");

    if (this.op === "select") {
      if (s.hooks.beforeSelect) await s.hooks.beforeSelect(this.table, this);
      if (c._down()) return netError();
      if (!uid) return pgErr(401, "42501", `permission denied for table ${this.table}`);
      let rows = [...s.tables[this.table].values()].filter(r => r.user_id === uid && this._match(r));
      rows.sort((a, b) => {
        for (const [col, asc] of this.orders) {
          const x = col === "updated_at" ? tsUs(a[col]) : a[col], y = col === "updated_at" ? tsUs(b[col]) : b[col];
          if (x < y) return asc ? -1 : 1;
          if (x > y) return asc ? 1 : -1;
        }
        return 0;
      });
      const total = rows.length;
      if (this.rangeV) rows = rows.slice(this.rangeV[0], this.rangeV[1] + 1);
      s.log.push({ op: "select", table: this.table, uid, range: this.rangeV, n: rows.length, filters: this.filters.map(f => [...f]) });
      return { data: rows.map(r => ({ ...r })), error: null, count: this.selectOpts?.count ? total : null, status: 200, statusText: "OK" };
    }

    if (this.op === "upsert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      const want = this.table === "transactions" ? "user_id,id" : "user_id";
      s.log.push({ op: "upsert", table: this.table, uid, n: rows.length, onConflict: this.opts.onConflict, ids: rows.map(r => r.id) });
      if (!uid) return pgErr(401, "42501", `permission denied for table ${this.table}`);
      if (this.opts.onConflict !== want) return pgErr(400, "42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification");
      for (const r of rows) {
        if ((r.user_id ?? uid) !== uid) return pgErr(403, "42501", `new row violates row-level security policy for table "${this.table}"`);
        if ("updated_at" in r) return pgErr(400, "FAKE1", "client must not send updated_at");
        if (this.table === "transactions") { const e = s._checkTx(r); if (e) return e; }
        else if (!r.data || typeof r.data !== "object" || Array.isArray(r.data)) return pgErr(400, "23514", 'violates check constraint "budget_settings_data_object"');
      }
      if (s.hooks.beforeUpsert) await s.hooks.beforeUpsert(this.table, rows, c);
      if (c._down()) return netError();
      s._applyUpsert(this.table, rows, uid);
      if (s.dropNextResponse) { s.dropNextResponse = false; return netError(); }
      return { data: null, error: null, count: null, status: 201, statusText: "Created" };
    }

    if (this.op === "delete") {
      if (!uid) return pgErr(401, "42501", `permission denied for table ${this.table}`);
      const map = s.tables[this.table];
      for (const [k, r] of [...map]) if (r.user_id === uid && this._match(r)) map.delete(k);
      s.log.push({ op: "delete", table: this.table, uid });
      return { data: null, error: null, count: null, status: 204, statusText: "No Content" };
    }
    throw new Error("fake supabase: unsupported op " + this.op);
  }
}

class FakeAuth {
  constructor(client) {
    this.client = client;
    this.server = client.server;
    const o = client.options.auth || {};
    this.storageKey = o.storageKey || "sb-fake-auth-token";
    this.persist = o.persistSession !== false;
    this.listeners = new Set();
    this.session = null;
    const ls = client.win && client.win.localStorage;
    if (this.persist && ls) {
      try { const raw = ls.getItem(this.storageKey); if (raw) this.session = JSON.parse(raw); } catch (e) { this.session = null; }
    }
    this.urlEvent = null;
    const loc = client.win && client.win.location;
    if (o.detectSessionInUrl && loc && /access_token=/.test(loc.hash || "")) {
      const p = new URLSearchParams(loc.hash.slice(1));
      const uid = this.server.tokens.get(p.get("access_token"));
      if (uid) {
        const u = [...this.server.users.values()].find(x => x.id === uid);
        this._save({ access_token: p.get("access_token"), refresh_token: p.get("refresh_token"), user: { id: uid, email: u.email } });
        this.urlEvent = p.get("type") === "recovery" ? "PASSWORD_RECOVERY" : "SIGNED_IN";
      }
      loc.hash = "";
    }
    // like supabase-js: the URL session is announced during initialisation, before INITIAL_SESSION
    if (this.urlEvent) setTimeout(() => this._emit(this.urlEvent, this.session), 0);
  }
  _save(session) {
    this.session = session;
    const ls = this.client.win && this.client.win.localStorage;
    if (this.persist && ls) { if (session) ls.setItem(this.storageKey, JSON.stringify(session)); else ls.removeItem(this.storageKey); }
  }
  _emit(event, session) { for (const cb of [...this.listeners]) cb(event, session); }
  _down() { return this.client._down(); }
  onAuthStateChange(cb) {
    this.listeners.add(cb);
    setTimeout(() => { if (this.listeners.has(cb)) cb("INITIAL_SESSION", this.session); }, 1);
    return { data: { subscription: { id: String(++seq), unsubscribe: () => this.listeners.delete(cb) } } };
  }
  async getSession() { return { data: { session: this.session }, error: null }; }
  async signUp({ email, password, options = {} }) {
    await null;
    if (this._down()) return { data: { user: null, session: null }, error: retryable() };
    if (this.server.rateLimitAuth) return { data: { user: null, session: null }, error: authApi("Request rate limit reached", 429, "over_request_rate_limit") };
    if (String(password).length < 6) return { data: { user: null, session: null }, error: new AuthError("AuthWeakPasswordError", "Password should be at least 6 characters.", 422, "weak_password", { reasons: ["length"] }) };
    const existing = this.server.users.get(email);
    if (existing && existing.confirmed) return { data: { user: null, session: null }, error: authApi("User already registered", 422, "user_already_exists") };
    const u = existing || this.server.addUser(email, password, { confirmed: !this.server.requireConfirm });
    this.server.emails.push({ type: "signup", email, redirectTo: options.emailRedirectTo });
    if (this.server.requireConfirm) return { data: { user: { id: u.id, email }, session: null }, error: null };
    const s = this.server.issue(u.id);
    this._save(s);
    this._emit("SIGNED_IN", s);
    return { data: { user: s.user, session: s }, error: null };
  }
  async signInWithPassword({ email, password }) {
    await null;
    if (this._down()) return { data: { user: null, session: null }, error: retryable() };
    if (this.server.rateLimitAuth) return { data: { user: null, session: null }, error: authApi("Request rate limit reached", 429, "over_request_rate_limit") };
    const u = this.server.users.get(email);
    if (!u || u.password !== password) return { data: { user: null, session: null }, error: authApi("Invalid login credentials", 400, "invalid_credentials") };
    if (!u.confirmed) return { data: { user: null, session: null }, error: authApi("Email not confirmed", 400, "email_not_confirmed") };
    const s = this.server.issue(u.id);
    this._save(s);
    this._emit("SIGNED_IN", s);
    return { data: { user: s.user, session: s }, error: null };
  }
  async signOut({ scope = "global" } = {}) {
    await null;
    this.server.signOutScopes.push(scope);
    if (this._down()) return { error: retryable() };   // like supabase-js: the session stays when the call fails
    if (this.session) {
      const uid = this.server.tokens.get(this.session.access_token);
      if (scope === "global" && uid) this.server.revokeUser(uid);
      else this.server.tokens.delete(this.session.access_token);
    }
    this._save(null);
    this._emit("SIGNED_OUT", null);
    return { error: null };
  }
  async resetPasswordForEmail(email, options = {}) {
    await null;
    if (this._down()) return { data: null, error: retryable() };
    if (this.server.rateLimitAuth) return { data: null, error: authApi("For security purposes, you can only request this after 60 seconds.", 429, "over_email_send_rate_limit") };
    this.server.emails.push({ type: "recovery", email, redirectTo: options.redirectTo });
    return { data: {}, error: null };
  }
  async updateUser({ password }) {
    await null;
    if (this._down()) return { data: { user: null }, error: retryable() };
    const uid = this.session && this.server.tokens.get(this.session.access_token);
    if (!uid) return { data: { user: null }, error: new AuthError("AuthSessionMissingError", "Auth session missing!", 400, undefined) };
    const u = [...this.server.users.values()].find(x => x.id === uid);
    if (String(password).length < 6) return { data: { user: null }, error: new AuthError("AuthWeakPasswordError", "Password should be at least 6 characters.", 422, "weak_password", { reasons: ["length"] }) };
    if (password === u.password) return { data: { user: null }, error: authApi("New password should be different from the old password.", 422, "same_password") };
    u.password = password;
    const user = { id: uid, email: u.email };
    this._emit("USER_UPDATED", this.session);
    return { data: { user }, error: null };
  }
  async refreshSession() {
    await null;
    if (this._down()) return { data: { session: null, user: null }, error: retryable() };
    const uid = this.session && this.server.refresh.get(this.session.refresh_token);
    if (!uid) return { data: { session: null, user: null }, error: authApi("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found") };
    this.server.refresh.delete(this.session.refresh_token);
    const s = this.server.issue(uid);
    this._save(s);
    this._emit("TOKEN_REFRESHED", s);
    return { data: { session: s, user: s.user }, error: null };
  }
  async stopAutoRefresh() { this.stopped = true; }
}

export { tsUs, fmtUs, TX_COLS };
