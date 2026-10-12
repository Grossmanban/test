// The largest settings document the app can produce (docs/ARCHITECTURE.md, Settings v2): 20 goals, 60 custom
// categories and 100 limits, every string at its length cap in 3-byte UTF-8 characters (₪), every number at its
// longest. Used by tests/store-pwa.test.mjs (store + fake server) and tests/schema/run.sh (real Postgres), so both
// check the same document against the size limit.
//
//   node tests/helpers/max-settings.mjs   → prints { doc, wire, wireBytes } as JSON
//   (wire = doc plus the largest _ms the store adds when it pushes: field stamps, entry stamps, tombstones;
//    wireBytes = octet_length(wire::jsonb::text))
import { pgJsonBytes } from "./fake-supabase.mjs";

const ID = "abcdefghijklmnopqrstuvwxyz0123456789";
const pick = (i, n) => Array.from({ length: n }, (_, k) => ID[(i * 7 + k * 13) % ID.length]).join("");
const BIG = 9999999999.99;
const TS = 8.64e15;                 // the largest ms epoch (Date max)

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
  return {
    startBalance: -BIG, goals, limits, categories,
    example: { startBalance: true, goals: true, limits: true, categories: true },
  };
}
// the most tombstones the store keeps per list (MAX_GONE in src/store-pwa.js)
export const MAX_GONE = 30;
// _ms as the store pushes it at its largest: field stamps, a stamp for every goal and category, MAX_GONE tombstones
// per list with ids at their length cap
export function maxSettingsWire(at = TS) {
  const doc = maxSettings();
  const gone = (prefix, len) => Object.fromEntries(Array.from({ length: MAX_GONE }, (_, i) =>
    [prefix + String(i).padStart(2, "0") + pick(i + 50, len - prefix.length - 2), at]));
  const items = {
    goals: { since: at, ms: Object.fromEntries(doc.goals.map(g => [g.id, at])), gone: gone("g_z", 32) },
    categories: { since: at, ms: Object.fromEntries(doc.categories.map(c => [c.id, at])), gone: gone("c_z", 22) },
  };
  return { ...doc, _ms: { startBalance: at, goals: at, limits: at, categories: at, at, items } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wire = maxSettingsWire();
  process.stdout.write(JSON.stringify({ doc: maxSettings(), wire, wireBytes: pgJsonBytes(wire) }));
}
