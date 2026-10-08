// Vendors supabase-js v2 (UMD build → window.supabase) into public/vendor/supabase.js.
// Picks the newest 2.x release that has been on npm for at least 14 days (a cooling-off period
// against compromised fresh releases), downloads dist/umd/supabase.js from jsDelivr and checks it
// byte-for-byte against the copy inside the npm tarball, whose sha512 must match the registry.
// Records the version and the MIT notice in public/LICENSES.md.
// Usage: node tools/fetch-vendor.mjs [--today=YYYY-MM-DD] [--version=2.x.y]
//        (Node ≥ 20; behind a proxy: NODE_USE_ENV_PROXY=1)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@supabase/supabase-js";
const FILE = "dist/umd/supabase.js";
const MIN_AGE_DAYS = 14;
const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || "").split("=")[1];

async function get(url, as = "buffer") {
  const res = await fetch(url, { headers: { accept: as === "json" ? "application/json" : "*/*" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  if (as === "json") return res.json();
  return Buffer.from(await res.arrayBuffer());
}
const semver = v => v.split(".").map(Number);
const cmp = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// minimal ustar reader: returns the contents of one entry of a .tar buffer
function tarEntry(tar, wanted) {
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const name = (str(345, 500) ? str(345, 500) + "/" : "") + str(0, 100);
    const size = parseInt(str(124, 136).trim() || "0", 8);
    if (name === wanted) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

const meta = await get(`https://registry.npmjs.org/${PKG.replace("/", "%2f")}`, "json");
const today = arg("today") || new Date().toISOString().slice(0, 10);
const cutoff = Date.parse(today + "T00:00:00Z") - MIN_AGE_DAYS * 864e5;
let version = arg("version");
if (!version) {
  const candidates = Object.keys(meta.versions)
    .filter(v => /^2\.\d+\.\d+$/.test(v) && !meta.versions[v].deprecated && Date.parse(meta.time[v]) <= cutoff)
    .sort(cmp);
  version = candidates.at(-1);
  if (!version) throw new Error(`no ${PKG} 2.x release older than ${MIN_AGE_DAYS} days`);
}
const info = meta.versions[version];
if (!info) throw new Error(`${PKG}@${version} not found`);
console.log(`${PKG}@${version} (published ${meta.time[version]}, ${info.license})`);

// 1) the npm tarball, verified against the registry's sha512 integrity
const tgz = await get(info.dist.tarball);
const [algo, expected] = info.dist.integrity.split("-");
const actual = crypto.createHash(algo).update(tgz).digest("base64");
if (actual !== expected) throw new Error(`tarball ${algo} mismatch: ${actual} ≠ ${expected}`);
const tar = zlib.gunzipSync(tgz);
const fromNpm = tarEntry(tar, `package/${FILE}`);
const license = tarEntry(tar, "package/LICENSE");
if (!fromNpm) throw new Error(`${FILE} missing in the npm tarball`);

// 2) the jsDelivr copy, which must be identical
const js = await get(`https://cdn.jsdelivr.net/npm/${PKG}@${version}/${FILE}`);
if (!js.equals(fromNpm)) throw new Error(`jsDelivr ${FILE} differs from the npm tarball`);
if (!/^var supabase\s*=/.test(js.toString("utf8", 0, 64))) throw new Error("unexpected UMD wrapper (expected `var supabase=`)");

const out = path.join(root, "public", "vendor", "supabase.js");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, js);
const sha = crypto.createHash("sha256").update(js).digest("base64");
console.log(`vendor: public/vendor/supabase.js (${(js.length / 1024).toFixed(1)} KB, sha256-${sha})`);

// 3) LICENSES.md: replace the supabase-js section between its markers
const licFile = path.join(root, "public", "LICENSES.md");
const notice = (license ? license.toString("utf8") : `MIT License\n\nCopyright (c) Supabase\n`).trim();
const section = `<!-- supabase-js:start -->
## supabase-js ${version}

- Файл: \`vendor/supabase.js\` (\`${PKG}@${version}/${FILE}\`, sha256-${sha})
- Источник: https://github.com/supabase/supabase-js · https://www.npmjs.com/package/${PKG}/v/${version}
- Лицензия: MIT

\`\`\`text
${notice}
\`\`\`
<!-- supabase-js:end -->`;
let doc = fs.existsSync(licFile) ? fs.readFileSync(licFile, "utf8") : "# Сторонние компоненты\n";
doc = /<!-- supabase-js:start -->[\s\S]*<!-- supabase-js:end -->/.test(doc)
  ? doc.replace(/<!-- supabase-js:start -->[\s\S]*<!-- supabase-js:end -->/, section)
  : doc.trimEnd() + "\n\n" + section + "\n";
fs.writeFileSync(licFile, doc);
console.log("vendor: updated public/LICENSES.md");
