// Tests for src/store-pwa.js (run: node --test tests/store-pwa.test.mjs).
// The store runs in Node against fake browser globals (tests/helpers/fake-env.mjs),
// a fake IndexedDB (fake-idb.mjs) and a fake Supabase project (fake-supabase.mjs)
// that several "devices" share.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createWindow, FakeStorage, fakeSeed, legacySeed, loadScript, sleep, waitFor, createBroadcastBus } from "./helpers/fake-env.mjs";
import { createFakeIndexedDB } from "./helpers/fake-idb.mjs";
import { createFakeSupabase, FAKE_URL, FAKE_ANON_KEY, FAKE_SERVICE_KEY, tsUs, pgJsonBytes } from "./helpers/fake-supabase.mjs";
import { maxSettings, maxSettingsWire, MAX_GONE } from "./helpers/max-settings.mjs";

const SRC = new URL("../src/store-pwa.js", import.meta.url).pathname;
const SEED_SRC = new URL("../src/seed.js", import.meta.url).pathname;
const { createBudgetStore } = loadScript(SRC);

const SLOW = { write: 1e7, realtime: 1e7, interval: 1e7 };   // no automatic syncs unless a test asks for them
const PW = "secret123";
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const devices = [];

class Device {
  constructor({ server = null, win = null, clock = T0, config = "file", seed = fakeSeed, delays = SLOW, storeOpts = {}, ...winOpts } = {}) {
    this.server = server;
    this.t = clock;
    const cfg = server && config === "file" ? { supabaseUrl: server.url, supabaseAnonKey: server.anonKey } : null;
    this.win = win || createWindow({ server, seed, config: cfg, ...winOpts });
    this.delays = delays;
    this.storeOpts = storeOpts;
    this.snaps = [];
    devices.push(this);
    this.start();
  }
  now = () => this.t;
  tick(ms = 1000) { this.t += ms; return this.t; }
  start(extra = {}) {
    this.snap = null;
    this.store = createBudgetStore({ window: this.win, now: this.now, delays: this.delays, ...this.storeOpts, ...extra });
    this.store.init(s => { this.snap = s; this.snaps.push(s); });
    return this;
  }
  async ready() { await waitFor(() => this.snap && this.snap.status === "ready", { what: "ready" }); return this; }
  async restart(extra) { await this.store.destroy(); this.start(extra); return this.ready(); }
  get tx() { return [...this.snap.tx].sort((a, b) => (a.id < b.id ? -1 : 1)); }
  ids() { return this.tx.map(t => t.id); }
  find(id) { return this.snap.tx.find(t => t.id === id); }
  get sync() { return this.snap.sync; }
  kv() { return this.win.idb.dump(); }
  async signIn(email, pw = PW) { await this.store.sync.signIn(email, pw); await this.store.sync.syncNow(); return this; }
  client() { return this.server.clients.filter(c => c.win === this.win && c.options.auth.storageKey === "budget-pwa-auth").at(-1); }
}
const tx = (over = {}) => ({ type: "expense", amount: 100, category: "groceries", note: "", date: "2026-10-08", createdAt: 1, ...over });
const DEFAULT_SETTINGS = { startBalance: 0, goals: [], limits: {}, categories: [] };
const GOAL = { id: "g_car", name: "Машина", target: 90000, deadline: "", initial: 5000, icon: "Car", createdAt: 1 };
const GOAL2 = { id: "g_trip", name: "Отпуск", target: 10000, deadline: "2027-06-01", initial: 0, icon: "Plane", createdAt: 2 };
const CAT = { id: "c_shuk01", type: "expense", name: "Шук", icon: "ShoppingBasket" };
const CAT2 = { id: "c_tutor01", type: "expense", name: "Репетитор", icon: "GraduationCap" };
// v1 goal (one per user, no id/icon) and what every reader migrates it to
const GOAL_V1 = { name: "Машина", target: 90000, deadline: "", initial: 5000 };
const GOAL_V1_AS_V2 = { id: "g_main", ...GOAL_V1, icon: "Target", createdAt: 0 };
// snap.settings / export settings: v2 shape only, nothing of v1 or of the store's stamps
function assertV2(st) {
  assert.ok(st && typeof st === "object");
  assert.deepEqual(Object.keys(st).filter(k => k !== "example").sort(), ["categories", "goals", "limits", "startBalance"]);
  assert.ok(Array.isArray(st.goals) && Array.isArray(st.categories));
  if ("example" in st) assert.ok(!("goal" in st.example) && Object.keys(st.example).length > 0);
}
const without = (o, ...keys) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };
async function rejects(p, code, message) {
  await assert.rejects(p, e => {
    assert.equal(e.code, code, `code ${e.code} (${e.message})`);
    if (message instanceof RegExp) assert.match(e.message, message);
    else if (message) assert.equal(e.message, message);
    return true;
  });
}
test.afterEach(async () => { for (const d of devices.splice(0)) await d.store.destroy(); });

/* ── local store ──────────────────────────────────────────────────────── */

test("CRUD lands in IndexedDB and survives a re-created store", async () => {
  const d = await new Device().ready();
  assert.equal(d.snap.status, "ready");
  assert.equal(d.snap.readOnly, false);
  assert.equal(d.snap.notice, undefined);

  const id = await d.store.saveTx(null, tx({ amount: 99.999, note: "Хлеб", updatedAt: 5 }));
  assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  let t = d.find(id);
  assert.deepEqual(without(t, "updatedAt"), { id, type: "expense", amount: 100, category: "groceries", note: "Хлеб", date: "2026-10-08", createdAt: 1 });
  assert.equal(t.updatedAt, T0, "updatedAt is the store's own clock, not the caller's");

  let rec = d.kv().tx[id];
  assert.deepEqual([rec.dirty, rec.localOnly, rec.deleted, rec.updatedMs], [true, false, false, T0]);

  d.t -= 60000;                                      // clock went backwards: updatedMs still increases
  await d.store.saveTx(id, tx({ amount: 120, note: "Хлеб и молоко" }));
  rec = d.kv().tx[id];
  assert.equal(rec.updatedMs, T0 + 1);
  assert.equal(d.find(id).amount, 120);

  d.tick(120000);
  await d.store.deleteTx(id);
  assert.equal(d.find(id), undefined);
  assert.equal(d.kv().tx[id].deleted, true, "a deleted record stays as a tombstone");
  await d.store.restoreTx(id, without(t, "id"));
  assert.equal(d.find(id).amount, 100);

  await d.store.saveSettings({
    startBalance: -1500.5,
    goals: [{ id: "g_car", name: " Машина ", target: 90000, deadline: "", initial: 0, icon: "Car", createdAt: 5 }],
    limits: { cafe: 500, bad: -1 },
    categories: [{ id: "c_shuk01", type: "expense", name: " Шук ", icon: "ShoppingBasket" }],
  });
  assert.deepEqual(d.snap.settings, {
    startBalance: -1500.5,
    goals: [{ id: "g_car", name: "Машина", target: 90000, deadline: "", initial: 0, icon: "Car", createdAt: 5 }],
    limits: { cafe: 500 },
    categories: [{ id: "c_shuk01", type: "expense", name: "Шук", icon: "ShoppingBasket" }],
  });

  const before = { tx: d.tx, settings: d.snap.settings };
  await d.restart();
  assert.deepEqual(d.tx, before.tx);
  assert.deepEqual(d.snap.settings, before.settings);
  assert.equal(fakeSeed.calls.length >= 1, true);
  assert.equal(d.kv().meta.seeded, true);
});

test("invalid writes are rejected with code invalid and a Russian message", async () => {
  const d = await new Device().ready();
  await rejects(d.store.saveTx(null, tx({ amount: 0 })), "invalid", /больше нуля/);
  await rejects(d.store.saveTx(null, tx({ amount: 1e10 })), "invalid", /больше нуля/);
  await rejects(d.store.saveTx(null, tx({ amount: "5" })), "invalid");
  await rejects(d.store.saveTx(null, tx({ date: "2026-02-30" })), "invalid", "Укажите дату операции.");
  await rejects(d.store.saveTx(null, tx({ type: "loan" })), "invalid");
  await rejects(d.store.saveTx("bad id!", tx()), "invalid");
  await rejects(d.store.saveSettings({ startBalance: NaN, goals: [], limits: {}, categories: [] }), "invalid");
  await rejects(d.store.saveSettings({ ...DEFAULT_SETTINGS, goals: { g_main: GOAL } }), "invalid", /проверьте введённые значения/);
  await rejects(d.store.saveSettings({ ...DEFAULT_SETTINGS, categories: "c_shuk01" }), "invalid");
  await rejects(d.store.saveSettings({ ...DEFAULT_SETTINGS, limits: [5] }), "invalid");
  await rejects(d.store.saveSettings(null), "invalid");
  assert.equal(d.snap.tx.length, 3, "only the examples");
});

test("first run seeds the example budget as device-only records", async () => {
  const d = await new Device().ready();
  assert.deepEqual(d.ids(), ["ex01", "ex02", "ex03"]);
  assert.ok(d.tx.every(t => t.example === true && t.updatedAt === undefined));
  assert.deepEqual(d.snap.settings.example, { startBalance: true, goals: true, limits: true, categories: true });
  assert.equal(d.find("ex03").goalId, "g_trip");
  assert.equal(d.sync.pending, 0);
  const kv = d.kv();
  assert.ok(Object.values(kv.tx).every(r => r.localOnly && !r.dirty && r.updatedMs === 0));
  assert.equal(kv.settings.localOnly, true);
  assert.deepEqual(fakeSeed.calls.at(-1), "2026-10-08");

  // deleting an example removes it outright; undo restores it as device-only
  const ex = d.find("ex01");
  await d.store.deleteTx("ex01");
  assert.equal(d.kv().tx.ex01, undefined);
  await d.store.restoreTx("ex01", without(ex, "id"));
  assert.equal(d.kv().tx.ex01.localOnly, true);
  assert.equal(d.sync.pending, 0);

  // editing an example (the UI drops the flag) makes it a normal record with an id of its own
  const own = await d.store.saveTx("ex02", without(d.find("ex02"), "id", "example"));
  assert.notEqual(own, "ex02");
  assert.equal(d.kv().tx.ex02, undefined);
  assert.deepEqual([d.kv().tx[own].localOnly, d.kv().tx[own].dirty], [false, true]);
  assert.equal(d.find(own).example, undefined);
  assert.equal(d.sync.pending, 1);

  // "Удалить пример": examples deleted, example settings reset to defaults → still device-only
  await d.store.deleteMany(["ex01", "ex03"], (done, total) => d.progress = [done, total]);
  assert.deepEqual(d.progress, [2, 2]);
  await d.store.saveSettings({ startBalance: 0, goals: [], limits: {}, categories: [] });
  assert.equal(d.kv().settings.localOnly, true);
  assert.deepEqual(d.kv().settings.fieldMs, { startBalance: 0, goals: 0, limits: 0, categories: 0 }, "reset example fields keep stamp 0");
  assert.equal(d.sync.pending, 1);

  // the example is not seeded again on the next start
  await d.restart();
  assert.deepEqual(d.ids(), [own]);
});

test("no BudgetSeed: starts empty; the real src/seed.js seeds a valid example", async () => {
  const empty = await new Device({ seed: null }).ready();
  assert.deepEqual(empty.snap.tx, []);
  assert.equal(empty.snap.settings, null);
  assert.equal(empty.kv().meta.seeded, true);

  if (!existsSync(SEED_SRC)) return;
  const { BudgetSeed } = loadScript(SEED_SRC);
  const d = await new Device({ seed: BudgetSeed, clock: new Date(2026, 9, 8, 12).getTime() }).ready();
  assert.ok(d.snap.tx.length > 20);
  assert.ok(d.snap.tx.every(t => t.example === true && t.date <= "2026-10-08"));
  // v2 shape whatever shape the seed has (an older seed.js had goal instead of goals)
  assertV2(d.snap.settings);
  assert.ok(d.snap.settings.goals.length >= 1);
  assert.ok(Object.keys(d.snap.settings.example).length >= 3);
  assert.ok(Object.keys(d.snap.settings.example).every(k => ["startBalance", "goals", "limits", "categories"].includes(k)));
  const goalIds = new Set(d.snap.settings.goals.map(g => g.id));
  assert.ok(d.snap.tx.every(t => t.goalId === undefined || (t.type === "saving" && goalIds.has(t.goalId))), "example savings point at example goals");
  assert.equal(d.sync.pending, 0);
});

test("storage falls back to localStorage, then memory, and says so", async () => {
  // no IndexedDB at all → localStorage, which persists
  const ls = new FakeStorage();
  const a = await new Device({ noIndexedDB: true, localStorage: ls }).ready();
  assert.match(a.snap.notice, /запасном/);
  const id = await a.store.saveTx(null, tx());
  assert.ok(JSON.parse(ls.getItem("budget-pwa-data")).tx[id]);
  await a.restart();
  assert.ok(a.find(id));

  // IndexedDB fails to open and localStorage throws → memory, data will not persist
  const idb = createFakeIndexedDB();
  idb.ctl.failOpen = "InvalidStateError";
  const broken = new FakeStorage(); broken.broken = true;
  const b = await new Device({ idb, localStorage: broken }).ready();
  assert.match(b.snap.notice, /пропадёт после закрытия/);
  const id2 = await b.store.saveTx(null, tx());
  assert.ok(b.find(id2));
  await b.restart();
  assert.equal(b.find(id2), undefined);

  // IndexedDB open never answers → time out, use localStorage
  const hang = createFakeIndexedDB();
  hang.ctl.hangOpen = true;
  const c = await new Device({ idb: hang, storeOpts: { delays: { ...SLOW, idbTimeout: 30 } } }).ready();
  assert.match(c.snap.notice, /запасном/);
});

test("IndexedDB: quota errors reject with code quota, lost connections are reopened, fallback data is migrated", async () => {
  const d = await new Device().ready();
  d.win.idbCtl.failNextCommit = "QuotaExceededError";
  await rejects(d.store.saveTx(null, tx({ note: "не влезло" })), "quota", /закончилось место/);
  assert.ok(!d.snap.tx.some(t => t.note === "не влезло"));
  assert.ok(!Object.values(d.kv().tx).some(t => t.note === "не влезло"));

  const opens = d.win.idbCtl.opens;
  d.win.idbCtl.failNextTransaction = "InvalidStateError";      // iOS dropped the connection
  const id = await d.store.saveTx(null, tx({ note: "после переподключения" }));
  assert.ok(d.kv().tx[id]);
  assert.equal(d.win.idbCtl.opens, opens + 1);

  // a record written while IndexedDB was unavailable (localStorage fallback) moves into IndexedDB
  const ls = new FakeStorage();
  ls.setItem("budget-pwa-data", JSON.stringify({
    tx: { old1: { id: "old1", type: "income", amount: 5, category: "salary", note: "", date: "2026-10-01", createdAt: 1, deleted: false, updatedMs: 7, dirty: true, localOnly: false } },
    settings: null, meta: { seeded: true },
  }));
  const m = await new Device({ localStorage: ls }).ready();
  assert.ok(m.find("old1"));
  assert.equal(m.find("ex01"), undefined, "the fallback session was already seeded");
  assert.equal(ls.getItem("budget-pwa-data"), null);
  assert.ok(m.kv().tx.old1);
});

test("two tabs on one IndexedDB do not overwrite each other", async () => {
  const idb = createFakeIndexedDB();
  const BC = createBroadcastBus();
  const ls = new FakeStorage();
  const t1 = await new Device({ idb, localStorage: ls, BroadcastChannel: BC }).ready();
  const t2 = await new Device({ idb, localStorage: ls, BroadcastChannel: BC }).ready();
  const [a, b] = await Promise.all([t1.store.saveTx(null, tx({ note: "a" })), t2.store.saveTx(null, tx({ note: "b" }))]);
  const stored = idb.dump().tx;
  assert.ok(stored[a] && stored[b]);
  await waitFor(() => t1.find(b) && t2.find(a), { what: "tabs to see each other" });
});

/* ── configuration ────────────────────────────────────────────────────── */

