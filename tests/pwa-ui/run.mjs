// Visual + behavioural harness for src/pwa.js (mock BudgetApp, mock store; no network, no Supabase).
// Usage: node tests/pwa-ui/run.mjs [--only=phone|ipad] [--no-shots] [--real]
//   screenshots → tests/pwa-ui/shots/<device>-<theme>-<state>.png
//   --real additionally runs pwa.js on top of the real src/app.html + app.js + icons.js (mock store)
// Env: PLAYWRIGHT (module path), CHROMIUM (executable), LUCIDE (lucide 0.460.0 UMD file)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith("--only=")) || "").slice(7);
const shots = !args.includes("--no-shots");
const real = args.includes("--real");
const shotDir = path.join(here, "shots");
if (shots) fs.mkdirSync(shotDir, { recursive: true });

const { chromium } = require(process.env.PLAYWRIGHT || "/opt/node-tools/node_modules/playwright");
const lucideCandidates = [process.env.LUCIDE, path.join(root, "node_modules/.cache/lucide-0.460.0.min.js"),
  "/tmp/claude-0/-home-user-test/a33a3173-3613-5536-ae22-6d990a2f6058/scratchpad/lib/lucide.min.js"].filter(Boolean);
let lucidePath = lucideCandidates.find(p => fs.existsSync(p));
if (!lucidePath) {
  const res = await fetch("https://cdn.jsdelivr.net/npm/lucide@0.460.0/dist/umd/lucide.min.js");
  if (!res.ok) throw new Error("lucide download failed");
  lucidePath = path.join(root, "node_modules/.cache/lucide-0.460.0.min.js");
  fs.mkdirSync(path.dirname(lucidePath), { recursive: true });
  fs.writeFileSync(lucidePath, await res.text());
}

