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
// The PWA store keeps a timestamp per settings field internally (startBalance, goals, limits, categories, v3: accounts,
// defaultAccount) and per goal / category / account (see "Sync rules"); the UI never sees them, and `_ms` / `_ms3` keys
// handed to saveSettings() are ignored.
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
interface EntryStamps {        // per list: when each entry was added or last changed, tombstones of deleted ones
  since: number;               // the list holds every entry changed before `since`
  ms: Record<string, number>;  // entry id → stamp
  gone: Record<string, number>;   // deleted entry id → stamp (at most 30, the newest)
}
interface BackupApi {
  export(): { app: "budget"; version: 3; exportedAt: string; settings: Settings | null;
              tx: Tx[];             // tx keep goalId, account, toAccount, plan
              settingsUpdatedAt?: number;
              settingsFieldsUpdatedAt?: { startBalance: number; goals: number; limits: number; categories: number;
                                          accounts: number; defaultAccount: number };
              settingsItemsUpdatedAt?: { goals: EntryStamps; categories: EntryStamps; accounts: EntryStamps } };
  import(data: unknown): Promise<{ added: number; updated: number; skipped: number; settingsUpdated: boolean }>;
  // validates; newer record wins; settings merge field by field, goals / categories / accounts entry by entry
  // (settingsItemsUpdatedAt; a file without it counts each list as a whole at its field stamp); example records and
  // example settings fields are skipped; a file without settingsUpdatedAt / settingsFieldsUpdatedAt (hand-made, other
  // tools): its non-default settings fields get stamp 1 — they replace examples, defaults and missing settings, never a
  // value the user set (stamp > 1); such a list only fills an example, empty or missing list.
  // Files of versions 1 and 2 import too: v1 `goal` → `goals`, settingsFieldsUpdatedAt.goal stamps goals; a field the
  // file does not hold (categories in v1, accounts / defaultAccount in v1 and v2) is left as it is. A v3 file leaves
  // accounts / defaultAccount out once they were cleared but stamps them: the clearing imports like any change.
  // A v2 file may still hold accounts / defaultAccount with the `_ms3` of the server row the v2 app carried them from:
  // they are stamped from that `_ms3` (fields and entries), never from settingsUpdatedAt. Operations of a v1 / v2 file
  // say nothing about account / toAccount / plan: an imported one keeps this device's (as far as its type allows), is
  // marked `legacy` and the next pull reads every row again (`meta.fullPull`), so one this device did not hold takes
  // the server's (see "Update from the v2 store") instead of clearing them on the server.
  // A transfer without two different valid accounts makes the file invalid (like any broken operation).
  // Version > 3: "made by a newer version" error (a v2 app says the same about a v3 file, so it never half-imports
  // one: it would drop transfers, accounts and the account of every operation).
}
```

Sync rules (implemented in `store-pwa.js`, schema in `supabase/schema.sql`):
- Local-first: every write lands in IndexedDB first and resolves when the IndexedDB transaction completes; sync runs afterwards.
- Each local record carries `updatedMs` (client clock, strictly increasing per record), `dirty`, `deleted` (tombstone) and `localOnly` (example records that are never uploaded).
- Push: upsert dirty, non-`localOnly` records with `onConflict: "user_id,id"`. The server keeps the row with the larger `client_updated_ms` (BEFORE UPDATE trigger returns NULL for older writes). `goal_id` and the v3 columns `account`, `to_account`, `plan_id`, `plan_n`, `plan_of` are always sent (`null` when the record has none), so moving a saving back to the first goal, an operation back to the default account or a split part into an income clears them on the server. A project whose `schema.sql` predates v2 / v3 answers PGRST204 or 42703 (a column is missing), or 23514 on `transactions_type_valid` (its type check does not know `'transfer'`): the sync error is «Обновите базу: выполните supabase/schema.sql ещё раз (SQL Editor в Supabase). …», phase `error`. The whole chunk is refused, so nothing is marked synced and every change stays dirty on the device; there is no extra retry (the next write, `online`, `visibilitychange`, the 60 s timer or «Синхронизировать» tries again, once).
- What the store accepts (UI, server rows, backups): `goalId` only on `saving` records and only as `[A-Za-z0-9_-]{1,32}`, otherwise dropped silently; v3 values are dropped silently exactly like `store-artifact.js` `txBody` does: `account` (any type) and `toAccount` (transfers only, ≠ `account`) only as `[A-Za-z0-9_-]{1,32}`, `plan` only on expenses and only whole (`id` as above, integers 1 ≤ `n` ≤ `of` ≤ 36) — plus `of` ≥ 2, which the server requires (`txBody` still keeps a plan of one part). A transfer that is left without a valid `account` and a different valid `toAccount` is refused (`saveTx` / `restoreTx` reject with code `invalid`, a backup file is invalid): the server would refuse it and block every later push. Server rows are taken as they come (a transfer row without accounts is kept and shown as the default account's; it cannot pass the v3 schema's checks anyway). Text (notes, names) loses NUL characters and unpaired UTF-16 surrogates, and is cut without splitting an emoji (Postgres refuses both, which would block the sync). Settings: invalid goals / categories / accounts / limits entries are dropped one by one (goal: id, non-empty name, 0 < target < 1e10, deadline "" or a date, initial ≥ 0; category: id `c_[a-z0-9]{4,20}`, type income/expense, non-empty name; account: id `a_[A-Za-z0-9_-]{1,30}` (the app mints `a_[a-z0-9]{2,20}`; `a_main` is accepted), kind bank/cash/wallet/card, non-empty name, |opening| < 1e10 (missing = 0); on cards only, each dropped alone when invalid: `billingDay` integer 1–28, `payFrom` an account id other than its own, `creditLimit` > 0; `archived` only as `true`; unknown keys of an entry are dropped; limit: key `[A-Za-z0-9_-]{1,32}`, value > 0), duplicate ids after the first are dropped, at most 20 goals / 60 categories / 20 accounts / 100 limits (the first ones are kept), a missing or malformed icon becomes `Target` (goal) / `Tag` (category) / the kind's icon (account: Landmark, Banknote, Smartphone, CreditCard), names are trimmed and cut to 60 / 32 / 40. `defaultAccount` is kept only as an account id (otherwise dropped). `accounts` and `defaultAccount` are left out of the document while empty, so a budget without accounts keeps the v2 shape; `startBalance` is stored as given (the app keeps it equal to the net opening of the accounts for v2 clients). `saveSettings` and backup import reject a field of the wrong type (goals / categories / accounts not an array, …) and a document over 55 000 bytes as the server measures it (`octet_length(data::text)`, server limit 65 536). The stamps the store adds when it pushes (`_ms` and `_ms3`, at most 20 goals, 60 categories and 20 accounts with a stamp each and 30 tombstones per list, all ids and stamps at their longest) take at most 9 829 bytes, so every accepted document fits: 55 000 + 9 829 = 64 829. The largest document of known fields (`tests/helpers/max-settings.mjs`: every list full, every string at its cap in 3-byte characters, 20 cards with every optional field) is 35 423 bytes, 45 252 with its largest stamps; the rest of the cap is room for fields of newer versions.
- Pull: rows with `updated_at > cursor − 2 min`, ordered by `updated_at`, paged by 1000. Merge: remote wins unless the local copy is dirty and newer (`updatedMs > client_updated_ms`). Remote tombstones are stored even for ids the device never had, so a later backup import cannot bring a deleted record back.
- Settings merge per field: last writer wins for `startBalance`, `limits` and `defaultAccount`, each on its own. `goals`, `categories` and `accounts` merge entry by entry: every goal, category and account comes from the side that changed it last, and a deleted one stays deleted, so two devices adding different goals (or accounts) offline both keep them, and a stale device cannot bring a deleted one back (an edit made after the delete does). Each side keeps, per list, `{ since, ms: { id: stamp }, gone: { id: stamp } }`: `ms` when each entry was added or last changed; `gone` tombstones of deleted entries, at most 30 (the newest; dropping older ones raises `since`); `since`: the list holds every entry changed before it, so an entry it does not hold that is older was deleted. Order: when one list holds every entry of the result, its order (the later list first); otherwise the entries already in place (the server's row, the device's settings) in their order, then the other side's additions; at most 20 goals / 60 categories / 20 accounts (the first ones). When the merged accounts match neither side's list (e.g. two devices added different accounts offline), `startBalance` becomes their net opening (stamped no older than the accounts), so v2 clients still show the right total. A list without entry stamps (older app versions, v1 data, backups made before them) counts as a whole: every entry stamped with the field's stamp and `since` = the field's stamp, i.e. "the later list wins" for entries older than it. Example lists never merge entry by entry (they carry 0 and lose as a whole). Each local settings record has `fieldMs` and `items` (entry stamps); on the server the stamps travel inside the document as `data._ms = { startBalance, goals, limits, categories, at, items: { goals, categories } }`, with `at` = the row's `client_updated_ms`, and — for the v3 fields — `data._ms3 = { accounts, defaultAccount, at, items: { accounts }, example? }` (left out while there is nothing to say: no accounts ever). A row whose `_ms` is missing or has another `at` (written by an older app version) counts every v2 field it holds as changed at `client_updated_ms`; with a matching `at`, a field without a valid stamp of its own (carried along by a version that does not know it) counts as changed at `client_updated_ms`, and a field the document does not hold at all (categories in a v1 row, accounts in a v2 row) gets 0 (it says nothing about it). `_ms3` has an `at` of its own and is trusted whenever 0 ≤ `at` ≤ the row's `client_updated_ms`: the v2 store rebuilds `_ms` on every push but keeps fields it does not know as they are, so a v2 client that merges a v3 row carries `accounts`, `defaultAccount` and `_ms3` along together, and `_ms3` still describes exactly those values (a v2 rewrite therefore never makes a v3 device lose an account it added offline). A stamp in `_ms3` for a field the document leaves out means it was cleared then; `_ms3.example` keeps the example flag of the accounts, which the v2 store drops. A row holding accounts but no trusted `_ms3` counts them as a whole at `client_updated_ms`. The default account has no example flag of its own: it is the example's while the accounts are. v1 data is migrated wherever it is read (IndexedDB record, server row, backup file, localStorage fallback): `goal` → `goals` (see Data shapes) and the v1 stamp `goal` (`fieldMs.goal`, `_ms.goal`, `settingsFieldsUpdatedAt.goal`) becomes the stamp of `goals`; `example.goal` becomes `example.goals`. A v1 row is not rewritten just because it was read; the next push writes v2 without `goal` (a v1 app that still writes `goal` next to `goals` is ignored for goals). `saveSettings` stamps only the fields and entries whose value changed (removed entries get a tombstone); example values and values reset by «Удалить пример» carry 0, so they never beat a real value (at equal stamps a non-example value beats an example one). When the merged result differs from the server's row it stays dirty with `updatedMs` above both, so the union is pushed; the server stays whole-row LWW.
- Saving operations without `goalId` belong to the first goal. When a `saveSettings` makes the first goal stop being first (deleted, or moved), and at sign-in after anonymous use (this device's goals then join after the account's), its savings without `goalId` get its id written down (`pinSavings`, in the same IndexedDB transaction as the settings), so they stay with it (and come back with it on «Вернуть») instead of moving to whichever goal is first now. Example records, savings with a goalId and other types are not touched; nothing is rewritten while the first goal stays. (`store-artifact.js` does the same before it writes the settings.)
- Signing into an account that already has live non-example rows removes the local example records (settings fields still holding example values are reset to defaults).
- Sign-in after anonymous local use keeps local records and uploads them; settings fields left at their defaults get stamp 0 first, so they never override the account's values, and this device's goals, categories and accounts join the account's entry by entry (with `since` 0 and no tombstones: what was deleted or never held here says nothing about the account's entries; the account's entries come first). v3: what app.js writes out by itself with the first account counts as a default too: `defaultAccount` `"a_main"` and an `a_main` account without an opening get stamp 0 (`a_main` has the same id on every device, so this device's copy never replaces the account's name and opening). In the first settings merge after such a sign-in, an account whose document never held accounts (v2, or v3 before its first account) joins with its implicit `a_main` (opening = its `startBalance`, stamped like it), so its start balance is kept; `startBalance` becomes the net opening of the merged accounts (see "Settings merge"). Sign-in as a different user than last time wipes local data first.
- Update from the v2 store (`meta.version` < 3 in IndexedDB): the v2 store skipped transfer rows, dropped `account` / `to_account` / `plan_*` of the rows it pulled, and its cursors are past them. On the first start of v3 the next pull reads every transaction row and the settings row again (`meta.fullPull`; no example removal, unlike a first sign-in), and a clean record whose server row is the same version but differs is replaced. Until that pull is done every synced record is a copy without the v3 fields: all of them are marked `legacy`, also when they are edited or deleted in v3 meanwhile (the UI shows them on the default account, without a plan). A `legacy` record that is newer than its server row (a v2 change not pushed yet, or a v3 edit before the full pull) takes `account` (and `plan` where its type allows) from the server's row in that pull, so the push, which sends every column, does not clear them; a record turned into a transfer meanwhile keeps the accounts chosen then. The pull ends by removing every mark. The upgrade write (marks, `fullPull`, `meta.version`) is done at start-up; when it fails (a full disk) the data is shown as it is (no fallback to memory) and every sync does it first, so nothing is pulled or pushed before it.
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

## Accounts, transfers, cards and installments (v3)

Money lives in user-defined **accounts**. Every operation says which account it touches; moving money
between accounts is a **transfer**, which is neither income nor expense. Credit cards are accounts whose
balance is a debt that the linked bank account pays off on the card's billing day.

```ts
type AccountKind = "bank" | "cash" | "wallet" | "card";   // wallet = Bit, PayBox or any e-wallet that can hold money
interface Account {
  id: string;            // "a_" + [a-z0-9]{2,20}; the implicit default account is "a_main"
  kind: AccountKind;
  name: string;          // ≤ 40, free text: "Леуми", "Наличные", "PayBox", "Max", "Isracard"…
  icon: string;          // lucide name from ACCOUNT_ICONS in app.js
  opening: number;       // balance when tracking started; for a card: the debt at that moment (≥ 0, owed)
  billingDay?: number;   // card only: 1–28, day the card is charged to payFrom (מועד חיוב)
  payFrom?: string;      // card only: id of the account the card bill is debited from
  creditLimit?: number;  // card only, optional
  archived?: true;       // hidden from pickers, still shown on old operations
  createdAt: number;
}
// Settings v3 adds:
//   accounts: Account[]                       (≤ 20; display order)
//   defaultAccount?: string                   (id used when an operation has no account)
//   example.accounts?: true                   (the example's accounts; defaultAccount counts as the example's with them)
// Both are left out while unset (a budget without accounts keeps the v2 document shape).
// Migration v2 → v3: with no accounts the app behaves as if
//   accounts = [{ id: "a_main", kind: "bank", name: "Основной счёт", icon: "Landmark", opening: startBalance }].
// Writers that create the first real account write that a_main record explicitly (opening = startBalance) and
// keep `startBalance` equal to the net opening of all accounts (non-card openings minus card openings) so v2
// clients still show the right total.