test("configure() validates the project URL and key; config.js wins over the device", async () => {
  const server = createFakeSupabase();
  const d = await new Device({ server, config: "none" }).ready();
  assert.deepEqual(without(d.sync, "lastSyncAt"), { available: true, configured: false, url: "", configSource: "none", user: null, phase: "off", pending: 0, error: null, recovery: false, link: null, pendingLink: null });

  await rejects(d.store.sync.configure({ url: "", anonKey: FAKE_ANON_KEY }), "invalid", /адрес проекта/i);
  await rejects(d.store.sync.configure({ url: "http://fake.supabase.co", anonKey: FAKE_ANON_KEY }), "invalid", /https:\/\//);
  await rejects(d.store.sync.configure({ url: "fake.supabase.co", anonKey: FAKE_ANON_KEY }), "invalid");
  await rejects(d.store.sync.configure({ url: FAKE_URL, anonKey: "abc" }), "invalid", /eyJ/);
  await rejects(d.store.sync.configure({ url: FAKE_URL, anonKey: FAKE_SERVICE_KEY }), "invalid", /секретный/);
  await rejects(d.store.sync.configure({ url: FAKE_URL, anonKey: "sb_secret_abc" }), "invalid", /секретный/);
  assert.equal(d.server.clients.length, 0);

  await d.store.sync.configure({ url: FAKE_URL + "/rest/v1/", anonKey: " " + FAKE_ANON_KEY + " " });
  assert.equal(d.sync.configured, true);
  assert.equal(d.sync.url, FAKE_URL);
  assert.equal(d.sync.configSource, "device");
  assert.deepEqual(JSON.parse(d.win.localStorage.getItem("budget-pwa-supabase")), { url: FAKE_URL, anonKey: FAKE_ANON_KEY });
  const c = d.client();
  assert.deepEqual(c.options, { auth: { flowType: "implicit", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "budget-pwa-auth" } });

  await d.restart();                                         // device config is remembered
  assert.equal(d.sync.configSource, "device");
  await d.store.sync.configure(null);
  assert.equal(d.sync.configured, false);
  assert.equal(d.win.localStorage.getItem("budget-pwa-supabase"), null);
  assert.doesNotThrow(() => d.store.sync.configure({ url: FAKE_URL, anonKey: "sb_publishable_AbC_123" }));

  const f = await new Device({ server }).ready();
  assert.equal(f.sync.configSource, "file");
  assert.equal(f.sync.configured, true);
  await rejects(f.store.sync.configure({ url: FAKE_URL, anonKey: FAKE_ANON_KEY }), "invalid", /config\.js/);

  const nolib = await new Device({ server: null, config: "none" }).ready();
  assert.equal(nolib.sync.available, false);
  await nolib.store.sync.configure({ url: FAKE_URL, anonKey: FAKE_ANON_KEY });
  assert.equal(nolib.sync.configured, true);
  assert.equal(nolib.sync.phase, "off");
  assert.match(nolib.sync.error, /не загрузился/);
  await rejects(nolib.store.sync.signIn("a@b.c", PW), "unknown", /не загрузился/);
});

/* ── accounts ─────────────────────────────────────────────────────────── */

test("auth errors map to codes and Russian messages", async () => {
  const server = createFakeSupabase({ requireConfirm: true });
  const d = await new Device({ server }).ready();
  const s = d.store.sync;
  await rejects(s.signIn("not-an-email", PW), "invalid", "Проверьте адрес почты.");
  await rejects(s.signUp("anna@example.com", "12345"), "invalid", "Пароль должен быть не короче 6 символов.");

  assert.deepEqual(await s.signUp("anna@example.com", PW), { needsConfirm: true });
  assert.equal(server.emails.at(-1).redirectTo, "https://app.example/budget/");
  await rejects(s.signIn("anna@example.com", PW), "auth", "Подтвердите почту по ссылке из письма, затем войдите.");
  server.confirm("anna@example.com");
  await rejects(s.signIn("anna@example.com", "wrong-password"), "auth", "Неверная почта или пароль.");
  await rejects(s.signUp("anna@example.com", PW), "invalid", /уже есть/);

  server.rateLimitAuth = true;
  await rejects(s.signIn("anna@example.com", PW), "rate", /Подождите/);
  await rejects(s.resetPassword("anna@example.com"), "rate", /Письма/);
  server.rateLimitAuth = false;

  d.win.netDown = true;
  await rejects(s.signIn("anna@example.com", PW), "network", /Нет соединения/);
  d.win.netDown = false;
  d.win.navigator.onLine = false;
  await rejects(s.signIn("anna@example.com", PW), "network");
  d.win.navigator.onLine = true;

  await s.resetPassword("anna@example.com");
  assert.deepEqual(server.emails.at(-1), { type: "recovery", email: "anna@example.com", redirectTo: "https://app.example/budget/" });
  await rejects(s.updatePassword("newpass1"), "auth", "Сначала войдите в аккаунт.");
  await rejects(s.syncNow(), "auth");

  await s.signIn("anna@example.com", PW);
  assert.equal(d.sync.user.email, "anna@example.com");
  await rejects(s.updatePassword(PW), "invalid", /совпадает/);

  const open = createFakeSupabase();
  const o = await new Device({ server: open }).ready();
  assert.deepEqual(await o.store.sync.signUp("bob@example.com", PW), { needsConfirm: false });
  assert.equal(o.sync.user.email, "bob@example.com");
});

test("password recovery link: the new password is set through the link's own session; the device is not signed into it", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const link = server.recoveryLink("anna@example.com");
  const linkToken = new URLSearchParams(link.slice(1)).get("access_token");
  const d = await new Device({ server, href: "https://app.example/budget/" + link }).ready();
  await waitFor(() => d.sync.recovery === true, { what: "recovery flag" });
  assert.equal(d.sync.user, null, "the link's account is not adopted");
  assert.deepEqual(d.sync.link, { type: "recovery", email: "anna@example.com" });
  assert.equal(d.win.location.hash, "", "tokens leave the URL");
  assert.equal(d.win.localStorage.getItem("budget-pwa-auth"), null, "the link's session is never stored as the device's");
  assert.deepEqual(server.setSessionCalls.map(c => c.persist), [false], "checked in a memory-only client");
  await rejects(d.store.sync.updatePassword("123"), "invalid");
  assert.equal(d.sync.recovery, true);
  await d.store.sync.updatePassword("brand-new-pass");
  assert.equal(d.sync.recovery, false);
  assert.equal(d.sync.link, null);
  assert.equal(d.sync.user, null, "afterwards the user signs in inside the app");
  assert.equal(server.tokens.has(linkToken), false, "the link's session was ended");
  assert.deepEqual(d.ids(), ["ex01", "ex02", "ex03"], "local data untouched");
  assert.equal(d.kv().meta.userId, null);

  const other = await new Device({ server }).ready();
  await rejects(other.store.sync.signIn("anna@example.com", PW), "auth", "Неверная почта или пароль.");
  await other.signIn("anna@example.com", "brand-new-pass");
  assert.equal(other.sync.phase, "idle");
});

test("a recovery link of this device's own account signs it in again, as before", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const d = await new Device({ server }).ready();
  await d.signIn("anna@example.com");
  const id = await d.store.saveTx(null, tx({ note: "not synced yet" }));
  d.win.localStorage.removeItem("budget-pwa-auth");          // the session was lost; the user resets the password
  d.win.navigate("https://app.example/budget/" + server.recoveryLink("anna@example.com"));
  await d.restart();
  await waitFor(() => d.sync.recovery && d.sync.user, { what: "recovery with the device's account" });
  assert.equal(d.sync.user.email, "anna@example.com");
  assert.equal(d.sync.link, null);
  assert.equal(d.sync.error, null);
  assert.ok(d.find(id));
  await d.store.sync.updatePassword("brand-new-pass");
  assert.equal(d.sync.recovery, false);
  assert.equal(d.sync.user.email, "anna@example.com", "still signed in");
  await d.store.sync.syncNow();
  assert.equal(d.sync.pending, 0);
  assert.ok(server.rows("transactions").some(r => r.id === id));
});

test("cancelRecovery keeps the password, ends a held link's session and gives the device back", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  server.addUser("bob@example.com");

  // signed in as anna; a reset link of bob's account arrives (asked for or crafted, the app cannot tell)
  const d = await new Device({ server }).ready();
  await d.signIn("anna@example.com");
  const link = server.recoveryLink("bob@example.com");
  const token = new URLSearchParams(link.slice(1)).get("access_token");
  d.win.navigate("https://app.example/budget/" + link);
  await d.restart();
  await waitFor(() => d.sync.recovery && d.sync.user, { what: "recovery link held" });
  assert.deepEqual(d.sync.link, { type: "recovery", email: "bob@example.com" });
  await d.store.sync.cancelRecovery();
  await waitFor(() => !d.sync.recovery, { what: "recovery cleared" });
  assert.equal(d.sync.link, null);
  assert.equal(d.sync.user.email, "anna@example.com");
  assert.equal(server.tokens.has(token), false, "the link's session was ended");
  assert.equal(server.users.get("bob@example.com").password, PW, "bob's password unchanged");
  const id = await d.store.saveTx(null, tx({ note: "after cancel" }));
  await d.store.sync.syncNow();
  assert.equal(d.sync.phase, "idle");
  assert.ok(server.rows("transactions").some(r => r.id === id && r.user_id === d.sync.user.id));

  // signed out: the device goes back to signing in; there is nothing left to change a password with
  const e = await new Device({ server, href: "https://app.example/budget/" + server.recoveryLink("bob@example.com") }).ready();
  await waitFor(() => e.sync.recovery, { what: "recovery (signed out)" });
  await e.store.sync.cancelRecovery();
  await waitFor(() => !e.sync.recovery, { what: "recovery cleared (signed out)" });
  assert.deepEqual([e.sync.link, e.sync.user], [null, null]);
  await rejects(e.store.sync.updatePassword("whatever-1"), "auth", "Сначала войдите в аккаунт.");
  assert.equal(server.users.get("bob@example.com").password, PW);

  // a reset link of this device's own account (its session was adopted): the device stays signed in
  const f = await new Device({ server }).ready();
  await f.signIn("anna@example.com");
  f.win.localStorage.removeItem("budget-pwa-auth");
  f.win.navigate("https://app.example/budget/" + server.recoveryLink("anna@example.com"));
  await f.restart();
  await waitFor(() => f.sync.recovery && f.sync.user, { what: "own recovery" });
  await f.store.sync.cancelRecovery();
  await waitFor(() => !f.sync.recovery, { what: "own recovery cleared" });
  assert.equal(f.sync.user.email, "anna@example.com");
  await f.store.sync.syncNow();
  assert.equal(f.sync.phase, "idle");
  assert.equal(server.users.get("anna@example.com").password, PW);
});

/* ── sync ─────────────────────────────────────────────────────────────── */

test("push/pull round trip between two devices; examples are never uploaded", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  assert.equal(a.sync.phase, "off");
  await a.signIn("anna@example.com");
  assert.equal(a.sync.phase, "idle");
  assert.equal(a.sync.lastSyncAt, a.t);
  assert.equal(server.rows("transactions").length, 0);
  assert.deepEqual(a.ids(), ["ex01", "ex02", "ex03"], "an empty account keeps the example");

  a.tick();
  const id = await a.store.saveTx(null, tx({ amount: 290, note: "Кофе", category: "cafe", createdAt: 42 }));
  await a.store.saveSettings({ startBalance: 1000, goals: [], limits: { cafe: 3000 }, categories: [] });
  assert.equal(a.sync.pending, 2);
  await a.store.sync.syncNow();
  assert.equal(a.sync.pending, 0);
  const uid = a.sync.user.id;
  const [row] = server.rows("transactions");
  assert.deepEqual(without(row, "updated_at"), {
    user_id: uid, id, type: "expense", amount: 290, category: "cafe", note: "Кофе", date: "2026-10-08",
    created_ms: 42, goal_id: null, example: false, deleted: false, client_updated_ms: a.t,
  });
  assert.match(row.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/);
  const [srow] = server.rows("budget_settings");
  assert.deepEqual(without(srow.data, "_ms"), { startBalance: 1000, goals: [], limits: { cafe: 3000 }, categories: [] });
  // per-field stamps: goals and categories still have their (removed) example values' 0, the others were set now
  const noEntries = { since: 0, ms: {}, gone: {} };
  assert.deepEqual(srow.data._ms, { startBalance: a.t, goals: 0, limits: a.t, categories: 0, at: a.t, items: { goals: noEntries, categories: noEntries } });
  assert.equal(srow.client_updated_ms, a.t);
  assert.equal(server.log.filter(l => l.op === "upsert").every(l => l.onConflict === (l.table === "transactions" ? "user_id,id" : "user_id")), true);
  assert.ok(server.log.filter(l => l.op === "select").every(l => l.filters.some(f => f[0] === "eq" && f[1] === "user_id" && f[2] === uid)));

  const b = await new Device({ server }).ready();
  await b.signIn("anna@example.com");
  assert.deepEqual(b.ids(), [id], "the account had data, so b's example went away");
  assert.deepEqual(without(b.find(id), "updatedAt"), without(a.find(id), "updatedAt"));
  assert.deepEqual(b.snap.settings, { startBalance: 1000, goals: [], limits: { cafe: 3000 }, categories: [] });
  assert.equal(b.sync.pending, 0);

  b.tick(5000);
  await b.store.saveTx(id, { ...without(b.find(id), "id"), amount: 300 });
  await b.store.sync.syncNow();
  await a.store.sync.syncNow();
  assert.equal(a.find(id).amount, 300);
  assert.equal(a.find(id).updatedAt, b.t);
});

test("last writer wins in both directions, also when an older push reaches the server last", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server, clock: 1_000_000 }).ready();
  const b = await new Device({ server, clock: 1_000_000 }).ready();
  await a.signIn("anna@example.com");
  const id = await a.store.saveTx(null, tx({ amount: 1 }));
  await a.store.sync.syncNow();
  await b.signIn("anna@example.com");
  const set = (d, amount) => d.store.saveTx(id, tx({ amount }));

  // remote newer beats a local dirty edit that is older
  a.t = 2_000_000; await set(a, 111);
  b.t = 3_000_000; await set(b, 222); await b.store.sync.syncNow();
  await a.store.sync.syncNow();
  assert.equal(a.find(id).amount, 222);
  assert.equal(a.sync.pending, 0);
  assert.equal(server.rows("transactions")[0].client_updated_ms, 3_000_000);

  // a local dirty edit that is newer beats the remote one and is pushed
  b.t = 4_000_000; await set(b, 333); await b.store.sync.syncNow();
  a.t = 5_000_000; await set(a, 444); await a.store.sync.syncNow();
  assert.equal(a.find(id).amount, 444);
  assert.equal(server.rows("transactions")[0].amount, 444);
  await b.store.sync.syncNow();
  assert.equal(b.find(id).amount, 444);

  // race: b pushes a newer version while a's older push is in flight → the server keeps b's,
  // and a converges on its next pull
  a.t = 6_000_000; await set(a, 555);
  b.t = 7_000_000; await set(b, 666);
  let raced = false;
  server.hooks.beforeUpsert = async (table, rows, client) => {
    if (!raced && client.win === a.win) { raced = true; await b.store.sync.syncNow(); }
  };
  await a.store.sync.syncNow();
  server.hooks.beforeUpsert = null;
  assert.ok(raced);
  assert.equal(server.rows("transactions")[0].amount, 666);
  await a.store.sync.syncNow();
  assert.equal(a.find(id).amount, 666);
});

test("settings: last writer wins", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server, clock: 1_000_000 }).ready();
  const b = await new Device({ server, clock: 1_000_000 }).ready();
  await a.signIn("anna@example.com");
  await b.signIn("anna@example.com");
  const S = sb => ({ startBalance: sb, goals: [], limits: {}, categories: [] });

  a.t = 2_000_000; await a.store.saveSettings(S(2));
  b.t = 3_000_000; await b.store.saveSettings(S(3)); await b.store.sync.syncNow();
  await a.store.sync.syncNow();
  assert.equal(a.snap.settings.startBalance, 3);
  assert.equal(a.sync.pending, 0);

  b.t = 4_000_000; await b.store.saveSettings(S(4)); await b.store.sync.syncNow();
  a.t = 5_000_000; await a.store.saveSettings(S(5)); await a.store.sync.syncNow();
  assert.equal(server.rows("budget_settings")[0].data.startBalance, 5);
  assert.equal(server.rows("budget_settings")[0].client_updated_ms, 5_000_000);
  await b.store.sync.syncNow();
  assert.equal(b.snap.settings.startBalance, 5);
});

test("deletes travel as tombstones; a newer edit beats an older delete", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server, clock: 1_000_000 }).ready();
  const b = await new Device({ server, clock: 1_000_000 }).ready();
  await a.signIn("anna@example.com");
  const id1 = await a.store.saveTx(null, tx({ note: "one" }));
  const id2 = await a.store.saveTx(null, tx({ note: "two" }));
  await a.store.sync.syncNow();
  await b.signIn("anna@example.com");
  assert.deepEqual(b.ids().sort(), [id1, id2].sort());

  a.tick(); await a.store.deleteTx(id1);
  await a.store.sync.syncNow();
  const row = server.rows("transactions").find(r => r.id === id1);
  assert.equal(row.deleted, true);
  assert.equal(row.amount, 100, "tombstones keep the last values (schema checks still pass)");
  await b.store.sync.syncNow();
  assert.equal(b.find(id1), undefined);
  assert.equal(b.kv().tx[id1].deleted, true);

  a.t = 2_000_000; await a.store.deleteTx(id2);
  b.t = 3_000_000; await b.store.saveTx(id2, tx({ note: "two, edited later" }));
  await a.store.sync.syncNow();
  await b.store.sync.syncNow();
  await a.store.sync.syncNow();
  assert.equal(a.find(id2).note, "two, edited later");
  assert.equal(b.find(id2).note, "two, edited later");

  // undo of a delete comes back on the other device too
  a.tick(2_000_000); await a.store.restoreTx(id1, tx({ note: "one again" }));
  await a.store.sync.syncNow();
  await b.store.sync.syncNow();
  assert.equal(b.find(id1).note, "one again");
});

