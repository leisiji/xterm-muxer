#!/usr/bin/env node
/**
 * Generates build/icon.png (256x256) with a minimal terminal-glyph design using
 * only Node built-ins (zlib + a tiny CRC32). electron-builder derives the
 * Windows .ico / Linux icons from this 256x256 PNG.
 */
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const W = 256
const H = 256

// palette
const BG = [16, 20, 30, 255] // deep slate
const PROMPT = [90, 199, 255, 255] // cyan ">"
const CURSOR = [250, 244, 248, 255] // light bar
const FG = [198, 200, 209, 255] // dim text
const ACCENT = [90, 247, 142, 255] // green block

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x < x1 && y >= y0 && y < y1
}

function pixel(x, y) {
  // rounded corner
  const r = 40
  const cx = Math.min(Math.max(x, r), W - r - 1)
  const cy = Math.min(Math.max(y, r), H - r - 1)
  const dx = x - cx
  const dy = y - cy
  const inRoundedRect = (cx === 0 || cy === 0 || cx === W - 1 || cy === H - 1) || dx * dx + dy * dy <= r * r || inRect(x, y, r, 0, W - r, H) || inRect(x, y, 0, r, W, H - r)
  if (!inRoundedRect) return [0, 0, 0, 0] // transparent outside rounded rect

  // prompt ">"
  if (inRect(x, y, 42, 104, 88, 150)) return PROMPT
  // cursor block after prompt
  if (inRect(x, y, 100, 104, 138, 150)) return CURSOR
  // a couple of dim text lines below
  for (let i = 0; i < 3; i++) {
    const y0 = 172 + i * 24
    const w = 150 - i * 26
    if (inRect(x, y, 42, y0, 42 + w, y0 + 10)) {
      return i === 2 ? ACCENT : FG
    }
  }
  return BG
}

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encode() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0 // filter none
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (1 + W * 4) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'icon.png')
fs.writeFileSync(out, encode())
console.log('wrote', out, fs.statSync(out).size, 'bytes')
