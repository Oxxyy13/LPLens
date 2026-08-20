#!/usr/bin/env node
/**
 * Range-bracket mark (direction A) → extension/icons/icon{16,48,128}.png.
 *
 * 48 and 128 scale the 64×64 viewBox. 16 is hand-tuned on the pixel grid:
 * naive 4.5/64 of 16px is 1.1px and the bars die. See drawMark16().
 *
 * Usage: node tools/make-icons.mjs
 */
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync, crc32 } from 'zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'extension', 'icons');

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error('RGBA length mismatch');
  }
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    const src = y * width * 4;
    const dst = y * stride + 1;
    for (let x = 0; x < width * 4; x++) raw[dst + x] = rgba[src + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode enough of a PNG to confirm signature, IHDR size, and chunk CRCs. */
export function inspectPng(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) throw new Error('bad PNG signature');
  let off = 8;
  let width = 0, height = 0, chunks = 0;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const got = buf.readUInt32BE(off + 8 + len);
    const expect = crc32(buf.subarray(off + 4, off + 8 + len));
    if (got !== expect) throw new Error('CRC mismatch in ' + type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    chunks++;
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return { width, height, chunks, bytes: buf.length };
}

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

class Canvas {
  constructor(size) {
    this.n = size;
    this.rgba = new Uint8ClampedArray(size * size * 4);
  }
  blend(x, y, r, g, b, a) {
    if (a <= 0) return;
    const n = this.n;
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const i = (y * n + x) * 4;
    const da = this.rgba[i + 3] / 255;
    const sa = a;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    const s = sa / outA, d = da * (1 - sa) / outA;
    this.rgba[i] = Math.round(r * s + this.rgba[i] * d);
    this.rgba[i + 1] = Math.round(g * s + this.rgba[i + 1] * d);
    this.rgba[i + 2] = Math.round(b * s + this.rgba[i + 2] * d);
    this.rgba[i + 3] = Math.round(outA * 255);
  }
  /** Axis-aligned fill with coverage anti-aliasing at edges. */
  fillRect(x0, y0, x1, y1, r, g, b, a = 1) {
    const n = this.n;
    const xa = Math.floor(x0), xb = Math.ceil(x1);
    const ya = Math.floor(y0), yb = Math.ceil(y1);
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const cx0 = Math.max(x, x0), cx1 = Math.min(x + 1, x1);
        const cy0 = Math.max(y, y0), cy1 = Math.min(y + 1, y1);
        const cov = Math.max(0, cx1 - cx0) * Math.max(0, cy1 - cy0);
        if (cov > 0) this.blend(x, y, r, g, b, a * cov);
      }
    }
  }
  fillCircle(cx, cy, radius, r, g, b, a = 1) {
    const n = this.n;
    const x0 = Math.max(0, Math.floor(cx - radius - 1));
    const x1 = Math.min(n - 1, Math.ceil(cx + radius + 1));
    const y0 = Math.max(0, Math.floor(cy - radius - 1));
    const y1 = Math.min(n - 1, Math.ceil(cy + radius + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cov = clamp((radius + 0.5 - d), 0, 1);
        if (cov > 0) this.blend(x, y, r, g, b, a * cov);
      }
    }
  }
  fillRoundedRect(x0, y0, x1, y1, rad, r, g, b, a = 1) {
    const n = this.n;
    for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
      for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const px = x + 0.5, py = y + 0.5;
        const qx = clamp(px, x0 + rad, x1 - rad);
        const qy = clamp(py, y0 + rad, y1 - rad);
        let d;
        if (px >= x0 + rad && px <= x1 - rad && py >= y0 + rad && py <= y1 - rad) d = -1;
        else d = Math.hypot(px - qx, py - qy) - rad;
        const cov = clamp(0.5 - d, 0, 1);
        if (cov > 0) this.blend(x, y, r, g, b, a * cov);
      }
    }
  }
}

const AMBER = [232, 163, 61];   // #E8A33D
const INK = [14, 20, 32];       // #0E1420

/** 64×64 viewBox, scaled. Used for 48 and 128. */
function drawMarkScaled(size) {
  const c = new Canvas(size);
  const s = size / 64;
  const [ar, ag, ab] = AMBER, [ir, ig, ib] = INK;
  c.fillRoundedRect(4 * s, 4 * s, 60 * s, 60 * s, 13 * s, ar, ag, ab, 1);
  c.fillRoundedRect(17 * s, 17 * s, 21.5 * s, 47 * s, 2.25 * s, ir, ig, ib, 1);
  c.fillRoundedRect(42.5 * s, 17 * s, 47 * s, 47 * s, 2.25 * s, ir, ig, ib, 1);
  c.fillCircle(32 * s, 32 * s, 6 * s, ir, ig, ib, 1);
  return c.rgba;
}

/**
 * 16px optical variant. Bars are 2px on the grid (not 1.1px), bar corner
 * radius dropped, dot r=2.5 at (8,8), outer rounded square kept.
 * Reads as [ • ] at 100% zoom.
 */
function drawMark16() {
  const c = new Canvas(16);
  const [ar, ag, ab] = AMBER, [ir, ig, ib] = INK;
  c.fillRoundedRect(1, 1, 15, 15, 3, ar, ag, ab, 1);
  c.fillRect(3, 4, 5, 12, ir, ig, ib, 1);   // 2px left bound, no radius
  c.fillRect(11, 4, 13, 12, ir, ig, ib, 1); // 2px right bound
  c.fillCircle(8, 8, 2.5, ir, ig, ib, 1);
  return c.rgba;
}

function luminanceMap(rgba, size) {
  const rows = [];
  const chars = ' .:-=+*#%@';
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = rgba[i + 3] / 255;
      const yv = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
      const t = a * (1 - yv); // darker ink shows denser
      row += chars[Math.min(chars.length - 1, Math.floor(t * chars.length))];
    }
    rows.push(row);
  }
  return rows.join('\n');
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const draws = { 16: drawMark16, 48: () => drawMarkScaled(48), 128: () => drawMarkScaled(128) };
  for (const size of [16, 48, 128]) {
    const rgba = draws[size]();
    const png = encodePng(size, size, rgba);
    const path = join(OUT, `icon${size}.png`);
    writeFileSync(path, png);
    const info = inspectPng(readFileSync(path));
    if (info.width !== size || info.height !== size) {
      throw new Error('IHDR size mismatch for ' + path);
    }
    console.log('make-icons: range-bracket', path, info.width + 'x' + info.height,
      info.bytes + ' bytes', info.chunks + ' chunks, CRCs ok');
    if (size === 16) {
      console.log('make-icons: 16px luminance map (darker = ink):\n' + luminanceMap(rgba, 16));
    }
  }
}

const self = fileURLToPath(import.meta.url).toLowerCase();
if (self === resolve(process.argv[1] || '').toLowerCase()) {
  main();
}
