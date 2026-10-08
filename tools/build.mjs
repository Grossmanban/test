// Builds both targets from src/ (no dependencies, Node ≥ 20):
//   dist/pwa/               the installable web app for GitHub Pages
//   dist/artifact/budget.html  a single file for the claude.ai artifact
// Usage: node tools/build.mjs [--only=pwa|artifact]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = p => path.join(root, "src", p);
const read = p => fs.readFileSync(p, "utf8");
const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7);
const hash = (data, n = 10) => crypto.createHash("sha256").update(data).digest("hex").slice(0, n);

function need(file) {
  if (!fs.existsSync(file)) { console.error(`build: missing ${path.relative(root, file)}`); process.exit(1); }
  return read(file);
}
function bundle(files) {
  return files.map(f => `/* ── ${f} ── */\n${need(src(f)).trim()}\n`).join("\n");
}
function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function copyDir(from, to) {
  if (!fs.existsSync(from)) return [];
  const out = [];
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) out.push(...copyDir(a, b).map(p => path.join(entry.name, p)));
    else { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(a, b); out.push(entry.name); }
  }
  return out;
}

const appHtml = need(src("app.html")).trim();
const appCss = need(src("app.css")).trim();

/* ── claude.ai artifact ─────────────────────────── */
function buildArtifact() {
  const js = bundle(["icons.js", "store-artifact.js", "app.js"]);
  const html = `<title>Домашняя бухгалтерия</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Unbounded:wght@500;600&display=swap">
<style>
${appCss}
</style>

${appHtml}

<script>window.BUDGET_FEATURES = { pwa: false };</script>
<script>
${js}
</script>
`;
  const out = path.join(root, "dist", "artifact", "budget.html");
  writeFile(out, html);
  console.log(`artifact: ${path.relative(root, out)} (${(html.length / 1024).toFixed(1)} KB)`);
}

/* ── PWA ────────────────────────────────────────── */
function buildPwa() {
  const dist = path.join(root, "dist", "pwa");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  const css = `${appCss}\n\n/* ── pwa.css ── */\n${need(src("pwa.css")).trim()}\n`;
  const js = bundle(["icons.js", "seed.js", "store-pwa.js", "app.js", "pwa.js"]);
  const cssName = `app.${hash(css)}.css`;
  const jsName = `app.${hash(js)}.js`;
  writeFile(path.join(dist, cssName), css);
  writeFile(path.join(dist, jsName), js);

  const assets = copyDir(path.join(root, "public"), dist).map(p => p.split(path.sep).join("/"));
  fs.copyFileSync(path.join(root, "config.js"), path.join(dist, "config.js"));
  fs.copyFileSync(src("manifest.webmanifest"), path.join(dist, "manifest.webmanifest"));
  writeFile(path.join(dist, ".nojekyll"), "");

  const head = need(src("head-pwa.html")).trim();
  const index = `<!doctype html>
<html lang="ru">
<head>
${head}
<link rel="stylesheet" href="${cssName}">
</head>
<body>
${appHtml}
<script src="config.js"></script>
<script src="vendor/supabase.js"></script>
<script>window.BUDGET_FEATURES = { pwa: true };</script>
<script src="${jsName}"></script>
</body>
</html>
`;
  writeFile(path.join(dist, "index.html"), index);

  // service worker: precache the app shell; the version changes whenever any shipped byte changes
  const skip = new Set(["LICENSES.md", ".nojekyll"]);
  const shipped = ["index.html", cssName, jsName, "config.js", "manifest.webmanifest",
    ...assets.filter(a => !skip.has(a) && !a.endsWith(".md"))];
  const version = hash(shipped.map(f => f + ":" + hash(fs.readFileSync(path.join(dist, f)), 16)).join("\n"), 12);
  const precache = ["./", ...shipped.map(f => "./" + f)];
  const swSrc = need(src("sw.js"));
  if (!swSrc.includes('"__BUILD_VERSION__"') || !swSrc.includes("__PRECACHE_LIST__")) {
    console.error("build: src/sw.js must contain \"__BUILD_VERSION__\" and __PRECACHE_LIST__"); process.exit(1);
  }
  const sw = swSrc.replace('"__BUILD_VERSION__"', JSON.stringify(version)).replace("__PRECACHE_LIST__", JSON.stringify(precache, null, 2));
  writeFile(path.join(dist, "sw.js"), sw);
  console.log(`pwa: dist/pwa (${shipped.length + 1} files, version ${version})`);
}

if (!only || only === "artifact") buildArtifact();
if (!only || only === "pwa") buildPwa();
