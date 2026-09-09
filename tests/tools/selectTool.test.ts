// tests/tools/selectTool.test.ts
import { describe, it, expect } from 'vitest'
import { hitHandle, resizeRect, findSnaps } from '@/tools/selectTool'

const R = { x: 100, y: 100, w: 200, h: 50 }

describe('hitHandle', () => {
  it('detects corners with screen-constant slop', () => {
    expect(hitHandle(R, 100, 100, 1)).toBe('nw')
    expect(hitHandle(R, 300, 150, 1)).toBe('se')
  })

  it('keeps slop constant in screen px as zoom changes', () => {
    expect(hitHandle(R, 106, 100, 1)).toBe('nw')      // 6 world px @ 1x = 6 screen px
    expect(hitHandle(R, 106, 100, 4)).not.toBe('nw')  // 6 world px @ 4x = 24 screen px
  })

  it('returns move inside and null outside', () => {
    expect(hitHandle(R, 200, 125, 1)).toBe('move')
    expect(hitHandle(R, 500, 500, 1)).toBeNull()
  })
})

describe('resizeRect', () => {
  it('resizes from the correct anchor', () => {
    expect(resizeRect(R, 'se', 10, 5)).toEqual({ x: 100, y: 100, w: 210, h: 55 })
    expect(resizeRect(R, 'nw', 10, 5)).toEqual({ x: 110, y: 105, w: 190, h: 45 })
  })

  it('moves without resizing', () => {
    expect(resizeRect(R, 'move', 10, -10)).toEqual({ x: 110, y: 90, w: 200, h: 50 })
  })

  it('clamps to a minimum size instead of inverting', () => {
    const r = resizeRect(R, 'se', -1000, -1000)
    expect(r.w).toBeGreaterThanOrEqual(4)
    expect(r.h).toBeGreaterThanOrEqual(4)
  })
})

describe('findSnaps', () => {
  const candidates = new Float32Array([98, 100, 200, 40])  // left edge at 98

  it('snaps a near edge and reports a guide', () => {
    const s = findSnaps({ x: 100, y: 300, w: 50, h: 20 }, candidates, 1, 6)
    expect(s.dx).toBeCloseTo(-2)
    expect(s.guides.length).toBeGreaterThan(0)
  })

  it('does not snap beyond tolerance', () => {
    const s = findSnaps({ x: 140, y: 300, w: 50, h: 20 }, candidates, 1, 6)
    expect(s.dx).toBe(0)
    expect(s.guides).toHaveLength(0)
  })

  it('prefers the nearest candidate edge', () => {
    const two = new Float32Array([98, 0, 10, 10, 103, 0, 10, 10])
    const s = findSnaps({ x: 100, y: 300, w: 50, h: 20 }, two, 2, 6)
    expect(Math.abs(s.dx)).toBeCloseTo(2)
  })
})
