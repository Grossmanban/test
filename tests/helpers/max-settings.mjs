// The largest settings document the app can produce (docs/ARCHITECTURE.md, Settings v2 + v3): 20 goals, 60 custom
// categories, 100 limits, 20 accounts and a default account, every string at its length cap in 3-byte UTF-8
// characters (₪: Cyrillic letters take 2 bytes, an emoji 4 bytes for 2 UTF-16 units, so ₪ is the worst case), every
// id at the longest the store accepts, every number at its longest. Used by tests/store-pwa.test.mjs (store + fake
// server) and tests/schema/run.sh (real Postgres), so both check the same document against the size limit.
//
//   node tests/helpers/max-settings.mjs   → prints { doc, wire, wireBytes, docBytes, stampBytes } as JSON
//   (wire = doc plus the largest stamps the store adds when it pushes: data._ms (field stamps of the v2 fields, entry
//    stamps and tombstones of goals and categories) and data._ms3 (the same for accounts and defaultAccount);
//    wireBytes = octet_length(wire::jsonb::text); stampBytes = wireBytes − docBytes, what the stamps add to any document)
import { pgJsonBytes } from "./fake-supabase.mjs";

const ID = "abcdefghijklmnopqrstuvwxyz0123456789";
const pick = (i, n) => Array.from({ length: n }, (_, k) => ID[(i * 7 + k * 13) % ID.length]).join("");
const BIG = 9999999999.99;
const TS = 8.64e15;                 // the largest ms epoch (Date max)
// the most entries and tombstones the store keeps (src/store-pwa.js: MAX_GOALS, MAX_CATEGORIES, MAX_ACCOUNTS, MAX_GONE)
export const MAX_GONE = 30;
export const MAX_ACCOUNTS = 20;
const accountId = i => "a_" + String(i).padStart(2, "0") + pick(i + 20, 28);   // 32 chars: "a_" + 30, the longest accepted

export function maxSettings() {
  const goals = Array.from({ length: 20 }, (_, i) => ({
    id: "g_" + String(i).padStart(2, "0") + pick(i, 28),          // 32 chars
    name: "₪".repeat(60),
    target: BIG, deadline: "2199-12-31", initial: BIG,
    icon: "I".repeat(40),
    createdAt: TS,
  }));
  const categories = Array.from({ length: 60 }, (_, i) => ({
    id: "c_" + String(i).padStart(2, "0") + pick(i, 18),          // "c_" + 20
    type: "expense",
    name: "₪".repeat(32),
    icon: "I".repeat(40),
    archived: true,
  }));
  const limits = {};
  for (let i = 0; i < 100; i++) limits["L" + String(i).padStart(2, "0") + pick(i, 29)] = BIG;   // 32-char keys
  // v3: cards carry every optional field (billingDay, payFrom, creditLimit), so 20 cards are the largest list
  const accounts = Array.from({ length: MAX_ACCOUNTS }, (_, i) => ({
    id: accountId(i),
    kind: "card",
    name: "₪".repeat(40),
    icon: "I".repeat(40),
    opening: -BIG,
    billingDay: 28,
    payFrom: accountId((i + 1) % MAX_ACCOUNTS),
    creditLimit: BIG,
    archived: true,
    createdAt: TS,
  }));
  return {
    startBalance: -BIG, goals, limits, categories, accounts, defaultAccount: accounts[0].id,
    example: { startBalance: true, goals: true, limits: true, categories: true, accounts: true },
  };
}
// stamps as the store pushes them at their largest: field stamps, a stamp for every goal, category and account,
// MAX_GONE tombstones per list with ids at their length cap
export function maxSettingsWire(at = TS) {
  const doc = maxSettings();
  const gone = (prefix, len) => Object.fromEntries(Array.from({ length: MAX_GONE }, (_, i) =>
    [prefix + String(i).padStart(2, "0") + pick(i + 50, len - prefix.length - 2), at]));
  const items = {
    goals: { since: at, ms: Object.fromEntries(doc.goals.map(g => [g.id, at])), gone: gone("g_z", 32) },
    categories: { since: at, ms: Object.fromEntries(doc.categories.map(c => [c.id, at])), gone: gone("c_z", 22) },
  };
  const accounts = { since: at, ms: Object.fromEntries(doc.accounts.map(a => [a.id, at])), gone: gone("a_z", 32) };
  return {
    ...doc,
    _ms: { startBalance: at, goals: at, limits: at, categories: at, at, items },
    _ms3: { accounts: at, defaultAccount: at, at, items: { accounts }, example: true },
  };
}
// bytes the stamps (_ms and _ms3) add to a document, at their largest
export const stampBytes = () => pgJsonBytes(maxSettingsWire()) - pgJsonBytes(maxSettings());

if (import.meta.url === `file://${process.argv[1]}`) {
  const wire = maxSettingsWire();
  const doc = maxSettings();
  process.stdout.write(JSON.stringify({ doc, wire, wireBytes: pgJsonBytes(wire), docBytes: pgJsonBytes(doc), stampBytes: stampBytes() }));
}
