// Generates the PWA icons in web/public with no dependencies (raw PNG via zlib).
// Run: npm run icons -w web
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [67, 56, 202]; // #4338ca
const DIE = [255, 255, 255];
const PIP = [49, 46, 129]; // #312e81

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Inside a rounded rect centred at (cx,cy) with half-size h and corner radius r? */
function inRoundRect(x, y, cx, cy, h, r) {
  const dx = Math.max(Math.abs(x - cx) - (h - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (h - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/**
 * Render the icon in unit coordinates [0,1].
 * fullBleed: background fills the square (maskable / apple-touch); otherwise rounded.
 * dieScale: die half-size; maskable keeps it inside the 80% safe zone.
 */
function render(size, { fullBleed, dieScale }) {
  const SS = 4; // supersampling for anti-aliasing
  const buf = Buffer.alloc(size * size * 4);
  const pipR = dieScale * 0.17;
  const off = dieScale * 0.5;
  const pips = [
    [-off, -off],
    [off, -off],
    [0, 0],
    [-off, off],
    [off, off],
  ];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let color = null;
          if (fullBleed || inRoundRect(x, y, 0.5, 0.5, 0.5, 0.22)) color = BG;
          // Die, tilted slightly for character.
          const ang = (-12 * Math.PI) / 180;
          const rx = 0.5 + (x - 0.5) * Math.cos(ang) - (y - 0.5) * Math.sin(ang);
          const ry = 0.5 + (x - 0.5) * Math.sin(ang) + (y - 0.5) * Math.cos(ang);
          if (inRoundRect(rx, ry, 0.5, 0.5, dieScale, dieScale * 0.28)) {
            color = DIE;
            for (const [ox, oy] of pips) {
              const dx = rx - (0.5 + ox);
              const dy = ry - (0.5 + oy);
              if (dx * dx + dy * dy <= pipR * pipR) color = PIP;
            }
          }
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      // Un-premultiply so edge pixels keep their colour.
      const cov = a / 255;
      buf[i] = cov ? Math.round(r / cov) : 0;
      buf[i + 1] = cov ? Math.round(g / cov) : 0;
      buf[i + 2] = cov ? Math.round(b / cov) : 0;
      buf[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, buf);
}

const icons = [
  ['icon-192.png', 192, { fullBleed: false, dieScale: 0.27 }],
  ['icon-512.png', 512, { fullBleed: false, dieScale: 0.27 }],
  // Maskable: full-bleed background, die well inside the central safe zone.
  ['icon-512-maskable.png', 512, { fullBleed: true, dieScale: 0.22 }],
  // iOS rounds the corners itself and dislikes transparency.
  ['apple-touch-icon.png', 180, { fullBleed: true, dieScale: 0.27 }],
];
for (const [name, size, opts] of icons) {
  writeFileSync(path.join(out, name), render(size, opts));
  console.log(`wrote ${name}`);
}

writeFileSync(
  path.join(out, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#4338ca"/>
  <g transform="rotate(-12 50 50)">
    <rect x="23" y="23" width="54" height="54" rx="15" fill="#fff"/>
    <g fill="#312e81">
      <circle cx="36.5" cy="36.5" r="4.6"/><circle cx="63.5" cy="36.5" r="4.6"/>
      <circle cx="50" cy="50" r="4.6"/>
      <circle cx="36.5" cy="63.5" r="4.6"/><circle cx="63.5" cy="63.5" r="4.6"/>
    </g>
  </g>
</svg>
`,
);
console.log('wrote favicon.svg');
