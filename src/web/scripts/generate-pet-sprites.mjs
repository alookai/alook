#!/usr/bin/env node
/**
 * Cloud Code monster PET sprite-sheet generator.
 *
 * Authors the six retained pets as procedural pixel art (32x32 logical grid,
 * upscaled x4 to 128px frames) and composes texture keyframes for every
 * activity/expression the pet state machine supports. Outputs, per pet:
 *   - public/pets/<id>.png        body sprite sheet (8 cols x N state rows)
 *   - public/pets/<id>-eyes.png   eye overlay strip (cursor tracking + blink)
 * plus a generated TS manifest consumed by the React sprite renderer.
 *
 * Run: node src/web/scripts/generate-pet-sprites.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(WEB_ROOT, "public", "pets");
const MANIFEST_PATH = path.join(
  WEB_ROOT,
  "src/components/home-pet/cloud-code-monster-pet-sprite-manifest.ts"
);

const GRID = 32; // logical pixels per frame side
const SCALE = 4; // output pixels per logical pixel
const FRAME = GRID * SCALE; // 128
const COLS = 8; // sheet columns (max frames per row)

/* ------------------------------------------------------------------ */
/* PNG encoding (dependency-free)                                      */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Pixel canvas                                                        */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

class Px {
  constructor(w = GRID, h = GRID) {
    this.w = w;
    this.h = h;
    this.data = Buffer.alloc(w * h * 4);
  }

  px(x, y, hex) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || !hex) return;
    const [r, g, b] = hexToRgb(hex);
    const i = (y * this.w + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = 255;
  }

  rect(x, y, w, h, hex) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        this.px(xx, yy, hex);
      }
    }
  }

  /** Filled pixel circle (odd widths look roundest at half-integer radii). */
  fillCircle(cx, cy, r, hex) {
    for (let y = Math.ceil(cy - r); y <= Math.floor(cy + r); y++) {
      const t = (y - cy) / r;
      const half = Math.round(r * Math.sqrt(Math.max(0, 1 - t * t)));
      if (half < 0) continue;
      this.hline(cx - half, y, half * 2 + 1, hex);
    }
  }

  clearRect(x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        const i = (yy * this.w + xx) * 4;
        this.data.writeUInt32BE(0, i);
      }
    }
  }

  hline(x, y, w, hex) {
    this.rect(x, y, w, 1, hex);
  }

  vline(x, y, h, hex) {
    this.rect(x, y, 1, h, hex);
  }

  /** Stamp ASCII art. legend maps char -> hex; "." and " " are transparent. */
  stamp(lines, legend, ox, oy) {
    for (let y = 0; y < lines.length; y++) {
      const row = lines[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === "." || ch === " ") continue;
        this.px(ox + x, oy + y, legend[ch]);
      }
    }
  }

  /** Lowest opaque row, or -1 when the canvas is empty. */
  bottomMost() {
    for (let y = this.h - 1; y >= 0; y--) {
      for (let x = 0; x < this.w; x++) {
        if (this.data[(y * this.w + x) * 4 + 3] !== 0) return y;
      }
    }
    return -1;
  }

  /** Highest opaque row, or -1 when the canvas is empty. */
  topMost() {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.data[(y * this.w + x) * 4 + 3] !== 0) return y;
      }
    }
    return -1;
  }

  /** Shifts everything down so the lowest pixel rests on the ground line. */
  dropToGround(groundY) {
    const bottom = this.bottomMost();
    const dy = groundY - 1 - bottom;
    if (bottom < 0 || dy <= 0) return;
    for (let y = this.h - 1; y >= 0; y--) {
      for (let x = 0; x < this.w; x++) {
        const src = y - dy;
        const di = (y * this.w + x) * 4;
        if (src < 0) {
          this.data[di + 3] = 0;
          continue;
        }
        const si = (src * this.w + x) * 4;
        this.data[di] = this.data[si];
        this.data[di + 1] = this.data[si + 1];
        this.data[di + 2] = this.data[si + 2];
        this.data[di + 3] = this.data[si + 3];
      }
    }
  }

  /**
   * Radial-ish gradient for flat shapes: pixels on the silhouette edge get
   * rings[0], the next ring inward gets rings[1], the rest stays as drawn.
   */
  ringShade(rings) {
    const opaque = (x, y) =>
      x >= 0 && y >= 0 && x < this.w && y < this.h &&
      this.data[(y * this.w + x) * 4 + 3] !== 0;
    const depth = new Int16Array(this.w * this.h).fill(-1);
    let frontier = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!opaque(x, y)) continue;
        const onEdge =
          !opaque(x - 1, y) || !opaque(x + 1, y) ||
          !opaque(x, y - 1) || !opaque(x, y + 1);
        if (onEdge) {
          depth[y * this.w + x] = 0;
          frontier.push([x, y]);
        }
      }
    }
    for (let d = 1; d < rings.length && frontier.length; d++) {
      const next = [];
      for (const [fx, fy] of frontier) {
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const x = fx + dx;
          const y = fy + dy;
          if (!opaque(x, y) || depth[y * this.w + x] !== -1) continue;
          depth[y * this.w + x] = d;
          next.push([x, y]);
        }
      }
      frontier = next;
    }
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const d = depth[y * this.w + x];
        if (d >= 0 && d < rings.length) this.px(x, y, rings[d]);
      }
    }
  }

  blit(src, ox, oy) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4;
        if (src.data[i + 3] === 0) continue;
        const xx = ox + x;
        const yy = oy + y;
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        const j = (yy * this.w + xx) * 4;
        src.data.copy(this.data, j, i, i + 4);
      }
    }
  }
}

