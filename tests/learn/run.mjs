// Visual + behavioural harness for the «Обучение» section (src/lessons.js, src/learn.js, src/learn.css)
// on a mock BudgetApp (tests/learn/mock-api.js): no store, no network.
// Usage: node tests/learn/run.mjs [--only=phone|ipad|se] [--no-shots]
//   screenshots → tests/learn/shots/<device>-<theme>-<state>.png
// Env: PLAYWRIGHT (module path), CHROMIUM (executable), LUCIDE (lucide 0.460.0 UMD file)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith("--only=")) || "").slice(7);
const shots = !args.includes("--no-shots");
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

let failed = 0, passed = 0;
function check(ok, msg) { if (ok) passed++; else { failed++; console.log("  FAIL", msg); } }

/* ── data checks (no browser) ──────────────────── */
const lucide = require(lucidePath);
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, "src/lessons.js"), "utf8"), sandbox);
const LESSONS = sandbox.window.MH_LESSONS;
check(Array.isArray(LESSONS) && LESSONS.length >= 10 && LESSONS.length <= 13, `10–13 lessons (${LESSONS && LESSONS.length})`);
const ACTIONS = ["tx", "saving", "limits", "goal", "categories", "start"];
const seenIds = new Set();
for (const l of LESSONS) {
  const tag = `lesson ${l.id}`;
  check(/^[a-z0-9-]+$/.test(l.id) && !seenIds.has(l.id), `${tag}: unique id`); seenIds.add(l.id);
  check(["basics", "israel", "app"].includes(l.track), `${tag}: track`);
  check(typeof l.title === "string" && l.title && typeof l.summary === "string" && l.summary, `${tag}: title + summary`);
  check(Number.isInteger(l.minutes) && l.minutes >= 2 && l.minutes <= 5, `${tag}: 2–5 minutes`);
  check(!!lucide.icons[l.icon], `${tag}: icon ${l.icon} exists in lucide`);
  check(Array.isArray(l.sections) && l.sections.length >= 2 && l.sections.every(s => Array.isArray(s.p) && (!s.list || Array.isArray(s.list))), `${tag}: sections shape`);
  check(l.takeaways.length >= 3 && l.takeaways.length <= 5, `${tag}: 3–5 takeaways`);
  check(l.quiz.length >= 2 && l.quiz.length <= 3 && l.quiz.every(q => q.q && q.options.length >= 2 && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length && q.explain),
    `${tag}: 2–3 quiz questions with a valid answer and an explanation`);
  check(!l.tryIt || (ACTIONS.includes(l.tryIt.action) && l.tryIt.label), `${tag}: tryIt action`);
  check(Array.isArray(l.sources) && l.sources.every(s => s.title && /^https:\/\/[^\s"<>]+$/.test(s.url)), `${tag}: sources are https links`);
  if (l.track === "israel") check(l.sources.length >= 2 && /^\d{4}-\d{2}$/.test(l.checked || ""), `${tag}: Israel lesson has sources and a check date`);
  const text = JSON.stringify({ ...l, sources: l.sources.map(s => s.title) });
  check(!/<[a-z/!]/i.test(text), `${tag}: plain text, no HTML`);
}
for (const t of ["app", "basics", "israel"]) check(LESSONS.some(l => l.track === t), `track ${t} has lessons`);

/* ── static server ─────────────────────────────── */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body, type;
  try {
    if (url.pathname === "/__lucide.js") { body = fs.readFileSync(lucidePath); type = TYPES[".js"]; }
    else if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    else {
      const file = path.join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep)) throw new Error("outside");
      body = fs.readFileSync(file);
      type = TYPES[path.extname(file)] || "application/octet-stream";
    }
  } catch (e) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};
const DEVICES = {
  phone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA.iphone },
  ipad: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: UA.ipad },
  se: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA.iphone },
  ipadland: { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: UA.ipad },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
const allIcons = new Set();

