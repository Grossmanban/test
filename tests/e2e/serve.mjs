// Tiny static server for dist/pwa mounted under /test/ (like GitHub Pages). Usage: node tests/e2e/serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/pwa");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8" };

export function serve(port = 0, base = "/test/") {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith(base)) { res.writeHead(302, { location: base }); return res.end(); }
    let rel = decodeURIComponent(url.pathname.slice(base.length)) || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, "127.0.0.1", () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await serve(Number(process.argv[2] || 8787));
  console.log(`http://127.0.0.1:${s.address().port}/test/`);
}
