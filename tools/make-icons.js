'use strict';
// Generates the tray / app icons in assets/ (no external tools needed): `node tools/make-icons.js`
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');

function png(w, h, rgba) {
  const crc = (b) => zlib.crc32(b) >>> 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed-distance helpers in unit coordinates (0..1).
const len = (x, y) => Math.hypot(x, y);
const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (x, y, cx, cy, r) => len(x - cx, y - cy) - r;
const segment = (x, y, ax, ay, bx, by) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return len(px - dx * t, py - dy * t);
};

// Lambda symbol: long stroke from top left to bottom right, short leg to the bottom left, small hook at the top.
function glyph(x, y) {
  const w = 0.075;
  const long = segment(x, y, 0.3, 0.17, 0.74, 0.83) - w;
  const leg = segment(x, y, 0.49, 0.455, 0.26, 0.83) - w;
  const hook = segment(x, y, 0.3, 0.17, 0.2, 0.17) - w;
  return Math.min(long, leg, hook);
}

function render(size, shade) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size, y = (py + (sy + 0.5) / ss) / size;
          const c = shade(x, y);
          if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
      buf[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return png(size, size, buf);
}

const DOT = { x: 0.8, y: 0.22, r: 0.19 };
const STATES = {
  ok: [34, 197, 94],     // collecting, connected
  wait: [245, 158, 11],  // collecting, (re)connecting
  err: [239, 68, 68],    // connection or save error
  run: [34, 197, 94],    // heat pump running (green)
  stop: [37, 99, 235],   // heat pump stopped (blue)
  off: [148, 163, 184],  // disconnected / not collecting (grey)
};

// macOS menu bar: black template images (the system adapts them to light/dark mode).
function templateShade(state) {
  return (x, y) => {
    const hasDot = !!state;
    if (hasDot && circle(x, y, DOT.x, DOT.y, DOT.r + 0.07) < 0) {
      if (state === 'ok' && circle(x, y, DOT.x, DOT.y, DOT.r) < 0) return [0, 0, 0, 1];
      if (state !== 'ok' && Math.abs(circle(x, y, DOT.x, DOT.y, DOT.r - 0.035)) < 0.045) return [0, 0, 0, 1];
      return null;
    }
    return glyph(x, y) < 0 ? [0, 0, 0, 1] : null;
  };
}

// macOS menu bar with a coloured dot: not a template image, so the glyph colour follows the theme.
function macColourShade(state, dark) {
  const g = dark ? 255 : 0;
  return (x, y) => {
    if (state) {
      const d = circle(x, y, DOT.x, DOT.y, DOT.r);
      if (d < 0) return [...STATES[state], 1];
      if (d < 0.07) return null;
    }
    return glyph(x, y) < 0 ? [g, g, g, 1] : null;
  };
}

// Windows / Linux tray and app icon: white glyph on a blue tile, coloured status dot.
function colourShade(state, inset = 0) {
  return (x, y) => {
    x = (x - inset) / (1 - 2 * inset); y = (y - inset) / (1 - 2 * inset);
    if (state) {
      const d = circle(x, y, DOT.x, DOT.y, DOT.r);
      if (d < 0) return [...STATES[state], 1];
      if (d < 0.06) return [255, 255, 255, 1];
    }
    if (roundRect(x, y, 0, 0, 1, 1, 0.22) > 0) return null;
    if (glyph(x, y) < 0) return [255, 255, 255, 1];
    return [31, 78, 121, 1];
  };
}

fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => { fs.writeFileSync(path.join(OUT, name), data); console.log('wrote', name); };
for (const state of [null, 'ok', 'wait', 'err', 'run', 'stop', 'off']) {
  const suffix = state ? `-${state}` : '';
  write(`trayTemplate${suffix}.png`, render(16, templateShade(state)));
  write(`trayTemplate${suffix}@2x.png`, render(32, templateShade(state)));
  write(`tray${suffix}.png`, render(32, colourShade(state)));
}
for (const state of [null, 'ok', 'wait', 'err', 'run', 'stop', 'off']) {
  for (const theme of ['light', 'dark']) {
    const base = `trayMac${state ? `-${state}` : ''}-${theme}`;
    write(`${base}.png`, render(16, macColourShade(state, theme === 'dark')));
    write(`${base}@2x.png`, render(32, macColourShade(state, theme === 'dark')));
  }
}
write('icon.png', render(512, colourShade(null, 0.08)));
