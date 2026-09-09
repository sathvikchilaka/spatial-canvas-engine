// tests/tools/orderTool.test.ts
import { describe, it, expect } from 'vitest'
import { relink, arrowPath } from '@/tools/orderTool'

const u = (a: number[]) => new Uint32Array(a)

describe('relink', () => {
  it('moves a node to follow the target', () => {
    expect(Array.from(relink(u([1,2,3,4,5]), 1, 4))).toEqual([1,4,2,3,5])
  })

  it('is a no-op when already the successor', () => {
    expect(Array.from(relink(u([1,2,3]), 1, 2))).toEqual([1,2,3])
  })

  it('never duplicates or drops nodes', () => {
    const r = relink(u([1,2,3,4,5]), 5, 1)
    expect(Array.from(r).sort((a,b)=>a-b)).toEqual([1,2,3,4,5])
  })

  it('refuses to link a node to itself', () => {
    expect(Array.from(relink(u([1,2,3]), 2, 2))).toEqual([1,2,3])
  })

  it('handles the first and last positions', () => {
    expect(Array.from(relink(u([1,2,3]), 3, 1))).toEqual([2,3,1])
  })
})

describe('arrowPath', () => {
  it('runs between rect centres', () => {
    const p = arrowPath({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 0, w: 10, h: 10 })
    expect(p.x1).toBeGreaterThan(0)
    expect(p.x2).toBeLessThan(105)
    expect(p.y1).toBeCloseTo(5)
  })

  it('produces a finite path for coincident rects', () => {
    const p = arrowPath({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })
    expect(Number.isFinite(p.x1) && Number.isFinite(p.headAngle)).toBe(true)
  })
})