function upscale(src, scale) {
  const out = Buffer.alloc(src.w * scale * src.h * scale * 4);
  const ow = src.w * scale;
  for (let y = 0; y < src.h * scale; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < src.w * scale; x++) {
      const sx = Math.floor(x / scale);
      const i = (sy * src.w + sx) * 4;
      const j = (y * ow + x) * 4;
      src.data.copy(out, j, i, i + 4);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Shared accessory stamps                                             */
/* ------------------------------------------------------------------ */

const INK = "#2b2724";
const PAPER = "#f6ecd2";

function drawLaptop(c, frame, cx, groundY, accent) {
  const x = cx - 8;
  const y = groundY - 7;
  // lid + screen
  c.rect(x, y - 1, 16, 7, "#33302c");
  c.rect(x + 1, y, 14, 5, "#1d1f24");
  // code lines: grow with frames
  const lineColors = [accent, "#8fd0a8", "#e8c468"];
  const widths = [
    [5, 3, 0],
    [7, 3, 2],
    [7, 5, 4],
    [4, 5, 6],
  ][frame % 4];
  for (let i = 0; i < 3; i++) {
    if (widths[i] > 0) c.hline(x + 2 + (i === 1 ? 2 : 0), y + 1 + i, widths[i], lineColors[i]);
  }
  // base / keyboard deck
  c.rect(x - 1, y + 6, 18, 2, "#d8d0c6");
  c.hline(x, y + 6, 16, "#bfb6a9");
}

function drawBook(c, frame, cx, groundY) {
  const x = cx - 7;
  const y = groundY - 6;
  c.rect(x, y, 7, 6, PAPER);
  c.rect(x + 7, y, 7, 6, "#ead394");
  c.vline(x + 7, y - 1, 7, "#6e4e2a");
  c.hline(x + 1, y + 1, 4, "#9a733d");
  c.hline(x + 8, y + 1, 4, "#9a733d");
  c.hline(x + 1, y + 3, 3, "#9a733d");
  if (frame === 2) {
    // page mid-flip
    c.rect(x + 4, y - 3, 3, 4, "#fffbee");
  }
  if (frame === 3) {
    c.hline(x + 8, y + 3, 4, "#9a733d");
  }
}

function drawPhone(c, frame, sideX, groundY) {
  const x = sideX;
  const y = groundY - 12;
  c.rect(x, y, 5, 8, "#2b2724");
  const glow = frame % 2 === 0 ? "#9ed7d4" : "#c8f4ec";
  c.rect(x + 1, y + 1, 3, 5, glow);
  if (frame >= 2) c.px(x + 2, y + 2, "#ffffff");
  c.px(x + 2, y + 6, "#f4e7d2");
}

function drawBox(c, frame, cx, groundY, accent) {
  const dy = frame % 2;
  const x = cx - 7;
  const y = groundY - 13 + dy;
  c.rect(x, y, 14, 8, "#e8c87f");
  c.rect(x, y, 14, 2, accent);
  c.rect(x + 6, y, 2, 8, accent);
  c.hline(x + 1, y + 4, 3, "#c9a55c");
  c.hline(x + 10, y + 5, 3, "#c9a55c");
}

function drawBroom(c, frame, cx, groundY) {
  const sway = [-2, 0, 2, 0][frame % 4];
  const hx = cx + 7 + sway;
  c.vline(hx, groundY - 12, 10, "#8b6538");
  c.vline(hx + 1, groundY - 12, 10, "#a37c46");
  c.rect(hx - 2 + Math.round(sway / 2), groundY - 3, 6, 2, "#e8c87f");
  c.rect(hx - 3 + sway, groundY - 1, 8, 2, "#d4a85c");
  // dust motes
  if (frame % 2 === 0) {
    c.px(hx - 4 + sway, groundY, "#c9bfae");
    c.px(hx + 6 + sway, groundY - 1, "#c9bfae");
  } else {
    c.px(hx - 5 + sway, groundY - 2, "#d8cfbf");
  }
}

function drawCookie(c, frame, cx, mouthY) {
  const x = cx + 4;
  const y = mouthY - 1;
  if (frame >= 3) {
    // crumbs only
    c.px(x, y + 3, "#b8854a");
    c.px(x + 3, y + 4, "#b8854a");
    c.px(x + 1, y + 5, "#9a6c3a");
    return;
  }
  const bite = frame; // 0,1,2 -> progressively eaten
  c.rect(x, y, 5 - bite, 5, "#e0a85c");
  c.rect(x + 1, y + 1, Math.max(0, 3 - bite), 3, "#efc06d");
  c.px(x + 1, y + 1, "#7d5723");
  if (bite < 2) c.px(x + 3 - bite, y + 3, "#7d5723");
  if (bite > 0) c.px(x + 5 - bite, y + 4, "#b8854a");
}

function drawBlocks(c, frame, cx, groundY, accent, accessory) {
  const x = cx + 6;
  c.rect(x, groundY - 3, 5, 4, accessory);
  c.px(x + 1, groundY - 2, "#ffffff");
  if (frame >= 1) {
    c.rect(x, groundY - 7, 5, 4, accent);
    c.px(x + 1, groundY - 6, "#ffffff");
  }
  if (frame >= 2) {
    c.rect(x + 1, groundY - 11, 5, 4, "#7fb6d9");
    c.px(x + 2, groundY - 10, "#ffffff");
  }
  if (frame === 3) {
    c.px(x + 6, groundY - 13, "#e8c468");
    c.px(x - 1, groundY - 9, "#e8c468");
  }
}

function drawJuggleBalls(c, frame, cx, topY, accent, accessory) {
  // three balls rotating through four positions over the head
  const orbit = [
    [
      [-8, 6],
      [0, 0],
      [8, 6],
    ],
    [
      [-6, 2],
      [6, 1],
      [7, 8],
    ],
    [
      [0, 0],
      [8, 6],
      [-8, 6],
    ],
    [
      [6, 1],
      [7, 8],
      [-6, 2],
    ],
  ][frame % 4];
  const colors = [accent, accessory, "#7fb6d9"];
  orbit.forEach(([dx, dy], i) => {
    c.rect(cx + dx - 1, topY + dy, 3, 3, colors[i]);
    c.px(cx + dx - 1, topY + dy, "#ffffff");
  });
}

function drawSparkles(c, frame, cx, topY, accent, accessory) {
  const a = frame % 2 === 0;
  const set = a
    ? [
        [-11, 4, accessory],
        [11, 2, accent],
        [0, -2, "#ffe9a8"],
      ]
    : [
        [-9, -1, accent],
        [9, 6, "#ffe9a8"],
        [-2, 1, accessory],
      ];
  for (const [dx, dy, col] of set) {
    const x = cx + dx;
    const y = topY + dy;
    c.px(x, y - 1, col);
    c.px(x, y + 1, col);
    c.px(x - 1, y, col);
    c.px(x + 1, y, col);
    if (a) c.px(x, y, "#ffffff");
  }
  // confetti specks
  c.px(cx + (a ? -13 : 13), topY + 8, accent);
  c.px(cx + (a ? 12 : -12), topY + 10, accessory);
}

function drawAlert(c, frame, cx, topY) {
  const x = cx + 8;
  const y = topY - 2 + (frame % 2);
  c.rect(x, y, 6, 6, "#2b2112");
  c.rect(x + 1, y + 1, 4, 4, frame % 2 === 0 ? "#f05f57" : "#ff7a6e");
  c.px(x + 2, y + 1, "#fff1d6");
  c.px(x + 3, y + 1, "#fff1d6");
  c.px(x + 2, y + 2, "#fff1d6");
  c.px(x + 3, y + 2, "#fff1d6");
  c.px(x + 2, y + 4, "#fff1d6");
  c.px(x + 3, y + 4, "#fff1d6");
}

function drawSweatDrop(c, frame, headX, headY) {
  const y = headY + (frame % 2);
  c.px(headX, y, "#9ed4ef");
  c.px(headX, y + 1, "#9ed4ef");
  c.px(headX - 1, y + 1, "#cdeefb");
}

function drawThoughtBubble(c, frame, cx, topY) {
  const x = cx + 5;
  const y = Math.max(0, topY - 9);
  c.rect(x + 1, y, 10, 5, "#fffdfa");
  c.hline(x + 2, y - 1, 8, "#fffdfa");
  c.hline(x + 2, y + 5, 8, "#fffdfa");
  c.px(x, y + 6, "#fffdfa");
  c.px(x - 1, y + 8, "#fffdfa");
  const on = "#34302b";
  const off = "#cfc8bd";
  const active = frame % 4;
  c.px(x + 3, y + 2, active >= 1 ? on : off);
  c.px(x + 6, y + 2, active >= 2 ? on : off);
  c.px(x + 9, y + 2, active >= 3 ? on : off);
}

function drawKeyboard(c, frame, cx, groundY, accent) {
  const x = cx - 7;
  const y = groundY - 4;
  c.rect(x, y, 14, 4, "#3a363f");
  for (let i = 0; i < 6; i++) {
    const lit = (i + frame) % 3 === 0;
    c.px(x + 1 + i * 2, y + 1, lit ? accent : "#6b6675");
    c.px(x + 2 + i * 2, y + 2, (i + frame) % 4 === 1 ? "#8f8a9c" : "#55505f");
  }
  // typing dots above
  const bx = cx + 6;
  const by = groundY - 22 < 0 ? 0 : groundY - 22;
  c.rect(bx, by, 7, 4, "#fffdfa");
  c.px(bx - 1, by + 5, "#fffdfa");
  const active = frame % 4;
  c.px(bx + 1, by + 1, active >= 1 ? "#34302b" : "#cfc8bd");
  c.px(bx + 3, by + 1, active >= 2 ? "#34302b" : "#cfc8bd");
  c.px(bx + 5, by + 1, active >= 3 ? "#34302b" : "#cfc8bd");
}

function drawZzz(c, frame, cx, topY) {
  const phase = frame % 4;
  const zs = [
    { x: cx + 6, y: topY + 4, size: 2 },
    { x: cx + 9, y: topY, size: 3 },
    { x: cx + 13, y: Math.max(0, topY - 5), size: 4 },
  ];
  zs.forEach((z, i) => {
    if ((i + phase) % 4 === 3) return; // twinkle out
    const col = i === 2 ? "#cdc4b4" : i === 1 ? "#b8ae9c" : "#a39884";
    drawPixelZ(c, z.x, z.y, z.size, col);
  });
}

function drawPixelZ(c, x, y, size, col) {
  c.hline(x, y, size, col);
  for (let d = 0; d < size - 2; d++) c.px(x + size - 2 - d, y + 1 + d, col);
  c.hline(x, y + size - 1, size, col);
}

function drawBlinkHissSnoreMarks(c, frame, palette) {
  const phase = frame % 4;
  const light = palette.sclera;
  const mid = "#d4ccb9";
  const dark = "#a39884";

  if (phase === 0) {
    c.px(23, 20, light);
    c.px(24, 20, mid);
  } else if (phase === 1) {
    c.rect(23, 18, 2, 2, light);
    c.px(22, 19, mid);
    c.px(25, 19, mid);
  } else if (phase === 2) {
    c.rect(24, 15, 2, 2, light);
    c.px(23, 16, mid);
    c.px(26, 16, mid);
  } else {
    c.px(25, 12, mid);
  }

  if (phase !== 0) drawPixelZ(c, 24, 9, 2, dark);
  if (phase >= 2) drawPixelZ(c, 27, 6, 3, mid);
}

function drawBlinkHissDeepSleepMarks(c, frame, palette) {
  const shift = frame % 2;
  const mid = "#d4ccb9";
  const dark = "#a39884";
  c.px(23 + shift, 15, palette.sclera);
  c.px(24 + shift, 15, mid);
  drawPixelZ(c, 25 + shift, 9, 2, dark);
  if (shift) drawPixelZ(c, 27, 6, 3, mid);
}

function drawBell(c, frame, cx, topY) {
  const tilt = frame % 2 === 0 ? -1 : 1;
  const x = cx - 3 + tilt;
  const y = Math.max(0, topY - 8);
  c.px(x + 2, y, "#2b2112");
  c.px(x + 3, y, "#2b2112");
  c.rect(x + 1, y + 1, 4, 2, "#f4c84f");
  c.rect(x, y + 3, 6, 2, "#f4c84f");
  c.hline(x - 1, y + 5, 8, "#e3a82f");
  c.px(x + 2 + tilt, y + 6, "#c8922f");
  // ring marks
  c.px(x - 3, y + 2, "#f4c84f");
  c.px(x + 8, y + 2, "#f4c84f");
  if (frame % 2 === 0) {
    c.px(x - 4, y + 4, "#e3a82f");
  } else {
    c.px(x + 9, y + 4, "#e3a82f");
  }
}

/* ------------------------------------------------------------------ */
/* Expression eye helpers (baked into body frames)                     */
/* ------------------------------------------------------------------ */

function bakeXEyes(c, eyeSpec, dy = 0) {
  for (const [x, y0] of eyeSpec.centers) {
    const y = y0 + dy;
    c.px(x - 1, y - 1, eyeSpec.ink);
    c.px(x + 1, y - 1, eyeSpec.ink);
    c.px(x, y, eyeSpec.ink);
    c.px(x - 1, y + 1, eyeSpec.ink);
    c.px(x + 1, y + 1, eyeSpec.ink);
  }
}

function bakeSquintEyes(c, eyeSpec, dy = 0) {
  for (const [x, y0] of eyeSpec.centers) {
    const y = y0 + dy;
    c.px(x - 1, y - 1, eyeSpec.ink);
    c.px(x, y, eyeSpec.ink);
    c.px(x + 1, y - 1, eyeSpec.ink);
    c.px(x - 1, y + 1, eyeSpec.ink);
    c.px(x + 1, y + 1, eyeSpec.ink);
  }
}

function drawDustSquareEyeSocket(c, x, y, hex, cornerHex = hex) {
  c.rect(x - 3, y - 3, 6, 6, hex);
  c.px(x - 3, y - 3, cornerHex);
  c.px(x + 2, y - 3, cornerHex);
  c.px(x - 3, y + 2, cornerHex);
  c.px(x + 2, y + 2, cornerHex);
}

function drawDustCenteredPupil(c, x, y, hex) {
  c.rect(x - 1, y - 1, 2, 2, hex);
}

/* ------------------------------------------------------------------ */
/* The six pets                                                        */
/* ------------------------------------------------------------------ */
/* Pose contract:
 *  p = {
 *    legs: "stand" | "walkA" | "walkB" | "walkC" | "walkD" | "sleep",
 *    arms: "down" | "up" | "swingA" | "swingB" | "cheer" | "cheerLow" | "hold",
 *    mouth: "smile" | "open" | "flat" | "o" | "yawn" | "wavy" | "grin",
 *    eyes: "socket" (overlay handles) | "closed" | "half" | "x" | "squint" | "wide",
 *    squash: 0 | 1 (sleep squash baked into shape)
 *  }
 */

const WALK_LEG_PHASE = { walkA: 0, walkB: 1, walkC: 2, walkD: 3 };

/** pet-1 Claude Pixel: flat coral rounded-square critter, four stub legs. */
const claudePixel = {
  id: "pet-1",
  anchors: { cx: 16, groundY: 29, topY: 7, mouthY: 18, headX: 24, sideX: 25 },
  palette: {
    body: "#f08a62",
    dark: "#d86444",
    ink: "#1a1410",
  },
  eyeSpec: {
    ink: "#1a1410",
    centers: [
      [11, 14],
      [20, 14],
    ],
  },
  body(c, p) {
    const P = this.palette;
    const sq = p.squash ?? 0;
    const top = 8 + sq;
    const bot = 24;
    // flat rounded square (two-step corners top and bottom)
    c.rect(7, top, 18, 1, P.body);
    c.rect(6, top + 1, 20, 1, P.body);
    c.rect(5, top + 2, 22, bot - top - 4, P.body);
    c.rect(6, bot - 2, 20, 1, P.body);
    c.rect(7, bot - 1, 18, 1, P.body);
    // arms (side nubs)
    const armY = { down: 13, up: 9, swingA: 12, swingB: 14, cheer: 8, cheerLow: 11, hold: 10 }[p.arms] ?? 13;
    c.rect(3, armY + sq, 2, 3, P.body);
    c.rect(27, armY + sq, 2, 3, P.body);
    // legs: four stubs
    const phase = WALK_LEG_PHASE[p.legs];
    const legXs = [6, 12, 17, 23];
    if (p.legs === "sleep") {
      c.rect(7, bot, 7, 2, P.dark);
      c.rect(18, bot, 7, 2, P.dark);
    } else if (p.legs !== "none") {
      legXs.forEach((lx, i) => {
        let dy = 0;
        let dx = 0;
        if (phase !== undefined) {
          const even = i % 2 === 0;
          const lifted = phase % 2 === 0 ? even : !even;
          dy = lifted ? -1 : 0;
          dx = lifted ? (phase < 2 ? 1 : -1) : 0;
        }
        c.rect(lx + dx, bot + dy, 3, 5, P.dark);
      });
    }
    // mouth
    this.mouth(c, p.mouth, sq);
  },
  mouth(c, kind, sq = 0) {
    const P = this.palette;
    const y = 18 + (sq >> 1);
    if (kind === "open" || kind === "yawn") {
      c.rect(14, y - 1, 4, kind === "yawn" ? 5 : 4, P.ink);
      c.rect(15, y + (kind === "yawn" ? 2 : 1), 2, 2, "#a8453a");
    } else if (kind === "o") {
      c.rect(15, y, 2, 2, P.ink);
    } else if (kind === "wavy") {
      c.px(13, y, P.ink);
      c.px(14, y + 1, P.ink);
      c.px(15, y, P.ink);
      c.px(16, y + 1, P.ink);
      c.px(17, y, P.ink);
    }
    // smile / grin / flat: mouthless resting face
  },
  eyes(c, variant, dy = 0) {
    const E = this.eyeSpec;
    for (const [x, y0] of E.centers) {
      const y = y0 + dy;
      if (variant === "closed") {
        c.hline(x - 2, y + 1, 4, E.ink);
      } else if (variant === "half") {
        c.rect(x - 2, y, 4, 3, E.ink);
      } else if (variant === "happy") {
        c.px(x - 2, y, E.ink);
        c.px(x - 1, y - 1, E.ink);
        c.px(x, y - 1, E.ink);
        c.px(x + 1, y, E.ink);
      } else if (variant === "wide") {
        // startled: the tall square eye blown up one step
        c.rect(x - 2, y - 3, 5, 6, E.ink);
        c.rect(x - 1, y - 2, 2, 2, "#f6e7d7");
      } else {
        // tall rectangular terminal eyes
        c.rect(x - 2, y - 2, 4, 5, E.ink);
        c.px(x - 1, y - 1, "#f6e7d7");
      }
    }
  },
};

/** pet-2 Spark Bolt Pal: round amber buddy with a springy lightning ahoge. */
const sparkBolt = {
  id: "pet-2",
  anchors: { cx: 16, groundY: 29, topY: 6, mouthY: 20, headX: 23, sideX: 24 },
  palette: {
    body: "#f6cf2e",
    dark: "#d9a922",
    ink: "#241c12",
    spark: "#f08c3a",
    blush: "#f6a04c",
    flash: "#fff3b8",
  },
  eyeSpec: {
    ink: "#241c12",
    centers: [
      [12, 15],
      [19, 15],
    ],
  },
  body(c, p) {
    const P = this.palette;
    const sq = p.squash ?? 0;
    const top = 10 + sq;
    const bot = 26;
    // single springy lightning ahoge, swaying with the walk
    const sway = p.legs === "walkB" || p.legs === "walkD" ? 1 : 0;
    if (!p.squash) {
      const ax = 16 + sway;
      c.px(ax, top - 1, P.spark);
      c.px(ax + 1, top - 2, P.spark);
      c.px(ax, top - 3, P.spark);
      c.px(ax + 1, top - 4, P.spark);
      c.px(ax + 1, top - 3, P.flash);
    } else {
      // ahoge flops over when resting
      c.px(17, top - 1, P.spark);
      c.px(18, top - 2, P.spark);
      c.px(19, top - 1, P.spark);
    }
    // flat round body (two-step corners top and bottom)
    c.rect(9, top, 14, 1, P.body);
    c.rect(7, top + 1, 18, 1, P.body);
    c.rect(6, top + 2, 20, bot - top - 4, P.body);
    c.rect(7, bot - 2, 18, 1, P.body);
    c.rect(9, bot - 1, 14, 1, P.body);
    // soft round blush with a sparkle
    for (const cx0 of [8, 22]) {
      c.rect(cx0, 19 + (sq >> 1), 2, 2, P.blush);
    }
    c.px(8, 19 + (sq >> 1), P.flash);
    // arms
    const armY = { down: 16, up: 12, swingA: 15, swingB: 17, cheer: 10, cheerLow: 13, hold: 13 }[p.arms] ?? 16;
    c.rect(4, armY + sq, 2, 3, P.body);
    c.rect(26, armY + sq, 2, 3, P.body);
    if (p.arms === "cheer") {
      c.rect(3, armY - 2 + sq, 2, 3, P.body);
      c.rect(27, armY - 2 + sq, 2, 3, P.body);
    }
    // legs
    const phase = WALK_LEG_PHASE[p.legs];
    if (p.legs === "sleep") {
      c.rect(9, bot, 6, 2, P.dark);
      c.rect(17, bot, 6, 2, P.dark);
    } else if (p.legs !== "none") {
      const legs = [
        [9, 0],
        [19, 1],
      ];
      legs.forEach(([lx, parity]) => {
        let dy = 0;
        let dx = 0;
        if (phase !== undefined) {
          const lifted = phase % 2 === 0 ? parity === 0 : parity === 1;
          dy = lifted ? -1 : 0;
          dx = lifted ? (phase < 2 ? 1 : -1) : 0;
        }
        c.rect(lx + dx, bot + dy, 4, 3, P.dark);
      });
    }
    this.mouth(c, p.mouth, sq);
  },
  mouth(c, kind, sq = 0) {
    const P = this.palette;
    const y = 20 + (sq >> 1);
    if (kind === "none") {
      return;
    }
    if (kind === "open" || kind === "yawn") {
      c.rect(14, y - 1, 4, kind === "yawn" ? 4 : 3, P.ink);
      c.rect(15, y + 1, 2, 1, "#b04a3c");
    } else if (kind === "o") {
      c.rect(15, y - 1, 2, 2, P.ink);
    } else if (kind === "flat") {
      c.hline(15, y, 3, P.ink);
    } else if (kind === "wavy") {
      c.hline(15, y, 3, P.ink);
    } else if (kind === "grin") {
      c.hline(14, y - 1, 4, P.ink);
      c.hline(15, y, 2, "#b04a3c");
    } else {
      // tiny centered mouth
      c.hline(15, y, 3, P.ink);
    }
  },
  eyes(c, variant, dy = 0) {
    const E = this.eyeSpec;
    for (const [x, y0] of E.centers) {
      const y = y0 + dy;
      if (variant === "closed") {
        c.hline(x - 2, y + 1, 5, E.ink);
      } else if (variant === "half") {
        c.rect(x - 2, y, 5, 2, E.ink);
      } else if (variant === "happy") {
        c.px(x - 2, y, E.ink);
        c.hline(x - 1, y - 1, 3, E.ink);
        c.px(x + 2, y, E.ink);
      } else if (variant === "wide") {
        // startled: the big round eye opens even wider
        c.rect(x - 1, y - 3, 3, 7, E.ink);
        c.vline(x - 2, y - 2, 5, E.ink);
        c.vline(x + 2, y - 2, 5, E.ink);
        c.rect(x - 1, y - 2, 2, 2, "#ffffff");
      } else {
        // big rounded kawaii eyes with a double highlight
        c.rect(x - 1, y - 2, 3, 5, E.ink);
        c.vline(x - 2, y - 1, 3, E.ink);
        c.vline(x + 2, y - 1, 3, E.ink);
        c.rect(x - 1, y - 1, 2, 2, "#ffffff");
        c.px(x + 1, y + 1, "#8a6d1c");
      }
    }
  },
};

/** pet-3 Star Puff: round pink dream pal with a star bobble and plum feet. */
const starPuff = {
  id: "pet-3",
  anchors: { cx: 16, groundY: 29, topY: 6, mouthY: 18, headX: 23, sideX: 24 },
  palette: {
    body: "#f88ba3",
    ink: "#27224d",
    cheek: "#ef5d7d",
    boot: "#a85ec0",
    star: "#ffd75e",
  },
  eyeSpec: {
    ink: "#27224d",
    centers: [
      [12, 15],
      [19, 15],
    ],
  },
  body(c, p) {
    const P = this.palette;
    const sq = p.squash ?? 0;
    const top = 8 + sq;
    const bot = 26;
    // star bobble floating off the crown (folds away when resting)
    if (!p.squash) {
      const bobX = 21;
      const bobY = top - 4;
      c.px(bobX, bobY - 1, P.star);
      c.hline(bobX - 1, bobY, 3, P.star);
      c.px(bobX, bobY + 1, P.star);
      c.px(bobX, bobY, "#fff7d6");
      c.px(20, top - 1, P.boot);
    } else {
      c.px(22, top - 2, P.star);
      c.px(21, top - 1, P.star);
    }
    // flat round puff (three-step corners for a circle feel)
    c.rect(11, top - 1, 10, 1, P.body);
    c.rect(9, top, 14, 1, P.body);
    c.rect(7, top + 1, 18, 2, P.body);
    c.rect(6, top + 3, 20, 1, P.body);
    c.rect(5, top + 4, 22, bot - top - 7, P.body);
    c.rect(6, bot - 3, 20, 1, P.body);
    c.rect(7, bot - 2, 18, 1, P.body);
    c.rect(9, bot - 1, 14, 1, P.body);
    // star-spark cheeks
    const cy = 18 + (sq >> 1);
    for (const cx0 of [8, 23]) {
      c.px(cx0, cy, P.cheek);
      c.px(cx0 - 1, cy + 1, P.cheek);
      c.px(cx0 + 1, cy + 1, P.cheek);
      c.px(cx0, cy + 2, P.cheek);
    }
    // arms: round side bumps
    const armY = { down: 14, up: 10, swingA: 13, swingB: 15, cheer: 9, cheerLow: 12, hold: 11 }[p.arms] ?? 14;
    c.rect(3, armY + sq, 3, 4, P.body);
    c.rect(26, armY + sq, 3, 4, P.body);
    // plum rounded feet
    const phase = WALK_LEG_PHASE[p.legs];
    if (p.legs === "sleep") {
      c.rect(8, bot, 7, 2, P.boot);
      c.rect(17, bot, 7, 2, P.boot);
    } else if (p.legs !== "none") {
      const boots = [
        [7, 0],
        [19, 1],
      ];
      boots.forEach(([lx, parity]) => {
        let dy = 0;
        let dx = 0;
        if (phase !== undefined) {
          const lifted = phase % 2 === 0 ? parity === 0 : parity === 1;
          dy = lifted ? -1 : 0;
          dx = lifted ? (phase < 2 ? 1 : -1) : 0;
        }
        c.rect(lx + dx, bot + dy, 6, 3, P.boot);
        c.clearRect(lx + dx, bot + 2 + dy, 1, 1);
        c.clearRect(lx + dx + 5, bot + 2 + dy, 1, 1);
      });
    }
    this.mouth(c, p.mouth, sq);
  },
  mouth(c, kind, sq = 0) {
    const P = this.palette;
    const y = 20 + (sq >> 1);
    if (kind === "none") {
      return;
    }
    if (kind === "open" || kind === "yawn") {
      c.rect(14, y - 1, 4, kind === "yawn" ? 5 : 4, "#8e2342");
      c.rect(15, y + 1, 2, 2, "#e26a8a");
    } else if (kind === "o") {
      c.rect(15, y, 2, 2, "#8e2342");
    } else if (kind === "flat") {
      c.hline(14, y, 4, P.ink);
    } else if (kind === "wavy") {
      c.px(13, y, P.ink);
      c.px(14, y - 1, P.ink);
      c.px(15, y, P.ink);
      c.px(16, y - 1, P.ink);
      c.px(17, y, P.ink);
    } else if (kind === "grin") {
      c.px(12, y - 1, P.ink);
      c.hline(13, y, 6, P.ink);
      c.px(19, y - 1, P.ink);
      c.hline(14, y + 1, 4, "#8e2342");
    } else {
      // compact smile kept clear of the tall eyes
      c.px(14, y, P.ink);
      c.hline(15, y + 1, 2, P.ink);
      c.px(17, y, P.ink);
    }
  },
  eyes(c, variant, dy = 0) {
    const E = this.eyeSpec;
    for (const [x, y0] of E.centers) {
      const y = y0 + dy;
      if (variant === "closed") {
        c.px(x - 2, y, E.ink);
        c.hline(x - 1, y + 1, 3, E.ink);
        c.px(x + 2, y, E.ink);
      } else if (variant === "half") {
        c.rect(x - 1, y, 3, 2, E.ink);
        c.px(x - 1, y, "#5d6fc4");
      } else if (variant === "happy") {
        c.px(x - 2, y, E.ink);
        c.hline(x - 1, y - 1, 3, E.ink);
        c.px(x + 2, y, E.ink);
      } else if (variant === "wide") {
        // startled: the dreamy oval flares fully open
        c.rect(x - 1, y - 4, 3, 9, E.ink);
        c.vline(x - 2, y - 3, 7, E.ink);
        c.vline(x + 2, y - 3, 7, E.ink);
        c.rect(x - 1, y - 3, 2, 3, "#ffffff");
        c.px(x + 1, y + 2, "#5d6fc4");
      } else {
        // big dreamy oval eyes with starlight
        c.rect(x - 1, y - 3, 3, 7, E.ink);
        c.vline(x - 2, y - 2, 5, E.ink);
        c.vline(x + 2, y - 2, 5, E.ink);
        c.rect(x - 1, y - 2, 2, 2, "#ffffff");
        c.px(x + 1, y + 1, "#5d6fc4");
        c.px(x, y + 2, "#8d7fd4");
      }
    }
  },
};

function drawCyclopsSclera(c, x, y, sclera) {
  c.rect(x - 2, y - 4, 5, 1, sclera);
  c.rect(x - 3, y - 3, 7, 1, sclera);
  c.rect(x - 4, y - 2, 9, 5, sclera);
  c.rect(x - 3, y + 3, 7, 1, sclera);
  c.rect(x - 2, y + 4, 5, 1, sclera);
}

function drawCyclopsEyeCore(c, x, y, palette) {
  c.rect(x - 1, y - 2, 3, 5, palette.iris);
  c.vline(x - 2, y - 1, 3, palette.iris);
  c.vline(x + 2, y - 1, 3, palette.iris);
  c.rect(x - 1, y - 1, 3, 3, palette.ink);
  c.px(x + 1, y - 2, palette.highlight);
}

/** pet-4 Blink Hiss: one-eyed green plankton sprite with curly antennae. */
const blockHiss = {
  id: "pet-4",
  anchors: { cx: 16, groundY: 29, topY: 3, mouthY: 20, headX: 22, sideX: 23 },
  palette: {
    body: "#5cb14c",
    dark: "#449a3c",
    moss: "#6fc05c",
    stem: "#33773a",
    sclera: "#f2f6e4",
    iris: "#2f7d33",
    highlight: "#dff0d0",
    ink: "#161812",
  },
  eyeSpec: {
    ink: "#161812",
    centers: [[15, 14]],
  },
  body(c, p) {
    const P = this.palette;
    const sq = p.squash ?? 0;
    const top = 7 + sq;
    const bot = 26;
    // two thin antennae curling outward, swaying with the walk
    const sway = p.legs === "walkB" || p.legs === "walkD" ? 1 : 0;
    if (!p.squash) {
      c.px(12, top - 1, P.stem);
      c.px(11, top - 2, P.stem);
      c.px(10 - sway, top - 3, P.stem);
      c.px(10 - sway, top - 4, P.dark);
      c.px(19, top - 1, P.stem);
      c.px(20, top - 2, P.stem);
      c.px(21 + sway, top - 3, P.stem);
      c.px(21 + sway, top - 4, P.dark);
    } else {
      // antennae lie flat when resting
      c.hline(7, top - 1, 3, P.stem);
      c.hline(22, top - 1, 3, P.stem);
      c.px(6, top - 2, P.dark);
      c.px(25, top - 2, P.dark);
    }
    // vertical rounded capsule body
    c.rect(12, top, 8, 1, P.body);
    c.rect(11, top + 1, 10, 1, P.body);
    c.rect(10, top + 2, 12, bot - top - 4, P.body);
    c.rect(11, bot - 2, 10, 1, P.body);
    c.rect(12, bot - 1, 8, 1, P.body);
    // moss freckles
    c.px(11, 20 + (sq >> 1), P.moss);
    c.px(21, 19 + (sq >> 1), P.moss);
    c.px(12, 24, P.dark);
    // overlay rows receive a fixed sclera after accessories are composed
    // tiny side arms
    const armY = { down: 17, up: 13, swingA: 16, swingB: 18, cheer: 11, cheerLow: 14, hold: 14 }[p.arms] ?? 17;
    c.rect(8, armY + sq, 2, 3, P.body);
    c.rect(22, armY + sq, 2, 3, P.body);
    if (p.arms === "cheer") {
      c.rect(7, armY - 2 + sq, 2, 3, P.body);
      c.rect(23, armY - 2 + sq, 2, 3, P.body);
    }
    // feet: two stubs
    const phase = WALK_LEG_PHASE[p.legs];
    if (p.legs === "sleep") {
      c.rect(11, bot, 4, 2, P.dark);
      c.rect(17, bot, 4, 2, P.dark);
    } else if (p.legs !== "none") {
      const legs = [
        [11, 0],
        [17, 1],
      ];
      legs.forEach(([lx, parity]) => {
        let dy = 0;
        let dx = 0;
        if (phase !== undefined) {
          const lifted = phase % 2 === 0 ? parity === 0 : parity === 1;
          dy = lifted ? -1 : 0;
          dx = lifted ? (phase < 2 ? 1 : -1) : 0;
        }
        c.rect(lx + dx, bot + dy, 4, 3, P.dark);
      });
    }
    this.mouth(c, p.mouth, sq);
  },
  sleepFrame(frame) {
    const c = new Px();
    const breathing = frame % 2;
    const squash = 4 + breathing;
    this.body(c, {
      legs: "sleep",
      arms: "down",
      mouth: frame === 3 ? "flat" : "o",
      squash,
    }, frame);
    this.eyes(c, "closed", 3 + breathing);
    c.dropToGround(this.anchors.groundY);
    drawBlinkHissSnoreMarks(c, frame, this.palette);
    return c;
  },
  sleepDeepFrame(frame) {
    const c = new Px();
    this.body(c, { legs: "none", arms: "down", mouth: "none", squash: 8 }, frame);
    this.eyes(c, "closed", 5);
    c.dropToGround(this.anchors.groundY);
    drawBlinkHissDeepSleepMarks(c, frame, this.palette);
    return c;
  },
  mouth(c, kind, sq = 0) {
    const P = this.palette;
    const y = 20 + (sq >> 1);
    if (kind === "none") {
      return;
    }
    if (kind === "open" || kind === "yawn") {
      c.rect(14, y - 1, 4, kind === "yawn" ? 4 : 3, P.ink);
      c.rect(15, y + 1, 2, 1, "#2e5a28");
    } else if (kind === "o") {
      c.rect(15, y - 1, 2, 2, P.ink);
    } else if (kind === "flat") {
      c.hline(14, y, 3, P.ink);
    } else if (kind === "wavy") {
      c.hline(14, y, 3, P.ink);
    } else if (kind === "grin") {
      c.hline(14, y, 4, P.ink);
    } else {
      // tiny centered hiss mouth without the previous zigzag
      c.hline(14, y, 3, P.ink);
    }
  },
  // a big X across the whole cyclops eye when knocked out
  faintEyes(c) {
    const E = this.eyeSpec;
    const [[x, y]] = E.centers;
    for (let i = -2; i <= 2; i++) {
      c.px(x + i, y + i + 1, E.ink);
      c.px(x + i, y - i + 1, E.ink);
    }
  },
  overlayEyeSockets(c) {
    const P = this.palette;
    const [[x, y]] = this.eyeSpec.centers;
    drawCyclopsSclera(c, x, y, P.sclera);
  },
  overlayEyes(c, variant) {
    const E = this.eyeSpec;
    const P = this.palette;
    const [[x, y]] = E.centers;
    if (variant === "closed") {
      c.hline(x - 2, y, 5, E.ink);
      return;
    }
    if (variant === "half") {
      c.rect(x - 1, y, 2, 1, E.ink);
      return;
    }
    drawCyclopsEyeCore(c, x, y, P);
  },
  eyes(c, variant, dy = 0) {
    const E = this.eyeSpec;
    const P = this.palette;
    const [[x, y0]] = E.centers;
    const y = y0 + dy;
    if (variant === "closed") {
      drawCyclopsSclera(c, x, y, P.sclera);
      // opaque lid — no transparent gaps over the socket during blink
      c.rect(x - 4, y - 3, 9, 6, P.body);
      c.hline(x - 2, y, 5, E.ink);
      c.px(x - 3, y - 1, E.ink);
      c.px(x + 3, y - 1, E.ink);
    } else if (variant === "half") {
      drawCyclopsSclera(c, x, y, P.sclera);
      c.rect(x - 4, y - 4, 9, 3, P.body);
      c.rect(x - 3, y - 1, 7, 1, P.dark);
      drawCyclopsEyeCore(c, x, y + 1, P);
    } else if (variant === "happy") {
      drawCyclopsSclera(c, x, y, P.sclera);
      drawCyclopsEyeCore(c, x, y, P);
    } else if (variant === "wide") {
      drawCyclopsSclera(c, x, y, P.sclera);
      drawCyclopsEyeCore(c, x, y, P);
    } else {
      drawCyclopsSclera(c, x, y, P.sclera);
      drawCyclopsEyeCore(c, x, y, P);
    }
  },
};

/** pet-5 Peek Ghost: cute armless floating spirit with a scalloped hem. */
const peekGhost = {
  id: "pet-5",
  anchors: { cx: 16, groundY: 29, topY: 5, mouthY: 18, headX: 23, sideX: 24 },
  palette: {
    body: "#e4e9f6",
    mid: "#d0d8ec",
    edge: "#a4b0d2",
    ink: "#1c1a26",
    blush: "#f0a7bd",
    mouth: "#ec6189",
    mouthDeep: "#c23a60",
  },
  eyeSpec: {
    ink: "#1c1a26",
    centers: [
      [12, 13],
      [19, 13],
    ],
  },
  body(c, p, frame = 0) {
    const P = this.palette;
    const sq = p.squash ?? 0;
    const top = 6 + sq;
    // sleeping ghost settles down onto the ground; otherwise it floats
    const hemY = Math.min(24 + sq, 26);
    // round dome head (no arms: pure sheet silhouette)
    c.rect(12, top, 8, 1, P.body);
    c.rect(10, top + 1, 12, 1, P.body);
    c.rect(8, top + 2, 16, 1, P.body);
    c.rect(7, top + 3, 18, 1, P.body);
    c.rect(6, top + 4, 20, hemY - top - 4, P.body);
    // scalloped hem: five rounded lobes, alternating dip for the float sway
    const dip = frame % 2 === 1 ? 1 : 0;
    for (let i = 0; i < 5; i++) {
      const lx = 6 + i * 4;
      const lobeDy = i % 2 === (dip ? 1 : 0) ? 1 : 0;
      c.rect(lx, hemY, 4, 2 + lobeDy, P.body);
      c.rect(lx + 1, hemY + 2 + lobeDy, 2, 1, P.body);
    }
    // dangling tentacle arms, swaying opposite the hem
    if (sq < 2) {
      const armDy = dip;
      c.rect(4, 14 + armDy, 2, 4, P.body);
      c.px(4, 18 + armDy, P.body);
      c.rect(26, 14 + (1 - armDy), 2, 4, P.body);
      c.px(27, 18 + (1 - armDy), P.body);
    }
    // soft radial gradient: darker rim, lighter center, for contrast
    c.ringShade([P.edge, P.mid]);
    // blush
    c.rect(8, 15 + sq, 2, 2, P.blush);
    c.rect(22, 15 + sq, 2, 2, P.blush);
    this.mouth(c, p.mouth, sq);
  },
  // clicking the ghost gets a cheeky funny face instead of a shock pose
  shockFace(c, f) {
    const P = this.palette;
    const E = this.eyeSpec;
    this.body(c, { legs: "stand", arms: "down", mouth: "none" }, f);
    // left eye winks shut
    const [lx, ly] = E.centers[0];
    c.px(lx - 2, ly + 1, E.ink);
    c.hline(lx - 1, ly, 3, E.ink);
    c.px(lx + 2, ly + 1, E.ink);
    // right eye pops wide open
    const [rx, ry] = E.centers[1];
    c.rect(rx - 1, ry - 3, 3, 6, E.ink);
    c.vline(rx - 2, ry - 2, 4, E.ink);
    c.vline(rx + 2, ry - 2, 4, E.ink);
    c.rect(rx - 1, ry - 2, 2, 2, "#ffffff");
    // open mouth with a wiggling tongue sticking out
    c.rect(14, 18, 4, 2, P.mouthDeep);
    const tongueX = 15 + (f % 2);
    c.rect(tongueX, 20, 2, 2, P.mouth);
    c.px(tongueX, 22, P.mouth);
  },
  mouth(c, kind, sq = 0) {
    const P = this.palette;
    const y = 17 + (sq >> 1);
    if (kind === "open" || kind === "yawn" || kind === "smile" || kind === "grin") {
      // small happy open mouth (rounded corners)
      const h = kind === "yawn" ? 4 : 3;
      c.rect(14, y, 4, h, P.mouth);
      c.rect(15, y + h - 1, 2, 1, P.mouthDeep);
      c.px(14, y, P.body);
      c.px(17, y, P.body);
    } else if (kind === "o") {
      c.rect(15, y, 2, 2, P.mouth);
    } else if (kind === "flat") {
      c.hline(14, y + 1, 4, P.ink);
    } else if (kind === "wavy") {
      c.px(13, y + 1, P.ink);
      c.px(14, y + 2, P.ink);
      c.px(15, y + 1, P.ink);
      c.px(16, y + 2, P.ink);
      c.px(17, y + 1, P.ink);
    }
  },
  eyes(c, variant, dy = 0) {
    const E = this.eyeSpec;
    for (const [x, y0] of E.centers) {
      const y = y0 + dy;
      if (variant === "closed") {
        c.px(x - 2, y, E.ink);
        c.hline(x - 1, y + 1, 3, E.ink);
        c.px(x + 2, y, E.ink);
      } else if (variant === "half") {
        c.rect(x - 1, y, 3, 2, E.ink);
      } else if (variant === "happy") {
        c.px(x - 2, y, E.ink);
        c.px(x - 1, y - 1, E.ink);
        c.px(x, y - 1, E.ink);
        c.px(x + 1, y, E.ink);
      } else if (variant === "wide") {
        // startled: round eye pops into a big circle with a wide glint
        c.rect(x - 1, y - 4, 3, 8, E.ink);
        c.vline(x - 2, y - 3, 6, E.ink);
        c.vline(x + 2, y - 3, 6, E.ink);
        c.rect(x - 2, y - 3, 2, 2, "#ffffff");
        c.px(x + 1, y + 2, "#8d93ab");
      } else {
        // big rounded eyes with double highlight for detail
        c.rect(x - 1, y - 3, 3, 6, E.ink);
        c.px(x - 2, y - 2, E.ink);
        c.px(x + 2, y - 2, E.ink);
        c.px(x - 2, y + 1, E.ink);
        c.px(x + 2, y + 1, E.ink);
        c.rect(x - 1, y - 2, 1, 2, "#ffffff");
        c.px(x + 1, y + 1, "#8d93ab");
      }
    }
  },
};

/** pet-6 Dust Puff: round soot ball with soft fuzz and round saucer eyes. */
const dustPuff = {
  id: "pet-6",
  anchors: { cx: 16, groundY: 29, topY: 7, mouthY: 19, headX: 23, sideX: 24 },
  palette: {
    body: "#26262b",
    cream: "#f5efda",
    ink: "#15151a",
  },
  eyeSpec: {
    ink: "#15151a",
    centers: [
      [12, 17],
      [20, 17],
    ],
  },
  body(c, p, frame = 0) {
    const P = this.palette;
    const sq = p.squash ?? 0;
    // Slightly flattened coal-ball ellipse; squash still settles it into a puddle.
    const cy = 17 + Math.ceil(sq / 2);
    const ry = 9 - sq;
    const rx = 11 + (sq >> 1);
    // gentle hover bob while moving (no legs, no arms)
    const phase = WALK_LEG_PHASE[p.legs];
    const bob = phase !== undefined ? -(phase % 2) : 0;
    for (let y = cy - ry; y <= cy + ry; y++) {
      const t = (y - cy) / ry;
      const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t)));
      if (half < 1) continue;
      c.rect(16 - half, y + bob, half * 2, 1, P.body);
    }
    // soft fuzz: sparse single-pixel tufts hugging the silhouette
    if (sq < 2) {
      const fuzzAngles = [105, 75, 140, 40, 170, 10, 205, 335, 245, 295];
      fuzzAngles.forEach((deg, i) => {
        if ((i + frame) % 5 === 4) return; // keep it sparse and uneven
        const rad = (deg * Math.PI) / 180;
        const fx = 16 + Math.round((rx + 0.8) * Math.cos(rad));
        const fy = cy - Math.round((ry + 0.8) * Math.sin(rad));
        c.px(fx, fy + bob, P.body);
      });
    }
    // square cream eye sockets (baked; pupils in overlay), vertically centred.
    if (p.eyes !== "bare") {
      if (sq < 2) {
        for (const [ex] of this.eyeSpec.centers) {
          drawDustSquareEyeSocket(c, ex, 17, P.cream, P.ink);
        }
      } else {
        // flattened: sleepy cream slits
        const ey = 16 + Math.ceil(sq / 2);
        for (const [ex] of this.eyeSpec.centers) {
          c.rect(ex - 2, ey, 5, 2, P.cream);
        }
      }
    }
    // no mouth, ever: clean soot face
  },
  mouth() {
    // the soot ball has no mouth
  },
  overlayEyeSockets(c) {
    const P = this.palette;
    for (const [ex] of this.eyeSpec.centers) {
      drawDustSquareEyeSocket(c, ex, 17, P.cream, P.ink);
    }
  },
  eyes(c, variant, dy = 0) {
    const E = this.eyeSpec;
    const P = this.palette;
    for (const [x, y0] of E.centers) {
      const y = y0 + dy;
      if (variant === "closed") {
        c.hline(x - 2, y - 1, 4, E.ink);
      } else if (variant === "half") {
        c.rect(x - 1, y - 1, 2, 1, E.ink);
      } else if (variant === "happy") {
        drawDustCenteredPupil(c, x, y, E.ink);
      } else if (variant === "wide") {
        // startled keeps the new square eye language with a centred block pupil
        drawDustSquareEyeSocket(c, x, y, P.cream, P.ink);
        drawDustCenteredPupil(c, x, y, E.ink);
      } else {
        drawDustCenteredPupil(c, x, y, E.ink);
      }
    }
  },
};