/* ── static server ─────────────────────────────── */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
function realPage() {
  const appHtml = fs.readFileSync(path.join(root, "src/app.html"), "utf8");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/src/app.css"><link rel="stylesheet" href="/src/pwa.css"></head><body>
${appHtml}
<script>window.BUDGET_FEATURES = { pwa: true }; window.__REAL_APP__ = true;</script>
<script src="/src/icons.js"></script><script src="/tests/pwa-ui/mock-app.js"></script>
<script src="/src/app.js"></script><script src="/src/pwa.js"></script></body></html>`;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body, type;
  try {
    if (url.pathname === "/__lucide.js") { body = fs.readFileSync(lucidePath); type = TYPES[".js"]; }
    else if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    // the harness page registers ./sw.js like the real app: answer with an inert worker
    else if (url.pathname === "/tests/pwa-ui/sw.js") { body = "self.addEventListener('message', () => {});"; type = TYPES[".js"]; }
    else if (url.pathname === "/real.html") { body = realPage(); type = TYPES[".html"]; }
    else {
      const file = path.join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root)) throw new Error("outside");
      body = fs.readFileSync(file);
      type = TYPES[path.extname(file)] || "application/octet-stream";
    }
  } catch (e) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ── checks ────────────────────────────────────── */
let failed = 0, passed = 0;
const allIcons = new Set();
async function collectIcons(page) {
  try { for (const n of await page.evaluate(() => [...window.__mock.icons])) allIcons.add(n); } catch (e) { /* page gone */ }
}
function check(ok, msg) {
  if (ok) passed++; else { failed++; console.log("  FAIL", msg); }
}
const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  chrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
const DEVICES = {
  phone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA.iphone },
  ipad: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: UA.ipad },
  se: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA.iphone, light: true },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });

async function newPage(dev, theme, query = "") {
  const { light, ...opts } = dev;
  const ctx = await browser.newContext({ ...opts, colorScheme: theme, locale: "ru-RU", acceptDownloads: true });
  // real iPads report 5 touch points (Chromium's touch emulation reports 1)
  if (dev.userAgent === UA.ipad) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 5 }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${base}/tests/pwa-ui/harness.html${query}`);
  await page.waitForFunction(() => window.__mock && document.querySelector("#pwaSync"));
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, errors };
}
const settle = page => page.waitForTimeout(260);
async function setSync(page, patch) { await page.evaluate(p => window.__mock.setSync(p), patch); await settle(page); }
async function openDialog(page) {
  if (!(await page.locator("#pwaDlg").evaluate(d => d.open))) await page.click("#pwaSync");
  await page.waitForFunction(() => document.querySelector("#pwaDlg").open);
  await settle(page);
}
async function closeDialog(page) { await page.evaluate(() => { const d = document.querySelector("#pwaDlg"); if (d.open) d.close(); }); }
async function shot(page, name, opts = {}) {
  if (!shots) return;
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(shotDir, `${name}.png`), ...opts });
}
async function shotDialog(page, name) {
  await page.evaluate(() => { document.querySelector("#pwaDlg").scrollTop = 0; });
  await shot(page, name);
  const scrolls = await page.evaluate(() => { const d = document.querySelector("#pwaDlg"); return d.scrollHeight > d.clientHeight + 4; });
  if (scrolls) {
    await page.evaluate(() => { const d = document.querySelector("#pwaDlg"); d.scrollTop = d.scrollHeight; });
    await shot(page, name + "-end");
    await page.evaluate(() => { document.querySelector("#pwaDlg").scrollTop = 0; });
  }
}
// layout rules for whatever is visible in the dialog right now
async function layoutChecks(page, label, coarse) {
  const r = await page.evaluate(() => {
    const d = document.querySelector("#pwaDlg");
    const vis = el => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0; };
    const out = { overflowX: d.scrollWidth - d.clientWidth, smallInputs: [], smallTargets: [], clipped: [] };
    for (const i of d.querySelectorAll("input.input")) if (vis(i) && parseFloat(getComputedStyle(i).fontSize) < 16) out.smallInputs.push(i.id);
    for (const b of d.querySelectorAll("button, a, .seg-wide label")) {
      if (!vis(b) || b.classList.contains("dlg-kb-save")) continue;
      const rc = b.getBoundingClientRect();
      // inline text links get their target from padding (pwa-link) — measure the padded box
      if (b.matches("p a")) continue;   // links inside a sentence are exempt (WCAG 2.5.8 inline)
      if (rc.height < 44 || rc.width < 44) out.smallTargets.push(`${b.tagName.toLowerCase()}.${b.className || ""}[${(b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 24)}] ${Math.round(rc.width)}x${Math.round(rc.height)}`);
      if (b.scrollWidth > b.clientWidth + 1 && b.matches("button")) out.clipped.push((b.textContent || "").trim().slice(0, 30));
    }
    return out;
  });
  check(r.overflowX <= 0, `${label}: dialog has no horizontal overflow (${r.overflowX}px)`);
  check(r.smallInputs.length === 0, `${label}: text inputs ≥ 16px (${r.smallInputs.join(", ")})`);
  check(r.clipped.length === 0, `${label}: no clipped button labels (${r.clipped.join(" | ")})`);
  if (coarse) check(r.smallTargets.length === 0, `${label}: touch targets ≥ 44px: ${r.smallTargets.join("; ")}`);
}

