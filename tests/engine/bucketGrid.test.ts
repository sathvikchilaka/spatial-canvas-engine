// tests/engine/bucketGrid.test.ts
import { describe, it, expect } from 'vitest'
import { BucketGrid } from '@/engine/bucketGrid'
import type { Rect } from '@/data/nodes'

describe('BucketGrid', () => {
  it('is conservative: never misses an intersecting rect', () => {
    const g = new BucketGrid(100)
    const ids = new Uint32Array([1, 2, 3])
    const coords = new Float32Array([0,0,50,50, 480,480,60,60, 5000,5000,10,10])
    g.addPage(0, ids, coords, new Uint32Array([0, 1, 2]))
    const out = new Uint32Array(64)
    const n = g.query(470, 470, 100, 100, out)
    expect(Array.from(out.slice(0, n))).toContain(1)
  })

  it('excludes far-away rects', () => {
    const g = new BucketGrid(100)
    g.addPage(0, new Uint32Array([1]), new Float32Array([0,0,10,10]), new Uint32Array([0]))
    const out = new Uint32Array(16)
    expect(g.query(9000, 9000, 100, 100, out)).toBe(0)
  })

  it('handles rects spanning many cells', () => {
    const g = new BucketGrid(100)
    g.addPage(0, new Uint32Array([1]), new Float32Array([0,0,1000,1000]), new Uint32Array([0]))
    const out = new Uint32Array(16)
    expect(g.query(900, 900, 10, 10, out)).toBe(1)
  })

  it('clears a single page without touching others', () => {
    const g = new BucketGrid(100)
    g.addPage(0, new Uint32Array([1]), new Float32Array([0,0,10,10]), new Uint32Array([0]))
    g.addPage(1, new Uint32Array([2]), new Float32Array([0,0,10,10]), new Uint32Array([1]))
    g.clearPage(0)
    const out = new Uint32Array(16)
    const n = g.query(0, 0, 20, 20, out)
    expect(Array.from(out.slice(0, n))).toEqual([1])
  })

  it('does not overflow the out array', () => {
    const g = new BucketGrid(100)
    const n = 50
    const ids = new Uint32Array(n), coords = new Float32Array(n * 4), idx = new Uint32Array(n)
    for (let i = 0; i < n; i++) { ids[i] = i + 1; idx[i] = i; coords[i*4+2] = 10; coords[i*4+3] = 10 }
    g.addPage(0, ids, coords, idx)
    const out = new Uint32Array(8)
    expect(g.query(0, 0, 100, 100, out)).toBeLessThanOrEqual(8)
  })

  it('returns each index at most once', () => {
    const g = new BucketGrid(100)
    g.addPage(0, new Uint32Array([1]), new Float32Array([0,0,1000,1000]), new Uint32Array([0]))
    const out = new Uint32Array(64)
    const n = g.query(0, 0, 1000, 1000, out)
    expect(new Set(Array.from(out.slice(0, n))).size).toBe(n)
  })
})

describe('BucketGrid.move', () => {
  /**
   * Culling is per frame and main-thread, so a box dragged out of its original
   * 512px cell is simply not returned any more — it vanishes from the canvas
   * while still being selectable. The grid has to move with the edit.
   */
  it('finds a box at its new home and not at its old one', () => {
    const g = new BucketGrid(512)
    const ids = Uint32Array.of(7)
    const coords = Float32Array.of(10, 10, 20, 20)
    g.addPage(0, ids, coords, Uint32Array.of(0))

    const out = new Uint32Array(16)
    expect(g.query(0, 0, 100, 100, out)).toBe(1)

    g.move(0, 0, { x: 10, y: 10, w: 20, h: 20 }, { x: 5000, y: 5000, w: 20, h: 20 })

    expect(g.query(0, 0, 100, 100, out)).toBe(0)
    expect(g.query(4900, 4900, 200, 200, out)).toBe(1)
    expect(out[0]).toBe(0)
  })

  it('still drops a moved box when its page is cleared', () => {
    const g = new BucketGrid(512)
    g.addPage(3, Uint32Array.of(7), Float32Array.of(10, 10, 20, 20), Uint32Array.of(0))
    g.move(0, 3, { x: 10, y: 10, w: 20, h: 20 }, { x: 5000, y: 5000, w: 20, h: 20 })
    g.clearPage(3)
    const out = new Uint32Array(16)
    expect(g.query(4900, 4900, 200, 200, out)).toBe(0)
  })

  /**
   * `move` is `remove` then `insert`, each over its own exact footprint — so a
   * box that straddles several cells and moves to a footprint that only
   * partially overlaps its old one should end up registered once per cell it
   * now occupies, nowhere it left, and (this is the load-bearing check) not
   * double-registered in a cell that was in both footprints. A future "diff
   * the footprints instead of remove+insert" optimization could silently
   * regress that last part without this test noticing via the single-box
   * cases above.
   */
  it('handles a multi-cell box moving to a partially overlapping footprint', () => {
    const g = new BucketGrid(512)
    // Straddles cells (0,0)/(1,0)/(0,1)/(1,1).
    const from: Rect = { x: 500, y: 500, w: 40, h: 40 }
    // Straddles cells (1,0)/(2,0)/(1,1)/(2,1) — shares column 1 with `from`,
    // gains column 2, loses column 0.
    const to: Rect = { x: 1000, y: 500, w: 40, h: 40 }
    g.addPage(0, Uint32Array.of(7), Float32Array.of(from.x, from.y, from.w, from.h), Uint32Array.of(0))

    g.move(0, 0, from, to)

    const out = new Uint32Array(16)
    // Retained cell (1,0): present exactly once.
    expect(g.query(520, 510, 10, 10, out)).toBe(1)
    // Retained cell (1,1): present exactly once.
    expect(g.query(520, 520, 10, 10, out)).toBe(1)
    // Gained cell (2,0): present.
    expect(g.query(1030, 510, 10, 10, out)).toBe(1)
    // Gained cell (2,1): present.
    expect(g.query(1030, 520, 10, 10, out)).toBe(1)
    // Lost cell (0,0): absent.
    expect(g.query(10, 510, 10, 10, out)).toBe(0)
    // Lost cell (0,1): absent.
    expect(g.query(10, 520, 10, 10, out)).toBe(0)
    // The whole new footprint (and its neighborhood), queried in one shot,
    // still yields the box exactly once — not once per shared cell.
    expect(g.query(950, 480, 150, 100, out)).toBe(1)
  })
})
