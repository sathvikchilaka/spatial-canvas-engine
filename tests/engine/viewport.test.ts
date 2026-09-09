import { describe, it, expect } from 'vitest'
import {
  worldToScreen, screenToWorld, zoomAt, panBy, visibleWorldRect,
  MIN_SCALE, MAX_SCALE, type Viewport,
} from '@/engine/viewport'

const vp = (scale = 1, tx = 0, ty = 0): Viewport => ({ scale, tx, ty })

describe('worldToScreen / screenToWorld', () => {
  it('round-trips at many scales and offsets', () => {
    for (const s of [0.1, 0.37, 1, 2.5, 5]) {
      for (const t of [-1000, -13.7, 0, 250]) {
        const v = vp(s, t, -t)
        const [sx, sy] = worldToScreen(v, 123.456, -78.9)
        const [wx, wy] = screenToWorld(v, sx, sy)
        expect(wx).toBeCloseTo(123.456, 6)
        expect(wy).toBeCloseTo(-78.9, 6)
      }
    }
  })

  it('applies scale then translate', () => {
    expect(worldToScreen(vp(2, 10, 20), 5, 5)).toEqual([20, 30])
  })
})

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const before = vp(1, 40, -15)
    const cursor: [number, number] = [317, 209]
    const anchor = screenToWorld(before, ...cursor)
    for (const factor of [1.1, 0.9, 2, 0.5]) {
      const after = zoomAt(before, cursor[0], cursor[1], factor)
      const [sx, sy] = worldToScreen(after, anchor[0], anchor[1])
      expect(sx).toBeCloseTo(cursor[0], 6)
      expect(sy).toBeCloseTo(cursor[1], 6)
    }
  })

  it('clamps to MIN_SCALE and MAX_SCALE', () => {
    expect(zoomAt(vp(MIN_SCALE), 0, 0, 0.01).scale).toBe(MIN_SCALE)
    expect(zoomAt(vp(MAX_SCALE), 0, 0, 100).scale).toBe(MAX_SCALE)
  })

  it('does not drift the anchor when clamped', () => {
    const v = vp(MAX_SCALE, 12, 34)
    const anchor = screenToWorld(v, 100, 100)
    const after = zoomAt(v, 100, 100, 4)
    const [sx, sy] = worldToScreen(after, ...anchor)
    expect(sx).toBeCloseTo(100, 6)
    expect(sy).toBeCloseTo(100, 6)
  })
})

describe('panBy', () => {
  it('translates in screen pixels regardless of scale', () => {
    expect(panBy(vp(3, 0, 0), 10, -5)).toEqual({ scale: 3, tx: 10, ty: -5 })
  })
})

describe('visibleWorldRect', () => {
  it('returns the world rect covering the canvas', () => {
    const r = visibleWorldRect(vp(2, -100, -50), 800, 600)
    expect(r.x).toBeCloseTo(50)
    expect(r.y).toBeCloseTo(25)
    expect(r.w).toBeCloseTo(400)
    expect(r.h).toBeCloseTo(300)
  })
})
