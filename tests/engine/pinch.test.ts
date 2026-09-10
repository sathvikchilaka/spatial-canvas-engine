import { describe, it, expect } from 'vitest'
import { pinchUpdate } from '@/engine/input'
import { zoomAt } from '@/engine/viewport'

describe('pinchUpdate', () => {
  it('reports the ratio of pointer separations and their midpoint', () => {
    const prev = { dist: 100, cx: 0, cy: 0 }
    const next = pinchUpdate(prev, { x: 0, y: 0 }, { x: 200, y: 0 })
    expect(next.dist).toBe(200)
    expect(next.factor).toBe(2)
    expect(next.cx).toBe(100)
    expect(next.cy).toBe(0)
  })

  it('is a no-op factor when the fingers do not move', () => {
    expect(pinchUpdate({ dist: 50, cx: 5, cy: 5 }, { x: 0, y: 0 }, { x: 50, y: 0 }).factor).toBe(1)
  })

  it('never divides by zero when both pointers coincide', () => {
    const next = pinchUpdate({ dist: 0, cx: 0, cy: 0 }, { x: 7, y: 7 }, { x: 7, y: 7 })
    expect(next.factor).toBe(1)
  })

  it('composes with zoomAt to keep the pinch midpoint fixed', () => {
    const vp = { scale: 1, tx: 0, ty: 0 }
    const { factor, cx, cy } = pinchUpdate({ dist: 100, cx: 50, cy: 50 }, { x: 0, y: 50 }, { x: 200, y: 50 })
    const next = zoomAt(vp, cx, cy, factor)
    // The world point under the midpoint before the zoom is still under it after.
    const worldBefore = (cx - vp.tx) / vp.scale
    const worldAfter = (cx - next.tx) / next.scale
    expect(worldAfter).toBeCloseTo(worldBefore, 5)
    expect(next.scale).toBe(2)
  })
})
