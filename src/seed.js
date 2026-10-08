/* Example budget for the first launch of the PWA: last month in full and the current month up to today.
   Every record is marked example:true; the settings mark which fields still hold example values. */
(() => {
  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  // [month: -1 = previous, 0 = current, day, type, category, amount, note]; "%m-1" / "%m-2" = month names
  const ROWS = [
    [-1, 1, "expense", "housing", 45000, "Аренда квартиры"],
    [-1, 2, "expense", "transport", 3060, "Проездной на 30 дней"],
    [-1, 5, "income", "salary", 70000, "Зарплата за %m-2"],
    [-1, 6, "expense", "cafe", 640, "Кофе и завтрак"],
    [-1, 7, "expense", "groceries", 4870, "Продукты на неделю"],
    [-1, 9, "expense", "telecom", 1150, "Мобильная связь и интернет"],
    [-1, 10, "expense", "telecom", 299, "Подписка на музыку"],
    [-1, 12, "expense", "fun", 1400, "Кино с друзьями"],
    [-1, 13, "expense", "groceries", 6230, "Продукты на неделю"],
    [-1, 15, "expense", "health", 1860, "Аптека"],
    [-1, 16, "saving", "savings", 15000, "Перевод в копилку"],
    [-1, 18, "income", "freelance", 18000, "Логотип для кофейни"],
    [-1, 19, "expense", "cafe", 3850, "Ужин в ресторане"],
    [-1, 20, "income", "salary", 50000, "Аванс"],
    [-1, 21, "expense", "groceries", 5410, "Продукты на неделю"],
    [-1, 22, "expense", "housing", 5230, "ЖКХ и электричество"],
    [-1, 24, "expense", "clothes", 7990, "Кроссовки"],
    [-1, 26, "expense", "transport", 690, "Такси"],
    [-1, 27, "expense", "groceries", 4980, "Продукты на неделю"],
    [-1, 28, "expense", "education", 2400, "Урок английского"],
    [-1, 31, "income", "cashback", 1270, "Кешбэк за %m-1"],
    [0, 1, "expense", "housing", 45000, "Аренда квартиры"],
    [0, 2, "expense", "transport", 3060, "Проездной на 30 дней"],
    [0, 3, "expense", "groceries", 5760, "Продукты на неделю"],
    [0, 4, "expense", "cafe", 2340, "Бранч с друзьями"],
    [0, 5, "income", "salary", 70000, "Зарплата за %m-1"],
    [0, 5, "saving", "savings", 15000, "Перевод в копилку"],
    [0, 6, "expense", "telecom", 1150, "Мобильная связь и интернет"],
    [0, 7, "expense", "groceries", 3920, "Продукты"],
    [0, 7, "expense", "health", 4500, "Стоматолог"],
    [0, 8, "expense", "cafe", 290, "Кофе с собой"],
  ];
  const pad = n => String(n).padStart(2, "0");

  function make(todayIso) {
    const [ty, tm, td] = todayIso.split("-").map(Number);
    const monthAt = k => { const d = new Date(ty, tm - 1 + k, 1); return { y: d.getFullYear(), m: d.getMonth() + 1 }; };
    const name = k => MONTHS[monthAt(k).m - 1];
    const perDay = {};
    const tx = [];
    ROWS.forEach(([k, day, type, category, amount, note], i) => {
      const { y, m } = monthAt(k);
      const last = new Date(y, m, 0).getDate();
      const d = Math.min(day, last);
      if (k === 0 && d > td) return;               // nothing in the future
      const date = `${y}-${pad(m)}-${pad(d)}`;
      perDay[date] = (perDay[date] || 0) + 1;
      const createdAt = new Date(y, m - 1, d, 9 + perDay[date]).getTime();
      tx.push({
        id: "ex" + pad(i + 1), type, category, amount, date, createdAt,
        note: note.replace("%m-2", name(-2)).replace("%m-1", name(-1)),
        example: true,
      });
    });
    const dl = monthAt(7);
    const settings = {
      startBalance: 52400,
      goal: { name: "Отпуск в Грузии", target: 250000, deadline: `${dl.y}-${pad(dl.m)}-01`, initial: 96000 },
      limits: { groceries: 25000, cafe: 8000, fun: 5000, transport: 4500, clothes: 6000, health: 5000, telecom: 1600 },
      example: { startBalance: true, goal: true, limits: true },
    };
    return { settings, tx };
  }

  window.BudgetSeed = { make };
})();