test("a record edited while its push is in flight stays dirty", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  const id = await a.store.saveTx(null, tx({ amount: 1 }));
  const gone = await a.store.saveTx(null, tx({ amount: 7 }));

  let release, entered = false;
  const gate = new Promise(r => { release = r; });
  server.hooks.beforeUpsert = async table => { if (table === "transactions" && !entered) { entered = true; await gate; } };
  const p = a.store.sync.syncNow();
  await waitFor(() => entered, { what: "push to start" });
  assert.equal(a.sync.phase, "syncing");
  a.tick(); await a.store.saveTx(id, tx({ amount: 2 }));
  a.tick(); await a.store.deleteTx(gone);
  release();
  await p;
  server.hooks.beforeUpsert = null;

  assert.equal(server.rows("transactions").find(r => r.id === id).amount, 1);
  assert.equal(a.kv().tx[id].dirty, true);
  assert.equal(a.kv().tx[gone].dirty, true);
  assert.equal(a.sync.pending, 2);
  assert.equal(a.find(id).amount, 2, "the pull did not overwrite the newer local edit");

  await a.store.sync.syncNow();
  assert.equal(server.rows("transactions").find(r => r.id === id).amount, 2);
  assert.equal(server.rows("transactions").find(r => r.id === gone).deleted, true);
  assert.equal(a.sync.pending, 0);
});

test("offline: changes stay pending, phase is offline, and reconnecting syncs them", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");

  a.win.setOnline(false);
  await sleep(5);
  assert.equal(a.sync.phase, "offline");
  const id = await a.store.saveTx(null, tx());
  await rejects(a.store.sync.syncNow(), "network", /Нет соединения/);
  assert.equal(a.sync.phase, "offline");
  assert.equal(a.sync.pending, 1);
  assert.equal(a.sync.error, null);
  assert.equal(server.log.filter(l => l.op === "upsert").length, 0);

  // navigator says online but requests fail
  a.win.navigator.onLine = true;
  a.win.netDown = true;
  await rejects(a.store.sync.syncNow(), "network");
  assert.equal(a.sync.phase, "offline");
  assert.equal(a.sync.pending, 1);

  // a response lost after the server applied the write: the re-push is idempotent
  a.win.netDown = false;
  server.dropNextResponse = true;
  await rejects(a.store.sync.syncNow(), "network");
  assert.equal(server.rows("transactions").length, 1);
  assert.equal(a.sync.pending, 1);

  a.win.setOnline(true);                                   // the "online" event triggers a sync
  await waitFor(() => a.sync.pending === 0 && a.sync.phase === "idle", { what: "sync after online" });
  assert.equal(server.rows("transactions").length, 1);
  assert.equal(server.rows("transactions")[0].id, id);
});

test("automatic triggers: 1.5 s after a write (debounced), on visibility, and from Realtime", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const fast = { write: 40, realtime: 30, interval: 1e7 };
  const a = await new Device({ server, delays: fast }).ready();
  const b = await new Device({ server, delays: fast }).ready();
  await a.signIn("anna@example.com");
  await b.signIn("anna@example.com");
  await sleep(20);                                           // let both channels join

  const upserts = () => server.log.filter(l => l.op === "upsert" && l.uid === a.sync.user.id).length;
  const before = upserts();
  const id1 = await a.store.saveTx(null, tx({ note: "1" }));
  const id2 = await a.store.saveTx(null, tx({ note: "2" }));
  await waitFor(() => server.rows("transactions").length === 2, { what: "debounced push" });
  assert.equal(upserts() - before, 1, "two quick writes → one push");

  // b hears about it through Realtime and pulls
  await waitFor(() => b.find(id1) && b.find(id2), { what: "realtime pull on b" });

  // a's own change echoes back through Realtime but does not cause another pull on a
  const aSelects = () => server.log.filter(l => l.op === "select" && l.table === "transactions" && server.clients.find(c => c.win === a.win)).length;
  await sleep(80);
  const n = server.log.length;
  await sleep(80);
  assert.equal(server.log.length, n, "no echo-triggered syncs");
  assert.ok(aSelects() > 0);

  // coming back to the app syncs
  server.put("transactions", { user_id: a.sync.user.id, id: "fromweb", type: "income", amount: 5, date: "2026-10-01", client_updated_ms: 1 });
  server.realtime = false;                                  // pretend the event was missed
  a.win.setVisible(false);
  a.win.setVisible(true);
  await waitFor(() => a.find("fromweb"), { what: "visibility sync" });

  // after a Realtime reconnect the store catches up
  server.realtime = true;
  server.tables.transactions.get(`${a.sync.user.id}|fromweb`).amount = 6;   // silent change, no event
  server.tables.transactions.get(`${a.sync.user.id}|fromweb`).client_updated_ms = 2;
  server.tables.transactions.get(`${a.sync.user.id}|fromweb`).updated_at = server.stamp();
  [...server.channels].find(ch => ch.client.win === b.win).reconnect();
  await waitFor(() => b.find("fromweb") && b.find("fromweb").amount === 6, { what: "pull after reconnect" });
});

test("Realtime unavailable is tolerated; sign-out removes the channel", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  server.realtime = false;
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  assert.equal(a.sync.phase, "idle");

  server.realtime = true;
  const b = await new Device({ server }).ready();
  await b.signIn("anna@example.com");
  assert.equal([...server.channels].filter(ch => ch.client.win === b.win).length, 1);
  const ch = [...server.channels].find(c => c.client.win === b.win);
  assert.deepEqual(ch.handlers.map(h => [h.filter.table, h.filter.filter]), [
    ["transactions", `user_id=eq.${b.sync.user.id}`], ["budget_settings", `user_id=eq.${b.sync.user.id}`]]);
  await b.store.sync.signOut();
  assert.equal([...server.channels].filter(c => c.client.win === b.win).length, 0);
});

test("never two syncs at once: concurrent calls share one follow-up", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  let active = 0, max = 0;
  const startLog = server.log.length;
  server.hooks.beforeSelect = async () => { active++; max = Math.max(max, active); await sleep(10); active--; };
  await Promise.all([1, 2, 3, 4, 5].map(() => a.store.sync.syncNow()));
  server.hooks.beforeSelect = null;
  assert.equal(max, 1);
  const pulls = server.log.slice(startLog).filter(l => l.op === "select" && l.table === "transactions").length;
  assert.equal(pulls, 2, "the running sync plus one queued follow-up");
});

test("paging: pulls > 1000 rows in pages of 1000 with a fixed lower bound, pushes chunks of ≤ 500", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  const N = 2345;
  const many = Array.from({ length: N }, (_, i) => ({ id: "r" + i, type: "expense", amount: i + 1, category: "other", note: "", date: "2026-09-15", createdAt: i, updatedAt: 1000 + i }));
  const res = await a.store.backup.import({ app: "budget", version: 1, exportedAt: "2026-10-08T00:00:00Z", settings: null, tx: many });
  assert.deepEqual(res, { added: N, updated: 0, skipped: 0, settingsUpdated: false });
  const mark = server.log.length;
  await a.store.sync.syncNow();
  const chunks = server.log.slice(mark).filter(l => l.op === "upsert" && l.table === "transactions").map(l => l.n);
  assert.deepEqual(chunks, [500, 500, 500, 500, 345]);
  assert.equal(server.rows("transactions").length, N);
  assert.equal(a.sync.pending, 0);

  const b = await new Device({ server }).ready();
  const m2 = server.log.length;
  await b.store.sync.signIn("anna@example.com", PW);       // starts the first sync by itself
  await waitFor(() => b.sync.phase === "idle" && b.snap.tx.length === N, { what: "first sync on b" });
  const pages = server.log.slice(m2).filter(l => l.op === "select" && l.table === "transactions");
  assert.deepEqual(pages.map(p => p.range), [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.deepEqual(pages.map(p => p.n), [1000, 1000, 345]);
  const bounds = new Set(pages.map(p => p.filters.find(f => f[0] === "gt")[2]));
  assert.equal(bounds.size, 1, "every page uses the same lower bound");
  assert.equal(b.snap.tx.length, N);
  const maxTs = server.rows("transactions").map(r => r.updated_at).sort((x, y) => tsUs(x) - tsUs(y)).at(-1);
  assert.equal(b.kv().meta.cursorTx, maxTs);

  // the next pull starts 2 minutes before the cursor
  const m3 = server.log.length;
  await b.store.sync.syncNow();
  const gt = server.log.slice(m3).find(l => l.op === "select" && l.table === "transactions").filters.find(f => f[0] === "gt")[2];
  assert.equal(Math.round((tsUs(maxTs) - tsUs(gt)) / 1000), 120000);
});

test("paging: a row that moves while pages are read cannot be skipped for good", async () => {
  const server = createFakeSupabase();
  const u = server.addUser("anna@example.com");
  for (let i = 0; i < 1500; i++) {                           // written 10 minutes ago, far below any overlap
    server.backdateNextMs = 600000;
    server.put("transactions", { user_id: u.id, id: "r" + String(i).padStart(4, "0"), type: "expense", amount: 1, date: "2026-10-01", client_updated_ms: 1 });
  }
  let moved = false;
  server.hooks.beforeSelect = async (table, q) => {
    if (table === "transactions" && q.rangeV && q.rangeV[0] === 1000 && !moved) {
      moved = true;                                          // another device edits a row from page 1
      server.put("transactions", { user_id: u.id, id: "r0000", type: "expense", amount: 2, date: "2026-10-01", client_updated_ms: 2 });
    }
  };
  const b = await new Device({ server }).ready();
  await b.store.sync.signIn("anna@example.com", PW);
  await waitFor(() => moved && b.sync.phase === "idle", { what: "first sync" });
  server.hooks.beforeSelect = null;
  await b.store.sync.syncNow();
  assert.equal(b.snap.tx.length, 1500);
  assert.equal(b.find("r0000").amount, 2);
  assert.ok(b.find("r1000"), "the row shifted out of page 2 was fetched by the follow-up pull");
});

test("rows committed late (inside the 2-minute overlap) are still pulled", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  const b = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  await a.store.saveTx(null, tx({ note: "first" }));
  await a.store.sync.syncNow();
  await b.signIn("anna@example.com");
  server.backdateNextMs = 60000;                            // a long transaction: stamped before b's cursor
  const late = await a.store.saveTx(null, tx({ note: "late" }));
  await a.store.sync.syncNow();
  assert.ok(tsUs(server.rows("transactions").find(r => r.id === late).updated_at) < tsUs(b.kv().meta.cursorTx));
  await b.store.sync.syncNow();
  assert.ok(b.find(late));
});

/* ── account switching ────────────────────────────────────────────────── */

test("signing into an account with data removes the example; an empty account keeps it", async () => {
  const server = createFakeSupabase();
  server.addUser("full@example.com");
  server.addUser("empty@example.com");
  server.addUser("partial@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("full@example.com");
  await a.store.saveSettings({ startBalance: 777, goals: [], limits: {}, categories: [] });
  const real = await a.store.saveTx(null, tx({ note: "real" }));
  await a.store.sync.syncNow();

  const b = await new Device({ server }).ready();
  assert.equal(b.snap.tx.length, 3);
  await b.signIn("full@example.com");
  assert.deepEqual(b.ids(), [real]);
  assert.deepEqual(b.snap.settings, { startBalance: 777, goals: [], limits: {}, categories: [] });
  assert.ok(Object.values(b.kv().tx).every(r => !r.localOnly));

  // empty account: the example stays on the device and is not uploaded; own records are
  const c = await new Device({ server }).ready();
  const mine = await c.store.saveTx(null, tx({ note: "mine" }));
  await c.signIn("empty@example.com");
  assert.deepEqual(c.ids(), ["ex01", "ex02", "ex03", mine].sort());
  const uidEmpty = c.sync.user.id;
  assert.deepEqual(server.rows("transactions", uidEmpty).map(r => r.id), [mine]);
  assert.equal(server.rows("budget_settings", uidEmpty).length, 0);
  assert.equal(c.sync.pending, 0);

  // an account with operations but no settings: example fields the user did not touch are reset
  const p = await new Device({ server }).ready();
  await p.signIn("partial@example.com");
  await p.store.saveTx(null, tx({ note: "p" }));
  await p.store.sync.syncNow();
  // untouched example settings and an account without settings: the example settings go away too
  const e = await new Device({ server }).ready();
  await e.signIn("partial@example.com");
  assert.equal(e.snap.settings, null);
  assert.ok(!e.snap.tx.some(t => t.example));
  // user-edited example settings: the fields still holding example values are reset, the user's value stays
  const d = await new Device({ server }).ready();
  const seeded = d.snap.settings;
  await d.store.saveSettings({ ...seeded, startBalance: 1234, example: { goals: true, limits: true, categories: true } });
  assert.equal(d.kv().settings.localOnly, false);
  await d.signIn("partial@example.com");
  assert.deepEqual(d.snap.settings, { startBalance: 1234, goals: [], limits: {}, categories: [] });
  assert.deepEqual(without(server.rows("budget_settings", d.sync.user.id)[0].data, "_ms"), { startBalance: 1234, goals: [], limits: {}, categories: [] });
});

test("signing in after anonymous use keeps and uploads the local records", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  const theirs = await a.store.saveTx(null, tx({ note: "from a" }));
  await a.store.sync.syncNow();

  const b = await new Device({ server }).ready();
  const m1 = await b.store.saveTx(null, tx({ note: "offline 1" }));
  const m2 = await b.store.saveTx(null, tx({ note: "offline 2" }));
  const gone = await b.store.saveTx(null, tx({ note: "deleted before sign-in" }));
  await b.store.deleteTx(gone);
  assert.equal(b.sync.pending, 3);
  await b.signIn("anna@example.com");
  assert.deepEqual(b.ids(), [theirs, m1, m2].sort());
  assert.equal(b.sync.pending, 0);
  await a.store.sync.syncNow();
  assert.deepEqual(a.ids().filter(id => !id.startsWith("ex")).sort(), [theirs, m1, m2].sort());
});

test("signing in as a different user wipes the previous user's data first", async () => {
  const server = createFakeSupabase();
  const u = server.addUser("u@example.com");
  const v = server.addUser("v@example.com");
  const x = await new Device({ server }).ready();
  await x.signIn("v@example.com");
  const vTx = await x.store.saveTx(null, tx({ note: "V's" }));
  await x.store.sync.syncNow();

  const a = await new Device({ server }).ready();
  await a.signIn("u@example.com");
  const uTx = await a.store.saveTx(null, tx({ note: "U's" }));
  await a.store.saveSettings({ startBalance: 5, goals: [], limits: {}, categories: [] });
  await a.store.sync.syncNow();
  const unpushed = await a.store.saveTx(null, tx({ note: "U's, not synced" }));

  await a.signIn("v@example.com");
  assert.equal(a.sync.user.email, "v@example.com");
  assert.deepEqual(a.ids(), [vTx]);
  assert.equal(a.snap.settings, null);
  assert.equal(a.kv().meta.userId, v.id);
  assert.deepEqual(server.rows("transactions", v.id).map(r => r.id), [vTx], "nothing of U's reached V's account");
  assert.deepEqual(server.rows("transactions", u.id).map(r => r.id), [uTx]);
  assert.ok(!a.find(unpushed));
});

test("sign-out pushes pending changes, ends only this device's session and wipes the device", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  const b = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  await b.signIn("anna@example.com");
  const id = await a.store.saveTx(null, tx({ note: "last minute" }));
  await a.store.sync.signOut();

  assert.ok(server.rows("transactions").some(r => r.id === id), "pending change pushed before sign-out");
  assert.deepEqual(server.signOutScopes, ["local"]);
  assert.deepEqual(a.snap.tx, []);
  assert.equal(a.snap.settings, null);
  assert.equal(a.sync.user, null);
  assert.equal(a.sync.phase, "off");
  assert.equal(a.sync.pending, 0);
  assert.deepEqual(a.kv().tx, {});
  assert.deepEqual(a.kv().meta, { seeded: true, userId: null, cursorTx: null, cursorSettings: null, lastSyncAt: null });
  assert.equal(a.win.localStorage.getItem("budget-pwa-auth"), null);
  await b.store.sync.syncNow();                             // the other device is still signed in
  assert.equal(b.sync.phase, "idle");
  await a.restart();
  assert.equal(a.sync.user, null);
  assert.deepEqual(a.snap.tx, []);

  // can sign in again afterwards on the same page
  await a.signIn("anna@example.com");
  assert.ok(a.find(id));

  // offline sign-out still forgets the session and the data
  a.win.netDown = true;
  await a.store.sync.signOut();
  assert.deepEqual(a.snap.tx, []);
  assert.equal(a.win.localStorage.getItem("budget-pwa-auth"), null);
  a.win.netDown = false;
  await a.restart();
  assert.equal(a.sync.user, null);
});

test("an expired session signs the user out but keeps the local data", async () => {
  const server = createFakeSupabase();
  const u = server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  const id = await a.store.saveTx(null, tx());
  server.revokeUser(u.id);
  await rejects(a.store.sync.syncNow(), "auth", "Сессия истекла. Войдите снова.");
  assert.equal(a.sync.user, null);
  assert.equal(a.sync.phase, "off");
  assert.equal(a.sync.error, "Сессия истекла. Войдите снова.");
  assert.ok(a.find(id));
  assert.equal(a.sync.pending, 1);

  await a.signIn("anna@example.com");                       // same user again: nothing is wiped
  assert.ok(a.find(id));
  assert.equal(a.sync.pending, 0);
  assert.equal(a.sync.error, null);
});

