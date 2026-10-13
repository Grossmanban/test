/* Store adapter for the claude.ai artifact: the artifact's `db` capability, one private subtree per viewer
   (data/users/<id>/budget = settings document, data/users/<id>/budget/tx/<id> = one document per transaction). */
(() => {
  "use strict";
  const MESSAGES = {
    read_only: "Нет прав на запись: этот бюджет открыт только для просмотра.",
    quota: "Хранилище заполнено. Удалите старые операции и повторите.",
    rate: "Слишком много действий подряд. Подождите пару секунд и повторите.",
    revoked: "Доступ к данным для этой страницы закрыт.",
    network: "Нет соединения с хранилищем. Повторите через минуту.",
    unknown: "Не удалось сохранить. Повторите попытку.",
  };
  function fail(code) { const e = new Error(MESSAGES[code] || MESSAGES.unknown); e.code = code; return e; }
  function mapErr(e) {
    switch (e && e.code) {
      case "invalid_argument": return fail("read_only");
      case "quota_exceeded": return fail("quota");
      case "resource_exhausted": return fail("rate");
      case "revoked": return fail("revoked");
      case "unavailable": return fail("network");
      default: return fail("unknown");
    }
  }
  async function withRetry(fn) {
    try { return await fn(); }
    catch (e) {
      if (e && (e.code === "unavailable" || e.code === "resource_exhausted")) {
        await new Promise(r => setTimeout(r, 600 + Math.random() * 600));
        try { return await fn(); } catch (e2) { throw mapErr(e2); }
      }
      throw mapErr(e);
    }
  }
  function use(name) {
    try {
      if (window.claude && typeof window.claude.use === "function") return Promise.resolve(window.claude.use(name)).catch(() => null);
    } catch (e) { /* no viewer */ }
    return Promise.resolve(null);
  }
  // plain JSON body for a transaction document
  function txBody(d) {
    const out = {
      type: d.type, amount: d.amount, category: d.category, note: d.note || "", date: d.date,
      createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
      updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : Date.now(),
    };
    // the goal a saving went to (missing = the first goal); other types never carry one
    if (d.type === "saving" && typeof d.goalId === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(d.goalId)) out.goalId = d.goalId;
    // v3: the account it touches, a transfer's destination, and a split purchase's part
    const ID = /^[A-Za-z0-9_-]{1,32}$/;
    if (typeof d.account === "string" && ID.test(d.account)) out.account = d.account;
    if (d.type === "transfer" && typeof d.toAccount === "string" && ID.test(d.toAccount) && d.toAccount !== out.account) out.toAccount = d.toAccount;
    const p = d.plan;
    if (d.type === "expense" && p && typeof p.id === "string" && ID.test(p.id) && Number.isInteger(p.n) && Number.isInteger(p.of) && p.n >= 1 && p.n <= p.of && p.of >= 2 && p.of <= 36) out.plan = { id: p.id, n: p.n, of: p.of };
    if (d.example === true) out.example = true;
    return out;
  }

  const GOAL_ID = /^[A-Za-z0-9_-]{1,32}$/;
  // the user's first goal as app.js reads the document (v1 `goal` = "g_main"; not the example's): saving operations
  // without goalId belong to it
  function firstGoalId(s) {
    if (!s || typeof s !== "object") return null;
    if (s.example && typeof s.example === "object" && (s.example.goals || s.example.goal)) return null;
    const list = Array.isArray(s.goals) ? s.goals : s.goal && typeof s.goal === "object" ? [Object.assign({ id: "g_main" }, s.goal)] : [];
    const g = list.find(x => x && typeof x === "object" && typeof x.name === "string" && x.name.trim() && typeof x.target === "number" && x.target > 0);
    if (!g) return null;
    return typeof g.id === "string" && GOAL_ID.test(g.id) ? g.id : "g_main";
  }

  window.createBudgetStore = function createBudgetStore() {
    const snap = { status: "loading", tx: [], settings: null, readOnly: false };
    let onChange = () => {};
    let settingsRef = null, txCol = null, settingsQueue = Promise.resolve();
    let lastSettings = null;   // the settings as last written here or delivered, whichever came later
    const emit = () => onChange({ ...snap, tx: snap.tx.slice() });

    async function connect() {
      const [db, user] = await Promise.all([use("db"), use("user")]);
      let uid = null;
      if (db && user) { try { uid = await user.id(); } catch (e) { uid = null; } }
      if (!uid) { snap.status = "offline"; emit(); return; }
      settingsRef = db.doc(`data/users/${uid}/budget`);
      txCol = settingsRef.collection("tx");
      let gotS = false, gotT = false;
      const ready = () => { if (gotS && gotT) snap.status = "ready"; emit(); };
      const onErr = () => { snap.status = "offline"; emit(); };
      settingsRef.onSnapshot(s => { snap.settings = s.exists ? s.data() : null; lastSettings = snap.settings; gotS = true; ready(); }, onErr);
      txCol.onSnapshot(s => { snap.tx = s.docs.map(d => ({ ...d.data(), id: d.id })); gotT = true; ready(); }, onErr);
    }
    function need() { if (!txCol) throw fail("revoked"); }
    async function guarded(fn) {
      try { return await withRetry(fn); }
      catch (e) { if (e.code === "read_only") { snap.readOnly = true; emit(); } throw e; }
    }

    return {
      init(cb) { onChange = cb; setTimeout(emit, 0); connect(); },
      async saveTx(id, data) {
        need();
        const ref = id ? txCol.doc(id) : txCol.doc();
        await guarded(() => ref.set(txBody(data)));
        return ref.id;
      },
      async deleteTx(id) { need(); await guarded(() => txCol.doc(id).delete()); },
      async restoreTx(id, data) { need(); await guarded(() => txCol.doc(id).set(txBody(data))); },
      saveSettings(next) {
        need();
        const body = JSON.parse(JSON.stringify(next));
        const run = settingsQueue.then(async () => {             // one write at a time per document
          // The first goal stops being first (deleted, or moved): its savings without goalId get its id written
          // down first, so they stay with it (and come back with it on «Вернуть») instead of moving to the new first goal.
          const was = firstGoalId(lastSettings);
          if (was && firstGoalId(body) !== was) {
            for (const t of snap.tx.slice()) {
              if (t.type !== "saving" || t.example === true || (typeof t.goalId === "string" && GOAL_ID.test(t.goalId))) continue;
              const pinned = Object.assign({}, t, { goalId: was, updatedAt: Date.now() });
              await guarded(() => txCol.doc(t.id).set(txBody(pinned)));
            }
          }
          await guarded(() => settingsRef.set(body));
          lastSettings = body;
        });
        settingsQueue = run.catch(() => {});
        return run;
      },
      async deleteMany(ids, onProgress) {
        need();
        let done = 0;
        for (const id of ids) {
          await guarded(() => txCol.doc(id).delete());
          done++;
          if (onProgress) onProgress(done, ids.length);
        }
      },
    };
  };
})();
