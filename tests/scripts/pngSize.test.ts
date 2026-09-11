import { describe, expect, it } from 'vitest'
import { pngSize } from '../../scripts/prepare-funsd'

/** Minimal PNG: 8-byte signature, then a length+type+IHDR body. */
function fakePng(w: number, h: number): Uint8Array {
  const buf = new Uint8Array(33)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(buf.buffer)
  view.setUint32(8, 13)
  buf.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  view.setUint32(16, w)
  view.setUint32(20, h)
  return buf
}

describe('pngSize', () => {
  it('reads width and height from the IHDR chunk', () => {
    expect(pngSize(fakePng(754, 1000))).toEqual({ w: 754, h: 1000 })
  })

  it('rejects a buffer that is not a PNG', () => {
    expect(() => pngSize(new Uint8Array(33))).toThrow(/not a png/i)
  })
})
