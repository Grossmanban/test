/*
 * store-pwa.js: the PWA storage adapter for «Домашняя бухгалтерия».
 *
 * window.createBudgetStore(opts) → Store (docs/ARCHITECTURE.md: Store, store.sync,
 * store.backup, snap.sync). Local-first: every write lands in IndexedDB first
 * (database "budget-pwa", object store "kv", keys "tx" / "settings" / "meta"),
 * falling back to localStorage and then memory, and is synced afterwards to the
 * user's own Supabase project (tables public.transactions, public.budget_settings).
 *
 * Every storage write is a read-modify-write inside one IndexedDB transaction, so
 * two tabs never overwrite each other's records, and sync steps re-check the
 * stored state (owner, record version) when they apply their result.
 *
 * Node tests inject dependencies through opts:
 *   window          object with the browser globals used here (indexedDB, localStorage,
 *                   navigator, document, location, crypto, BroadcastChannel,
 *                   BUDGET_CONFIG, BudgetSeed, supabase, addEventListener)
 *   storage         "auto" (default) | "idb" | "local" | "memory"
 *   indexedDB, localStorage   override the ones on window
 *   supabaseFactory (url, key, options) => client   (default window.supabase.createClient)
 *   now             () => ms epoch
 *   online          () => boolean   (default navigator.onLine)
 *   delays          { write: 1500, realtime: 800, interval: 60000, idbTimeout: 4000 }
 */