const PETS = [claudePixel, sparkBolt, starPuff, blockHiss, peekGhost, dustPuff];

/* ------------------------------------------------------------------ */
/* Row composition                                                     */
/* ------------------------------------------------------------------ */

/**
 * Row contract: { id, frames, frameMs, eyes: "overlay" | "baked", loop }
 * compose(pet, frameIndex) -> Px canvas
 */
const ROWS = [
  {
    id: "idle",
    frames: 1,
    frameMs: 1000,
    eyes: "overlay",
    compose(pet) {
      // calm resting pose: completely still, only the eye overlay blinks
      const c = new Px();
      pet.body(c, { legs: "stand", arms: "down", mouth: "smile" }, 0);
      return c;
    },
  },
  {
    id: "walk",
    frames: 4,
    frameMs: 110,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      const legPose = ["walkA", "walkC", "walkB", "walkD"][f];
      pet.body(c, { legs: legPose, arms: f % 2 === 0 ? "swingA" : "swingB", mouth: "smile" }, f);
      return c;
    },
  },
  {
    id: "sleep",
    frames: 4,
    frameMs: 700,
    eyes: "baked",
    compose(pet, f) {
      if (pet.sleepFrame) return pet.sleepFrame(f);
      // snore phase: settled on the ground with a little open-mouth snore
      const c = new Px();
      pet.body(c, { legs: "sleep", arms: "down", mouth: "o", squash: 3 }, 0);
      pet.eyes(c, "closed", 2);
      c.dropToGround(pet.anchors.groundY);
      drawZzz(c, f, pet.anchors.cx, c.topMost() - 6);
      return c;
    },
  },
  {
    id: "sleepDeep",
    frames: 2,
    frameMs: 1100,
    eyes: "baked",
    compose(pet, f) {
      if (pet.sleepDeepFrame) return pet.sleepDeepFrame(f);
      // deep sleep: fully prone on the floor, legs tucked away, only Z drifts
      const c = new Px();
      pet.body(c, { legs: "none", arms: "down", mouth: "none", squash: 7 }, 0);
      pet.eyes(c, "closed", 4);
      c.dropToGround(pet.anchors.groundY);
      drawZzz(c, f * 2, pet.anchors.cx, c.topMost() - 7);
      return c;
    },
  },
  {
    id: "doze",
    frames: 2,
    frameMs: 650,
    eyes: "baked",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: "down", mouth: f === 0 ? "yawn" : "o", squash: 2 }, f);
      pet.eyes(c, f === 0 ? "half" : "closed", 1);
      if (f === 1) drawZzz(c, 0, pet.anchors.cx, pet.anchors.topY - 1);
      return c;
    },
  },
  {
    id: "wake",
    frames: 2,
    frameMs: 420,
    eyes: "baked",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: f === 0 ? "cheer" : "down", mouth: f === 0 ? "yawn" : "smile", squash: f === 0 ? 0 : 0 }, f);
      pet.eyes(c, f === 0 ? "half" : "open");
      if (f === 0) drawSweatDrop(c, 0, pet.anchors.headX, pet.anchors.topY + 2);
      return c;
    },
  },
  {
    id: "shock",
    frames: 2,
    frameMs: 170,
    eyes: "baked",
    compose(pet, f) {
      const c = new Px();
      if (pet.shockFace) {
        // some pets pull a cheeky face instead of a startled one
        pet.shockFace(c, f);
        return c;
      }
      pet.body(c, { legs: "stand", arms: "up", mouth: "open" }, f);
      // each pet pops its own eye shape wide open (no generic square)
      pet.eyes(c, "wide");
      // shock spark pixels
      const { cx, topY } = pet.anchors;
      const flash = f === 0;
      const marks = [
        [-12, 2],
        [12, 1],
        [0, -4],
        [-10, 14],
        [10, 14],
      ];
      marks.forEach(([dx, dy], i) => {
        if ((i + (flash ? 0 : 1)) % 2 === 0) {
          c.px(cx + dx, topY + dy, "#f2c45b");
          c.px(cx + dx, topY + dy - 1, "#f2c45b");
        }
      });
      return c;
    },
  },
  {
    id: "shaken",
    frames: 2,
    frameMs: 90,
    eyes: "baked",
    compose(pet, f) {
      const c = new Px();
      const wob = new Px();
      pet.body(wob, { legs: "stand", arms: f === 0 ? "swingA" : "swingB", mouth: "wavy" }, f);
      bakeSquintEyes(wob, pet.eyeSpec);
      c.blit(wob, f === 0 ? -1 : 1, 0);
      return c;
    },
  },
  {
    id: "faint",
    frames: 2,
    frameMs: 900,
    eyes: "baked",
    compose(pet, f) {
      // knocked out: the container animation tips this pose onto its side
      const c = new Px();
      pet.body(c, { legs: "sleep", arms: "down", mouth: "wavy", squash: 1 }, 0);
      if (pet.faintEyes) {
        pet.faintEyes(c);
      } else {
        bakeXEyes(c, pet.eyeSpec);
      }
      // dizzy stars
      const { cx, topY } = pet.anchors;
      const a = f === 0;
      c.px(cx + (a ? -9 : 9), topY - 2, "#f2c45b");
      c.px(cx + (a ? 8 : -8), topY - 4, "#e8d9a8");
      return c;
    },
  },
  {
    id: "think",
    frames: 4,
    frameMs: 430,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: "down", mouth: "o" }, f);
      drawThoughtBubble(c, f, pet.anchors.cx + 4, pet.anchors.topY + 1);
      return c;
    },
  },
  {
    id: "code",
    frames: 4,
    frameMs: 200,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: f % 2 === 0 ? "hold" : "down", mouth: "flat" }, f);
      drawLaptop(c, f, pet.anchors.cx, pet.anchors.groundY, "#8fb8e8");
      return c;
    },
  },
  {
    id: "read",
    frames: 4,
    frameMs: 650,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: "hold", mouth: f === 3 ? "o" : "smile" }, f);
      drawBook(c, f, pet.anchors.cx, pet.anchors.groundY);
      return c;
    },
  },
  {
    id: "phone",
    frames: 4,
    frameMs: 480,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: "hold", mouth: f === 2 ? "o" : "smile" }, f);
      drawPhone(c, f, pet.anchors.sideX, pet.anchors.groundY);
      return c;
    },
  },
  {
    id: "build",
    frames: 4,
    frameMs: 300,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: f % 2 === 0 ? "up" : "hold", mouth: "smile" }, f);
      drawBlocks(c, f, pet.anchors.cx, pet.anchors.groundY, "#e08a5a", "#8fb8e8");
      return c;
    },
  },
  {
    id: "juggle",
    frames: 4,
    frameMs: 160,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: f % 2 === 0 ? "cheer" : "up", mouth: "grin" }, f);
      drawJuggleBalls(c, f, pet.anchors.cx, Math.max(0, pet.anchors.topY - 6), "#e08a5a", "#f2c45b");
      return c;
    },
  },
  {
    id: "cheer",
    frames: 4,
    frameMs: 210,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: f % 2 === 0 ? "walkA" : "stand", arms: f % 2 === 0 ? "cheer" : "cheerLow", mouth: "grin" }, f);
      drawSparkles(c, f, pet.anchors.cx, pet.anchors.topY - 2, "#e08a5a", "#f2c45b");
      return c;
    },
  },
  {
    id: "alert",
    frames: 2,
    frameMs: 260,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: "down", mouth: "wavy" }, f);
      drawAlert(c, f, pet.anchors.cx, pet.anchors.topY - 4);
      drawSweatDrop(c, f, pet.anchors.headX, pet.anchors.topY + 2);
      return c;
    },
  },
  {
    id: "carry",
    frames: 2,
    frameMs: 420,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: f === 0 ? "walkA" : "walkB", arms: "up", mouth: "o" }, f);
      drawBox(c, f, pet.anchors.cx, pet.anchors.groundY, "#c98a4b");
      return c;
    },
  },
  {
    id: "sweep",
    frames: 4,
    frameMs: 230,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: f % 2 === 0 ? "swingA" : "swingB", mouth: "smile" }, f);
      drawBroom(c, f, pet.anchors.cx, pet.anchors.groundY);
      return c;
    },
  },
  {
    id: "snack",
    frames: 4,
    frameMs: 340,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      const mouth = f === 0 ? "o" : f === 1 ? "open" : f === 2 ? "smile" : "grin";
      pet.body(c, { legs: "stand", arms: "hold", mouth }, f);
      drawCookie(c, f, pet.anchors.cx, pet.anchors.mouthY);
      return c;
    },
  },
  {
    id: "bell",
    frames: 2,
    frameMs: 300,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: f === 0 ? "cheer" : "up", mouth: "o" }, f);
      drawBell(c, f, pet.anchors.cx, pet.anchors.topY - 1);
      return c;
    },
  },
  {
    id: "type",
    frames: 4,
    frameMs: 180,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: "stand", arms: f % 2 === 0 ? "hold" : "down", mouth: "smile" }, f);
      drawKeyboard(c, f, pet.anchors.cx, pet.anchors.groundY, "#8fb8e8");
      return c;
    },
  },
  // walking variants for autowalk activities (accessory stays in hand)
  {
    id: "walkRead",
    frames: 4,
    frameMs: 110,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: ["walkA", "walkC", "walkB", "walkD"][f], arms: "hold", mouth: "smile" }, f);
      drawBook(c, f % 2, pet.anchors.cx, pet.anchors.groundY);
      return c;
    },
  },
  {
    id: "walkPhone",
    frames: 4,
    frameMs: 110,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: ["walkA", "walkC", "walkB", "walkD"][f], arms: "hold", mouth: "o" }, f);
      drawPhone(c, f % 2, pet.anchors.sideX, pet.anchors.groundY);
      return c;
    },
  },
  {
    id: "walkSnack",
    frames: 4,
    frameMs: 110,
    eyes: "overlay",
    compose(pet, f) {
      const c = new Px();
      pet.body(c, { legs: ["walkA", "walkC", "walkB", "walkD"][f], arms: "hold", mouth: f % 2 === 0 ? "open" : "smile" }, f);
      drawCookie(c, f % 2, pet.anchors.cx, pet.anchors.mouthY);
      return c;
    },
  },
];