test("a failed e-mail link and a session lost while the app was closed are explained", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const l = await new Device({ server, href: "https://app.example/budget/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired" }).ready();
  await waitFor(() => l.sync.error, { what: "link error" });
  assert.equal(l.sync.error, "Ссылка из письма устарела или уже использована. Запросите новое письмо.");
  await l.signIn("anna@example.com");
  assert.equal(l.sync.error, null);

  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  const id = await a.store.saveTx(null, tx());
  a.win.localStorage.removeItem("budget-pwa-auth");          // e.g. the browser dropped the session
  await a.restart();
  await waitFor(() => a.sync.error, { what: "session-ended message" });
  assert.equal(a.sync.user, null);
  assert.match(a.sync.error, /Войдите снова/);
  assert.ok(a.find(id));
});

test("switching to another project keeps local data as anonymous and uploads it there", async () => {
  const s1 = createFakeSupabase({ url: "https://one.supabase.co" });
  const s2 = createFakeSupabase({ url: "https://two.supabase.co" });
  s1.addUser("anna@example.com");
  s2.addUser("anna@example.com");
  const win = createWindow({ seed: fakeSeed });
  win.supabase = { createClient: (url, key, o) => (url.includes("one") ? s1 : s2).createClient(url, key, o, win) };
  const d = await new Device({ win }).ready();
  await d.store.sync.configure({ url: s1.url, anonKey: FAKE_ANON_KEY });
  await d.store.sync.signIn("anna@example.com", PW);
  const id = await d.store.saveTx(null, tx());
  await d.store.sync.syncNow();
  await d.store.sync.configure({ url: s2.url, anonKey: FAKE_ANON_KEY });
  assert.equal(d.sync.user, null);
  assert.ok(d.find(id));
  assert.equal(d.sync.pending, 1);
  await d.store.sync.signIn("anna@example.com", PW);
  await d.store.sync.syncNow();
  assert.deepEqual(s2.rows("transactions").map(r => r.id), [id]);
});

/* ── backup ───────────────────────────────────────────────────────────── */

test("backup export has the documented shape; import validates every record", async () => {
  const d = await new Device().ready();
  const id = await d.store.saveTx(null, tx({ note: "моё" }));
  await d.store.saveSettings({ startBalance: 10, goals: [], limits: {}, categories: [] });
  const out = d.store.backup.export();
  assert.equal(out.app, "budget");
  assert.equal(out.version, 2);
  assert.equal(out.exportedAt, new Date(T0).toISOString());
  assert.deepEqual(out.settings, { startBalance: 10, goals: [], limits: {}, categories: [] });
  assert.equal(out.settingsUpdatedAt, T0);
  assert.deepEqual(out.settingsFieldsUpdatedAt, { startBalance: T0, goals: 0, limits: 0, categories: 0 });
  assert.equal(out.tx.length, 4);
  assert.deepEqual(Object.keys(out.tx.find(t => t.id === id)).sort(), ["amount", "category", "createdAt", "date", "id", "note", "type", "updatedAt"]);
  assert.ok(out.tx.filter(t => t.example).every(t => t.updatedAt === undefined));
  JSON.parse(JSON.stringify(out));

  const imp = data => d.store.backup.import(data);
  const file = txs => ({ app: "budget", version: 1, exportedAt: "x", settings: null, tx: txs });
  await rejects(imp(null), "invalid", "Файл не похож на резервную копию бюджета.");
  await rejects(imp("{not json"), "invalid", /не похож/);
  await rejects(imp({ app: "other", version: 1, tx: [] }), "invalid", /не похож/);
  await rejects(imp({ app: "budget", version: 3, tx: [] }), "invalid", /более новой версией/);
  await rejects(imp({ app: "budget", version: 0, tx: [] }), "invalid", /не похож/);
  const ok = { id: "ok1", type: "income", amount: 5, category: "salary", note: "", date: "2026-10-01", createdAt: 1 };
  await rejects(imp(file([ok, ok, { ...ok, id: "x", amount: -1 }])), "invalid", /операция №3: сумма/);
  await rejects(imp(file([{ ...ok, id: "with space" }])), "invalid", /№1: неверный идентификатор/);
  await rejects(imp(file([{ ...ok, id: "a".repeat(65) }])), "invalid", /идентификатор/);
  await rejects(imp(file([{ ...ok, date: "2026-02-30" }])), "invalid", /дата/);
  await rejects(imp(file([{ ...ok, type: "transfer" }])), "invalid", /тип/);
  await rejects(imp(file([{ ...ok, note: 5 }])), "invalid");
  await rejects(imp({ ...file([]), settings: { startBalance: "a lot" } }), "invalid", /настройки/);
  await rejects(imp({ ...file([]), settings: { startBalance: 1, goals: "many" } }), "invalid", /настройки/);
  await rejects(imp({ ...file([]), settings: { startBalance: 1, huge: "x".repeat(70000) } }), "invalid", /настройки/);
  assert.equal(d.find("ok1"), undefined, "a failed import changes nothing");
});

test("backup import merges by timestamp: newer wins, untimed records lose to existing ones", async () => {
  const d = await new Device({ clock: 5000 }).ready();
  const e1 = await d.store.saveTx("e1", tx({ note: "e1 local" }));
  const e2 = await d.store.saveTx("e2", tx({ note: "e2 local" }));
  const e3 = await d.store.saveTx("e3", tx({ note: "e3 local" }));
  await d.store.deleteTx("e3");                               // tombstone at 5001
  await d.store.saveSettings({ startBalance: 1, goals: [], limits: {}, categories: [] });
  d.t = 100_000;                                              // backup timestamps from the future are capped at "now"
  const base = { type: "expense", amount: 1, category: "other", date: "2026-10-01", createdAt: 0 };
  const res = await d.store.backup.import(JSON.stringify({
    app: "budget", version: 1, exportedAt: "2026-10-08T00:00:00Z",
    settings: { startBalance: 99, goals: [], limits: {}, categories: [] }, settingsUpdatedAt: 6000,
    tx: [
      { ...base, id: e1, note: "older", updatedAt: 4000 },          // skipped: older
      { ...base, id: e2, note: "newer", updatedAt: 6000 },          // updated
      { ...base, id: "e3", note: "back", updatedAt: 9000 },         // newer than the tombstone: comes back
      { ...base, id: "ex01", note: "no timestamp" },               // skipped: untimed vs existing example
      { ...base, id: "n1", note: "new, untimed" },                 // added
      { ...base, id: "n2", note: "dup older", updatedAt: 10 },     // duplicate id: the newer copy is used,
      { ...base, id: "n2", note: "dup newer", updatedAt: 20, example: true },   // but example records are never imported
    ],
  }));
  assert.deepEqual(res, { added: 3, updated: 1, skipped: 3, settingsUpdated: true });
  assert.equal(d.find(e1).note, "e1 local");
  assert.equal(d.find(e2).note, "newer");
  assert.equal(d.find("e3").note, "back");
  assert.notEqual(d.find("ex01").note, "no timestamp");
  assert.equal(d.find("n1").note, "new, untimed");
  assert.equal(d.find("n2").note, "dup older");
  assert.equal(d.find("n2").example, undefined);
  assert.equal(d.snap.settings.startBalance, 99);
  const kv = d.kv();
  for (const id of [e2, "e3", "n1", "n2"]) assert.deepEqual([kv.tx[id].dirty, kv.tx[id].localOnly], [true, false], id);
  assert.equal(kv.tx[e2].updatedMs, 6000);
  assert.equal(kv.tx.n1.updatedMs, 0);
  assert.equal(kv.settings.dirty, true);

  // a whole round trip: export from one device, import on a fresh one (its example is not overwritten)
  const fresh = await new Device().ready();
  const res2 = await fresh.store.backup.import(d.store.backup.export());
  assert.equal(res2.added, d.snap.tx.length - 3);
  assert.equal(res2.skipped, 3);
  assert.deepEqual(fresh.snap.settings, d.snap.settings);
});

test("imported records are uploaded on the next sync", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  await a.store.backup.import({ app: "budget", version: 1, exportedAt: "", settings: null, tx: [{ id: "imp1", type: "income", amount: 10, category: "salary", note: "", date: "2026-10-01", createdAt: 0, updatedAt: 123 }] });
  assert.equal(a.sync.pending, 1);
  await a.store.sync.syncNow();
  assert.deepEqual(server.rows("transactions").map(r => [r.id, r.client_updated_ms]), [["imp1", 123]]);
});

const GOAL_IMPORT = { id: "g_repair", name: "Ремонт", target: 30000, deadline: "", initial: 0, icon: "Hammer", createdAt: 3 };
const CAT_IMPORT = { id: "c_vaad01", type: "expense", name: "Ваад байт", icon: "Building2" };
test("a backup file without settings timestamps restores settings over nothing, the example or defaults, never over the user's values", async () => {
  const untimed = { app: "budget", version: 2, exportedAt: "2026-10-01T00:00:00Z", settings: { startBalance: 777, goals: [GOAL_IMPORT], limits: { cafe: 5 }, categories: [CAT_IMPORT] }, tx: [] };
  const want = { startBalance: 777, goals: [GOAL_IMPORT], limits: { cafe: 5 }, categories: [CAT_IMPORT] };

  // no settings at all (no example seeded; the same state as after a sign-out)
  const none = await new Device({ seed: null }).ready();
  assert.equal(none.snap.settings, null);
  assert.equal((await none.store.backup.import(untimed)).settingsUpdated, true);
  assert.deepEqual(none.snap.settings, want);
  assert.deepEqual([none.kv().settings.dirty, none.kv().settings.localOnly], [true, false]);
  assert.deepEqual((await none.store.backup.import(untimed)).settingsUpdated, false, "the same file again changes nothing");

  // the example settings
  const ex = await new Device().ready();
  assert.equal((await ex.store.backup.import(untimed)).settingsUpdated, true);
  assert.deepEqual(ex.snap.settings, want);

  // the device-only defaults left by «Удалить пример»
  const cleared = await new Device().ready();
  await cleared.store.deleteMany(cleared.snap.tx.map(t => t.id));
  await cleared.store.saveSettings(DEFAULT_SETTINGS);
  assert.equal(cleared.kv().settings.localOnly, true);
  assert.equal((await cleared.store.backup.import(untimed)).settingsUpdated, true);
  assert.deepEqual(cleared.snap.settings, want);

  // a value the user set on this device wins; fields still at their defaults are filled from the file
  const own = await new Device({ seed: null }).ready();
  await own.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 5000 });
  assert.equal((await own.store.backup.import(untimed)).settingsUpdated, true);
  assert.deepEqual(own.snap.settings, { ...want, startBalance: 5000 });
  own.tick(1000);
  await own.store.saveSettings({ ...want, startBalance: 5000, goals: [] });   // the user removes the goal
  assert.equal((await own.store.backup.import(untimed)).settingsUpdated, false, "a removed goal is the user's value too");
  assert.deepEqual(own.snap.settings.goals, []);
  // an untimed file holding only defaults changes nothing; example fields in it are never imported
  const plain = await new Device({ seed: null }).ready();
  await plain.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 10 });
  assert.equal((await plain.store.backup.import({ ...untimed, settings: DEFAULT_SETTINGS })).settingsUpdated, false);
  assert.equal((await plain.store.backup.import({ ...untimed, settings: { startBalance: 1, goals: [GOAL_IMPORT], limits: {}, example: { goals: true } } })).settingsUpdated, false);
  assert.deepEqual(plain.snap.settings, { ...DEFAULT_SETTINGS, startBalance: 10 });

  // after a sign-in the account's own values win; its unset fields take the file's
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server, seed: null }).ready();
  await a.signIn("anna@example.com");
  await a.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 100 });
  await a.store.sync.syncNow();
  const b = await new Device({ server, seed: null, clock: T0 + 60_000 }).ready();
  await b.store.backup.import(untimed);
  await b.signIn("anna@example.com");
  await a.store.sync.syncNow();
  for (const d of [a, b]) assert.deepEqual(d.snap.settings, { ...want, startBalance: 100 });
  assert.equal(a.sync.pending + b.sync.pending, 0);
});

/* ── regressions from the sync / security review ─────────────────────── */

// mirror of app.js saveSettings(patch): the UI spreads the whole snapshot settings back into the store
function uiSaveSettings(d, patch) {
  const raw = d.snap.settings ? JSON.parse(JSON.stringify(d.snap.settings)) : {};
  const next = { ...DEFAULT_SETTINGS, ...raw, ...patch };
  if (next.example && typeof next.example === "object") {
    for (const k of Object.keys(patch)) delete next.example[k];
    if (!Object.keys(next.example).length) delete next.example;
  }
  return d.store.saveSettings(next);
}
// mirror of app.js clearExamples() («Удалить пример»)
async function uiClearExamples(d) {
  await d.store.deleteMany(d.snap.tx.filter(t => t.example === true).map(t => t.id));
  const st = d.snap.settings && d.snap.settings.example;
  if (st && typeof st === "object" && Object.keys(st).length) {
    const patch = {};
    for (const k of Object.keys(st)) if (k in DEFAULT_SETTINGS) patch[k] = DEFAULT_SETTINGS[k];
    const raw = JSON.parse(JSON.stringify(d.snap.settings));
    delete raw.example;
    await d.store.saveSettings({ ...DEFAULT_SETTINGS, ...raw, ...patch });
  }
}
test("#0 a second device used before its first sign-in keeps the account's goal and limits", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const phone = await new Device({ server, clock: T0 }).ready();
  await phone.signIn("anna@example.com");
  await uiClearExamples(phone);
  phone.tick();
  await uiSaveSettings(phone, { startBalance: 10000 });
  await uiSaveSettings(phone, { goals: [GOAL] });
  await uiSaveSettings(phone, { limits: { groceries: 20000, cafe: 5000 } });
  await uiSaveSettings(phone, { categories: [CAT] });
  await phone.store.sync.syncNow();

  // iPad, an hour later: «Удалить пример», enters the start balance the toast asks for, then signs in
  const ipad = await new Device({ server, clock: T0 + 3600_000 }).ready();
  await uiClearExamples(ipad);
  await uiSaveSettings(ipad, { startBalance: 12000 });
  await ipad.signIn("anna@example.com");
  await phone.store.sync.syncNow();

  const expected = { startBalance: 12000, goals: [GOAL], limits: { groceries: 20000, cafe: 5000 }, categories: [CAT] };
  assert.deepEqual(without(server.rows("budget_settings")[0].data, "_ms"), expected, "the iPad's newer start balance plus the account's goals, limits and categories");
  assert.deepEqual(ipad.snap.settings, expected);
  assert.deepEqual(phone.snap.settings, expected);
  assert.equal(ipad.sync.pending, 0);
  assert.equal(phone.sync.pending, 0);
});

test("#0 settings stamps never come from the UI and never reach it", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  await a.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 5, goals: [GOAL] });
  await a.store.sync.syncNow();
  assert.equal("_ms" in a.snap.settings, false);
  assert.equal("_ms" in a.store.backup.export().settings, false);
  const b = await new Device({ server }).ready();
  await b.signIn("anna@example.com");
  assert.equal("_ms" in b.snap.settings, false, "a pulled row's _ms stays inside the store");

  // the UI hands back whatever it got, plus a forged _ms: the store recomputes the stamps itself
  a.tick(60_000);
  await a.store.saveSettings({ ...a.snap.settings, limits: { cafe: 100 }, _ms: { startBalance: 9e12, goals: 9e12, limits: 0, categories: 9e12, at: 9e12 }, goal: GOAL_V1 });
  const kv = a.kv().settings;
  assert.equal("_ms" in kv.data, false);
  assert.equal("goal" in kv.data, false, "a v1 goal handed in next to goals is not kept");
  assert.equal(kv.fieldMs.limits, a.t);
  assert.ok(kv.fieldMs.startBalance < a.t && kv.fieldMs.goals < a.t && kv.fieldMs.categories < a.t, "unchanged fields keep their old stamps");
  assert.deepEqual(a.snap.settings.goals, [GOAL]);
  assertV2(a.snap.settings);
});

test("#7 offline edits of different settings fields on two devices both survive", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  await a.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 1000 });
  await a.store.sync.syncNow();
  const b = await new Device({ server }).ready();
  await b.signIn("anna@example.com");
  assert.deepEqual(b.snap.settings, { ...DEFAULT_SETTINGS, startBalance: 1000 });
  a.win.setOnline(false); b.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { goals: [GOAL2] });
  b.tick(120_000); await uiSaveSettings(b, { limits: { cafe: 3000 } });
  a.win.setOnline(true); b.win.setOnline(true);
  await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  const both = { startBalance: 1000, goals: [GOAL2], limits: { cafe: 3000 }, categories: [] };
  assert.deepEqual(without(server.rows("budget_settings")[0].data, "_ms"), both);
  assert.deepEqual(a.snap.settings, both);
  assert.deepEqual(b.snap.settings, both);
  assert.equal(a.sync.pending + b.sync.pending, 0);

  // the same field on both: the later edit wins
  a.tick(60_000); await uiSaveSettings(a, { startBalance: 1 });
  b.tick(60_000); await uiSaveSettings(b, { startBalance: 2 });
  await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  assert.equal(a.snap.settings.startBalance, 2);
  assert.equal(b.snap.settings.startBalance, 2);
});