(function (root) {
  "use strict";

  const DB_NAME = "budget-pwa";
  const KV = "kv";
  const ALL = ["tx", "settings", "meta"];
  const LS_DATA = "budget-pwa-data";          // localStorage fallback (migrated into IndexedDB when it works again)
  const LS_CONFIG = "budget-pwa-supabase";    // project URL + key entered on this device
  const AUTH_KEY = "budget-pwa-auth";         // supabase-js session storage key
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const PAGE = 1000;
  const CHUNK = 500;
  const OVERLAP_MS = 2 * 60 * 1000;
  const MAX_AMOUNT = 9999999999.99;           // schema: amount > 0 and amount < 1e10
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const TYPES = ["income", "expense", "saving"];
  const SETTINGS_KEYS = ["startBalance", "goal", "limits"];
  const SETTINGS_DEFAULTS = { startBalance: 0, goal: null, limits: {} };
  const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const STALE = { stale: true };              // thrown to abandon a sync whose account is gone

  const M = {
    txInvalid: "Не удалось сохранить: проверьте данные операции.",
    txType: "Не удалось сохранить: неизвестный тип операции.",
    txAmount: "Сумма должна быть больше нуля и меньше 10 000 000 000 ₽.",
    txDate: "Укажите дату операции.",
    txId: "Не удалось сохранить: неверный идентификатор операции.",
    settingsInvalid: "Не удалось сохранить: проверьте введённые значения.",
    quota: "На устройстве закончилось место для данных. Освободите память и повторите.",
    storage: "Не удалось сохранить данные на устройстве. Повторите попытку.",
    network: "Нет соединения с сервером. Проверьте интернет и повторите.",
    server: "Сервер синхронизации не отвечает. Повторите попытку позже.",
    rate: "Слишком много попыток подряд. Подождите минуту и повторите.",
    rateEmail: "Письма отправляются слишком часто. Подождите несколько минут и повторите.",
    badCredentials: "Неверная почта или пароль.",
    notConfirmed: "Подтвердите почту по ссылке из письма, затем войдите.",
    weakPassword: "Пароль слишком простой. Придумайте пароль подлиннее, с буквами и цифрами.",
    pwnedPassword: "Этот пароль встречался в утечках данных. Придумайте другой.",
    shortPassword: "Пароль должен быть не короче 6 символов.",
    noPassword: "Введите пароль.",
    samePassword: "Новый пароль совпадает со старым. Придумайте другой.",
    userExists: "Аккаунт с этой почтой уже есть. Войдите или восстановите пароль.",
    badEmail: "Проверьте адрес почты.",
    signupDisabled: "Регистрация новых пользователей отключена в настройках проекта Supabase.",
    banned: "Этот аккаунт заблокирован.",
    sessionExpired: "Сессия истекла. Войдите снова.",
    sessionEnded: "Сессия завершена. Войдите снова, чтобы продолжить синхронизацию.",
    linkExpired: "Ссылка из письма устарела или уже использована. Запросите новое письмо.",
    linkFailed: "Не удалось войти по ссылке из письма. Запросите новое письмо.",
    noAccess: "Нет доступа к данным аккаунта. Войдите снова.",
    needSignIn: "Сначала войдите в аккаунт.",
    recoveryExpired: "Ссылка для смены пароля устарела. Запросите новое письмо.",
    authFailed: "Не удалось выполнить запрос. Повторите попытку позже.",
    notConfigured: "Синхронизация не настроена: укажите адрес проекта и ключ.",
    noLibrary: "Модуль синхронизации не загрузился. Обновите страницу.",
    badKey: "Неверный ключ проекта. Проверьте ключ в настройках синхронизации.",
    noSchema: "В проекте Supabase нет таблиц бюджета. Выполните supabase/schema.sql в SQL Editor.",
    serverReadOnly: "Проект Supabase сейчас открыт только для чтения (закончилось место). Изменения сохраняются на устройстве.",
    serverFull: "В проекте Supabase закончилось место. Изменения сохраняются на устройстве.",
    serverRejected: "Сервер отклонил данные. Проверьте, что схема базы обновлена (supabase/schema.sql).",
    syncFailed: "Не удалось синхронизировать. Повторим попытку позже.",
    cfgFile: "Проект указан в config.js, на этом устройстве его изменить нельзя.",
    cfgUrl: "Укажите адрес проекта Supabase (Project URL).",
    cfgUrlBad: "Адрес проекта должен начинаться с https://, например https://abcd.supabase.co",
    cfgKey: "Укажите ключ проекта: anon или publishable key.",
    cfgKeyBad: "Ключ не похож на anon/publishable key: он начинается с «eyJ» или «sb_publishable_».",
    cfgKeySecret: "Это секретный ключ: его нельзя хранить в приложении. Вставьте anon или publishable key.",
    notBackup: "Файл не похож на резервную копию бюджета.",
    backupVersion: "Резервная копия сделана более новой версией приложения. Обновите приложение.",
    backupSettings: "Ошибка в файле: настройки бюджета повреждены.",
    noticeLocal: "Основное хранилище браузера недоступно: данные сохраняются в запасном, где мало места. Сделайте резервную копию.",
    noticeMemory: "Браузер не разрешает сохранять данные (например, в приватном режиме). Всё, что вы введёте, пропадёт после закрытия страницы. Войдите в аккаунт для синхронизации или сделайте резервную копию.",
  };

  /* ── small helpers ─────────────────────────── */
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const r2 = n => Math.round(n * 100) / 100;
  const pad = n => String(n).padStart(2, "0");
  const noop = () => {};
  const clone = typeof root.structuredClone === "function"
    ? v => (v == null ? v : root.structuredClone(v))
    : v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const defer = typeof root.queueMicrotask === "function" ? fn => root.queueMicrotask(fn) : fn => Promise.resolve().then(fn);

  function fail(code, message, cause) {
    const e = new Error(message);
    e.code = code;
    if (cause !== undefined) e.cause = cause;
    Object.defineProperty(e, "budget", { value: true });   // classified already
    return e;
  }
  function withTimeout(p, ms) {
    let timer;
    return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })])
      .finally(() => clearTimeout(timer));
  }
  function validDate(s) {
    const m = typeof s === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1900 || y > 2199 || mo < 1 || mo > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  }
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const bumpMs = (t, prev) => Math.max(t, ((prev && prev.updatedMs) || 0) + 1);

  // Postgres timestamptz text → microseconds since epoch (keeps the 6 fractional digits).
  function tsMicros(s) {
    if (typeof s !== "string") return NaN;
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s.trim());
    if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? NaN : t * 1000; }
    let zone = m[4] || "Z";
    if (/^[+-]\d{2}$/.test(zone)) zone += ":00";
    else if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ":" + zone.slice(3);
    const base = Date.parse(`${m[1]}T${m[2]}${zone}`);
    if (Number.isNaN(base)) return NaN;
    return base * 1000 + Number(((m[3] || "") + "000000").slice(0, 6));
  }
  const tsLater = (a, b) => !b || tsMicros(a) > tsMicros(b);
  const tsShift = (s, ms) => { const us = tsMicros(s); return Number.isNaN(us) ? EPOCH : new Date(Math.floor(us / 1000) + ms).toISOString(); };

  function normMeta(m) {
    m = isObj(m) ? m : {};
    const str = v => (typeof v === "string" && v ? v : null);
    return {
      seeded: m.seeded === true,
      userId: str(m.userId),
      cursorTx: str(m.cursorTx),
      cursorSettings: str(m.cursorSettings),
      lastSyncAt: finite(m.lastSyncAt) ? m.lastSyncAt : null,
    };
  }

  /* ── validation of what the UI / a backup file hands us ─────────────── */
  function badTx(reason, message) { const e = fail("invalid", message); e.reason = reason; return e; }
  function txFields(d, createdDefault) {
    if (!isObj(d)) throw badTx("запись повреждена", M.txInvalid);
    if (!TYPES.includes(d.type)) throw badTx("неизвестный тип операции", M.txType);
    const amount = finite(d.amount) ? r2(d.amount) : NaN;
    if (!(amount > 0 && amount <= MAX_AMOUNT)) throw badTx("сумма должна быть больше нуля и меньше 10 млрд", M.txAmount);
    if (!validDate(d.date)) throw badTx("неверная дата", M.txDate);
    if (d.category != null && typeof d.category !== "string") throw badTx("неверная категория", M.txInvalid);
    if (d.note != null && typeof d.note !== "string") throw badTx("неверный комментарий", M.txInvalid);
    let category = (d.category || "").trim().slice(0, 32);
    if (!category) category = d.type === "income" ? "other_in" : d.type === "saving" ? "savings" : "other";
    const out = {
      type: d.type, amount, category,
      note: (d.note || "").slice(0, 80),
      date: d.date,
      createdAt: finite(d.createdAt) && d.createdAt >= 0 ? Math.round(d.createdAt) : createdDefault,
    };
    if (d.example === true) out.example = true;
    return out;
  }

  function settingsData(s) {
    const bad = () => fail("invalid", M.settingsInvalid);
    if (!isObj(s)) throw bad();
    let out;
    try { out = JSON.parse(JSON.stringify(s)); } catch (e) { throw bad(); }   // keeps unknown fields, JSON-safe
    const sb = s.startBalance == null ? 0 : s.startBalance;
    if (!finite(sb) || Math.abs(sb) > MAX_AMOUNT) throw bad();
    out.startBalance = r2(sb);
    if (s.goal == null) out.goal = null;
    else {
      const g = s.goal;
      if (!isObj(g) || typeof g.name !== "string" || !finite(g.target) || g.target <= 0 || g.target > MAX_AMOUNT) throw bad();
      const deadline = g.deadline == null ? "" : g.deadline;
      if (deadline !== "" && !validDate(deadline)) throw bad();
      const initial = g.initial == null ? 0 : g.initial;
      if (!finite(initial) || initial < 0 || initial > MAX_AMOUNT) throw bad();
      out.goal = { name: g.name.trim().slice(0, 60), target: r2(g.target), deadline, initial: r2(initial) };
    }
    out.limits = {};
    if (s.limits != null) {
      if (!isObj(s.limits)) throw bad();
      for (const [k, v] of Object.entries(s.limits)) {
        if (k && k.length <= 32 && finite(v) && v > 0 && v <= MAX_AMOUNT) out.limits[k] = r2(v);
      }
    }
    const ex = isObj(s.example) ? SETTINGS_KEYS.filter(k => s.example[k] === true) : [];
    if (ex.length) { out.example = {}; for (const k of ex) out.example[k] = true; }
    else delete out.example;
    const json = JSON.stringify(out);
    const bytes = typeof root.TextEncoder === "function" ? new root.TextEncoder().encode(json).length : json.length * 3;
    if (bytes > 30000) throw bad();
    return out;
  }
  const hasExampleFlags = d => !!(d && isObj(d.example) && Object.keys(d.example).length);
  function isDefaultField(k, v) {
    if (k === "startBalance") return !v;
    if (k === "goal") return v == null;
    return !v || (isObj(v) && !Object.keys(v).length);
  }
  // true when nothing in the settings is the user's own value: every field is an example or a default
  const onlyExampleOrDefault = d => SETTINGS_KEYS.every(k => (isObj(d.example) && d.example[k] === true) || isDefaultField(k, d[k]));
  function stripExample(d) {
    const out = clone(d);
    if (isObj(out.example)) for (const k of Object.keys(out.example)) if (k in SETTINGS_DEFAULTS) out[k] = clone(SETTINGS_DEFAULTS[k]);
    delete out.example;
    return out;
  }

  function toTx(r) {
    const t = { id: r.id, type: r.type, amount: r.amount, category: r.category || "", note: r.note || "", date: r.date, createdAt: r.createdAt || 0 };
    if (r.updatedMs > 0) t.updatedAt = r.updatedMs;
    if (r.example === true) t.example = true;
    return t;
  }
  const liveRecord = r => isObj(r) && !r.deleted && TYPES.includes(r.type) && finite(r.amount) && r.amount > 0 && typeof r.date === "string";

  /* ── Supabase rows ⇄ local records ─────────── */
  function recToRow(r, uid) {
    return {
      user_id: uid, id: r.id, type: r.type, amount: r.amount,
      category: r.category || "", note: r.note || "", date: r.date,
      created_ms: Math.max(0, Math.round(r.createdAt || 0)),
      example: r.example === true, deleted: !!r.deleted,
      client_updated_ms: Math.max(0, Math.round(r.updatedMs || 0)),
    };
  }
  function rowToRec(row) {
    if (!isObj(row) || typeof row.id !== "string" || !ID_RE.test(row.id)) return null;
    const rec = {
      id: row.id, type: row.type, amount: r2(Number(row.amount)),
      category: typeof row.category === "string" ? row.category : "",
      note: typeof row.note === "string" ? row.note : "",
      date: typeof row.date === "string" ? row.date.slice(0, 10) : "",
      createdAt: Number(row.created_ms) || 0,
      deleted: !!row.deleted,
      updatedMs: Number(row.client_updated_ms) || 0,
      dirty: false, localOnly: false,
    };
    if (row.example === true) rec.example = true;
    if (!rec.deleted && !(TYPES.includes(rec.type) && rec.amount > 0 && validDate(rec.date))) return null;
    return rec;
  }
  function settingsRowToRec(row) {
    let data;
    try { data = settingsData(isObj(row.data) ? row.data : {}); } catch (e) { data = clone(SETTINGS_DEFAULTS); }
    return { data, updatedMs: Number(row.client_updated_ms) || 0, dirty: false, localOnly: false };
  }

  /* ── error classification ──────────────────── */
  function authError(e) {
    if (e && e.budget) return e;
    const status = Number(e && e.status) || 0;
    const code = String((e && (e.code || e.error_code)) || "");
    const msg = String((e && (e.message || e.msg || e.error_description)) || "");
    const name = String((e && e.name) || "");
    if (name === "AuthRetryableFetchError" || (status === 0 && /fetch|network|load failed|timed? ?out|abort/i.test(msg)) || name === "TypeError") return fail("network", M.network, e);
    if (/invalid api key|no api key/i.test(msg)) return fail("invalid", M.badKey, e);
    if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return fail("auth", M.badCredentials, e);
    if (code === "email_not_confirmed" || /email not confirmed/i.test(msg)) return fail("auth", M.notConfirmed, e);
    if (code === "over_email_send_rate_limit" || /email rate limit|for security purposes/i.test(msg)) return fail("rate", M.rateEmail, e);
    if (status === 429 || /rate_limit/.test(code) || /rate limit|too many requests/i.test(msg)) return fail("rate", M.rate, e);
    if (code === "same_password" || /different from the old password/i.test(msg)) return fail("invalid", M.samePassword, e);
    if (code === "weak_password" || name === "AuthWeakPasswordError" || /password should (be at least|contain)|weak password|password is too|pwned/i.test(msg)) {
      const reasons = (e && e.reasons) || (e && e.weak_password && e.weak_password.reasons) || [];
      return fail("invalid", Array.isArray(reasons) && reasons.includes("pwned") ? M.pwnedPassword : M.weakPassword, e);
    }
    if (code === "user_already_exists" || code === "email_exists" || /already (been )?registered/i.test(msg)) return fail("invalid", M.userExists, e);
    if (code === "email_address_invalid" || code === "validation_failed" || /invalid.*email|email.*invalid|unable to validate email/i.test(msg)) return fail("invalid", M.badEmail, e);
    if (code === "signup_disabled" || code === "email_provider_disabled" || /signups? not allowed|signup.*disabled/i.test(msg)) return fail("invalid", M.signupDisabled, e);
    if (code === "user_banned") return fail("auth", M.banned, e);
    if (name === "AuthSessionMissingError" || /session_not_found|refresh_token|bad_jwt|no_authorization|session_expired/.test(code)
      || status === 401 || status === 403 || /jwt|session|refresh token/i.test(msg)) return fail("auth", M.sessionExpired, e);
    if (status >= 500) return fail("network", M.server, e);
    return fail("unknown", M.authFailed, e);
  }
  function syncError(x) {
    if (x && x.budget) return x;
    const res = x && x.res;
    if (res) {                                                    // PostgREST result { error, status }
      const e = res.error || {};
      const status = Number(res.status) || Number(e.status) || 0;
      const code = String(e.code || "");
      const msg = String(e.message || "");
      if (status === 0 || /failed to fetch|fetch failed|networkerror|network request failed|load failed|timed? ?out|abort/i.test(msg)) return fail("network", M.network, e);
      if (/invalid api key|no api key/i.test(msg)) return fail("invalid", M.badKey, e);
      if (status === 401 || /^PGRST30[0-3]$/.test(code) || /jwt/i.test(msg)) return fail("auth", M.sessionExpired, e);
      if (code === "42501" || status === 403) return fail("auth", M.noAccess, e);
      if (status === 429) return fail("rate", M.rate, e);
      if (code === "25006") return fail("read_only", M.serverReadOnly, e);
      if (/^53[1-4]00$/.test(code) || status === 507) return fail("quota", M.serverFull, e);
      if (code === "42P01" || code === "42703" || code === "42P10" || code === "42883" || /^PGRST20[0-9]$/.test(code) || status === 404) return fail("invalid", M.noSchema, e);
      if ([502, 503, 504, 520, 521, 522, 523, 524].includes(status)) return fail("network", M.server, e);
      if (/^(22|23)/.test(code) || status === 400 || status === 409) return fail("invalid", M.serverRejected, e);
      return fail("unknown", M.syncFailed, e);
    }
    const msg = String((x && x.message) || "");
    if (x && (x.name === "AuthRetryableFetchError" || /failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(msg))) return fail("network", M.network, x);
    if (x && typeof x.name === "string" && x.name.startsWith("Auth")) return authError(x);
    if (typeof console !== "undefined" && console.error) console.error("budget sync:", x);
    return fail("unknown", M.syncFailed, x);
  }
  function storageError(e) {
    if (e && e.budget) return e;
    const name = String((e && e.name) || "");
    if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || (e && e.code === 22) || /quota/i.test(String((e && e.message) || ""))) return fail("quota", M.quota, e);
    return fail("unknown", M.storage, e);
  }
  const connectionLost = e => !!e && /InvalidStateError|UnknownError|TransactionInactiveError/.test(String(e.name || "")) ;

  /* ── project config ────────────────────────── */
  function jwtRole(key) {
    try {
      const part = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const dec = typeof root.atob === "function" ? root.atob(part + "===".slice((part.length + 3) % 4)) : "";
      return (JSON.parse(dec) || {}).role || "";
    } catch (e) { return ""; }
  }
  function checkConfig(url, key) {
    url = String(url == null ? "" : url).trim();
    key = String(key == null ? "" : key).trim();
    if (!url) return { ok: false, message: M.cfgUrl };
    let u;
    try { u = new URL(url); } catch (e) { return { ok: false, message: M.cfgUrlBad }; }
    const local = u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if ((u.protocol !== "https:" && !local) || u.username || u.password || u.search || u.hash) return { ok: false, message: M.cfgUrlBad };
    let path = u.pathname.replace(/\/+$/, "");
    if (/^\/(rest|auth|realtime|storage)\/v1(\/.*)?$/.test(path)) path = "";   // pasted an API endpoint
    if (!key) return { ok: false, message: M.cfgKey };
    if (/^sb_secret_/.test(key)) return { ok: false, message: M.cfgKeySecret };
    const isJwt = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key);
    if (!isJwt && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return { ok: false, message: M.cfgKeyBad };
    if (isJwt && jwtRole(key) === "service_role") return { ok: false, message: M.cfgKeySecret };
    return { ok: true, url: u.origin + path, key };
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  function createBudgetStore(opts) {
    opts = opts || {};
    const env = opts.window || root;
    const now = typeof opts.now === "function" ? () => Number(opts.now()) : () => Date.now();
    const delays = Object.assign({ write: 1500, realtime: 800, interval: 60000, idbTimeout: 4000 }, opts.delays || {});
    const instanceId = Math.random().toString(36).slice(2);

    let S = { tx: {}, settings: null, meta: normMeta(null) };   // = last committed storage state
    let status = "loading";
    let notice = null;
    let listener = null;
    let booting = null;
    let destroyed = false;
    let emitQueued = false;
    const P = { backend: null, queue: [], busy: false };
    const SY = {
      cfg: null, source: "none", cfgUrl: "",
      client: null, authSub: null, channel: null, rtSubscribed: false, gen: 0,
      user: null, phase: "off", error: null, recovery: false,
      running: null, followUp: null, adoptChain: Promise.resolve(), authRetried: false,
      timers: {}, interval: null, unlisten: [], bc: null,
    };

    /* ── environment ─────────────────────────── */
    function lsObj() { try { return opts.localStorage || env.localStorage || null; } catch (e) { return null; } }
    function lsGet(k) { try { const s = lsObj(); return s ? s.getItem(k) : null; } catch (e) { return null; } }
    function lsSet(k, v) { try { const s = lsObj(); if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } }
    function lsDel(k) { try { const s = lsObj(); if (s) s.removeItem(k); } catch (e) { /* ignore */ } }
    function isOnline() {
      if (typeof opts.online === "function") return !!opts.online();
      const nav = env.navigator;
      return !(nav && nav.onLine === false);
    }
    function isVisible() { const d = env.document; return !d || d.visibilityState !== "hidden"; }
    function listen(target, type, fn) {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener(type, fn);
      SY.unlisten.push(() => { try { target.removeEventListener(type, fn); } catch (e) { /* ignore */ } });
    }
    function later(name, ms, fn) {
      clearTimeout(SY.timers[name]);
      SY.timers[name] = setTimeout(() => { SY.timers[name] = null; if (!destroyed) fn(); }, ms);
    }
    function mintId() {
      const bytes = new Uint8Array(12);
      const c = env.crypto || root.crypto;
      if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      let s = "";
      for (const b of bytes) s += ID_CHARS[b % ID_CHARS.length];
      return Math.max(0, Math.floor(now())).toString(36) + s;
    }
    function todayIso() { const d = new Date(now()); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
    function redirectUrl() {
      const loc = env.location;
      if (!loc || !/^https?:$/.test(loc.protocol || "")) return undefined;
      return String(loc.origin || "") + String(loc.pathname || "/");
    }

    /* ── snapshot ────────────────────────────── */
    function pendingCount() {
      let n = 0;
      for (const id in S.tx) { const r = S.tx[id]; if (r.dirty && !r.localOnly) n++; }
      if (S.settings && S.settings.dirty && !S.settings.localOnly) n++;
      return n;
    }
    function getFactory() {
      if (typeof opts.supabaseFactory === "function") return opts.supabaseFactory;
      const sb = env.supabase;
      return sb && typeof sb.createClient === "function" ? (u, k, o) => sb.createClient(u, k, o) : null;
    }
    function syncState() {
      return {
        available: !!getFactory(),
        configured: !!SY.cfg,
        url: SY.cfg ? SY.cfg.url : SY.cfgUrl || "",
        configSource: SY.source,
        user: SY.user ? { id: SY.user.id, email: SY.user.email } : null,
        phase: SY.user && SY.client ? SY.phase : "off",
        lastSyncAt: S.meta.lastSyncAt || null,
        pending: pendingCount(),
        error: SY.error,
        recovery: SY.recovery,
      };
    }
    function snapshot() {
      const tx = [];
      for (const id in S.tx) { const r = S.tx[id]; if (liveRecord(r)) tx.push(toTx(r)); }
      const snap = { status, tx, settings: S.settings && isObj(S.settings.data) ? clone(S.settings.data) : null, readOnly: false, sync: syncState() };
      if (notice) snap.notice = notice;
      return snap;
    }
    function scheduleEmit() {
      if (!listener || emitQueued || destroyed || status === "loading") return;
      emitQueued = true;
      defer(() => {
        emitQueued = false;
        if (destroyed || !listener) return;
        try { listener(snapshot()); } catch (e) { if (typeof console !== "undefined") console.error(e); }
      });
    }
    function setPhase(p) { if (SY.phase !== p) { SY.phase = p; scheduleEmit(); } }

    /* ── storage backends: run(keys, writeKeys, apply) → Promise<state> ── */
    function memoryBackend() {
      const disk = { tx: {}, settings: null, meta: null };
      return {
        kind: "memory",
        run(keys, writeKeys, apply) {
          return Promise.resolve().then(() => {
            const st = {};
            for (const k of keys) st[k] = clone(disk[k]);
            apply(st);
            for (const k of writeKeys) disk[k] = clone(st[k]);
            return st;
          });
        },
      };
    }
    function localBackend(ls) {
      return {
        kind: "local",
        run(keys, writeKeys, apply) {
          return Promise.resolve().then(() => {
            let all = {};
            try { all = JSON.parse(ls.getItem(LS_DATA) || "{}") || {}; } catch (e) { all = {}; }
            const st = {};
            for (const k of keys) st[k] = all[k] === undefined ? null : all[k];
            apply(st);
            if (writeKeys.length) {
              for (const k of writeKeys) all[k] = st[k];
              ls.setItem(LS_DATA, JSON.stringify(all));
            }
            return st;
          });
        },
      };
    }
    function idbBackend(idb) {
      let db = null;
      const b = {
        kind: "idb",
        open() {
          return new Promise((resolve, reject) => {
            let done = false, req;
            const timer = setTimeout(() => { if (!done) { done = true; reject(new Error("IndexedDB open timeout")); } }, delays.idbTimeout);
            const finish = (err, d) => { if (done) { if (d) try { d.close(); } catch (e) { /* ignore */ } return; } done = true; clearTimeout(timer); err ? reject(err) : resolve(d); };
            try { req = idb.open(DB_NAME); } catch (e) { finish(e); return; }   // creates version 1; opens a newer one as is
            req.onupgradeneeded = () => {
              try { const d = req.result; if (!d.objectStoreNames.contains(KV)) d.createObjectStore(KV); } catch (e) { /* surfaces as an open error */ }
            };
            req.onsuccess = () => {
              const d = req.result;
              d.onversionchange = () => { try { d.close(); } catch (e) { /* ignore */ } if (db === d) db = null; };
              d.onclose = () => { if (db === d) db = null; };
              db = d;
              finish(null, d);
            };
            req.onerror = () => finish(req.error || new Error("IndexedDB open failed"));
            req.onblocked = () => { /* wait: the other tab closes on versionchange */ };
          });
        },
        reopen() { try { if (db) db.close(); } catch (e) { /* ignore */ } db = null; return b.open(); },
        run(keys, writeKeys, apply) {
          if (!db) return b.open().then(() => b.run(keys, writeKeys, apply));
          return new Promise((resolve, reject) => {
            let t;
            try { t = db.transaction(KV, writeKeys.length ? "readwrite" : "readonly"); } catch (e) { reject(e); return; }
            const os = t.objectStore(KV);
            const st = {};
            let left = keys.length, failed = null;
            t.oncomplete = () => (failed ? reject(failed) : resolve(st));
            t.onabort = () => reject(failed || t.error || new Error("IndexedDB transaction aborted"));
            t.onerror = ev => { if (ev && typeof ev.preventDefault === "function") ev.preventDefault(); };
            for (const k of keys) {
              const r = os.get(k);
              r.onsuccess = () => {
                st[k] = r.result === undefined ? null : r.result;
                if (--left) return;
                try {
                  apply(st);
                  for (const wk of writeKeys) os.put(st[wk], wk);
                } catch (e) { failed = e; try { t.abort(); } catch (e2) { /* ignore */ } }
              };
            }
          });
        },
      };
      return b;
    }
    async function openStorage() {
      const mode = opts.storage || "auto";
      if (mode === "auto" || mode === "idb") {
        let idb = null;
        try { idb = opts.indexedDB || env.indexedDB || null; } catch (e) { idb = null; }
        if (idb) {
          try {
            const b = idbBackend(idb);
            await b.open();
            await b.run(ALL, [], noop);
            return { backend: b };
          } catch (e) { /* fall back */ }
        }
      }
      if (mode === "auto" || mode === "local") {
        const ls = lsObj();
        if (ls) {
          try {
            ls.setItem(LS_DATA + "-probe", "1");
            ls.removeItem(LS_DATA + "-probe");
            const b = localBackend(ls);
            await b.run(ALL, [], noop);
            return { backend: b, notice: mode === "auto" ? M.noticeLocal : null };
          } catch (e) { /* fall back */ }
        }
      }
      return { backend: memoryBackend(), notice: mode === "memory" ? null : M.noticeMemory };
    }

    /* ── commits: batched read-modify-write transactions ── */
    function commit(keys, fn, write) {
      return new Promise((resolve, reject) => {
        P.queue.push({ keys, fn, write: write !== false && !!fn, resolve, reject });
        pump();
      });
    }
    async function pump() {
      if (P.busy || !P.backend || !P.queue.length) return;
      P.busy = true;
      const batch = P.queue.splice(0);
      const keys = [...new Set(batch.flatMap(o => o.keys))];
      const writeKeys = [...new Set(batch.filter(o => o.write).flatMap(o => o.keys))];
      const apply = st => {
        if ("tx" in st && !isObj(st.tx)) st.tx = {};
        if ("settings" in st && !(isObj(st.settings) && isObj(st.settings.data))) st.settings = null;
        if ("meta" in st) st.meta = normMeta(st.meta);
        for (const op of batch) {
          op.ok = true; op.value = undefined;
          if (!op.fn) continue;
          try { op.value = op.fn(st); } catch (e) { op.ok = false; op.err = e; }
        }
      };
      let st = null, error = null;
      try { st = await P.backend.run(keys, writeKeys, apply); }
      catch (e) {
        if (connectionLost(e) && P.backend.reopen) {                 // iOS drops idle IndexedDB connections
          try { await P.backend.reopen(); st = await P.backend.run(keys, writeKeys, apply); } catch (e2) { error = e2; }
        } else error = e;
      }
      P.busy = false;
      if (error) {
        const ce = storageError(error);
        for (const op of batch) op.reject(ce);
      } else {
        for (const k of keys) S[k] = st[k];
        scheduleEmit();
        if (writeKeys.length) broadcast();
        for (const op of batch) (op.ok ? op.resolve(op.value) : op.reject(op.err));
      }
      if (P.queue.length) pump();
    }
    const refresh = () => commit(ALL, null, false);

    function broadcast() {
      if (!SY.bc) return;
      try { SY.bc.postMessage({ from: instanceId, t: "changed" }); } catch (e) { /* ignore */ }
    }
    function setupBroadcast() {
      const BC = env.BroadcastChannel;
      if (P.backend.kind === "memory" || typeof BC !== "function") return;
      try {
        SY.bc = new BC("budget-pwa");
        SY.bc.onmessage = ev => { const d = ev && ev.data; if (d && d.from !== instanceId && !destroyed) refresh().catch(noop); };
      } catch (e) { SY.bc = null; }
    }

    /* ── start-up ────────────────────────────── */
    function boot() {
      if (!booting) booting = start();
      return booting;
    }
    async function start() {
      let opened;
      try { opened = await openStorage(); } catch (e) { opened = { backend: memoryBackend(), notice: M.noticeMemory }; }
      if (destroyed) return;
      P.backend = opened.backend;
      notice = opened.notice || null;
      try {
        await refresh();
        if (P.backend.kind === "idb") await migrateLocalFallback();
        if (!S.meta.seeded) await seed();
      } catch (e) {
        if (P.backend.kind !== "memory") {
          P.backend = memoryBackend();
          notice = M.noticeMemory;
          try { await refresh(); await seed(); } catch (e2) { /* nothing more to try */ }
        }
      }
      if (destroyed) return;
      status = "ready";
      scheduleEmit();
      setupBroadcast();
      setupSync();
    }
    function seed() {
      let data = null;
      try {
        const bs = opts.seed || env.BudgetSeed;
        if (bs && typeof bs.make === "function") data = bs.make(todayIso());
      } catch (e) { data = null; }
      return commit(ALL, st => {
        if (st.meta.seeded) return;
        if (data && Array.isArray(data.tx)) {
          for (const t of data.tx) {
            if (!t || !ID_RE.test(String(t.id)) || st.tx[t.id]) continue;
            let f;
            try { f = txFields(t, 0); } catch (e) { continue; }
            st.tx[t.id] = Object.assign({ id: String(t.id) }, f, { deleted: false, updatedMs: 0, dirty: false, localOnly: true });
          }
        }
        if (data && isObj(data.settings) && !st.settings) {
          try { st.settings = { data: settingsData(data.settings), updatedMs: 0, dirty: false, localOnly: true }; } catch (e) { /* skip */ }
        }
        st.meta.seeded = true;
      });
    }
    async function migrateLocalFallback() {
      const raw = lsGet(LS_DATA);
      if (!raw) return;
      let old = null;
      try { old = JSON.parse(raw); } catch (e) { old = null; }
      if (isObj(old)) {
        await commit(ALL, st => {
          const otx = isObj(old.tx) ? old.tx : {};
          for (const id of Object.keys(otx)) {
            const r = otx[id], c = st.tx[id];
            if (!isObj(r) || !ID_RE.test(id)) continue;
            if (!c || (r.updatedMs || 0) > (c.updatedMs || 0)) st.tx[id] = r;
          }
          const os = old.settings;
          if (isObj(os) && isObj(os.data) && (!st.settings || (os.updatedMs || 0) > (st.settings.updatedMs || 0))) st.settings = os;
          const om = normMeta(old.meta);
          if (!st.meta.seeded && om.seeded) st.meta = om;
        });
      }
      lsDel(LS_DATA);
    }

    /* ── local writes ────────────────────────── */
    function afterWrite() {
      if (SY.user && SY.client) later("write", delays.write, kickSync);
    }
    async function writeTx(id, data) {
      if (id != null && id !== "" && !ID_RE.test(String(id))) throw fail("invalid", M.txId);
      const fields = txFields(data, Math.floor(now()));
      await boot();
      const txId = id == null || id === "" ? mintId() : String(id);
      const t = now();
      await commit(["tx"], st => {
        const prev = st.tx[txId];
        const localOnly = fields.example === true && (!prev || !!prev.localOnly);
        st.tx[txId] = Object.assign({ id: txId }, fields, { deleted: false, updatedMs: bumpMs(t, prev), dirty: !localOnly, localOnly });
      });
      afterWrite();
      return txId;
    }
    function deleteRec(st, id, t) {
      const prev = st.tx[id];
      if (!prev || prev.deleted) return false;
      if (prev.localOnly) delete st.tx[id];
      else st.tx[id] = Object.assign({}, prev, { deleted: true, updatedMs: bumpMs(t, prev), dirty: true });
      return true;
    }

    /* ── sync: config & client ───────────────── */
    function readConfig() {
      const fc = env.BUDGET_CONFIG;
      const fu = isObj(fc) && typeof fc.supabaseUrl === "string" ? fc.supabaseUrl.trim() : "";
      const fk = isObj(fc) && typeof fc.supabaseAnonKey === "string" ? fc.supabaseAnonKey.trim() : "";
      if (fu || fk) {
        const v = checkConfig(fu, fk);
        return v.ok ? { source: "file", cfg: { url: v.url, key: v.key } } : { source: "file", cfg: null, url: fu, error: "config.js: " + v.message };
      }
      const raw = lsGet(LS_CONFIG);
      if (raw) {
        try {
          const o = JSON.parse(raw);
          const v = checkConfig(o && o.url, o && o.anonKey);
          if (v.ok) return { source: "device", cfg: { url: v.url, key: v.key } };
        } catch (e) { /* ignore a broken value */ }
      }
      return { source: "none", cfg: null };
    }
    function setupSync() {
      const rc = readConfig();
      SY.source = rc.source;
      SY.cfg = rc.cfg;
      SY.cfgUrl = rc.url || "";
      SY.error = rc.error || null;
      addTriggers();
      if (SY.cfg) {
        if (getFactory()) startClient();
        else SY.error = M.noLibrary;
      }
      scheduleEmit();
    }
    function addTriggers() {
      if (SY.unlisten.length) return;
      listen(env, "online", () => { if (SY.user) kickSync(); });
      listen(env, "offline", () => { if (SY.user && SY.client) setPhase("offline"); });
      listen(env.document, "visibilitychange", () => {
        if (isVisible()) { if (SY.user) kickSync(); }
        else if (SY.timers.write) { clearTimeout(SY.timers.write); SY.timers.write = null; kickSync(); }   // flush before iOS suspends us
      });
      SY.interval = setInterval(() => { if (!destroyed && isVisible() && SY.user && !SY.running) kickSync(); }, delays.interval);
      if (SY.interval && typeof SY.interval.unref === "function") SY.interval.unref();
    }
    function clientOptions() {
      return { auth: { flowType: "implicit", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: AUTH_KEY } };
    }
    // an e-mail link that failed (expired, already used) comes back as #error=…&error_code=…
    function linkError() {
      const loc = env.location;
      const raw = loc ? String(loc.hash || "").replace(/^#/, "") + "&" + String(loc.search || "").replace(/^\?/, "") : "";
      if (!/(^|&)(error|error_code|error_description)=/.test(raw)) return null;
      const p = new URLSearchParams(raw);
      if (!p.get("error") && !p.get("error_code")) return null;
      return /expired|invalid/i.test((p.get("error_code") || "") + " " + (p.get("error_description") || "")) ? M.linkExpired : M.linkFailed;
    }
    async function startClient() {
      const factory = getFactory();
      if (!factory || !SY.cfg || destroyed) return;
      const gen = ++SY.gen;
      const fromLink = linkError();
      if (fromLink) SY.error = fromLink;
      let client;
      try { client = factory(SY.cfg.url, SY.cfg.key, clientOptions()); }
      catch (e) { SY.error = M.noLibrary; scheduleEmit(); return; }
      SY.client = client;
      try {
        const res = client.auth.onAuthStateChange((event, session) => {
          // never call supabase from inside this callback (auth lock): handle it on the next task
          setTimeout(() => { if (gen === SY.gen && !destroyed) onAuthEvent(event, session, gen); }, 0);
        });
        SY.authSub = res && res.data && res.data.subscription;
      } catch (e) { SY.authSub = null; }
      let session = null;
      try { const r = await client.auth.getSession(); session = r && r.data && r.data.session; } catch (e) { session = null; }
      if (gen !== SY.gen) return;
      if (session && session.user) await adoptUser(session.user, gen, true).catch(noop);
      else if (S.meta.userId && !SY.user && !SY.error) SY.error = M.sessionEnded;   // signed in last time, session gone now
      scheduleEmit();
    }
    function removeAuthStorage() {
      lsDel(AUTH_KEY);
      lsDel(AUTH_KEY + "-user");
      lsDel(AUTH_KEY + "-code-verifier");
    }
    async function stopClient(signOutLocal) {
      const client = SY.client;
      SY.gen++;
      unsubscribeRealtime(client);
      try { if (SY.authSub) SY.authSub.unsubscribe(); } catch (e) { /* ignore */ }
      SY.authSub = null;
      SY.client = null;
      SY.user = null;
      SY.recovery = false;
      clearTimeout(SY.timers.write); clearTimeout(SY.timers.realtime); clearTimeout(SY.timers.retry);
      if (!client) return;
      if (signOutLocal) {
        // scope "local": the default ("global") would end the session on every device
        try { await withTimeout(Promise.resolve(client.auth.signOut({ scope: "local" })), 8000); } catch (e) { /* removed below anyway */ }
        removeAuthStorage();
      }
      try { if (client.auth && typeof client.auth.stopAutoRefresh === "function") await client.auth.stopAutoRefresh(); } catch (e) { /* ignore */ }
      try { if (typeof client.removeAllChannels === "function") await client.removeAllChannels(); } catch (e) { /* ignore */ }
    }
    function requireClient() {
      if (!getFactory()) throw fail("unknown", M.noLibrary);
      if (!SY.cfg) throw fail("invalid", M.notConfigured);
      if (!SY.client) throw fail("unknown", M.noLibrary);
      return SY.client;
    }
    // Local data stays on the device but no longer belongs to an account: it is uploaded on the next sign-in.
    function anonymizeLocal() {
      return commit(ALL, st => {
        if (!st.meta.userId) return;
        for (const id in st.tx) if (!st.tx[id].localOnly) st.tx[id].dirty = true;
        if (st.settings && !st.settings.localOnly) st.settings.dirty = true;
        Object.assign(st.meta, { userId: null, cursorTx: null, cursorSettings: null, lastSyncAt: null });
      });
    }

    /* ── sync: accounts ──────────────────────── */
    function onAuthEvent(event, session, gen) {
      const user = session && session.user;
      if (event === "PASSWORD_RECOVERY") {
        SY.recovery = true;
        scheduleEmit();
        if (user) adoptUser(user, gen, true).catch(noop);
      } else if (event === "SIGNED_OUT") {
        if (SY.user) {                            // ended elsewhere (expired / revoked / other tab): keep the data
          SY.user = null;
          SY.recovery = false;
          SY.error = M.sessionEnded;
          unsubscribeRealtime(SY.client);
          setPhase("off");
          scheduleEmit();
        }
      } else if (user) {                          // INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED
        if (SY.user && SY.user.id === user.id && user.email) SY.user.email = String(user.email);
        adoptUser(user, gen, false).catch(noop);
      }
    }
    function adoptUser(user, gen, force) {
      const run = SY.adoptChain.then(() => doAdopt(user, gen, force));
      SY.adoptChain = run.catch(noop);
      return run;
    }
    async function doAdopt(user, gen, force) {
      if (gen !== SY.gen || destroyed || !user || !user.id) return;
      const uid = String(user.id);
      const changed = !SY.user || SY.user.id !== uid;
      SY.user = { id: uid, email: String(user.email || "") };
      if (changed) { SY.error = null; SY.authRetried = false; }
      if (S.meta.userId !== uid) {
        await commit(ALL, st => {
          if (st.meta.userId === uid) return;
          if (st.meta.userId) {                    // another account was used here last: wipe its data first
            st.tx = {};
            st.settings = null;
          } else {                                 // anonymous local use: keep everything and upload it
            for (const id in st.tx) if (!st.tx[id].localOnly) st.tx[id].dirty = true;
            if (st.settings && !st.settings.localOnly) st.settings.dirty = true;
          }
          Object.assign(st.meta, { userId: uid, cursorTx: null, cursorSettings: null, lastSyncAt: null });
        });
      }
      if (gen !== SY.gen || !SY.user || SY.user.id !== uid) return;
      if (changed || !SY.channel) subscribeRealtime(uid);
      if (SY.phase === "off") SY.phase = "idle";
      scheduleEmit();
      if (changed || force) kickSync();
    }

    /* ── sync: realtime ──────────────────────── */
    function subscribeRealtime(uid) {
      unsubscribeRealtime(SY.client);
      const client = SY.client;
      if (!client || typeof client.channel !== "function") return;
      try {
        const onChange = payload => onRealtime(payload, uid);
        const filter = "user_id=eq." + uid;
        const ch = client.channel("budget-" + uid)
          .on("postgres_changes", { event: "*", schema: "public", table: "transactions", filter }, onChange)
          .on("postgres_changes", { event: "*", schema: "public", table: "budget_settings", filter }, onChange);
        SY.rtSubscribed = false;
        ch.subscribe(st => {
          if (st !== "SUBSCRIBED" || SY.channel !== ch) return;
          if (SY.rtSubscribed) later("realtime", delays.realtime, kickSync);   // reconnected: catch up on missed events
          SY.rtSubscribed = true;
        });
        SY.channel = ch;
      } catch (e) { SY.channel = null; }
    }
    function unsubscribeRealtime(client) {
      const ch = SY.channel;
      SY.channel = null;
      SY.rtSubscribed = false;
      clearTimeout(SY.timers.realtime);
      if (!ch) return;
      try {
        const p = client && typeof client.removeChannel === "function" ? client.removeChannel(ch) : ch.unsubscribe && ch.unsubscribe();
        if (p && typeof p.catch === "function") p.catch(noop);
      } catch (e) { /* ignore */ }
    }
    function onRealtime(payload, uid) {
      if (destroyed || !SY.user || SY.user.id !== uid) return;
      const row = payload && payload.new;
      const table = payload && payload.table;
      if (isObj(row) && row.id !== undefined && table === "transactions") {
        const loc = S.tx[row.id];
        if (loc && loc.updatedMs === Number(row.client_updated_ms) && !!loc.deleted === !!row.deleted) return;   // our own write
      } else if (isObj(row) && table === "budget_settings") {
        const loc = S.settings;
        if (loc && !loc.localOnly && loc.updatedMs === Number(row.client_updated_ms)) return;
      }
      later("realtime", delays.realtime, kickSync);
    }

    /* ── sync: engine ────────────────────────── */
    function kickSync() {
      if (!SY.user || !SY.client || destroyed) return;
      requestSync().catch(noop);
    }
    // One sync at a time; calls made while one runs share a single follow-up run.
    function requestSync() {
      if (SY.running) {
        if (!SY.followUp) SY.followUp = SY.running.then(noop, noop).then(() => { SY.followUp = null; return requestSync(); });
        return SY.followUp;
      }
      const p = doSync();
      SY.running = p;
      const fin = () => { if (SY.running === p) SY.running = null; };
      p.then(fin, fin);
      return p;
    }
    function alive(uid, gen) { return !destroyed && SY.gen === gen && !!SY.user && SY.user.id === uid && S.meta.userId === uid; }
    function ensureAlive(uid, gen) { if (!alive(uid, gen)) throw STALE; }

    async function doSync() {
      const client = SY.client, gen = SY.gen;
      const uid = SY.user && SY.user.id;
      if (!client || !uid || destroyed) return;
      if (!isOnline()) { setPhase("offline"); throw fail("network", M.network); }
      setPhase("syncing");
      try {
        await SY.adoptChain;
        await boot();
        ensureAlive(uid, gen);
        const first = !S.meta.cursorTx;
        const remote = await pull(client, uid, gen);
        if (first && remote.hasData) await dropExamples(uid, remote.settingsRow);
        await push(client, uid, gen);
        const t = now();
        await commit(["meta"], st => { if (st.meta.userId === uid) st.meta.lastSyncAt = t; });
        if (!alive(uid, gen)) return;
        SY.error = null;
        SY.authRetried = false;
        setPhase("idle");
        if (remote.again) later("retry", 1000, kickSync);
      } catch (e) {
        if (e === STALE || !alive(uid, gen)) return;
        const ce = syncError(e);
        if (ce.code === "network") { SY.error = null; setPhase("offline"); }
        else if (ce.code === "auth") await onAuthFailure(ce, client, uid, gen);
        else { SY.error = ce.message; setPhase("error"); }
        scheduleEmit();
        throw ce;
      }
    }
    async function onAuthFailure(ce, client, uid, gen) {
      if (!SY.authRetried && client.auth && typeof client.auth.refreshSession === "function") {
        SY.authRetried = true;
        try {
          const r = await client.auth.refreshSession();
          if (r && !r.error && r.data && r.data.session && alive(uid, gen)) {
            SY.error = null;
            setPhase("idle");
            later("retry", 1000, kickSync);
            return;
          }
        } catch (e) { /* treat as a failed session */ }
      }
      if (!alive(uid, gen)) return;
      SY.user = null;                             // keep the local data: same user signing in again resumes
      SY.recovery = false;
      SY.error = ce.message;
      unsubscribeRealtime(client);
      setPhase("off");
      try {
        const r = await withTimeout(Promise.resolve(client.auth.signOut({ scope: "local" })), 8000);
        if (r && r.error) removeAuthStorage();
      } catch (e) { removeAuthStorage(); }
    }

    async function pull(client, uid, gen) {
      const out = { hasData: false, settingsRow: null, again: false };
      const cursor = S.meta.cursorTx;
      const lower = cursor ? tsShift(cursor, -OVERLAP_MS) : EPOCH;   // fixed lower bound for every page
      const seen = new Set();
      let offset = 0, maxTs = cursor;
      for (;;) {
        ensureAlive(uid, gen);
        const res = await client.from("transactions").select("*")
          .eq("user_id", uid)
          .gt("updated_at", lower)
          .order("updated_at", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (!res || res.error) throw { res: res || {} };
        const rows = Array.isArray(res.data) ? res.data : [];
        for (const r of rows) {
          if (seen.has(r.id)) out.again = true;   // a row moved while paging: an offset may have skipped one
          seen.add(r.id);
          if (!r.deleted && !r.example) out.hasData = true;
          if (tsLater(r.updated_at, maxTs)) maxTs = r.updated_at;
        }
        ensureAlive(uid, gen);
        if (rows.length) await commit(["tx", "meta"], st => mergeRows(st, uid, rows));
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
      const nextCursor = out.again ? cursor || EPOCH : maxTs || cursor || EPOCH;
      const sCursor = S.meta.cursorSettings;
      ensureAlive(uid, gen);
      const sres = await client.from("budget_settings").select("*")
        .eq("user_id", uid)
        .gt("updated_at", sCursor ? tsShift(sCursor, -OVERLAP_MS) : EPOCH);
      if (!sres || sres.error) throw { res: sres || {} };
      const srow = Array.isArray(sres.data) && sres.data.length ? sres.data[0] : null;
      if (srow) { out.hasData = true; out.settingsRow = srow; }
      ensureAlive(uid, gen);
      await commit(["settings", "meta"], st => {
        if (st.meta.userId !== uid) return;
        if (srow) mergeSettingsRow(st, srow);
        st.meta.cursorTx = nextCursor;
        st.meta.cursorSettings = srow && tsLater(srow.updated_at, sCursor) ? srow.updated_at : sCursor || EPOCH;
      });
      return out;
    }
    // remote wins unless the local copy is dirty and newer
    function mergeRows(st, uid, rows) {
      if (st.meta.userId !== uid) return;
      for (const row of rows) {
        const rec = rowToRec(row);
        if (!rec) continue;
        const cur = st.tx[rec.id];
        if (!cur) { if (!rec.deleted) st.tx[rec.id] = rec; continue; }
        if (!cur.localOnly && cur.dirty && cur.updatedMs > rec.updatedMs) continue;
        if (!cur.localOnly && !cur.dirty && cur.updatedMs === rec.updatedMs && !!cur.deleted === rec.deleted) continue;
        st.tx[rec.id] = rec;
      }
    }
    function mergeSettingsRow(st, row) {
      const remote = settingsRowToRec(row);
      const cur = st.settings;
      if (cur && !cur.localOnly && cur.dirty && cur.updatedMs > remote.updatedMs) return;
      if (cur && !cur.localOnly && !cur.dirty && cur.updatedMs === remote.updatedMs) return;
      st.settings = remote;
    }
    // Signed into an account that already has data: the example budget goes away.
    function dropExamples(uid, settingsRow) {
      const t = now();
      return commit(ALL, st => {
        if (st.meta.userId !== uid) return;
        for (const id of Object.keys(st.tx)) if (st.tx[id].localOnly) delete st.tx[id];
        const s = st.settings;
        if (s && (s.localOnly || hasExampleFlags(s.data))) {
          if (settingsRow) st.settings = settingsRowToRec(settingsRow);
          else if (s.localOnly) st.settings = null;
          else st.settings = { data: stripExample(s.data), updatedMs: bumpMs(t, s), dirty: true, localOnly: false };
        }
      });
    }
    async function push(client, uid, gen) {
      const dirty = Object.values(S.tx).filter(r => r.dirty && !r.localOnly);
      for (let i = 0; i < dirty.length; i += CHUNK) {
        ensureAlive(uid, gen);
        const chunk = dirty.slice(i, i + CHUNK);
        const sent = chunk.map(r => [r.id, r.updatedMs]);
        const res = await client.from("transactions").upsert(chunk.map(r => recToRow(r, uid)), { onConflict: "user_id,id" });
        if (!res || res.error) throw { res: res || {} };
        // a record edited while its push was in flight has a newer updatedMs and stays dirty
        await commit(["tx", "meta"], st => {
          if (st.meta.userId !== uid) return;
          for (const [id, ms] of sent) { const r = st.tx[id]; if (r && r.dirty && r.updatedMs === ms) r.dirty = false; }
        });
      }
      const s = S.settings;
      if (s && s.dirty && !s.localOnly) {
        ensureAlive(uid, gen);
        const ms = s.updatedMs;
        const res = await client.from("budget_settings").upsert(
          { user_id: uid, data: s.data, client_updated_ms: Math.max(0, Math.round(ms || 0)) }, { onConflict: "user_id" });
        if (!res || res.error) throw { res: res || {} };
        await commit(["settings", "meta"], st => {
          if (st.meta.userId !== uid) return;
          const c = st.settings;
          if (c && c.dirty && c.updatedMs === ms) c.dirty = false;
        });
      }
    }

    /* ── backup ──────────────────────────────── */
    function parseBackup(data) {
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { throw fail("invalid", M.notBackup); } }
      if (!isObj(data) || data.app !== "budget" || !Array.isArray(data.tx)) throw fail("invalid", M.notBackup);
      if (data.version !== 1) throw fail("invalid", finite(data.version) && data.version > 1 ? M.backupVersion : M.notBackup);
      const t = now();
      const items = data.tx.map((raw, i) => {
        try {
          if (!isObj(raw)) throw badTx("запись повреждена", M.txInvalid);
          if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) throw badTx("неверный идентификатор", M.txId);
          const fields = txFields(raw, 0);
          const ts = finite(raw.updatedAt) && raw.updatedAt > 0 ? Math.min(Math.round(raw.updatedAt), t) : null;
          return { id: raw.id, fields, ts };
        } catch (e) {
          throw fail("invalid", `Ошибка в файле: операция №${i + 1}: ${e.reason || "запись повреждена"}.`);
        }
      });
      let settings = null;
      if (data.settings != null) {
        try { settings = settingsData(data.settings); } catch (e) { throw fail("invalid", M.backupSettings); }
      }
      const sts = finite(data.settingsUpdatedAt) && data.settingsUpdatedAt > 0 ? Math.min(Math.round(data.settingsUpdatedAt), t) : null;
      return { items, settings, settingsTs: sts };
    }
    function importInto(st, parsed) {
      let added = 0, updated = 0, skipped = 0, settingsUpdated = false;
      const byId = new Map();
      for (const it of parsed.items) {
        const p = byId.get(it.id);
        if (p) { skipped++; if ((it.ts || 0) > (p.ts || 0)) byId.set(it.id, it); }
        else byId.set(it.id, it);
      }
      for (const it of byId.values()) {
        const cur = st.tx[it.id];
        // records without a timestamp count as older than anything already here
        if (cur && (it.ts == null || it.ts <= (cur.updatedMs || 0))) { skipped++; continue; }
        st.tx[it.id] = Object.assign({ id: it.id }, it.fields, { deleted: false, updatedMs: it.ts || 0, dirty: true, localOnly: false });
        if (!cur || cur.deleted) added++; else updated++;
      }
      if (parsed.settings) {
        const cur = st.settings;
        if (!cur || cur.localOnly || (parsed.settingsTs != null && parsed.settingsTs > (cur.updatedMs || 0))) {
          st.settings = { data: parsed.settings, updatedMs: Math.max(parsed.settingsTs || 0, cur && !cur.localOnly ? cur.updatedMs + 1 : 0), dirty: true, localOnly: false };
          settingsUpdated = true;
        }
      }
      return { added, updated, skipped, settingsUpdated };
    }
    const backup = {
      export() {
        const tx = [];
        for (const id in S.tx) { const r = S.tx[id]; if (liveRecord(r)) tx.push(toTx(r)); }
        tx.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1)));
        const out = { app: "budget", version: 1, exportedAt: new Date(now()).toISOString(), settings: S.settings ? clone(S.settings.data) : null, tx };
        if (S.settings && S.settings.updatedMs > 0) out.settingsUpdatedAt = S.settings.updatedMs;
        return out;
      },
      async import(data) {
        const parsed = parseBackup(data);
        await boot();
        const res = await commit(["tx", "settings"], st => importInto(st, parsed));
        afterWrite();
        return res;
      },
    };

    /* ── sync API ────────────────────────────── */
    const sync = {
      async configure(cfg) {
        await boot();
        if (SY.source === "file") throw fail("invalid", M.cfgFile);
        if (cfg == null) {
          lsDel(LS_CONFIG);
          const had = !!SY.cfg;
          SY.cfg = null; SY.source = "none"; SY.cfgUrl = ""; SY.error = null;
          if (had) { await stopClient(true); await anonymizeLocal(); }
          SY.phase = "off";
          scheduleEmit();
          return;
        }
        const v = checkConfig(cfg.url, cfg.anonKey);
        if (!v.ok) throw fail("invalid", v.message);
        if (SY.cfg && SY.cfg.url === v.url && SY.cfg.key === v.key) {
          if (!SY.client && getFactory()) await startClient();
          return;
        }
        lsSet(LS_CONFIG, JSON.stringify({ url: v.url, anonKey: v.key }));   // no storage (private mode): this session only
        const projectChanged = !!SY.cfg && SY.cfg.url !== v.url;
        if (SY.client) await stopClient(projectChanged);
        if (projectChanged) await anonymizeLocal();
        SY.cfg = { url: v.url, key: v.key }; SY.source = "device"; SY.cfgUrl = v.url;
        SY.error = getFactory() ? null : M.noLibrary;
        SY.phase = "off";
        if (getFactory()) await startClient();
        scheduleEmit();
      },
      async signUp(email, password) {
        await boot();
        const client = requireClient();
        email = String(email || "").trim();
        if (!EMAIL_RE.test(email)) throw fail("invalid", M.badEmail);
        if (String(password || "").length < 6) throw fail("invalid", M.shortPassword);
        if (!isOnline()) throw fail("network", M.network);
        let res;
        try { res = await client.auth.signUp({ email, password: String(password), options: { emailRedirectTo: redirectUrl() } }); }
        catch (e) { throw authError(e); }
        if (res && res.error) throw authError(res.error);
        const session = res && res.data && res.data.session;
        if (session && session.user) { await adoptUser(session.user, SY.gen, true); return { needsConfirm: false }; }
        return { needsConfirm: true };
      },
      async signIn(email, password) {
        await boot();
        const client = requireClient();
        email = String(email || "").trim();
        if (!EMAIL_RE.test(email)) throw fail("invalid", M.badEmail);
        if (!password) throw fail("invalid", M.noPassword);
        if (!isOnline()) throw fail("network", M.network);
        let res;
        try { res = await client.auth.signInWithPassword({ email, password: String(password) }); }
        catch (e) { throw authError(e); }
        if (res && res.error) throw authError(res.error);
        const user = res && res.data && (res.data.user || (res.data.session && res.data.session.user));
        if (!user) throw fail("unknown", M.authFailed);
        SY.error = null;
        await adoptUser(user, SY.gen, true);
      },
      async signOut() {
        await boot();
        if (SY.client && SY.user && isOnline() && pendingCount() > 0) {
          try { await withTimeout(requestSync(), 15000); } catch (e) { /* sign out anyway */ }
        }
        // the old client is detached first, so none of its late events or syncs can bring the data back
        await stopClient(true);
        await commit(ALL, st => {
          st.tx = {};
          st.settings = null;
          st.meta = Object.assign(normMeta(null), { seeded: true });
        });
        SY.error = null;
        SY.phase = "off";
        if (SY.cfg && getFactory()) await startClient();
        scheduleEmit();
      },
      async resetPassword(email) {
        await boot();
        const client = requireClient();
        email = String(email || "").trim();
        if (!EMAIL_RE.test(email)) throw fail("invalid", M.badEmail);
        if (!isOnline()) throw fail("network", M.network);
        let res;
        try { res = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() }); }
        catch (e) { throw authError(e); }
        if (res && res.error) throw authError(res.error);
      },
      async updatePassword(password) {
        await boot();
        const client = requireClient();
        if (!SY.user) throw fail("auth", SY.recovery ? M.recoveryExpired : M.needSignIn);
        if (String(password || "").length < 6) throw fail("invalid", M.shortPassword);
        if (!isOnline()) throw fail("network", M.network);
        let res;
        try { res = await client.auth.updateUser({ password: String(password) }); }
        catch (e) { throw authError(e); }
        if (res && res.error) throw authError(res.error);
        SY.recovery = false;
        scheduleEmit();
      },
      async syncNow() {
        await boot();
        requireClient();
        if (!SY.user) throw fail("auth", M.needSignIn);
        await requestSync();
      },
    };

    /* ── Store ───────────────────────────────── */
    return {
      init(onChange) {
        listener = typeof onChange === "function" ? onChange : null;
        boot();
        if (status === "ready") scheduleEmit();
      },
      saveTx(id, data) {
        return writeTx(id, data);
      },
      async deleteTx(id) {
        if (!ID_RE.test(String(id))) throw fail("invalid", M.txId);
        await boot();
        const t = now();
        const changed = await commit(["tx"], st => deleteRec(st, String(id), t));
        if (changed) afterWrite();
      },
      async restoreTx(id, data) {
        if (!ID_RE.test(String(id))) throw fail("invalid", M.txId);
        await writeTx(String(id), data);
      },
      async saveSettings(next) {
        const data = settingsData(next);
        await boot();
        const t = now();
        await commit(["settings"], st => {
          const prev = st.settings;
          // the example settings stay device-only until the user enters a value of their own
          const keepLocal = !!(prev && prev.localOnly) && onlyExampleOrDefault(data);
          st.settings = { data, updatedMs: bumpMs(t, prev), dirty: !keepLocal, localOnly: keepLocal };
        });
        afterWrite();
      },
      async deleteMany(ids, onProgress) {
        const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(id => ID_RE.test(id));
        await boot();
        const total = list.length;
        let done = 0, changed = false;
        for (let i = 0; i < total; i += 200) {
          const part = list.slice(i, i + 200);
          const t = now();
          const n = await commit(["tx"], st => part.reduce((k, id) => k + (deleteRec(st, id, t) ? 1 : 0), 0));
          if (n) changed = true;
          done += part.length;
          if (typeof onProgress === "function") { try { onProgress(done, total); } catch (e) { /* UI callback */ } }
        }
        if (changed) afterWrite();
      },
      sync,
      backup,
      // not in the Store contract: stops timers, listeners and the Supabase client (tests, hot reload)
      async destroy() {
        destroyed = true;
        listener = null;
        for (const k of Object.keys(SY.timers)) clearTimeout(SY.timers[k]);
        clearInterval(SY.interval);
        for (const off of SY.unlisten.splice(0)) off();
        try { if (SY.bc) SY.bc.close(); } catch (e) { /* ignore */ }
        await stopClient(false);
      },
    };
  }

  root.createBudgetStore = createBudgetStore;
})(typeof window !== "undefined" ? window : globalThis);
