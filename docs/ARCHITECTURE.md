# Architecture

One UI, two hosts:

| Target | Output | Storage | Notes |
|---|---|---|---|
| **PWA** (primary) | `dist/pwa/` → GitHub Pages | IndexedDB on the device, synced to the user's own Supabase project | installable on iPhone/iPad home screen, works offline |
| **claude.ai artifact** | `dist/artifact/budget.html` (single file) | artifact `db` capability (`window.claude.use("db")`) | no sync UI, no service worker |

`tools/build.mjs` assembles both targets from `src/`. No npm dependencies; Node ≥ 20.

## Source files and globals

Every `src/*.js` file is a classic script wrapped in its own IIFE (no modules, no bundler). It communicates only through these globals:

| File | Defines | Used by |
|---|---|---|
| `config.js` (repo root, PWA only) | `window.BUDGET_CONFIG = { supabaseUrl, supabaseAnonKey }` (empty strings when not set) | `store-pwa.js` |
| `public/vendor/supabase.js` (PWA only) | `window.supabase` (supabase-js v2 UMD, `createClient`) | `store-pwa.js` |
| `src/icons.js` | `window.BUDGET_ICONS = { Name: [[tag, attrs], …] }` (lucide subset, ISC) | `app.js`, `pwa.js` |
| `src/seed.js` (PWA only) | `window.BudgetSeed = { make(todayIso) → { settings, tx } }` | `store-pwa.js` |
| `src/store-artifact.js` / `src/store-pwa.js` | `window.createBudgetStore(opts) → Store` | `app.js` |
| `src/app.js` | `window.BudgetApp` (see below); reads `window.BUDGET_FEATURES = { pwa: boolean }` set by the build | `pwa.js` |
| `src/pwa.js` + `src/pwa.css` (PWA only) | sync/account dialog, backup, install banner, service-worker update toast | — |
| `src/sw.js` (PWA only) | service worker; the build replaces `"__BUILD_VERSION__"` and `__PRECACHE_LIST__` | — |

Script order in the PWA `index.html`: `config.js`, `vendor/supabase.js`, then one bundle `app.<hash>.js` = `icons.js + seed.js + store-pwa.js + app.js + pwa.js`.
Artifact: one inline `<script>` = `icons.js + store-artifact.js + app.js`.

## Data shapes (v2: Money honey)

Amounts are Israeli new shekels (₪, ILS), stored as plain numbers with 2 decimals; the currency is a UI concern only.

```ts
type TxType = "income" | "expense" | "saving";
interface Tx {               // what the UI sees
  id: string;                // ≤ 64 chars, [A-Za-z0-9_-]
  type: TxType;
  amount: number;            // > 0 and < 1e10, rounded to 2 decimals (shekels)
  category: string;          // ≤ 32 chars: a built-in id from CATS in app.js, a custom category id ("c_…"), "savings" for type "saving"
  goalId?: string;           // type "saving" only: the goal this money went to ([A-Za-z0-9_-]{1,32}); missing = the first goal
  note: string;              // ≤ 80 chars
  date: string;              // "YYYY-MM-DD", 1900-01-01 … 2199-12-31
  createdAt: number;         // ms epoch, ordering within a day
  updatedAt?: number;        // ms epoch
  example?: true;            // part of the example budget
}
interface Goal {
  id: string;                // [A-Za-z0-9_-]{1,32}, e.g. "g_k3x9q2"
  name: string;              // ≤ 60 chars
  target: number;            // > 0
  deadline: string;          // "" or "YYYY-MM-DD"
  initial: number;           // ≥ 0, saved before tracking started
  icon: string;              // lucide icon name from GOAL_ICONS in app.js
  createdAt: number;         // ms epoch, display order
}
interface CustomCategory {
  id: string;                // "c_" + [a-z0-9]{4,20}
  type: "income" | "expense";
  name: string;              // ≤ 32 chars
  icon: string;              // lucide icon name from PICKER_ICONS in app.js
  archived?: true;           // hidden from pickers, still shown on old operations
}
interface Settings {         // one document per user
  startBalance: number;      // may be negative
  goals: Goal[];             // ≤ 20, in display order
  limits: Record<string /* expense category id, built-in or custom */, number>;
  categories: CustomCategory[];   // ≤ 60
  example?: { startBalance?: true; goals?: true; limits?: true; categories?: true };   // fields still holding example values
}
// Legacy (v1) settings carry `goal: {name,target,deadline,initial} | null` instead of `goals`.
// Every reader migrates it: goals = goal ? [{ id: "g_main", icon: "Target", createdAt: 0, ...goal }] : [].
// Writers never write `goal` again. Saving operations without goalId belong to goals[0].
// The PWA store keeps a timestamp per settings field internally (startBalance, goals, limits, categories; see "Sync rules");
// the UI never sees it, and a `_ms` key handed to saveSettings() is ignored.
```