type TxType = "income" | "expense" | "saving" | "transfer";
interface Tx {               // additions to v2
  account?: string;          // income/expense/saving: the account; transfer: the source. Missing = defaultAccount or "a_main"
  toAccount?: string;        // transfer only: the destination (≠ account)
  plan?: { id: string; n: number; of: number };   // installment n of `of` (2–36) of one split purchase, id shared by its parts
}
// Transfers use category "transfer". A card bill payment is a transfer payFrom → card.
// Installments («сплит», תשלומים): a split purchase of total T into N parts is stored as N expense records on the
// card, amounts T/N rounded to agorot (the last part takes the remainder), dated on the purchase day and then the
// same day of the following months (clamped to month end). Future-dated parts are obligations: they count in
// their month's budget and in the card debt only once their date arrives.
```

Server (`supabase/schema.sql`, re-run on an existing project to upgrade it): `public.transactions` gains nullable
`account text`, `to_account text`, `plan_id text`, `plan_n smallint`, `plan_of smallint` (existing rows get NULL: the
default account, not a transfer, not a split part); `type` also allows `'transfer'`. Checks (NULL passes, as in every
Postgres CHECK): `account`, `to_account`, `plan_id` match `^[A-Za-z0-9_-]{1,32}$`; `to_account` only on `'transfer'`
rows; a live (not deleted) transfer needs `account` and `to_account`, different; `plan_id`, `plan_n`, `plan_of` are
set together or not at all, with 2 ≤ `plan_of` ≤ 36 and 1 ≤ `plan_n` ≤ `plan_of`; a plan only on `'expense'` rows.
The PWA store maps `account ↔ account`, `toAccount ↔ to_account`, `plan ↔ plan_id / plan_n / plan_of` (see "Sync rules"
for what it accepts and how it reacts to a project still on the v2 schema). Settings: `accounts` merge entry by entry
like goals and categories, `defaultAccount` per field; their stamps travel in `data._ms3`.

Clients of v2 (the deployed `store-pwa.js` of v2 keeps running until the app updates). What they do with v3 data:
- Transfer rows: the v2 store does not take rows of an unknown type, so it never shows, stores, edits or deletes a
  transfer (a deleted transfer is stored as a tombstone, never shown). Its cursor moves past them.
- Rows with `account` / `plan_*`: it shows them without those fields. Its upserts name only the columns it knows, and an
  update (`INSERT … ON CONFLICT DO UPDATE`) sets only the columns it names, so its edits and deletes keep `account`,
  `to_account` and the plan on the server. Nothing in its normal sync deletes rows or clears these columns.
- Settings: it keeps fields it does not know (`accounts`, `defaultAccount`, `_ms3`) when it merges a server row and
  pushes them back unchanged (with `_ms3`, so v3 merges stay exact). The deployed v2 app saves its settings as a
  document of the four fields it knows, so its local copy loses them; but every v2 sync pulls the current settings row
  first (its cursor is that row's `updated_at` and it reads from cursor − 2 min) and merges it into the dirty local
  copy, so what it pushes still holds the server's `accounts`, `defaultAccount` and `_ms3`. Should a v2 client ever
  push a document without them (a row its pull did not return), v3 devices treat the missing fields as unknown
  (stamp 0), keep their own copy and push it back on their next sync.
Known limitations, until that device updates to v3:
- A v2 edit that changes the type of a split part (e.g. expense → income), or an edit or delete of a record a v3
  device has since turned into a transfer (the v2 device keeps its old copy: it skips the transfer row), leaves `plan_*` /
  `to_account` on the server row, which the checks refuse: that v2 device shows «Сервер отклонил данные…» and keeps
  its pending changes (the whole chunk) on the device. Once it updates, v3 pushes the record with every column
  (`plan_*` / `to_account` null) and the sync goes through.
- A v2 device that edited a v3 row and could not push before updating, or whose user edits it in v3 before the first
  (full) pull: handled by the v3 upgrade (legacy records take `account` / `plan` from the server row, see "Sync rules").
- A v2 backup holds no transfers and no `account` / `toAccount` / `plan` of operations; importing it keeps this
  device's (or the server's) values. It may hold `accounts`, `defaultAccount` and `_ms3` the v2 app carried along from
  the account's settings row: they are stamped from that `_ms3`, so an account deleted since does not come back. A v2
  app refuses a v3 backup ("made by a newer version").

Balances (UI): account balance = opening (card: −opening) + incomes − expenses − savings − transfers out + transfers in,
counting operations dated ≤ the cut-off. A card's balance is negative while money is owed. «Деньги» = sum of
non-card balances; «Долг по картам» = −sum of card balances; the headline balance stays the net total (as in v2).
Card cycle: the charge on billingDay of month M covers card operations dated from billingDay of month M−1 up to the
day before billingDay of month M; on or after the billing day the app proposes the transfer payFrom → card for that
amount (editable, since real cut-offs differ by issuer); anything not paid stays as debt.

## Learning section (`src/lessons.js`, `src/learn.js`, `src/learn.css`; both targets)

- `lessons.js` defines `window.MH_LESSONS = Lesson[]` (pure data, Russian):
  `{ id, title, summary, minutes, icon, track: "basics" | "israel" | "app", sections: [{ h?, p: string[] , list?: string[] }], takeaways: string[], quiz: [{ q, options: string[], correct: number, explain }], tryIt?: { label, action: "tx" | "saving" | "limits" | "goal" | "categories" | "start" }, sources: [{ title, url }] }`.
  Text is plain (no HTML); renderers escape it.
- `learn.js` defines `window.BudgetLearn = { mount(el, api) }`. `app.js` calls it once, the first time the «Обучение» view opens, with `el = #viewLearn` and `api = BudgetApp` (which also exposes `actions` below).
- Lesson progress is per device: `localStorage["mh-learn"]` (every access wrapped in try/catch; the section must work without it).

`BudgetApp.actions` (exposed by `app.js`): `{ setView(name: "budget" | "goals" | "learn"), openTx(preset?: { type?, category?, goalId? }), openLimits(), openGoal(goalId?: string | null), openCategories(), openStart() }`.

## Styling rules

All colours are tokens defined on bare `:root` in `src/app.css` and redefined in both dark blocks (`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and `:root[data-theme="dark"] {…}`). Component rules never use literal one-theme colours. Reuse the existing classes: `.btn .btn-primary .btn-ghost .btn-quiet .btn-danger .btn-sm`, `.icon-btn`, `.notice`, `dialog > form.dlg > .dlg-head / .field / .input / .money-input / .hint / .err / .dlg-foot`, `.seg`, `.status.is-good|.is-warn`. Text inputs are ≥ 16px (iOS zoom). Touch targets ≥ 44px under `(pointer: coarse)`.