/* ── per device × theme scenario ───────────────── */
async function scenario(devName, theme) {
  const dev = DEVICES[devName];
  const tag = `${devName}-${theme}`;
  console.log(`· ${tag}`);
  const { ctx, page, errors } = await newPage(dev, theme);
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  check(coarse, `${tag}: emulated touch device matches (pointer: coarse)`);

  // top bar + iOS install banner, not configured
  check(await page.locator("#pwaBanner .pwa-install").isVisible(), `${tag}: iOS install banner visible`);
  check((await page.locator("#pwaBanner").innerText()).includes("На экран „Домой“"), `${tag}: banner explains «На экран „Домой“»`);
  check(await page.getAttribute("#pwaSync", "aria-label") === "Синхронизация не настроена", `${tag}: button label when not configured`);
  const bsz = await page.locator("#pwaSync").boundingBox();
  check(Math.round(bsz.width) === 44 && Math.round(bsz.height) === 44, `${tag}: sync button is 44px under pointer:coarse (${bsz.width}x${bsz.height})`);
  await shot(page, `${tag}-00-top`);

  // gallery of button states
  const states = [
    ["не настроено", { configured: false, user: null, phase: "off", pending: 0 }],
    ["вход", { configured: true, url: "https://abcd.supabase.co", configSource: "device", user: null, phase: "off" }],
    ["готово", { user: { id: "u1", email: "anna@example.com" }, phase: "idle", pending: 0, lastSyncAt: Date.now() - 120e3 }],
    ["ожидает", { phase: "idle", pending: 2 }],
    ["синхр.", { phase: "syncing", pending: 1 }],
    ["нет сети", { phase: "offline", pending: 3 }],
    ["ошибка", { phase: "error", pending: 12, error: "Сервер синхронизации не отвечает. Повторите попытку позже." }],
    ["пароль", { recovery: true }],
  ];
  const labels = [];
  for (const [cap, patch] of states) {
    await setSync(page, patch);
    labels.push(await page.getAttribute("#pwaSync", "aria-label"));
    await page.evaluate(cap => {
      const fig = document.createElement("figure");
      const b = document.querySelector("#pwaSync").cloneNode(true);
      b.removeAttribute("id");
      fig.append(b, Object.assign(document.createElement("figcaption"), { textContent: cap }));
      document.querySelector("#gallery").append(fig);
    }, cap);
    if (patch.recovery) { await closeDialog(page); await setSync(page, { recovery: false }); }
  }
  check(labels[2] === "Синхронизация: всё сохранено", `${tag}: idle label (${labels[2]})`);
  check(labels[5].includes("нет сети") && labels[5].includes("3 изменения"), `${tag}: offline label with pending (${labels[5]})`);
  check(labels[6].includes("ошибка") && labels[6].includes("12 изменений"), `${tag}: error label (${labels[6]})`);
  await page.evaluate(() => document.querySelector("#gallery").scrollIntoView());
  await shot(page, `${tag}-01-buttons`, { clip: await page.locator("#stub").boundingBox() });
  await page.evaluate(() => { document.querySelector("#gallery").innerHTML = ""; scrollTo(0, 0); });

  // a) not configured
  await setSync(page, { configured: false, url: "", configSource: "none", user: null, phase: "off", pending: 0, error: null, recovery: false });
  await openDialog(page);
  check(await page.locator("#pwaTitle").innerText() === "Синхронизация", `${tag}: config title`);
  check(await page.locator('#pwaDlg a[href$="supabase/README.md"][target="_blank"][rel="noopener"]').count() === 1, `${tag}: guide link`);
  check((await page.locator("#pwaGuideUrl").innerText()).trim() === "https://github.com/Grossmanban/test/blob/main/supabase/README.md", `${tag}: guide URL shown as text`);
  check(await page.locator('[data-act="off-ask"]').count() === 0, `${tag}: no «Отключить» when nothing is configured`);
  await layoutChecks(page, `${tag} config`, coarse);
  await shotDialog(page, `${tag}-02-config`);
  await page.fill("#pwaUrl", "abcd.supabase.co");
  await page.fill("#pwaKey", "sb_publishable_xxx");
  await page.click('#pwaForm button[type="submit"]');
  await page.waitForSelector("#pwaErr:not([hidden])");
  check((await page.locator("#pwaErr").innerText()).includes("https://"), `${tag}: store error message shown for a bad URL`);
  await shot(page, `${tag}-03-config-error`);
  await page.fill("#pwaUrl", "https://abcd.supabase.co");
  await page.click('#pwaForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#pwaTitle").textContent === "Вход в аккаунт");
  await settle(page);
  check(await page.locator("#pwaFlash").innerText().then(t => t.includes("Проект подключён")), `${tag}: configured → sign-in view with confirmation`);

  // b) signed out, with an error from the store
  await setSync(page, { error: "Сессия завершена. Войдите снова, чтобы продолжить синхронизацию." });
  await page.evaluate(() => { window.__mock.sync.error = null; });
  await layoutChecks(page, `${tag} auth`, coarse);
  check(await page.getAttribute("#pwaPass", "autocomplete") === "current-password", `${tag}: sign-in password autocomplete`);
  check(await page.getAttribute("#pwaEmail", "autocomplete") === "email", `${tag}: email autocomplete`);
  await shotDialog(page, `${tag}-04-auth`);
  // sign-up mode, error from the store
  await page.fill("#pwaEmail", "anna@example.com");
  await page.fill("#pwaPass", "123");
  await page.check("#pwaModeUp", { force: true });
  await settle(page);
  check(await page.getAttribute("#pwaPass", "autocomplete") === "new-password", `${tag}: sign-up password autocomplete`);
  check(await page.inputValue("#pwaEmail") === "anna@example.com" && await page.inputValue("#pwaPass") === "123", `${tag}: typed values survive the mode switch`);
  await page.evaluate(() => { window.__mock.fail.signUp = { code: "invalid", message: "Пароль слишком простой. Придумайте пароль подлиннее, с буквами и цифрами." }; });
  await page.click('#pwaForm button[type="submit"]');
  await page.waitForSelector("#pwaErr:not([hidden])");
  await layoutChecks(page, `${tag} signup`, coarse);
  await shotDialog(page, `${tag}-05-signup-error`);
  // sign-up → e-mail sent
  await page.evaluate(() => { delete window.__mock.fail.signUp; });
  await page.fill("#pwaPass", "correct horse 42");
  await page.click('#pwaForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#pwaTitle").textContent === "Подтвердите почту");
  await settle(page);
  check((await page.locator(".pwa-note").innerText()).includes("Мы отправили письмо на anna@example.com"), `${tag}: «Мы отправили письмо…» state`);
  check(await page.inputValue("#pwaPass") === "correct horse 42", `${tag}: password kept for signing in after confirming`);
  await layoutChecks(page, `${tag} sent`, coarse);
  await shotDialog(page, `${tag}-06-sent`);
  await page.click('[data-act="sent-back"]');
  await settle(page);
  // forgot password
  await page.check("#pwaModeIn", { force: true });
  await settle(page);
  await page.fill("#pwaEmail", "");
  await page.click('[data-act="forgot"]');
  check(await page.locator("#pwaErr").isVisible(), `${tag}: forgot password without e-mail asks for it`);
  await page.fill("#pwaEmail", "anna@example.com");
  await page.click('[data-act="forgot"]');
  await page.waitForFunction(() => /смены пароля отправлено/.test(document.querySelector("#pwaFlash").textContent));
  check(await page.evaluate(() => window.__mock.calls.some(c => c.name === "resetPassword" && c.args[0] === "anna@example.com")), `${tag}: resetPassword called`);
  await shotDialog(page, `${tag}-07-reset-sent`);

  // change / disconnect project (device config)
  await page.click('[data-act="cfg-edit"]');
  await settle(page);
  check(await page.locator('[data-act="off-ask"]').isVisible(), `${tag}: «Отключить» offered for a device config`);
  check(await page.inputValue("#pwaUrl") === "https://abcd.supabase.co", `${tag}: project URL prefilled`);
  await page.click('[data-act="off-ask"]');
  await settle(page);
  await layoutChecks(page, `${tag} disconnect`, coarse);
  await shotDialog(page, `${tag}-08-disconnect`);
  await page.click('[data-act="off-no"]');
  await page.click('[data-act="cfg-cancel"]');
  await settle(page);

  // sign in
  await page.fill("#pwaEmail", "anna@example.com");
  await page.fill("#pwaPass", "secret-123");
  await page.click('#pwaForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#pwaTitle").textContent === "Аккаунт");
  await page.waitForTimeout(600);
  await setSync(page, { lastSyncAt: Date.now() - 125e3 });
  check((await page.locator("#pwaStatus").innerText()).includes("Синхронизировано · 2 мин назад"), `${tag}: «Синхронизировано · 2 мин назад»`);
  await layoutChecks(page, `${tag} account`, coarse);
  await shotDialog(page, `${tag}-09-account`);
  // sync now
  await page.click("#pwaSyncNow");
  await page.waitForTimeout(250);
  check(await page.locator("#pwaStatus .is-busy").count() === 1, `${tag}: syncing status shown`);
  await page.waitForTimeout(600);

  // offline with pending + sign-out confirm
  await setSync(page, { phase: "offline", pending: 3 });
  check((await page.locator("#pwaStatus").innerText()).includes("Нет сети — изменения сохранятся на устройстве"), `${tag}: offline status`);
  await page.click('[data-act="out-ask"]');
  await settle(page);
  check((await page.locator(".pwa-loud").innerText()).includes("3 изменения"), `${tag}: loud warning with pending count`);
  check(await page.locator("#pwaOutSave").isVisible(), `${tag}: «Сохранить копию» offered before signing out with pending changes`);
  await layoutChecks(page, `${tag} signout`, coarse);
  await shotDialog(page, `${tag}-10-signout-confirm`);
  await page.click('[data-act="out-no"]');
  // error
  await setSync(page, { phase: "error", pending: 1, error: "Сервер синхронизации не отвечает. Повторите попытку позже." });
  check((await page.locator("#pwaStatus").innerText()).includes("Ошибка: Сервер синхронизации не отвечает"), `${tag}: error status`);
  await shotDialog(page, `${tag}-11-error`);

  // backup: import ok + invalid file
  const good = Buffer.from(JSON.stringify({ app: "budget", version: 1, exportedAt: "2026-10-08T10:00:00Z", settings: null, tx: [] }));
  await page.setInputFiles("#pwaFile", { name: "budget-backup-2026-10-01.json", mimeType: "application/json", buffer: good });
  await page.waitForFunction(() => /Копия загружена/.test(document.querySelector("#pwaBkMsg").textContent));
  check((await page.locator("#pwaBkMsg").innerText()).includes("новых операций: 12"), `${tag}: import result with counts`);
  check(await page.evaluate(() => window.__mock.toasts.some(t => /Копия загружена/.test(t.msg))), `${tag}: import toast`);
  await page.evaluate(() => { const d = document.querySelector("#pwaDlg"); d.scrollTop = d.scrollHeight; });
  await shot(page, `${tag}-12-import-ok`);
  await page.setInputFiles("#pwaFile", { name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{oops") });
  await page.waitForFunction(() => /не резервная копия/.test(document.querySelector("#pwaBkMsg").textContent));
  await page.setInputFiles("#pwaFile", { name: "other.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
  await page.waitForFunction(() => /Файл не похож на резервную копию/.test(document.querySelector("#pwaBkMsg").textContent));
  await page.evaluate(() => { const d = document.querySelector("#pwaDlg"); d.scrollTop = d.scrollHeight; });
  await shot(page, `${tag}-13-import-error`);

  // sign out
  await setSync(page, { phase: "idle", pending: 0, error: null });
  await page.click('[data-act="out-ask"]');
  await page.click('[data-act="out-yes"]');
  await page.waitForFunction(() => document.querySelector("#pwaTitle").textContent === "Вход в аккаунт");
  check(await page.inputValue("#pwaEmail") === "anna@example.com", `${tag}: e-mail prefilled after sign-out`);
  await closeDialog(page);

  // d) recovery opens by itself
  await setSync(page, { user: { id: "u1", email: "anna@example.com" }, phase: "idle", recovery: true });
  check(await page.locator("#pwaDlg").evaluate(d => d.open), `${tag}: recovery opens the dialog automatically`);
  check(await page.locator("#pwaTitle").innerText() === "Новый пароль", `${tag}: recovery title`);
  await page.fill("#pwaNew", "new-secret-1");
  await page.fill("#pwaNew2", "new-secret-2");
  await page.click('#pwaForm button[type="submit"]');
  check((await page.locator("#pwaErr").innerText()) === "Пароли не совпадают.", `${tag}: mismatch error`);
  await layoutChecks(page, `${tag} recovery`, coarse);
  await shotDialog(page, `${tag}-14-recovery`);
  await page.fill("#pwaNew2", "new-secret-1");
  await page.click('#pwaForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#pwaTitle").textContent === "Аккаунт");
  check(await page.evaluate(() => window.__mock.calls.some(c => c.name === "updatePassword" && c.args[0] === "new-secret-1")), `${tag}: updatePassword called`);
  await settle(page);
  await shotDialog(page, `${tag}-15-recovery-done`);
  await closeDialog(page);

  // install banner: dismiss for 30 days
  await collectIcons(page);
  await page.click('#pwaBanner [data-install="hide"]');
  check(await page.locator("#pwaBanner .pwa-install").count() === 0, `${tag}: banner dismissed`);
  await page.reload();
  await page.waitForFunction(() => window.__mock && document.querySelector("#pwaSync"));
  check(await page.locator("#pwaBanner .pwa-install").count() === 0, `${tag}: banner stays hidden after reload`);

  await collectIcons(page);
  check(errors.length === 0, `${tag}: no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

/* ── desktop Chrome: download, beforeinstallprompt, service-worker update ── */
async function desktop(theme) {
  const tag = `desktop-${theme}`;
  console.log(`· ${tag}`);
  const { ctx, page, errors } = await newPage({ viewport: { width: 1280, height: 860 }, userAgent: UA.chrome }, theme, "?sw=mock&state=signedin");
  check(await page.locator("#pwaBanner .pwa-install").count() === 0, `${tag}: no iOS banner in Chrome`);
  const offered = await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true });
    window.__prompted = 0;
    e.prompt = async () => { window.__prompted++; };
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  check(offered, `${tag}: beforeinstallprompt is intercepted`);
  check(await page.locator('#pwaBanner [data-install="go"]').isVisible(), `${tag}: «Установить» button shown`);
  // service worker
  await page.waitForFunction(() => window.__swRegistered);
  const reg = await page.evaluate(() => window.__swRegistered);
  check(reg.url === "./sw.js" && reg.opts && reg.opts.scope === "./", `${tag}: registers ./sw.js with scope ./`);
  await page.waitForSelector("#toast:not([hidden])");
  check((await page.locator("#toast").innerText()).includes("Доступна новая версия"), `${tag}: update toast`);
  await shot(page, `${tag}-16-update-toast`);
  await openDialog(page);
  check(await page.locator('[data-act="update"]').isVisible(), `${tag}: update row in dialog`);
  check((await page.locator("#pwaVer").innerText()).includes("3f2a1b9c0d1e"), `${tag}: app version from the service worker`);
  await layoutChecks(page, `${tag} account`, false);
  await shotDialog(page, `${tag}-17-account-update`);
  // download fallback (no share on desktop)
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-act="export"]')]);
  check(/^budget-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), `${tag}: download name ${dl.suggestedFilename()}`);
  const saved = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  check(saved.app === "budget" && saved.version === 1 && Array.isArray(saved.tx), `${tag}: downloaded file is the backup JSON`);
  await closeDialog(page);
  await page.click('#pwaBanner [data-install="go"]');
  check(await page.evaluate(() => window.__prompted) === 1, `${tag}: «Установить» calls prompt()`);
  // apply the update: SKIP_WAITING, then exactly one reload
  await page.evaluate(() => window.BudgetApp.toast("x"));
  const navs = [];
  page.on("framenavigated", f => { if (f === page.mainFrame()) navs.push(f.url()); });
  await page.evaluate(() => {
    // the toast was replaced above; reopen the dialog and use the update row
    document.querySelector("#pwaSync").click();
  });
  await page.click('[data-act="update"]');
  await page.waitForTimeout(800);
  check(navs.length === 1, `${tag}: reloads exactly once after «Обновить» (${navs.length})`);
  await collectIcons(page);
  check(errors.length === 0, `${tag}: no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

/* ── share path on iPhone ──────────────────────── */
async function iosShare() {
  const tag = "phone-share";
  console.log(`· ${tag}`);
  const { ctx, page, errors } = await newPage(DEVICES.phone, "light", "?state=signedin");
  await page.evaluate(() => {
    window.__shared = null;
    navigator.canShare = d => !!(d && d.files && d.files.length);
    navigator.share = async d => { window.__shared = { name: d.files[0].name, type: d.files[0].type, text: await d.files[0].text() }; };
  });
  await openDialog(page);
  await page.click('[data-act="export"]');
  await page.waitForFunction(() => window.__shared);
  const s = await page.evaluate(() => window.__shared);
  check(/^budget-backup-\d{4}-\d{2}-\d{2}\.json$/.test(s.name) && s.type === "application/json" && JSON.parse(s.text).app === "budget", `${tag}: share sheet gets the JSON file (${s.name})`);
  await page.waitForFunction(() => /Копия сохранена/.test(document.querySelector("#pwaBkMsg").textContent));
  // cancelled share sheet: no error, no download
  await page.evaluate(() => { navigator.share = async () => { throw new DOMException("cancel", "AbortError"); }; });
  await page.click('[data-act="export"]');
  await page.waitForTimeout(200);
  await collectIcons(page);
  check(errors.length === 0, `${tag}: no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

/* ── e-mail links: «Отмена» in the password form; a link's address is pre-filled only when this browser asked for it ── */
async function links(devName, theme, desktopUa = false) {
  const tag = `links-${devName}-${theme}${desktopUa ? "-chrome" : ""}`;
  console.log(`· ${tag}`);
  const { ctx, page, errors } = await newPage(desktopUa ? { ...DEVICES[devName], userAgent: UA.chrome } : DEVICES[devName], theme);
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const CFG = { configured: true, url: "https://abcd.supabase.co", configSource: "device", user: null, phase: "off", error: null, recovery: false, link: null };
  const ANNA = { id: "u1", email: "anna@example.com" };
  const stranger = "stranger@example.com";
  const title = () => page.locator("#pwaTitle").innerText();
  const waitTitle = t => page.waitForFunction(t => document.querySelector("#pwaDlg").open && document.querySelector("#pwaTitle").textContent === t, t);
  const view = async () => (await page.locator("#pwaView").innerText()).replace(/\s+/g, " ");
  const called = name => page.evaluate(n => window.__mock.calls.filter(c => c.name === n).length, name);
  const reload = async () => {
    await closeDialog(page);
    await page.reload();
    await page.waitForFunction(() => window.__mock && document.querySelector("#pwaSync"));
  };

  // 1. a confirmation link nobody here asked for: the note names the address, the sign-in form is not pre-filled
  await setSync(page, { ...CFG, link: { type: "confirmed", email: stranger } });
  await waitTitle("Вход в аккаунт");
  await settle(page);
  check((await view()).includes(`Почта ${stranger} подтверждена`), `${tag}: confirmation note names the link's address`);
  check(await page.inputValue("#pwaEmail") === "", `${tag}: an address this browser did not ask for is not pre-filled`);
  check((await view()).includes("с почтой и паролем своего аккаунта"), `${tag}: the note does not point at the link's address`);
  await closeDialog(page);

  // 2. a recovery link of another account while signed in: «Отмена» keeps the password and gives the account view back
  await setSync(page, { ...CFG, user: ANNA, phase: "idle", lastSyncAt: Date.now(), recovery: true, link: { type: "recovery", email: stranger } });
  await waitTitle("Новый пароль");
  await settle(page);
  check(await page.getAttribute("#pwaSync", "aria-label") === "Синхронизация: задайте новый пароль", `${tag}: button asks for the new password`);
  check((await view()).includes(`Смена пароля для ${stranger}`) && (await view()).includes("вошли как anna@example.com"), `${tag}: recovery form names the link's account and the device's`);
  check((await view()).includes("Не просили сменить пароль? Нажмите «Отмена»"), `${tag}: a link this browser did not ask for says how to back out`);
  check(await page.locator('[data-act="rec-cancel"]').isVisible(), `${tag}: «Отмена» in the password form`);
  await layoutChecks(page, `${tag} recovery link`, coarse);
  await shotDialog(page, `${tag}-recovery-link`);
  await page.click('[data-act="rec-cancel"]');
  await waitTitle("Аккаунт");
  await settle(page);
  check(await called("cancelRecovery") === 1 && await called("updatePassword") === 0, `${tag}: «Отмена» calls cancelRecovery, not updatePassword`);
  check((await page.locator("#pwaFlash").innerText()).includes("Пароль не изменён."), `${tag}: «Пароль не изменён.»`);
  check(await page.locator("#pwaStatus").isVisible() && await page.locator('[data-act="out-ask"]').isVisible(), `${tag}: sync status and «Выйти» are back`);
  check(await page.getAttribute("#pwaSync", "aria-label") === "Синхронизация: всё сохранено", `${tag}: button back to the sync status`);
  await closeDialog(page);

  // 3. a reset of this device's own account (no held link): cancellable too, no «не просили» line
  await setSync(page, { recovery: true });
  await waitTitle("Новый пароль");
  await settle(page);
  check(!(await view()).includes("Не просили"), `${tag}: own account: no «не просили» line`);
  await page.click('[data-act="rec-cancel"]');
  await waitTitle("Аккаунт");
  check(await called("cancelRecovery") === 2, `${tag}: own account: cancelRecovery called`);
  await closeDialog(page);

  // 4. signed out, a recovery link of a stranger: after the new password the sign-in form stays empty
  await setSync(page, { ...CFG, recovery: true, link: { type: "recovery", email: stranger } });
  await waitTitle("Новый пароль");
  await settle(page);
  await page.fill("#pwaNew", "new-secret-1");
  await page.fill("#pwaNew2", "new-secret-1");
  await page.click('#pwaForm button[type="submit"]');
  await waitTitle("Вход в аккаунт");
  await settle(page);
  check((await page.locator("#pwaFlash").innerText()).includes(`Пароль для ${stranger} изменён`), `${tag}: stranger's reset: done message`);
  check(await page.inputValue("#pwaEmail") === "", `${tag}: stranger's reset: the address is not pre-filled`);

  // 5. this browser asked for the links (sign-up, password reset): the address is pre-filled after a reload
  await page.fill("#pwaEmail", "Anna@Example.com");
  await page.click('[data-act="forgot"]');
  await page.waitForFunction(() => /смены пароля отправлено/.test(document.querySelector("#pwaFlash").textContent));
  await page.locator('label:has(#pwaModeUp)').scrollIntoViewIfNeeded();
  await page.click('label:has(#pwaModeUp)');
  await page.waitForFunction(() => document.querySelector("#pwaTitle").textContent === "Новый аккаунт");
  await page.fill("#pwaEmail", "bob@example.com");
  await page.fill("#pwaPass", "correct horse 42");
  await page.click('#pwaForm button[type="submit"]');
  await waitTitle("Подтвердите почту");
  await reload();
  await setSync(page, { ...CFG, link: { type: "confirmed", email: "bob@example.com" } });
  await waitTitle("Вход в аккаунт");
  await settle(page);
  check(await page.inputValue("#pwaEmail") === "bob@example.com", `${tag}: confirmation of an address asked for here: pre-filled`);
  check((await view()).includes("с этой почтой и паролем"), `${tag}: … and the note points at it`);
  await reload();
  await setSync(page, { ...CFG, recovery: true, link: { type: "recovery", email: "anna@example.com" } });
  await waitTitle("Новый пароль");
  await settle(page);
  check(!(await view()).includes("Не просили"), `${tag}: reset asked for here: no «не просили» line`);
  await page.fill("#pwaNew", "new-secret-2");
  await page.fill("#pwaNew2", "new-secret-2");
  await page.click('#pwaForm button[type="submit"]');
  await waitTitle("Вход в аккаунт");
  await settle(page);
  check(await page.inputValue("#pwaEmail") === "anna@example.com", `${tag}: reset asked for here: the address is pre-filled for signing in`);
  check(await title() === "Вход в аккаунт", `${tag}: sign-in view after the reset`);

  await collectIcons(page);
  check(errors.length === 0, `${tag}: no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

/* ── real app.js + icons.js (integration smoke test) ── */
async function realApp() {
  const tag = "real-app";
  console.log(`· ${tag}`);
  const ctx = await browser.newContext({ ...DEVICES.phone, colorScheme: "light", locale: "ru-RU" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`${base}/real.html?state=signedin`);
  await page.waitForTimeout(800);
  check(await page.evaluate(() => !!window.BudgetApp), `${tag}: app.js exposes BudgetApp`);
  check(await page.locator("#pwaSync").count() === 1, `${tag}: sync button rendered in #pwaTop`);
  if (await page.locator("#pwaSync").count()) {
    await page.click("#pwaSync");
    await page.waitForTimeout(300);
    check(await page.locator("#pwaDlg").evaluate(d => d.open), `${tag}: account dialog opens`);
    await shot(page, `${tag}-account`);
    await page.evaluate(() => document.querySelector("#pwaDlg").close());
  }
  await shot(page, `${tag}-top`);
  const missing = await page.evaluate(() => window.__mock.missingIcons());
  console.log(`  icons missing from src/icons.js: ${missing.join(", ") || "none"}`);
  await collectIcons(page);
  check(errors.length === 0, `${tag}: no page errors (${errors.join(" | ")})`);
  await ctx.close();
}

try {
  for (const dev of Object.keys(DEVICES)) {
    if (only && only !== dev) continue;
    for (const theme of DEVICES[dev].light ? ["light"] : ["light", "dark"]) await scenario(dev, theme);
  }
  if (!only) {
    await desktop("light"); await desktop("dark"); await iosShare();
    await links("phone", "dark"); await links("se", "light"); await links("phone", "light", true);
  }
  if (real) await realApp();
  // every icon requested while the scenarios ran (harness markup adds Wallet, ChevronLeft, ChevronRight, Plus)
  console.log(`icons requested: ${[...allIcons].sort().join(", ")}`);
} finally {
  await browser.close();
  server.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