Server: `public.transactions` has a nullable `goal_id text` column (same charset/length as Goal.id); the client maps `goalId ↔ goal_id`.

## Store contract (both adapters)

```ts
interface Store {
  init(onChange: (snap: Snapshot) => void): void;   // start loading; call onChange on every change (async, never synchronously inside init)
  saveTx(id: string | null, data: Omit<Tx, "id">): Promise<string>;   // null id = create (adapter mints the id); resolves with the id
  deleteTx(id: string): Promise<void>;
  restoreTx(id: string, data: Omit<Tx, "id">): Promise<void>;          // undo of a delete: recreate under the same id
  saveSettings(next: Settings): Promise<void>;                         // full replacement
  deleteMany(ids: string[], onProgress?: (done: number, total: number) => void): Promise<void>;
  sync?: SyncApi;      // PWA only
  backup?: BackupApi;  // PWA only
}
interface Snapshot {
  status: "loading" | "ready" | "offline";   // "offline": no storage at all (artifact signed out / no db)
  tx: Tx[];                                  // live (non-deleted) transactions, any order
  settings: Settings | null;                 // null = never saved
  readOnly: boolean;
  sync?: SyncState;                          // PWA only
  notice?: string;                           // optional one-line warning to show (e.g. IndexedDB unavailable)
}
```

Rejections are `Error` objects with `code` ∈ `read_only | quota | rate | revoked | network | auth | invalid | unknown` and a user-facing Russian `message`. The UI shows `message` and switches to read-only on `read_only`.

## PWA sync contract (`store.sync`, `snap.sync`)

```ts
interface SyncState {
  available: boolean;      // supabase-js loaded
  configured: boolean;     // project URL + anon key known
  url: string;             // project URL ("" if none)
  configSource: "file" | "device" | "none";   // config.js or entered on this device
  user: { id: string; email: string } | null;
  phase: "off" | "idle" | "syncing" | "offline" | "error";   // "off" = not configured or signed out
  lastSyncAt: number | null;   // ms epoch of last fully successful push+pull
  pending: number;             // local changes not yet pushed
  error: string | null;        // Russian, user-facing
  recovery: boolean;           // password-recovery link opened: UI asks for a new password (updatePassword) or cancelRecovery()
  link: {                      // an e-mail link's session that was NOT adopted (another account than this device's, or none yet)
    type: "recovery"           //   held in memory only until updatePassword() succeeds or cancelRecovery(), then ended (recovery is true meanwhile)
        | "confirmed";         //   sign-up confirmation / magic link / e-mail change: checked and ended at once; tell the user
    email: string;             //   that the address is confirmed and to sign in (in the installed app). Cleared by signIn/signUp.
  } | null;
  pendingLink: "recovery" | "link" | null;   // an e-mail link waits in the URL hash, but this browser has no project config
                               // (iOS opens mail links in Safari, whose storage is separate from the Home Screen app's):
                               // the UI asks for the project URL and key once; configure() then handles the link
}
interface SyncApi {
  configure(cfg: { url: string; anonKey: string } | null): Promise<void>;   // null clears device config; handles a pending link
  signUp(email: string, password: string): Promise<{ needsConfirm: boolean }>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;                 // also wipes local data of that account from the device
  resetPassword(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;   // signed in, or through a held recovery link (snap.sync.link)
  cancelRecovery(): Promise<void>;          // keep the password: ends a held recovery link's session, clears `recovery` and `link`
  syncNow(): Promise<void>;
}
interface BackupApi {
  export(): { app: "budget"; version: 1; exportedAt: string; settings: Settings | null; tx: Tx[];
              settingsUpdatedAt?: number; settingsFieldsUpdatedAt?: { startBalance: number; goal: number; limits: number } };
  import(data: unknown): Promise<{ added: number; updated: number; skipped: number; settingsUpdated: boolean }>;
  // validates; newer record wins; settings merge field by field; example records and example settings fields are skipped;
  // a file without settingsUpdatedAt / settingsFieldsUpdatedAt (hand-made, other tools): its non-default settings fields
  // get stamp 1 — they replace examples, defaults and missing settings, never a value the user set (stamp > 1)
}
```

