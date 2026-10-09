/* Example budget for the first launch of the PWA: last month in full and the current month up to today, in shekels.
   Every record is marked example:true; the settings mark which fields still hold example values. */
(() => {
  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  // [month: -1 = previous, 0 = current, day, type, category, amount, note, goalId?]; "%m-1" / "%m-2" = month names
  const ROWS = [
    [-1, 1, "expense", "housing", 5800, "Аренда квартиры"],
    [-1, 2, "expense", "transport", 225, "Проездной на месяц"],
    [-1, 3, "expense", "groceries", 720, "Продукты на неделю"],
    [-1, 5, "income", "salary", 14500, "Зарплата за %m-2"],
    [-1, 6, "expense", "cafe", 32, "Кофе и круассан"],
    [-1, 8, "expense", "utilities", 980, "Арнона за два месяца"],
    [-1, 9, "expense", "telecom", 59, "Мобильная связь"],
    [-1, 9, "expense", "telecom", 99, "Домашний интернет"],
    [-1, 10, "expense", "c_vaadbayit", 180, "Ваад байт"],
    [-1, 11, "expense", "groceries", 640, "Продукты на неделю"],
    [-1, 12, "expense", "fun", 96, "Кино с друзьями"],
    [-1, 15, "expense", "health", 85, "Аптека"],
    [-1, 16, "saving", "savings", 1500, "В копилку", "g_safety"],
    [-1, 18, "income", "freelance", 2400, "Логотип для кафе"],
    [-1, 19, "expense", "cafe", 310, "Ужин в ресторане"],
    [-1, 20, "income", "social", 173, "Битуах Леуми: пособие на ребёнка"],
    [-1, 21, "expense", "groceries", 690, "Продукты на неделю"],
    [-1, 22, "expense", "utilities", 410, "Электричество"],
    [-1, 24, "expense", "clothes", 389, "Кроссовки"],
    [-1, 25, "expense", "car", 280, "Бензин"],
    [-1, 26, "saving", "savings", 800, "В копилку", "g_trip"],
    [-1, 27, "expense", "groceries", 710, "Продукты на неделю"],
    [-1, 28, "expense", "kids", 250, "Кружок рисования"],
    [-1, 31, "income", "cashback", 45, "Кешбэк за %m-1"],
    [0, 1, "expense", "housing", 5800, "Аренда квартиры"],
    [0, 2, "expense", "transport", 225, "Проездной на месяц"],
    [0, 3, "expense", "groceries", 760, "Продукты на неделю"],
    [0, 4, "expense", "cafe", 180, "Бранч с друзьями"],
    [0, 5, "income", "salary", 14500, "Зарплата за %m-1"],
    [0, 5, "saving", "savings", 1500, "В копилку", "g_safety"],
    [0, 6, "expense", "telecom", 59, "Мобильная связь"],
    [0, 7, "expense", "groceries", 590, "Продукты"],
    [0, 7, "expense", "health", 450, "Стоматолог"],
    [0, 8, "expense", "cafe", 18, "Кофе с собой"],
    [0, 9, "expense", "c_vaadbayit", 180, "Ваад байт"],
  ];
  const pad = n => String(n).padStart(2, "0");

  function make(todayIso) {
    const [ty, tm, td] = todayIso.split("-").map(Number);
    const monthAt = k => { const d = new Date(ty, tm - 1 + k, 1); return { y: d.getFullYear(), m: d.getMonth() + 1 }; };
    const name = k => MONTHS[monthAt(k).m - 1];
    const firstOf = k => { const { y, m } = monthAt(k); return `${y}-${pad(m)}-01`; };
    const perDay = {};
    const tx = [];
    ROWS.forEach(([k, day, type, category, amount, note, goalId], i) => {
      const { y, m } = monthAt(k);
      const last = new Date(y, m, 0).getDate();
      const d = Math.min(day, last);
      if (k === 0 && d > td) return;               // nothing in the future
      const date = `${y}-${pad(m)}-${pad(d)}`;
      perDay[date] = (perDay[date] || 0) + 1;
      const createdAt = new Date(y, m - 1, d, 9 + perDay[date]).getTime();
      tx.push({
        id: "ex" + pad(i + 1), type, category, amount, date, createdAt,
        ...(goalId ? { goalId } : {}),
        note: note.replace("%m-2", name(-2)).replace("%m-1", name(-1)),
        example: true,
      });
    });
    const t0 = new Date(ty, tm - 3, 1).getTime();
    const settings = {
      startBalance: 9200,
      goals: [
        { id: "g_safety", name: "Подушка безопасности", target: 45000, deadline: firstOf(12), initial: 18000, icon: "ShieldCheck", createdAt: t0 },
        { id: "g_trip", name: "Отпуск в Эйлате", target: 6000, deadline: firstOf(6), initial: 1200, icon: "TreePalm", createdAt: t0 + 1 },
        { id: "g_laptop", name: "Новый ноутбук", target: 5500, deadline: "", initial: 900, icon: "Laptop", createdAt: t0 + 2 },
      ],
      limits: { groceries: 3200, cafe: 600, fun: 400, transport: 300, car: 600, clothes: 500, health: 500, telecom: 200, kids: 400 },
      categories: [{ id: "c_vaadbayit", type: "expense", name: "Ваад байт", icon: "Building2" }],
      example: { startBalance: true, goals: true, limits: true, categories: true },
    };
    return { settings, tx };
  }

  window.BudgetSeed = { make };
})();