test("#7 rows without trustworthy field stamps (older app versions) count as changed as a whole", async () => {
  const server = createFakeSupabase();
  const u = server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  await a.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 1000 });
  await a.store.sync.syncNow();
  const stale = server.rows("budget_settings")[0].data._ms;

  // a newer version's row that changed only the start balance: a's pending limits survive
  a.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { limits: { cafe: 3000 } });
  const t1 = a.t + 60_000;
  server.put("budget_settings", { user_id: u.id, data: { ...DEFAULT_SETTINGS, startBalance: 2000, _ms: { ...stale, startBalance: t1, at: t1 } }, client_updated_ms: t1 });
  a.win.setOnline(true);
  a.tick(120_000); await a.store.sync.syncNow();
  assert.deepEqual(a.snap.settings, { ...DEFAULT_SETTINGS, startBalance: 2000, limits: { cafe: 3000 } });

  // an old (v1) version rewrote the document and carried the stale _ms along (at ≠ client_updated_ms): its whole
  // row is newer; the categories it does not know (not in its document) are not touched
  a.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { goals: [GOAL], categories: [CAT] });
  const t2 = a.t + 60_000;
  server.put("budget_settings", { user_id: u.id, data: { startBalance: 3000, goal: null, limits: {}, _ms: stale }, client_updated_ms: t2 });
  a.win.setOnline(true);
  a.tick(120_000); await a.store.sync.syncNow();
  assert.deepEqual(a.snap.settings, { startBalance: 3000, goals: [], limits: {}, categories: [CAT] });

  // a row without _ms at all, older than a's next edit: only fields changed later locally win
  a.tick(60_000); await uiSaveSettings(a, { goals: [GOAL] });
  server.put("budget_settings", { user_id: u.id, data: { startBalance: 4000, goal: null, limits: { cafe: 1 } }, client_updated_ms: a.t - 30_000 });
  a.tick(1000); await a.store.sync.syncNow();
  assert.deepEqual(a.snap.settings, { startBalance: 4000, goals: [GOAL], limits: { cafe: 1 }, categories: [CAT] });
  assert.equal("goal" in server.rows("budget_settings")[0].data, false, "the v1 key is not written back");
  assert.equal(a.sync.pending, 0);
  assert.deepEqual(without(server.rows("budget_settings")[0].data, "_ms"), a.snap.settings);
});

test("#3 a backup import on a freshly signed-in device does not bring back operations deleted in the account", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server }).ready();
  await a.signIn("anna@example.com");
  const gone = await a.store.saveTx(null, tx({ note: "deleted after the backup", amount: 5000 }));
  await a.store.sync.syncNow();
  const file = JSON.parse(JSON.stringify(a.store.backup.export()));
  a.tick(60_000); await a.store.deleteTx(gone);
  server.backdateNextMs = 10 * 60_000;                       // the deletion is older than the pull overlap
  await a.store.sync.syncNow();
  a.tick(60_000); await a.store.saveTx(null, tx({ note: "later operation" }));
  await a.store.sync.syncNow();

  const b = await new Device({ server, clock: T0 + 3600_000 }).ready();
  await b.signIn("anna@example.com");
  assert.equal(b.find(gone), undefined);
  assert.equal(b.kv().tx[gone].deleted, true, "the account's tombstone is kept on the new device");
  const res = await b.store.backup.import(file);
  assert.equal(res.added, 0);
  for (let i = 0; i < 2; i++) { b.tick(60_000); await b.store.sync.syncNow(); }
  assert.equal(b.find(gone), undefined);
  assert.equal(b.sync.pending, 0);
  assert.equal(server.rows("transactions").find(r => r.id === gone).deleted, true);
});

test("#8 the same example edited into a real record on two devices gives two records", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const phone = await new Device({ server, clock: Date.UTC(2026, 8, 20, 9) }).ready();
  const ipad = await new Device({ server, clock: Date.UTC(2026, 9, 8, 9) }).ready();
  const pEx = phone.find("ex01"), iEx = ipad.find("ex01");
  phone.tick();
  const pId = await phone.store.saveTx("ex01", { ...without(pEx, "id", "example", "updatedAt"), amount: 38000, note: "Аренда август" });
  await phone.signIn("anna@example.com");
  ipad.tick();
  const iId = await ipad.store.saveTx("ex01", { ...without(iEx, "id", "example", "updatedAt"), amount: 38000, note: "Аренда сентябрь" });
  await ipad.signIn("anna@example.com");
  await phone.store.sync.syncNow();
  assert.notEqual(pId, "ex01");
  assert.notEqual(iId, "ex01");
  assert.notEqual(pId, iId);
  const real = server.rows("transactions").filter(r => !r.deleted && !r.example);
  assert.deepEqual(real.map(r => r.note).sort(), ["Аренда август", "Аренда сентябрь"]);
  assert.ok(!server.rows("transactions").some(r => r.id === "ex01"));
  const own = d => d.snap.tx.filter(t => !t.example).map(t => t.note).sort();
  assert.deepEqual(own(phone), ["Аренда август", "Аренда сентябрь"]);
  assert.deepEqual(own(ipad), ["Аренда август", "Аренда сентябрь"]);
});

test("#9 restoring a backup made while the example was shown does not upload the example", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const phone = await new Device({ server }).ready();
  const mine = await phone.store.saveTx(null, tx({ note: "моя операция" }));
  const file = JSON.parse(JSON.stringify(phone.store.backup.export()));
  assert.deepEqual(file.tx.filter(t => t.example).map(t => t.id), ["ex01", "ex02", "ex03"]);
  assert.deepEqual(file.settings.example, { startBalance: true, goals: true, limits: true, categories: true });
  await phone.store.deleteMany(phone.snap.tx.filter(t => t.example).map(t => t.id));
  await phone.signIn("anna@example.com");
  const ipad = await new Device({ server }).ready();
  await ipad.signIn("anna@example.com");
  const res = await ipad.store.backup.import(file);
  assert.equal(res.skipped, 4, "three example records skipped, the own one already there");
  assert.equal(res.settingsUpdated, false, "example settings are not imported either");
  await ipad.store.sync.syncNow();
  await phone.store.sync.syncNow();
  assert.deepEqual(server.rows("transactions").filter(r => r.example).map(r => r.id), []);
  assert.equal(server.rows("budget_settings").length, 0);
  assert.deepEqual(phone.ids(), [mine]);
  assert.deepEqual(ipad.ids(), [mine]);
});

test("#10 a launch on the localStorage fallback does not bring the removed example back into IndexedDB", async () => {
  const idb = createFakeIndexedDB();
  const ls = new FakeStorage();
  const win = createWindow({ idb, localStorage: ls, seed: fakeSeed });
  const d = await new Device({ win, delays: { ...SLOW, idbTimeout: 50 } }).ready();
  await uiClearExamples(d);
  await uiSaveSettings(d, { goals: [GOAL] });
  const mine = await d.store.saveTx(null, tx({ note: "моя" }));
  idb.ctl.hangOpen = true;                                    // IndexedDB open hangs on the next launch (old Safari)
  await d.restart();
  assert.ok(d.snap.notice);
  assert.deepEqual(d.ids(), ["ex01", "ex02", "ex03"], "the fallback launch starts from an empty localStorage");
  d.tick(60_000);
  await uiSaveSettings(d, { startBalance: 777 });            // one field changed during the fallback launch
  const extra = await d.store.saveTx(null, tx({ note: "во время сбоя" }));
  idb.ctl.hangOpen = false;
  await d.restart();
  assert.equal(d.snap.notice, undefined);
  assert.deepEqual(d.ids(), [mine, extra].sort(), "own records move over, the example does not");
  assert.deepEqual(d.snap.settings, { ...DEFAULT_SETTINGS, startBalance: 777, goals: [GOAL] }, "example settings never replace real ones");
  assert.equal(ls.getItem("budget-pwa-data"), null);
});

test("#2 an e-mail link opened where sync is not configured waits for the project, then works", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const bob = server.addUser("bob@example.com");
  const link = server.recoveryLink("anna@example.com");
  const d = await new Device({ server, config: "none", href: "https://app.example/budget/" + link }).ready();
  await sleep(10);
  assert.equal(d.sync.configured, false);
  assert.equal(d.sync.pendingLink, "recovery");
  assert.equal(d.win.location.hash, link, "the link stays in the URL until the project is known");
  assert.equal(d.server.clients.length, 0);
  await d.store.sync.configure({ url: server.url, anonKey: server.anonKey });
  assert.equal(d.sync.pendingLink, null);
  assert.equal(d.win.location.hash, "");
  assert.equal(d.sync.recovery, true);
  assert.deepEqual(d.sync.link, { type: "recovery", email: "anna@example.com" });
  assert.equal(d.sync.user, null);
  await d.store.sync.updatePassword("brand-new-pass");
  assert.equal(d.sync.recovery, false);
  assert.equal(d.sync.user, null);
  await d.store.sync.signIn("anna@example.com", "brand-new-pass");
  assert.equal(d.sync.user.email, "anna@example.com");

  // a sign-up confirmation link: the address is confirmed, the user signs in with the password
  const s = server.issue(bob.id);
  const e = await new Device({ server, config: "none", href: `https://app.example/budget/#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer&type=signup` }).ready();
  await sleep(10);
  assert.equal(e.sync.pendingLink, "link");
  await e.store.sync.configure({ url: server.url, anonKey: server.anonKey });
  assert.deepEqual(e.sync.link, { type: "confirmed", email: "bob@example.com" });
  assert.equal(e.sync.user, null);
  assert.equal(server.tokens.has(s.access_token), false, "the confirmation link's session was ended");
  await e.signIn("bob@example.com");
  assert.equal(e.sync.link, null);

  // a failed link is explained without any project config
  const f = await new Device({ server, config: "none", href: "https://app.example/budget/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired" }).ready();
  await sleep(10);
  assert.equal(f.sync.pendingLink, null);
  assert.equal(f.sync.error, "Ссылка из письма устарела или уже использована. Запросите новое письмо.");

  // no network while the link is checked: it stays in the URL and works after a reload
  const link2 = server.recoveryLink("anna@example.com");
  const gw = createWindow({ server, seed: fakeSeed, config: { supabaseUrl: server.url, supabaseAnonKey: server.anonKey }, href: "https://app.example/budget/" + link2 });
  gw.netDown = true;
  const g = await new Device({ server, win: gw }).ready();
  await waitFor(() => g.sync.error, { what: "network error" });
  assert.match(g.sync.error, /Нет соединения/);
  assert.equal(g.win.location.hash, link2);
  assert.equal(g.sync.recovery, false);
  g.win.netDown = false;
  await g.restart();
  await waitFor(() => g.sync.recovery, { what: "recovery after reload" });
  assert.equal(g.win.location.hash, "");
  assert.equal(g.sync.error, null);
});

test("#4 a link with another account's session never signs the app into it", async () => {
  const server = createFakeSupabase();
  const victim = server.addUser("victim@example.com");
  const attacker = server.addUser("attacker@example.com");
  const crafted = () => {
    const s = server.issue(attacker.id);
    return { token: s.access_token, href: `https://app.example/budget/#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer` };
  };

  // a device that was never signed in, holding a private record
  const d = await new Device({ server }).ready();
  const mine = await d.store.saveTx(null, tx({ note: "PRIVATE salary note", amount: 250000 }));
  const l1 = crafted();
  d.win.navigate(l1.href);
  await d.restart();
  await waitFor(() => d.sync.link, { what: "link handled" });
  await sleep(20);
  assert.deepEqual(d.sync.link, { type: "confirmed", email: "attacker@example.com" });
  assert.equal(d.sync.user, null);
  assert.equal(d.sync.recovery, false);
  assert.equal(d.win.location.hash, "");
  assert.equal(server.log.filter(l => l.op === "upsert").length, 0, "nothing uploaded");
  assert.equal(server.rows("transactions", attacker.id).length, 0);
  assert.ok(d.find(mine));
  assert.equal(d.sync.pending, 1);
  assert.equal(d.kv().meta.userId, null);
  assert.equal(d.win.localStorage.getItem("budget-pwa-auth"), null);
  assert.equal(server.tokens.has(l1.token), false, "the link's session was ended");

  // a device signed in as the victim, with a change that is not synced yet
  const v = await new Device({ server }).ready();
  await v.signIn("victim@example.com");
  const pending = await v.store.saveTx(null, tx({ note: "VICTIM unsynced entry" }));
  v.win.navigate(crafted().href);
  await v.restart();
  await waitFor(() => v.sync.link && v.sync.user, { what: "link handled while signed in" });
  assert.equal(v.sync.user.email, "victim@example.com");
  assert.ok(v.find(pending));
  assert.equal(v.kv().meta.userId, victim.id);
  await v.store.sync.syncNow();
  assert.ok(server.rows("transactions", victim.id).some(r => r.id === pending));
  assert.equal(server.rows("transactions", attacker.id).length, 0);

  // a recovery link of another account on a signed-in device: the password changes, the device keeps its account
  v.win.navigate("https://app.example/budget/" + server.recoveryLink("attacker@example.com"));
  await v.restart();
  await waitFor(() => v.sync.recovery && v.sync.user, { what: "recovery link handled" });
  assert.equal(v.sync.user.email, "victim@example.com");
  assert.deepEqual(v.sync.link, { type: "recovery", email: "attacker@example.com" });
  await v.store.sync.updatePassword("attacker-new-pass");
  assert.equal(v.sync.recovery, false);
  assert.equal(v.sync.user.email, "victim@example.com");
  assert.equal(server.users.get("attacker@example.com").password, "attacker-new-pass");
  assert.equal(server.users.get("victim@example.com").password, PW);
});

test("#5 an offline relaunch with an expired access token stays signed in, offline", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const d = await new Device({ server }).ready();
  await d.signIn("anna@example.com");
  const id = await d.store.saveTx(null, tx());
  const expire = () => {
    const s = JSON.parse(d.win.localStorage.getItem("budget-pwa-auth"));
    s.expires_at = Math.floor(Date.now() / 1000) - 120;     // the app was closed for over an hour
    d.win.localStorage.setItem("budget-pwa-auth", JSON.stringify(s));
  };
  expire();
  d.win.navigator.onLine = false;
  server.refreshRetryMs = 400;                               // supabase-js keeps retrying the refresh before it answers
  const t0 = Date.now();
  await d.restart();
  await waitFor(() => d.sync.user && d.sync.phase === "offline", { what: "offline, still signed in" });
  assert.ok(Date.now() - t0 < 300, "shown without waiting for getSession()");
  await sleep(450);
  server.refreshRetryMs = 0;
  assert.equal(d.sync.user && d.sync.phase, "offline", "still signed in once getSession() gave up");
  assert.equal(d.sync.user.email, "anna@example.com");
  assert.equal(d.sync.error, null, "no «Сессия завершена»");
  assert.equal(d.sync.pending, 1);
  assert.ok(d.win.localStorage.getItem("budget-pwa-auth"), "the session is still stored");
  d.win.setOnline(true);
  await waitFor(() => d.sync.phase === "idle" && d.sync.pending === 0, { what: "sync once online" });
  assert.ok(server.rows("transactions").some(r => r.id === id));

  // online with an expired token: refreshed as usual
  expire();
  await d.restart();
  await waitFor(() => d.sync.user && d.sync.phase === "idle", { what: "refreshed online" });
  assert.equal(d.sync.error, null);

  // a stored session of another account than this device's is not used offline
  const other = await new Device({ server }).ready();
  other.win.localStorage.setItem("budget-pwa-auth", d.win.localStorage.getItem("budget-pwa-auth"));
  other.win.localStorage.setItem("budget-pwa-auth", JSON.stringify({ ...JSON.parse(other.win.localStorage.getItem("budget-pwa-auth")), expires_at: 1 }));
  other.win.navigator.onLine = false;
  await other.restart();
  await sleep(20);
  assert.equal(other.sync.user, null);
});

/* ── v2 (Money honey): goalId, several goals, custom categories, v1 migration ── */

const saving = (over = {}) => tx({ type: "saving", category: "savings", amount: 500, ...over });

