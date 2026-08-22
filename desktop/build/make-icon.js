'use strict'
// Renders the AlphaTape mark to a 1024px PNG with a transparent squircle margin,
// then the iconset is built from it with sips/iconutil. Written by hand because
// this machine has no SVG rasteriser, and a browser screenshot cannot give us
// the transparent corners a macOS app icon needs.
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const S = 1024
// Big Sur proportions: the body sits inside the canvas with a margin.
const MARGIN = 100, BODY = S - MARGIN * 2, RADIUS = 185
const NAVY = [0x10, 0x1c, 0x2e]
const GOLD = [0xc9, 0xa8, 0x4c]

// The mark, in the favicon's 100-unit space with its transform folded in:
// x' = 50 + (x-50)*1.08, y' = y + 7, clipped below y' = 86.
const xf = x => 50 + (x - 50) * 1.08
const SEGS = [
  [xf(23), 97, xf(50), 24],   // left leg
  [xf(50), 24, xf(77), 97],   // right leg
  [xf(36), 63, xf(64), 63],   // crossbar
  [xf(50), 63, xf(50), 97],   // stem
]
const CLIP_Y = 86
const STROKE = 7.5

function distToSeg(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// Rounded-rect coverage, in pixels, signed distance style.
function rrDist(px, py) {
  const cx = Math.abs(px - S / 2) - (BODY / 2 - RADIUS)
  const cy = Math.abs(py - S / 2) - (BODY / 2 - RADIUS)
  const qx = Math.max(cx, 0), qy = Math.max(cy, 0)
  return Math.hypot(qx, qy) + Math.min(Math.max(cx, cy), 0) - RADIUS
}

const cover = d => Math.max(0, Math.min(1, 0.5 - d))          // 1px AA band
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

// The mark occupies this fraction of the body, centred.
const MARK = BODY * 0.66
// Optically centred, not arithmetically: the mark is clipped flat at the base
// and pointed at the apex, so dead-centre reads as sitting low.
const markX = (S - MARK) / 2, markY = (S - MARK) / 2 - BODY * 0.018

const buf = Buffer.alloc(S * S * 4)
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const px = x + 0.5, py = y + 0.5
    const bodyA = cover(rrDist(px, py))
    let r = NAVY[0], g = NAVY[1], b = NAVY[2], a = bodyA

    if (bodyA > 0) {
      // Hairline gold rim, the same restraint the app uses on panels.
      const rim = cover(Math.abs(rrDist(px, py) + 2.5) - 1.4) * 0.34
      if (rim > 0) { const c = mix([r, g, b], GOLD, rim); r = c[0]; g = c[1]; b = c[2] }

      // The mark, in unit space.
      const ux = (px - markX) / MARK * 100
      const uy = (py - markY) / MARK * 100
      if (uy <= CLIP_Y) {
        let d = Infinity
        for (const s of SEGS) d = Math.min(d, distToSeg(ux, uy, s))
        const scale = MARK / 100
        const inkA = cover((d - STROKE / 2) * scale)
        // Clip edge gets the same 1px softening so it does not alias.
        const clipA = Math.max(0, Math.min(1, (CLIP_Y - uy) * scale + 0.5))
        const ink = inkA * clipA
        if (ink > 0) { const c = mix([r, g, b], GOLD, ink); r = c[0]; g = c[1]; b = c[2] }
      }
    }
    const o = (y * S + x) * 4
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = Math.round(a * 255)
  }
}

// Minimal PNG writer: IHDR / IDAT / IEND.
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}
let TBL = null
function crc32(b) {
  if (!TBL) { TBL = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c } }
  let c = 0xffffffff
  for (const v of b) c = TBL[(c ^ v) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
fs.writeFileSync(path.join(__dirname, 'icon.png'), png)
console.log(`icon.png ${S}x${S}, ${(png.length / 1024).toFixed(0)} KB`)
