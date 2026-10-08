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

## Data shapes

```ts
type TxType = "income" | "expense" | "saving";
interface Tx {               // what the UI sees
  id: string;                // ≤ 64 chars, [A-Za-z0-9_-]
  type: TxType;
  amount: number;            // > 0, rounded to 2 decimals (rubles)
  category: string;          // ids from CATS in app.js; "savings" for type "saving"
  note: string;              // ≤ 80 chars
  date: string;              // "YYYY-MM-DD"
  createdAt: number;         // ms epoch, ordering within a day
  updatedAt?: number;        // ms epoch
  example?: true;            // part of the example budget
}
interface Settings {         // one document per user
  startBalance: number;      // may be negative
  goal: { name: string; target: number; deadline: string /* "" or YYYY-MM-DD */; initial: number } | null;
  limits: Record<string /* expense category id */, number>;
  example?: { startBalance?: true; goal?: true; limits?: true };   // fields still holding example values
}
```

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
  recovery: boolean;           // password-recovery link opened: UI must ask for a new password
}
interface SyncApi {
  configure(cfg: { url: string; anonKey: string } | null): Promise<void>;   // null clears device config
  signUp(email: string, password: string): Promise<{ needsConfirm: boolean }>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;                 // also wipes local data of that account from the device
  resetPassword(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  syncNow(): Promise<void>;
}
interface BackupApi {
  export(): { app: "budget"; version: 1; exportedAt: string; settings: Settings | null; tx: Tx[] };
  import(data: unknown): Promise<{ added: number; updated: number; skipped: number }>;   // validates; newer record wins
}
```

Sync rules (implemented in `store-pwa.js`, schema in `supabase/schema.sql`):
- Local-first: every write lands in IndexedDB first and resolves when the IndexedDB transaction completes; sync runs afterwards.
- Each local record carries `updatedMs` (client clock, strictly increasing per record), `dirty`, `deleted` (tombstone) and `localOnly` (example records that are never uploaded).
- Push: upsert dirty, non-`localOnly` records with `onConflict: "user_id,id"`. The server keeps the row with the larger `client_updated_ms` (BEFORE UPDATE trigger returns NULL for older writes).
- Pull: rows with `updated_at > cursor − 2 min`, ordered by `updated_at`, paged by 1000. Merge: remote wins unless the local copy is dirty and newer (`updatedMs > client_updated_ms`).
- Signing into an account that already has live non-example rows removes the local example records.
- Sign-in after anonymous local use keeps local records and uploads them. Sign-in as a different user than last time wipes local data first.
- Triggers: start-up, 1.5 s after a local write, `online`, `visibilitychange → visible`, every 60 s while visible, Supabase Realtime change events (debounced).
- supabase-js client: `flowType: "implicit"` (email links open in Safari, outside the installed app, so a PKCE verifier stored in the app would be missing), `persistSession`, `autoRefreshToken`, `detectSessionInUrl`, `storageKey: "budget-pwa-auth"`.

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

## Styling rules

All colours are tokens defined on bare `:root` in `src/app.css` and redefined in both dark blocks (`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and `:root[data-theme="dark"] {…}`). Component rules never use literal one-theme colours. Reuse the existing classes: `.btn .btn-primary .btn-ghost .btn-quiet .btn-danger .btn-sm`, `.icon-btn`, `.notice`, `dialog > form.dlg > .dlg-head / .field / .input / .money-input / .hint / .err / .dlg-foot`, `.seg`, `.status.is-good|.is-warn`. Text inputs are ≥ 16px (iOS zoom). Touch targets ≥ 44px under `(pointer: coarse)`.