test("v2 goalId: a saving's goal travels between two devices; other types and invalid ids drop it", async () => {
  const server = createFakeSupabase();
  const u = server.addUser("anna@example.com");
  const a = await new Device({ server, seed: null }).ready();
  const b = await new Device({ server, seed: null }).ready();
  await a.signIn("anna@example.com");
  await b.signIn("anna@example.com");
  const s1 = await a.store.saveTx(null, saving({ goalId: "g_car" }));
  const s2 = await a.store.saveTx(null, saving());                                // no goal: the first goal (UI rule)
  const dropped = await Promise.all([
    a.store.saveTx(null, tx({ goalId: "g_car" })),                                  // expense
    a.store.saveTx(null, tx({ type: "income", category: "salary", goalId: "g_car" })),
    a.store.saveTx(null, saving({ goalId: "g car!" })),
    a.store.saveTx(null, saving({ goalId: "g".repeat(33) })),
    a.store.saveTx(null, saving({ goalId: "" })),
    a.store.saveTx(null, saving({ goalId: 7 })),
  ]);
  assert.equal(a.find(s1).goalId, "g_car");
  assert.equal(a.kv().tx[s1].goalId, "g_car");
  for (const id of [s2, ...dropped]) assert.equal("goalId" in a.find(id), false, id);
  await a.store.sync.syncNow();
  const row = id => server.rows("transactions").find(r => r.id === id);
  assert.equal(row(s1).goal_id, "g_car");
  for (const id of [s2, ...dropped]) assert.equal(row(id).goal_id, null, id);

  await b.store.sync.syncNow();
  assert.deepEqual(b.find(s1), a.find(s1));
  assert.equal("goalId" in b.find(s2), false);

  // moved to another goal on b, then back to "the first goal" on a: null clears the column on the server
  b.tick(1000); await b.store.saveTx(s1, { ...without(b.find(s1), "id", "updatedAt"), goalId: "g_trip" });
  await b.store.sync.syncNow(); await a.store.sync.syncNow();
  assert.equal(a.find(s1).goalId, "g_trip");
  a.tick(2000); await a.store.saveTx(s1, without(a.find(s1), "id", "updatedAt", "goalId"));
  await a.store.sync.syncNow(); await b.store.sync.syncNow();
  assert.equal(row(s1).goal_id, null);
  assert.equal("goalId" in b.find(s1), false);
  // a saving with a goal turned into an expense loses the goal
  b.tick(1000); await b.store.saveTx(s2, { ...without(b.find(s2), "id", "updatedAt"), goalId: "g_trip" });
  b.tick(1000); await b.store.saveTx(s2, { ...without(b.find(s2), "id", "updatedAt"), type: "expense", category: "cafe" });
  await b.store.sync.syncNow(); await a.store.sync.syncNow();
  assert.deepEqual([row(s2).goal_id, "goalId" in a.find(s2)], [null, false]);
  // deleting a saving with a goal: the tombstone travels as usual
  b.tick(1000); const s3 = await b.store.saveTx(null, saving({ goalId: "g_trip" }));
  await b.store.sync.syncNow(); await a.store.sync.syncNow();
  a.tick(1000); await a.store.deleteTx(s3);
  await a.store.sync.syncNow(); await b.store.sync.syncNow();
  assert.equal(b.find(s3), undefined);
  assert.equal(row(s3).deleted, true);

  // rows other clients wrote: a goal_id on a non-saving row or with a bad id is not taken
  server.put("transactions", { user_id: u.id, id: "w1", type: "income", amount: 5, date: "2026-10-01", goal_id: "g_car", client_updated_ms: 1 });
  server.put("transactions", { user_id: u.id, id: "w2", type: "saving", amount: 5, date: "2026-10-01", goal_id: "x y", client_updated_ms: 1 });
  server.put("transactions", { user_id: u.id, id: "w3", type: "saving", amount: 5, date: "2026-10-01", goal_id: "g_ok", client_updated_ms: 1 });
  await b.store.sync.syncNow();
  assert.deepEqual(["w1", "w2", "w3"].map(id => b.find(id).goalId), [undefined, undefined, "g_ok"]);
  assert.equal(b.sync.pending, 0);
});

test("v2 goalId: backup export and import keep it; a bad goalId in a file is dropped, not refused", async () => {
  const d = await new Device({ seed: null }).ready();
  const id = await d.store.saveTx(null, saving({ goalId: "g_car" }));
  const out = d.store.backup.export();
  assert.equal(out.version, 2);
  assert.equal(out.tx.find(t => t.id === id).goalId, "g_car");
  const fresh = await new Device({ seed: null }).ready();
  assert.equal((await fresh.store.backup.import(JSON.parse(JSON.stringify(out)))).added, 1);
  assert.equal(fresh.find(id).goalId, "g_car");
  const base = { amount: 5, note: "", date: "2026-10-01", createdAt: 0 };
  const res = await fresh.store.backup.import({ app: "budget", version: 2, exportedAt: "", settings: null, tx: [
    { ...base, id: "f1", type: "saving", category: "savings", goalId: "bad id" },
    { ...base, id: "f2", type: "expense", category: "cafe", goalId: "g_car" },
    { ...base, id: "f3", type: "saving", category: "savings", goalId: { id: "g_car" } },
  ] });
  assert.equal(res.added, 3);
  for (const f of ["f1", "f2", "f3"]) assert.equal("goalId" in fresh.find(f), false, f);
  // a v1 file has no goalId at all: its savings belong to the first goal
  const v1 = await fresh.store.backup.import({ app: "budget", version: 1, exportedAt: "", settings: null, tx: [{ ...base, id: "f4", type: "saving", category: "savings" }] });
  assert.equal(v1.added, 1);
  assert.equal("goalId" in fresh.find("f4"), false);
});

test("v2 goalId: a project still on the old schema.sql (no goal_id column) asks to run it again", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  server.noGoalIdColumn = true;
  const a = await new Device({ server, seed: null }).ready();
  await a.signIn("anna@example.com");
  await a.store.saveTx(null, saving({ goalId: "g_car" }));
  await rejects(a.store.sync.syncNow(), "invalid", /устарела.*schema\.sql/);
  assert.equal(a.sync.phase, "error");
  assert.match(a.sync.error, /ещё раз/);
  assert.equal(a.sync.pending, 1, "kept on the device");
  server.noGoalIdColumn = false;                                  // the user re-ran schema.sql
  await a.store.sync.syncNow();
  assert.deepEqual([a.sync.phase, a.sync.pending, a.sync.error], ["idle", 0, null]);
});

test("v2 settings: a v1 record on the device migrates (goal → goals with the goal's stamp); v1 keys never reach the UI or storage again", async () => {
  const d = await new Device({ seed: null }).ready();
  const poke = rec => d.win.idb.poke("budget-pwa", "kv", "settings", rec);
  poke({ data: { startBalance: 5000, goal: GOAL_V1, limits: { cafe: 300 } }, fieldMs: { startBalance: 100, goal: 200, limits: 300 }, updatedMs: 300, dirty: true, localOnly: false });
  await d.restart();
  assert.deepEqual(d.snap.settings, { startBalance: 5000, goals: [GOAL_V1_AS_V2], limits: { cafe: 300 }, categories: [] });
  assertV2(d.snap.settings);
  const out = d.store.backup.export();
  assertV2(out.settings);
  assert.deepEqual(out.settingsFieldsUpdatedAt, { startBalance: 100, goals: 200, limits: 300, categories: 0 }, "goal's stamp → goals; the record held no categories");
  assert.equal(d.sync.pending, 1);
  // the next write stores v2 only; the fields it did not change keep their stamps
  d.tick(); await uiSaveSettings(d, { limits: { cafe: 400 } });
  let kv = d.kv().settings;
  assert.deepEqual(Object.keys(kv.data).sort(), ["categories", "goals", "limits", "startBalance"]);
  assert.deepEqual(kv.fieldMs, { startBalance: 100, goals: 200, limits: d.t, categories: 0 });

  // a v1 record from before field stamps: every field it holds counts as changed at updatedMs, categories at 0
  poke({ data: { startBalance: 1, goal: null, limits: {} }, updatedMs: 777, dirty: false, localOnly: false });
  await d.restart();
  assert.deepEqual(d.snap.settings, { ...DEFAULT_SETTINGS, startBalance: 1 });
  assert.deepEqual(d.store.backup.export().settingsFieldsUpdatedAt, { startBalance: 777, goals: 777, limits: 777, categories: 0 });

  // the v1 example (device-only, example.goal): flagged as goals; «Удалить пример» resets it with stamp 0
  poke({ data: { startBalance: 5240, goal: GOAL_V1, limits: { cafe: 800 }, example: { startBalance: true, goal: true, limits: true } }, fieldMs: { startBalance: 0, goal: 0, limits: 0 }, updatedMs: 0, dirty: false, localOnly: true });
  await d.restart();
  assert.deepEqual(d.snap.settings, { startBalance: 5240, goals: [GOAL_V1_AS_V2], limits: { cafe: 800 }, categories: [], example: { startBalance: true, goals: true, limits: true } });
  assertV2(d.snap.settings);
  await uiClearExamples(d);
  assert.deepEqual(d.snap.settings, DEFAULT_SETTINGS);
  kv = d.kv().settings;
  assert.deepEqual([kv.localOnly, kv.dirty], [true, false], "still device-only");
  assert.deepEqual(kv.fieldMs, { startBalance: 0, goals: 0, limits: 0, categories: 0 });
  assert.equal(d.sync.pending, 0);

  // an older src/seed.js (v1 settings) seeds a v2 example
  const e = await new Device({ seed: legacySeed }).ready();
  assert.deepEqual(e.snap.settings.example, { startBalance: true, goals: true, limits: true });
  assert.deepEqual(e.snap.settings.goals, [{ id: "g_main", name: "Отпуск", target: 25000, deadline: "2027-05-01", initial: 9600, icon: "Target", createdAt: 0 }]);
  assertV2(e.snap.settings);
});

test("v2 settings: a v1 server row migrates and merges per field with a v2 device's goals edits; v2 never writes goal", async () => {
  const server = createFakeSupabase();
  const u = server.addUser("anna@example.com");
  const T1 = T0 - 3 * 3600_000;
  server.put("budget_settings", { user_id: u.id, client_updated_ms: T1,
    data: { startBalance: 1000, goal: GOAL_V1, limits: { cafe: 300 }, _ms: { startBalance: T1 - 2000, goal: T1 - 1000, limits: T1, at: T1 } } });
  const a = await new Device({ server, seed: null }).ready();
  await a.signIn("anna@example.com");
  assert.deepEqual(a.snap.settings, { startBalance: 1000, goals: [GOAL_V1_AS_V2], limits: { cafe: 300 }, categories: [] });
  assertV2(a.snap.settings);
  assert.deepEqual(a.kv().settings.fieldMs, { startBalance: T1 - 2000, goals: T1 - 1000, limits: T1, categories: 0 },
    "the v1 _ms.goal stamps goals; the row holds no categories");
  assert.equal(a.sync.pending, 0, "a v1 row is read as is, not rewritten");

  // offline on a: a second goal and a category; meanwhile a v1 device changes the start balance (later than a's edits)
  a.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { goals: [...a.snap.settings.goals, GOAL2] });
  a.tick(1000); await uiSaveSettings(a, { categories: [CAT] });
  const T4 = a.t + 60_000;
  server.put("budget_settings", { user_id: u.id, client_updated_ms: T4,
    data: { startBalance: 2000, goal: GOAL_V1, limits: { cafe: 300 }, _ms: { startBalance: T4, goal: T1 - 1000, limits: T1, at: T4 } } });
  a.win.setOnline(true);
  a.tick(120_000); await a.store.sync.syncNow();
  const want = { startBalance: 2000, goals: [GOAL_V1_AS_V2, GOAL2], limits: { cafe: 300 }, categories: [CAT] };
  assert.deepEqual(a.snap.settings, want);
  let row = server.rows("budget_settings")[0];
  assert.deepEqual(without(row.data, "_ms"), want, "the union is pushed as v2, without the v1 goal");
  assert.deepEqual(Object.keys(row.data._ms).sort(), ["at", "categories", "goals", "items", "limits", "startBalance"]);
  assert.equal(a.sync.pending, 0);

  const b = await new Device({ server, seed: null }).ready();
  await b.signIn("anna@example.com");
  assert.deepEqual(b.snap.settings, want);

  // a v1 device saves the start balance afterwards: it carries goals and categories along unchanged and writes
  // goal: null next to them (it sees no goal of its own); the v2 goals stay
  const T5 = T4 + 3600_000;
  row = server.rows("budget_settings")[0];
  server.put("budget_settings", { user_id: u.id, client_updated_ms: T5,
    data: { ...without(row.data, "_ms"), startBalance: 3000, goal: null, _ms: { startBalance: T5, goal: row.data._ms.goals, limits: row.data._ms.limits, at: T5 } } });
  b.t = T5 + 1000; await b.store.sync.syncNow();
  a.t = T5 + 1000; await a.store.sync.syncNow();
  for (const d of [a, b]) { assert.deepEqual(d.snap.settings, { ...want, startBalance: 3000 }); assertV2(d.snap.settings); }
  assert.equal(a.sync.pending + b.sync.pending, 0);
});

test("v2 settings: goals and custom categories merge per field; offline edits on two devices both survive", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server, seed: null }).ready();
  await a.signIn("anna@example.com");
  await a.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 100, goals: [GOAL], categories: [CAT] });
  await a.store.sync.syncNow();
  const b = await new Device({ server, seed: null }).ready();
  await b.signIn("anna@example.com");

  // different fields: categories on a, goals on b
  a.win.setOnline(false); b.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { categories: [CAT, CAT2] });
  b.tick(120_000); await uiSaveSettings(b, { goals: [GOAL, GOAL2] });
  a.win.setOnline(true); b.win.setOnline(true);
  await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  const both = { startBalance: 100, goals: [GOAL, GOAL2], limits: {}, categories: [CAT, CAT2] };
  for (const d of [a, b]) assert.deepEqual(d.snap.settings, both);
  assert.deepEqual(without(server.rows("budget_settings")[0].data, "_ms"), both);

  // the same category on both: the later edit of it wins (archiving on a, renaming on b later)
  a.tick(60_000); await uiSaveSettings(a, { categories: [{ ...CAT, archived: true }, CAT2] });
  b.tick(120_000); await uiSaveSettings(b, { categories: [{ ...CAT, name: "Рынок" }, CAT2], limits: { [CAT.id]: 400 } });
  await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  const later = { ...both, categories: [{ ...CAT, name: "Рынок" }, CAT2], limits: { [CAT.id]: 400 } };
  for (const d of [a, b]) assert.deepEqual(d.snap.settings, later);
  // goal order is the display order: a reorder is a change of goals
  a.tick(60_000); await uiSaveSettings(a, { goals: [GOAL2, GOAL] });
  await a.store.sync.syncNow(); await b.store.sync.syncNow();
  assert.deepEqual(b.snap.settings.goals.map(g => g.id), [GOAL2.id, GOAL.id]);
  assert.equal(a.sync.pending + b.sync.pending, 0);
});

test("v2 settings: a v1 backup file migrates and merges per field; categories it does not hold are kept", async () => {
  const v1file = {
    app: "budget", version: 1, exportedAt: "2026-10-01T00:00:00Z",
    settings: { startBalance: 777, goal: GOAL_V1, limits: { cafe: 5 } },
    settingsUpdatedAt: 15_000, settingsFieldsUpdatedAt: { startBalance: 15_000, goal: 15_000, limits: 15_000 }, tx: [],
  };
  // goals edited on the device after the file: kept, and the file's goal (never deleted here) joins them, after the
  // device's own (goals merge entry by entry); start balance and limits older here: taken from the file
  const d = await new Device({ seed: null, clock: 10_000 }).ready();
  await d.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 50, categories: [CAT] });
  d.t = 20_000; await uiSaveSettings(d, { goals: [GOAL] });
  d.t = 100_000;
  assert.equal((await d.store.backup.import(v1file)).settingsUpdated, true);
  assert.deepEqual(d.snap.settings, { startBalance: 777, goals: [GOAL, GOAL_V1_AS_V2], limits: { cafe: 5 }, categories: [CAT] });
  assert.deepEqual(d.kv().settings.fieldMs, { startBalance: 15_000, goals: 20_000, limits: 15_000, categories: 10_000 });

  // goals older on the device: the file's goal arrives as goals = [g_main], with the file's goal stamp
  const e = await new Device({ seed: null, clock: 10_000 }).ready();
  await e.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL], categories: [CAT] });
  e.t = 100_000;
  await e.store.backup.import(v1file);
  assert.deepEqual(e.snap.settings, { startBalance: 777, goals: [GOAL_V1_AS_V2], limits: { cafe: 5 }, categories: [CAT] });
  assert.equal(e.kv().settings.fieldMs.goals, 15_000);
  assertV2(e.snap.settings);

  // a v1 file's example goal (example.goal) is not imported
  const f = await new Device({ seed: null }).ready();
  await f.store.backup.import({ ...v1file, settings: { ...v1file.settings, example: { goal: true } } });
  assert.deepEqual(f.snap.settings, { ...DEFAULT_SETTINGS, startBalance: 777, limits: { cafe: 5 } });

  // a hand-made v1 file without timestamps: its goal fills an empty goals list; the device's categories stay
  const g = await new Device({ seed: null }).ready();
  await g.store.saveSettings({ ...DEFAULT_SETTINGS, categories: [CAT] });
  await g.store.backup.import({ app: "budget", version: 1, exportedAt: "", settings: { startBalance: 0, goal: GOAL_V1, limits: {} }, tx: [] });
  assert.deepEqual(g.snap.settings, { ...DEFAULT_SETTINGS, goals: [GOAL_V1_AS_V2], categories: [CAT] });

  // and the other way round: a v2 export round-trips with its field stamps
  const out = JSON.parse(JSON.stringify(e.store.backup.export()));
  assert.deepEqual(out.settingsFieldsUpdatedAt, e.kv().settings.fieldMs);
  assert.equal("goal" in out.settings, false);
  const h = await new Device({ seed: null }).ready();
  await h.store.backup.import(out);
  assert.deepEqual(h.snap.settings, e.snap.settings);
  assert.deepEqual(h.kv().settings.fieldMs, e.kv().settings.fieldMs);
});

