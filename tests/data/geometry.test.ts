import { describe, expect, it } from 'vitest'
import { gridGeometry, stackedGeometry, uniformGeometry } from '@/data/geometry'
import { PAGE_GAP, PAGE_H, PAGE_W, PAGES_PER_ROW, pageOrigin } from '@/data/generator'

describe('uniformGeometry', () => {
  const g = uniformGeometry(100, PAGE_W, PAGE_H, PAGE_GAP)
  const out = new Float32Array(4)

  it('stacks every page in one column', () => {
    const stride = PAGE_H + PAGE_GAP
    for (let p = 0; p < 100; p++) {
      g.origin(p, out)
      expect([out[0], out[1]]).toEqual([0, p * stride])
    }
  })

  it('matches the legacy constant-stride range math', () => {
    const stride = PAGE_H + PAGE_GAP
    for (const y of [0, stride * 3.5, stride * 99]) {
      const legacyFrom = Math.max(0, Math.floor(y / stride))
      const legacyTo = Math.min(99, Math.floor((y + 2000) / stride))
      expect(g.rangeFor(y, 2000)).toEqual([legacyFrom, legacyTo])
    }
  })
})

describe('stackedGeometry', () => {
  // Deliberately variable heights — the case uniform math cannot express.
  const g = stackedGeometry([{ w: 10, h: 100 }, { w: 20, h: 50 }, { w: 30, h: 200 }], 10)
  const out = new Float32Array(4)

  it('stacks pages at their own heights', () => {
    g.origin(0, out); expect([out[1], out[3]]).toEqual([0, 100])
    g.origin(1, out); expect([out[1], out[3]]).toEqual([110, 50])
    g.origin(2, out); expect([out[1], out[3]]).toEqual([170, 200])
  })

  it('finds the pages intersecting a span', () => {
    expect(g.rangeFor(0, 5)).toEqual([0, 0])
    expect(g.rangeFor(115, 10)).toEqual([1, 1])
    expect(g.rangeFor(0, 400)).toEqual([0, 2])
  })

  it('clamps a span above the document to the last page', () => {
    expect(g.rangeFor(10_000, 100)).toEqual([2, 2])
  })

  it('clamps a span below the document to the first page', () => {
    expect(g.rangeFor(-500, 100)).toEqual([0, 0])
  })
})

import { PageLayer } from '@/engine/layers/pages'

describe('PageLayer with geometry', () => {
  it('draws each page at its geometry rect, not a constant stride', () => {
    const g = stackedGeometry([{ w: 10, h: 100 }, { w: 20, h: 50 }], 10)
    const calls: number[][] = []
    const ctx = {
      fillStyle: '',
      fillRect: (x: number, y: number, w: number, h: number) => calls.push([x, y, w, h]),
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D

    const layer = new PageLayer(4, () => ({}) as never)
    layer.draw(ctx, g, 0, 1)

    // Page 1's paper rect starts at y=110 and is 50 tall.
    expect(calls.some(([, y, w, h]) => y === 110 && w === 20 && h === 50)).toBe(true)
    layer.dispose()
  })
})

describe('gridGeometry', () => {
  // The synthetic document's paper must sit under the boxes the generator places,
  // so this geometry and `pageOrigin` are two views of one contact-sheet layout.
  const g = gridGeometry(100, PAGE_W, PAGE_H, PAGE_GAP, PAGES_PER_ROW)
  const out = new Float32Array(4)

  it('places every page where the generator puts its boxes', () => {
    for (let p = 0; p < 100; p++) {
      const [ox, oy] = pageOrigin(p)
      g.origin(p, out)
      expect([out[0], out[1]]).toEqual([ox, oy])
    }
  })

  it('widens a row span to whole rows', () => {
    // A sliver inside row 0 still returns all of row 0 — over-inclusive on x by
    // contract; PageLayer drops the off-screen columns.
    expect(g.rangeFor(0, 1)).toEqual([0, PAGES_PER_ROW - 1])
    const stride = PAGE_H + PAGE_GAP
    expect(g.rangeFor(stride, 1)).toEqual([PAGES_PER_ROW, PAGES_PER_ROW * 2 - 1])
  })

  it('clamps the final row to the page count', () => {
    const partial = gridGeometry(12, PAGE_W, PAGE_H, PAGE_GAP, PAGES_PER_ROW)
    expect(partial.rangeFor(0, PAGE_H * 10)).toEqual([0, 11])
  })

  it('reports an empty range for an empty document', () => {
    expect(gridGeometry(0, PAGE_W, PAGE_H, PAGE_GAP, PAGES_PER_ROW).rangeFor(0, 100)).toEqual([
      0, -1,
    ])
  })
})
