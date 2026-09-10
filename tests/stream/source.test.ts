// tests/stream/source.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MockStreamSource } from '@/stream/mockSource'

describe('MockStreamSource', () => {
  it('emits every page exactly once, then done', async () => {
    vi.useFakeTimers()
    const src = new MockStreamSource(10, 1)
    const seen: number[] = []
    let done = false
    src.start((e) => {
      if (e.type === 'page') seen.push(e.pageIndex)
      else done = true
    })
    await vi.runAllTimersAsync()
    expect(seen.slice().sort((a, b) => a - b)).toEqual([...Array(10).keys()])
    expect(done).toBe(true)
    vi.useRealTimers()
  })

  it('emits out of order', async () => {
    vi.useFakeTimers()
    const src = new MockStreamSource(30, 7)
    const seen: number[] = []
    src.start((e) => { if (e.type === 'page') seen.push(e.pageIndex) })
    await vi.runAllTimersAsync()
    expect(seen).not.toEqual([...Array(30).keys()])
    vi.useRealTimers()
  })

  it('stops emitting after stop()', async () => {
    vi.useFakeTimers()
    const src = new MockStreamSource(50, 3)
    const cb = vi.fn()
    src.start(cb)
    await vi.advanceTimersByTimeAsync(50)
    src.stop()
    const n = cb.mock.calls.length
    await vi.runAllTimersAsync()
    expect(cb.mock.calls.length).toBe(n)
  })
})
