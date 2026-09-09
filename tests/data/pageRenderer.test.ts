import { describe, it, expect, vi } from 'vitest'
import { PageCache } from '@/data/pageRenderer'

const fakePage = (index: number) => ({ index, blocks: [], nodeCount: 0 })

describe('PageCache', () => {
  it('renders on first ensure and reuses afterwards', () => {
    const render = vi.fn(() => ({}) as never)
    const c = new PageCache(3, render)
    c.ensure(fakePage(0)); c.ensure(fakePage(0))
    expect(render).toHaveBeenCalledTimes(1)
    expect(c.get(fakePage(0))).not.toBeNull()
  })

  it('never holds more than maxPages', () => {
    const c = new PageCache(3, () => ({}) as never)
    for (let i = 0; i < 10; i++) c.ensure(fakePage(i))
    expect(c.size).toBeLessThanOrEqual(3)
  })

  it('evicts pages outside the visible range', () => {
    const c = new PageCache(10, () => ({}) as never)
    for (let i = 0; i < 8; i++) c.ensure(fakePage(i))
    c.evictOutside(5, 7)
    expect(c.get(fakePage(0))).toBeNull()
    expect(c.get(fakePage(6))).not.toBeNull()
  })

  it('drops everything on dispose', () => {
    const c = new PageCache(4, () => ({}) as never)
    c.ensure(fakePage(1)); c.dispose()
    expect(c.size).toBe(0)
  })
})
