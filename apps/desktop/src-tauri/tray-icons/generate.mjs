// Pure-Node tray-icon generator (no native deps). Software-rasterises each voice state at a
// supersample resolution, box-downsamples to 32x32 RGBA, and encodes a real PNG via zlib. These are
// the dynamic system-tray icons swapped by `gv_tray_set_state` (see ../src/lib.rs) — kept OUTSIDE the
// build-generated (gitignored) `icons/` dir so they're committed and available to `include_image!`.
// Run:  node generate.mjs   → writes {silent,speaking,muted,deafened}.png next to this script.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const OUT = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const N = 32; // output px
const F = 8; // supersample factor
const R = N * F; // 256

// ---- colours (match client palette) ----
const GREEN = [63, 185, 122]; // --green (speaking ring)
const GREEN_HALO = [63, 185, 122];
const GREY = [154, 164, 176];
const GREY_RIM = [86, 94, 106];
const RED = [224, 87, 78]; // --danger

// RGBA float buffer at supersample res
function canvas() {
  return new Float32Array(R * R * 4); // premultiplied-ish, but we keep opaque overwrite
}
function idx(x, y) {
  return (y * R + x) * 4;
}
function setPx(buf, x, y, c, a = 1) {
  if (x < 0 || y < 0 || x >= R || y >= R) return;
  const i = idx(x, y);
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = a * 255;
}
function erasePx(buf, x, y) {
  if (x < 0 || y < 0 || x >= R || y >= R) return;
  const i = idx(x, y);
  buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
}

// membership fills (opaque overwrite; supersample gives AA after downsample)
function each(fn) {
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) fn(x, y);
}
function fillCircle(buf, cx, cy, r, c) {
  const r2 = r * r;
  each((x, y) => {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= r2) setPx(buf, x, y, c);
  });
}
function ring(buf, cx, cy, rOut, rIn, c, halfPredicate) {
  const ro2 = rOut * rOut, ri2 = rIn * rIn;
  each((x, y) => {
    const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
    if (d2 <= ro2 && d2 >= ri2 && (!halfPredicate || halfPredicate(x, y))) setPx(buf, x, y, c);
  });
}
function roundRect(buf, x0, y0, w, h, rad, c) {
  const x1 = x0 + w, y1 = y0 + h;
  each((x, y) => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return;
    // corner rounding
    const cxL = x0 + rad, cxR = x1 - rad, cyT = y0 + rad, cyB = y1 - rad;
    let ok = true;
    if (x < cxL && y < cyT) ok = (x - cxL) ** 2 + (y - cyT) ** 2 <= rad * rad;
    else if (x > cxR && y < cyT) ok = (x - cxR) ** 2 + (y - cyT) ** 2 <= rad * rad;
    else if (x < cxL && y > cyB) ok = (x - cxL) ** 2 + (y - cyB) ** 2 <= rad * rad;
    else if (x > cxR && y > cyB) ok = (x - cxR) ** 2 + (y - cyB) ** 2 <= rad * rad;
    if (ok) setPx(buf, x, y, c);
  });
}
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}
function line(buf, ax, ay, bx, by, width, c) {
  const hw = width / 2;
  each((x, y) => {
    if (segDist(x, y, ax, ay, bx, by) <= hw) setPx(buf, x, y, c);
  });
}
function eraseLine(buf, ax, ay, bx, by, width) {
  const hw = width / 2;
  each((x, y) => {
    if (segDist(x, y, ax, ay, bx, by) <= hw) erasePx(buf, x, y);
  });
}

// downsample R×R → N×N by averaging F×F blocks
function downsample(buf) {
  const out = Buffer.alloc(N * N * 4);
  for (let oy = 0; oy < N; oy++) {
    for (let ox = 0; ox < N; ox++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < F; sy++) {
        for (let sx = 0; sx < F; sx++) {
          const i = idx(ox * F + sx, oy * F + sy);
          const pa = buf[i + 3] / 255;
          r += buf[i] * pa;
          g += buf[i + 1] * pa;
          b += buf[i + 2] * pa;
          a += pa;
        }
      }
      const o = (oy * N + ox) * 4;
      const cnt = F * F;
      const av = a || 1;
      out[o] = Math.round(r / av); // un-premultiply
      out[o + 1] = Math.round(g / av);
      out[o + 2] = Math.round(b / av);
      out[o + 3] = Math.round((a / cnt) * 255);
    }
  }
  return out;
}

// ---- PNG encode ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function save(name, buf) {
  const png = encodePng(downsample(buf));
  writeFileSync(`${OUT}/${name}.png`, png);
  console.log('wrote', name, png.length, 'bytes');
}

// ================= ICONS =================
const CX = R / 2, CY = R / 2;

// silent bubble: grey filled circle with darker rim
{
  const b = canvas();
  fillCircle(b, CX, CY, 96, GREY_RIM);
  fillCircle(b, CX, CY, 86, GREY);
  save('silent', b);
}

// speaking bubble: green filled circle + green halo ring (matches avatar speaking ring)
{
  const b = canvas();
  ring(b, CX, CY, 122, 104, GREEN_HALO); // outer halo
  fillCircle(b, CX, CY, 90, [40, 160, 100]); // rim
  fillCircle(b, CX, CY, 82, GREEN);
  save('speaking', b);
}

// muted: red microphone with diagonal slash (no bubble)
{
  const b = canvas();
  // mic capsule (body)
  roundRect(b, CX - 30, 52, 60, 100, 30, RED);
  // stand arc (U under capsule)
  ring(b, CX, 150, 54, 42, RED, (x, y) => y >= 150);
  // stem
  line(b, CX, 196, CX, 218, 13, RED);
  // base
  line(b, CX - 26, 218, CX + 26, 218, 13, RED);
  // slash: erase clearance then draw red line
  eraseLine(b, 70, 58, 190, 200, 30);
  line(b, 74, 62, 186, 196, 15, RED);
  save('muted', b);
}

// deafened: red headphones with diagonal slash
{
  const b = canvas();
  // headband (upper annulus)
  ring(b, CX, 128, 82, 64, RED, (x, y) => y <= 128);
  // earcups
  roundRect(b, 44, 122, 34, 64, 15, RED);
  roundRect(b, R - 78, 122, 34, 64, 15, RED);
  // slash
  eraseLine(b, 70, 58, 190, 200, 30);
  line(b, 74, 62, 186, 196, 15, RED);
  save('deafened', b);
}

console.log('done');
