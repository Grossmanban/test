// Browser-ish globals for running src/store-pwa.js in Node: localStorage,
// a window with events, document visibility, location and BroadcastChannel.
import { readFileSync } from "node:fs";
import { createFakeIndexedDB } from "./fake-idb.mjs";

export class FakeStorage {
  constructor({ quota = Infinity } = {}) { this.map = new Map(); this.quota = quota; this.broken = false; }
  _check() { if (this.broken) throw new DOMException("The operation is insecure.", "SecurityError"); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { this._check(); return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) {
    this._check();
    k = String(k); v = String(v);
    let size = 0;
    for (const [kk, vv] of this.map) if (kk !== k) size += kk.length + vv.length;
    if (size + k.length + v.length > this.quota) throw new DOMException("Quota exceeded", "QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k) { this._check(); this.map.delete(String(k)); }
  clear() { this._check(); this.map.clear(); }
}

class Emitter {
  constructor() { this._l = new Map(); }
  addEventListener(type, fn) { if (!this._l.has(type)) this._l.set(type, new Set()); this._l.get(type).add(fn); }
  removeEventListener(type, fn) { this._l.get(type)?.delete(fn); }
  dispatch(type, ev = {}) { for (const fn of [...(this._l.get(type) || [])]) fn({ type, ...ev }); }
  count(type) { return this._l.get(type)?.size || 0; }
}

// BroadcastChannel scoped to one fake "browser" (devices must not hear each other)
export function createBroadcastBus() {
  const chans = new Set();
  return class FakeBroadcastChannel {
    constructor(name) { this.name = name; this.onmessage = null; chans.add(this); }
    postMessage(data) {
      for (const c of chans) if (c !== this && c.name === this.name) setTimeout(() => c.onmessage && c.onmessage({ data: structuredClone(data) }), 0);
    }
    close() { chans.delete(this); }
  };
}

export function createWindow({
  idb = createFakeIndexedDB(), localStorage = new FakeStorage(), href = "https://app.example/budget/",
  config = null, seed = null, server = null, BroadcastChannel = undefined, noIndexedDB = false,
} = {}) {
  const u = new URL(href);
  const win = new Emitter();
  win.idbCtl = idb && idb.ctl;
  win.idb = idb;
  Object.defineProperty(win, "indexedDB", { get: () => (noIndexedDB || !idb ? undefined : idb.indexedDB), enumerable: true });
  win.localStorage = localStorage;
  win.navigator = { onLine: true };
  win.document = new Emitter();
  win.document.visibilityState = "visible";
  win.location = { href: u.href, origin: u.origin, protocol: u.protocol, pathname: u.pathname, search: u.search, hash: u.hash };
  win.history = {
    state: null,
    replaceState(state, _title, url) {
      const n = new URL(url, win.location.href);
      this.state = state;
      Object.assign(win.location, { href: n.href, pathname: n.pathname, search: n.search, hash: n.hash });
    },
  };
  // "the user opens a link": a new URL for the next store started on this window
  win.navigate = href => {
    const n = new URL(href, win.location.href);
    Object.assign(win.location, { href: n.href, origin: n.origin, protocol: n.protocol, pathname: n.pathname, search: n.search, hash: n.hash });
  };
  win.crypto = globalThis.crypto;
  win.BUDGET_CONFIG = config || { supabaseUrl: "", supabaseAnonKey: "" };
  if (seed) win.BudgetSeed = seed;
  if (BroadcastChannel) win.BroadcastChannel = BroadcastChannel;
  if (server) win.supabase = { createClient: (url, key, options) => server.createClient(url, key, options, win) };
  win.netDown = false;          // fetch fails although navigator.onLine is true
  win.setOnline = on => { win.navigator.onLine = on; win.dispatch(on ? "online" : "offline"); };
  win.setVisible = vis => { win.document.visibilityState = vis ? "visible" : "hidden"; win.document.dispatch("visibilitychange"); };
  return win;
}

// a tiny deterministic example budget (the real one is src/seed.js), settings v2
export const fakeSeed = {
  calls: [],
  make(todayIso) {
    this.calls.push(todayIso);
    const ym = todayIso.slice(0, 7);
    return {
      settings: {
        startBalance: 5240,
        goals: [{ id: "g_trip", name: "Отпуск", target: 25000, deadline: "2027-05-01", initial: 9600, icon: "Plane", createdAt: 1 }],
        limits: { groceries: 2500, cafe: 800 },
        categories: [{ id: "c_market", type: "expense", name: "Шук", icon: "ShoppingBasket" }],
        example: { startBalance: true, goals: true, limits: true, categories: true },
      },
      tx: [
        { id: "ex01", type: "expense", category: "housing", amount: 4500, note: "Аренда", date: `${ym}-01`, createdAt: 1, example: true },
        { id: "ex02", type: "income", category: "salary", amount: 7000, note: "Зарплата", date: `${ym}-05`, createdAt: 2, example: true },
        { id: "ex03", type: "saving", category: "savings", amount: 1500, note: "В копилку", date: `${ym}-05`, createdAt: 3, goalId: "g_trip", example: true },
      ],
    };
  },
};
// the same in the v1 shape (one goal, no categories), as an older src/seed.js made it
export const legacySeed = {
  make(todayIso) {
    const v2 = fakeSeed.make.call({ calls: [] }, todayIso);
    return {
      settings: {
        startBalance: 5240,
        goal: { name: "Отпуск", target: 25000, deadline: "2027-05-01", initial: 9600 },
        limits: { groceries: 2500, cafe: 800 },
        example: { startBalance: true, goal: true, limits: true },
      },
      tx: v2.tx.map(({ goalId, ...t }) => t),
    };
  },
};

// Loads a classic-script src/*.js file into a holder object that plays "window".
export function loadScript(path, holder = Object.create(globalThis)) {
  const code = readFileSync(path, "utf8");
  // eslint-disable-next-line no-new-func
  new Function("window", "globalThis", code)(holder, holder);
  return holder;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 3000, step = 5, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting for " + what);
    await sleep(step);
  }
}
