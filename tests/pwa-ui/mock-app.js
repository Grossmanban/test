/* Test harness for src/pwa.js (not shipped).
   - always: a controllable mock Store (sync + backup) exposed as window.__mock and window.createBudgetStore
   - mock mode (default): a mock window.BudgetApp with helpers copied from src/app.js
   - real mode (window.__REAL_APP__ = true): src/app.js runs and builds BudgetApp on top of the mock store
   Icons: window.lucide (full lucide 0.460.0 UMD) behind window.BUDGET_ICONS; every requested name is
   recorded in __mock.icons so the runner can list what pwa.js needs from the subset. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const params = new URLSearchParams(location.search);

  /* ── icons ─────────────────────────────────── */
  // real mode: wrap the shipped subset (src/icons.js) so names missing from it show up in __mock.missingIcons()
  const usedIcons = new Set();
  const subset = window.BUDGET_ICONS || null;
  const lookup = name => (subset ? subset[name] : window.lucide && window.lucide.icons[name] ? window.lucide.icons[name][2] : undefined);
  window.BUDGET_ICONS = new Proxy({}, {
    get(_, name) {
      if (typeof name !== "string") return undefined;
      usedIcons.add(name);
      return lookup(name);
    },
  });

  /* ── mock sync / backup store ──────────────── */
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const err = (code, message) => Object.assign(new Error(message), { code });
  const M = {
    calls: [],
    icons: usedIcons,
    missingIcons: () => [...usedIcons].filter(n => !lookup(n)).sort(),
    delay: 150,
    fail: {},               // method name → { code, message } to reject with
    signUpConfirm: true,    // signUp resolves { needsConfirm }
    importResult: { added: 12, updated: 3, skipped: 41, settingsUpdated: true },
    status: "ready",
    sync: {
      available: true, configured: false, url: "", configSource: "none", user: null,
      phase: "off", lastSyncAt: null, pending: 0, error: null, recovery: false, link: null, pendingLink: null,
    },
    tx: [
      { id: "a1", type: "expense", amount: 1250, category: "groceries", note: "Продукты", date: "2026-10-07", createdAt: 1 },
      { id: "a2", type: "income", amount: 98000, category: "salary", note: "Зарплата", date: "2026-10-05", createdAt: 2 },
    ],
    settings: { startBalance: 40000, goal: null, limits: {} },
    listener: null,
    setSync(patch) { Object.assign(M.sync, patch); M.emit(); },
    emit() {
      const snap = { status: M.status, tx: M.tx.slice(), settings: M.settings, readOnly: false, sync: { ...M.sync } };
      setTimeout(() => M.listener && M.listener(snap), 0);
    },
  };
  async function call(name, args, fn) {
    M.calls.push({ name, args });
    await wait(M.delay);
    if (M.fail[name]) { const f = M.fail[name]; throw err(f.code, f.message); }
    return fn ? fn() : undefined;
  }
  const sync = {
    configure: cfg => call("configure", [cfg], () => {
      if (cfg == null) { Object.assign(M.sync, { configured: false, url: "", configSource: "none", phase: "off", error: null }); }
      else {
        if (!/^https:\/\//.test(cfg.url || "")) throw err("invalid", "Адрес проекта должен начинаться с https://, например https://abcd.supabase.co");
        if (!cfg.anonKey) throw err("invalid", "Укажите ключ проекта: anon или publishable key.");
        Object.assign(M.sync, { configured: true, url: cfg.url, configSource: "device", phase: "off", error: null });
      }
      M.emit();
    }),
    signUp: (email, password) => call("signUp", [email, password], () => {
      if (M.signUpConfirm) return { needsConfirm: true };
      Object.assign(M.sync, { user: { id: "u1", email }, phase: "idle", lastSyncAt: Date.now() });
      M.emit();
      return { needsConfirm: false };
    }),
    signIn: (email, password) => call("signIn", [email, password], () => {
      if (!/@/.test(email)) throw err("invalid", "Проверьте адрес почты.");
      Object.assign(M.sync, { user: { id: "u1", email }, phase: "syncing", error: null });
      M.emit();
      setTimeout(() => { Object.assign(M.sync, { phase: "idle", lastSyncAt: Date.now() }); M.emit(); }, 400);
    }),
    signOut: () => call("signOut", [], () => {
      Object.assign(M.sync, { user: null, phase: "off", pending: 0, lastSyncAt: null, error: null });
      M.tx = [];
      M.emit();
    }),
    resetPassword: email => call("resetPassword", [email], () => {
      if (!/@/.test(email)) throw err("invalid", "Проверьте адрес почты.");
    }),
    updatePassword: password => call("updatePassword", [password], () => {
      if (String(password).length < 6) throw err("invalid", "Пароль должен быть не короче 6 символов.");
      M.sync.recovery = false;
      M.sync.link = null;
      M.emit();
    }),
    cancelRecovery: () => call("cancelRecovery", [], () => {
      M.sync.recovery = false;
      if (M.sync.link && M.sync.link.type === "recovery") M.sync.link = null;
      M.emit();
    }),
    syncNow: () => call("syncNow", [], async () => {
      M.setSync({ phase: "syncing" });
      await wait(300);
      M.setSync({ phase: "idle", pending: 0, lastSyncAt: Date.now(), error: null });
    }),
  };
  const backup = {
    export() {
      M.calls.push({ name: "export", args: [] });
      return { app: "budget", version: 1, exportedAt: new Date().toISOString(), settings: M.settings, tx: M.tx.slice() };
    },
    import: data => call("import", [data], () => {
      if (!data || data.app !== "budget") throw err("invalid", "Файл не похож на резервную копию бюджета.");
      return { ...M.importResult };
    }),
  };
  const store = {
    init(onChange) { M.listener = onChange; M.emit(); },
    saveTx: async () => "x", deleteTx: async () => {}, restoreTx: async () => {},
    saveSettings: async () => {}, deleteMany: async () => {},
    sync, backup,
  };
  window.__mock = M;
  window.createBudgetStore = () => store;

  // initial state from the query string: ?state=signedin etc. (the runner mostly drives __mock directly)
  const preset = params.get("state");
  if (preset === "signedin") Object.assign(M.sync, { configured: true, url: "https://abcd.supabase.co", configSource: "device", user: { id: "u1", email: "anna@example.com" }, phase: "idle", lastSyncAt: Date.now() - 120e3 });

  /* ── fake service worker (?sw=mock): a waiting worker is ready right away ── */
  if (params.get("sw") === "mock") {
    const listeners = {};
    const posted = (window.__swPosted = []);
    const waiting = { state: "installed", postMessage(m) { posted.push(m); if (m && m.type === "SKIP_WAITING") setTimeout(() => (listeners.controllerchange || []).forEach(f => f()), 50); } };
    const reg = { waiting, installing: null, addEventListener() {}, update: async () => {} };
    const controller = { postMessage(m, ports) { if (m && m.type === "GET_VERSION" && ports && ports[0]) ports[0].postMessage({ version: "3f2a1b9c0d1e" }); } };
    const swc = {
      controller,
      register: async (url, opts) => { window.__swRegistered = { url, opts }; return reg; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    };
    Object.defineProperty(navigator, "serviceWorker", { value: swc, configurable: true });
    window.__reloads = Number(sessionStorage.getItem("reloads") || 0);
    window.addEventListener("beforeunload", () => sessionStorage.setItem("reloads", String(window.__reloads + 1)));
  }

  if (window.__REAL_APP__) return;

  /* ── mock BudgetApp (helpers copied from src/app.js) ── */
  function icon(name) {
    const node = window.BUDGET_ICONS && window.BUDGET_ICONS[name];
    if (!node) return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"></svg>';
    const kids = node.map(([tag, attrs]) =>
      `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
    return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${kids}</svg>`;
  }
  function hydrateIcons(root = document) {
    $$("[data-icon]", root).forEach(el => {
      const name = el.getAttribute("data-icon");
      el.removeAttribute("data-icon");
      el.insertAdjacentHTML("afterbegin", icon(name));
    });
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const NF = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const money = (v, opts = {}) => `${v < 0 ? "−" : opts.sign && v > 0 ? "+" : ""}${NF.format(Math.abs(opts.round ? Math.round(v) : v))} ₽`;
  let toastTimer = null;
  const toasts = (M.toasts = []);
  function toast(msg, action) {
    toasts.push({ msg, label: action && action.label });
    const el = $("#toast");
    clearTimeout(toastTimer);
    el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" id="toastAct">${esc(action.label)}</button>` : ""}`;
    el.hidden = false;
    const live = $("#live"); live.textContent = "";
    setTimeout(() => { live.textContent = action ? `${msg}. Кнопка «${action.label}» внизу экрана` : msg; }, 60);
    if (action) $("#toastAct").onclick = () => { el.hidden = true; action.run(); };
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3200);
  }
  const KB_SEL = 'input:not([type="radio"]):not([type="checkbox"]):not([type="date"]):not([type="file"])';
  function enhanceDialog(dlg) {
    if (dlg.dataset.enhanced) return;
    dlg.dataset.enhanced = "1";
    let downOnBackdrop = false;
    dlg.addEventListener("pointerdown", e => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener("click", e => {
      if (e.target.closest("[data-close]")) dlg.close();
      else if (e.target === dlg && downOnBackdrop) dlg.close();
    });
    dlg.addEventListener("touchmove", e => { if (e.target === dlg) e.preventDefault(); }, { passive: false });
    dlg.addEventListener("focusin", e => { if (e.target.matches(KB_SEL)) dlg.classList.add("kb-open"); });
    dlg.addEventListener("focusout", () => setTimeout(() => {
      const a = document.activeElement;
      if (!a || !dlg.contains(a) || !a.matches(KB_SEL)) dlg.classList.remove("kb-open");
    }, 150));
    dlg.addEventListener("close", () => dlg.classList.remove("kb-open"));
  }
  const snapListeners = new Set();
  let lastSnap = null;
  window.BudgetApp = {
    store, icon, hydrateIcons, esc, money, toast, enhanceDialog,
    onSnapshot(cb) { snapListeners.add(cb); if (lastSnap) cb(lastSnap); return () => snapListeners.delete(cb); },
  };
  document.addEventListener("DOMContentLoaded", () => hydrateIcons());
  hydrateIcons();
  store.init(snap => {
    lastSnap = snap;
    for (const cb of snapListeners) { try { cb(snap); } catch (e) { console.error(e); } }
  });
})();
