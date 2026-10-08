// Renders the app icons into public/icons/ with a headless Chromium canvas (Playwright):
//   apple-touch-icon.png 180×180  opaque, full-bleed (iOS rounds the corners itself)
//   icon-192.png, icon-512.png    purpose "any": rounded tile with transparent corners
//   icon-maskable-512.png         purpose "maskable": full-bleed, mark inside the 80 % safe zone
//   favicon-32.png, favicon.svg   simplified tile for tabs (no engraving — it is noise at 32 px)
// Design: the balance card's deep pine (#0e3b31) with an engraved guilloche rosette in thin mint
// lines, and the app's brand mark — the Lucide "wallet" glyph (ISC) — drawn thick in mint.
// Output: 8-bit palette PNGs (quantized + encoded below, no dependencies besides Playwright).
// Usage: node tools/make-icons.mjs [--preview=sheet.png]    (env ICON_COLORS=n overrides the palette size)
//   env PLAYWRIGHT=<path to the playwright package>, CHROMIUM=<browser executable> (both optional)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "icons");
const require = createRequire(import.meta.url);

function loadPlaywright() {
  for (const p of [process.env.PLAYWRIGHT, "playwright", "/opt/node-tools/node_modules/playwright"].filter(Boolean)) {
    try { return require(p); } catch {}
  }
  throw new Error("playwright not found: npm i -D playwright, or set PLAYWRIGHT=<path to the package>");
}

const PINE = "#0e3b31";
const MINT = "#9fe6c9";
// Lucide "wallet" (lucide 0.460.0, ISC): 24×24 grid, ink spans x 3…22, y 3…21
const WALLET = [
  "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1",
  "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4",
];
const GLYPH_CX = 12.5, GLYPH_CY = 12;

// shape: "square" (full-bleed) | "tile" (rounded, transparent corners)
// mark: glyph width (19 grid units) as a fraction of the icon size; weight: stroke in grid units
const ICONS = [
  { file: "apple-touch-icon.png", size: 180, shape: "square", mark: 0.47, weight: 2.35, engrave: true },
  { file: "icon-192.png", size: 192, shape: "tile", mark: 0.47, weight: 2.35, engrave: true },
  { file: "icon-512.png", size: 512, shape: "tile", mark: 0.47, weight: 2.3, engrave: true },
  { file: "icon-maskable-512.png", size: 512, shape: "square", mark: 0.40, weight: 2.3, engrave: true, safe: 0.8 },
  { file: "favicon-32.png", size: 32, shape: "tile", mark: 0.66, weight: 2.7, engrave: false, colors: 256 },
];

