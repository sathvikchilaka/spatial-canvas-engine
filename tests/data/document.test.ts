import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { createSyntheticDocument } from '@/data/synthetic/source'
import { createFunsdDocument } from '@/data/funsd/source'
import { serializeGeneratedPage } from '@/data/synthetic/serialize'
import { PAGE_GAP, PAGE_H, PAGE_W, PAGES_PER_ROW } from '@/data/generator'

describe('synthetic document', () => {
  it('lays its pages out as the contact sheet the boxes are placed on', async () => {
    const doc = createSyntheticDocument(100, 1)
    expect(doc.id).toBe('synthetic')
    expect(doc.pageCount).toBe(100)
    const g = await doc.geometry()
    expect(g.count).toBe(100)
    const out = new Float32Array(4)
    g.origin(0, out)
    expect([out[0], out[1], out[2], out[3]]).toEqual([0, 0, PAGE_W, PAGE_H])
    // Row-major, `PAGES_PER_ROW` wide — not one tall column.
    g.origin(1, out)
    expect([out[0], out[1]]).toEqual([PAGE_W + PAGE_GAP, 0])
    g.origin(PAGES_PER_ROW, out)
    expect([out[0], out[1]]).toEqual([0, PAGE_H + PAGE_GAP])
  })

  /**
   * The regression that motivated this: the raster was laid out by the
   * document's geometry while the nodes were placed by a second, different
   * formula, so every page but page 0 had its boxes somewhere else entirely.
   * Geometry is now the only source of truth — node coords derive from the
   * offsets the drain loop reads out of it and hands the worker.
   */
  it('serializes every node inside its page rect from the geometry', async () => {
    const doc = createSyntheticDocument(100, 1)
    const g = await doc.geometry()
    const out = new Float32Array(4)
    for (const p of [0, 1, 5, 9, 10, 37, 99]) {
      g.origin(p, out)
      const [ox, oy, w, h] = [out[0], out[1], out[2], out[3]]
      const nodes = serializeGeneratedPage(p, 1, ox, oy)
      expect(nodes.length).toBeGreaterThan(0)
      for (const n of nodes) {
        expect(n.x).toBeGreaterThanOrEqual(ox)
        expect(n.y).toBeGreaterThanOrEqual(oy)
        expect(n.x + n.w).toBeLessThanOrEqual(ox + w)
        expect(n.y + n.h).toBeLessThanOrEqual(oy + h)
      }
    }
  })

  it('streams every page exactly once, out of order', async () => {
    const doc = createSyntheticDocument(20, 1)
    const stream = doc.createStream()
    const seen: number[] = []
    stream.start((e) => { if (e.type === 'page') seen.push(e.pageIndex) })
    await vi.waitFor(() => expect(seen).toHaveLength(20), { timeout: 5000 })
    expect([...seen].sort((a, b) => a - b)).toEqual([...Array(20).keys()])
    expect(seen).not.toEqual([...Array(20).keys()])
    stream.stop()
  })
})

describe('funsd document', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ pages: [{ id: 'a', w: 754, h: 1000 }, { id: 'b', w: 802, h: 1000 }] }),
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stacks pages at their manifest sizes', async () => {
    const doc = await createFunsdDocument()
    expect(doc.pageCount).toBe(2)
    const g = await doc.geometry()
    const out = new Float32Array(4)
    g.origin(0, out); expect([out[2], out[3]]).toEqual([754, 1000])
    g.origin(1, out); expect(out[1]).toBe(1000 + PAGE_GAP)
  })

  it('streams annotation urls, not node payloads', async () => {
    const doc = await createFunsdDocument()
    const stream = doc.createStream()
    const urls: string[] = []
    stream.start((e) => { if (e.type === 'page') urls.push(e.url) })
    await vi.waitFor(() => expect(urls).toHaveLength(2), { timeout: 5000 })
    expect(urls.every((u) => u.startsWith('/funsd/annotations/'))).toBe(true)
    stream.stop()
  })
})
