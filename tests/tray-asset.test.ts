import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const icon = readFileSync(
  new URL('../src/main/assets/tray.ico', import.meta.url)
)

interface IconEntry {
  width: number
  height: number
  bytes: number
  offset: number
}

function readEntries(buffer: Buffer): IconEntry[] {
  const count = buffer.readUInt16LE(4)
  const entries: IconEntry[] = []
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16
    entries.push({
      width: buffer.readUInt8(entry) || 256,
      height: buffer.readUInt8(entry + 1) || 256,
      bytes: buffer.readUInt32LE(entry + 8),
      offset: buffer.readUInt32LE(entry + 12)
    })
  }
  return entries
}

describe('Windows tray icon asset', () => {
  it('is a multi-size ICO file', () => {
    expect(icon.length).toBeGreaterThan(1_000)
    expect(icon.readUInt16LE(0)).toBe(0)
    expect(icon.readUInt16LE(2)).toBe(1)
    expect(icon.readUInt16LE(4)).toBeGreaterThanOrEqual(2)
  })

  it('includes the small Windows tray sizes with in-bounds image data', () => {
    const entries = readEntries(icon)
    const sizes = entries.map((entry) => entry.width)
    expect(sizes).toContain(16)
    expect(sizes).toContain(32)

    for (const entry of entries) {
      expect(entry.width).toBe(entry.height)
      expect(entry.bytes).toBeGreaterThan(40)
      expect(entry.offset + entry.bytes).toBeLessThanOrEqual(icon.length)
      // Generated entries are PNG-compressed images, not BMP payloads.
      expect(icon.subarray(entry.offset, entry.offset + 8).toString('hex')).toBe(
        '89504e470d0a1a0a'
      )
    }
  })
})
