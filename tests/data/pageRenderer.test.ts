import { describe, it, expect, vi } from 'vitest'
import { PageCache } from '@/data/pageRenderer'

const fakePage = (index: number) => ({ index, blocks: [], nodeCount: 0 })

describe('PageCache', () => {
  it('renders on first ensure and reuses afterwards', () => {
    const render = vi.fn(() => ({}) as never)
    const c = new PageCache(3, render)
    c.ensure(0, fakePage(0)); c.ensure(0, fakePage(0))
    expect(render).toHaveBeenCalledTimes(1)
    expect(c.get(0)).not.toBeNull()
  })

  it('never holds more than maxPages', () => {
    const c = new PageCache(3, () => ({}) as never)
    for (let i = 0; i < 10; i++) c.ensure(i, fakePage(i))
    expect(c.size).toBeLessThanOrEqual(3)
  })

  it('evicts pages outside the visible range', () => {
    const c = new PageCache(10, () => ({}) as never)
    for (let i = 0; i < 8; i++) c.ensure(i, fakePage(i))
    c.evictOutside(5, 7)
    expect(c.get(0)).toBeNull()
    expect(c.get(6)).not.toBeNull()
  })

  it('drops everything on dispose', () => {
    const c = new PageCache(4, () => ({}) as never)
    c.ensure(1, fakePage(1)); c.dispose()
    expect(c.size).toBe(0)
  })

  it('does not cache or throw when page is undefined', () => {
    const render = vi.fn(() => ({}) as never)
    const c = new PageCache(3, render)
    c.ensure(0)
    expect(render).not.toHaveBeenCalled()
    expect(c.get(0)).toBeNull()
  })
})

describe('PageCache async rasters', () => {
  const fakeBitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap

  it('returns null while a raster is pending, then the bitmap', async () => {
    let resolve!: (b: ImageBitmap) => void
    const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)))

    cache.ensure(0, fakePage(0))
    expect(cache.get(0)).toBeNull()

    const bmp = fakeBitmap()
    resolve(bmp)
    await Promise.resolve()
    expect(cache.get(0)).toBe(bmp)
    cache.dispose()
  })

  it('does not start a second load for a page already pending', () => {
    const render = vi.fn(() => new Promise<ImageBitmap>(() => {}))
    const cache = new PageCache(4, render)
    cache.ensure(0, fakePage(0))
    cache.ensure(0, fakePage(0))
    expect(render).toHaveBeenCalledTimes(1)
    cache.dispose()
  })

  it('closes a raster that resolves after its page was evicted', async () => {
    let resolve!: (b: ImageBitmap) => void
    const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)))

    cache.ensure(5, fakePage(5))
    cache.evictOutside(0, 0) // page 5 is no longer wanted

    const bmp = fakeBitmap()
    resolve(bmp)
    await Promise.resolve()

    expect(bmp.close).toHaveBeenCalled()
    expect(cache.get(5)).toBeNull()
    cache.dispose()
  })

  it('closes a raster that resolves after dispose', async () => {
    let resolve!: (b: ImageBitmap) => void
    const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)))
    cache.ensure(0, fakePage(0))
    cache.dispose()

    const bmp = fakeBitmap()
    resolve(bmp)
    await Promise.resolve()

    expect(bmp.close).toHaveBeenCalled()
  })

  it('notifies when a raster becomes available so the frame can redraw', async () => {
    let resolve!: (b: ImageBitmap) => void
    const onReady = vi.fn()
    const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)), onReady)
    cache.ensure(0, fakePage(0))
    resolve(fakeBitmap())
    await Promise.resolve()
    expect(onReady).toHaveBeenCalled()
    cache.dispose()
  })

  it('survives 20 construct/dispose cycles with in-flight decodes without leaking', async () => {
    const rounds: Array<{ resolve: (b: ImageBitmap) => void; bmp: ReturnType<typeof fakeBitmap>; cache: PageCache }> = []

    for (let i = 0; i < 20; i++) {
      let resolve!: (b: ImageBitmap) => void
      const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)))
      cache.ensure(0, fakePage(0))
      cache.dispose()
      rounds.push({ resolve, bmp: fakeBitmap(), cache })
    }

    for (const { resolve, bmp } of rounds) resolve(bmp)
    await Promise.resolve()
    await Promise.resolve()

    for (const { bmp, cache } of rounds) {
      expect(bmp.close).toHaveBeenCalled()
      expect(cache.get(0)).toBeNull()
      expect(cache.size).toBe(0)
    }
  })

  it('clears the pending entry on a failed render so a later ensure can retry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const bmp = fakeBitmap()
    const render = vi.fn(() => {
      calls++
      if (calls === 1) throw new Error('no 2d context')
      return bmp
    })
    const cache = new PageCache(4, render)

    cache.ensure(0, fakePage(0))
    expect(render).toHaveBeenCalledTimes(1)
    expect(cache.get(0)).toBeNull()

    cache.ensure(0, fakePage(0))
    expect(render).toHaveBeenCalledTimes(2)
    expect(cache.get(0)).toBe(bmp)

    warn.mockRestore()
    cache.dispose()
  })

  it('clears the pending entry on a rejected promise so a later ensure can retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const bmp = fakeBitmap()
    const render = vi.fn(() => {
      calls++
      return calls === 1 ? Promise.reject(new Error('decode failed')) : Promise.resolve(bmp)
    })
    const cache = new PageCache(4, render)

    cache.ensure(0, fakePage(0))
    await Promise.resolve()
    await Promise.resolve()
    expect(cache.get(0)).toBeNull()

    cache.ensure(0, fakePage(0))
    await Promise.resolve()
    await Promise.resolve()
    expect(render).toHaveBeenCalledTimes(2)
    expect(cache.get(0)).toBe(bmp)

    warn.mockRestore()
    cache.dispose()
  })
})