test("v2 settings: a v1 record left in the localStorage fallback migrates and merges per field into IndexedDB", async () => {
  const idb = createFakeIndexedDB();
  const ls = new FakeStorage();
  const d = await new Device({ win: createWindow({ idb, localStorage: ls, seed: null }) }).ready();
  await d.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 100, goals: [GOAL2], categories: [CAT] });   // all at T0
  // written during a launch on the fallback: goal and limits changed later than T0, the start balance earlier
  ls.setItem("budget-pwa-data", JSON.stringify({
    tx: {}, meta: { seeded: true },
    settings: { data: { startBalance: 9, goal: GOAL_V1, limits: { cafe: 7 } }, fieldMs: { startBalance: T0 - 5000, goal: T0 + 5000, limits: T0 + 6000 }, updatedMs: T0 + 6000, dirty: true, localOnly: false },
  }));
  d.t = T0 + 10_000;
  await d.restart();
  assert.equal(ls.getItem("budget-pwa-data"), null);
  assert.deepEqual(d.snap.settings, { startBalance: 100, goals: [GOAL_V1_AS_V2], limits: { cafe: 7 }, categories: [CAT] });
  const kv = d.kv().settings;
  assert.equal("goal" in kv.data, false);
  assert.deepEqual(kv.fieldMs, { startBalance: T0, goals: T0 + 5000, limits: T0 + 6000, categories: T0 });
  assert.equal(kv.dirty, true);
});

test("v2 settings: goals, categories and limits are checked entry by entry; whole-field errors reject", async () => {
  const d = await new Device({ seed: null }).ready();
  const goals = [
    GOAL,
    { ...GOAL, name: "same id again" },
    { ...GOAL2, id: "bad id" }, { ...GOAL2, id: "g".repeat(33) }, { ...GOAL2, id: 5 },
    { ...GOAL2, id: "g_t0", target: 0 }, { ...GOAL2, id: "g_t1", target: 1e10 }, { ...GOAL2, id: "g_t2", target: "5" },
    { ...GOAL2, id: "g_n0", name: "   " }, { ...GOAL2, id: "g_n1", name: null },
    { ...GOAL2, id: "g_d0", deadline: "2026-02-30" }, { ...GOAL2, id: "g_i0", initial: -1 },
    "g_x", null, [GOAL2],
    { id: "g_min", name: " Мин ", target: 10.5 },                                     // only what is required
    { ...GOAL2, id: "g_cut", name: "\u0000Б\n" + "б".repeat(70), icon: "<svg onload=x>", createdAt: -5, extra: 1 },
  ];
  const categories = [
    CAT, { ...CAT, name: "same id again" },
    { ...CAT2, id: "c_AB12" }, { ...CAT2, id: "c_ab" }, { ...CAT2, id: "c_" + "a".repeat(21) }, { ...CAT2, id: "x_tutor01" },
    { ...CAT2, type: "saving" }, { ...CAT2, name: " " }, { ...CAT2, name: 5 }, null,
    { id: "c_arch01", type: "income", name: "Пособие", icon: "HandCoins", archived: true },
    { id: "c_noicon1", type: "expense", name: "Ш".repeat(40), archived: "yes" },
  ];
  const limits = { cafe: 100.555, [CAT.id]: 50, "": 1, "bad key": 5, ["k".repeat(33)]: 5, zero: 0, tiny: 0.001, neg: -5, nan: NaN, str: "5", big: 1e10 };
  await d.store.saveSettings({ startBalance: 0, goals, categories, limits });
  assert.deepEqual(d.snap.settings.goals, [
    GOAL,
    { id: "g_min", name: "Мин", target: 10.5, deadline: "", initial: 0, icon: "Target", createdAt: 0 },
    { ...GOAL2, id: "g_cut", name: "Б" + "б".repeat(59), icon: "Target", createdAt: 0 },
  ]);
  assert.deepEqual(d.snap.settings.categories, [
    CAT,
    { id: "c_arch01", type: "income", name: "Пособие", icon: "HandCoins", archived: true },
    { id: "c_noicon1", type: "expense", name: "Ш".repeat(32), icon: "Tag" },
  ]);
  assert.deepEqual(d.snap.settings.limits, { cafe: 100.56, [CAT.id]: 50 });
  assertV2(d.snap.settings);

  // caps: 20 goals, 60 categories, 100 limits (the first ones are kept)
  const big = maxSettings();
  const g21 = [...big.goals, { ...GOAL, id: "g_21st" }];
  const c61 = [...big.categories, { ...CAT, id: "c_61st0" }];
  const l101 = { ...big.limits, cafe: 1 };
  await d.store.saveSettings({ startBalance: 0, goals: g21, categories: c61, limits: l101 });
  assert.equal(d.snap.settings.goals.length, 20);
  assert.equal(d.snap.settings.categories.length, 60);
  assert.equal(Object.keys(d.snap.settings.limits).length, 100);
  assert.ok(!d.snap.settings.goals.some(g => g.id === "g_21st") && !d.snap.settings.categories.some(c => c.id === "c_61st0") && !("cafe" in d.snap.settings.limits));

  // a malformed field or an oversized document rejects the whole save
  const before = d.snap.settings;
  await rejects(d.store.saveSettings({ ...DEFAULT_SETTINGS, goals: GOAL }), "invalid");
  await rejects(d.store.saveSettings({ ...DEFAULT_SETTINGS, categories: {} }), "invalid");
  await rejects(d.store.saveSettings({ ...DEFAULT_SETTINGS, startBalance: 1e11 }), "invalid");
  await rejects(d.store.saveSettings({ ...DEFAULT_SETTINGS, notes: "x".repeat(61_000) }), "invalid", /проверьте введённые значения/);
  assert.deepEqual(d.snap.settings, before);
});

test("v2 settings: the largest document the app can make is saved, pushed (server size check) and pulled whole", async () => {
  const doc = without(maxSettings(), "example");
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server, seed: null }).ready();
  await a.signIn("anna@example.com");
  await a.store.saveSettings(doc);
  assert.deepEqual(a.snap.settings, doc, "nothing of it is cut or dropped");
  await a.store.sync.syncNow();
  assert.deepEqual([a.sync.phase, a.sync.pending], ["idle", 0]);
  const row = server.rows("budget_settings")[0];
  assert.deepEqual(without(row.data, "_ms"), doc);
  const bytes = pgJsonBytes(row.data);
  assert.ok(bytes > 25_000 && bytes < 65536 - 30_000, `octet_length(data::text) = ${bytes}: far below the 64 KB check`);
  assert.ok(bytes > 32768 - 8000, "it would come close to the old 32 KB check");
  const b = await new Device({ server, seed: null }).ready();
  await b.signIn("anna@example.com");
  assert.deepEqual(b.snap.settings, doc);

  // the server's size check is still enforced (a project with an older, smaller limit): the error is shown, data stays
  server.settingsMaxBytes = 20_000;
  a.tick(); await uiSaveSettings(a, { startBalance: 1 });
  await rejects(a.store.sync.syncNow(), "invalid", /отклонил/);
  assert.equal(a.sync.pending, 1);
});

test("v2 text: notes and names cut inside an emoji or holding NUL still reach the server", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server, seed: null }).ready();
  await a.signIn("anna@example.com");
  const t1 = await a.store.saveTx(null, tx({ note: "a".repeat(79) + "😀" }));
  const t2 = await a.store.saveTx(null, tx({ note: "x\u0000y😀z\nw", category: "c_shuk01" }));
  const t3 = await a.store.saveTx(null, tx({ note: "lone \ud83d high and \ude00 low" }));
  assert.equal(a.find(t1).note, "a".repeat(79), "an emoji that does not fit is left out whole");
  assert.equal(a.find(t2).note, "xy😀z\nw");
  assert.equal(a.find(t3).note, "lone  high and  low");
  assert.equal(a.find(t2).category, "c_shuk01");
  await a.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [{ ...GOAL, name: "b".repeat(59) + "😀" }], categories: [{ ...CAT, name: "Ш\u0000ук\t" }] });
  assert.equal(a.snap.settings.goals[0].name, "b".repeat(59));
  assert.equal(a.snap.settings.categories[0].name, "Шук");
  await a.store.sync.syncNow();
  assert.deepEqual([a.sync.phase, a.sync.pending, a.sync.error], ["idle", 0, null]);
  assert.equal(server.rows("transactions").find(r => r.id === t2).note, "xy😀z\nw");
});

test("v2 settings: «Удалить пример» on the v2 example resets every field with stamp 0; an account's values then win", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const phone = await new Device({ server, seed: null }).ready();
  await phone.signIn("anna@example.com");
  await phone.store.saveSettings({ startBalance: 300, goals: [GOAL], limits: { cafe: 100 }, categories: [CAT] });
  await phone.store.sync.syncNow();

  const ipad = await new Device({ server, clock: T0 + 3600_000 }).ready();
  assert.equal(ipad.snap.settings.example.categories, true);
  await uiClearExamples(ipad);
  assert.deepEqual(ipad.snap.settings, DEFAULT_SETTINGS);
  assert.deepEqual(ipad.kv().settings.fieldMs, { startBalance: 0, goals: 0, limits: 0, categories: 0 });
  assert.equal(ipad.kv().settings.localOnly, true);
  assert.equal(ipad.sync.pending, 0);
  await ipad.signIn("anna@example.com");
  assert.deepEqual(ipad.snap.settings, { startBalance: 300, goals: [GOAL], limits: { cafe: 100 }, categories: [CAT] });
  assert.equal(ipad.sync.pending, 0);
});

/* ── v2 settings: goals and categories merge entry by entry; savings keep their goal ─────── */
const G3 = { id: "g_bike", name: "Велосипед", target: 3000, deadline: "", initial: 0, icon: "Bike", createdAt: 3 };
const G4 = { id: "g_sofa", name: "Диван", target: 4000, deadline: "", initial: 0, icon: "Sofa", createdAt: 4 };
const C3 = { id: "c_vaad01", type: "expense", name: "Ваад байт", icon: "Building2" };
const C4 = { id: "c_btl001", type: "income", name: "Пособие", icon: "HandCoins" };

async function twoSignedIn(initial) {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const a = await new Device({ server, seed: null }).ready();
  await a.signIn("anna@example.com");
  if (initial) { await a.store.saveSettings(initial); await a.store.sync.syncNow(); }
  const b = await new Device({ server, seed: null }).ready();
  await b.signIn("anna@example.com");
  return { server, a, b };
}

test("v2 entries: two devices add different goals offline: both goals survive, savings keep their goal", async () => {
  const { server, a, b } = await twoSignedIn({ ...DEFAULT_SETTINGS, goals: [GOAL] });
  a.win.setOnline(false); b.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { goals: [...a.snap.settings.goals, GOAL2] });
  const sa = await a.store.saveTx(null, saving({ goalId: GOAL2.id, note: "на отпуск" }));
  b.tick(120_000); await uiSaveSettings(b, { goals: [...b.snap.settings.goals, G3] });
  const sb = await b.store.saveTx(null, saving({ goalId: G3.id, note: "на велосипед" }));
  a.win.setOnline(true); b.win.setOnline(true);
  await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  for (const d of [a, b]) {
    const ids = d.snap.settings.goals.map(g => g.id);
    assert.deepEqual(ids.sort(), [GOAL.id, GOAL2.id, G3.id].sort(), "both new goals survive on " + (d === a ? "a" : "b"));
    for (const s of [sa, sb]) assert.ok(ids.includes(d.find(s).goalId), "saving " + s + " still has its goal");
  }
  assert.equal(server.rows("budget_settings")[0].data.goals.length, 3);
});

test("v2 entries: two devices add different custom categories offline: both survive (no operation falls back to «Прочее»)", async () => {
  const { a, b } = await twoSignedIn({ ...DEFAULT_SETTINGS, categories: [CAT] });
  a.win.setOnline(false); b.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { categories: [...a.snap.settings.categories, C3] });
  await a.store.saveTx(null, tx({ category: C3.id }));
  b.tick(120_000); await uiSaveSettings(b, { categories: [...b.snap.settings.categories, C4] });
  await b.store.saveTx(null, tx({ type: "income", category: C4.id }));
  a.win.setOnline(true); b.win.setOnline(true);
  await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  for (const d of [a, b]) assert.deepEqual(d.snap.settings.categories.map(c => c.id).sort(), [CAT.id, C3.id, C4.id].sort());
});

test("v2 entries: a goal deleted on one device and another goal added offline on the other: the deleted one stays deleted, the new one stays", async () => {
  for (const laterIsDelete of [false, true]) {
    const { a, b } = await twoSignedIn({ ...DEFAULT_SETTINGS, goals: [GOAL, GOAL2] });
    a.win.setOnline(false); b.win.setOnline(false);
    const del = async () => { a.tick(laterIsDelete ? 120_000 : 60_000); await uiSaveSettings(a, { goals: [GOAL] }); };
    const add = async () => { b.tick(laterIsDelete ? 60_000 : 120_000); await uiSaveSettings(b, { goals: [...b.snap.settings.goals, G3] }); };
    await del(); await add();
    a.win.setOnline(true); b.win.setOnline(true);
    await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
    for (const d of [a, b]) assert.deepEqual(d.snap.settings.goals.map(g => g.id), [GOAL.id, G3.id], `laterIsDelete=${laterIsDelete}`);
  }
});

test("v2 entries: sign-in after anonymous use with a goal and a category of its own keeps the account's goals and categories; the account's first goal stays first", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const phone = await new Device({ server, seed: null }).ready();
  await phone.signIn("anna@example.com");
  await phone.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL_V1_AS_V2, GOAL2], categories: [CAT] });
  const legacy = await phone.store.saveTx(null, saving());   // no goalId: belongs to the first goal (g_main)
  await phone.store.sync.syncNow();

  // iPad, a day later: «Удалить пример», then a goal and a category of its own, then signs in
  const ipad = await new Device({ server, clock: T0 + 86_400_000 }).ready();
  await uiClearExamples(ipad);
  ipad.tick(); await uiSaveSettings(ipad, { goals: [G3] });
  ipad.tick(); await uiSaveSettings(ipad, { categories: [C3] });
  await ipad.signIn("anna@example.com");
  await phone.store.sync.syncNow();
  for (const d of [phone, ipad]) {
    const s = d.snap.settings;
    assert.deepEqual(s.goals.map(g => g.id), [GOAL_V1_AS_V2.id, GOAL2.id, G3.id], "union, the account's goals first");
    assert.deepEqual(s.categories.map(c => c.id), [CAT.id, C3.id]);
    assert.equal("goalId" in d.find(legacy), false);
  }
});

test("v2 entries: a backup from another device imported here keeps goals and categories added on this device since", async () => {
  const e = await new Device({ seed: null, clock: 10_000 }).ready();
  await e.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL], categories: [CAT] });
  const d = await new Device({ seed: null, clock: 10_000 }).ready();
  await d.store.backup.import(JSON.parse(JSON.stringify(e.store.backup.export())));
  d.t = 20_000; await uiSaveSettings(d, { goals: [GOAL, G3], categories: [CAT, C4] });
  e.t = 30_000; await uiSaveSettings(e, { goals: [GOAL, GOAL2], categories: [CAT, C3] });
  d.t = 40_000; await d.store.backup.import(JSON.parse(JSON.stringify(e.store.backup.export())));
  assert.deepEqual(d.snap.settings.goals.map(g => g.id), [GOAL.id, G3.id, GOAL2.id]);
  assert.deepEqual(d.snap.settings.categories.map(c => c.id), [CAT.id, C4.id, C3.id]);
  // and a goal deleted here after the backup was made does not come back from it
  d.t = 50_000; await uiSaveSettings(d, { goals: [GOAL, GOAL2] });
  d.t = 60_000; await d.store.backup.import(JSON.parse(JSON.stringify(e.store.backup.export())));
  assert.deepEqual(d.snap.settings.goals.map(g => g.id), [GOAL.id, GOAL2.id]);
});

test("v2 entries: the same goal edited on both devices: the later edit wins", async () => {
  const { a, b } = await twoSignedIn({ ...DEFAULT_SETTINGS, goals: [GOAL, GOAL2] });
  a.win.setOnline(false); b.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { goals: [{ ...GOAL, target: 1 }, GOAL2] });
  b.tick(120_000); await uiSaveSettings(b, { goals: [{ ...GOAL, target: 2 }, GOAL2] });
  a.win.setOnline(true); b.win.setOnline(true);
  await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  for (const d of [a, b]) assert.equal(d.snap.settings.goals[0].target, 2);
});

// what the UI computes: the goal a saving belongs to (goalId, or the first goal)
const goalOfTx = (t, goals) => (t.goalId ? goals.find(g => g.id === t.goalId) || null : goals[0] || null);
const savedIn = (d, goalId) => d.snap.tx.filter(t => t.type === "saving" && (goalOfTx(t, d.snap.settings.goals) || {}).id === goalId).reduce((s, t) => s + t.amount, 0);

test("v2 entries: deleting the first goal does not move its savings without goalId into the next goal", async () => {
  const d = await new Device({ seed: null }).ready();
  await d.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL_V1_AS_V2, GOAL2] });
  await d.store.saveTx(null, saving({ amount: 700 }));                       // v1-style: no goalId → g_main
  await d.store.saveTx(null, saving({ amount: 50, goalId: GOAL2.id }));
  assert.deepEqual([savedIn(d, "g_main"), savedIn(d, GOAL2.id)], [700, 50]);
  d.tick(); await uiSaveSettings(d, { goals: [GOAL2] });                     // «Удалить цель» on g_main
  assert.equal(savedIn(d, GOAL2.id), 50, "the trip goal does not get the car's 700");
  d.tick(); await uiSaveSettings(d, { goals: [GOAL_V1_AS_V2, GOAL2] });      // «Вернуть»
  assert.deepEqual([savedIn(d, "g_main"), savedIn(d, GOAL2.id)], [700, 50], "undo brings the savings back with the goal");
});