/* Runs in the browser: draws one icon onto a canvas and returns a PNG data URL. */
function drawIcon(spec, consts) {
  const { size: S, shape, mark, weight, engrave } = spec;
  const { PINE, MINT, WALLET, GLYPH_CX, GLYPH_CY } = consts;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const tileR = S * 0.225;

  g.save();
  if (shape === "tile") {
    g.beginPath(); g.roundRect(0, 0, S, S, tileR); g.clip();
  }
  // deep pine with a soft light falling from the top-left, darker towards the corners
  const bg = g.createRadialGradient(S * 0.32, S * 0.18, 0, S * 0.5, S * 0.5, S * 0.95);
  bg.addColorStop(0, "#175847");
  bg.addColorStop(0.5, PINE);
  bg.addColorStop(1, "#082a22");
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);

  const cx = S / 2, cy = S / 2;
  if (engrave) {
    // engraved guilloche: two woven rings of phase-shifted sine curves (a banknote rosette)
    // and a pair of hairline circles, all thin mint lines at low alpha
    const lw = Math.max(0.5, S / 420);
    g.lineWidth = lw;
    g.strokeStyle = MINT;
    const ring = (R0, A, k, n, alpha, twist) => {
      g.globalAlpha = alpha;
      for (let j = 0; j < n; j++) {
        const ph = (j / n) * Math.PI * 2;
        g.beginPath();
        for (let a = 0; a <= Math.PI * 2 + 1e-3; a += Math.PI / 900) {
          const r = S * (R0 + A * Math.sin(k * a + ph) + twist * Math.sin((k / 2) * a - ph));
          const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
          a ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.closePath();
        g.stroke();
      }
    };
    ring(0.445, 0.045, 24, 14, 0.15, 0.012);
    ring(0.585, 0.06, 30, 12, 0.10, 0.015);
    g.globalAlpha = 0.2;
    for (const k of [0.385, 0.395]) { g.beginPath(); g.arc(cx, cy, S * k, 0, Math.PI * 2); g.stroke(); }
    g.globalAlpha = 1;
    // clear the centre so the mark sits on calm pine
    const calm = g.createRadialGradient(cx, cy, 0, cx, cy, S * 0.36);
    calm.addColorStop(0, "rgba(13, 55, 46, 0.96)");
    calm.addColorStop(0.72, "rgba(13, 55, 46, 0.85)");
    calm.addColorStop(1, "rgba(13, 55, 46, 0)");
    g.fillStyle = calm;
    g.beginPath(); g.arc(cx, cy, S * 0.36, 0, Math.PI * 2); g.fill();
  }

  // the mark: wallet glyph, thick round strokes, mint with a faint top-down sheen
  const k = (S * mark) / 19;
  g.save();
  g.translate(cx, cy);
  g.scale(k, k);
  g.translate(-GLYPH_CX, -GLYPH_CY);
  g.lineWidth = weight;
  g.lineCap = "round";
  g.lineJoin = "round";
  const glyph = new Path2D(WALLET.join(" "));   // one path → one shadow, no seams where strokes cross
  if (S >= 64) {
    g.shadowColor = "rgba(0, 18, 12, 0.55)";
    g.shadowBlur = S / 28;
    g.shadowOffsetY = S / 90;
  }
  const sheen = g.createLinearGradient(0, 2, 0, 22);
  sheen.addColorStop(0, "#c2f5df");
  sheen.addColorStop(1, MINT);
  g.strokeStyle = S >= 64 ? sheen : MINT;
  g.stroke(glyph);
  g.restore();

  // a hairline highlight along the top edge of the tile
  if (shape === "tile" && S >= 64) {
    g.globalAlpha = 0.22;
    g.strokeStyle = MINT;
    g.lineWidth = Math.max(1, S / 256);
    g.beginPath(); g.roundRect(g.lineWidth / 2, g.lineWidth / 2, S - g.lineWidth, S - g.lineWidth, tileR - g.lineWidth / 2);
    const fade = g.createLinearGradient(0, 0, 0, S);
    fade.addColorStop(0, "rgba(159, 230, 201, 1)");
    fade.addColorStop(0.35, "rgba(159, 230, 201, 0)");
    g.strokeStyle = fade;
    g.stroke();
    g.globalAlpha = 1;
  }
  g.restore();
  const px = g.getImageData(0, 0, S, S).data;      // straight (non-premultiplied) RGBA
  let bin = "";
  for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ── PNG output: palette quantization (≤ 256 colours) + a minimal PNG encoder ──
   The fine engraving makes truecolour PNGs huge (≈ 430 KB at 512 px) and every shipped file is
   precached by the service worker, so icons are stored as 8-bit palette PNGs: 160 colours by
   default (≈ 4× smaller, PSNR > 50 dB, no visible banding — the artwork is a narrow range of greens). */
function quantize(rgba, maxColors = 256) {
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    const key = a === 0 ? 0 : ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | a) >>> 0;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // colours in premultiplied space, so semi-transparent edge pixels compare sensibly
  const uniq = [...counts].map(([key, n]) => {
    const r = key >>> 24, gg = (key >>> 16) & 255, b = (key >>> 8) & 255, a = key & 255;
    return { key, n, v: [r * a / 255, gg * a / 255, b * a / 255, a] };
  });
  let palette;
  if (uniq.length <= maxColors) {
    palette = uniq.map(u => u.v);
  } else {
    // weighted median cut …
    let boxes = [uniq];
    const spread = box => {
      let best = -1, ch = 0;
      for (let c = 0; c < 4; c++) {
        let lo = Infinity, hi = -Infinity;
        for (const u of box) { lo = Math.min(lo, u.v[c]); hi = Math.max(hi, u.v[c]); }
        if (hi - lo > best) { best = hi - lo; ch = c; }
      }
      return { range: best, ch };
    };
    while (boxes.length < maxColors) {
      let bi = -1, score = 0, ch = 0;
      boxes.forEach((box, i) => {
        if (box.length < 2) return;
        const s = spread(box), w = box.reduce((t, u) => t + u.n, 0);
        const sc = s.range * Math.sqrt(w);
        if (sc > score) { score = sc; bi = i; ch = s.ch; }
      });
      if (bi < 0) break;
      const box = boxes[bi].sort((x, y) => x.v[ch] - y.v[ch]);
      const total = box.reduce((t, u) => t + u.n, 0);
      let acc = 0, cut = 1;
      for (; cut < box.length - 1; cut++) { acc += box[cut - 1].n; if (acc >= total / 2) break; }
      boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
    }
    const mean = box => {
      const m = [0, 0, 0, 0]; let w = 0;
      for (const u of box) { for (let c = 0; c < 4; c++) m[c] += u.v[c] * u.n; w += u.n; }
      return m.map(x => x / w);
    };
    palette = boxes.map(mean);
    // … refined by a few weighted k-means passes
    for (let pass = 0; pass < 4; pass++) {
      const acc = palette.map(() => [0, 0, 0, 0, 0]);
      for (const u of uniq) {
        const j = nearest(palette, u.v);
        const t = acc[j]; for (let c = 0; c < 4; c++) t[c] += u.v[c] * u.n; t[4] += u.n;
      }
      palette = palette.map((p, j) => acc[j][4] ? acc[j].slice(0, 4).map(x => x / acc[j][4]) : p);
    }
  }
  const index = new Map(uniq.map(u => [u.key, nearest(palette, u.v)]));
  const idx = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const a = rgba[i + 3];
    idx[p] = index.get(a === 0 ? 0 : ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | a) >>> 0);
  }
  // back to straight RGBA for PLTE/tRNS
  const pal = palette.map(([r, g, b, a]) => {
    const A = Math.round(a);
    return A === 0 ? [0, 0, 0, 0] : [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x * 255 / a)))).concat(A);
  });
  return { pal, idx };
}
// quality of the palette image against the original, in dB (composited over black, alpha included)
function psnr(rgba, { pal, idx }) {
  let se = 0;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const q = pal[idx[p]], a = rgba[i + 3] / 255, b = q[3] / 255;
    for (let c = 0; c < 3; c++) se += (rgba[i + c] * a - q[c] * b) ** 2;
    se += (rgba[i + 3] - q[3]) ** 2;
  }
  const mse = se / (idx.length * 4);
  return mse ? 10 * Math.log10(255 * 255 / mse) : 99;
}
function nearest(palette, v) {
  let best = 0, bd = Infinity;
  for (let j = 0; j < palette.length; j++) {
    const p = palette[j];
    const d = (p[0] - v[0]) ** 2 + (p[1] - v[1]) ** 2 + (p[2] - v[2]) ** 2 + (p[3] - v[3]) ** 2;
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
  let c = -1; for (const b of Buffer.concat([head.subarray(4), data])) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ -1) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
function encodePng8(size, { pal, idx }) {
  // transparent entries first keeps tRNS short
  const order = pal.map((p, i) => i).sort((a, b) => (pal[a][3] === 255) - (pal[b][3] === 255));
  const remap = new Uint8Array(pal.length); order.forEach((old, i) => { remap[old] = i; });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 3;   // 8-bit indexed
  const plte = Buffer.from(order.flatMap(i => pal[i].slice(0, 3)));
  const alphas = order.map(i => pal[i][3]);
  const nTrns = alphas.findIndex(a => a === 255) < 0 ? alphas.length : alphas.findIndex(a => a === 255);
  // filter type 0 (none) on every scanline: the best fit for palette images (measured smaller than sub/up/paeth)
  const rows = [];
  for (let y = 0; y < size; y++) {
    const line = Buffer.alloc(size + 1);
    for (let x = 0; x < size; x++) line[x + 1] = remap[idx[y * size + x]];
    rows.push(line);
  }
  const raw = Buffer.concat(rows);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("PLTE", plte),
    ...(nTrns ? [chunk("tRNS", Buffer.from(alphas.slice(0, nTrns)))] : []),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function faviconSvg() {
  // 32-unit tile; glyph scaled like favicon-32.png
  const S = 32, k = (S * 0.66) / 19;
  const tx = S / 2 - GLYPH_CX * k, ty = S / 2 - GLYPH_CY * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<defs><radialGradient id="b" cx="0.32" cy="0.18" r="0.95" fx="0.32" fy="0.18" gradientUnits="objectBoundingBox">
<stop offset="0" stop-color="#175847"/><stop offset="0.5" stop-color="${PINE}"/><stop offset="1" stop-color="#082a22"/></radialGradient></defs>
<rect width="32" height="32" rx="7.2" fill="url(#b)"/>
<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(4)})" fill="none" stroke="${MINT}" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round">
${WALLET.map(d => `<path d="${d}"/>`).join("\n")}
</g>
</svg>
`;
}

const preview = (process.argv.find(a => a.startsWith("--preview=")) || "").slice(10);
const { chromium } = loadPlaywright();
const exe = process.env.CHROMIUM || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  fs.mkdirSync(outDir, { recursive: true });
  const consts = { PINE, MINT, WALLET, GLYPH_CX, GLYPH_CY };
  for (const spec of ICONS) {
    if (spec.safe) {
      // maskable: the glyph (with its stroke) must stay inside the circular safe zone
      const k = (spec.size * spec.mark) / 19, h = spec.weight / 2;
      const reach = Math.hypot(22 - GLYPH_CX + h, 21 - GLYPH_CY + h) * k;
      if (reach > (spec.safe * spec.size) / 2) throw new Error(`${spec.file}: mark leaves the ${spec.safe * 100}% safe zone`);
    }
    const b64 = await page.evaluate(([fn, s, c]) => new Function(`return (${fn})`)()(s, c), [drawIcon.toString(), spec, consts]);
    const rgba = new Uint8Array(Buffer.from(b64, "base64"));
    const q = quantize(rgba, Number(process.env.ICON_COLORS || spec.colors || 160));
    const png = encodePng8(spec.size, q);
    fs.writeFileSync(path.join(outDir, spec.file), png);
    console.log(`icons: public/icons/${spec.file} (${spec.size}×${spec.size}, ${q.pal.length} colours, PSNR ${psnr(rgba, q).toFixed(1)} dB, ${(png.length / 1024).toFixed(1)} KB)`);
  }
  fs.writeFileSync(path.join(outDir, "favicon.svg"), faviconSvg());
  console.log("icons: public/icons/favicon.svg");

  if (preview) {
    // contact sheet: every icon on light and dark, plus the iOS corner mask and the maskable safe zone
    const img = f => "data:image/png;base64," + fs.readFileSync(path.join(outDir, f)).toString("base64");
    const svg = "data:image/svg+xml;base64," + Buffer.from(faviconSvg()).toString("base64");
    const row = bg => `<div class="row" style="background:${bg}">
      <figure><img src="${img("apple-touch-icon.png")}" style="width:180px;border-radius:40px"><figcaption>iOS 180</figcaption></figure>
      <figure><img src="${img("icon-512.png")}" style="width:192px"><figcaption>any 512→192</figcaption></figure>
      <figure><img src="${img("icon-maskable-512.png")}" style="width:192px;border-radius:50%"><figcaption>maskable (circle)</figcaption></figure>
      <figure><div style="position:relative;width:192px;height:192px"><img src="${img("icon-maskable-512.png")}" style="width:192px;border-radius:24px">
        <div style="position:absolute;inset:0;margin:auto;width:80%;height:80%;border-radius:50%;outline:1px dashed #f0f"></div></div><figcaption>safe zone</figcaption></figure>
      <figure><img src="${img("icon-192.png")}" style="width:60px"><figcaption>home 60</figcaption></figure>
      <figure><img src="${img("favicon-32.png")}" style="width:32px"><img src="${svg}" style="width:32px;margin-left:6px"><img src="${img("favicon-32.png")}" style="width:16px;margin-left:6px"><figcaption>32 png · svg · 16</figcaption></figure>
    </div>`;
    await page.setViewportSize({ width: 1180, height: 600 });
    await page.setContent(`<!doctype html><style>body{margin:0;font:12px system-ui}.row{display:flex;gap:22px;align-items:flex-end;padding:22px}
      figure{margin:0;text-align:center}figcaption{margin-top:6px;color:#888}img{display:inline-block;vertical-align:bottom}</style>
      ${row("#edf1ef")}${row("#0a100e")}`);
    await page.waitForFunction(() => [...document.images].every(i => i.complete));
    await page.screenshot({ path: preview, fullPage: true });
    console.log(`icons: preview ${preview}`);
  }
} finally {
  await browser.close();
}
