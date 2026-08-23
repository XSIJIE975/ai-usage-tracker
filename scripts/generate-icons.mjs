/**
 * 品牌图标生成器（纯 Node，无第三方依赖）。
 *
 * 设计源：docs/design/icons/app-icon.svg（与 src/components/BrandIcon.tsx 同源）
 * 渲染方式：SDF（有向距离场）+ 2x2 超采样抗锯齿，输出 RGBA PNG；
 *          ICO 采用 PNG 内嵌容器（Windows Vista+ 标准）。
 *
 * 用法：node scripts/generate-icons.mjs
 * 输出：src-tauri/icons/ 全套 Tauri 图标 + docs/design/icons/ 规格展示件
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------------- 设计参数（与 BrandIcon.tsx 保持一致） ---------------- */
const VIEW = 256;
const CORNER = 56;
const COLOR_TOP = [0x81, 0x83, 0xf8]; // iris-400
const COLOR_BOTTOM = [0x5a, 0x48, 0xe2]; // iris-600
const GAUGE = { cx: 128, cy: 138, r: 74, stroke: 20 };
const ARC_START = (140 * Math.PI) / 180;
const ARC_END = (400 * Math.PI) / 180; // 即 40°，跨过顶部
const NEEDLE = { x1: 128, y1: 138, x2: 164.8, y2: 101.2, w: 13 };
const DOT = { cx: 128, cy: 138, r: 13 };

/* ---------------- SDF 基元 ---------------- */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function sdArc(px, py) {
  const vx = px - GAUGE.cx;
  const vy = py - GAUGE.cy;
  let a = Math.atan2(vy, vx);
  if (a < 0) a += 2 * Math.PI;
  // 将角度映射到 [ARC_START, ARC_END] 区间内（允许跨过 2π）
  let aAdj = a;
  if (aAdj < ARC_START) aAdj += 2 * Math.PI;
  const clamped = Math.max(ARC_START, Math.min(ARC_END, aAdj));
  const nx = GAUGE.cx + GAUGE.r * Math.cos(clamped);
  const ny = GAUGE.cy + GAUGE.r * Math.sin(clamped);
  return Math.hypot(px - nx, py - ny) - GAUGE.stroke / 2;
}

function coverage(d) {
  return Math.max(0, Math.min(1, 0.5 - d));
}

/* ---------------- 逐像素渲染（2x2 超采样 + SDF 抗锯齿） ---------------- */
function renderIcon(size) {
  const scale = VIEW / size;
  const small = size < 48; // 小尺寸补偿：加粗前景保证可辨
  const needleW = small ? NEEDLE.w * 1.35 : NEEDLE.w;
  const arcStrokePad = small ? 1.15 : 1;
  const data = Buffer.alloc(size * size * 4);
  const samples = [0.25, 0.75];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (const sy of samples) {
        for (const sx of samples) {
          const px = (x + sx) * scale;
          const py = (y + sy) * scale;
          const dBase = sdRoundRect(px, py, 128, 128, 128, 128, CORNER);
          const covBase = coverage(dBase);
          let sr = 0;
          let sg = 0;
          let sb = 0;
          if (covBase > 0) {
            const t = (px + py) / (VIEW * 2);
            const cr = COLOR_TOP[0] + (COLOR_BOTTOM[0] - COLOR_TOP[0]) * t;
            const cg = COLOR_TOP[1] + (COLOR_BOTTOM[1] - COLOR_TOP[1]) * t;
            const cb = COLOR_TOP[2] + (COLOR_BOTTOM[2] - COLOR_TOP[2]) * t;
            const hl = py < 128 ? 0.08 * (1 - py / 128) : 0; // 顶部微高光
            sr = cr + (255 - cr) * hl;
            sg = cg + (255 - cg) * hl;
            sb = cb + (255 - cb) * hl;
            const dArc = sdArc(px, py) / arcStrokePad;
            const dNeedle = sdSegment(px, py, NEEDLE.x1, NEEDLE.y1, NEEDLE.x2, NEEDLE.y2) - needleW / 2;
            const dDot = Math.hypot(px - DOT.cx, py - DOT.cy) - DOT.r;
            const covFg = Math.max(coverage(dArc), coverage(dNeedle), coverage(dDot)) * 0.96;
            sr = sr * (1 - covFg) + 255 * covFg;
            sg = sg * (1 - covFg) + 255 * covFg;
            sb = sb * (1 - covFg) + 255 * covFg;
          }
          ar += sr * covBase;
          ag += sg * covBase;
          ab += sb * covBase;
          aa += covBase;
        }
      }
      const n = samples.length * samples.length;
      const idx = (y * size + x) * 4;
      data[idx] = Math.round(ar / n);
      data[idx + 1] = Math.round(ag / n);
      data[idx + 2] = Math.round(ab / n);
      data[idx + 3] = Math.round((aa / n) * 255);
    }
  }
  return data;
}

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO 编码（PNG 内嵌） ---------------- */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dirs = entries.map(({ size, png }) => {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size;
    dir[1] = size >= 256 ? 0 : size;
    dir[4] = 1; // planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += png.length;
    return dir;
  });
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]);
}

/* ---------------- 生成 ---------------- */
const pngCache = new Map();
function pngOf(size) {
  if (!pngCache.has(size)) pngCache.set(size, encodePng(size, renderIcon(size)));
  return pngCache.get(size);
}

function write(rel, buf) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  console.log(`✓ ${rel} (${(buf.length / 1024).toFixed(1)} KB)`);
}

// Tauri 标准图标
write("src-tauri/icons/32x32.png", pngOf(32));
write("src-tauri/icons/64x64.png", pngOf(64));
write("src-tauri/icons/128x128.png", pngOf(128));
write("src-tauri/icons/128x128@2x.png", pngOf(256));
write("src-tauri/icons/icon.png", pngOf(512));
write("src-tauri/icons/icon.ico", encodeIco([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, png: pngOf(s) }))));

// Windows Store 徽标
for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
  write(`src-tauri/icons/Square${s}x${s}Logo.png`, pngOf(s));
}
write("src-tauri/icons/StoreLogo.png", pngOf(50));

// 设计规格展示件
for (const s of [16, 32, 64, 128, 256, 512]) {
  write(`docs/design/icons/icon-${s}.png`, pngOf(s));
}
console.log("\n完成：PNG/ICO 已输出，SVG 源文件见 docs/design/icons/app-icon.svg");