/* Eye overlay strip: open / half / closed / happy */
const EYE_FRAMES = ["open", "half", "closed", "happy"];

/* ------------------------------------------------------------------ */
/* Sheet assembly                                                      */
/* ------------------------------------------------------------------ */

function buildSheets() {
  mkdirSync(OUT_DIR, { recursive: true });

  for (const pet of PETS) {
    // body sheet
    const sheet = new Px(GRID * COLS, GRID * ROWS.length);
    ROWS.forEach((row, rowIndex) => {
      for (let f = 0; f < row.frames; f++) {
        const frame = row.compose(pet, f);
        if (row.eyes === "overlay" && pet.overlayEyeSockets) {
          pet.overlayEyeSockets(frame);
        }
        sheet.blit(frame, f * GRID, rowIndex * GRID);
      }
    });
    const bodyPng = encodePng(
      GRID * COLS * SCALE,
      GRID * ROWS.length * SCALE,
      upscale(sheet, SCALE)
    );
    writeFileSync(path.join(OUT_DIR, `${pet.id}.png`), bodyPng);

    // eye overlay strip
    const eyes = new Px(GRID * EYE_FRAMES.length, GRID);
    EYE_FRAMES.forEach((variant, i) => {
      const frame = new Px();
      if (pet.overlayEyes) {
        pet.overlayEyes(frame, variant);
      } else {
        pet.eyes(frame, variant);
      }
      eyes.blit(frame, i * GRID, 0);
    });
    const eyesPng = encodePng(
      GRID * EYE_FRAMES.length * SCALE,
      GRID * SCALE,
      upscale(eyes, SCALE)
    );
    writeFileSync(path.join(OUT_DIR, `${pet.id}-eyes.png`), eyesPng);

    console.log(`generated ${pet.id}: body ${bodyPng.length}B eyes ${eyesPng.length}B`);
  }
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

function buildManifest() {
  const rows = ROWS.map((row, index) => ({
    id: row.id,
    index,
    frames: row.frames,
    frameMs: row.frameMs,
    eyes: row.eyes,
  }));

  const manifest = `// Generated by scripts/generate-pet-sprites.mjs — do not edit by hand.
// Regenerate with: node src/web/scripts/generate-pet-sprites.mjs

// Sheet geometry: ${GRID}x${GRID} px grid at ${SCALE}x scale, ${EYE_FRAMES.length} eye frames per strip.
export const PET_SPRITE_COLS = ${COLS};
export const PET_SPRITE_ROW_COUNT = ${ROWS.length};

export type PetSpriteRowId =
${ROWS.map((row) => `  | "${row.id}"`).join("\n")};

export type PetSpriteRow = {
  id: PetSpriteRowId;
  index: number;
  frames: number;
  frameMs: number;
  eyes: "overlay" | "baked";
};

export const PET_SPRITE_ROWS: readonly PetSpriteRow[] = ${JSON.stringify(rows, null, 2)} as const;

export const PET_SPRITE_ROW_BY_ID: ReadonlyMap<PetSpriteRowId, PetSpriteRow> = new Map(
  PET_SPRITE_ROWS.map((row) => [row.id, row])
);

export function petSpriteBodyUrl(presetId: string) {
  return \`/pets/\${presetId}.png\`;
}

export function petSpriteEyesUrl(presetId: string) {
  return \`/pets/\${presetId}-eyes.png\`;
}
`;

  writeFileSync(MANIFEST_PATH, manifest);
  console.log(`wrote manifest ${MANIFEST_PATH}`);
}

buildSheets();
buildManifest();
