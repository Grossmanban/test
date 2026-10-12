/* «Обучение»: lesson list with a track filter, an in-page lesson reader, quizzes and per-device progress.
   window.BudgetLearn.mount(el, api) — called once by app.js with el = #viewLearn and api = BudgetApp
   (icon, esc, toast, actions). Lessons come from window.MH_LESSONS (src/lessons.js, plain text).
   Progress lives in localStorage["mh-learn"]; every access is guarded, the section works without it. */
(() => {
  "use strict";

  const KEY = "mh-learn";
  const TRACKS = {
    app: { label: "Приложение", title: "Как пользоваться Money honey" },
    basics: { label: "Основы", title: "Основы личных финансов" },
    israel: { label: "Израиль", title: "Деньги в Израиле" },
  };
  const FILTERS = [["all", "Все"], ["app", "Приложение"], ["basics", "Основы"], ["israel", "Израиль"]];
  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  // tryIt.action → which view to show behind the dialog, and how to open it through BudgetApp.actions
  const ACTIONS = {
    tx: { view: "budget", fn: "openTx", args: () => [] },
    saving: { view: "goals", fn: "openTx", args: () => [{ type: "saving" }] },
    limits: { view: "budget", fn: "openLimits", args: () => [] },
    goal: { view: "goals", fn: "openGoal", args: () => [null] },
    categories: { view: "budget", fn: "openCategories", args: () => [] },
    start: { view: "budget", fn: "openStart", args: () => [] },
  };

  /* ── progress (per device) ─────────────────────── */
  function blankProgress() { return { v: 1, track: "all", seen: {}, done: {}, quiz: {} }; }
  function loadProgress() {
    const p = blankProgress();
    try {
      const raw = window.localStorage.getItem(KEY);
      const d = raw ? JSON.parse(raw) : null;
      if (d && typeof d === "object") {
        if (FILTERS.some(f => f[0] === d.track)) p.track = d.track;
        for (const k of ["seen", "done", "quiz"]) if (d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) p[k] = d[k];
      }
    } catch (e) { /* private mode, blocked storage, bad JSON: start fresh */ }
    return p;
  }

  function mount(el, api) {
    if (!el) return;
    api = api || {};
    const esc = typeof api.esc === "function" ? api.esc
      : s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const icon = name => (typeof api.icon === "function" ? api.icon(name) : "");
    const toast = msg => { if (typeof api.toast === "function") api.toast(msg); };
    const actions = api.actions || {};

    const LESSONS = (Array.isArray(window.MH_LESSONS) ? window.MH_LESSONS : [])
      .filter(l => l && typeof l.id === "string" && TRACKS[l.track]);
    const byId = Object.fromEntries(LESSONS.map(l => [l.id, l]));
    const P = loadProgress();
    const S = { lesson: null, listScroll: 0 };
    function save() { try { window.localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* keep in memory */ } }

    /* ── text helpers ──────────────────────────────── */
    // plain lesson text → safe HTML: no-break spaces inside numbers and before ₪ / dashes,
    // Hebrew runs isolated in <bdi lang="he"> so they keep their direction inside Russian sentences
    const HEB = /[֐-׿יִ-ﭏ]+(?:[\s"'׳״-][֐-׿יִ-ﭏ]+)*/g;
    function t(s) {
      const str = String(s == null ? "" : s)
        .replace(/(\d) (?=\d{3}(?!\d))/g, "$1 ")
        .replace(/(\d) ₪/g, "$1 ₪")
        .replace(/ — /g, " — ");
      let out = "", last = 0;
      str.replace(HEB, (m, i) => {
        out += esc(str.slice(last, i)) + `<bdi lang="he">${esc(m)}</bdi>`;
        last = i + m.length;
        return m;
      });
      return out + esc(str.slice(last));
    }
    const plural = (n, forms) => forms[(n % 100 > 10 && n % 100 < 20) ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
    const isDone = id => !!P.done[id];
    const answers = id => (P.quiz[id] && typeof P.quiz[id] === "object" ? P.quiz[id] : {});
    function quizScore(l) {
      const a = answers(l.id);
      let answered = 0, right = 0;
      (l.quiz || []).forEach((q, i) => { if (Number.isInteger(a[i])) { answered++; if (a[i] === q.correct) right++; } });
      return { answered, right, total: (l.quiz || []).length };
    }
    function checkedLabel(v) {
      const m = /^(\d{4})-(\d{2})$/.exec(v || "");
      return m && +m[2] >= 1 && +m[2] <= 12 ? `${MONTHS[+m[2] - 1]} ${m[1]}` : "";
    }
    function tryAvailable(l) {
      const a = l.tryIt && ACTIONS[l.tryIt.action];
      return !!(a && typeof actions[a.fn] === "function") || !!(l.tryIt && typeof actions[l.tryIt.action] === "function");
    }

    /* ── list ──────────────────────────────────────── */
    function cardHtml(l) {
      const sc = quizScore(l);
      const state = isDone(l.id)
        ? `<span class="lrn-state is-done">${icon("CircleCheck")}Пройден</span>`
        : P.seen[l.id] ? `<span class="lrn-state is-seen">${sc.answered ? `Тест: ${sc.right} из ${sc.total}` : "Начат"}</span>` : "";
      return `<li><button type="button" class="lrn-card${isDone(l.id) ? " is-done" : ""}" data-open="${esc(l.id)}">
          <span class="lrn-ic tone-${esc(l.track)}">${icon(l.icon)}</span>
          <span class="lrn-card-main">
            <span class="lrn-card-title">${t(l.title)}</span>
            <span class="lrn-card-sum">${t(l.summary)}</span>
            <span class="lrn-card-meta"><span class="lrn-min">${icon("Clock")}${esc(l.minutes)} мин</span>${state}</span>
          </span>
          <span class="lrn-chev" aria-hidden="true">${icon("ChevronRight")}</span>
        </button></li>`;
    }
    function nextUnfinished() {
      return LESSONS.find(l => P.seen[l.id] && !isDone(l.id)) || LESSONS.find(l => !isDone(l.id)) || null;
    }
    function renderList() {
      if (!LESSONS.length) {
        el.innerHTML = `<div class="lrn"><div class="card empty"><div class="empty-ic">${icon("GraduationCap")}</div>
          <h3>Уроки не загрузились</h3><p>Обновите страницу.</p></div></div>`;
        return;
      }
      const done = LESSONS.filter(l => isDone(l.id)).length;
      const pct = Math.round(done / LESSONS.length * 100);
      const next = nextUnfinished();
      const nextLabel = !next ? "" : P.seen[next.id] ? "Продолжить" : done ? "Следующий урок" : "Начните с первого урока";
      const shown = P.track === "all" ? LESSONS : LESSONS.filter(l => l.track === P.track);
      const groups = Object.keys(TRACKS).filter(k => P.track === "all" || P.track === k)
        .map(k => [k, shown.filter(l => l.track === k)]).filter(([, ls]) => ls.length);
      el.innerHTML = `<div class="lrn">
        <div class="view-head lrn-head">
          <div><h2 class="view-title" id="lrnListTitle" tabindex="-1">Обучение</h2>
            <p class="meta">Короткие уроки с мини-тестами: как вести бюджет в Money honey, основы личных финансов и деньги в Израиле.</p></div>
          <div class="lrn-sum">
            <p class="lrn-sum-text"><b>${done}</b> из ${LESSONS.length} ${plural(LESSONS.length, ["урока", "уроков", "уроков"])} пройдено</p>
            <div class="lrn-meter" aria-hidden="true"><span style="width:${pct}%"></span></div>
          </div>
        </div>
        ${next ? `<button type="button" class="lrn-continue" data-open="${esc(next.id)}">
            <span class="lrn-ic tone-${esc(next.track)}">${icon(next.icon)}</span>
            <span class="lrn-continue-main"><span class="lrn-continue-label">${nextLabel}</span><span class="lrn-continue-title">${t(next.title)}</span></span>
            <span class="lrn-continue-go">${icon("ChevronRight")}</span>
          </button>` : `<div class="notice is-info lrn-all-done">${icon("CircleCheckBig")}<p><b>Все уроки пройдены.</b> Загляните в уроки об Израиле раз в год: суммы и правила там меняются.</p></div>`}
        <div class="notice lrn-note" role="note">${icon("Info")}<p>Это общая информация, а не персональная финансовая консультация. Суммы и правила меняются — сверяйтесь с источниками в конце каждого урока.</p></div>
        <div class="seg lrn-tracks" role="group" aria-label="Темы уроков">
          ${FILTERS.map(([id, label]) => {
            const n = id === "all" ? LESSONS.length : LESSONS.filter(l => l.track === id).length;
            return `<button type="button" data-track="${id}" aria-pressed="${P.track === id}">${label}<span class="lrn-count" aria-hidden="true">${n}</span></button>`;
          }).join("")}
        </div>
        ${groups.map(([k, ls]) => `<section class="lrn-group" aria-labelledby="lrnG-${k}">
            <h3 class="lrn-group-title" id="lrnG-${k}">${esc(TRACKS[k].title)}<span>${ls.length} ${plural(ls.length, ["урок", "урока", "уроков"])}</span></h3>
            <ul class="lrn-grid">${ls.map(cardHtml).join("")}</ul>
          </section>`).join("")}
      </div>`;
    }

    /* ── reader ────────────────────────────────────── */
    function optMark(state) { return state === "right" ? icon("Check") : state === "wrong" ? icon("X") : ""; }
    function questionHtml(l, q, qi) {
      const a = answers(l.id)[qi];
      const answered = Number.isInteger(a);
      const qid = `lrnQ-${l.id}-${qi}`;
      const opts = q.options.map((o, oi) => {
        const st = !answered ? "" : oi === q.correct ? "right" : oi === a ? "wrong" : "rest";
        const note = !answered ? "" : oi === q.correct ? (oi === a ? " — ваш ответ, верно" : " — верный ответ") : oi === a ? " — ваш ответ, неверно" : "";
        return `<button type="button" class="lrn-opt${st ? " is-" + st : ""}" data-q="${qi}" data-o="${oi}"${answered ? ' aria-disabled="true"' : ""}>
            <span class="lrn-opt-mark" aria-hidden="true">${optMark(st)}</span><span class="lrn-opt-text">${t(o)}</span><span class="sr">${note}</span>
          </button>`;
      }).join("");
      return `<div class="lrn-q" role="group" aria-labelledby="${qid}" data-qbox="${qi}">
          <p class="lrn-q-text" id="${qid}"><span class="lrn-q-n" aria-hidden="true">${qi + 1}</span><span>${t(q.q)}</span></p>
          <div class="lrn-opts">${opts}</div>
          <div class="lrn-fb" aria-live="polite">${answered ? feedbackHtml(q, a) : ""}</div>
        </div>`;
    }
    function feedbackHtml(q, a) {
      const ok = a === q.correct;
      return `<div class="lrn-fb-box ${ok ? "is-right" : "is-wrong"}">
          <p class="lrn-fb-title">${icon(ok ? "CircleCheck" : "CircleAlert")}${ok ? "Верно!" : `Не совсем. Верный ответ: «${t(q.options[q.correct])}»`}</p>
          <p>${t(q.explain)}</p></div>`;
    }
    function scoreText(l) {
      const sc = quizScore(l);
      if (!sc.total) return "";
      if (sc.answered < sc.total) return `${sc.answered} из ${sc.total} ${plural(sc.total, ["вопроса", "вопросов", "вопросов"])}`;
      return sc.right === sc.total ? `Все ответы верные: ${sc.right} из ${sc.total}` : `Верно: ${sc.right} из ${sc.total}`;
    }
    function doneBtnHtml(id) {
      return isDone(id)
        ? `${icon("CircleCheck")}<span>Пройдено</span><span class="lrn-done-undo">· снять отметку</span>`
        : `${icon("Check")}<span>Отметить пройденным</span>`;
    }
    function renderReader(l) {
      const idx = LESSONS.indexOf(l);
      const next = LESSONS[idx + 1] || null;
      const prev = LESSONS[idx - 1] || null;
      const checked = checkedLabel(l.checked);
      const sc = quizScore(l);
      const sections = (l.sections || []).map(s => `<section class="lrn-sec">
          ${s.h ? `<h3>${t(s.h)}</h3>` : ""}
          ${(s.p || []).map(p => `<p>${t(p)}</p>`).join("")}
          ${s.list && s.list.length ? `<ul>${s.list.map(i => `<li>${t(i)}</li>`).join("")}</ul>` : ""}
        </section>`).join("");
      const tryIt = tryAvailable(l) ? `<section class="lrn-try" aria-labelledby="lrnTry">
          <span class="lrn-try-ic" aria-hidden="true">${icon("Sparkles")}</span>
          <div class="lrn-try-main"><h3 id="lrnTry">Попробуйте в приложении</h3><p>${t(l.tryIt.label)}</p>
            <p class="lrn-try-hint">Урок останется открытым во вкладке «Обучение».</p></div>
          <button type="button" class="btn btn-primary lrn-try-btn" data-try>${icon("Play")}Попробовать в приложении</button>
        </section>` : "";
      const sources = (l.sources || []).filter(s => s && /^https:\/\//.test(s.url));
      el.innerHTML = `<div class="lrn"><article class="lrn-reader" aria-labelledby="lrnLessonTitle">
        <div class="lrn-bar">
          <button type="button" class="btn btn-quiet lrn-back" data-back>${icon("ChevronLeft")}Все уроки</button>
          <span class="lrn-pos">Урок ${idx + 1} из ${LESSONS.length}</span>
        </div>
        <header class="lrn-hero">
          <span class="lrn-ic lrn-ic-lg tone-${esc(l.track)}">${icon(l.icon)}</span>
          <div class="lrn-hero-main">
            <p class="eyebrow">${esc(TRACKS[l.track].label)} · ${esc(l.minutes)} мин</p>
            <h2 class="lrn-title" id="lrnLessonTitle" tabindex="-1">${t(l.title)}</h2>
            <p class="lrn-lead">${t(l.summary)}</p>
          </div>
        </header>
        <div class="card lrn-body">${sections}</div>
        ${l.takeaways && l.takeaways.length ? `<section class="lrn-takeaways" aria-labelledby="lrnTk">
            <h3 id="lrnTk">${icon("Lightbulb")}Главное</h3>
            <ul>${l.takeaways.map(k => `<li>${icon("Check")}<span>${t(k)}</span></li>`).join("")}</ul>
          </section>` : ""}
        ${l.quiz && l.quiz.length ? `<section class="card lrn-quiz" aria-labelledby="lrnQz">
            <div class="lrn-quiz-head"><h3 id="lrnQz">Проверьте себя</h3><p class="lrn-score" id="lrnScore">${esc(scoreText(l))}</p></div>
            <p class="lrn-quiz-hint">Нажмите на вариант ответа — сразу появится объяснение.</p>
            ${l.quiz.map((q, qi) => questionHtml(l, q, qi)).join("")}
            <div class="lrn-quiz-foot"${sc.answered ? "" : " hidden"}><button type="button" class="btn btn-quiet btn-sm" data-reset>${icon("RotateCcw")}Пройти тест заново</button></div>
          </section>` : ""}
        ${tryIt}
        ${sources.length ? `<section class="lrn-sources" aria-labelledby="lrnSrc">
            <h3 id="lrnSrc">Источники</h3>
            <ul>${sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${icon("ExternalLink")}<span>${t(s.title)}</span><span class="sr"> (откроется в новом окне)</span></a></li>`).join("")}</ul>
            ${checked ? `<p class="lrn-checked">Суммы и правила проверены по этим источникам: ${checked}. Перед решениями уточняйте актуальные данные.</p>` : ""}
          </section>` : ""}
        <div class="lrn-foot">
          <button type="button" class="btn ${isDone(l.id) ? "btn-ghost is-done" : "btn-primary"} lrn-done" data-done aria-pressed="${isDone(l.id)}">${doneBtnHtml(l.id)}</button>
          <div class="lrn-nav">
            ${prev ? `<button type="button" class="lrn-step" data-open="${esc(prev.id)}" aria-label="Предыдущий урок: ${esc(prev.title)}">${icon("ChevronLeft")}<span><small>Назад</small><span class="lrn-step-title">${t(prev.title)}</span></span></button>` : "<span></span>"}
            ${next ? `<button type="button" class="lrn-step is-next" data-open="${esc(next.id)}" aria-label="Следующий урок: ${esc(next.title)}"><span><small>Дальше</small><span class="lrn-step-title">${t(next.title)}</span></span>${icon("ChevronRight")}</button>` : ""}
          </div>
        </div>
      </article></div>`;
    }

    /* ── navigation ────────────────────────────────── */
    function scrollToTop() {
      const top = el.getBoundingClientRect().top + window.scrollY - 12;
      if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    }
    function open(id) {
      const l = byId[id];
      if (!l) return;
      if (!S.lesson) S.listScroll = window.scrollY;
      S.lesson = id;
      if (!P.seen[id]) { P.seen[id] = Date.now(); save(); }
      renderReader(l);
      scrollToTop();
      const h = el.querySelector("#lrnLessonTitle");
      if (h) h.focus({ preventScroll: true });
    }
    function back() {
      const was = S.lesson;
      S.lesson = null;
      renderList();
      window.scrollTo({ top: S.listScroll, behavior: "auto" });
      const card = was && el.querySelector(`.lrn-card[data-open="${CSS.escape(was)}"]`);
      (card || el.querySelector("#lrnListTitle"))?.focus({ preventScroll: !!card });
    }
    function answer(qi, oi) {
      const l = byId[S.lesson];
      const q = l && l.quiz && l.quiz[qi];
      if (!q || !(oi >= 0 && oi < q.options.length) || Number.isInteger(answers(l.id)[qi])) return;
      P.quiz[l.id] = { ...answers(l.id), [qi]: oi };
      save();
      // update the question in place, so focus stays put and the live region announces the feedback
      const box = el.querySelector(`[data-qbox="${qi}"]`);
      if (!box) return;
      box.querySelectorAll(".lrn-opt").forEach(b => {
        const i = +b.dataset.o;
        const st = i === q.correct ? "right" : i === oi ? "wrong" : "rest";
        b.classList.add("is-" + st);
        b.setAttribute("aria-disabled", "true");
        b.querySelector(".lrn-opt-mark").innerHTML = optMark(st);
        b.querySelector(".sr").textContent = i === q.correct ? (i === oi ? " — ваш ответ, верно" : " — верный ответ") : i === oi ? " — ваш ответ, неверно" : "";
      });
      box.querySelector(".lrn-fb").innerHTML = feedbackHtml(q, oi);
      const score = el.querySelector("#lrnScore");
      if (score) score.textContent = scoreText(l);
      const foot = el.querySelector(".lrn-quiz-foot");
      if (foot) foot.hidden = false;
    }
    function resetQuiz() {
      const l = byId[S.lesson];
      if (!l) return;
      delete P.quiz[l.id];
      save();
      const y = window.scrollY;
      renderReader(l);
      window.scrollTo({ top: y, behavior: "auto" });
      el.querySelector(".lrn-opt")?.focus({ preventScroll: true });
    }
    function toggleDone() {
      const l = byId[S.lesson];
      if (!l) return;
      if (isDone(l.id)) delete P.done[l.id];
      else P.done[l.id] = Date.now();
      save();
      const b = el.querySelector("[data-done]");
      if (b) {
        b.innerHTML = doneBtnHtml(l.id);
        b.setAttribute("aria-pressed", String(isDone(l.id)));
        b.classList.toggle("btn-primary", !isDone(l.id));
        b.classList.toggle("btn-ghost", isDone(l.id));
        b.classList.toggle("is-done", isDone(l.id));
      }
      if (isDone(l.id)) {
        const left = LESSONS.filter(x => !isDone(x.id)).length;
        toast(left ? `Урок пройден. Осталось ${left} ${plural(left, ["урок", "урока", "уроков"])}` : "Все уроки пройдены — отличная работа!");
      } else toast("Отметка снята");
    }
    function runTry() {
      const l = byId[S.lesson];
      if (!l || !l.tryIt) return;
      const a = ACTIONS[l.tryIt.action];
      try {
        if (a && typeof actions[a.fn] === "function") {
          if (typeof actions.setView === "function") actions.setView(a.view);
          actions[a.fn](...a.args());
        } else if (typeof actions[l.tryIt.action] === "function") actions[l.tryIt.action]();
      } catch (e) { console.error(e); toast("Не получилось открыть окно приложения"); }
    }

    el.addEventListener("click", e => {
      const b = e.target.closest("button, a");
      if (!b || !el.contains(b)) return;
      if (b.dataset.open) { open(b.dataset.open); return; }
      if (b.dataset.track) {
        if (P.track === b.dataset.track) return;
        P.track = b.dataset.track; save();
        renderList();
        el.querySelector(`[data-track="${CSS.escape(P.track)}"]`)?.focus({ preventScroll: true });
        return;
      }
      if (b.hasAttribute("data-back")) { back(); return; }
      if (b.dataset.q != null) { answer(+b.dataset.q, +b.dataset.o); return; }
      if (b.hasAttribute("data-reset")) { resetQuiz(); return; }
      if (b.hasAttribute("data-done")) { toggleDone(); return; }
      if (b.hasAttribute("data-try")) { runTry(); return; }
    });

    el.classList.add("lrn-view");
    renderList();
  }

  window.BudgetLearn = { mount };
})();
