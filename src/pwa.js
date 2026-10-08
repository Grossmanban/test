/* PWA-only UI of «Домашняя бухгалтерия»: the sync status button (#pwaTop), the account dialog
   (sync setup → sign-in / sign-up → account, password recovery), backup export / import, the install
   banner (#pwaBanner) and the service-worker update prompt.
   Runs after app.js and talks only to window.BudgetApp, store.sync, store.backup and snap.sync
   (docs/ARCHITECTURE.md). Every icon name appears literally, either as an icon(…) argument or as an
   `icon:` property, so that tools/icons-subset.mjs picks it up. */
(() => {
  "use strict";
  const App = window.BudgetApp;
  if (!App || !App.store || !(App.store.sync || App.store.backup)) return;
  const { store, icon, esc, toast } = App;
  const sync = store.sync || null;
  const backup = store.backup || null;
  const $ = (s, r = document) => r.querySelector(s);

  const GUIDE_URL = "https://github.com/Grossmanban/test/blob/main/supabase/README.md";
  const LS_INSTALL = "budget-pwa-install-hidden";
  const SNOOZE_MS = 30 * 864e5;
  const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
  const FALLBACK_ERR = "Не удалось выполнить действие. Повторите попытку.";

  const nav = window.navigator;
  const UA = nav.userAgent || "";
  // iPadOS 13+ reports a Mac user agent; only the touch points give it away
  const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && nav.maxTouchPoints > 1);
  const IS_IOS_SAFARI = IS_IOS && /Safari\//.test(UA) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|GSA\/|DuckDuckGo|Mercury/.test(UA);
  const mq = q => { try { return window.matchMedia(q).matches; } catch (e) { return false; } };
  const isStandalone = () => nav.standalone === true || mq("(display-mode: standalone)") || mq("(display-mode: fullscreen)");

  /* ── small helpers ─────────────────────────── */
  const pad = n => String(n).padStart(2, "0");
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many;
  }
  const nChanges = n => `${n} ${plural(n, "изменение", "изменения", "изменений")}`;
  const nOps = n => `${n} ${plural(n, "операция", "операции", "операций")}`;
  function ago(ms) {
    const now = Date.now(), d = now - ms;
    if (d < 60e3) return "только что";
    if (d < 3600e3) return `${Math.floor(d / 60e3)} мин назад`;
    if (d < 6 * 3600e3) return `${Math.floor(d / 3600e3)} ч назад`;
    const t = new Date(ms), today = new Date(now), hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    if (isoDay(t) === isoDay(today)) return `сегодня в ${hm}`;
    if (isoDay(t) === isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return `вчера в ${hm}`;
    const opts = t.getFullYear() === today.getFullYear() ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" };
    return `${t.toLocaleDateString("ru-RU", opts)} в ${hm}`;
  }
  function hostOf(url) { try { return new URL(url).host; } catch (e) { return String(url || ""); } }
  const errMsg = e => (e && e.code && e.message ? String(e.message) : FALLBACK_ERR);
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  /* ── state ─────────────────────────────────── */
  const U = {
    sy: null,             // last snap.sync (null until the first snapshot)
    status: "loading",    // last snap.status
    view: "",             // rendered dialog view
    key: "",              // structure key of the rendered view
    authMode: "signin",   // "signin" | "signup"
    email: "",            // email typed in the sign-in form (survives re-renders and sign-out)
    sent: null,           // { email } after a sign-up that needs email confirmation
    editConfig: false,    // signed out, user asked to change the project
    confirmOut: false,    // sign-out confirm open
    confirmOff: false,    // "disconnect sync" confirm open
    flash: null,          // { kind: "good" | "warn", text } one-off message at the top of the view
    bk: null,             // { kind: "good" | "err", text } backup result
    busy: false,
    recoveryOpened: false,
    waiting: null,        // service worker waiting to take over
    updating: false,
    version: "",
    btnKey: "",
    ticker: 0,
  };

  /* ── sync status button (#pwaTop) ──────────── */
  // how each phase looks in the top bar; tone drives the status dot colour
  const LOOK = {
    off: { icon: "Cloud", tone: "off" },
    idle: { icon: "Cloud", tone: "ok" },
    syncing: { icon: "RefreshCw", tone: "busy" },
    offline: { icon: "CloudOff", tone: "warn" },
    error: { icon: "CloudAlert", tone: "err" },
    recovery: { icon: "KeyRound", tone: "warn" },
  };
  function buttonLook(sy) {
    if (!sync || !sy) return { ...LOOK.off, phase: "off", label: "Резервная копия и синхронизация", badge: "" };
    if (sy.recovery) return { ...LOOK.recovery, phase: "recovery", label: "Синхронизация: задайте новый пароль", badge: "" };
    if (sy.configured && !sy.available) return { ...LOOK.error, phase: "error", label: `Синхронизация недоступна: ${sy.error || "модуль не загрузился"}`, badge: "" };
    if (!sy.configured) return { ...LOOK.off, phase: "off", label: "Синхронизация не настроена", badge: "" };
    if (!sy.user) return { ...LOOK.off, phase: "off", label: "Синхронизация: войдите в аккаунт", badge: "" };
    const n = sy.pending || 0;
    const tail = n > 0 ? `, не отправлено: ${nChanges(n)}` : "";
    const badge = n > 0 && (sy.phase === "offline" || sy.phase === "error") ? (n > 99 ? "99+" : String(n)) : "";
    switch (sy.phase) {
      case "syncing": return { ...LOOK.syncing, phase: "syncing", label: "Синхронизация: идёт обмен данными" + tail, badge };
      case "offline": return { ...LOOK.offline, phase: "offline", label: "Синхронизация: нет сети, изменения сохранятся на устройстве" + tail, badge };
      case "error": return { ...LOOK.error, phase: "error", label: `Синхронизация: ошибка${sy.error ? ` — ${sy.error}` : ""}` + tail, badge };
      default: return n > 0
        ? { ...LOOK.idle, tone: "busy", phase: "idle", label: "Синхронизация" + tail, badge }
        : { ...LOOK.idle, phase: "idle", label: "Синхронизация: всё сохранено", badge };
    }
  }

  const top = $("#pwaTop");
  let syncBtn = null;
  if (top) {
    top.insertAdjacentHTML("beforeend",
      `<button type="button" class="icon-btn pwa-sync" id="pwaSync" aria-haspopup="dialog" data-tone="off" data-phase="off">` +
      `<span class="pwa-sync-ic"></span><span class="pwa-dot" aria-hidden="true"></span></button>`);
    syncBtn = $("#pwaSync", top);
    syncBtn.addEventListener("click", () => openDlg());
  }
  function renderButton() {
    if (!syncBtn) return;
    const look = buttonLook(U.sy);
    const k = JSON.stringify(look);
    if (k === U.btnKey) return;
    const prevIcon = U.btnKey ? JSON.parse(U.btnKey).icon : "";
    U.btnKey = k;
    syncBtn.dataset.tone = look.tone;
    syncBtn.dataset.phase = look.phase;
    syncBtn.setAttribute("aria-label", look.label);
    syncBtn.title = look.label;
    if (prevIcon !== look.icon) $(".pwa-sync-ic", syncBtn).innerHTML = icon(look.icon);
    const dot = $(".pwa-dot", syncBtn);
    dot.textContent = look.badge;
    dot.classList.toggle("is-count", !!look.badge);
  }

  /* ── account dialog ────────────────────────── */
  const dlg = document.createElement("dialog");
  dlg.id = "pwaDlg";
  dlg.className = "pwa-dlg";
  dlg.setAttribute("aria-labelledby", "pwaTitle");
  dlg.innerHTML = `<div class="dlg">
    <div class="dlg-head">
      <h2 id="pwaTitle" tabindex="-1">Синхронизация</h2>
      <button type="submit" class="btn btn-sm btn-primary dlg-kb-save" id="pwaKbSave" form="pwaForm" hidden>Сохранить</button>
      <button type="button" class="icon-btn" data-close aria-label="Закрыть">${icon("X")}</button>
    </div>
    <div class="pwa-view" id="pwaView"></div>
    <div id="pwaUpdate"></div>
    <section class="pwa-sec" aria-labelledby="pwaBkTitle">
      <h3 id="pwaBkTitle">Резервная копия</h3>
      <p class="hint">Файл со всеми операциями и настройками бюджета.${IS_IOS ? " В окне «Поделиться» выберите «Сохранить в Файлы»." : ""}
        Загрузка копии добавляет недостающие записи и обновляет устаревшие — ничего не удаляет.</p>
      <div class="pwa-two">
        <button type="button" class="btn btn-ghost" data-act="export">${icon("Download")}Сохранить копию</button>
        <button type="button" class="btn btn-ghost" data-act="import">${icon("Upload")}Загрузить копию</button>
      </div>
      <div id="pwaBkMsg" role="status"></div>
      <input type="file" id="pwaFile" accept="application/json,.json" hidden>
    </section>
    <p class="hint pwa-ver" id="pwaVer" hidden></p>
  </div>`;
  document.body.appendChild(dlg);
  App.enhanceDialog(dlg);
  const viewEl = $("#pwaView", dlg);

  function viewOf(sy) {
    if (!sync || !sy) return "basic";
    if (sy.recovery) return "recovery";
    if (sy.user) return "account";
    if (!sy.configured || U.editConfig) return "config";
    return "auth";
  }
  function titleOf(v, sy) {
    switch (v) {
      case "config": return sy && sy.configured ? "Проект синхронизации" : "Синхронизация";
      case "auth": return U.sent ? "Подтвердите почту" : U.authMode === "signup" ? "Новый аккаунт" : "Вход в аккаунт";
      case "account": return "Аккаунт";
      case "recovery": return "Новый пароль";
      default: return "Резервная копия";
    }
  }
  function submitLabel(v) {
    if (v === "auth") return U.authMode === "signup" && !U.sent ? "Создать" : "Войти";
    if (v === "config" || v === "recovery") return "Сохранить";
    return "";
  }

  /* view markup */
  const eye = id => `<button type="button" class="icon-btn pwa-eye" data-act="eye" aria-controls="${id}" aria-pressed="false" aria-label="Показать пароль">${icon("Eye")}</button>`;
  function guideHtml() {
    return `<div class="pwa-guide">
      <p class="hint">Как создать проект и где взять ключ — <a href="${GUIDE_URL}" target="_blank" rel="noopener">пошаговая инструкция</a>
        (около 10 минут, бесплатно). Если ссылка не открывается, скопируйте адрес:</p>
      <div class="pwa-url"><code id="pwaGuideUrl">${GUIDE_URL}</code>
        <button type="button" class="icon-btn" data-act="copy" aria-label="Скопировать адрес инструкции">${icon("Copy")}</button></div>
    </div>`;
  }
  function projectHtml(sy) {
    if (!sy.url) return "";
    const change = sy.configSource === "device" && !sy.user
      ? ` · <button type="button" class="pwa-link" data-act="cfg-edit">Изменить</button>` : "";
    return `<p class="hint pwa-proj">Проект Supabase: <b>${esc(hostOf(sy.url))}</b>${change}</p>`;
  }
  function viewHtml(v, sy) {
    if (v === "config") {
      const editing = !!sy.configured;
      const canOff = editing && sy.configSource === "device";
      return `<form class="pwa-form" id="pwaForm" data-form="config" novalidate>
        <div id="pwaFlash"></div>
        <div id="pwaSyErr"></div>
        <p class="pwa-lead">${editing
          ? "Укажите другой проект Supabase или отключите синхронизацию на этом устройстве."
          : "С синхронизацией у вас один бюджет на iPhone и iPad, а в облаке хранится копия всех операций. Для неё нужен ваш личный бесплатный проект Supabase: данные хранятся только там."}</p>
        ${guideHtml()}
        <label class="field"><span>Адрес проекта (Project URL)</span>
          <input class="input" id="pwaUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" placeholder="https://abcd.supabase.co" value="${esc(sy.url || "")}"></label>
        <label class="field"><span>Публичный ключ (anon / publishable)</span>
          <input class="input" id="pwaKey" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="sb_publishable_… или eyJ…" aria-describedby="pwaKeyHint">
          <small class="hint" id="pwaKeyHint">В Supabase: Project Settings → API Keys. Секретный ключ (service_role, sb_secret_…) сюда не вводите.</small></label>
        <p class="err" id="pwaErr" role="alert" hidden></p>
        <div class="pwa-actions"${U.confirmOff ? " hidden" : ""}>
          ${canOff ? `<button type="button" class="btn btn-danger" data-act="off-ask">Отключить</button>` : ""}
          <span class="spacer"></span>
          ${editing ? `<button type="button" class="btn btn-quiet" data-act="cfg-cancel">Отмена</button>` : ""}
          <button type="submit" class="btn btn-primary" data-busy="Сохраняем…">Сохранить</button>
        </div>
        ${canOff && U.confirmOff ? `<div class="confirm pwa-confirm" role="group" aria-labelledby="pwaOffQ">
          <p class="pwa-confirm-q" id="pwaOffQ">Отключить синхронизацию на этом устройстве?</p>
          <p>Бюджет останется на устройстве, но перестанет синхронизироваться. В облаке ничего не удалится.</p>
          <div class="pwa-actions"><span class="spacer"></span>
            <button type="button" class="btn btn-sm btn-quiet" data-act="off-no">Отмена</button>
            <button type="button" class="btn btn-sm btn-danger-solid" data-act="off-yes" data-busy="Отключаем…">Отключить</button></div>
        </div>` : ""}
      </form>`;
    }
    if (v === "auth") {
      const sent = U.sent;
      const signup = U.authMode === "signup" && !sent;
      return `<form class="pwa-form" id="pwaForm" data-form="auth" novalidate>
        <div id="pwaFlash"></div>
        <div id="pwaSyErr"></div>
        ${sent ? `<div class="pwa-note" role="status">
            <span class="pwa-note-ic">${icon("MailCheck")}</span>
            <div><p><b>Мы отправили письмо на ${esc(sent.email)}</b></p>
              <p>Откройте ссылку из письма, чтобы подтвердить почту. Ссылка откроется в браузере — после этого вернитесь сюда и войдите с этой почтой и паролем.</p>
              <p class="hint">Письма нет? Проверьте «Спам» и подождите пару минут. Если аккаунт с этой почтой уже был, просто войдите.</p></div>
          </div>`
          : `<p class="pwa-lead">${signup
            ? "Один аккаунт для всех ваших устройств: на iPhone и iPad будет один и тот же бюджет. Операции, которые уже есть на этом устройстве, перейдут в аккаунт."
            : "Войдите, чтобы вести один бюджет на iPhone и iPad. Операции, которые уже есть на этом устройстве, сохранятся в аккаунте."}</p>`}
        ${sent ? "" : `<div class="seg seg-wide seg-2" role="radiogroup" aria-label="Вход или новый аккаунт">
          <label><input type="radio" name="pwaMode" id="pwaModeIn" value="signin"${signup ? "" : " checked"}><span>Войти</span></label>
          <label><input type="radio" name="pwaMode" id="pwaModeUp" value="signup"${signup ? " checked" : ""}><span>Создать аккаунт</span></label>
        </div>`}
        <label class="field"><span>Почта</span>
          <input class="input" id="pwaEmail" type="email" inputmode="email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" value="${esc(U.email)}"></label>
        <div class="field"><span><label for="pwaPass">Пароль</label></span>
          <div class="pwa-pass"><input class="input" id="pwaPass" type="password" autocomplete="${signup ? "new-password" : "current-password"}" enterkeyhint="go" autocapitalize="none" autocorrect="off" spellcheck="false"${signup ? ` minlength="6" aria-describedby="pwaPassHint"` : ""}>${eye("pwaPass")}</div>
          ${signup ? `<small class="hint" id="pwaPassHint">Не короче 6 символов. Этот пароль понадобится на каждом устройстве.</small>` : ""}
        </div>
        <p class="err" id="pwaErr" role="alert" hidden></p>
        <div class="pwa-stack">
          <button type="submit" class="btn btn-primary" data-busy="${signup ? "Создаём аккаунт…" : "Входим…"}">${signup ? "Создать аккаунт" : "Войти"}</button>
          ${signup ? "" : `<button type="button" class="btn btn-quiet" data-act="forgot" data-busy="Отправляем письмо…">Забыли пароль?</button>`}
          ${sent ? `<button type="button" class="btn btn-quiet" data-act="sent-back">Указать другую почту</button>` : ""}
        </div>
        ${projectHtml(sy)}
      </form>`;
    }
    if (v === "account") {
      return `<div class="pwa-form">
        <div id="pwaFlash"></div>
        <div class="pwa-user">
          <span class="pwa-avatar">${icon("CircleUserRound")}</span>
          <div class="pwa-user-txt"><small>Вы вошли как</small><b class="pwa-email">${esc(sy.user.email || "без почты")}</b></div>
        </div>
        <div id="pwaStatus"></div>
        <p class="err" id="pwaErr" role="alert" hidden></p>
        <div class="pwa-actions"${U.confirmOut ? " hidden" : ""}>
          <button type="button" class="btn btn-ghost" data-act="sync" id="pwaSyncNow" data-busy="Синхронизация…">${icon("RefreshCw")}Синхронизировать сейчас</button>
          <span class="spacer"></span>
          <button type="button" class="btn btn-danger" data-act="out-ask">${icon("LogOut")}Выйти</button>
        </div>
        ${U.confirmOut ? `<div class="confirm pwa-confirm" role="group" aria-labelledby="pwaOutQ">
          <p class="pwa-confirm-q" id="pwaOutQ">Выйти из аккаунта на этом устройстве?</p>
          <p>Бюджет останется в облаке, а с этого устройства будет удалён. Чтобы вернуть его, снова войдите.</p>
          <div id="pwaOutWarn"></div>
          <div class="pwa-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-act="export" id="pwaOutSave" hidden>${icon("Download")}Сохранить копию</button>
            <span class="spacer"></span>
            <button type="button" class="btn btn-sm btn-quiet" data-act="out-no">Отмена</button>
            <button type="button" class="btn btn-sm btn-danger-solid" data-act="out-yes" data-busy="Выходим…">Выйти</button></div>
        </div>` : ""}
        ${projectHtml(sy)}
      </div>`;
    }
    if (v === "recovery") {
      const email = sy.user ? sy.user.email : "";
      return `<form class="pwa-form" id="pwaForm" data-form="recovery" novalidate>
        <div id="pwaSyErr"></div>
        <div class="pwa-note">
          <span class="pwa-note-ic">${icon("KeyRound")}</span>
          <div><p><b>Смена пароля${email ? ` для ${esc(email)}` : ""}</b></p>
            <p>Придумайте новый пароль. Потом войдите с ним на остальных устройствах.</p></div>
        </div>
        ${email ? `<input type="email" class="sr" autocomplete="username" value="${esc(email)}" tabindex="-1" aria-hidden="true" readonly>` : ""}
        <div class="field"><span><label for="pwaNew">Новый пароль</label></span>
          <div class="pwa-pass"><input class="input" id="pwaNew" type="password" autocomplete="new-password" minlength="6" enterkeyhint="next" autocapitalize="none" autocorrect="off" spellcheck="false" aria-describedby="pwaNewHint">${eye("pwaNew")}</div>
          <small class="hint" id="pwaNewHint">Не короче 6 символов.</small></div>
        <div class="field"><span><label for="pwaNew2">Повторите пароль</label></span>
          <input class="input" id="pwaNew2" type="password" autocomplete="new-password" enterkeyhint="done" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
        <p class="err" id="pwaErr" role="alert" hidden></p>
        <div class="pwa-stack"><button type="submit" class="btn btn-primary" data-busy="Сохраняем…">Сохранить пароль</button></div>
      </form>`;
    }
    return `<p class="pwa-lead">Сохраните копию бюджета в файл или загрузите сохранённую раньше.</p>`;
  }

  /* dynamic parts (no inputs inside, safe to replace while the user types) */
  const STATUS = {
    syncing: { icon: "RefreshCw", cls: "is-busy" },
    offline: { icon: "CloudOff", cls: "is-warn" },
    error: { icon: "CloudAlert", cls: "is-err" },
    idle: { icon: "CircleCheck", cls: "is-good" },
    warn: { icon: "TriangleAlert", cls: "is-warn" },
    good: { icon: "CircleCheck", cls: "is-good" },
    err: { icon: "CircleAlert", cls: "is-err" },
  };
  function statusBox(kind, title, lines = []) {
    const st = STATUS[kind] || STATUS.warn;
    return `<div class="status pwa-status ${st.cls}">${icon(st.icon)}<div><b>${esc(title)}</b>${lines.filter(Boolean).map(l => `<span>${esc(l)}</span>`).join("")}</div></div>`;
  }
  function syncStatusHtml(sy) {
    const n = sy.pending || 0;
    const last = sy.lastSyncAt ? ago(sy.lastSyncAt) : "";
    const pend = n > 0 ? `Не отправлено в облако: ${nChanges(n)}` : "";
    if (!sy.available) return statusBox("error", `Ошибка: ${sy.error || "модуль синхронизации не загрузился"}`, [pend]);
    switch (sy.phase) {
      case "syncing": return statusBox("syncing", "Синхронизация…", [last && `Последняя: ${last}`, pend]);
      case "offline": return statusBox("offline", "Нет сети — изменения сохранятся на устройстве", [last && `Последняя синхронизация: ${last}`, pend]);
      case "error": return statusBox("error", `Ошибка: ${sy.error || "не удалось синхронизировать"}`, [last && `Последняя синхронизация: ${last}`, pend]);
      default: return statusBox("idle", last ? `Синхронизировано · ${last}` : "Подключено · ещё не синхронизировано", [pend]);
    }
  }
  function swapHtml(el, html) {
    if (!el || el.__html === html) return;
    const a = document.activeElement;
    const act = a && el.contains(a) && a.dataset ? a.dataset.act : "";
    el.__html = html;
    el.innerHTML = html;
    if (act) { const t = el.querySelector(`[data-act="${act}"]`); (t || $("#pwaTitle", dlg)).focus({ preventScroll: true }); }
  }
  function updateDynamic() {
    const sy = U.sy, v = U.view;
    $("#pwaTitle", dlg).textContent = titleOf(v, sy);
    const kb = $("#pwaKbSave", dlg), label = submitLabel(v);
    kb.hidden = !label || !$("#pwaForm", dlg);
    kb.textContent = label || "Сохранить";
    kb.disabled = U.busy;

    swapHtml($("#pwaFlash", dlg), U.flash ? statusBox(U.flash.kind, U.flash.text) : "");
    if (sy) {
      const showErr = sy.error && (v === "auth" || v === "config" || v === "recovery");
      swapHtml($("#pwaSyErr", dlg), showErr ? statusBox("warn", sy.error) : "");
      if (v === "account") {
        swapHtml($("#pwaStatus", dlg), syncStatusHtml(sy));
        const n = sy.pending || 0;
        const risk = sy.phase === "offline"
          ? "Сейчас нет сети — если выйти, они пропадут. Дождитесь синхронизации или сначала сохраните копию."
          : "Перед выходом приложение попробует их отправить; если не получится, они пропадут. Надёжнее сначала сохранить копию.";
        swapHtml($("#pwaOutWarn", dlg), n > 0 ? `<p class="pwa-loud">${icon("TriangleAlert")}<span>Ещё не отправлено в облако: ${esc(nChanges(n))}. ${risk}</span></p>` : "");
        const save = $("#pwaOutSave", dlg);
        if (save) save.hidden = !(n > 0);
        const now = $("#pwaSyncNow", dlg);
        if (now && !now.hasAttribute("aria-busy")) now.disabled = sy.phase === "syncing" || !sy.available;
      }
    }
    swapHtml($("#pwaUpdate", dlg), U.waiting ? `<div class="status is-good pwa-status pwa-update">${icon("Sparkles")}<div><b>Доступна новая версия приложения</b><span>Обновление займёт пару секунд, данные сохранятся.</span></div>
      <button type="button" class="btn btn-sm btn-primary" data-act="update">Обновить</button></div>` : "");
    swapHtml($("#pwaBkMsg", dlg), U.bk ? statusBox(U.bk.kind, U.bk.text) : "");
    const ver = $("#pwaVer", dlg);
    ver.hidden = !U.version;
    ver.textContent = U.version ? `Версия приложения: ${U.version}` : "";
  }

  /* structure: re-rendered only when the view (or one of its modes) changes; typed values and focus survive */
  function render(fresh) {
    const sy = U.sy, v = viewOf(sy);
    const key = JSON.stringify([v, U.authMode, U.sent && U.sent.email, U.confirmOut, U.confirmOff,
      sy && [sy.configured, sy.configSource, sy.url, sy.available, sy.user && sy.user.email]]);
    if (fresh || key !== U.key) {
      const keep = {};
      const a = document.activeElement;
      const focusInside = !!a && viewEl.contains(a);
      const focusSel = !focusInside ? "" : a.id ? `#${a.id}` : a.dataset && a.dataset.act ? `[data-act="${a.dataset.act}"]` : "";
      if (!fresh) viewEl.querySelectorAll("input.input[id]").forEach(i => { keep[i.id] = i.value; });
      U.key = key;
      U.view = v;
      viewEl.innerHTML = viewHtml(v, sy);
      for (const id in keep) { const i = viewEl.querySelector(`#${id}`); if (i) i.value = keep[id]; }
      if (focusInside) {
        const t = focusSel && viewEl.querySelector(focusSel);
        (t && !t.closest("[hidden]") ? t : $("#pwaTitle", dlg)).focus({ preventScroll: true });
      }
    }
    updateDynamic();
  }

  function openDlg() {
    if (dlg.open) return;
    U.flash = null; U.bk = null; U.confirmOut = false; U.confirmOff = false; U.editConfig = false;
    render(true);
    dlg.showModal();
    // with a mouse or keyboard, start in the first text field; on touch the keyboard would cover the sheet
    if (!mq("(pointer: coarse)")) { const f = viewEl.querySelector("input.input"); if (f) f.focus(); }
    clearInterval(U.ticker);
    U.ticker = setInterval(() => { if (dlg.open) updateDynamic(); }, 20000);   // «2 мин назад»
  }
  dlg.addEventListener("close", () => {
    clearInterval(U.ticker);
    viewEl.querySelectorAll('input[type="password"]').forEach(i => { i.value = ""; });
    U.confirmOut = false; U.confirmOff = false; U.flash = null;
  });

  function setErr(text) {
    const el = $("#pwaErr", dlg);
    if (!el) { if (text) toast(text); return; }
    el.textContent = text || "";
    el.hidden = !text;
  }
  // runs one action at a time; the button shows its data-busy label meanwhile
  async function run(btn, fn, onError = e => setErr(errMsg(e))) {
    if (U.busy) return;
    U.busy = true;
    setErr("");
    const kb = $("#pwaKbSave", dlg);
    kb.disabled = true;
    let html = "";
    if (btn) {
      html = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      if (btn.dataset.busy) btn.textContent = btn.dataset.busy;
    }
    try { await fn(); }
    catch (e) { onError(e); }
    finally {
      U.busy = false;
      kb.disabled = false;
      if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute("aria-busy"); btn.innerHTML = html; }
      if (dlg.open) updateDynamic();
    }
  }
  const val = id => { const i = $(`#${id}`, dlg); return i ? i.value : ""; };

  /* ── actions ───────────────────────────────── */
  async function submitConfig(btn) {
    await run(btn, async () => {
      await sync.configure({ url: val("pwaUrl").trim(), anonKey: val("pwaKey").trim() });
      U.editConfig = false;
      U.flash = { kind: "good", text: "Проект подключён. Теперь войдите или создайте аккаунт." };
      render();
    });
  }
  async function submitAuth(btn) {
    const email = val("pwaEmail").trim(), pass = val("pwaPass");
    U.email = email;
    if (U.authMode === "signup" && !U.sent) {
      await run(btn, async () => {
        const res = await sync.signUp(email, pass);
        if (res && res.needsConfirm) { U.sent = { email }; U.flash = null; render(); }
        else toast("Аккаунт создан");
      });
    } else {
      await run(btn, async () => {
        await sync.signIn(email, pass);
        U.sent = null; U.flash = null; U.authMode = "signin";
        toast("Вы вошли в аккаунт");
      });
    }
  }
  async function forgot(btn) {
    const email = val("pwaEmail").trim();
    if (!email) {
      setErr("Укажите почту — пришлём на неё ссылку для смены пароля.");
      $("#pwaEmail", dlg).focus();
      return;
    }
    U.email = email;
    await run(btn, async () => {
      await sync.resetPassword(email);
      U.flash = { kind: "good", text: `Письмо со ссылкой для смены пароля отправлено на ${email}. Откройте ссылку, задайте новый пароль и затем войдите здесь.` };
      updateDynamic();
    });
  }
  async function submitRecovery(btn) {
    const p1 = val("pwaNew"), p2 = val("pwaNew2");
    if (p1 && p1 !== p2) { setErr("Пароли не совпадают."); $("#pwaNew2", dlg).focus(); return; }
    await run(btn, async () => {
      await sync.updatePassword(p1);
      U.flash = { kind: "good", text: isStandalone()
        ? "Пароль изменён. На других устройствах войдите с новым паролем."
        : "Пароль изменён. В приложении на экране «Домой» и на других устройствах войдите с новым паролем." };
      toast("Пароль изменён");
      render();
    });
  }
  async function syncNow(btn) {
    await run(btn, async () => {
      await sync.syncNow();
      toast("Синхронизировано");
    });
  }
  async function signOut(btn) {
    const email = U.sy && U.sy.user ? U.sy.user.email : "";
    await run(btn, async () => {
      await sync.signOut();
      U.confirmOut = false;
      U.email = email || U.email;
      U.authMode = "signin";
      U.flash = { kind: "good", text: "Вы вышли из аккаунта. Данные этого аккаунта удалены с устройства и остались в облаке." };
      render();
      toast("Вы вышли из аккаунта");
    });
  }
  async function disconnect(btn) {
    await run(btn, async () => {
      await sync.configure(null);
      U.confirmOff = false;
      U.editConfig = false;
      U.flash = { kind: "good", text: "Синхронизация отключена. Бюджет остался на этом устройстве." };
      render();
    });
  }
  async function copyGuide(btn) {
    let ok = false;
    try { await nav.clipboard.writeText(GUIDE_URL); ok = true; } catch (e) { ok = false; }
    if (!ok) {   // no clipboard access: select the text so the system menu offers «Скопировать»
      const code = $("#pwaGuideUrl", dlg), sel = window.getSelection();
      if (code && sel) { const r = document.createRange(); r.selectNodeContents(code); sel.removeAllRanges(); sel.addRange(r); }
      return;
    }
    btn.innerHTML = icon("Check");
    btn.setAttribute("aria-label", "Адрес скопирован");
    setTimeout(() => { if (btn.isConnected) { btn.innerHTML = icon("Copy"); btn.setAttribute("aria-label", "Скопировать адрес инструкции"); } }, 2000);
  }
  function toggleEye(btn) {
    const show = btn.getAttribute("aria-pressed") !== "true";
    btn.closest("form").querySelectorAll('input[type="password"], input[data-pw]').forEach(i => {
      i.dataset.pw = "1";
      i.type = show ? "text" : "password";
    });
    btn.setAttribute("aria-pressed", String(show));
    btn.setAttribute("aria-label", show ? "Скрыть пароль" : "Показать пароль");
    btn.innerHTML = show ? icon("EyeOff") : icon("Eye");
  }

  /* backup */
  function setBk(kind, text) { U.bk = text ? { kind, text } : null; if (dlg.open) updateDynamic(); }
  async function exportBackup(btn) {
    if (!backup) return;
    if (U.status === "loading") { setBk("err", "Данные ещё загружаются. Подождите секунду и повторите."); return; }
    let data;
    try { data = backup.export(); } catch (e) { setBk("err", errMsg(e)); return; }
    const name = `budget-backup-${isoDay(new Date())}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const what = `${nOps((data && data.tx || []).length)}${data && data.settings ? " и настройки" : ""}`;
    let file = null;
    try { file = new File([blob], name, { type: "application/json" }); } catch (e) { file = null; }
    // iPhone / iPad: the share sheet is the way to «Сохранить в Файлы»; a download link opens a preview there
    let canShare = false;
    try { canShare = !!(file && nav.canShare && nav.canShare({ files: [file] })); } catch (e) { canShare = false; }
    if (canShare && (IS_IOS || mq("(pointer: coarse)"))) {
      btn && (btn.disabled = true);
      try {
        await nav.share({ files: [file], title: name });
        setBk("good", `Копия сохранена: ${name} (${what}).`);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;   // share sheet closed
      } finally { if (btn) btn.disabled = false; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener"; a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setBk("good", `Файл ${name} скачан (${what}). Храните его в надёжном месте.`);
  }
  async function importFile(file) {
    if (!file || !backup) return;
    const btn = $('[data-act="import"]', dlg);
    if (file.size > MAX_BACKUP_BYTES) { setBk("err", "Файл слишком большой для резервной копии бюджета."); return; }
    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text.replace(/^﻿/, ""));
    } catch (e) {
      setBk("err", `«${file.name}» — не резервная копия бюджета: нужен файл .json, сохранённый кнопкой «Сохранить копию».`);
      return;
    }
    setBk("", "");
    await run(btn, async () => {
      const r = await backup.import(data);
      const parts = [];
      if (r.added) parts.push(`новых операций: ${r.added}`);
      if (r.updated) parts.push(`обновлено: ${r.updated}`);
      if (r.settingsUpdated) parts.push("настройки бюджета обновлены");
      const text = parts.length
        ? `Копия загружена — ${parts.join(", ")}${r.skipped ? `; без изменений: ${r.skipped}` : ""}.`
        : `Копия загружена: всё из неё уже есть на этом устройстве${r.skipped ? ` (${nOps(r.skipped)} без изменений)` : ""}.`;
      setBk("good", text);
      toast(text);
    }, e => setBk("err", errMsg(e)));
  }

  /* event wiring (one listener per event type) */
  dlg.addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b || !dlg.contains(b) || b.disabled) return;
    switch (b.dataset.act) {
      case "export": exportBackup(b); break;
      case "import": if (!U.busy) { const f = $("#pwaFile", dlg); f.value = ""; f.click(); } break;
      case "forgot": forgot(b); break;
      case "sync": syncNow(b); break;
      case "out-ask": U.confirmOut = true; render(); { const no = $('[data-act="out-no"]', dlg); if (no) no.focus(); } break;
      case "out-no": U.confirmOut = false; render(); { const o = $('[data-act="out-ask"]', dlg); if (o) o.focus(); } break;
      case "out-yes": signOut(b); break;
      case "cfg-edit": U.editConfig = true; U.flash = null; render(); { const i = $("#pwaUrl", dlg); if (i && !mq("(pointer: coarse)")) i.focus(); else $("#pwaTitle", dlg).focus(); } break;
      case "cfg-cancel": U.editConfig = false; U.confirmOff = false; render(); $("#pwaTitle", dlg).focus(); break;
      case "off-ask": U.confirmOff = true; render(); { const no = $('[data-act="off-no"]', dlg); if (no) no.focus(); } break;
      case "off-no": U.confirmOff = false; render(); { const o = $('[data-act="off-ask"]', dlg); if (o) o.focus(); } break;
      case "off-yes": disconnect(b); break;
      case "sent-back": U.sent = null; U.authMode = "signup"; render(); { const i = $("#pwaEmail", dlg); if (i) i.focus(); } break;
      case "copy": copyGuide(b); break;
      case "eye": toggleEye(b); break;
      case "update": applyUpdate(); break;
    }
  });
  dlg.addEventListener("submit", e => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (U.busy) return;
    if (form.dataset.form === "config") submitConfig(btn);
    else if (form.dataset.form === "auth") submitAuth(btn);
    else if (form.dataset.form === "recovery") submitRecovery(btn);
  });
  dlg.addEventListener("change", e => {
    const t = e.target;
    if (t.name === "pwaMode" && t.checked) { U.authMode = t.value; U.flash = null; setErr(""); render(); }
    else if (t.id === "pwaFile") importFile(t.files && t.files[0]);
  });
  dlg.addEventListener("input", e => {
    if (e.target.id === "pwaEmail") U.email = e.target.value;
    if (e.target.matches("input.input")) setErr("");
  });

  /* ── snapshots ─────────────────────────────── */
  App.onSnapshot(snap => {
    const sy = snap && snap.sync ? snap.sync : null;
    U.sy = sy;
    U.status = snap ? snap.status : "loading";
    if (sy && sy.user && U.sent) { U.sent = null; U.authMode = "signin"; }
    renderButton();
    if (sy && sy.recovery && !U.recoveryOpened) {
      U.recoveryOpened = true;                 // a password-recovery link was opened: ask for the new password
      if (!dlg.open) { openDlg(); return; }
    } else if (!(sy && sy.recovery)) U.recoveryOpened = false;
    if (dlg.open) render();
  });
  renderButton();

  /* ── install banner (#pwaBanner) ───────────── */
  (function initInstall() {
    const host = $("#pwaBanner");
    if (!host) return;
    const snoozed = () => { const t = Number(lsGet(LS_INSTALL)); return t > 0 && Date.now() - t < SNOOZE_MS; };
    let deferred = null;
    const close = `<button type="button" class="icon-btn" data-install="hide" aria-label="Скрыть подсказку об установке">${icon("X")}</button>`;
    function show(kind) {
      host.innerHTML = kind === "ios"
        ? `<div class="notice is-info pwa-install" role="note">${icon("Share")}
            <p>Установите приложение: нажмите <b>«Поделиться»</b> <span class="pwa-share" aria-hidden="true">${icon("Share")}</span>→ <b>«На экран „Домой“»</b></p>${close}</div>`
        : `<div class="notice is-info pwa-install" role="note">${icon("Smartphone")}
            <p><b>Установите приложение</b> — бюджет будет открываться в отдельном окне и работать без интернета.</p>
            <button type="button" class="btn btn-sm btn-primary" data-install="go">${icon("Download")}Установить</button>${close}</div>`;
    }
    const hide = () => { host.innerHTML = ""; };
    host.addEventListener("click", async e => {
      const b = e.target.closest("[data-install]");
      if (!b) return;
      if (b.dataset.install === "hide") { lsSet(LS_INSTALL, String(Date.now())); hide(); return; }
      if (b.dataset.install === "go" && deferred) {
        const ev = deferred;
        deferred = null;
        hide();
        try {
          await ev.prompt();
          const choice = await ev.userChoice;
          if (choice && choice.outcome === "dismissed") lsSet(LS_INSTALL, String(Date.now()));
        } catch (err) { /* the prompt can only be used once */ }
      }
    });
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();             // our banner replaces the browser's own mini-infobar
      deferred = e;
      if (!isStandalone() && !snoozed()) show("prompt");
    });
    window.addEventListener("appinstalled", () => { deferred = null; hide(); });
    if (IS_IOS_SAFARI && !isStandalone() && !snoozed()) show("ios");
  })();

  /* ── service worker: offline shell and updates ── */
  let reg = null;
  let reloading = false;
  function reloadOnce() { if (reloading) return; reloading = true; window.location.reload(); }
  function applyUpdate() {
    const w = U.waiting || (reg && reg.waiting);
    U.updating = true;
    if (!w) { reloadOnce(); return; }
    w.postMessage({ type: "SKIP_WAITING" });
    setTimeout(reloadOnce, 4000);   // controllerchange normally reloads first
  }
  (function initServiceWorker() {
    if (!("serviceWorker" in nav)) return;
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
    if (window.location.protocol !== "https:" && !local) return;
    const swc = nav.serviceWorker;
    const hadController = !!swc.controller;
    let offeredAt = 0;
    swc.addEventListener("controllerchange", () => {
      // the first install also takes control (clients.claim) — that one needs no reload
      if (hadController || U.updating) reloadOnce();
      else askVersion();
    });
    function offer(w) {
      if (!w || !swc.controller || U.updating) return;
      U.waiting = w;
      if (dlg.open) updateDynamic();
      if (Date.now() - offeredAt < 10 * 60e3) return;
      offeredAt = Date.now();
      toast("Доступна новая версия", { label: "Обновить", run: applyUpdate });
    }
    function askVersion() {
      const c = swc.controller;
      if (!c || typeof MessageChannel !== "function") return;
      const ch = new MessageChannel();
      ch.port1.onmessage = e => {
        if (e.data && e.data.version) { U.version = String(e.data.version); if (dlg.open) updateDynamic(); }
      };
      try { c.postMessage({ type: "GET_VERSION" }, [ch.port2]); } catch (e) { /* ignore */ }
    }
    function start() {
      swc.register("./sw.js", { scope: "./" }).then(r => {
        reg = r;
        if (r.waiting) offer(r.waiting);
        r.addEventListener("updatefound", () => {
          const w = r.installing;
          if (!w) return;
          w.addEventListener("statechange", () => { if (w.state === "installed") offer(w); });
        });
        askVersion();
      }).catch(() => { /* no offline support this time; the app still works */ });
    }
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !reg) return;
      reg.update().catch(() => {});
      if (reg.waiting) offer(reg.waiting);
    });
  })();
})();
