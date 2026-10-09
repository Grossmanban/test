(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const FEATURES = window.BUDGET_FEATURES || {};

  /* ── Icons ─────────────────────────────────── */
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

  /* ── Categories ────────────────────────────── */
  // built-in categories; users add their own (settings.categories) with an icon from PICKER_ICONS
  const CATS = {
    expense: [
      { id: "housing", name: "Жильё", icon: "House" },
      { id: "utilities", name: "Счета и арнона", icon: "Zap" },
      { id: "groceries", name: "Продукты", icon: "ShoppingCart" },
      { id: "transport", name: "Транспорт", icon: "Bus" },
      { id: "car", name: "Машина и бензин", icon: "Car" },
      { id: "cafe", name: "Кафе и рестораны", icon: "Coffee" },
      { id: "health", name: "Здоровье", icon: "HeartPulse" },
      { id: "kids", name: "Дети", icon: "Baby" },
      { id: "pets", name: "Питомцы", icon: "PawPrint" },
      { id: "fun", name: "Развлечения", icon: "Popcorn" },
      { id: "clothes", name: "Одежда и обувь", icon: "Shirt" },
      { id: "beauty", name: "Красота и уход", icon: "Sparkles" },
      { id: "sport", name: "Спорт", icon: "Dumbbell" },
      { id: "telecom", name: "Связь и подписки", icon: "Smartphone" },
      { id: "education", name: "Образование", icon: "GraduationCap" },
      { id: "travel", name: "Путешествия", icon: "Plane" },
      { id: "gifts", name: "Подарки", icon: "Gift" },
      { id: "charity", name: "Пожертвования", icon: "HandHeart" },
      { id: "other", name: "Прочее", icon: "Ellipsis" },
    ],
    income: [
      { id: "salary", name: "Зарплата", icon: "Briefcase" },
      { id: "freelance", name: "Подработка", icon: "Laptop" },
      { id: "social", name: "Социальные выплаты", icon: "HandCoins" },
      { id: "refund", name: "Возвраты и налоги", icon: "ReceiptText" },
      { id: "cashback", name: "Кешбэк и проценты", icon: "Percent" },
      { id: "sales", name: "Продажа вещей", icon: "Tag" },
      { id: "gift_in", name: "Подарки", icon: "Gift" },
      { id: "other_in", name: "Прочее", icon: "Ellipsis" },
    ],
    saving: [{ id: "savings", name: "Копилка", icon: "PiggyBank" }],
  };
  const CAT = {};
  for (const [type, list] of Object.entries(CATS)) for (const c of list) CAT[c.id] = { ...c, type };
  // icons offered when a user creates a category
  const PICKER_ICONS = ["ShoppingBag", "Store", "Utensils", "Pizza", "Coffee", "Beer", "Wine", "Cake", "Apple", "Milk",
    "House", "Building2", "Sofa", "Lamp", "Hammer", "Wrench", "Plug", "Droplets", "Flame", "Zap",
    "Car", "Fuel", "Bus", "Train", "Bike", "CarTaxiFront", "Plane", "Luggage", "Hotel", "Ship",
    "HeartPulse", "Pill", "Stethoscope", "Syringe", "Glasses", "Baby", "School", "GraduationCap", "BookOpen", "Puzzle",
    "PawPrint", "Dog", "Cat", "Dumbbell", "Trophy", "Music", "Gamepad2", "Film", "Ticket", "Camera",
    "Palette", "Scissors", "Sparkles", "Shirt", "Watch", "Gem", "Gift", "HandHeart", "Church", "Flower2",
    "Smartphone", "Laptop", "Tv", "Wifi", "Headphones", "CreditCard", "Landmark", "Coins", "Banknote", "HandCoins",
    "Briefcase", "Calculator", "ReceiptText", "Percent", "Tag", "Package", "Truck", "Leaf", "Sun", "Star"];
  // icons offered for goals
  const GOAL_ICONS = ["Target", "ShieldCheck", "Umbrella", "Plane", "TreePalm", "House", "Car", "Laptop", "Smartphone",
    "GraduationCap", "Baby", "Heart", "Gem", "Gift", "Bike", "Camera", "Sofa", "PiggyBank", "Rocket", "Star"];
  const DEFAULT_GOAL_ICON = "Target";

  // a category record by id, built-in or the user's own (archived ones still resolve for old operations)
  function findCat(id) {
    if (CAT[id]) return CAT[id];
    const c = (S.settings ? settings().categories : []).find(x => x.id === id);
    return c ? { id: c.id, name: c.name, icon: c.icon, type: c.type, custom: true, archived: !!c.archived } : null;
  }
  function catOf(t) {
    const c = findCat(t.category);
    if (c && c.type === t.type) return c;
    return t.type === "income" ? CAT.other_in : t.type === "saving" ? CAT.savings : CAT.other;
  }
  // categories offered in pickers for a type: built-ins and active custom ones
  function catsFor(type) {
    if (type === "saving") return CATS.saving;
    const custom = settings().categories.filter(c => c.type === type && !c.archived)
      .map(c => ({ id: c.id, name: c.name, icon: c.icon, type: c.type, custom: true }));
    const list = CATS[type];
    return [...list.slice(0, -1), ...custom, list[list.length - 1]];   // custom ones before «Прочее»
  }
  const KIND_BG = { income: "bg-income", expense: "bg-expense", saving: "bg-saving" };

  /* ── Dates ─────────────────────────────────── */
  const pad = n => String(n).padStart(2, "0");
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const TODAY = isoOf(now);
  const YESTERDAY = isoOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const ymOf = iso => iso.slice(0, 7);
  const CUR_YM = ymOf(TODAY);
  const ymParts = ym => ym.split("-").map(Number);
  const daysIn = ym => { const [y, m] = ymParts(ym); return new Date(y, m, 0).getDate(); };
  const shiftYm = (ym, k) => { const [y, m] = ymParts(ym); const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const lastIso = ym => `${ym}-${pad(daysIn(ym))}`;
  const M_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const M_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const M_PREP = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
  const M_DAT = ["январю", "февралю", "марту", "апрелю", "маю", "июню", "июлю", "августу", "сентябрю", "октябрю", "ноябрю", "декабрю"];
  const M_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const WD = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const dParts = iso => iso.split("-").map(Number);
  function dayLabel(iso) {
    const [y, m, d] = dParts(iso);
    if (iso === TODAY) return `Сегодня, ${d} ${M_GEN[m - 1]}`;
    if (iso === YESTERDAY) return `Вчера, ${d} ${M_GEN[m - 1]}`;
    return `${d} ${M_GEN[m - 1]}, ${WD[new Date(y, m - 1, d).getDay()]}`;
  }
  const dayShort = iso => { const [, m, d] = dParts(iso); return `${d} ${M_SHORT[m - 1]}`; };
  const dayLong = iso => { const [y, m, d] = dParts(iso); return `${d} ${M_GEN[m - 1]}${y !== now.getFullYear() ? " " + y : ""}`; };

  /* ── Numbers ───────────────────────────────── */
  const NF0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const NF2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MINUS = "−", NB = " ";
  const CUR = "₪";   // Israeli new shekel
  const r2 = n => Math.round(n * 100) / 100;
  function num(v) { const a = Math.abs(r2(v)); return Number.isInteger(a) ? NF0.format(a) : NF2.format(a); }
  function money(v, opts = {}) {
    v = r2(v);
    const s = v < 0 ? MINUS : (opts.sign && v > 0 ? "+" : "");
    const body = opts.round ? NF0.format(Math.abs(Math.round(v))) : num(v);
    return `${s}${body}${NB}${CUR}`;
  }
  function parseAmount(str) {
    const s = String(str || "").replace(/[\s  ₽₪]/g, "").replace(",", ".");
    if (!s) return null;
    if (!/^\d*\.?\d*$/.test(s)) return NaN;
    const v = parseFloat(s);
    return Number.isFinite(v) ? r2(v) : NaN;
  }
  const inputAmount = v => (v == null || v === 0) ? "" : String(r2(v)).replace(".", ",");
  function plural(n, f) {
    n = Math.abs(n) % 100; const n1 = n % 10;
    if (n > 10 && n < 20) return f[2];
    if (n1 > 1 && n1 < 5) return f[1];
    if (n1 === 1) return f[0];
    return f[2];
  }
  const OPS = ["операция", "операции", "операций"];
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ── State ─────────────────────────────────── */
  const DEFAULTS = { startBalance: 0, goals: [], limits: {}, categories: [] };
  const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
  const mintId = p => p + Math.random().toString(36).slice(2, 10);
  const S = {
    status: "loading",      // loading | ready | offline
    tx: [],
    settings: null,
    month: CUR_YM,
    filter: "all",
    cat: null,
    q: "",
    readOnly: false,
    clearing: null,
    notice: "",
    sync: null,
  };
  const store = window.createBudgetStore({});
  const snapListeners = new Set();
  let lastSnap = null;

  // the settings document in its v2 shape (goals[] and categories[]); v1 data with a single `goal` is migrated here
  let settingsMemo = null, settingsMemoSrc;
  function settings() {
    if (settingsMemoSrc === S.settings && settingsMemo) return settingsMemo;
    const raw = S.settings || {};
    const out = { startBalance: 0, goals: [], limits: {}, categories: [] };
    if (typeof raw.startBalance === "number" && Number.isFinite(raw.startBalance)) out.startBalance = raw.startBalance;
    const goalOk = g => g && typeof g === "object" && typeof g.name === "string" && g.name.trim() && typeof g.target === "number" && g.target > 0;
    const normGoal = (g, i) => ({
      id: typeof g.id === "string" && ID_RE.test(g.id) ? g.id : (i === 0 ? "g_main" : "g_" + i),
      name: g.name.slice(0, 60),
      target: g.target,
      deadline: typeof g.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline) ? g.deadline : "",
      initial: typeof g.initial === "number" && g.initial > 0 ? g.initial : 0,
      icon: GOAL_ICONS.includes(g.icon) ? g.icon : DEFAULT_GOAL_ICON,
      createdAt: typeof g.createdAt === "number" ? g.createdAt : 0,
    });
    const goals = Array.isArray(raw.goals) ? raw.goals : (raw.goal ? [{ id: "g_main", ...raw.goal }] : []);
    const seen = new Set();
    for (const g of goals) {
      if (!goalOk(g)) continue;
      const n = normGoal(g, out.goals.length);
      if (seen.has(n.id)) continue;
      seen.add(n.id); out.goals.push(n);
      if (out.goals.length >= 20) break;
    }
    if (Array.isArray(raw.categories)) {
      const ids = new Set();
      for (const c of raw.categories) {
        if (!c || typeof c !== "object" || typeof c.id !== "string" || !/^c_[a-z0-9]{4,20}$/.test(c.id) || ids.has(c.id)) continue;
        if (c.type !== "income" && c.type !== "expense" || typeof c.name !== "string" || !c.name.trim()) continue;
        ids.add(c.id);
        out.categories.push({ id: c.id, type: c.type, name: c.name.slice(0, 32), icon: PICKER_ICONS.includes(c.icon) ? c.icon : "Tag", ...(c.archived ? { archived: true } : {}) });
        if (out.categories.length >= 60) break;
      }
    }
    if (raw.limits && typeof raw.limits === "object") {
      for (const [k, v] of Object.entries(raw.limits)) {
        const isExpense = (CAT[k] && CAT[k].type === "expense") || out.categories.some(c => c.id === k && c.type === "expense");
        if (isExpense && typeof v === "number" && v > 0) out.limits[k] = v;
      }
    }
    let ex = raw.example && typeof raw.example === "object" ? { ...raw.example } : null;
    if (ex && ex.goal) { ex.goals = true; delete ex.goal; }
    out.example = ex && Object.keys(ex).length ? ex : null;
    settingsMemoSrc = S.settings; settingsMemo = out;
    return out;
  }
  // the goal a saving operation belongs to: its goalId, or the first goal for older operations
  function goalOfTx(t, goals = settings().goals) {
    if (t.goalId) return goals.find(g => g.id === t.goalId) || null;
    return goals[0] || null;
  }
  function goalSaved(g, goals = settings().goals) {
    let sum = g.initial;
    for (const t of S.tx) if (t.type === "saving" && goalOfTx(t, goals) === g) sum += t.amount;
    return r2(sum);
  }
  function goalSavedInMonth(g, ym, goals = settings().goals) {
    let sum = 0;
    for (const t of S.tx) if (t.type === "saving" && ymOf(t.date) === ym && goalOfTx(t, goals) === g) sum += t.amount;
    return r2(sum);
  }
  function validTx(t) {
    return t && ["income", "expense", "saving"].includes(t.type)
      && typeof t.amount === "number" && Number.isFinite(t.amount) && t.amount > 0
      && typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date);
  }
  const sgn = t => t.type === "income" ? 1 : -1;
  function sortAsc(list) {
    return [...list].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1
      : ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id < b.id ? -1 : 1));
  }
  function derive() {
    const sorted = sortAsc(S.tx);
    let bal = settings().startBalance;
    const after = new Map();
    for (const t of sorted) { bal += sgn(t) * t.amount; after.set(t.id, r2(bal)); }
    return { sorted, after };
  }
  function balanceAt(sorted, cutoffIso) {
    let b = settings().startBalance;
    for (const t of sorted) { if (t.date > cutoffIso) break; b += sgn(t) * t.amount; }
    return r2(b);
  }
  function monthStats(ym, upToDay = 31) {
    const r = { inc: 0, exp: 0, sav: 0, n: 0, byCat: {} };
    for (const t of S.tx) {
      if (ymOf(t.date) !== ym || dParts(t.date)[2] > upToDay) continue;
      r.n++;
      if (t.type === "income") r.inc += t.amount;
      else if (t.type === "saving") r.sav += t.amount;
      else {
        r.exp += t.amount;
        const c = catOf(t).id;
        (r.byCat[c] = r.byCat[c] || { sum: 0, n: 0 });
        r.byCat[c].sum += t.amount; r.byCat[c].n++;
      }
    }
    r.inc = r2(r.inc); r.exp = r2(r.exp); r.sav = r2(r.sav);
    r.net = r2(r.inc - r.exp - r.sav);
    return r;
  }

  /* ── Render: header & notices ───────────────── */
  function renderHeader() {
    const [y, m] = ymParts(S.month);
    const ml = $("#monthLabel");
    // rewrite only on a real month change, so VoiceOver does not re-announce it on every render
    if (ml.dataset.ym !== S.month) { ml.innerHTML = `${M_NOM[m - 1]} <span>${y}</span>`; ml.dataset.ym = S.month; }
    $("#todayBtn").hidden = S.month === CUR_YM;
    const canAdd = S.status === "ready" && !S.readOnly;
    $("#addBtn").disabled = !canAdd;
    $("#fab").disabled = !canAdd;
    $("#editStart").disabled = !canAdd;
    $("#limitsBtn").disabled = !canAdd;
    $("#catsBtn").disabled = !canAdd;
  }

  function renderNotice() {
    const el = $("#notice");
    const st = settings();
    const hasExample = S.tx.some(t => t.example === true) || (st.example && Object.keys(st.example).length > 0);
    if (S.status === "offline") {
      el.className = "notice is-info"; el.hidden = false;
      el.innerHTML = `${icon("Info")}<p><b>Бюджет хранится в вашем аккаунте Claude.</b> Откройте эту страницу в claude.ai, войдя в аккаунт, чтобы добавлять операции и видеть свои данные.</p>`;
    } else if (S.notice) {
      el.className = "notice"; el.hidden = false;
      el.innerHTML = `${icon("TriangleAlert")}<p>${esc(S.notice)}</p>`;
    } else if (S.readOnly) {
      el.className = "notice is-info"; el.hidden = false;
      el.innerHTML = `${icon("Lock")}<p><b>Только просмотр.</b> Изменения не сохраняются: у вас нет прав на запись в этот бюджет.</p>`;
    } else if (S.status === "ready" && hasExample) {
      el.className = "notice"; el.hidden = false;
      const busy = S.clearing;
      el.innerHTML = `${icon("Sparkles")}<p><b>Это пример бюджета.</b> Прошлый и текущий месяц заполнены условными операциями, чтобы было видно, как всё работает. Ваши новые записи останутся, когда вы удалите пример.</p>
        <button class="btn btn-ghost btn-sm" id="clearEx" ${busy ? "disabled" : ""}>${busy ? `Удаляем ${busy.done} из ${busy.total}…` : "Удалить пример"}</button>`;
    } else {
      el.hidden = true; el.innerHTML = "";
    }
  }

  /* ── Render: balance card ───────────────────── */
  let sparkData = null;
  function renderBalance(d) {
    const ym = S.month, [y, m] = ymParts(ym);
    const ready = S.status === "ready";
    let cutoff, label;
    if (ym === CUR_YM) { cutoff = TODAY; label = `Остаток на ${dayLong(TODAY)}`; }
    else if (ym < CUR_YM) { cutoff = lastIso(ym); label = `Остаток на ${dayLong(cutoff)}`; }
    else { cutoff = lastIso(ym); label = `Прогноз на ${dayLong(cutoff)}`; }
    $("#bcLabel").textContent = label;

    if (!ready) {
      $("#bcAmount").innerHTML = `<span class="int">—</span>`;
      $("#bcSub").innerHTML = S.status === "loading" ? "Загружаем данные…" : "Нет доступа к данным";
      sparkData = null; drawSpark(); return;
    }
    const bal = balanceAt(d.sorted, cutoff);
    const prevEnd = lastIso(shiftYm(ym, -1));
    const startBal = balanceAt(d.sorted, prevEnd);
    const s = num(bal), [int, frac] = s.split(",");
    $("#bcAmount").innerHTML = `${bal < 0 ? MINUS : ""}<span class="int">${int}</span>${frac ? `<span class="frac">,${frac}</span>` : ""}<span class="cur">${CUR}</span>`;
    const change = r2(bal - startBal);
    $("#bcSub").innerHTML =
      `<span>На 1 ${M_GEN[m - 1]}: <b class="num">${money(startBal)}</b></span>` +
      `<span>С начала месяца: <b class="num">${money(change, { sign: true })}</b></span>`;

    // daily end-of-day balance series
    const lastDay = Number(cutoff.slice(8, 10));
    const pts = [];
    let b = startBal, i = 0;
    const inMonth = d.sorted.filter(t => ymOf(t.date) === ym);
    for (let day = 1; day <= lastDay; day++) {
      const iso = `${ym}-${pad(day)}`;
      while (i < inMonth.length && inMonth[i].date <= iso) { b += sgn(inMonth[i]) * inMonth[i].amount; i++; }
      pts.push({ iso, v: r2(b) });
    }
    sparkData = { pts, start: startBal };
    drawSpark();
  }

  let sparkGeo = null;
  function drawSpark() {
    const svg = $("#sparkSvg"), axis = $("#sparkAxis");
    if (!sparkData || !sparkData.pts.length) { svg.innerHTML = ""; axis.innerHTML = ""; sparkGeo = null; return; }
    const pts = sparkData.pts;
    const W = Math.max(220, Math.round(svg.getBoundingClientRect().width) || 520), H = 92;
    const padT = 10, padB = 8, padL = 5, padR = 7;
    const vs = pts.map(p => p.v);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 1) { hi += 1; lo -= 1; }
    const span = hi - lo; lo -= span * 0.1; hi += span * 0.12;
    const x = i => pts.length === 1 ? W - padR : padL + i * (W - padL - padR) / (pts.length - 1);
    const y = v => padT + (hi - v) / (hi - lo) * (H - padT - padB);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    let line = "";
    pts.forEach((p, i) => { line += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`; });
    if (pts.length === 1) line = `M${padL},${y(pts[0].v).toFixed(1)}L${x(0).toFixed(1)},${y(pts[0].v).toFixed(1)}`;
    const firstX = pts.length === 1 ? padL : x(0);
    const area = `${line}L${x(pts.length - 1).toFixed(1)},${H}L${firstX.toFixed(1)},${H}Z`;
    const zero = lo < 0 && hi > 0
      ? `<line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" style="stroke:var(--card-line)" stroke-width="1"/>` : "";
    const lx = x(pts.length - 1), ly = y(pts[pts.length - 1].v);
    svg.innerHTML = `
      <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--card-spark);stop-opacity:.32"/>
        <stop offset="1" style="stop-color:var(--card-spark);stop-opacity:0"/>
      </linearGradient></defs>
      ${zero}
      <path d="${area}" style="fill:url(#sparkFill)" stroke="none"/>
      <path d="${line}" fill="none" style="stroke:var(--card-spark)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line id="sparkGuide" x1="0" x2="0" y1="0" y2="${H}" style="stroke:var(--card-dim)" stroke-width="1" visibility="hidden"/>
      <circle id="sparkDot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5" style="fill:var(--card-spark);stroke:var(--card)" stroke-width="2"/>
      <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" id="sparkHit"/>`;
    axis.innerHTML = `<span>${dayShort(pts[0].iso)}</span><span>${dayShort(pts[pts.length - 1].iso)}</span>`;
    sparkGeo = { x, y, pts, W, H, lx, ly };
  }
  function sparkHover(e) {
    if (!sparkGeo) return;
    const svg = $("#sparkSvg"), rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (sparkGeo.W / rect.width);
    const { pts, x, y } = sparkGeo;
    let best = 0, bd = Infinity;
    pts.forEach((_, i) => { const dd = Math.abs(x(i) - px); if (dd < bd) { bd = dd; best = i; } });
    const p = pts[best], cx = x(best), cy = y(p.v);
    const g = $("#sparkGuide"), dot = $("#sparkDot");
    g.setAttribute("x1", cx); g.setAttribute("x2", cx); g.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
    const prev = best ? pts[best - 1].v : sparkData.start;
    const delta = r2(p.v - prev);
    showTip(`<b>${dayLabel(p.iso)}</b><div>Остаток: <span class="num">${money(p.v)}</span></div>${delta ? `<div>За день: <span class="num">${money(delta, { sign: true })}</span></div>` : ""}`,
      rect.left + cx * rect.width / sparkGeo.W,
      e.pointerType === "mouse" ? rect.top + cy * rect.height / sparkGeo.H : rect.top,
      e.pointerType !== "mouse");
  }
  function sparkLeave() {
    if (!sparkGeo) return;
    $("#sparkGuide") && $("#sparkGuide").setAttribute("visibility", "hidden");
    const dot = $("#sparkDot");
    if (dot) { dot.setAttribute("cx", sparkGeo.lx); dot.setAttribute("cy", sparkGeo.ly); }
    hideTip();
  }

  /* ── Render: KPIs ───────────────────────────── */
  function deltaHtml(cur, prev, goodWhenUp, cmpLabel) {
    if (!(prev > 0)) return `<span>нет данных для сравнения</span>`;
    const pct = Math.round((cur - prev) / prev * 100);
    if (pct === 0) return `<span>без изменений ${cmpLabel}</span>`;
    const up = pct > 0, good = up === goodWhenUp;
    return `<span class="${good ? "t-good" : "t-warn"}" style="display:inline-flex;align-items:center;gap:3px">${icon(up ? "TrendingUp" : "TrendingDown")}${up ? "+" : MINUS}${Math.abs(pct)}%</span><span>${cmpLabel}</span>`;
  }
  function renderKpis() {
    const el = $("#kpis");
    const ready = S.status === "ready";
    const ym = S.month, [, m] = ymParts(ym), prevYm = shiftYm(ym, -1), [, pm] = ymParts(prevYm);
    const isCur = ym === CUR_YM;
    const dayCut = isCur ? Number(TODAY.slice(8, 10)) : 31;
    const st = monthStats(ym);
    const prev = monthStats(prevYm, isCur ? dayCut : 31);
    const cmp = isCur ? `к${NB}1–\u2060${Math.min(dayCut, daysIn(prevYm))}${NB}${M_GEN[pm - 1]}` : `к${NB}${M_DAT[pm - 1]}`;
    const v = x => ready ? x : "—";
    const rate = st.inc > 0 ? Math.round(st.sav / st.inc * 100) : null;
    el.innerHTML = `
      <div class="kpi">
        <div class="kpi-label"><span class="kpi-dot bg-income">${icon("ArrowDownLeft")}</span>Доходы</div>
        <div class="kpi-value">${v(money(st.inc))}</div>
        <div class="kpi-sub">${ready ? deltaHtml(st.inc, prev.inc, true, cmp) : "&nbsp;"}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label"><span class="kpi-dot bg-expense">${icon("ArrowUpRight")}</span>Расходы</div>
        <div class="kpi-value">${v(money(st.exp))}</div>
        <div class="kpi-sub">${ready ? deltaHtml(st.exp, prev.exp, false, cmp) : "&nbsp;"}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label"><span class="kpi-dot bg-saving">${icon("PiggyBank")}</span>В копилку</div>
        <div class="kpi-value">${v(money(st.sav))}</div>
        <div class="kpi-sub">${ready ? (rate != null ? `<span class="t-gold" style="font-weight:700">${rate}%</span><span>от доходов ${isCur ? "месяца" : "в " + M_PREP[m - 1]}</span>` : "<span>доходов пока нет</span>") : "&nbsp;"}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label"><span class="kpi-dot bg-net">${icon("Scale")}</span>Итог месяца</div>
        <div class="kpi-value ${ready ? (st.net >= 0 ? "t-good" : "t-bad") : ""}">${v(money(st.net, { sign: true }))}</div>
        <div class="kpi-sub"><span>доходы − расходы − копилка</span></div>
      </div>`;
  }

  /* ── Render: categories ─────────────────────── */
  function renderCats() {
    const list = $("#catList"), total = $("#catTotal"), plan = $("#planLine");
    if (S.status !== "ready") {
      total.textContent = "—"; plan.innerHTML = "";
      list.innerHTML = S.status === "loading" ? `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>` : "";
      return;
    }
    const st = monthStats(S.month), prev = monthStats(shiftYm(S.month, -1));
    const limits = settings().limits;
    const [, pm] = ymParts(shiftYm(S.month, -1));
    total.textContent = money(st.exp);
    const ids = new Set([...Object.keys(st.byCat), ...Object.keys(limits)]);
    const rows = [...ids].map(id => ({
      c: findCat(id), sum: r2(st.byCat[id] ? st.byCat[id].sum : 0), n: st.byCat[id] ? st.byCat[id].n : 0,
      limit: limits[id] || 0, prev: r2(prev.byCat[id] ? prev.byCat[id].sum : 0),
    })).filter(r => r.c).sort((a, b) => b.sum - a.sum || b.limit - a.limit);

    const limTotal = Object.values(limits).reduce((s, x) => s + x, 0);
    if (limTotal > 0) {
      const inLimited = Object.keys(limits).reduce((s, k) => s + (st.byCat[k] ? st.byCat[k].sum : 0), 0);
      const pct = Math.round(inLimited / limTotal * 100);
      plan.innerHTML = `<div class="plan-line"><span>По категориям с лимитом: ${money(inLimited)} из ${money(limTotal)}</span><span class="num" style="font-weight:700;color:var(--ink-2)">${pct}%</span></div>`;
    } else plan.innerHTML = `<div class="plan-line"><span>Задайте лимиты, чтобы видеть, сколько ещё можно потратить</span></div>`;

    if (!rows.length) {
      list.innerHTML = `<div class="empty" style="padding:22px 8px"><div class="empty-ic">${icon("ChartBar")}</div><p>В ${M_PREP[ymParts(S.month)[1] - 1]} расходов пока нет. Добавьте расход — здесь появится разбивка по категориям.</p></div>`;
      return;
    }
    const scale = Math.max(...rows.map(r => Math.max(r.sum, r.limit)), 1);
    list.innerHTML = rows.map(r => {
      const share = st.exp > 0 ? Math.round(r.sum / st.exp * 100) : 0;
      let cls = "", stat = "";
      if (r.limit) {
        const left = r2(r.limit - r.sum);
        if (left < 0) { cls = "is-over"; stat = `<span class="st t-bad">${icon("CircleAlert")}Перерасход ${money(-left)}</span>`; }
        else if (r.sum >= r.limit * 0.85) { cls = "is-near"; stat = `<span class="st t-warn">${icon("TriangleAlert")}Осталось ${money(left)}</span>`; }
        else stat = `<span>из ${money(r.limit)}</span>`;
      }
      const tip = [
        `<b>${esc(r.c.name)}</b>`,
        `<div><span class="num">${money(r.sum)}</span> · ${share}% расходов</div>`,
        `<div>${r.n} ${plural(r.n, OPS)} · в ${M_PREP[pm - 1]} <span class="num">${money(r.prev)}</span></div>`,
        r.limit ? `<div>Лимит <span class="num">${money(r.limit)}</span></div>` : "",
        `<div style="opacity:.7;margin-top:2px">Нажмите, чтобы показать операции</div>`,
      ].join("");
      return `<button class="cat-row ${S.cat === r.c.id ? "is-active" : ""}" data-cat="${esc(r.c.id)}" data-tip="${esc(tip)}" aria-pressed="${S.cat === r.c.id}">
        <span class="tx-ic bg-expense">${icon(r.c.icon)}</span>
        <span class="cat-name">${esc(r.c.name)}</span>
        <span class="cat-amt">${money(r.sum)}</span>
        <span class="cat-track" aria-hidden="true">
          <span class="cat-bar ${cls}" style="width:${(r.sum / scale * 100).toFixed(2)}%;${r.sum ? "" : "min-width:0"}"></span>
          ${r.limit ? `<span class="cat-limit" style="left:${(r.limit / scale * 100).toFixed(2)}%"></span>` : ""}
        </span>
        <span class="cat-meta"><span>${r.n ? `${share}% · ${r.n} ${plural(r.n, OPS)}` : "трат нет"}</span>${stat}</span>
      </button>`;
    }).join("") + `<p class="cat-hint" aria-hidden="true">Нажмите на категорию, чтобы отфильтровать операции</p>`;
  }

  /* ── Render: goals ──────────────────────────── */
  function monthsBetween(fromYm, toIso) {
    const [fy, fm] = ymParts(fromYm), [ty, tm] = dParts(toIso);
    return (ty - fy) * 12 + (tm - fm);
  }
  function goalStats(g, goals) {
    const saved = goalSaved(g, goals);
    const pct = Math.min(100, saved / g.target * 100);
    const left = r2(Math.max(0, g.target - saved));
    const thisMonth = goalSavedInMonth(g, CUR_YM, goals);
    let mLeft = null, perMonth = null, need = null, overdue = false;
    if (g.deadline) {
      mLeft = monthsBetween(CUR_YM, g.deadline);
      if (left > 0 && mLeft > 0) {
        const leftAtStart = r2(Math.max(0, g.target - (saved - thisMonth)));
        perMonth = Math.ceil(leftAtStart / mLeft / 10) * 10;      // rounded up to 10 ₪
        need = r2(perMonth - thisMonth);
      } else if (left > 0) overdue = true;
    }
    return { saved, pct, left, thisMonth, mLeft, perMonth, need, overdue, done: left === 0 };
  }
  function goalStatusHtml(g, st) {
    const [, cm] = ymParts(CUR_YM);
    if (st.done) return `<div class="status is-good">${icon("PartyPopper")}<span><b>Цель достигнута!</b> Можно поставить следующую.</span></div>`;
    if (st.overdue) return `<div class="status is-warn">${icon("Clock")}<span>Срок прошёл, осталось собрать <b>${money(st.left)}</b>. Обновите дату цели.</span></div>`;
    if (st.need == null) return "";
    return st.need <= 0
      ? `<div class="status is-good">${icon("CircleCheck")}<span>В ${M_PREP[cm - 1]} отложено <b>${money(st.thisMonth)}</b>: план месяца выполнен.</span></div>`
      : st.thisMonth > 0
        ? `<div class="status is-warn">${icon("Clock")}<span>В ${M_PREP[cm - 1]} отложено ${money(st.thisMonth)}. Чтобы успеть к сроку, добавьте ещё <b>${money(st.need)}</b>.</span></div>`
        : `<div class="status is-warn">${icon("Clock")}<span>Чтобы успеть к сроку, отложите в ${M_PREP[cm - 1]} <b>${money(st.need)}</b>.</span></div>`;
  }
  function meterHtml(g, st, label) {
    const monthPart = Math.min(st.pct, st.thisMonth / g.target * 100);
    return `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${g.target}" aria-valuenow="${Math.min(st.saved, g.target)}" aria-valuetext="${Math.floor(st.pct)}%: ${money(st.saved)} из ${money(g.target)}" aria-label="${esc(label)}">
        <span class="meter-fill" style="width:${st.pct.toFixed(2)}%"></span>
        ${monthPart > 0.3 && st.pct < 100 ? `<span class="meter-month" style="left:${(st.pct - monthPart).toFixed(2)}%;width:${monthPart.toFixed(2)}%" title="Отложено в этом месяце"></span>` : ""}
      </div>`;
  }
  function goalCardHtml(g, goals, canEdit) {
    const st = goalStats(g, goals);
    let deadlineHtml = "без срока";
    if (g.deadline) {
      const [dy, dm, dd] = dParts(g.deadline);
      deadlineHtml = `${dd}${NB}${M_GEN[dm - 1]} ${dy}<small>${st.mLeft > 0 ? `осталось ${st.mLeft}${NB}мес.` : "срок наступил"}</small>`;
    }
    return `<article class="card goal-card${st.done ? " is-done" : ""}" aria-label="Цель «${esc(g.name)}»">
      <div class="goal-top">
        <span class="goal-ic">${icon(g.icon)}</span>
        <h3 class="goal-name">${esc(g.name)}</h3>
        <button class="icon-btn" data-goal-edit="${esc(g.id)}" aria-label="Изменить цель «${esc(g.name)}»" ${canEdit ? "" : "disabled"}>${icon("Pencil")}</button>
      </div>
      <div class="goal-figs">
        <span class="goal-saved">${money(st.saved)}</span>
        <span class="goal-of">из ${money(g.target)}</span>
        <span class="goal-pct">${Math.floor(st.pct)}%</span>
      </div>
      ${meterHtml(g, st, `Накоплено ${money(st.saved)} из ${money(g.target)}`)}
      <dl class="goal-stats">
        <div><dt>Осталось</dt><dd>${money(st.left)}</dd></div>
        <div><dt>Срок</dt><dd>${deadlineHtml}</dd></div>
        <div><dt>В месяц</dt><dd>${st.perMonth ? "≈" + NB + money(st.perMonth) : "—"}</dd></div>
      </dl>
      ${goalStatusHtml(g, st)}
      ${st.done ? "" : `<button class="btn btn-gold" data-goal-add="${esc(g.id)}" ${canEdit ? "" : "disabled"}>${icon("PiggyBank")}Отложить</button>`}
    </article>`;
  }
  // compact goals card in the side column of the budget view
  function renderGoal() {
    const el = $("#goalCard");
    const goals = settings().goals;
    const canEdit = S.status === "ready" && !S.readOnly;
    if (S.status !== "ready" || !goals.length) {
      el.innerHTML = `<div class="card-head"><div><p class="eyebrow">Цели накоплений</p><h2 id="goalTitle">Копите на что-то важное?</h2></div></div>
        <p class="hint" style="margin:0 0 14px">Поставьте одну или несколько целей: подушка безопасности, отпуск, ноутбук. Переводы «В копилку» будут двигать прогресс нужной цели.</p>
        <button class="btn btn-gold" data-do="goal-new" ${canEdit ? "" : "disabled"}>${icon("Target")}Поставить цель</button>`;
      return;
    }
    const total = goals.reduce((sum, g) => sum + goalSaved(g, goals), 0);
    const shown = goals.slice(0, 3);
    el.innerHTML = `
      <div class="card-head">
        <div><p class="eyebrow">Цели накоплений</p><h2 id="goalTitle">Накоплено ${money(total)}</h2></div>
        <button class="btn btn-ghost btn-sm" data-do="goals-view">Все цели</button>
      </div>
      <div class="goal-mini-list">
        ${shown.map(g => {
          const st = goalStats(g, goals);
          return `<button class="goal-mini" data-goal-add="${esc(g.id)}" ${canEdit && !st.done ? "" : "disabled"} aria-label="Отложить на цель «${esc(g.name)}»: ${Math.floor(st.pct)}%, ${money(st.saved)} из ${money(g.target)}">
            <span class="goal-ic">${icon(g.icon)}</span>
            <span class="goal-mini-name">${esc(g.name)}</span>
            <span class="goal-mini-pct">${st.done ? icon("CircleCheck") : Math.floor(st.pct) + "%"}</span>
            <span class="goal-mini-meter" aria-hidden="true"><span style="width:${st.pct.toFixed(2)}%"></span></span>
            <span class="goal-mini-meta">${money(st.saved)} из ${money(g.target)}${st.need > 0 ? ` · ещё ${money(st.need)} в этом месяце` : ""}</span>
          </button>`;
        }).join("")}
      </div>
      ${goals.length > shown.length ? `<p class="hint goal-more">И ещё ${goals.length - shown.length} ${plural(goals.length - shown.length, ["цель", "цели", "целей"])} на вкладке «Цели».</p>` : ""}
      <button class="btn btn-gold" data-do="saving" ${canEdit ? "" : "disabled"}>${icon("PiggyBank")}Отложить в копилку</button>`;
  }
  // the «Цели» view
  function renderGoalsView() {
    const el = $("#viewGoals");
    if (!el) return;
    const goals = settings().goals;
    const canEdit = S.status === "ready" && !S.readOnly;
    const total = goals.reduce((sum, g) => sum + goalSaved(g, goals), 0);
    const target = goals.reduce((sum, g) => sum + g.target, 0);
    const month = goals.reduce((sum, g) => sum + goalSavedInMonth(g, CUR_YM, goals), 0);
    const [, cm] = ymParts(CUR_YM);
    const head = `<div class="view-head">
        <div><h2 class="view-title">Цели накоплений</h2>
          <p class="meta">${goals.length ? `${goals.length} ${plural(goals.length, ["цель", "цели", "целей"])} · накоплено ${money(total)} из ${money(target)} · в ${M_PREP[cm - 1]} отложено ${money(month)}` : "Здесь будут ваши цели и прогресс по каждой"}</p></div>
        <button class="btn btn-primary" data-do="goal-new" ${canEdit ? "" : "disabled"}>${icon("Plus")}Новая цель</button>
      </div>`;
    if (S.status !== "ready") { el.innerHTML = head + `<div class="skeleton"></div>`; return; }
    el.innerHTML = head + (goals.length
      ? `<div class="goal-grid">${goals.map(g => goalCardHtml(g, goals, canEdit)).join("")}</div>`
      : `<div class="card empty"><div class="empty-ic">${icon("Target")}</div><h3>Целей пока нет</h3>
          <p>Начните с подушки безопасности: обычно советуют запас на 3–6 месяцев расходов. Потом добавьте отпуск, технику или учёбу.</p>
          <div class="row"><button class="btn btn-primary" data-do="goal-new" ${canEdit ? "" : "disabled"}>${icon("Plus")}Поставить цель</button></div></div>`);
  }

  /* ── Render: ledger ─────────────────────────── */
  function renderLedger(d) {
    const body = $("#ledgerBody"), meta = $("#ledgerMeta");
    $$("#typeFilter button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === S.filter)));
    const chip = $("#catChipSlot");
    const fc = S.cat ? findCat(S.cat) : null;
    chip.innerHTML = fc
      ? `<button class="cat-chip" id="clearCat" aria-label="Сбросить категорию ${esc(fc.name)}">${esc(fc.name)}${icon("X")}</button>` : "";
    const [, m] = ymParts(S.month);

    if (S.status === "loading") {
      meta.textContent = "Загружаем…";
      body.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
      return;
    }
    if (S.status === "offline") {
      meta.textContent = "Нет подключения к хранилищу";
      body.innerHTML = `<div class="empty"><div class="empty-ic">${icon("CloudOff")}</div><h3>Операции недоступны</h3><p>Войдите в claude.ai и откройте страницу снова: доходы и расходы хранятся в вашем личном разделе.</p></div>`;
      return;
    }
    const inMonth = S.tx.filter(t => ymOf(t.date) === S.month);
    let list = inMonth;
    if (S.filter !== "all") list = list.filter(t => t.type === S.filter);
    if (S.cat) list = list.filter(t => catOf(t).id === S.cat);
    const q = S.q.trim().toLowerCase();
    if (q) {
      const qn = q.replace(/[\s ]/g, "").replace(",", ".");
      list = list.filter(t => (t.note || "").toLowerCase().includes(q) || catOf(t).name.toLowerCase().includes(q) || String(t.amount).includes(qn));
    }
    meta.textContent = list.length === inMonth.length
      ? `${inMonth.length} ${plural(inMonth.length, OPS)} в ${M_PREP[m - 1]}`
      : `Показано ${list.length} из ${inMonth.length}`;
    if (S.cat && findCat(S.cat)) {
      // the category tooltip is mouse-only: give touch users last month's figure and the limit here
      const pYm = shiftYm(S.month, -1), pv = monthStats(pYm).byCat[S.cat], lim = settings().limits[S.cat];
      meta.textContent += ` · в ${M_PREP[ymParts(pYm)[1] - 1]}: ${money(pv ? pv.sum : 0)}${lim ? ` · лимит ${money(lim)}` : ""}`;
    }

    if (!S.tx.length) {
      body.innerHTML = `<div class="empty"><div class="empty-ic">${icon("ReceiptText")}</div><h3>Здесь появятся ваши доходы и расходы</h3>
        <p>Укажите, сколько денег у вас сейчас, и добавьте первую операцию. Остаток после каждой записи посчитается сам.</p>
        <div class="row"><button class="btn btn-ghost" data-act="start" ${S.readOnly ? "disabled" : ""}>Указать остаток</button><button class="btn btn-primary" data-act="add" ${S.readOnly ? "disabled" : ""}>${icon("Plus")}Добавить операцию</button></div></div>`;
      return;
    }
    if (!list.length) {
      const filtered = list.length !== inMonth.length || inMonth.length === 0 && (q || S.cat || S.filter !== "all");
      body.innerHTML = inMonth.length && filtered
        ? `<div class="empty"><div class="empty-ic">${icon("SearchX")}</div><h3>Ничего не найдено</h3><p>Попробуйте другой запрос или сбросьте фильтры.</p><div class="row"><button class="btn btn-ghost" data-act="reset">Сбросить фильтры</button></div></div>`
        : `<div class="empty"><div class="empty-ic">${icon("CalendarDays")}</div><h3>В ${M_PREP[m - 1]} операций нет</h3><p>Добавьте доход или расход за этот месяц.</p><div class="row"><button class="btn btn-primary" data-act="add" ${S.readOnly ? "disabled" : ""}>${icon("Plus")}Добавить операцию</button></div></div>`;
      return;
    }
    const sorted = sortAsc(list).reverse();
    const groups = [];
    for (const t of sorted) {
      const g = groups[groups.length - 1];
      if (g && g.date === t.date) g.items.push(t); else groups.push({ date: t.date, items: [t] });
    }
    body.innerHTML = groups.map(g => {
      const dayNet = r2(g.items.reduce((s, t) => s + sgn(t) * t.amount, 0));
      return `<div class="day"><div class="day-head"><span>${dayLabel(g.date)}</span><span class="num">${money(dayNet, { sign: true })}</span></div>
        <ul class="tx-list">${g.items.map(t => txRow(t, d.after.get(t.id))).join("")}</ul></div>`;
    }).join("");
  }
  const TOUCH_UI = matchMedia("(hover: none)").matches;
  function txRow(t, after) {
    const c = catOf(t);
    const title = t.note && t.note.trim() ? t.note.trim() : c.name;
    const amtCls = t.type === "income" ? "t-good" : t.type === "saving" ? "t-gold" : "";
    const sign = t.type === "income" ? "+" : MINUS;
    const goal = t.type === "saving" ? goalOfTx(t) : null;
    const metaName = t.type === "saving" ? (goal ? `Копилка · ${goal.name}` : "Копилка") : c.name;
    const label = `${title}, ${sign}${money(t.amount)}, ${metaName}${t.example ? ", пример" : ""}, остаток ${money(after)}`;
    return `<li class="tx" ${TOUCH_UI ? 'role="button"' : ""} tabindex="0" data-id="${esc(t.id)}" aria-label="${esc(label)}">
      <span class="tx-ic ${KIND_BG[t.type]}">${icon(c.icon)}</span>
      <div class="tx-main"><div class="tx-title">${esc(title)}</div>
        <div class="tx-meta"><span style="overflow:hidden;text-overflow:ellipsis">${esc(metaName)}</span>${t.example ? `<span class="ex-tag">пример</span>` : ""}</div></div>
      <div class="tx-sum"><div class="tx-amt ${amtCls}">${sign}${money(t.amount)}</div><div class="tx-bal">ост. ${money(after)}</div></div>
      <div class="tx-actions">
        <button class="icon-btn" data-act="edit" aria-label="Изменить" ${S.readOnly ? "disabled" : ""}>${icon("Pencil")}</button>
        <button class="icon-btn del" data-act="del" aria-label="Удалить" ${S.readOnly ? "disabled" : ""}>${icon("Trash2")}</button>
      </div>
    </li>`;
  }

  function render() {
    const d = derive();
    renderHeader();
    renderNotice();
    renderBalance(d);
    renderKpis();
    renderCats();
    renderGoal();
    renderGoalsView();
    renderLedger(d);
    if (lastSnap) for (const cb of snapListeners) { try { cb(lastSnap); } catch (e) { console.error(e); } }
  }

  /* ── Tooltip & toast ───────────────────────── */
  const tip = $("#tip");
  // `above`: centre the tip above the point (touch), so the finger does not cover it
  function showTip(html, x, y, above = false) {
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = above ? x - r.width / 2 : x + 14, top = above ? y - r.height - 12 : y + 14;
    if (!above && left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (!above && top + r.height > innerHeight - 8) top = y - r.height - 14;
    left = Math.min(Math.max(8, left), innerWidth - r.width - 8);
    tip.style.transform = `translate(${left}px, ${Math.max(8, top)}px)`;
  }
  function hideTip() { tip.hidden = true; }

  let toastTimer = null;
  function toast(msg, action) {
    const el = $("#toast");
    clearTimeout(toastTimer);
    el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" id="toastAct">${esc(action.label)}</button>` : ""}`;
    el.hidden = false;
    const live = $("#live"); live.textContent = "";
    setTimeout(() => { live.textContent = action ? `${msg}. Кнопка «${action.label}» внизу экрана` : msg; }, 60);
    if (action) $("#toastAct").onclick = () => { el.hidden = true; action.run(); };
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3200);
  }

  /* ── Writes (through the store adapter) ─────── */
  const ERR_DEFAULT = {
    read_only: "Нет прав на запись: этот бюджет открыт только для просмотра.",
    quota: "Хранилище заполнено. Удалите старые операции и повторите.",
    rate: "Слишком много действий подряд. Подождите пару секунд и повторите.",
    revoked: "Доступ к данным для этой страницы закрыт.",
    network: "Нет соединения. Проверьте интернет и повторите.",
  };
  function errText(e) {
    const c = e && e.code;
    if (c === "read_only") { S.readOnly = true; render(); }
    return (e && e.message && e.code) ? e.message : (ERR_DEFAULT[c] || "Не удалось сохранить. Повторите попытку.");
  }
  // the normalized v2 settings document, ready to store (never carries the legacy `goal` key)
  function settingsDoc() {
    const st = settings();
    const doc = { startBalance: st.startBalance, goals: st.goals.map(g => ({ ...g })), limits: { ...st.limits }, categories: st.categories.map(c => ({ ...c })) };
    if (st.example) doc.example = { ...st.example };
    return doc;
  }
  function saveSettings(patch) {
    const next = { ...settingsDoc(), ...patch };
    if (next.example && typeof next.example === "object") {
      for (const k of Object.keys(patch)) delete next.example[k];
      if (!Object.keys(next.example).length) delete next.example;
    }
    return store.saveSettings(next);
  }

  /* ── Transaction dialog ────────────────────── */
  const txDlg = $("#txDlg");
  let editing = null;
  function defaultDate() {
    if (S.month === CUR_YM) return TODAY;
    return S.month < CUR_YM ? lastIso(S.month) : `${S.month}-01`;
  }
  // categories most used in the last 60 days come first, so the usual choice is one tap away
  function usageOrder(type) {
    const since = isoOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60));
    const count = {};
    for (const t of S.tx) if (t.type === type && t.date >= since) count[t.category] = (count[t.category] || 0) + 1;
    const list = catsFor(type);
    const last = list[list.length - 1];
    return [...list.slice(0, -1).map((c, i) => ({ c, i, n: count[c.id] || 0 })).sort((x, y) => y.n - x.n || x.i - y.i).map(x => x.c), last];
  }
  function renderCatChips(type, selected, goalId) {
    const field = $("#catField"), legend = $("#catLegend"), hint = $("#savingHint");
    if (type === "saving") {
      const goals = settings().goals;
      legend.textContent = "Цель";
      hint.hidden = false;
      hint.textContent = "Сумма уйдёт в копилку выбранной цели, уменьшит остаток на счёте и не попадёт в расходы.";
      if (!goals.length) {
        field.hidden = true;
        hint.innerHTML = `Сумма уйдёт в копилку, уменьшит остаток на счёте и не попадёт в расходы. <button type="button" class="link-btn" data-do="goal-new">Поставить цель</button>, чтобы видеть прогресс.`;
        $("#catChips").innerHTML = `<input type="radio" name="category" value="savings" checked hidden>`;
        return;
      }
      field.hidden = false;
      const sel = goals.some(g => g.id === goalId) ? goalId : goals.find(g => !goalStats(g, goals).done)?.id || goals[0].id;
      $("#catChips").innerHTML = `<input type="radio" name="category" value="savings" checked hidden>` + goals.map(g =>
        `<label class="chip-opt"><input type="radio" name="goal" value="${esc(g.id)}" ${g.id === sel ? "checked" : ""}><span>${icon(g.icon)}${esc(g.name)}</span></label>`).join("");
      return;
    }
    field.hidden = false; hint.hidden = true;
    legend.textContent = "Категория";
    const list = usageOrder(type);
    const fallback = type === "expense" ? (list.find(c => c.id === "groceries") || list[0]) : list[0];
    const sel = list.some(c => c.id === selected) ? selected : fallback.id;
    // long lists: the most used categories first, the rest behind «Ещё»
    const SHOW = 9;
    const expanded = catChipsExpanded || list.length <= SHOW + 2;
    let shown = list;
    if (!expanded) {
      shown = list.slice(0, SHOW);
      const selCat = list.find(c => c.id === sel);
      if (!shown.includes(selCat)) shown = [...shown.slice(0, SHOW - 1), selCat];
    }
    $("#catChips").innerHTML = shown.map(c =>
      `<label class="chip-opt"><input type="radio" name="category" value="${esc(c.id)}" ${c.id === sel ? "checked" : ""}><span>${icon(c.icon)}${esc(c.name)}</span></label>`).join("")
      + (expanded ? "" : `<button type="button" class="chip-more" data-more="1">${icon("Ellipsis")}Ещё ${list.length - shown.length}</button>`)
      + `<button type="button" class="chip-add" data-do="cat-new" data-type="${type}">${icon("Plus")}Своя категория</button>`;
  }
  let catChipsExpanded = false;
  $("#catChips").addEventListener("click", e => {
    if (!e.target.closest("[data-more]")) return;
    catChipsExpanded = true;
    const type = $('#txForm input[name="type"]:checked').value, cur = $('#txForm input[name="category"]:checked');
    renderCatChips(type, cur ? cur.value : null);
  });

  function openTx(t = null, preset = {}) {
    if (S.status !== "ready" || S.readOnly) return;
    editing = t;
    const type = t ? t.type : (preset.type || (S.filter !== "all" ? S.filter : "expense"));
    $(`#txForm input[name="type"][value="${type}"]`).checked = true;
    catChipsExpanded = false;
    renderCatChips(type, t ? t.category : (preset.category || S.cat || null), t ? t.goalId : preset.goalId);
    $("#txAmount").value = t ? inputAmount(t.amount) : "";
    $("#txDate").value = t ? t.date : defaultDate();
    $("#txNote").value = t ? (t.note || "") : "";
    $("#txDlgTitle").textContent = t ? "Изменить операцию" : (type === "saving" ? "Отложить в копилку" : "Новая операция");
    $("#txDelete").hidden = !t;
    $("#txConfirm").hidden = true;
    $("#txErr").hidden = true;
    $$('#txForm [type="submit"]').forEach(b => { b.disabled = false; });
    $("#txSave").textContent = "Сохранить";
    txDlg.showModal();
    // focus inside the tap itself, or iOS does not open the keypad; when editing on touch, leave the keypad closed
    if (!t || matchMedia("(pointer: fine)").matches) $("#txAmount").focus();
  }
  $("#txForm").addEventListener("change", e => {
    if (e.target.name === "type") {
      const cur = $('#txForm input[name="category"]:checked');
      renderCatChips(e.target.value, cur ? cur.value : null);
      if (!editing) $("#txDlgTitle").textContent = e.target.value === "saving" ? "Отложить в копилку" : "Новая операция";
    }
  });
  $("#txForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#txErr");
    const amount = parseAmount($("#txAmount").value);
    const type = $('#txForm input[name="type"]:checked').value;
    const catEl = $('#txForm input[name="category"]:checked');
    const date = $("#txDate").value;
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    if (amount == null || Number.isNaN(amount) || amount <= 0) { fail("Введите сумму больше нуля, например 1 250 или 349,90."); $("#txAmount").focus(); return; }
    if (amount >= 1e10) { fail("Сумма слишком большая. Проверьте, нет ли лишних цифр."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1900-01-01" || date > "2199-12-31") { fail("Укажите дату операции между 1900 и 2199 годом."); $("#txDate").focus(); return; }
    const data = {
      type, amount, date,
      category: type === "saving" ? "savings" : (catEl ? catEl.value : "other"),
      ...(type === "saving" && $('#txForm input[name="goal"]:checked') ? { goalId: $('#txForm input[name="goal"]:checked').value } : {}),
      note: $("#txNote").value.trim().slice(0, 80),
      createdAt: editing && editing.createdAt ? editing.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    // two submit buttons (footer and the header one shown while typing): guard against a double create
    const btn = $("#txSave"), subs = $$('#txForm [type="submit"]');
    if (btn.disabled) return;
    subs.forEach(b => { b.disabled = true; }); btn.textContent = "Сохраняем…";
    try {
      await store.saveTx(editing ? editing.id : null, data);
      txDlg.close();
      if (ymOf(date) !== S.month) {
        const [, mm] = ymParts(ymOf(date));
        toast(`Сохранено в ${M_PREP[mm - 1]}`, { label: "Показать", run: () => { S.month = ymOf(date); render(); } });
      } else toast(editing ? "Изменения сохранены" : "Операция добавлена");
    } catch (ex) {
      fail(errText(ex));
      subs.forEach(b => { b.disabled = false; }); btn.textContent = "Сохранить";
    }
  });
  $("#txDelete").addEventListener("click", () => { $("#txConfirm").hidden = false; $("#txConfirmYes").focus(); });
  $("#txConfirmNo").addEventListener("click", () => { $("#txConfirm").hidden = true; });
  $("#txConfirmYes").addEventListener("click", async () => {
    if (!editing) return;
    const t = editing;
    txDlg.close();
    await deleteTx(t);
  });

  async function deleteTx(t) {
    const snapshot = { ...t }; delete snapshot.id;
    try {
      await store.deleteTx(t.id);
      toast("Операция удалена", {
        label: "Вернуть",
        run: async () => {
          try { await store.restoreTx(t.id, snapshot); toast("Операция возвращена"); }
          catch (e) { toast(errText(e)); }
        },
      });
    } catch (e) { toast(errText(e)); }
  }

  /* ── Goal dialog (new or edit) ─────────────── */
  const goalDlg = $("#goalDlg");
  let editingGoal = null;
  function iconGrid(el, name, icons, selected) {
    el.innerHTML = icons.map(n =>
      `<label class="icon-opt" title=""><input type="radio" name="${name}" value="${n}" ${n === selected ? "checked" : ""} aria-label="${n}"><span>${icon(n)}</span></label>`).join("");
  }
  function openGoal(id) {
    if (S.status !== "ready" || S.readOnly) return;
    const goals = settings().goals;
    const g = id ? goals.find(x => x.id === id) || null : null;
    if (!g && goals.length >= 20) { toast("Можно завести до 20 целей. Удалите выполненную, чтобы добавить новую."); return; }
    editingGoal = g;
    $("#goalDlgTitle").textContent = g ? "Изменить цель" : "Новая цель";
    $("#gName").value = g ? g.name : "";
    $("#gTarget").value = g ? inputAmount(g.target) : "";
    $("#gDeadline").value = g ? g.deadline : "";
    $("#gInitial").value = g ? inputAmount(g.initial) : "";
    iconGrid($("#gIcons"), "gicon", GOAL_ICONS, g ? g.icon : (goals.length ? "Target" : "ShieldCheck"));
    $("#goalDelete").hidden = !g;
    $("#goalErr").hidden = true;
    goalDlg.showModal();
    if (!g || matchMedia("(pointer: fine)").matches) $("#gName").focus();
  }
  $("#goalForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#goalErr");
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    const name = $("#gName").value.trim();
    const target = parseAmount($("#gTarget").value);
    const initial = parseAmount($("#gInitial").value) || 0;
    const deadline = $("#gDeadline").value;
    const ic = ($('#goalForm input[name="gicon"]:checked') || {}).value || DEFAULT_GOAL_ICON;
    if (!name) { fail("Назовите цель, например «Подушка безопасности»."); $("#gName").focus(); return; }
    if (!target || Number.isNaN(target) || target <= 0 || target >= 1e10) { fail("Укажите сумму цели больше нуля."); $("#gTarget").focus(); return; }
    if (Number.isNaN(initial) || initial < 0) { fail("Отложенная сумма должна быть числом, например 5 000."); return; }
    if (deadline && (deadline < "1900-01-01" || deadline > "2199-12-31")) { fail("Укажите срок между 1900 и 2199 годом или оставьте поле пустым."); return; }
    const goals = settings().goals.map(g => ({ ...g }));
    const fields = { name: name.slice(0, 60), target, deadline: deadline || "", initial, icon: ic };
    let next;
    if (editingGoal) next = goals.map(g => g.id === editingGoal.id ? { ...g, ...fields } : g);
    else next = [...goals, { id: mintId("g_"), createdAt: Date.now(), ...fields }];
    try {
      await saveSettings({ goals: next });
      goalDlg.close(); toast(editingGoal ? "Цель сохранена" : "Цель добавлена");
    } catch (ex) { fail(errText(ex)); }
  });
  $("#goalDelete").addEventListener("click", async () => {
    if (!editingGoal) return;
    const prev = settings().goals.map(g => ({ ...g }));
    const gone = editingGoal;
    goalDlg.close();
    try {
      await saveSettings({ goals: prev.filter(g => g.id !== gone.id) });
      toast(`Цель «${gone.name}» убрана`, { label: "Вернуть", run: () => saveSettings({ goals: prev }).catch(e => toast(errText(e))) });
    } catch (ex) { toast(errText(ex)); }
  });

  /* ── Category editor and manager ───────────── */
  const catDlg = $("#catDlg"), catsDlg = $("#catsDlg");
  let editingCat = null, catFromTx = false;
  function catUsage(id) {
    return S.tx.reduce((n, t) => n + (t.category === id ? 1 : 0), 0);
  }
  function openCatEditor(id, type, fromTx = false) {
    if (S.status !== "ready" || S.readOnly) return;
    const cats = settings().categories;
    const c = id ? cats.find(x => x.id === id) || null : null;
    if (!c && cats.length >= 60) { toast("Можно завести до 60 своих категорий. Удалите ненужные, чтобы добавить новую."); return; }
    editingCat = c; catFromTx = fromTx;
    $("#catDlgTitle").textContent = c ? "Изменить категорию" : "Новая категория";
    const t = c ? c.type : (type === "income" ? "income" : "expense");
    $(`#catForm input[name="ctype"][value="${t}"]`).checked = true;
    $$('#catForm input[name="ctype"]').forEach(r => { r.disabled = !!c && catUsage(c.id) > 0; });
    $("#cName").value = c ? c.name : "";
    iconGrid($("#cIcons"), "cicon", PICKER_ICONS, c ? c.icon : null);
    const used = c ? catUsage(c.id) : 0;
    $("#catRemove").hidden = !c;
    $("#catRemove").lastChild.textContent = used ? "Скрыть" : "Удалить";
    $("#catRemove").setAttribute("aria-label", used ? "Скрыть категорию" : "Удалить категорию");
    $("#catRemoveHint").hidden = !c || !used;
    $("#catRemoveHint").textContent = used ? `Категория есть в ${used} ${plural(used, OPS)}. Её можно скрыть: старые записи сохранят название и иконку.` : "";
    $("#catErr").hidden = true;
    catDlg.showModal();
    if (!c || matchMedia("(pointer: fine)").matches) $("#cName").focus();
  }
  $("#catForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#catErr");
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    const name = $("#cName").value.trim().slice(0, 32);
    const type = $('#catForm input[name="ctype"]:checked').value;
    const ic = ($('#catForm input[name="cicon"]:checked') || {}).value;
    if (!name) { fail("Назовите категорию, например «Ваад байт»."); $("#cName").focus(); return; }
    if (!ic) { fail("Выберите иконку."); return; }
    const taken = [...catsFor(type)].some(c => c.name.toLowerCase() === name.toLowerCase() && (!editingCat || c.id !== editingCat.id));
    if (taken) { fail(`Категория «${name}» уже есть.`); return; }
    const cats = settings().categories.map(c => ({ ...c }));
    const id = editingCat ? editingCat.id : "c_" + Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "x");
    const next = editingCat ? cats.map(c => c.id === id ? { ...c, name, type, icon: ic } : c) : [...cats, { id, type, name, icon: ic }];
    try {
      await saveSettings({ categories: next });
      catDlg.close();
      toast(editingCat ? "Категория сохранена" : `Категория «${name}» добавлена`);
      if (catFromTx && txDlg.open) {
        $(`#txForm input[name="type"][value="${type}"]`).checked = true;
        renderCatChips(type, id);
      }
      if (catsDlg.open) renderCatsManager();
    } catch (ex) { fail(errText(ex)); }
  });
  $("#catRemove").addEventListener("click", async () => {
    if (!editingCat) return;
    const prev = settings().categories.map(c => ({ ...c }));
    const gone = editingCat, used = catUsage(gone.id) > 0;
    const next = used ? prev.map(c => c.id === gone.id ? { ...c, archived: true } : c) : prev.filter(c => c.id !== gone.id);
    catDlg.close();
    try {
      await saveSettings({ categories: next });
      toast(used ? `Категория «${gone.name}» скрыта` : `Категория «${gone.name}» удалена`, { label: "Вернуть", run: () => saveSettings({ categories: prev }).catch(e => toast(errText(e))) });
      if (catsDlg.open) renderCatsManager();
    } catch (ex) { toast(errText(ex)); }
  });
  function renderCatsManager() {
    const cats = settings().categories;
    const group = (title, list, archived) => list.length ? `<h3 class="cats-group">${title}</h3><div class="cats-list">${list.map(c => `
      <div class="cats-row">
        <span class="tx-ic ${c.type === "income" ? "bg-income" : "bg-expense"}">${icon(c.icon)}</span>
        <span class="cats-name"><b>${esc(c.name)}</b><small>${c.type === "income" ? "доход" : "расход"} · ${catUsage(c.id)} ${plural(catUsage(c.id), OPS)}</small></span>
        ${archived ? `<button type="button" class="btn btn-ghost btn-sm" data-cat-restore="${esc(c.id)}">Вернуть</button>`
                   : `<button type="button" class="icon-btn" data-cat-edit="${esc(c.id)}" aria-label="Изменить категорию «${esc(c.name)}»">${icon("Pencil")}</button>`}
      </div>`).join("")}</div>` : "";
    const active = cats.filter(c => !c.archived), hidden = cats.filter(c => c.archived);
    $("#catsBody").innerHTML = active.length || hidden.length
      ? group("Расходы", active.filter(c => c.type === "expense")) + group("Доходы", active.filter(c => c.type === "income")) + group("Скрытые", hidden, true)
      : `<div class="empty" style="padding:18px 8px"><div class="empty-ic">${icon("Tags")}</div><p>Своих категорий пока нет. Добавьте, например, «Ваад байт», «Кружки детей» или «Социальное пособие на жильё».</p></div>`;
  }
  function openCategories() {
    if (S.status !== "ready" || S.readOnly) return;
    renderCatsManager();
    catsDlg.showModal();
  }
  $("#catsBody").addEventListener("click", async e => {
    const ed = e.target.closest("[data-cat-edit]");
    if (ed) { openCatEditor(ed.dataset.catEdit); return; }
    const rs = e.target.closest("[data-cat-restore]");
    if (rs) {
      const next = settings().categories.map(c => c.id === rs.dataset.catRestore ? (({ archived, ...rest }) => rest)(c) : { ...c });
      try { await saveSettings({ categories: next }); renderCatsManager(); toast("Категория снова в списке"); }
      catch (ex) { toast(errText(ex)); }
    }
  });
  $("#catsAdd").addEventListener("click", () => openCatEditor(null, "expense"));

  /* ── Limits dialog ─────────────────────────── */
  const limitsDlg = $("#limitsDlg");
  function openLimits() {
    if (S.status !== "ready" || S.readOnly) return;
    const lim = settings().limits, st = monthStats(S.month), [, m] = ymParts(S.month);
    $("#limitList").innerHTML = catsFor("expense").map(c => `
      <label class="limit-row">
        <span class="tx-ic bg-expense">${icon(c.icon)}</span>
        <span><b>${esc(c.name)}</b><small>в ${M_PREP[m - 1]}: ${money(st.byCat[c.id] ? st.byCat[c.id].sum : 0)}</small></span>
        <span class="money-input"><input class="input num" inputmode="decimal" autocomplete="off" id="lim-${esc(c.id)}" data-cat="${esc(c.id)}" placeholder="без лимита" value="${inputAmount(lim[c.id] || 0)}"></span>
      </label>`).join("");
    $("#limitsErr").hidden = true;
    limitsDlg.showModal();
  }
  $("#limitsForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#limitsErr");
    const limits = {};
    for (const inp of $$("#limitList input")) {
      const v = parseAmount(inp.value);
      if (v == null || v === 0) continue;
      if (Number.isNaN(v) || v < 0) { err.textContent = `Проверьте лимит для «${(findCat(inp.dataset.cat) || CAT.other).name}»: нужна сумма числом.`; err.hidden = false; inp.focus(); return; }
      limits[inp.dataset.cat] = v;
    }
    try { await saveSettings({ limits }); limitsDlg.close(); toast("Лимиты сохранены"); }
    catch (ex) { err.textContent = errText(ex); err.hidden = false; }
  });

  /* ── Start balance dialog ──────────────────── */
  const startDlg = $("#startDlg");
  function openStart() {
    if (S.status !== "ready" || S.readOnly) return;
    const v = settings().startBalance;
    // the iPhone decimal keypad has no minus key, so the sign is a separate choice
    $(`#startForm input[name="startSign"][value="${v < 0 ? -1 : 1}"]`).checked = true;
    $("#startAmount").value = inputAmount(Math.abs(v));
    $("#startErr").hidden = true;
    startDlg.showModal();
    $("#startAmount").focus();
  }
  $("#startForm").addEventListener("submit", async e => {
    e.preventDefault();
    const raw = $("#startAmount").value.trim();
    const neg = $('#startForm input[name="startSign"]:checked').value === "-1" || /^[-−]/.test(raw);
    const v = parseAmount(raw.replace(/^[-−]/, ""));
    const err = $("#startErr");
    if (v != null && Number.isNaN(v)) { err.textContent = "Введите сумму числом, например 52 400."; err.hidden = false; return; }
    try { await saveSettings({ startBalance: (v || 0) * (neg ? -1 : 1) }); startDlg.close(); toast("Начальный остаток сохранён"); }
    catch (ex) { err.textContent = errText(ex); err.hidden = false; }
  });

  /* ── Clear example data ────────────────────── */
  async function clearExamples() {
    if (S.clearing) return;
    const ex = S.tx.filter(t => t.example === true);
    S.clearing = { done: 0, total: ex.length };
    renderNotice();
    try {
      await store.deleteMany(ex.map(t => t.id), done => { S.clearing.done = done; renderNotice(); });
      const ex = settings().example;
      if (ex && Object.keys(ex).length) {
        const next = settingsDoc();
        for (const k of Object.keys(ex)) if (k in DEFAULTS) next[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
        delete next.example;
        await store.saveSettings(next);
      }
      S.clearing = null; S.cat = null;
      render();
      toast("Пример удалён. Укажите начальный остаток и добавьте свои операции.");
    } catch (e) {
      S.clearing = null; render(); toast(errText(e));
    }
  }

  /* ── Events ────────────────────────────────── */
  $("#prevMonth").addEventListener("click", () => { S.month = shiftYm(S.month, -1); render(); });
  $("#nextMonth").addEventListener("click", () => { S.month = shiftYm(S.month, 1); render(); });
  $("#todayBtn").addEventListener("click", () => { S.month = CUR_YM; render(); });
  $("#addBtn").addEventListener("click", () => openTx());
  $("#fab").addEventListener("click", () => openTx());
  $("#editStart").addEventListener("click", openStart);
  $("#limitsBtn").addEventListener("click", openLimits);
  /* Dialog behaviour shared with pwa.js: data-close buttons, backdrop tap, iOS scroll and keyboard handling */
  const KB_SEL = 'input:not([type="radio"]):not([type="checkbox"]):not([type="date"]):not([type="file"])';
  function enhanceDialog(dlg) {
    if (dlg.dataset.enhanced) return;
    dlg.dataset.enhanced = "1";
    let downOnBackdrop = false;
    dlg.addEventListener("pointerdown", e => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener("click", e => {
      if (e.target.closest("[data-close]")) dlg.close();
      else if (e.target === dlg && downOnBackdrop) dlg.close();   // a backdrop tap that also started on the backdrop
    });
    // a drag that starts on the backdrop never scrolls the page behind the sheet
    dlg.addEventListener("touchmove", e => { if (e.target === dlg) e.preventDefault(); }, { passive: false });
    // while a text field has focus on touch, a Save button appears in the sticky header (the iOS keyboard hides the footer)
    dlg.addEventListener("focusin", e => { if (e.target.matches(KB_SEL)) dlg.classList.add("kb-open"); });
    dlg.addEventListener("focusout", () => setTimeout(() => {
      const a = document.activeElement;
      if (!a || !dlg.contains(a) || !a.matches(KB_SEL)) dlg.classList.remove("kb-open");
    }, 150));
    dlg.addEventListener("close", () => dlg.classList.remove("kb-open"));
  }
  $$("dialog").forEach(enhanceDialog);
  $("#typeFilter").addEventListener("click", e => {
    const b = e.target.closest("button[data-f]"); if (!b) return;
    S.filter = b.dataset.f;
    if (S.filter !== "all" && S.filter !== "expense") S.cat = null;
    render();
  });
  let qTimer = null;
  $("#search").addEventListener("input", e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { S.q = e.target.value; renderLedger(derive()); }, 120);
  });
  $("#search").addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault(); clearTimeout(qTimer);
    S.q = e.target.value; renderLedger(derive());
    e.target.blur();   // the keyboard's «Найти» key dismisses the iPhone keyboard
  });
  $("#catChipSlot").addEventListener("click", e => { if (e.target.closest("#clearCat")) { S.cat = null; render(); } });
  $("#notice").addEventListener("click", e => { if (e.target.closest("#clearEx")) clearExamples(); });
  // goal and category buttons anywhere (side card, goals view, sheets)
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-goal-add],[data-goal-edit],[data-do]");
    if (!el || el.disabled) return;
    if (el.dataset.goalAdd !== undefined) { openTx(null, { type: "saving", goalId: el.dataset.goalAdd || undefined }); return; }
    if (el.dataset.goalEdit) { openGoal(el.dataset.goalEdit); return; }
    switch (el.dataset.do) {
      case "goal-new": if (txDlg.open) txDlg.close(); openGoal(null); break;
      case "goals-view": setView("goals"); break;
      case "saving": openTx(null, { type: "saving" }); break;
      case "cat-new": openCatEditor(null, el.dataset.type, true); break;
      case "categories": openCategories(); break;
    }
  });
  $("#catsBtn").addEventListener("click", openCategories);

  /* ── Views: Бюджет · Цели · Обучение ─────────── */
  const VIEWS = ["budget", "goals", "learn"];
  let learnMounted = false;
  function setView(v, opts = {}) {
    if (!VIEWS.includes(v)) v = "budget";
    S.view = v;
    $("#viewBudget").hidden = v !== "budget";
    $("#viewGoals").hidden = v !== "goals";
    $("#viewLearn").hidden = v !== "learn";
    $$("#viewTabs [role=tab]").forEach(b => { const on = b.dataset.view === v; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
    document.documentElement.dataset.view = v;
    if (v === "learn" && !learnMounted) {
      learnMounted = true;
      const el = $("#viewLearn");
      if (window.BudgetLearn && typeof window.BudgetLearn.mount === "function") {
        try { window.BudgetLearn.mount(el, window.BudgetApp); }
        catch (e) { console.error(e); el.innerHTML = `<div class="card empty"><h3>Раздел обучения не открылся</h3><p>Обновите страницу.</p></div>`; }
      } else el.innerHTML = `<div class="card empty"><h3>Раздел обучения не загрузился</h3><p>Обновите страницу.</p></div>`;
    }
    hideTip();
    if (!opts.keepScroll) window.scrollTo(0, 0);
    if (!opts.keepHash) {
      try { history.replaceState(null, "", v === "budget" ? location.pathname + location.search : "#" + v); } catch (e) { /* sandboxed frame */ }
    }
  }
  $("#viewTabs").addEventListener("click", e => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });
  $("#viewTabs").addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabs = $$("#viewTabs [role=tab]"), i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const j = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[j].focus(); setView(tabs[j].dataset.view, { keepScroll: true });
  });

  $("#ledgerBody").addEventListener("click", e => {
    const act = e.target.closest("[data-act]");
    const row = e.target.closest(".tx");
    if (act && !row) {
      const a = act.dataset.act;
      if (a === "add") openTx();
      else if (a === "start") openStart();
      else if (a === "reset") { S.filter = "all"; S.cat = null; S.q = ""; $("#search").value = ""; render(); }
      return;
    }
    if (!row || S.readOnly) return;
    const t = S.tx.find(x => x.id === row.dataset.id);
    if (!t) return;
    if (act && act.dataset.act === "del") { e.stopPropagation(); deleteTx(t); return; }
    openTx(t);
  });
  $("#ledgerBody").addEventListener("keydown", e => {
    const row = e.target.closest(".tx");
    if (!row || e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const t = S.tx.find(x => x.id === row.dataset.id);
      if (t && !S.readOnly) openTx(t);
    }
  });

  const catList = $("#catList");
  catList.addEventListener("click", e => {
    const row = e.target.closest(".cat-row"); if (!row) return;
    S.cat = S.cat === row.dataset.cat ? null : row.dataset.cat;
    if (S.cat && S.filter !== "all" && S.filter !== "expense") S.filter = "all";
    hideTip();
    render();
    if (S.cat && matchMedia("(max-width: 719.98px), (max-height: 500px)").matches) $(".ledger").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  });
  catList.addEventListener("pointermove", e => {
    const row = e.target.closest(".cat-row");
    if (!row || e.pointerType === "touch") { hideTip(); return; }
    showTip(row.dataset.tip, e.clientX, e.clientY);
  });
  catList.addEventListener("pointerleave", hideTip);
  catList.addEventListener("focusin", e => {
    const row = e.target.closest(".cat-row"); if (!row || !row.matches(":focus-visible")) return;
    const r = row.getBoundingClientRect();
    showTip(row.dataset.tip, r.left + 40, r.bottom - 6);
  });
  catList.addEventListener("focusout", hideTip);

  const sparkSvg = $("#sparkSvg");
  let sparkT = null;
  const sparkOn = e => { clearTimeout(sparkT); sparkHover(e); };
  sparkSvg.addEventListener("pointermove", sparkOn);
  sparkSvg.addEventListener("pointerdown", sparkOn);
  sparkSvg.addEventListener("pointerleave", e => {
    clearTimeout(sparkT);
    // a finger lift fires pointerleave at once: keep the value readable for a moment
    if (e.pointerType === "mouse") sparkLeave(); else sparkT = setTimeout(sparkLeave, 1500);
  });
  sparkSvg.addEventListener("pointercancel", sparkLeave);
  addEventListener("scroll", hideTip, { passive: true });

  /* ── iOS / iPadOS adaptation ───────────────── */
  document.addEventListener("touchstart", () => {}, { passive: true });   // lets iOS apply :active press styles
  // iPads with a trackpad report hover:hover but are often tapped with a finger: track the last pointer type
  const rootEl = document.documentElement;
  const setInput = v => { if (rootEl.dataset.input !== v) rootEl.dataset.input = v; };
  setInput(matchMedia("(pointer: coarse)").matches ? "touch" : "mouse");
  addEventListener("pointerdown", e => setInput(e.pointerType === "mouse" ? "mouse" : "touch"), { capture: true, passive: true });
  addEventListener("pointermove", e => { if (e.pointerType === "mouse") setInput("mouse"); }, { passive: true });
  // the floating add button tucks away while scrolling down so it does not cover ledger amounts
  const fabEl = $("#fab"); let fabY = scrollY, fabTick = false;
  addEventListener("scroll", () => {
    if (fabTick) return; fabTick = true;
    requestAnimationFrame(() => {
      const y = scrollY, dy = y - fabY;
      if (Math.abs(dy) > 6) { fabEl.classList.toggle("is-tucked", dy > 0 && y > 240); fabY = y; }
      if (innerHeight + y >= document.documentElement.scrollHeight - 40) fabEl.classList.remove("is-tucked");
      fabTick = false;
    });
  }, { passive: true });

  /* ── Engraved guilloche on the balance card ── */
  function drawGuilloche() {
    const c = $("#guilloche"), host = $("#balanceCard");
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = getComputedStyle(host).getPropertyValue("--card-ink").trim() || "#ecf6f2";
    g.lineWidth = 0.7;
    // wave band across the lower half
    g.globalAlpha = 0.075;
    for (let k = 0; k < 16; k++) {
      g.beginPath();
      for (let x = 0; x <= w + 4; x += 4) {
        const t = x / w * Math.PI * 2;
        const y = h * 0.66 + Math.sin(t * 1.6 + k * 0.28) * h * 0.11 + Math.sin(t * 4.3 - k * 0.19) * h * 0.035 + (k - 8) * 2.4;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    // rosette in the top-right corner
    const R = Math.min(h * 0.62, w * 0.36), cx = w - R * 0.42, cy = R * 0.3;
    g.globalAlpha = 0.11;
    for (let j = 0; j < 22; j++) {
      g.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.012) {
        const r = R * (0.62 + 0.26 * Math.sin(9 * a + j * Math.PI / 11) + 0.06 * Math.sin(3 * a));
        const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
        a ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.stroke();
    }
  }
  const ro = new ResizeObserver(() => { drawGuilloche(); drawSpark(); });
  ro.observe($("#balanceCard"));

  /* ── Store ─────────────────────────────────── */
  function applySnapshot(snap) {
    lastSnap = snap;
    S.status = snap.status;
    S.tx = (snap.tx || []).filter(validTx);
    S.settings = snap.settings || null;
    S.readOnly = S.readOnly || !!snap.readOnly;
    S.notice = snap.notice || "";
    S.sync = snap.sync || null;
    render();
  }

  window.BudgetApp = {
    store, icon, hydrateIcons, esc, money, toast, enhanceDialog,
    actions: {
      setView: v => setView(v),
      openTx: (preset = {}) => openTx(null, preset || {}),
      openLimits: () => openLimits(),
      openGoal: id => openGoal(id || null),
      openCategories: () => openCategories(),
      openStart: () => openStart(),
    },
    onSnapshot(cb) { snapListeners.add(cb); if (lastSnap) cb(lastSnap); return () => snapListeners.delete(cb); },
    features: FEATURES,
  };

  hydrateIcons();
  const startView = (location.hash || "").replace("#", "");
  setView(VIEWS.includes(startView) ? startView : "budget", { keepHash: true, keepScroll: true });
  render();
  drawGuilloche();
  store.init(applySnapshot);
})();