async function newPage(dev, theme, query = "") {
  const ctx = await browser.newContext({ ...dev, colorScheme: theme, locale: "ru-RU" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${base}/tests/learn/harness.html${query}`);
  await page.waitForFunction(() => window.__mounted && document.querySelector(".lrn"));
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, errors };
}
async function collectIcons(page) { for (const n of await page.evaluate(() => [...window.__learn.icons])) allIcons.add(n); }
async function shot(page, name, opts = {}) {
  if (!shots) return;
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(shotDir, `${name}.png`), ...opts });
}
const settle = page => page.waitForTimeout(280);

// layout rules for the section as rendered right now
async function layoutChecks(page, label, coarse) {
  if (coarse) check(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), `${label}: still (pointer: coarse)`);
  const r = await page.evaluate(coarse => {
    const out = { overflow: document.scrollingElement.scrollWidth - innerWidth, small: [], clipped: [], contrast: [] };
    const root = document.querySelector("#viewLearn");
    const visible = el => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== "hidden"; };
    for (const el of root.querySelectorAll("button, a[href]")) {
      if (!visible(el)) continue;
      const b = el.getBoundingClientRect();
      if (coarse && (b.height < 43.5 || b.width < 43.5)) out.small.push(`${el.className || el.tagName} "${el.textContent.trim().slice(0, 24)}" ${Math.round(b.width)}x${Math.round(b.height)}`);
    }
    for (const el of root.querySelectorAll("*")) {
      if (!visible(el)) continue;
      const b = el.getBoundingClientRect();
      if (b.right > innerWidth + 1 || b.left < -1) out.clipped.push(`${el.tagName}.${el.className} ${Math.round(b.left)}–${Math.round(b.right)}`);
    }
    // WCAG contrast of text against the nearest opaque background
    const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return parse(getComputedStyle(document.body).backgroundColor); };
    for (const el of root.querySelectorAll("*")) {
      if (!visible(el)) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!own || el.closest(".sr")) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color), bg = bgOf(el);
      if (!fg || !bg) continue;
      const opacity = [...function* () { for (let e = el; e; e = e.parentElement) yield +getComputedStyle(e).opacity; }()].reduce((a, b) => a * b, 1);
      if (opacity < 0.99) continue;
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need) out.contrast.push(`${el.tagName}.${el.className} "${el.textContent.trim().slice(0, 20)}" ${ratio.toFixed(2)}`);
    }
    return out;
  }, coarse);
  check(r.overflow <= 0, `${label}: no horizontal page scroll (${r.overflow}px)`);
  check(r.clipped.length === 0, `${label}: nothing sticks out of the viewport: ${r.clipped.slice(0, 4).join("; ")}`);
  if (coarse) check(r.small.length === 0, `${label}: touch targets ≥ 44px: ${r.small.slice(0, 6).join("; ")}`);
  check(r.contrast.length === 0, `${label}: text contrast: ${[...new Set(r.contrast)].slice(0, 6).join("; ")}`);
}

const ISRAEL = LESSONS.find(l => l.track === "israel" && l.tryIt);
const devices = Object.keys(DEVICES).filter(d => !only || d === only);
for (const devName of devices) {
  const dev = DEVICES[devName];
  const themes = ["light", "dark"];
  for (const theme of themes) {
    const tag = `${devName}-${theme}`;
    console.log(`· ${tag}`);
    const { ctx, page, errors } = await newPage(dev, theme);
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    check(coarse, `${tag}: emulated touch device matches (pointer: coarse)`);

    // list
    check(await page.locator(".lrn-card").count() === LESSONS.length, `${tag}: every lesson has a card`);
    await layoutChecks(page, `${tag} list`, coarse);
    await shot(page, `${tag}-01-list`);

    // filter
    await page.click('[data-track="israel"]');
    await settle(page);
    check(await page.locator(".lrn-card").count() === LESSONS.filter(l => l.track === "israel").length, `${tag}: filter «Израиль» shows Israel lessons only`);
    check(await page.evaluate(() => document.activeElement && document.activeElement.dataset.track === "israel"), `${tag}: focus stays on the pressed filter`);
    check(await page.getAttribute('[data-track="israel"]', "aria-pressed") === "true", `${tag}: filter button has aria-pressed`);
    if (devName === "phone" || devName === "se") await shot(page, `${tag}-03-filter-israel`);
    await page.click('[data-track="all"]');

    // reader: an Israel lesson (Hebrew text, sources, check date, try it)
    await page.click(`.lrn-card[data-open="${ISRAEL.id}"]`);
    await settle(page);
    check(await page.evaluate(() => document.activeElement && document.activeElement.id === "lrnLessonTitle"), `${tag}: opening a lesson focuses its title`);
    check(await page.locator(".lrn-sec h3").count() === ISRAEL.sections.filter(s => s.h).length, `${tag}: every section heading rendered`);
    check(await page.locator('bdi[lang="he"]').count() > 3, `${tag}: Hebrew runs are isolated in <bdi lang="he">`);
    const links = await page.$$eval(".lrn-sources a", as => as.map(a => ({ href: a.href, target: a.target, rel: a.rel })));
    check(links.length === ISRAEL.sources.length && links.every(a => a.target === "_blank" && /noopener/.test(a.rel) && a.href.startsWith("https://")),
      `${tag}: sources are new-window links with rel=noopener`);
    check(await page.locator(".lrn-checked").count() === 1, `${tag}: Israel lesson shows when its facts were checked`);
    await layoutChecks(page, `${tag} reader`, coarse);
    await shot(page, `${tag}-04-reader-top`);

    // quiz: right, then wrong answer
    const q0 = ISRAEL.quiz[0], q1 = ISRAEL.quiz[1];
    await page.locator('[data-qbox="0"]').scrollIntoViewIfNeeded();
    await page.click(`[data-q="0"][data-o="${q0.correct}"]`);
    await page.click(`[data-q="1"][data-o="${(q1.correct + 1) % q1.options.length}"]`);
    await settle(page);
    const quiz = await page.evaluate(() => ({
      fb: [...document.querySelectorAll(".lrn-fb")].map(f => ({ live: f.getAttribute("aria-live"), text: f.textContent.trim() })),
      disabled: [...document.querySelectorAll('[data-qbox="0"] .lrn-opt')].every(b => b.getAttribute("aria-disabled") === "true"),
      right: document.querySelectorAll('[data-qbox="0"] .lrn-opt.is-right').length,
      wrong: document.querySelectorAll('[data-qbox="1"] .lrn-opt.is-wrong').length,
      score: document.querySelector("#lrnScore").textContent,
      focusOk: document.activeElement && document.activeElement.classList.contains("lrn-opt"),
    }));
    check(quiz.fb[0].live === "polite" && /Верно/.test(quiz.fb[0].text) && quiz.fb[0].text.includes(q0.explain.slice(0, 20)), `${tag}: right answer → «Верно» + explanation in a live region`);
    check(/Не совсем/.test(quiz.fb[1].text), `${tag}: wrong answer → «Не совсем» + the right option`);
    check(quiz.disabled && quiz.right === 1 && quiz.wrong === 1, `${tag}: answered options are locked and marked`);
    check(quiz.focusOk, `${tag}: focus stays on the tapped option`);
    check(/из/.test(quiz.score), `${tag}: score shows`);
    await page.locator(".lrn-quiz").scrollIntoViewIfNeeded();
    await page.evaluate(() => { const q = document.querySelector(".lrn-quiz"); window.scrollBy(0, q.getBoundingClientRect().top - 16); });
    await layoutChecks(page, `${tag} quiz`, coarse);
    await shot(page, `${tag}-05-quiz`);

    // try it → actions
    await page.evaluate(() => { window.__learn.calls.length = 0; });
    await page.click("[data-try]");
    const calls = await page.evaluate(() => window.__learn.calls);
    const expect = { tx: ["budget", "openTx"], saving: ["goals", "openTx"], limits: ["budget", "openLimits"], goal: ["goals", "openGoal"], categories: ["budget", "openCategories"], start: ["budget", "openStart"] }[ISRAEL.tryIt.action];
    check(calls.length === 2 && calls[0].name === "setView" && calls[0].args[0] === expect[0] && calls[1].name === expect[1],
      `${tag}: «Попробовать в приложении» switches view and opens the dialog (${JSON.stringify(calls)})`);

    // bottom: try + sources + done + prev/next
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await settle(page);
    await page.click("[data-done]");
    await settle(page);
    check(await page.getAttribute("[data-done]", "aria-pressed") === "true", `${tag}: «Отметить пройденным» toggles aria-pressed`);
    check(await page.evaluate(() => window.__learn.toasts.some(t => /пройден/i.test(t))), `${tag}: marking done shows a toast`);
    await layoutChecks(page, `${tag} reader end`, coarse);
    await shot(page, `${tag}-06-reader-end`);

    // persistence + back to the list
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("mh-learn")));
    check(stored && stored.done && stored.done[ISRAEL.id] && stored.quiz && stored.quiz[ISRAEL.id], `${tag}: progress saved in localStorage["mh-learn"]`);
    await page.click("[data-back]");
    await settle(page);
    check(await page.evaluate(id => document.activeElement && document.activeElement.dataset.open === id, ISRAEL.id), `${tag}: back to the list focuses the lesson's card`);
    check(await page.locator(`.lrn-card[data-open="${ISRAEL.id}"] .lrn-state.is-done`).count() === 1, `${tag}: card shows «Пройден»`);
    await page.reload();
    await page.waitForFunction(() => window.__mounted && document.querySelector(".lrn"));
    check(await page.locator(`.lrn-card[data-open="${ISRAEL.id}"] .lrn-state.is-done`).count() === 1, `${tag}: progress survives a reload`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, `${tag}-08-list-progress`);

    await collectIcons(page);
    check(errors.length === 0, `${tag}: no page errors: ${errors.join(" | ")}`);
    await ctx.close();
  }
}

/* ── full-page screenshots (last: they reset Chromium's touch emulation) ── */
if (shots) {
  for (const devName of ["phone", "ipad"].filter(d => !only || d === only)) {
    for (const theme of ["light", "dark"]) {
      const { ctx, page } = await newPage(DEVICES[devName], theme);
      await shot(page, `${devName}-${theme}-02-list-full`, { fullPage: true });
      for (const id of [ISRAEL.id, LESSONS.find(l => l.track === "basics").id]) {
        await page.click(`.lrn-card[data-open="${id}"]`);
        await page.click(`[data-q="0"][data-o="${LESSONS.find(l => l.id === id).quiz[0].correct}"]`);
        await settle(page);
        await shot(page, `${devName}-${theme}-07-reader-full-${id}`, { fullPage: true });
        await page.click("[data-back]");
      }
      await ctx.close();
    }
  }
}

/* ── every lesson renders; every try-it maps to the right action ── */
{
  const { ctx, page, errors } = await newPage(DEVICES.phone, "light");
  const map = { tx: ["budget", "openTx", []], saving: ["goals", "openTx", [{ type: "saving" }]], limits: ["budget", "openLimits", []],
    goal: ["goals", "openGoal", [null]], categories: ["budget", "openCategories", []], start: ["budget", "openStart", []] };
  for (const l of LESSONS) {
    await page.click(`.lrn-card[data-open="${l.id}"]`);
    await page.waitForSelector("#lrnLessonTitle");
    const r = await page.evaluate(() => ({
      title: document.querySelector("#lrnLessonTitle").textContent,
      text: document.querySelector(".lrn-reader").textContent,
      opts: document.querySelectorAll(".lrn-opt").length,
      take: document.querySelectorAll(".lrn-takeaways li").length,
      tryBtn: !!document.querySelector("[data-try]"),
    }));
    check(r.title.replace(/\s+/g, " ").trim() === l.title.replace(/\s+/g, " "), `${l.id}: title rendered`);
    check(!/undefined|null|NaN|\[object/.test(r.text), `${l.id}: no undefined/null in text`);
    check(r.opts === l.quiz.reduce((n, q) => n + q.options.length, 0) && r.take === l.takeaways.length, `${l.id}: quiz options and takeaways rendered`);
    check(r.tryBtn === !!l.tryIt, `${l.id}: try-it block ${l.tryIt ? "shown" : "absent"}`);
    if (l.tryIt) {
      await page.evaluate(() => { window.__learn.calls.length = 0; });
      await page.click("[data-try]");
      const calls = await page.evaluate(() => window.__learn.calls);
      const [view, fn, fnArgs] = map[l.tryIt.action];
      check(calls.length === 2 && calls[0].args[0] === view && calls[1].name === fn && JSON.stringify(calls[1].args) === JSON.stringify(fnArgs),
        `${l.id}: try-it «${l.tryIt.action}» → setView(${view}) + ${fn}(${JSON.stringify(fnArgs).slice(1, -1)}) (${JSON.stringify(calls)})`);
    }
    await page.click("[data-back]");
  }
  // prev/next walk
  await page.click(`.lrn-card[data-open="${LESSONS[0].id}"]`);
  for (let i = 1; i < LESSONS.length; i++) {
    await page.click(".lrn-step.is-next");
    const t = await page.textContent("#lrnLessonTitle");
    check(t.replace(/\s+/g, " ").trim() === LESSONS[i].title.replace(/\s+/g, " "), `next → ${LESSONS[i].id}`);
  }
  check(await page.locator(".lrn-step.is-next").count() === 0, "last lesson has no «Дальше»");
  // quiz reset
  await page.click('[data-q="0"][data-o="0"]');
  await page.click("[data-reset]");
  const lastId = LESSONS[LESSONS.length - 1].id;
  check(await page.locator(".lrn-opt[aria-disabled]").count() === 0
    && await page.evaluate(id => !(JSON.parse(localStorage.getItem("mh-learn")).quiz || {})[id], lastId)
    && await page.locator(".lrn-quiz-foot").isHidden(), "«Пройти тест заново» clears answers");
  check(errors.length === 0, `all lessons: no page errors: ${errors.join(" | ")}`);
  await collectIcons(page);
  await ctx.close();
}

/* ── everything done: the «continue» card turns into a «все уроки пройдены» note ── */
{
  const ctx = await browser.newContext({ ...DEVICES.phone, colorScheme: "light", locale: "ru-RU" });
  await ctx.addInitScript(ids => { try { localStorage.setItem("mh-learn", JSON.stringify({ v: 1, done: Object.fromEntries(ids.map(id => [id, 1])) })); } catch (e) { /* */ } }, LESSONS.map(l => l.id));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`${base}/tests/learn/harness.html`);
  await page.waitForFunction(() => window.__mounted);
  await page.evaluate(() => document.fonts.ready);
  check(await page.locator(".lrn-all-done").count() === 1 && await page.locator(".lrn-continue").count() === 0, "all done: «Все уроки пройдены» note replaces the continue card");
  check(await page.locator(".lrn-state.is-done").count() === LESSONS.length, "all done: every card says «Пройден»");
  check(errors.length === 0, `all done: no page errors: ${errors.join(" | ")}`);
  await collectIcons(page);
  await shot(page, "phone-light-09-all-done");
  await ctx.close();
}

/* ── storage blocked, actions missing ──────────── */
{
  const { ctx, page, errors } = await newPage(DEVICES.phone, "light", "?nostorage=1&noactions=1");
  check(await page.locator(".lrn-card").count() === LESSONS.length, "no storage: list renders");
  await page.click(`.lrn-card[data-open="${ISRAEL.id}"]`);
  check(await page.locator("[data-try]").count() === 0, "no actions: try-it block is hidden");
  await page.click(`[data-q="0"][data-o="0"]`);
  check(await page.locator('[data-qbox="0"] .lrn-fb-box').count() === 1, "no storage: quiz still works");
  await page.click("[data-done]");
  check(await page.getAttribute("[data-done]", "aria-pressed") === "true", "no storage: done toggle works in memory");
  await page.click("[data-back]");
  check(await page.locator(`.lrn-card[data-open="${ISRAEL.id}"] .lrn-state.is-done`).count() === 1, "no storage: progress kept for the session");
  check(errors.length === 0, `no storage: no page errors: ${errors.join(" | ")}`);
  await ctx.close();
}
{
  // corrupt stored progress must not break the section
  const ctx = await browser.newContext({ ...DEVICES.phone, colorScheme: "light" });
  await ctx.addInitScript(() => { try { localStorage.setItem("mh-learn", "{not json"); } catch (e) { /* */ } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(`${base}/tests/learn/harness.html`);
  await page.waitForFunction(() => window.__mounted);
  check(await page.locator(".lrn-card").count() === LESSONS.length && errors.length === 0, "corrupt localStorage value: list renders, no errors");
  await ctx.close();
}

await browser.close();
server.close();
const missing = [...allIcons].filter(n => !lucide.icons[n]).sort();
check(missing.length === 0, `all icons exist in lucide: missing ${missing.join(", ")}`);
console.log(`\nicons used by the learning section (${allIcons.size}): ${[...allIcons].sort().join(", ")}`);
console.log(`${passed} passed, ${failed} failed${shots ? ` · screenshots in ${path.relative(root, shotDir)}/` : ""}`);
process.exit(failed ? 1 : 0);
