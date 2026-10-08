// End-to-end check of the built PWA (run `node tools/build.mjs` first):
// first launch shows the example budget, a new operation survives a reload (IndexedDB),
// the service worker serves the app offline, and there are no console errors.
// Usage: node tests/e2e/pwa.e2e.mjs [screenshotDir]
import { createRequire } from "node:module";
import fs from "node:fs";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT || "/opt/node-tools/node_modules/playwright";
const { chromium } = require(pwPath);
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });

const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/test/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

try {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(e.message));

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".tx").length > 0, null, { timeout: 10000 });
  check(await page.locator("#notice").isVisible(), "example notice is shown on first launch");
  check((await page.locator(".tx").count()) > 3, "example operations are listed");
  check((await page.locator("#pwaTop").innerHTML()).trim().length > 0, "sync button is rendered in #pwaTop");
  if (shots) await page.screenshot({ path: `${shots}/iphone-first-launch.png`, fullPage: true });

  // add an operation through the floating button
  await page.tap("#fab");
  await page.fill("#txAmount", "1234,5");
  await page.fill("#txNote", "E2E проверка");
  await page.click("#txSave");
  await page.waitForFunction(() => [...document.querySelectorAll(".tx-title")].some(e => e.textContent.includes("E2E проверка")), null, { timeout: 5000 });
  check(true, "new operation appears in the ledger");

  // survives a reload
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".tx").length > 0, null, { timeout: 10000 });
  check(await page.locator(".tx-title", { hasText: "E2E проверка" }).count() === 1, "operation persists after reload (IndexedDB)");

  // service worker takes control, then the app loads offline
  const sw = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    const reg = await navigator.serviceWorker.ready;
    return reg.active ? reg.active.state : "none";
  });
  check(sw === "activated", `service worker active (${sw})`);
  await page.reload({ waitUntil: "networkidle" });
  await ctx.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".tx").length > 0, null, { timeout: 10000 }).catch(() => {});
  check(await page.locator(".tx-title", { hasText: "E2E проверка" }).count() === 1, "app and data load offline");
  const fontsOk = await page.evaluate(() => document.fonts.check('700 16px "Manrope"'));
  check(fontsOk, "Manrope font available offline");
  await ctx.setOffline(false);

  // delete the example budget
  await page.click("#clearEx");
  await page.waitForFunction(() => !document.querySelector("#clearEx"), null, { timeout: 15000 });
  const left = await page.locator(".tx").count();
  check(left === 1, `only the user's own operation remains after clearing the example (${left})`);

  check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await ctx.close();
} catch (e) {
  failures.push(String(e && e.stack || e));
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log("\nall e2e checks passed");
