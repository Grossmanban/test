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
    transfer: [{ id: "transfer", name: "Перевод", icon: "ArrowLeftRight" }],
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
  // accounts (v3): where money lives
  const ACCOUNT_KINDS = {
    bank: { name: "Банковский счёт", short: "Банк", icon: "Landmark" },
    cash: { name: "Наличные", short: "Наличные", icon: "Banknote" },
    wallet: { name: "Кошелёк: Bit, PayBox…", short: "Кошелёк", icon: "Smartphone" },
    card: { name: "Кредитная карта", short: "Карта", icon: "CreditCard" },
  };
  const ACCOUNT_ICONS = ["Landmark", "Building2", "Banknote", "Coins", "Wallet", "WalletCards", "CreditCard", "Smartphone",
    "PiggyBank", "HandCoins", "Briefcase", "Vault", "Gem", "ShieldCheck", "Heart", "Star"];
  // names the icon pickers read to VoiceOver
  const ICON_RU = {
    ShoppingBag: "Пакет с покупками", Store: "Магазин", Utensils: "Вилка и нож", Pizza: "Пицца", Coffee: "Кофе",
    Beer: "Пиво", Wine: "Вино", Cake: "Торт", Apple: "Яблоко", Milk: "Молоко", House: "Дом", Building2: "Здание",
    Sofa: "Диван", Lamp: "Лампа", Hammer: "Молоток", Wrench: "Гаечный ключ", Plug: "Вилка розетки", Droplets: "Вода",
    Flame: "Огонь", Zap: "Молния", Car: "Машина", Fuel: "Заправка", Bus: "Автобус", Train: "Поезд", Bike: "Велосипед",
    CarTaxiFront: "Такси", Plane: "Самолёт", Luggage: "Чемодан", Hotel: "Отель", Ship: "Корабль", HeartPulse: "Пульс",
    Pill: "Таблетка", Stethoscope: "Стетоскоп", Syringe: "Шприц", Glasses: "Очки", Baby: "Малыш", School: "Школа",
    GraduationCap: "Шапка выпускника", BookOpen: "Книга", Puzzle: "Пазл", PawPrint: "Лапа", Dog: "Собака",
    Cat: "Кошка", Dumbbell: "Гантель", Trophy: "Кубок", Music: "Музыка", Gamepad2: "Геймпад", Film: "Кино",
    Ticket: "Билет", Camera: "Фотоаппарат", Palette: "Палитра", Scissors: "Ножницы", Sparkles: "Блёстки",
    Shirt: "Футболка", Watch: "Часы", Gem: "Бриллиант", Gift: "Подарок", HandHeart: "Рука с сердцем", Church: "Храм",
    Flower2: "Цветок", Smartphone: "Телефон", Laptop: "Ноутбук", Tv: "Телевизор", Wifi: "Wi-Fi",
    Headphones: "Наушники", CreditCard: "Карта", Landmark: "Банк", Coins: "Монеты", Banknote: "Купюры",
    HandCoins: "Деньги в руке", Briefcase: "Портфель", Calculator: "Калькулятор", ReceiptText: "Чек",
    Percent: "Процент", Tag: "Ярлык", Package: "Посылка", Truck: "Грузовик", Leaf: "Лист", Sun: "Солнце",
    Star: "Звезда", Target: "Мишень", ShieldCheck: "Щит", Umbrella: "Зонт", TreePalm: "Пальма", Heart: "Сердце",
    PiggyBank: "Копилка", Rocket: "Ракета", Wallet: "Кошелёк", WalletCards: "Карты", Vault: "Сейф",
  };

  // a category record by id, built-in or the user's own (archived ones still resolve for old operations)
  function findCat(id) {
    if (CAT[id]) return CAT[id];
    const c = (S.settings ? settings().categories : []).find(x => x.id === id);
    return c ? { id: c.id, name: c.name, icon: c.icon, type: c.type, custom: true, archived: !!c.archived } : null;
  }
  function catOf(t) {
    const c = findCat(t.category);
    if (c && c.type === t.type) return c;
    return t.type === "income" ? CAT.other_in : t.type === "saving" ? CAT.savings : t.type === "transfer" ? CAT.transfer : CAT.other;
  }
  // categories offered in pickers for a type: built-ins and active custom ones
  function catsFor(type) {
    if (type === "saving" || type === "transfer") return CATS[type];
    const custom = settings().categories.filter(c => c.type === type && !c.archived)
      .map(c => ({ id: c.id, name: c.name, icon: c.icon, type: c.type, custom: true }));
    const list = CATS[type];
    return [...list.slice(0, -1), ...custom, list[list.length - 1]];   // custom ones before «Прочее»
  }
  const KIND_BG = { income: "bg-income", expense: "bg-expense", saving: "bg-saving", transfer: "bg-transfer" };

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
  const DEFAULTS = { startBalance: 0, goals: [], limits: {}, categories: [], accounts: [] };
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
    const out = { startBalance: 0, goals: [], limits: {}, categories: [], accounts: [], defaultAccount: "a_main" };
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
    // accounts: with none stored the app behaves as one bank account holding the start balance (v2 data)
    if (Array.isArray(raw.accounts)) {
      const ids = new Set();
      for (const a of raw.accounts) {
        if (!a || typeof a !== "object" || typeof a.id !== "string" || !/^a_[a-z0-9]{2,20}$/.test(a.id) || ids.has(a.id)) continue;
        if (!ACCOUNT_KINDS[a.kind] || typeof a.name !== "string" || !a.name.trim()) continue;
        ids.add(a.id);
        const acc = {
          id: a.id, kind: a.kind, name: a.name.slice(0, 40),
          icon: ACCOUNT_ICONS.includes(a.icon) ? a.icon : ACCOUNT_KINDS[a.kind].icon,
          opening: typeof a.opening === "number" && Number.isFinite(a.opening) ? a.opening : 0,
          createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
        };
        if (a.kind === "card") {
          acc.billingDay = Number.isInteger(a.billingDay) && a.billingDay >= 1 && a.billingDay <= 28 ? a.billingDay : 10;
          if (typeof a.payFrom === "string") acc.payFrom = a.payFrom;
          if (typeof a.creditLimit === "number" && a.creditLimit > 0) acc.creditLimit = a.creditLimit;
          if (acc.opening < 0) acc.opening = -acc.opening;
        }
        if (a.archived) acc.archived = true;
        out.accounts.push(acc);
        if (out.accounts.length >= 20) break;
      }
      for (const a of out.accounts) if (a.kind === "card" && a.payFrom && !out.accounts.some(b => b.id === a.payFrom && b.kind !== "card")) delete a.payFrom;
    }
    if (!out.accounts.length) out.accounts = [{ id: "a_main", kind: "bank", name: "Основной счёт", icon: "Landmark", opening: out.startBalance, createdAt: 0, virtual: true }];
    out.defaultAccount = typeof raw.defaultAccount === "string" && out.accounts.some(a => a.id === raw.defaultAccount && !a.archived)
      ? raw.defaultAccount : (out.accounts.find(a => !a.archived && a.kind !== "card") || out.accounts[0]).id;
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
    return t && ["income", "expense", "saving", "transfer"].includes(t.type)
      && typeof t.amount === "number" && Number.isFinite(t.amount) && t.amount > 0
      && typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date);
  }
  const sgn = t => t.type === "income" ? 1 : t.type === "transfer" ? 0 : -1;
  // the account an operation touches (its source for a transfer). Operations written before the first real account
  // stay on the implicit "a_main" while it exists, so changing the main account only affects new operations.
  function accountIdOf(t) {
    const st = settings();
    if (t.account && st.accounts.some(a => a.id === t.account)) return t.account;
    return st.accounts.some(a => a.id === "a_main") ? "a_main" : st.defaultAccount;
  }
  const findAccount = id => settings().accounts.find(a => a.id === id) || null;
  const activeAccounts = () => settings().accounts.filter(a => !a.archived);
  // net opening across accounts: money minus card debts at the start of tracking
  function netOpening() {
    return settings().accounts.reduce((sum, a) => sum + (a.kind === "card" ? -a.opening : a.opening), 0);
  }
  // balance of every account at the end of cutoffIso (card balances are negative while money is owed)
  function accountBalances(cutoffIso) {
    const bal = new Map(settings().accounts.map(a => [a.id, a.kind === "card" ? -a.opening : a.opening]));
    for (const t of S.tx) {
      if (t.date > cutoffIso) continue;
      const from = accountIdOf(t);
      if (t.type === "transfer") {
        if (!t.toAccount || !bal.has(t.toAccount) || t.toAccount === from) continue;
        bal.set(from, bal.get(from) - t.amount);
        bal.set(t.toAccount, bal.get(t.toAccount) + t.amount);
      } else bal.set(from, bal.get(from) + sgn(t) * t.amount);
    }
    for (const [k, v] of bal) bal.set(k, r2(v));
    return bal;
  }
  function sortAsc(list) {
    return [...list].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1
      : ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id < b.id ? -1 : 1));
  }
  function derive() {
    const sorted = sortAsc(S.tx);
    let bal = netOpening();
    const after = new Map();
    for (const t of sorted) { bal += sgn(t) * t.amount; after.set(t.id, r2(bal)); }
    return { sorted, after };
  }
  function balanceAt(sorted, cutoffIso) {
    let b = netOpening();
    for (const t of sorted) { if (t.date > cutoffIso) break; b += sgn(t) * t.amount; }
    return r2(b);
  }
  function monthStats(ym, upToDay = 31) {
    const r = { inc: 0, exp: 0, sav: 0, n: 0, byCat: {} };
    for (const t of S.tx) {
      if (ymOf(t.date) !== ym || dParts(t.date)[2] > upToDay || t.type === "transfer") continue;
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
    // the change compares the same days of both months (the current month may already hold planned split parts)
    const prev = monthStats(prevYm, isCur ? dayCut : 31), cur = isCur ? monthStats(ym, dayCut) : st;
    const cmp = isCur ? `к${NB}1–\u2060${Math.min(dayCut, daysIn(prevYm))}${NB}${M_GEN[pm - 1]}` : `к${NB}${M_DAT[pm - 1]}`;
    const v = x => ready ? x : "—";
    const rate = st.inc > 0 ? Math.round(st.sav / st.inc * 100) : null;
    el.innerHTML = `
      <div class="kpi">
        <div class="kpi-label"><span class="kpi-dot bg-income">${icon("ArrowDownLeft")}</span>Доходы</div>
        <div class="kpi-value">${v(money(st.inc))}</div>
        <div class="kpi-sub">${ready ? deltaHtml(cur.inc, prev.inc, true, cmp) : "&nbsp;"}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label"><span class="kpi-dot bg-expense">${icon("ArrowUpRight")}</span>Расходы</div>
        <div class="kpi-value">${v(money(st.exp))}</div>
        <div class="kpi-sub">${ready ? deltaHtml(cur.exp, prev.exp, false, cmp) : "&nbsp;"}</div>
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
  /* ── Accounts, cards and transfers ──────────── */
  const dayBefore = iso => { const [y, m, d] = dParts(iso); return isoOf(new Date(y, m - 1, d - 1)); };
  function addMonths(iso, k) {
    const [y, m, d] = dParts(iso);
    const first = new Date(y, m - 1 + k, 1), last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return isoOf(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
  }
  function billingDate(card, ym) { return `${ym}-${pad(Math.min(card.billingDay, daysIn(ym)))}`; }
  // the latest billing date on or before today, and the next one after today
  function cardDates(card) {
    const here = billingDate(card, CUR_YM);
    return {
      last: here <= TODAY ? here : billingDate(card, shiftYm(CUR_YM, -1)),
      next: here > TODAY ? here : billingDate(card, shiftYm(CUR_YM, 1)),
    };
  }
  // what the bank should pay on a billing date: the card debt the day before it. A payment recorded on or after the
  // billing date settles that bill (the issuer's cut-off may differ); whatever it did not cover stays as card debt
  // and comes back with the next bill.
  function cardDue(card, billIso) {
    const owed = -(accountBalances(dayBefore(billIso)).get(card.id) || 0);
    for (const t of S.tx) if (t.type === "transfer" && t.toAccount === card.id && t.date >= billIso && t.date <= TODAY) return 0;
    return r2(Math.max(0, owed));
  }
  // future installments of split purchases still to come on a card
  function cardFuture(card) {
    let sum = 0, n = 0;
    for (const t of S.tx) if (t.type === "expense" && t.date > TODAY && accountIdOf(t) === card.id) { sum += t.amount; n++; }
    return { sum: r2(sum), n };
  }
  // cards whose last bill has not been paid yet (shown as a prompt to record the bank → card transfer)
  function cardsDue() {
    const out = [];
    for (const card of settings().accounts.filter(a => a.kind === "card")) {
      const { last } = cardDates(card);
      if (card.createdAt && last < isoOf(new Date(card.createdAt))) continue;
      const due = cardDue(card, last);
      if (due > 0) out.push({ card, date: last, due });
    }
    return out;
  }
  function accountMeta(a, bal) {
    if (a.kind !== "card") return ACCOUNT_KINDS[a.kind].short;
    const { next } = cardDates(a);
    const [, nm, nd] = dParts(next);
    const fut = cardFuture(a);
    return `спишется ${nd}${NB}${M_GEN[nm - 1]}${fut.n ? ` · сплит ещё ${money(fut.sum)}` : ""}${a.creditLimit ? ` · лимит ${money(a.creditLimit)}` : ""}`;
  }
  function renderAccounts() {
    const el = $("#accCard");
    if (!el) return;
    if (S.status !== "ready") { el.innerHTML = `<div class="skeleton"></div>`; return; }
    const st = settings(), bal = accountBalances(TODAY);
    // hidden accounts still count while they hold money (or a card debt), so the rows add up to the totals
    const accs = st.accounts.filter(a => !a.archived || Math.abs(bal.get(a.id)) > 0.004);
    // a card in credit (a refund after the bill) is money; only what cards owe is debt
    const money0 = st.accounts.reduce((sum, a) => sum + (a.kind !== "card" ? bal.get(a.id) : Math.max(0, bal.get(a.id))), 0);
    const debt = st.accounts.filter(a => a.kind === "card").reduce((sum, a) => sum + Math.max(0, -bal.get(a.id)), 0);
    const canEdit = !S.readOnly;
    const single = accs.length === 1 && accs[0].virtual;
    const dues = cardsDue();
    el.innerHTML = `
      <div class="card-head">
        <div><p class="eyebrow">Счета на сегодня</p><h2 id="accTitle">Деньги ${money(money0)}</h2>
          ${debt > 0.004 ? `<p class="meta">Долг по картам ${money(debt)}</p>` : ""}</div>
        <div class="head-tools">
          ${single ? "" : `<button class="icon-btn" data-do="transfer" aria-label="Перевод между счетами" title="Перевод между счетами" ${canEdit ? "" : "disabled"}>${icon("ArrowLeftRight")}</button>`}
          <button class="btn btn-ghost btn-sm" data-do="accounts" ${canEdit ? "" : "disabled"}>${icon("Settings2")}Счета</button>
        </div>
      </div>
      ${dues.map(d => {
        const [, m, dd] = dParts(d.date);
        return `<div class="status is-warn acc-due">${icon("CalendarClock")}<span>Списание по карте <b>«${esc(d.card.name)}»</b> ${dd}${NB}${M_GEN[m - 1]}: <b>${money(d.due)}</b></span>
          <button class="btn btn-sm btn-primary" data-pay-card="${esc(d.card.id)}" aria-label="Провести списание по карте «${esc(d.card.name)}»: ${money(d.due)}" ${canEdit ? "" : "disabled"}>Провести</button></div>`;
      }).join("")}
      <div class="acc-list">
        ${accs.map(a => {
          const b = bal.get(a.id);
          const neg = a.kind === "card" ? b < -0.004 : b < -0.004;
          return `<div class="acc-row">
            <span class="tx-ic ${a.kind === "card" ? "bg-card" : "bg-acc"}">${icon(a.icon)}</span>
            <span class="acc-name"><b>${esc(a.name)}</b><small>${a.archived ? "скрыт · " : ""}${esc(accountMeta(a, b))}</small></span>
            <span class="acc-bal num ${neg ? (a.kind === "card" ? "t-ink2" : "t-bad") : ""}">${a.kind === "card" ? (b < -0.004 ? `долг ${money(-b)}` : money(b)) : money(b)}</span>
          </div>`;
        }).join("")}
      </div>
      ${single ? `<p class="hint acc-hint">Заведите свои счета: банк, наличные, Bit или PayBox, кредитки с днём списания. Тогда переводы и сплит будут учитываться правильно.</p>` : ""}`;
  }

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
      const months = mLeft > 0 ? mLeft : g.deadline >= TODAY ? 1 : 0;   // a deadline later this month: this month
      if (left > 0 && months > 0) {
        const leftAtStart = r2(Math.max(0, g.target - (saved - thisMonth)));
        perMonth = Math.ceil(leftAtStart / months / 10) * 10;     // rounded up to 10 ₪
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
      deadlineHtml = `${dd}${NB}${M_GEN[dm - 1]} ${dy}<small>${st.mLeft > 0 ? `осталось ${st.mLeft}${NB}мес.` : g.deadline >= TODAY ? "в этом месяце" : "срок наступил"}</small>`;
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
      ${(() => {
        if (st.done) return "";
        const pace = goalPace(g, goals);
        if (!(pace > 0)) return "";
        const when = reachMonth(st.left, pace, st.thisMonth);
        return `<p class="goal-pace">${icon("TrendingUp")}В текущем темпе (≈${NB}${money(pace)} в месяц) накопите к ${monthLabelDat(when)}.</p>`;
      })()}
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
      ${(() => { const P = savingsPlan(); return P.need > 0 ? `<p class="hint goal-more">${icon("Lightbulb")}<span>Чтобы успеть к срокам, откладывайте ≈${NB}${money(P.need)} в месяц${P.cf && P.need > P.spare ? `: это больше, чем остаётся свободным. <button type="button" class="link-btn" data-do="goals-view">Что делать</button>` : "."}</span></p>` : ""; })()}
      ${goals.length > shown.length ? `<p class="hint goal-more">И ещё ${goals.length - shown.length} ${plural(goals.length - shown.length, ["цель", "цели", "целей"])} на вкладке «Цели».</p>` : ""}
      <button class="btn btn-gold" data-do="saving" ${canEdit ? "" : "disabled"}>${icon("PiggyBank")}Отложить в копилку</button>`;
  }
  /* ── Savings recommendations ─────────────────── */
  const DISCRETIONARY = new Set(["cafe", "fun", "clothes", "beauty", "travel", "gifts", "sport", "other"]);
  // averages over the last (up to) three complete months that have any income
  function cashflow() {
    // tracking starts with the first operation; that month is usually partial, so it counts only with income in it
    const firstYm = ymOf(S.tx.reduce((m, t) => (t.date < m ? t.date : m), TODAY));
    const months = [];
    for (let k = 1; k <= 3; k++) {
      const ym = shiftYm(CUR_YM, -k), st = monthStats(ym);
      if (ym > firstYm || (ym === firstYm && st.inc > 0)) months.push({ ym, st });
    }
    if (!months.length || !months.some(m => m.st.inc > 0)) return null;
    const avg = f => r2(months.reduce((sum, m) => sum + f(m.st), 0) / months.length);
    const byCat = {};
    for (const m of months) for (const [c, v] of Object.entries(m.st.byCat)) byCat[c] = (byCat[c] || 0) + v.sum / months.length;
    return { n: months.length, months: months.map(m => m.ym), inc: avg(s => s.inc), exp: avg(s => s.exp), sav: avg(s => s.sav), byCat };
  }
  // average monthly saving into one goal over the same months (the current pace)
  function goalPace(g, goals) {
    const cf = cashflow();
    return cf ? r2(cf.months.reduce((sum, ym) => sum + goalSavedInMonth(g, ym, goals), 0) / cf.n) : 0;
  }
  function monthLabel(ym) { const [y, m] = ymParts(ym); return `${M_NOM[m - 1].toLowerCase()} ${y}`; }
  function monthLabelDat(ym) { const [y, m] = ymParts(ym); return `${M_DAT[m - 1]} ${y}`; }   // «к февралю 2027»
  // the month a goal is reached when `perMonth` goes in every month from this one on (this month only tops up
  // what was already put aside in it)
  function reachMonth(left, perMonth, thisMonth = 0) {
    if (!(perMonth > 0)) return null;
    const extra = Math.max(0, perMonth - thisMonth);
    return left <= extra ? CUR_YM : shiftYm(CUR_YM, Math.ceil((left - extra) / perMonth));
  }
  function savingsPlan() {
    const goals = settings().goals, cf = cashflow();
    const open = goals.map(g => ({ g, st: goalStats(g, goals) })).filter(x => !x.st.done);
    const dated = open.filter(x => x.st.perMonth > 0), free = open.filter(x => !x.g.deadline);
    const need = r2(dated.reduce((sum, x) => sum + x.st.perMonth, 0));
    const hasSafety = goals.some(g => g.icon === "ShieldCheck" || g.icon === "Umbrella" || /подушк|резерв|запас/i.test(g.name));
    return { goals, cf, open, dated, free, need, hasSafety, spare: cf ? r2(cf.inc - cf.exp) : null };
  }
  function planCardHtml() {
    const P = savingsPlan(), cf = P.cf;
    const canEdit = S.status === "ready" && !S.readOnly;
    const rows = [];
    if (!cf) {
      rows.push(`<p class="plan-lead">Добавьте доходы и расходы хотя бы за один полный месяц, и я посчитаю, сколько реально откладывать без ущерба для бюджета.</p>`);
      if (P.need > 0) rows.push(`<p class="plan-need">Чтобы успеть к срокам ваших целей, нужно откладывать <b>${money(P.need)}</b> в месяц.</p>`);
    } else {
      const pct = cf.inc > 0 ? Math.round(P.need / cf.inc * 100) : 0;
      rows.push(`<dl class="plan-stats">
          <div><dt>Свободно в среднем</dt><dd>${money(Math.max(0, P.spare))}<small>доход ${money(cf.inc)} − расходы ${money(cf.exp)}</small></dd></div>
          <div><dt>Нужно для целей в срок</dt><dd>${P.need > 0 ? money(P.need) : "—"}<small>${P.need > 0 ? `${pct}% дохода` : (!P.goals.length ? "целей пока нет" : P.open.some(x => x.st.overdue) ? "срок прошёл: обновите дату" : !P.open.length ? "все цели достигнуты" : "у целей нет срока")}</small></dd></div>
          <div><dt>Ориентир 50/30/20</dt><dd>${money(Math.round(cf.inc * 0.2 / 10) * 10)}<small>20% дохода в месяц</small></dd></div>
        </dl>`);
      if (P.spare <= 0) {
        rows.push(`<div class="status is-warn">${icon("TriangleAlert")}<span>Расходы съедают весь доход${cf.n > 1 ? ` (в среднем за ${cf.n} мес.)` : ""}. Сначала найдите, где сократить траты, иначе откладывать не из чего.</span></div>`);
      } else if (P.need > P.spare) {
        const gap = r2(P.need - P.spare);
        const k = P.spare / P.need;
        rows.push(`<div class="status is-warn">${icon("TriangleAlert")}<span>На все сроки не хватает <b>${money(gap)}</b> в месяц. Варианты:</span></div>`);
        const moves = P.dated.map(x => {
          const per = Math.floor(x.st.perMonth * k / 10) * 10;
          const when = reachMonth(x.st.left, per, x.st.thisMonth);
          return when ? `<li>«${esc(x.g.name)}»: откладывать ${money(per)} в месяц и перенести срок на <b>${monthLabel(when)}</b></li>` : "";
        }).join("");
        const cuts = Object.entries(cf.byCat)
          .filter(([c]) => DISCRETIONARY.has(c) || (findCat(c) && findCat(c).custom))
          .sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([c, v]) => `<li>Сократить «${esc((findCat(c) || CAT.other).name)}»: сейчас ≈ ${money(Math.round(v / 10) * 10)} в месяц</li>`).join("");
        rows.push(`<ul class="plan-list">${moves}${cuts}</ul>`);
      } else if (P.need > 0) {
        rows.push(`<div class="status is-good">${icon("CircleCheck")}<span>План реален: откладывайте <b>${money(P.need)}</b> в месяц${P.spare - P.need > 0 ? `, и ещё останется ≈ ${money(r2(P.spare - P.need))}` : ""}.</span></div>`);
      }
      // goals without a deadline share half of what is left after the dated ones
      const rest = Math.max(0, r2(P.spare - P.need));
      if (P.free.length && rest > 0) {
        const per = Math.floor(rest / 2 / P.free.length / 10) * 10;
        if (per > 0) rows.push(`<ul class="plan-list">${P.free.map(x => {
          const when = reachMonth(x.st.left, per, x.st.thisMonth);
          return `<li>«${esc(x.g.name)}» без срока: при ${money(per)} в месяц накопите к <b>${monthLabelDat(when)}</b></li>`;
        }).join("")}</ul>`);
      }
      if (!P.hasSafety) {
        const lo = Math.round(cf.exp * 3 / 100) * 100, hi = Math.round(cf.exp * 6 / 100) * 100;
        rows.push(`<div class="plan-safety">${icon("ShieldCheck")}<span><b>Подушка безопасности</b> обычно равна расходам за 3–6 месяцев: для вас это ${money(lo)}–${money(hi)}.</span>
          <button class="btn btn-sm btn-ghost" data-do="goal-safety" data-target="${lo}" ${canEdit ? "" : "disabled"}>Поставить цель</button></div>`);
      }
    }
    return `<section class="card plan-card" aria-labelledby="planTitle">
        <div class="card-head"><div><p class="eyebrow">Рекомендации</p><h2 id="planTitle">Сколько откладывать</h2></div></div>
        ${rows.join("")}
      </section>`;
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
    el.innerHTML = head + planCardHtml() + (goals.length
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
    const amtCls = t.type === "income" ? "t-good" : t.type === "saving" ? "t-gold" : t.type === "transfer" ? "t-ink2" : "";
    const sign = t.type === "income" ? "+" : t.type === "transfer" ? "" : MINUS;
    const goal = t.type === "saving" ? goalOfTx(t) : null;
    const many = activeAccounts().length > 1 || settings().accounts.length > 1;
    const acc = findAccount(accountIdOf(t)), to = t.toAccount ? findAccount(t.toAccount) : null;
    let metaName = t.type === "saving" ? (goal ? `Копилка · ${goal.name}` : "Копилка") : c.name;
    if (t.type === "transfer") metaName = `${acc ? acc.name : "?"} → ${to ? to.name : "?"}`;
    else if (many && acc) metaName += ` · ${acc.name}`;
    if (t.plan) metaName += ` · сплит ${t.plan.n}/${t.plan.of}`;
    const label = `${title}, ${sign}${money(t.amount)}, ${metaName}${t.example ? ", пример" : ""}, остаток ${money(after)}`;
    return `<li class="tx" ${TOUCH_UI ? 'role="button"' : ""} tabindex="0" data-id="${esc(t.id)}" aria-label="${esc(label)}">
      <span class="tx-ic ${KIND_BG[t.type]}">${icon(c.icon)}</span>
      <div class="tx-main"><div class="tx-title">${esc(title)}</div>
        <div class="tx-meta"><span style="overflow:hidden;text-overflow:ellipsis">${esc(metaName)}</span>${t.date > TODAY ? `<span class="ex-tag">запланировано</span>` : ""}${t.example ? `<span class="ex-tag">пример</span>` : ""}</div></div>
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
    renderAccounts();
    renderGoal();
    renderGoalsView();
    renderLedger(d);
    // open managers follow every change, including «Вернуть» and edits from another device
    const ad = document.getElementById("accsDlg"); if (ad && ad.open) renderAccountsManager();
    const cd = document.getElementById("catsDlg"); if (cd && cd.open) renderCatsManager();
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
    // an open sheet sits in the top layer above the page: the toast (and its «Вернуть») goes into the topmost one
    const host = [...document.querySelectorAll("dialog[open]")].pop() || document.body;
    if (el.parentNode !== host) host.appendChild(el);
    // inside a sheet the toast sits just above the sheet's buttons
    el.style.bottom = "";
    const foot = host !== document.body && host.querySelector(".dlg-foot");
    if (foot) requestAnimationFrame(() => { if (el.parentNode === host) el.style.bottom = `${innerHeight - Math.min(foot.getBoundingClientRect().top, host.getBoundingClientRect().bottom) + 8}px`; });
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
    const real = st.accounts.filter(a => !a.virtual);
    if (real.length) { doc.accounts = real.map(a => ({ ...a })); doc.defaultAccount = st.defaultAccount; }
    if (st.example) doc.example = { ...st.example };
    return doc;
  }
  // Starts from the stored document, so the fields and entries this save does not change go back exactly as they
  // came (values of a newer version, limits of categories this view hides); only a v1 `goal` becomes goals.
  function saveSettings(patch) {
    const raw = S.settings ? JSON.parse(JSON.stringify(S.settings)) : {};
    const next = { ...DEFAULTS, ...raw, ...patch };
    if (!Array.isArray(raw.goals) && !("goals" in patch)) next.goals = settingsDoc().goals;
    delete next.goal;
    if (Array.isArray(next.accounts) && next.accounts.length) {
      next.accounts = next.accounts.map(({ virtual, ...a }) => a);
      // v2 clients only know startBalance: keep it equal to the net opening of all accounts
      next.startBalance = r2(next.accounts.reduce((sum, a) => sum + (a.kind === "card" ? -(Number(a.opening) || 0) : Number(a.opening) || 0), 0));
    } else { delete next.accounts; delete next.defaultAccount; }
    const ex = raw.example && typeof raw.example === "object" ? { ...raw.example } : null;
    if (ex && ex.goal) { ex.goals = true; delete ex.goal; }
    if (ex) for (const k of Object.keys(patch)) delete ex[k];
    if (ex && "accounts" in patch) delete ex.startBalance;   // the openings now say what the start is
    if (ex && Object.keys(ex).length) next.example = ex; else delete next.example;
    return store.saveSettings(next);
  }
  // «Вернуть» puts back only the removed entry, at its old place in the current list, so whatever another device
  // added meanwhile stays
  function restoreEntry(list, prev, id) {
    const at = prev.findIndex(x => x.id === id);
    const cur = list.filter(x => x.id !== id && !x.virtual).map(x => ({ ...x }));
    cur.splice(Math.min(at, cur.length), 0, { ...prev[at] });
    return cur;
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
    if (type === "transfer") {
      field.hidden = true; hint.hidden = true;
      $("#catChips").innerHTML = `<input type="radio" name="category" value="transfer" checked hidden>`;
      return;
    }
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

  // account pickers: one account (the implicit default) hides them; transfers pick a source and a destination
  let accTouched = false;
  const CAT_ACC_KEY = "mh-cat-acc";
  function rememberedAccount(cat) {
    try { const m = JSON.parse(localStorage.getItem(CAT_ACC_KEY) || "{}"); return m[cat] || null; } catch (e) { return null; }
  }
  function rememberAccount(cat, acc) {
    try { const m = JSON.parse(localStorage.getItem(CAT_ACC_KEY) || "{}"); m[cat] = acc; localStorage.setItem(CAT_ACC_KEY, JSON.stringify(m)); } catch (e) { /* per-device convenience only */ }
  }
  const accChip = (name, a, sel) =>
    `<label class="chip-opt"><input type="radio" name="${name}" value="${esc(a.id)}" ${a.id === sel ? "checked" : ""}><span>${icon(a.icon)}${esc(a.name)}</span></label>`;
  function renderAccChips(type, sel, toSel) {
    // hidden accounts stay selectable for the operation being edited (and a preset destination such as a hidden card's bill)
    const keep = editing ? [accountIdOf(editing), editing.toAccount] : [toSel];
    const accs = settings().accounts.filter(a => !a.archived || keep.includes(a.id));
    const field = $("#accField"), toField = $("#toField");
    const single = accs.length < 2;
    if (type === "transfer") {
      field.hidden = false; toField.hidden = false;
      $("#accLegend").textContent = "Откуда";
      if (single) {
        $("#accChips").innerHTML = `<p class="hint">Чтобы переводить деньги, заведите второй счёт: наличные, Bit, PayBox или кредитку. <button type="button" class="link-btn" data-do="account-new">Добавить счёт</button></p>`;
        $("#toChips").innerHTML = "";
        toField.hidden = true;
        return;
      }
      // money usually moves out of the bank, cash or a wallet; a card is a source only when chosen explicitly
      const selAcc = accs.find(a => a.id === sel);
      const from = selAcc && (selAcc.kind !== "card" || accTouched) ? sel : settings().defaultAccount;
      const to = accs.some(a => a.id === toSel && a.id !== from) ? toSel : (accs.find(a => a.id !== from && a.kind === "cash") || accs.find(a => a.id !== from)).id;
      $("#accChips").innerHTML = accs.map(a => accChip("account", a, from)).join("");
      $("#toChips").innerHTML = accs.map(a => accChip("toAccount", a, to)).join("");
      return;
    }
    toField.hidden = true;
    $("#accLegend").textContent = type === "income" ? "Куда пришли деньги" : "Счёт";
    field.hidden = single;
    const s0 = accs.some(a => a.id === sel) ? sel : settings().defaultAccount;
    $("#accChips").innerHTML = accs.map(a => accChip("account", a, s0)).join("");
  }
  // installments («сплит», תשלומים): only for expenses paid by card
  function renderSplit() {
    const type = $('#txForm input[name="type"]:checked').value;
    const accEl = $('#txForm input[name="account"]:checked');
    const acc = accEl ? findAccount(accEl.value) : findAccount(settings().defaultAccount);
    const box = $("#splitField");
    const plan = editing && editing.plan;
    if (plan) {
      box.hidden = false; $("#splitToggle").hidden = true; $("#splitRow").hidden = true;
      const parts = S.tx.filter(t => t.plan && t.plan.id === plan.id).length;
      $("#planInfo").hidden = false;
      $("#planInfo").textContent = `Платёж ${plan.n} из ${plan.of} сплита. Изменения коснутся только этого платежа${parts > 1 ? "; удалить можно этот платёж или весь сплит" : ""}.`;
      return;
    }
    $("#planInfo").hidden = true;
    const show = type === "expense" && acc && acc.kind === "card";
    box.hidden = !show; $("#splitToggle").hidden = !show;
    if (!show) { $("#splitOn").checked = false; $("#splitRow").hidden = true; return; }
    $("#splitRow").hidden = !$("#splitOn").checked;
    if ($("#splitOn").checked) {
      const n = Number($("#splitN").value) || 2;
      const total = parseAmount($("#txAmount").value);
      const date = $("#txDate").value || TODAY;
      const months = Array.from({ length: Math.min(n, 3) }, (_, k) => M_NOM[dParts(addMonths(date, k))[1] - 1].toLowerCase());
      $("#splitHint").textContent = total > 0
        ? `${n} ${plural(n, ["платёж", "платежа", "платежей"])} по ${money(Math.floor(Math.round(total * 100) / n) / 100)}: ${months.join(", ")}${n > 3 ? "…" : ""}. Каждый попадёт в бюджет своего месяца.`
        : `${n} ${plural(n, ["платёж", "платежа", "платежей"])}: каждый попадёт в бюджет своего месяца.`;
    }
  }
  $("#aBilling").innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">${i + 1}-го</option>`).join("");
  $("#splitN").innerHTML = Array.from({ length: 35 }, (_, i) => `<option value="${i + 2}">${i + 2}</option>`).join("");

  function openTx(t = null, preset = {}) {
    if (S.status !== "ready" || S.readOnly) return;
    editing = t;
    const type = t ? t.type : (preset.type || (S.filter !== "all" ? S.filter : "expense"));
    $(`#txForm input[name="type"][value="${type}"]`).checked = true;
    catChipsExpanded = false;
    renderCatChips(type, t ? t.category : (preset.category || S.cat || null), t ? (t.goalId || (goalOfTx(t) || {}).id) : preset.goalId);
    accTouched = !!t;
    const cat = ($('#txForm input[name="category"]:checked') || {}).value;
    renderAccChips(type, t ? accountIdOf(t) : (preset.account || rememberedAccount(cat)), t ? t.toAccount : preset.toAccount);
    $("#txAmount").value = t ? inputAmount(t.amount) : (preset.amount ? inputAmount(preset.amount) : "");
    $("#txDate").value = t ? t.date : (preset.date || defaultDate());
    $("#txNote").value = t ? (t.note || "") : (preset.note || "");
    $("#splitOn").checked = false; $("#splitN").value = "3";
    renderSplit();
    $("#txDlgTitle").textContent = t ? "Изменить операцию" : TX_TITLES[type];
    $("#txDelete").hidden = !t;
    $("#txConfirm").hidden = true;
    $("#txConfirmAll").hidden = !(t && t.plan);
    $("#txErr").hidden = true;
    $$('#txForm [type="submit"]').forEach(b => { b.disabled = false; });
    $("#txSave").textContent = "Сохранить";
    txDlg.showModal();
    // focus inside the tap itself, or iOS does not open the keypad; when editing on touch, leave the keypad closed
    if (!t || matchMedia("(pointer: fine)").matches) $("#txAmount").focus();
  }
  const TX_TITLES = { expense: "Новая операция", income: "Новая операция", saving: "Отложить в копилку", transfer: "Перевод между счетами" };
  $("#txForm").addEventListener("change", e => {
    const name = e.target.name;
    if (name === "type") {
      const cur = $('#txForm input[name="category"]:checked');
      const acc = $('#txForm input[name="account"]:checked');
      renderCatChips(e.target.value, cur ? cur.value : null);
      const nc = $('#txForm input[name="category"]:checked');
      renderAccChips(e.target.value, accTouched && acc ? acc.value : (nc && rememberedAccount(nc.value)) || null);
      if (!editing) $("#txDlgTitle").textContent = TX_TITLES[e.target.value];
    } else if (name === "category" && !accTouched) {
      // the account remembered for this category, otherwise the main one
      const want = rememberedAccount(e.target.value) || settings().defaultAccount;
      const r = $(`#txForm input[name="account"][value="${CSS.escape(want)}"]`);
      if (r) r.checked = true;
    } else if (name === "account") {
      accTouched = true;
      // a transfer cannot go to the account it comes from
      const to = $('#txForm input[name="toAccount"]:checked');
      if (to && to.value === e.target.value) {
        const other = $$('#txForm input[name="toAccount"]').find(r => r.value !== e.target.value);
        if (other) other.checked = true;
      }
    }
    renderSplit();
  });
  $("#txAmount").addEventListener("input", () => { if ($("#splitOn").checked) renderSplit(); });
  $("#txForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#txErr");
    const amount = parseAmount($("#txAmount").value);
    const type = $('#txForm input[name="type"]:checked').value;
    const catEl = $('#txForm input[name="category"]:checked');
    const accEl = $('#txForm input[name="account"]:checked'), toEl = $('#txForm input[name="toAccount"]:checked');
    const date = $("#txDate").value;
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    if (amount == null || Number.isNaN(amount) || amount <= 0) { fail("Введите сумму больше нуля, например 1 250 или 349,90."); $("#txAmount").focus(); return; }
    if (amount >= 1e10) { fail("Сумма слишком большая. Проверьте, нет ли лишних цифр."); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1900-01-01" || date > "2199-12-31") { fail("Укажите дату операции между 1900 и 2199 годом."); $("#txDate").focus(); return; }
    const account = accEl ? accEl.value : settings().defaultAccount;
    if (type === "transfer") {
      if (!toEl) { fail("Заведите второй счёт, чтобы переводить деньги между счетами."); return; }
      if (toEl.value === account) { fail("Выберите разные счета: откуда и куда."); return; }
    }
    const splitN = type === "expense" && !(editing && editing.plan) && $("#splitOn").checked && !$("#splitField").hidden ? Number($("#splitN").value) : 0;
    if (splitN >= 2 && Math.round(amount * 100) < splitN) { fail(`Сумму меньше ${splitN} агорот не разбить на ${splitN} платежей.`); return; }
    const base = {
      type, date,
      category: type === "saving" ? "savings" : type === "transfer" ? "transfer" : (catEl ? catEl.value : "other"),
      ...(type === "saving" && $('#txForm input[name="goal"]:checked') ? { goalId: $('#txForm input[name="goal"]:checked').value } : {}),
      // the implicit single account is not written, so v2 data stays as it was
      ...(activeAccounts().some(a => !a.virtual) ? { account } : {}),
      ...(type === "transfer" ? { toAccount: toEl.value } : {}),
      ...(editing && editing.plan ? { plan: { ...editing.plan } } : {}),
      note: $("#txNote").value.trim().slice(0, 80),
      createdAt: editing && editing.createdAt ? editing.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    // two submit buttons (footer and the header one shown while typing): guard against a double create
    const btn = $("#txSave"), subs = $$('#txForm [type="submit"]');
    if (btn.disabled) return;
    subs.forEach(b => { b.disabled = true; }); btn.textContent = "Сохраняем…";
    try {
      if (splitN >= 2) {
        // split purchase: N parts on the card, one per month, the last part takes the rounding remainder
        const planId = mintId("p_");
        const cents = Math.round(amount * 100), partC = Math.floor(cents / splitN);
        for (let k = 0; k < splitN; k++) {
          const amt = (k === splitN - 1 ? cents - partC * (splitN - 1) : partC) / 100;
          const data = { ...base, amount: amt, date: addMonths(date, k), plan: { id: planId, n: k + 1, of: splitN }, createdAt: base.createdAt + k };
          await store.saveTx(k === 0 && editing ? editing.id : null, data);
        }
      } else {
        await store.saveTx(editing ? editing.id : null, { ...base, amount });
      }
      if (type !== "transfer" && base.category && accEl) rememberAccount(base.category, account);
      txDlg.close();
      if (splitN >= 2) toast(`Сплит: ${splitN} ${plural(splitN, ["платёж", "платежа", "платежей"])} по месяцам`);
      else if (ymOf(date) !== S.month) {
        const [, mm] = ymParts(ymOf(date));
        toast(`Сохранено в ${M_PREP[mm - 1]}`, { label: "Показать", run: () => { S.month = ymOf(date); render(); } });
      } else toast(editing ? "Изменения сохранены" : type === "transfer" ? "Перевод записан" : "Операция добавлена");
    } catch (ex) {
      fail(errText(ex));
      subs.forEach(b => { b.disabled = false; }); btn.textContent = "Сохранить";
    }
  });
  $("#splitOn").addEventListener("change", renderSplit);
  $("#splitN").addEventListener("change", renderSplit);
  $("#txDelete").addEventListener("click", () => { $("#txConfirm").hidden = false; $("#txConfirmYes").focus({ preventScroll: true }); $("#txConfirm").scrollIntoView({ block: "center" }); });
  $("#txConfirmNo").addEventListener("click", () => { $("#txConfirm").hidden = true; });
  $("#txConfirmYes").addEventListener("click", async () => {
    if (!editing) return;
    const t = editing;
    txDlg.close();
    await deleteTx(t);
  });
  $("#txConfirmAll").addEventListener("click", async () => {
    if (!editing || !editing.plan) return;
    const parts = S.tx.filter(t => t.plan && t.plan.id === editing.plan.id);
    txDlg.close();
    try {
      await store.deleteMany(parts.map(t => t.id));
      toast(`Сплит удалён: ${parts.length} ${plural(parts.length, ["платёж", "платежа", "платежей"])}`);
    } catch (e) { toast(errText(e)); }
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
      `<label class="icon-opt" title=""><input type="radio" name="${name}" value="${n}" ${n === selected ? "checked" : ""} aria-label="${esc(ICON_RU[n] || n)}"><span>${icon(n)}</span></label>`).join("");
  }
  function openGoal(id, preset = {}) {
    if (S.status !== "ready" || S.readOnly) return;
    const goals = settings().goals;
    const g = id ? goals.find(x => x.id === id) || null : null;
    if (!g && goals.length >= 20) { toast("Можно завести до 20 целей. Удалите выполненную, чтобы добавить новую."); return; }
    editingGoal = g;
    $("#goalDlgTitle").textContent = g ? "Изменить цель" : "Новая цель";
    $("#gName").value = g ? g.name : (preset.name || "");
    $("#gTarget").value = g ? inputAmount(g.target) : (preset.target ? inputAmount(preset.target) : "");
    $("#gDeadline").value = g ? g.deadline : "";
    $("#gInitial").value = g ? inputAmount(g.initial) : "";
    iconGrid($("#gIcons"), "gicon", GOAL_ICONS, g ? g.icon : (preset.icon || (goals.length ? "Target" : "ShieldCheck")));
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
      toast(`Цель «${gone.name}» убрана`, { label: "Вернуть", run: () => saveSettings({ goals: restoreEntry(settings().goals, prev, gone.id) }).catch(e => toast(errText(e))) });
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
      toast(used ? `Категория «${gone.name}» скрыта` : `Категория «${gone.name}» удалена`, { label: "Вернуть", run: () => saveSettings({ categories: restoreEntry(settings().categories, prev, gone.id) }).then(() => toast(`Категория «${gone.name}» возвращена`)).catch(e => toast(errText(e))) });
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
    const listed = new Set($$("#limitList input").map(i => i.dataset.cat));
    for (const [k, v] of Object.entries(settings().limits)) if (!listed.has(k)) limits[k] = v;   // hidden categories keep theirs
    for (const inp of $$("#limitList input")) {
      const v = parseAmount(inp.value);
      if (v == null || v === 0) continue;
      if (Number.isNaN(v) || v < 0) { err.textContent = `Проверьте лимит для «${(findCat(inp.dataset.cat) || CAT.other).name}»: нужна сумма числом.`; err.hidden = false; inp.focus(); return; }
      limits[inp.dataset.cat] = v;
    }
    try { await saveSettings({ limits }); limitsDlg.close(); toast("Лимиты сохранены"); }
    catch (ex) { err.textContent = errText(ex); err.hidden = false; }
  });

  /* ── Accounts: manager and editor ────────────── */
  const accsDlg = $("#accsDlg"), accDlg = $("#accDlg");
  let editingAcc = null;
  const accUsage = id => S.tx.reduce((n, t) => n + (accountIdOf(t) === id || t.toAccount === id ? 1 : 0), 0);
  function renderAccountsManager() {
    const st = settings(), bal = accountBalances(TODAY);
    const row = (a, archived) => `<div class="cats-row">
        <span class="tx-ic ${a.kind === "card" ? "bg-card" : "bg-acc"}">${icon(a.icon)}</span>
        <span class="cats-name"><b>${esc(a.name)}${a.id === st.defaultAccount ? ` <span class="ex-tag">основной</span>` : ""}</b>
          <small>${esc(a.kind === "card" ? `${ACCOUNT_KINDS.card.short} · списание ${a.billingDay}-го` : ACCOUNT_KINDS[a.kind].short)} · ${a.kind === "card" && bal.get(a.id) < 0 ? `долг ${money(-bal.get(a.id))}` : money(bal.get(a.id))}</small></span>
        ${archived ? `<button type="button" class="btn btn-ghost btn-sm" data-acc-restore="${esc(a.id)}">Вернуть</button>`
                   : `<button type="button" class="icon-btn" data-acc-edit="${esc(a.id)}" aria-label="Изменить счёт «${esc(a.name)}»">${icon("Pencil")}</button>`}
      </div>`;
    const act = st.accounts.filter(a => !a.archived), arch = st.accounts.filter(a => a.archived);
    $("#accsBody").innerHTML = `<div class="cats-list">${act.map(a => row(a)).join("")}</div>`
      + (arch.length ? `<h3 class="cats-group">Скрытые</h3><div class="cats-list">${arch.map(a => row(a, true)).join("")}</div>` : "");
  }
  function openAccounts() {
    if (S.status !== "ready" || S.readOnly) return;
    renderAccountsManager();
    accsDlg.showModal();
  }
  function accKindChanged() {
    const kind = $('#accForm input[name="akind"]:checked').value;
    const isCard = kind === "card";
    $("#accCardFields").hidden = !isCard;
    $("#accSignRow").hidden = isCard;
    $("#aDefaultRow").hidden = isCard;   // a card is never the main account
    $("#aOpeningLabel").textContent = isCard ? "Долг по карте на начало учёта" : "Остаток на начало учёта";
    $("#aOpeningHint").textContent = isCard
      ? "Сколько уже потрачено по карте и ещё не списано с банка. Если записываете с чистого листа, оставьте 0."
      : "Сколько денег на этом счёте сейчас, до первой записи в приложении.";
    $("#aName").placeholder = { bank: "Например: Леуми", cash: "Например: Наличные", wallet: "Например: PayBox", card: "Например: Max" }[kind];
    if (!editingAcc) {
      const cur = $('#accForm input[name="aicon"]:checked');
      if (!cur || Object.values(ACCOUNT_KINDS).some(k => k.icon === cur.value)) {
        const r = $(`#accForm input[name="aicon"][value="${ACCOUNT_KINDS[kind].icon}"]`); if (r) r.checked = true;
      }
    }
    // a card is paid from a bank account or a wallet
    const payFrom = activeAccounts().filter(a => a.kind !== "card" && (!editingAcc || a.id !== editingAcc.id));
    const cur = editingAcc && editingAcc.payFrom;
    $("#aPayFrom").innerHTML = payFrom.length
      ? payFrom.map(a => `<option value="${esc(a.id)}" ${a.id === cur || (!cur && a.id === settings().defaultAccount) ? "selected" : ""}>${esc(a.name)}</option>`).join("")
      : `<option value="">Сначала заведите банковский счёт</option>`;
  }
  function openAccountEditor(id, kind) {
    if (S.status !== "ready" || S.readOnly) return;
    const st = settings();
    const a = id ? st.accounts.find(x => x.id === id) || null : null;
    if (!a && st.accounts.filter(x => !x.virtual).length >= 20) { toast("Можно завести до 20 счетов."); return; }
    editingAcc = a;
    $("#accDlgTitle").textContent = a ? "Изменить счёт" : "Новый счёт";
    const k = a ? a.kind : (kind || "bank");
    $(`#accForm input[name="akind"][value="${k}"]`).checked = true;
    $$('#accForm input[name="akind"]').forEach(r => { r.disabled = !!a && accUsage(a.id) > 0 && (r.value === "card") !== (a.kind === "card"); });
    $("#aName").value = a ? a.name : "";
    iconGrid($("#aIcons"), "aicon", ACCOUNT_ICONS, a ? a.icon : ACCOUNT_KINDS[k].icon);
    const op = a ? a.opening : 0;
    $(`#accForm input[name="asign"][value="${op < 0 && k !== "card" ? -1 : 1}"]`).checked = true;
    $("#aOpening").value = inputAmount(Math.abs(op));
    $("#aBilling").value = String(a && a.billingDay || 10);
    $("#aLimit").value = a && a.creditLimit ? inputAmount(a.creditLimit) : "";
    $("#aDefault").checked = a ? st.defaultAccount === a.id : false;
    accKindChanged();
    const used = a ? accUsage(a.id) : 0;
    $("#accRemove").hidden = !a || st.accounts.filter(x => !x.archived).length < 2;
    $("#accRemove").lastChild.textContent = used ? "Скрыть" : "Удалить";
    $("#accRemove").setAttribute("aria-label", used ? "Скрыть счёт" : "Удалить счёт");
    $("#accErr").hidden = true;
    accDlg.showModal();
    if (!a || matchMedia("(pointer: fine)").matches) $("#aName").focus();
  }
  $("#accForm").addEventListener("change", e => { if (e.target.name === "akind") accKindChanged(); });
  $("#accForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#accErr");
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    const kind = $('#accForm input[name="akind"]:checked').value;
    const name = $("#aName").value.trim().slice(0, 40);
    const ic = ($('#accForm input[name="aicon"]:checked') || {}).value || ACCOUNT_KINDS[kind].icon;
    const raw = $("#aOpening").value.trim();
    const v = parseAmount(raw.replace(/^[-−]/, ""));
    if (!name) { fail("Назовите счёт, например «Леуми», «Наличные» или «Max»."); $("#aName").focus(); return; }
    if (v != null && (Number.isNaN(v) || v >= 1e10)) { fail("Введите сумму числом, например 8 500."); $("#aOpening").focus(); return; }
    const neg = kind !== "card" && ($('#accForm input[name="asign"]:checked').value === "-1" || /^[-−]/.test(raw));
    const acc = {
      ...(editingAcc ? (({ virtual, ...rest }) => rest)(editingAcc) : { id: "a_" + Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "x"), createdAt: Date.now() }),
      kind, name, icon: ic, opening: (v || 0) * (neg ? -1 : 1),
    };
    if (kind === "card") {
      acc.billingDay = Number($("#aBilling").value) || 10;
      const pf = $("#aPayFrom").value; if (pf) acc.payFrom = pf; else delete acc.payFrom;
      const lim = parseAmount($("#aLimit").value);
      if (lim && !Number.isNaN(lim) && lim > 0) acc.creditLimit = lim; else delete acc.creditLimit;
    } else { delete acc.billingDay; delete acc.payFrom; delete acc.creditLimit; }
    let list = settings().accounts.map(a => ({ ...a }));
    // the example's start balance is not the user's money: it does not become the opening of «Основной счёт»
    if (settings().example && settings().example.startBalance) list = list.map(a => a.virtual ? { ...a, opening: 0 } : a);
    // the first own bank, cash or wallet replaces the implicit, empty and unused «Основной счёт» (e.g. right after
    // «Удалить пример»), also when a card paid from it was added first
    const emptyMain = a => a.id === "a_main" && !a.opening && a.name === "Основной счёт" && accUsage("a_main") === 0;
    const phantom = !editingAcc && kind !== "card" && !txDlg.open && list.some(emptyMain) && list.every(a => emptyMain(a) || a.kind === "card");
    if (phantom) list = list.filter(a => !emptyMain(a)).map(a => a.payFrom === "a_main" ? { ...a, payFrom: acc.id } : a);
    const next = editingAcc ? list.map(a => a.id === acc.id ? acc : a) : [...list, acc];
    let def = phantom ? acc.id : settings().defaultAccount;
    if ($("#aDefault").checked && kind !== "card") def = acc.id;
    else if (!$("#aDefault").checked && editingAcc && def === acc.id) def = (next.find(x => x.id !== acc.id && x.kind !== "card" && !x.archived) || { id: def }).id;
    if (def === acc.id && kind === "card") def = (next.find(a => a.kind !== "card" && !a.archived) || next[0]).id;
    try {
      await saveSettings({ accounts: next, defaultAccount: def });
      accDlg.close();
      toast(editingAcc ? "Счёт сохранён" : `Счёт «${name}» добавлен`);
      if (accsDlg.open) { renderAccountsManager(); ($(`#accsBody [data-acc-edit="${CSS.escape(acc.id)}"]`) || $("#accsAdd")).focus(); }
      if (txDlg.open) { const type = $('#txForm input[name="type"]:checked').value; renderAccChips(type, type === "transfer" ? null : acc.id); renderSplit(); }
    } catch (ex) { fail(errText(ex)); }
  });
  $("#accRemove").addEventListener("click", async () => {
    if (!editingAcc) return;
    const prev = settings().accounts.map(a => ({ ...a }));
    const gone = editingAcc, used = accUsage(gone.id) > 0;
    const next = used ? prev.map(a => a.id === gone.id ? { ...a, archived: true } : a) : prev.filter(a => a.id !== gone.id);
    let def = settings().defaultAccount;
    const wasMain = def === gone.id;
    if (wasMain) def = (next.find(a => !a.archived && a.kind !== "card") || next.find(a => !a.archived) || next[0]).id;
    accDlg.close();
    try {
      await saveSettings({ accounts: next, defaultAccount: def });
      toast(used ? `Счёт «${gone.name}» скрыт` : `Счёт «${gone.name}» удалён`, { label: "Вернуть", run: () => saveSettings({ accounts: restoreEntry(settings().accounts, prev, gone.id), ...(wasMain ? { defaultAccount: gone.id } : {}) }).then(() => toast(`Счёт «${gone.name}» возвращён`)).catch(e => toast(errText(e))) });
      if (accsDlg.open) { renderAccountsManager(); $("#accsAdd").focus(); }
    } catch (ex) { toast(errText(ex)); }
  });
  $("#accsBody").addEventListener("click", async e => {
    const ed = e.target.closest("[data-acc-edit]");
    if (ed) { openAccountEditor(ed.dataset.accEdit); return; }
    const rs = e.target.closest("[data-acc-restore]");
    if (rs) {
      const next = settings().accounts.map(a => a.id === rs.dataset.accRestore ? (({ archived, ...rest }) => rest)(a) : { ...a });
      try { await saveSettings({ accounts: next }); renderAccountsManager(); toast("Счёт снова в списке"); }
      catch (ex) { toast(errText(ex)); }
    }
  });
  $("#accsAdd").addEventListener("click", () => openAccountEditor(null));
  // the hero's edit button and the old «начальный остаток» entry points open the accounts
  const openStart = openAccounts;
  // record a card bill: a transfer from the card's paying account to the card
  function payCard(cardId) {
    const card = findAccount(cardId);
    if (!card) return;
    const d = cardsDue().find(x => x.card.id === cardId);
    openTx(null, { type: "transfer", account: card.payFrom || settings().defaultAccount, toAccount: card.id,
      amount: d ? d.due : undefined, date: d ? d.date : TODAY, note: `Списание по карте «${card.name}»` });
  }

  /* ── Clear example data ────────────────────── */
  async function clearExamples() {
    if (S.clearing) return;
    const ex = S.tx.filter(t => t.example === true);
    S.clearing = { done: 0, total: ex.length };
    renderNotice();
    try {
      await store.deleteMany(ex.map(t => t.id), done => { S.clearing.done = done; renderNotice(); });
      const exFlags = settings().example || {};
      // accounts still exactly as the example made them are the example's, even once the flag went with the user's
      // first own account (the PWA seed is known; the artifact relies on the flag)
      const seedList = window.BudgetSeed ? window.BudgetSeed.make(TODAY).settings.accounts : [];
      const seedAcc = a => !!exFlags.accounts || seedList.some(x => x.id === a.id && x.kind === a.kind && x.name === a.name && x.opening === a.opening);
      const exAccounts = settings().accounts.some(a => !a.virtual && seedAcc(a));
      if (Object.keys(exFlags).length || exAccounts) {
        const st = settings(), next = settingsDoc();
        for (const k of Object.keys(exFlags)) if (k in DEFAULTS) next[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
        // the user's own operations keep the example goal, category or account they were made into: it becomes
        // theirs, without the example's amounts («уже отложено», opening balance)
        const mine = S.tx.filter(t => t.example !== true);
        if (exFlags.goals) next.goals = st.goals.filter(g => mine.some(t => t.type === "saving" && goalOfTx(t, st.goals) === g)).map(g => ({ ...g, initial: 0 }));
        if (exFlags.categories) next.categories = st.categories.filter(c => mine.some(t => t.category === c.id)).map(c => ({ ...c }));
        if (exAccounts) {
          // a start balance that is not the example's (e.g. from a v2 backup loaded over the example) stays the user's
          const own = exFlags.accounts && !exFlags.startBalance ? st.startBalance : 0;
          const kept = st.accounts.filter(a => !a.virtual && (!seedAcc(a) || mine.some(t => t.account === a.id || t.toAccount === a.id)))
            .map(a => seedAcc(a) ? { ...a, opening: 0 } : { ...a });
          if (own && kept.length && !kept.some(a => a.id === "a_main")) kept.unshift({ id: "a_main", kind: "bank", name: "Основной счёт", icon: "Landmark", opening: own, createdAt: 0 });
          if (kept.length) {
            next.accounts = kept;
            next.defaultAccount = kept.some(a => a.id === st.defaultAccount) ? st.defaultAccount : (kept.find(a => a.kind !== "card") || kept[0]).id;
            next.startBalance = r2(kept.reduce((sum, a) => sum + (a.kind === "card" ? -a.opening : a.opening), 0));
          } else { delete next.defaultAccount; next.startBalance = own; }
        }
        if (!next.accounts || !next.accounts.length) { delete next.accounts; delete next.defaultAccount; }
        delete next.example;
        await store.saveSettings(next);
      }
      S.clearing = null; S.cat = null;
      render();
      toast("Пример удалён. Добавьте свои счета и операции.");
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
    dlg.addEventListener("close", () => {
      dlg.classList.remove("kb-open");
      const t = $("#toast"); if (dlg.contains(t)) { t.style.bottom = ""; document.body.appendChild(t); }
    });
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
    const el = e.target.closest("[data-goal-add],[data-goal-edit],[data-pay-card],[data-do]");
    if (!el || el.disabled) return;
    if (el.dataset.goalAdd !== undefined) { openTx(null, { type: "saving", goalId: el.dataset.goalAdd || undefined }); return; }
    if (el.dataset.goalEdit) { openGoal(el.dataset.goalEdit); return; }
    if (el.dataset.payCard) { payCard(el.dataset.payCard); return; }
    switch (el.dataset.do) {
      case "goal-new": if (txDlg.open) txDlg.close(); openGoal(null); break;
      case "goal-safety": openGoal(null, { name: "Подушка безопасности", target: Number(el.dataset.target) || 0, icon: "ShieldCheck" }); break;
      case "goals-view": setView("goals"); break;
      case "saving": openTx(null, { type: "saving" }); break;
      case "cat-new": openCatEditor(null, el.dataset.type, true); break;
      case "categories": openCategories(); break;
      case "accounts": openAccounts(); break;
      case "account-new": openAccountEditor(null, "cash"); break;
      case "transfer": openTx(null, { type: "transfer" }); break;
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
      openStart: () => openAccounts(),
      openAccounts: () => openAccounts(),
      openTransfer: () => openTx(null, { type: "transfer" }),
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
  // an installed app resumed on a new day starts over, so «сегодня», due card bills and new operations use the new date
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isoOf(new Date()) !== TODAY && !document.querySelector("dialog[open]")) location.reload();
  });
})();
