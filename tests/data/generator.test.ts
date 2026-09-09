import { describe, it, expect } from 'vitest'
import { generatePage, generateDocument, pageOrigin, PAGE_W, PAGE_H } from '@/data/generator'

describe('generator', () => {
  it('is deterministic for a given seed', () => {
    expect(JSON.stringify(generatePage(3, 42))).toBe(JSON.stringify(generatePage(3, 42)))
  })

  it('differs across pages and across seeds', () => {
    expect(JSON.stringify(generatePage(3, 42))).not.toBe(JSON.stringify(generatePage(4, 42)))
    expect(JSON.stringify(generatePage(3, 42))).not.toBe(JSON.stringify(generatePage(3, 43)))
  })

  it('keeps every block inside the page bounds', () => {
    for (let p = 0; p < 20; p++) {
      for (const b of generatePage(p, 7).blocks) {
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.y).toBeGreaterThanOrEqual(0)
        expect(b.x + b.w).toBeLessThanOrEqual(PAGE_W)
        expect(b.y + b.h).toBeLessThanOrEqual(PAGE_H)
      }
    }
  })

  it('never overlaps sibling blocks vertically', () => {
    const blocks = generatePage(1, 7).blocks.slice().sort((a, b) => a.y - b.y)
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].y).toBeGreaterThanOrEqual(blocks[i - 1].y + blocks[i - 1].h - 0.001)
    }
  })

  it('stacks pages vertically without overlap', () => {
    expect(pageOrigin(0)[1]).toBe(0)
    expect(pageOrigin(1)[1]).toBeGreaterThanOrEqual(PAGE_H)
  })

  it('produces ~10k nodes across 100 pages', () => {
    const { nodes } = generateDocument(100, 1)
    expect(nodes.count).toBeGreaterThan(8000)
    expect(nodes.count).toBeLessThan(14000)
  })

  it('gives every node a unique id and a valid parent', () => {
    const { nodes } = generateDocument(5, 1)
    const seen = new Set<number>()
    for (let i = 0; i < nodes.count; i++) {
      expect(seen.has(nodes.ids[i])).toBe(false)
      seen.add(nodes.ids[i])
      const p = nodes.parents[i]
      expect(p === -1 || p < nodes.count).toBe(true)
    }
  })
})
