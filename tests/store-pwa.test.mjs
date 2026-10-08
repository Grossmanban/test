// Tests for src/store-pwa.js (run: node --test tests/store-pwa.test.mjs).
// The store runs in Node against fake browser globals (tests/helpers/fake-env.mjs),
// a fake IndexedDB (fake-idb.mjs) and a fake Supabase project (fake-supabase.mjs)
// that several "devices" share.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createWindow, FakeStorage, fakeSeed, loadScript, sleep, waitFor, createBroadcastBus } from "./helpers/fake-env.mjs";
import { createFakeIndexedDB } from "./helpers/fake-idb.mjs";
import { createFakeSupabase, FAKE_URL, FAKE_ANON_KEY, FAKE_SERVICE_KEY, tsUs } from "./helpers/fake-supabase.mjs";

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
  client() { return this.server.clients.filter(c => c.win === this.win).at(-1); }
}
const tx = (over = {}) => ({ type: "expense", amount: 100, category: "groceries", note: "", date: "2026-10-08", createdAt: 1, ...over });
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

  await d.store.saveSettings({ startBalance: -1500.5, goal: { name: " Машина ", target: 900000, deadline: "", initial: 0 }, limits: { cafe: 5000, bad: -1 } });
  assert.deepEqual(d.snap.settings, { startBalance: -1500.5, goal: { name: "Машина", target: 900000, deadline: "", initial: 0 }, limits: { cafe: 5000 } });

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
  await rejects(d.store.saveSettings({ startBalance: NaN, goal: null, limits: {} }), "invalid");
  await rejects(d.store.saveSettings({ startBalance: 0, goal: { name: "x", target: 0 }, limits: {} }), "invalid");
  assert.equal(d.snap.tx.length, 3, "only the examples");
});

