/* Test double for window.BudgetApp as src/learn.js sees it (not shipped).
   icon(): full lucide 0.460.0 UMD (window.lucide) — every requested name is recorded in __learn.icons;
   esc()/toast() copied from src/app.js; actions are spies recorded in __learn.calls.
   Query flags: ?nostorage=1 → every localStorage access throws (private mode / blocked site data);
                ?noactions=1 → BudgetApp.actions is missing (the «try it» block must disappear). */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const params = new URLSearchParams(location.search);

  if (params.get("nostorage")) {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  }

  const used = new Set();
  const lookup = name => (window.lucide && window.lucide.icons[name] ? window.lucide.icons[name][2] : null);
  function icon(name) {
    used.add(name);
    const node = lookup(name);
    if (!node) return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"></svg>';
    const kids = node.map(([tag, attrs]) =>
      `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
    return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${kids}</svg>`;
  }
  function hydrateIcons(root = document) {
    root.querySelectorAll("[data-icon]").forEach(el => {
      const name = el.getAttribute("data-icon");
      el.removeAttribute("data-icon");
      el.insertAdjacentHTML("afterbegin", icon(name));
    });
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const calls = [], toasts = [];
  let toastTimer = null;
  function toast(msg) {
    toasts.push(msg);
    const el = $("#toast");
    clearTimeout(toastTimer);
    el.innerHTML = `<span>${esc(msg)}</span>`;
    el.hidden = false;
    const live = $("#live"); live.textContent = "";
    setTimeout(() => { live.textContent = msg; }, 60);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  const spy = name => (...args) => { calls.push({ name, args: JSON.parse(JSON.stringify(args)) }); };

  window.__learn = { icons: used, missing: () => [...used].filter(n => !lookup(n)).sort(), calls, toasts };
  window.BudgetApp = {
    icon, esc, toast, hydrateIcons,
    actions: params.get("noactions") ? undefined : {
      setView: spy("setView"), openTx: spy("openTx"), openLimits: spy("openLimits"),
      openGoal: spy("openGoal"), openCategories: spy("openCategories"), openStart: spy("openStart"),
    },
  };
  window.__mount = () => {
    hydrateIcons();
    window.BudgetLearn.mount($("#viewLearn"), window.BudgetApp);
    window.__mounted = true;
  };
})();
