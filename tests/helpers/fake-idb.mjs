// A small in-memory IndexedDB for Node tests of src/store-pwa.js.
// It models what the store relies on: open/upgrade, one object store with
// out-of-line keys, get/put/delete requests, transactions that commit when no
// request is pending, are serialized per database, become inactive after the
// creating task (a request made later throws TransactionInactiveError), and
// can be made to fail (quota on commit, lost connection, failing open).

const dom = (name, message = name) => new DOMException(message, name);
const later = fn => setTimeout(fn, 0);

export function createFakeIndexedDB() {
  const dbs = new Map();   // name → { version, stores: Map<string, Map<key, value>>, queue: FakeTx[] }
  const ctl = {
    failOpen: null,              // e.g. "InvalidStateError": every open() fails
    hangOpen: false,             // open() never answers (old Safari bug)
    failNextCommit: null,        // e.g. "QuotaExceededError": the next readwrite commit aborts
    failNextTransaction: null,   // e.g. "InvalidStateError": the next db.transaction() throws
    opens: 0, commits: 0,
  };

  const indexedDB = {
    open(name, version = 1) {
      const req = { result: null, error: null, readyState: "pending", onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      ctl.opens++;
      later(() => {
        if (ctl.hangOpen) return;
        if (ctl.failOpen) { req.error = dom(ctl.failOpen); req.readyState = "done"; req.onerror && req.onerror({ target: req }); return; }
        let rec = dbs.get(name);
        if (!rec) { rec = { version: 0, stores: new Map(), queue: [] }; dbs.set(name, rec); }
        if (version < rec.version) { req.error = dom("VersionError"); req.onerror && req.onerror({ target: req }); return; }
        const conn = new FakeDB(rec, ctl);
        req.result = conn;
        if (version > rec.version) {
          const oldVersion = rec.version;
          rec.version = version;
          conn._upgrading = true;
          try { req.onupgradeneeded && req.onupgradeneeded({ target: req, oldVersion, newVersion: version }); } finally { conn._upgrading = false; }
        }
        req.readyState = "done";
        req.onsuccess && req.onsuccess({ target: req });
      });
      return req;
    },
    deleteDatabase(name) { dbs.delete(name); const req = {}; later(() => req.onsuccess && req.onsuccess({ target: req })); return req; },
  };

  // plain copy of an object store, for assertions
  function dump(name = "budget-pwa", store = "kv") {
    const rec = dbs.get(name);
    const s = rec && rec.stores.get(store);
    const out = {};
    if (s) for (const [k, v] of s) out[k] = structuredClone(v);
    return out;
  }
  function poke(name, store, key, value) {
    const rec = dbs.get(name);
    rec.stores.get(store).set(key, structuredClone(value));
  }
  return { indexedDB, ctl, dump, poke };
}

class FakeDB {
  constructor(rec, ctl) {
    this._rec = rec; this._ctl = ctl; this._closed = false; this._upgrading = false;
    this.onversionchange = null; this.onclose = null;
    this.objectStoreNames = { contains: n => rec.stores.has(n) };
  }
  createObjectStore(name) {
    if (!this._upgrading) throw dom("InvalidStateError");
    this._rec.stores.set(name, new Map());
    return {};
  }
  transaction(names, mode = "readonly") {
    if (this._closed) throw dom("InvalidStateError", "The database connection is closing.");
    if (this._ctl.failNextTransaction) { const n = this._ctl.failNextTransaction; this._ctl.failNextTransaction = null; throw dom(n); }
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) if (!this._rec.stores.has(n)) throw dom("NotFoundError");
    return new FakeTx(this, mode);
  }
  close() { this._closed = true; }
}

class FakeTx {
  constructor(db, mode) {
    this.db = db; this.mode = mode;
    this.error = null; this.oncomplete = null; this.onerror = null; this.onabort = null;
    this._state = "active";      // active | finished | aborted
    this._active = true;         // requests may be made
    this._running = false;       // holds the database lock
    this._requests = [];         // waiting to be processed
    this._pending = 0;
    this._writes = new Map();    // store → Map(key → value | DELETE)
    db._rec.queue.push(this);
    later(() => { this._active = false; this._tick(); });
    this._acquire();
  }
  objectStore(name) {
    const tx = this;
    const base = this.db._rec.stores.get(name);
    if (!base) throw dom("NotFoundError");
    const writes = this._writes.get(name) || new Map();
    this._writes.set(name, writes);
    const request = run => {
      if (tx._state !== "active" || !tx._active) throw dom("TransactionInactiveError");
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, transaction: tx };
      tx._pending++;
      tx._requests.push(() => {
        try { req.result = run(); } catch (e) { req.error = e; }
        tx._pending--;
        tx._active = true;
        try {
          if (req.error) { req.onerror && req.onerror({ target: req, preventDefault() {} }); tx._fail(req.error); }
          else req.onsuccess && req.onsuccess({ target: req });
        } finally { tx._active = false; }
        tx._tick();
      });
      tx._acquire();
      return req;
    };
    return {
      get: key => request(() => {
        const v = writes.has(key) ? writes.get(key) : base.get(key);
        return v === DELETE || v === undefined ? undefined : structuredClone(v);
      }),
      put: (value, key) => {
        if (tx.mode !== "readwrite") throw dom("ReadOnlyError");
        const copy = structuredClone(value);   // DataCloneError surfaces synchronously, as in browsers
        return request(() => { writes.set(key, copy); return key; });
      },
      delete: key => {
        if (tx.mode !== "readwrite") throw dom("ReadOnlyError");
        return request(() => { writes.set(key, DELETE); });
      },
    };
  }
  abort() {
    if (this._state !== "active") throw dom("InvalidStateError");
    this._fail(dom("AbortError"));
  }
  _acquire() {
    const q = this.db._rec.queue;
    if (q[0] === this && !this._running) { this._running = true; }
    if (this._running && this._requests.length && !this._draining) {
      this._draining = true;
      later(() => {
        this._draining = false;
        const jobs = this._requests.splice(0);
        for (const j of jobs) { if (this._state === "active") j(); }
        this._acquire();
      });
    }
  }
  _tick() {
    if (this._state !== "active" || this._active || this._pending || !this._running) return;
    later(() => {
      if (this._state !== "active" || this._active || this._pending) return;
      if (this.mode === "readwrite" && this.db._ctl.failNextCommit) {
        const n = this.db._ctl.failNextCommit;
        this.db._ctl.failNextCommit = null;
        this._fail(dom(n));
        return;
      }
      for (const [name, writes] of this._writes) {
        const base = this.db._rec.stores.get(name);
        for (const [k, v] of writes) (v === DELETE ? base.delete(k) : base.set(k, v));
      }
      if (this.mode === "readwrite") this.db._ctl.commits++;
      this._state = "finished";
      this._release();
      this.oncomplete && this.oncomplete({ target: this });
    });
  }
  _fail(err) {
    if (this._state !== "active") return;
    this._state = "aborted";
    this.error = err;
    this._writes.clear();
    this._release();
    later(() => this.onabort && this.onabort({ target: this }));
  }
  _release() {
    const q = this.db._rec.queue;
    const i = q.indexOf(this);
    if (i >= 0) q.splice(i, 1);
    if (q[0]) q[0]._acquire(), q[0]._tick();
  }
}
const DELETE = Symbol("delete");