test("first run seeds the example budget as device-only records", async () => {
  const d = await new Device().ready();
  assert.deepEqual(d.ids(), ["ex01", "ex02", "ex03"]);
  assert.ok(d.tx.every(t => t.example === true && t.updatedAt === undefined));
  assert.deepEqual(d.snap.settings.example, { startBalance: true, goal: true, limits: true });
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

  // editing an example (the UI drops the flag) makes it a normal record
  await d.store.saveTx("ex02", without(d.find("ex02"), "id", "example"));
  assert.deepEqual([d.kv().tx.ex02.localOnly, d.kv().tx.ex02.dirty], [false, true]);
  assert.equal(d.find("ex02").example, undefined);
  assert.equal(d.sync.pending, 1);

  // "Удалить пример": examples deleted, example settings reset to defaults → still device-only
  await d.store.deleteMany(["ex01", "ex03"], (done, total) => d.progress = [done, total]);
  assert.deepEqual(d.progress, [2, 2]);
  await d.store.saveSettings({ startBalance: 0, goal: null, limits: {} });
  assert.equal(d.kv().settings.localOnly, true);
  assert.equal(d.sync.pending, 1);

  // the example is not seeded again on the next start
  await d.restart();
  assert.deepEqual(d.ids(), ["ex02"]);
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
  assert.deepEqual(d.snap.settings.example, { startBalance: true, goal: true, limits: true });
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
  assert.deepEqual(without(d.sync, "lastSyncAt"), { available: true, configured: false, url: "", configSource: "none", user: null, phase: "off", pending: 0, error: null, recovery: false });

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
  assert.deepEqual(c.options, { auth: { flowType: "implicit", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "budget-pwa-auth" } });

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

test("password recovery link sets sync.recovery until the new password is saved", async () => {
  const server = createFakeSupabase();
  server.addUser("anna@example.com");
  const link = server.recoveryLink("anna@example.com");
  const d = await new Device({ server, href: "https://app.example/budget/" + link }).ready();
  await waitFor(() => d.sync.recovery === true, { what: "recovery flag" });
  assert.equal(d.sync.user.email, "anna@example.com");
  assert.equal(d.win.location.hash, "");
  await rejects(d.store.sync.updatePassword("123"), "invalid");
  assert.equal(d.sync.recovery, true);
  await d.store.sync.updatePassword("brand-new-pass");
  assert.equal(d.sync.recovery, false);

  const other = await new Device({ server }).ready();
  await rejects(other.store.sync.signIn("anna@example.com", PW), "auth", "Неверная почта или пароль.");
  await other.signIn("anna@example.com", "brand-new-pass");
  assert.equal(other.sync.phase, "idle");
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
  await a.store.saveSettings({ startBalance: 1000, goal: null, limits: { cafe: 3000 } });
  assert.equal(a.sync.pending, 2);
  await a.store.sync.syncNow();
  assert.equal(a.sync.pending, 0);
  const uid = a.sync.user.id;
  const [row] = server.rows("transactions");
  assert.deepEqual(without(row, "updated_at"), {
    user_id: uid, id, type: "expense", amount: 290, category: "cafe", note: "Кофе", date: "2026-10-08",
    created_ms: 42, example: false, deleted: false, client_updated_ms: a.t,
  });
  assert.match(row.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/);
  const [srow] = server.rows("budget_settings");
  assert.deepEqual(srow.data, { startBalance: 1000, goal: null, limits: { cafe: 3000 } });
  assert.equal(server.log.filter(l => l.op === "upsert").every(l => l.onConflict === (l.table === "transactions" ? "user_id,id" : "user_id")), true);
  assert.ok(server.log.filter(l => l.op === "select").every(l => l.filters.some(f => f[0] === "eq" && f[1] === "user_id" && f[2] === uid)));

  const b = await new Device({ server }).ready();
  await b.signIn("anna@example.com");
  assert.deepEqual(b.ids(), [id], "the account had data, so b's example went away");
  assert.deepEqual(without(b.find(id), "updatedAt"), without(a.find(id), "updatedAt"));
  assert.deepEqual(b.snap.settings, { startBalance: 1000, goal: null, limits: { cafe: 3000 } });
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
  const S = sb => ({ startBalance: sb, goal: null, limits: {} });

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
  await a.store.saveSettings({ startBalance: 777, goal: null, limits: {} });
  const real = await a.store.saveTx(null, tx({ note: "real" }));
  await a.store.sync.syncNow();

  const b = await new Device({ server }).ready();
  assert.equal(b.snap.tx.length, 3);
  await b.signIn("full@example.com");
  assert.deepEqual(b.ids(), [real]);
  assert.deepEqual(b.snap.settings, { startBalance: 777, goal: null, limits: {} });
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
  await d.store.saveSettings({ ...seeded, startBalance: 1234, example: { goal: true, limits: true } });
  assert.equal(d.kv().settings.localOnly, false);
  await d.signIn("partial@example.com");
  assert.deepEqual(d.snap.settings, { startBalance: 1234, goal: null, limits: {} });
  assert.deepEqual(server.rows("budget_settings", d.sync.user.id)[0].data, { startBalance: 1234, goal: null, limits: {} });
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
  await a.store.saveSettings({ startBalance: 5, goal: null, limits: {} });
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
  await d.store.saveSettings({ startBalance: 10, goal: null, limits: {} });
  const out = d.store.backup.export();
  assert.equal(out.app, "budget");
  assert.equal(out.version, 1);
  assert.equal(out.exportedAt, new Date(T0).toISOString());
  assert.deepEqual(out.settings, { startBalance: 10, goal: null, limits: {} });
  assert.equal(out.settingsUpdatedAt, T0);
  assert.equal(out.tx.length, 4);
  assert.deepEqual(Object.keys(out.tx.find(t => t.id === id)).sort(), ["amount", "category", "createdAt", "date", "id", "note", "type", "updatedAt"]);
  assert.ok(out.tx.filter(t => t.example).every(t => t.updatedAt === undefined));
  JSON.parse(JSON.stringify(out));

  const imp = data => d.store.backup.import(data);
  const file = txs => ({ app: "budget", version: 1, exportedAt: "x", settings: null, tx: txs });
  await rejects(imp(null), "invalid", "Файл не похож на резервную копию бюджета.");
  await rejects(imp("{not json"), "invalid", /не похож/);
  await rejects(imp({ app: "other", version: 1, tx: [] }), "invalid", /не похож/);
  await rejects(imp({ app: "budget", version: 2, tx: [] }), "invalid", /более новой версией/);
  const ok = { id: "ok1", type: "income", amount: 5, category: "salary", note: "", date: "2026-10-01", createdAt: 1 };
  await rejects(imp(file([ok, ok, { ...ok, id: "x", amount: -1 }])), "invalid", /операция №3: сумма/);
  await rejects(imp(file([{ ...ok, id: "with space" }])), "invalid", /№1: неверный идентификатор/);
  await rejects(imp(file([{ ...ok, id: "a".repeat(65) }])), "invalid", /идентификатор/);
  await rejects(imp(file([{ ...ok, date: "2026-02-30" }])), "invalid", /дата/);
  await rejects(imp(file([{ ...ok, type: "transfer" }])), "invalid", /тип/);
  await rejects(imp(file([{ ...ok, note: 5 }])), "invalid");
  await rejects(imp({ ...file([]), settings: { startBalance: "a lot" } }), "invalid", /настройки/);
  assert.equal(d.find("ok1"), undefined, "a failed import changes nothing");
});

test("backup import merges by timestamp: newer wins, untimed records lose to existing ones", async () => {
  const d = await new Device({ clock: 5000 }).ready();
  const e1 = await d.store.saveTx("e1", tx({ note: "e1 local" }));
  const e2 = await d.store.saveTx("e2", tx({ note: "e2 local" }));
  const e3 = await d.store.saveTx("e3", tx({ note: "e3 local" }));
  await d.store.deleteTx("e3");                               // tombstone at 5001
  await d.store.saveSettings({ startBalance: 1, goal: null, limits: {} });
  d.t = 100_000;                                              // backup timestamps from the future are capped at "now"
  const base = { type: "expense", amount: 1, category: "other", date: "2026-10-01", createdAt: 0 };
  const res = await d.store.backup.import(JSON.stringify({
    app: "budget", version: 1, exportedAt: "2026-10-08T00:00:00Z",
    settings: { startBalance: 99, goal: null, limits: {} }, settingsUpdatedAt: 6000,
    tx: [
      { ...base, id: e1, note: "older", updatedAt: 4000 },          // skipped: older
      { ...base, id: e2, note: "newer", updatedAt: 6000 },          // updated
      { ...base, id: "e3", note: "back", updatedAt: 9000 },         // newer than the tombstone: comes back
      { ...base, id: "ex01", note: "no timestamp" },               // skipped: untimed vs existing example
      { ...base, id: "n1", note: "new, untimed" },                 // added
      { ...base, id: "n2", note: "dup older", updatedAt: 10 },     // duplicate id: the newer copy is used
      { ...base, id: "n2", note: "dup newer", updatedAt: 20, example: true },
    ],
  }));
  assert.deepEqual(res, { added: 3, updated: 1, skipped: 3, settingsUpdated: true });
  assert.equal(d.find(e1).note, "e1 local");
  assert.equal(d.find(e2).note, "newer");
  assert.equal(d.find("e3").note, "back");
  assert.notEqual(d.find("ex01").note, "no timestamp");
  assert.equal(d.find("n1").note, "new, untimed");
  assert.equal(d.find("n2").note, "dup newer");
  assert.equal(d.find("n2").example, true);
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