Sync rules (implemented in `store-pwa.js`, schema in `supabase/schema.sql`):
- Local-first: every write lands in IndexedDB first and resolves when the IndexedDB transaction completes; sync runs afterwards.
- Each local record carries `updatedMs` (client clock, strictly increasing per record), `dirty`, `deleted` (tombstone) and `localOnly` (example records that are never uploaded).
- Push: upsert dirty, non-`localOnly` records with `onConflict: "user_id,id"`. The server keeps the row with the larger `client_updated_ms` (BEFORE UPDATE trigger returns NULL for older writes).
- Pull: rows with `updated_at > cursor − 2 min`, ordered by `updated_at`, paged by 1000. Merge: remote wins unless the local copy is dirty and newer (`updatedMs > client_updated_ms`). Remote tombstones are stored even for ids the device never had, so a later backup import cannot bring a deleted record back.
- Settings merge per field (last writer wins for `startBalance`, `goal` and `limits` separately). Each local settings record has `fieldMs`; on the server the stamps travel inside the document as `data._ms = { startBalance, goal, limits, at }`, with `at` = the row's `client_updated_ms`. A row whose `_ms` is missing, malformed or has another `at` (written by an older app version) counts every field as changed at `client_updated_ms`. `saveSettings` stamps only the fields whose value changed; example values and values reset by «Удалить пример» carry 0, so they never beat a real value (at equal stamps a non-example value beats an example one). When the merged result differs from the server's row it stays dirty with `updatedMs` above both, so the union is pushed; the server stays whole-row LWW.
- Signing into an account that already has live non-example rows removes the local example records (settings fields still holding example values are reset to defaults).
- Sign-in after anonymous local use keeps local records and uploads them; settings fields left at their defaults get stamp 0 first, so they never override the account's values. Sign-in as a different user than last time wipes local data first.
- An example record edited into a real one (the UI drops `example`) is stored under a fresh id: example ids are the same on every device. Backup import skips example records and example settings fields.
- localStorage fallback data is migrated into IndexedDB on the next launch; its example records/settings are skipped when IndexedDB was already seeded, and settings are merged per field.
- Triggers: start-up, 1.5 s after a local write, `online`, `visibilitychange → visible`, every 60 s while visible, Supabase Realtime change events (debounced).
- supabase-js client: `flowType: "implicit"` (email links open in Safari, outside the installed app, so a PKCE verifier stored in the app would be missing), `persistSession`, `autoRefreshToken`, `detectSessionInUrl: false`, `storageKey: "budget-pwa-auth"`.
- E-mail links (`#access_token=…&type=…`) are read by the store, removed from the URL, and checked in a separate memory-only client (`persistSession: false`). The session is adopted only when its user id equals `meta.userId` (this device's own account; e.g. a password reset where the app is signed in). Any other account is never adopted, so a crafted link cannot sign the app into a stranger's account, upload this device's data there or wipe unsynced changes: a `type=recovery` session is kept only for `updatePassword()` and then signed out (`scope: "local"`); any other link is signed out at once and reported as `snap.sync.link = { type: "confirmed" }`. Local data and `meta.userId` are untouched. `cancelRecovery()` drops a held recovery link without changing the password (the UI offers «Отмена», so a link nobody here asked for cannot lock the dialog in the password form). The UI pre-fills a link's e-mail into the sign-in form only when this browser asked for a link to that address (sign-up or password reset in the last 7 days, `localStorage["budget-pwa-mail-asked"]`): a link someone else sent names their account. Without a project config the hash stays in place and `snap.sync.pendingLink` is set. `#error=…` links set `error`.
- Start-up while offline: when `getSession()` has no session because the expired token cannot be refreshed (offline / retryable error), the stored session of this device's account (`localStorage["budget-pwa-auth"]`) keeps it signed in with phase `offline`; supabase-js refreshes it once online.

## `window.BudgetApp` (exposed by `app.js` for `pwa.js`)

```ts
interface BudgetApp {
  store: Store;
  icon(name: string): string;                 // inline SVG markup for a lucide icon in BUDGET_ICONS
  hydrateIcons(root?: ParentNode): void;      // replaces [data-icon] placeholders
  esc(s: unknown): string;                    // HTML escape
  money(v: number, opts?: { sign?: boolean; round?: boolean }): string;
  toast(msg: string, action?: { label: string; run: () => void }): void;
  enhanceDialog(dlg: HTMLDialogElement): void;   // backdrop close, data-close buttons, iOS keyboard/save behaviour, scroll lock
  onSnapshot(cb: (snap: Snapshot) => void): () => void;   // called after every render
}
```

PWA mount points in `src/app.html`: `#pwaTop` (inside the top bar, before the month switcher) and `#pwaBanner` (directly after `#notice`).

## Learning section (`src/lessons.js`, `src/learn.js`, `src/learn.css`; both targets)

- `lessons.js` defines `window.MH_LESSONS = Lesson[]` (pure data, Russian):
  `{ id, title, summary, minutes, icon, track: "basics" | "israel" | "app", sections: [{ h?, p: string[] , list?: string[] }], takeaways: string[], quiz: [{ q, options: string[], correct: number, explain }], tryIt?: { label, action: "tx" | "saving" | "limits" | "goal" | "categories" | "start" }, sources: [{ title, url }] }`.
  Text is plain (no HTML); renderers escape it.
- `learn.js` defines `window.BudgetLearn = { mount(el, api) }`. `app.js` calls it once, the first time the «Обучение» view opens, with `el = #viewLearn` and `api = BudgetApp` (which also exposes `actions` below).
- Lesson progress is per device: `localStorage["mh-learn"]` (every access wrapped in try/catch; the section must work without it).

`BudgetApp.actions` (exposed by `app.js`): `{ setView(name: "budget" | "goals" | "learn"), openTx(preset?: { type?, category?, goalId? }), openLimits(), openGoal(goalId?: string | null), openCategories(), openStart() }`.

## Styling rules

All colours are tokens defined on bare `:root` in `src/app.css` and redefined in both dark blocks (`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and `:root[data-theme="dark"] {…}`). Component rules never use literal one-theme colours. Reuse the existing classes: `.btn .btn-primary .btn-ghost .btn-quiet .btn-danger .btn-sm`, `.icon-btn`, `.notice`, `dialog > form.dlg > .dlg-head / .field / .input / .money-input / .hint / .err / .dlg-foot`, `.seg`, `.status.is-good|.is-warn`. Text inputs are ≥ 16px (iOS zoom). Touch targets ≥ 44px under `(pointer: coarse)`.
