/**
 * Generates the placeholder app icon: build/icon.png (256x256, used for the
 * window/taskbar icon and by electron-builder) and build/icon.ico (16..256,
 * PNG-compressed entries). Dependency-free (Node built-ins only): a small
 * signed-distance rasteriser with 4x4 supersampling, a PNG writer on zlib, and
 * an ICO container writer.
 *
 * Design: rounded indigo-to-violet square with a white microphone. It is a
 * placeholder -- replace build/icon.* with real artwork any time; the
 * generated files are committed, so this script only needs re-running if you
 * want to tweak the placeholder.
 *
 * Usage: node scripts/generate-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SS = 4 // supersampling per axis

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r)
  const dy = Math.abs(py - cy) - (hh - r)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r
}

/** Returns [r,g,b,a] (0..255, straight alpha) for a point in unit space. */
function shade(x, y) {
  if (sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return [0, 0, 0, 0]

  // Background gradient: indigo (top-left) -> violet (bottom-right).
  const t = (x + y) / 2
  const bg = [79 + (139 - 79) * t, 70 + (92 - 70) * t, 229 + (246 - 229) * t]

  let white = false
  // Capsule.
  if (sdRoundRect(x, y, 0.5, 0.385, 0.105, 0.17, 0.105) <= 0) white = true
  // U-shaped cradle: lower half of a ring.
  const rd = Math.hypot(x - 0.5, y - 0.44)
  if (y >= 0.44 && Math.abs(rd - 0.205) <= 0.0225) white = true
  // Stem and base.
  if (Math.abs(x - 0.5) <= 0.0225 && y >= 0.645 && y <= 0.775) white = true
  if (sdRoundRect(x, y, 0.5, 0.79, 0.1, 0.0225, 0.0225) <= 0) white = true

  return white ? [255, 255, 255, 255] : [bg[0], bg[1], bg[2], 255]
}

function render(size) {
  const px = Buffer.alloc(size * size * 4)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const c = shade((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size)
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]
        }
      }
      const o = (j * size + i) * 4
      if (a > 0) {
        px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a)
      }
      px[o + 3] = Math.round(a / (SS * SS))
    }
  }
  return px
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((e, i) => {
    const o = i * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(e.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

mkdirSync(OUT_DIR, { recursive: true })
const entries = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }))
writeFileSync(join(OUT_DIR, 'icon.png'), entries[entries.length - 1].png)
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco(entries))
console.log(`wrote build/icon.png and build/icon.ico (${SIZES.join(', ')})`)