test("v2 entries: sign-in after anonymous use (v1 data: one goal, savings without goalId) into an account with goals keeps each saving with its goal", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const phone = await new Device({ server, seed: null }).ready();
  await phone.signIn("anna@example.com");
  await phone.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL, GOAL2] });
  await phone.store.saveTx(null, saving({ amount: 300 }));                   // the account's first goal
  await phone.store.sync.syncNow();
  const old = await new Device({ server, seed: null, clock: T0 + 3600_000 }).ready();
  old.win.idb.poke("budget-pwa", "kv", "settings", { data: { startBalance: 0, goal: GOAL_V1, limits: {} }, fieldMs: { startBalance: 1, goal: T0 + 1000, limits: 1 }, updatedMs: T0 + 1000, dirty: true, localOnly: false });
  await old.restart();
  await old.store.saveTx(null, saving({ amount: 900 }));                     // belongs to g_main on this device
  assert.equal(savedIn(old, "g_main"), 900);
  await old.signIn("anna@example.com");
  await phone.store.sync.syncNow();
  for (const d of [phone, old]) {
    assert.deepEqual(d.snap.settings.goals.map(g => g.id), [GOAL.id, GOAL2.id, "g_main"]);
    assert.deepEqual([savedIn(d, GOAL.id), savedIn(d, "g_main")], [300, 900]);
  }
});

test("v2 entries: a stale third device cannot bring a deleted goal back; an edit made after the delete does", async () => {
  const { server, a, b } = await twoSignedIn({ ...DEFAULT_SETTINGS, goals: [GOAL, GOAL2] });
  const c = await new Device({ server, seed: null }).ready();
  await c.signIn("anna@example.com");
  c.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { goals: [GOAL] }); await a.store.sync.syncNow();
  b.tick(70_000); await b.store.sync.syncNow();
  c.tick(80_000); await uiSaveSettings(c, { goals: [...c.snap.settings.goals, G3] });   // stale: still holds GOAL2
  c.win.setOnline(true); await c.store.sync.syncNow();
  await a.store.sync.syncNow(); await b.store.sync.syncNow();
  for (const d of [a, b, c]) assert.deepEqual(d.snap.settings.goals.map(g => g.id), [GOAL.id, G3.id]);
  // b edits G3 offline after a deletes it: the later edit wins (like operations)
  b.win.setOnline(false);
  a.tick(100_000); await uiSaveSettings(a, { goals: [GOAL] }); await a.store.sync.syncNow();
  b.tick(200_000); await uiSaveSettings(b, { goals: [GOAL, { ...G3, target: 3500 }] });
  b.win.setOnline(true); await b.store.sync.syncNow(); await a.store.sync.syncNow(); await c.store.sync.syncNow();
  for (const d of [a, b, c]) assert.deepEqual(d.snap.settings.goals.map(g => [g.id, g.target]), [[GOAL.id, GOAL.target], [G3.id, 3500]]);
  for (const d of [a, b, c]) assert.equal(d.sync.pending, 0);
});

test("v2 entries: tombstones are capped; dropping old ones still keeps their entries deleted on a stale device", async () => {
  const cats = Array.from({ length: 40 }, (_, i) => ({ id: "c_k" + String(i).padStart(3, "0"), type: "expense", name: "К" + i, icon: "Tag" }));
  const { server, a, b } = await twoSignedIn({ ...DEFAULT_SETTINGS, categories: cats });
  b.win.setOnline(false);
  for (let i = 0; i < 36; i++) { a.tick(1000); await uiSaveSettings(a, { categories: a.snap.settings.categories.slice(1) }); }
  await a.store.sync.syncNow();
  const items = server.rows("budget_settings")[0].data._ms.items.categories;
  assert.equal(Object.keys(items.gone).length, 30);
  assert.ok(items.since > 0);
  b.tick(100_000); await uiSaveSettings(b, { categories: [...b.snap.settings.categories, C3] });   // stale, adds one
  b.win.setOnline(true); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  for (const d of [a, b]) assert.deepEqual(d.snap.settings.categories.map(c => c.id), ["c_k036", "c_k037", "c_k038", "c_k039", C3.id]);
});

test("v2 entries: two lists that together hold more than 20 goals: the first 20 (the account's first), both devices agree, no endless re-push", async () => {
  const mk = (p, n) => Array.from({ length: n }, (_, i) => ({ ...G3, id: `g_${p}${i}`, name: p + i, createdAt: i }));
  const { server, a, b } = await twoSignedIn({ ...DEFAULT_SETTINGS, goals: mk("x", 5) });
  a.win.setOnline(false); b.win.setOnline(false);
  a.tick(1000); await uiSaveSettings(a, { goals: [...a.snap.settings.goals, ...mk("a", 10)] });
  b.tick(2000); await uiSaveSettings(b, { goals: [...b.snap.settings.goals, ...mk("b", 10)] });
  a.win.setOnline(true); b.win.setOnline(true);
  await a.store.sync.syncNow(); await b.store.sync.syncNow(); await a.store.sync.syncNow();
  // whoever reached the server first (the online event syncs both) keeps all 10 of its goals; the other gets 5 in
  const first = server.rows("budget_settings")[0].data.goals[5].id.slice(2, 3), second = first === "a" ? "b" : "a";
  const want = [...mk("x", 5), ...mk(first, 10), ...mk(second, 5)].map(g => g.id);
  for (const d of [a, b]) assert.deepEqual(d.snap.settings.goals.map(g => g.id), want);
  assert.deepEqual(server.rows("budget_settings")[0].data.goals.map(g => g.id), want);
  const n = server.log.filter(l => l.op === "upsert" && l.table === "budget_settings").length;
  await a.store.sync.syncNow(); await b.store.sync.syncNow();
  assert.equal(server.log.filter(l => l.op === "upsert" && l.table === "budget_settings").length, n, "nothing left to push");
});

test("v2 entries: a row written by a version without entry stamps counts as a whole for entries older than it", async () => {
  const { server, a } = await twoSignedIn({ ...DEFAULT_SETTINGS, goals: [GOAL] });
  const u = a.sync.user;
  a.win.setOnline(false);
  a.tick(60_000); await uiSaveSettings(a, { goals: [GOAL, GOAL2] });          // older than the row below
  const t1 = a.t + 60_000;
  server.put("budget_settings", { user_id: u.id, client_updated_ms: t1,
    data: { ...DEFAULT_SETTINGS, goals: [{ ...GOAL, name: "Машина 2" }], _ms: { startBalance: 0, goals: t1, limits: 0, categories: 0, at: t1 } } });
  a.tick(120_000); await uiSaveSettings(a, { goals: [...a.snap.settings.goals, G3] });   // newer than the row
  a.win.setOnline(true); await a.store.sync.syncNow();
  assert.deepEqual(a.snap.settings.goals.map(g => [g.id, g.name]), [[GOAL.id, "Машина 2"], [G3.id, G3.name]]);
});

test("v2 entries: the example's goals never join an account's goals; a sign-in while the example is shown keeps only the account's", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const phone = await new Device({ server, seed: null }).ready();
  await phone.signIn("anna@example.com");
  await phone.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL] });
  await phone.store.sync.syncNow();
  const ipad = await new Device({ server }).ready();
  assert.ok(ipad.snap.settings.example.goals);
  await ipad.signIn("anna@example.com");
  assert.deepEqual(ipad.snap.settings.goals, [GOAL]);
  assert.equal("example" in ipad.snap.settings, false);
});

test("v2 entries: malformed entry stamps in a row or a file are ignored, never crash, never reach the UI", async () => {
  const { server, a } = await twoSignedIn({ ...DEFAULT_SETTINGS, goals: [GOAL] });
  const u = a.sync.user;
  const t1 = a.t + 60_000;
  const bad = { since: "x", ms: { [GOAL.id]: -5, g_trip: 9e15, __proto__x: 1 }, gone: JSON.parse('{"__proto__": 5, "bad id": 7, "g_car": "1", "g_ok": ' + (t1 + 10) + '}') };
  server.put("budget_settings", { user_id: u.id, client_updated_ms: t1,
    data: { ...DEFAULT_SETTINGS, goals: [GOAL, GOAL2], _ms: { startBalance: 0, goals: t1, limits: 0, categories: 0, at: t1, items: { goals: bad, categories: [] } } } });
  a.tick(120_000); await a.store.sync.syncNow();
  assert.deepEqual(a.snap.settings.goals.map(g => g.id), [GOAL.id, GOAL2.id]);
  assertV2(a.snap.settings);
  assert.equal(a.sync.phase, "idle");
  const out = a.store.backup.export();
  const d = await new Device({ seed: null }).ready();
  await d.store.backup.import({ ...out, settingsItemsUpdatedAt: { goals: bad, categories: "x" } });
  assert.deepEqual(d.snap.settings.goals.map(g => g.id), [GOAL.id, GOAL2.id]);
  assertV2(d.snap.settings);
});

test("v2 entries: backups carry entry stamps and tombstones; a restored device does not bring back a goal deleted in the account", async () => {
  const { a, b } = await twoSignedIn({ ...DEFAULT_SETTINGS, goals: [GOAL, GOAL2] });
  const file = JSON.parse(JSON.stringify(b.store.backup.export()));            // GOAL, GOAL2
  assert.deepEqual(Object.keys(file.settingsItemsUpdatedAt).sort(), ["categories", "goals"]);
  a.tick(60_000); await uiSaveSettings(a, { goals: [GOAL] }); await a.store.sync.syncNow();
  b.tick(120_000); await b.store.sync.syncNow();
  b.tick(1000); await b.store.backup.import(file);
  await b.store.sync.syncNow(); await a.store.sync.syncNow();
  for (const d of [a, b]) assert.deepEqual(d.snap.settings.goals.map(g => g.id), [GOAL.id]);
  const fresh = await new Device({ seed: null, clock: a.t + 1000 }).ready();
  await fresh.store.backup.import(JSON.parse(JSON.stringify(a.store.backup.export())));
  assert.deepEqual(fresh.kv().settings.items, a.kv().settings.items);
});

test("v2 entries: pinning: only live savings without goalId; example records, explicit goals and other types are untouched; no tx write when the first goal stays", async () => {
  const d = await new Device({ seed: null }).ready();
  await d.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL, GOAL2] });
  const s1 = await d.store.saveTx(null, saving());
  const s2 = await d.store.saveTx(null, saving({ goalId: GOAL2.id }));
  const e1 = await d.store.saveTx(null, tx());
  const gone = await d.store.saveTx(null, saving()); await d.store.deleteTx(gone);
  const before = JSON.stringify(d.kv().tx);
  d.tick(); await uiSaveSettings(d, { goals: [{ ...GOAL, target: 1 }, GOAL2], startBalance: 5 });   // same first goal
  assert.equal(JSON.stringify(d.kv().tx), before, "operations not rewritten");
  d.tick(); await uiSaveSettings(d, { goals: [GOAL2, { ...GOAL, target: 1 }] });   // reorder: the first goal changes
  assert.deepEqual([d.find(s1).goalId, d.find(s2).goalId, "goalId" in d.find(e1)], [GOAL.id, GOAL2.id, false]);
  assert.equal("goalId" in d.kv().tx[gone], false);
  // the example's goals never pin anything
  const x = await new Device().ready();
  const real = await x.store.saveTx(null, saving());
  await uiClearExamples(x);
  assert.equal("goalId" in x.find(real), false);
});

test("v2 entries: the largest stamps the store adds (_ms with entry stamps and MAX_GONE tombstones) fit next to the largest document it accepts", async () => {
  const wire = maxSettingsWire();
  const msBytes = pgJsonBytes({ _ms: wire._ms }) - 2;
  assert.ok(57000 + msBytes < 65536, `57 000 + ${msBytes} bytes of _ms must stay under the server's 65 536`);
  const d = await new Device({ seed: null }).ready();
  const pad = n => ({ ...DEFAULT_SETTINGS, notes: "x".repeat(n) });
  await d.store.saveSettings(pad(56_900));
  await rejects(d.store.saveSettings(pad(57_100)), "invalid");
  // the store keeps exactly MAX_GONE tombstones per list (tests/helpers/max-settings.mjs measures that many)
  for (let i = 0; i < MAX_GONE + 5; i++) { d.tick(); await d.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [{ ...GOAL, id: "g_t" + i }] }); }
  d.tick(); await d.store.saveSettings(DEFAULT_SETTINGS);
  assert.equal(Object.keys(d.kv().settings.items.goals.gone).length, MAX_GONE);
});

/* ── store-artifact.js (claude.ai artifact) ─────────────────────────────── */

test("artifact store: goalId goes into the transaction document for savings only", async () => {
  const docs = new Map();
  const ref = path => ({
    id: path.split("/").pop(),
    set: async body => { docs.set(path, JSON.parse(JSON.stringify(body))); },
    delete: async () => { docs.delete(path); },
    onSnapshot: cb => setTimeout(() => cb(path.endsWith("/tx") ? { docs: [] } : { exists: false }), 0),
    collection: name => colRef(path + "/" + name),
  });
  let n = 0;
  const colRef = path => ({ ...ref(path), doc: id => ref(path + "/" + (id || "auto" + ++n)) });
  const holder = Object.create(globalThis);
  holder.claude = { use: name => (name === "db" ? { doc: ref } : { id: async () => "viewer1" }) };
  loadScript(new URL("../src/store-artifact.js", import.meta.url).pathname, holder);
  const store = holder.createBudgetStore();
  let snap = null;
  store.init(s => { snap = s; });
  await waitFor(() => snap && snap.status === "ready", { what: "artifact ready" });
  const s1 = await store.saveTx(null, saving({ goalId: "g_car" }));
  const e1 = await store.saveTx(null, tx({ goalId: "g_car" }));
  const s2 = await store.saveTx(null, saving({ goalId: "no good" }));
  await store.restoreTx("r1", saving({ goalId: "g_trip" }));
  const body = id => docs.get("data/users/viewer1/budget/tx/" + id);
  assert.equal(body(s1).goalId, "g_car");
  assert.equal("goalId" in body(e1), false);
  assert.equal("goalId" in body(s2), false);
  assert.equal(body("r1").goalId, "g_trip");
});

function artifactStore(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const subs = new Set();
  const deliver = s => s.cb(s.col
    ? { docs: [...docs.keys()].filter(p => p.startsWith(s.path + "/") && !p.slice(s.path.length + 1).includes("/")).map(p => ({ id: p.split("/").pop(), data: () => JSON.parse(JSON.stringify(docs.get(p))) })) }
    : { exists: docs.has(s.path), data: () => JSON.parse(JSON.stringify(docs.get(s.path))) });
  const notify = () => { for (const s of subs) setTimeout(() => deliver(s), 0); };
  const ref = (path, col) => ({
    id: path.split("/").pop(),
    set: async body => { docs.set(path, JSON.parse(JSON.stringify(body))); notify(); },
    delete: async () => { docs.delete(path); notify(); },
    onSnapshot: cb => { const s = { path, col, cb }; subs.add(s); setTimeout(() => deliver(s), 0); },
    collection: name => colRef(path + "/" + name),
  });
  let n = 0;
  const colRef = path => ({ ...ref(path, true), doc: id => ref(path + "/" + (id || "auto" + ++n)) });
  const holder = Object.create(globalThis);
  holder.claude = { use: name => (name === "db" ? { doc: p => ref(p) } : { id: async () => "viewer1" }) };
  loadScript(new URL("../src/store-artifact.js", import.meta.url).pathname, holder);
  const store = holder.createBudgetStore();
  const out = { store, docs, snap: null };
  store.init(s => { out.snap = s; });
  return out;
}

test("artifact store: deleting the first goal (also a v1 document's goal) keeps its savings without goalId with it", async () => {
  const P = "data/users/viewer1/budget", T = id => P + "/tx/" + id;
  const a = artifactStore({
    [P]: { startBalance: 0, goal: GOAL_V1, limits: {} },                          // v1: goal = g_main
    [T("s1")]: saving({ amount: 700 }), [T("s2")]: saving({ amount: 50, goalId: GOAL2.id }), [T("e1")]: tx(),
    [T("x1")]: saving({ amount: 9, example: true }),
  });
  await waitFor(() => a.snap && a.snap.status === "ready", { what: "artifact ready" });
  await a.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL_V1_AS_V2, GOAL2] });   // a goal added: g_main stays first
  assert.equal("goalId" in a.docs.get(T("s1")), false);
  await waitFor(() => Array.isArray(a.snap.settings.goals));
  await a.store.saveSettings({ ...DEFAULT_SETTINGS, goals: [GOAL2] });                  // «Убрать цель» g_main
  assert.deepEqual(["s1", "s2", "e1", "x1"].map(id => a.docs.get(T(id)).goalId), ["g_main", GOAL2.id, undefined, undefined]);
  assert.deepEqual(Object.keys(a.docs.get(P)).sort(), ["categories", "goals", "limits", "startBalance"], "no v1 goal written back");
  // the example's goals pin nothing
  const b = artifactStore({ [P]: { ...DEFAULT_SETTINGS, goals: [GOAL], example: { goals: true } }, [T("s1")]: saving() });
  await waitFor(() => b.snap && b.snap.status === "ready", { what: "artifact ready" });
  await b.store.saveSettings(DEFAULT_SETTINGS);
  assert.equal("goalId" in b.docs.get(T("s1")), false);
});
