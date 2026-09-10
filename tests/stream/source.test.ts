// tests/stream/source.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MockStreamSource } from '@/stream/mockSource'
import { parseSseEnvelope } from '@/stream/sseSource'

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

describe('parseSseEnvelope', () => {
  it('reads a page envelope and leaves the body as an opaque string', () => {
    const body = JSON.stringify({ form: [{ id: 1, box: [0, 0, 1, 1], text: 'x', label: 'other', words: [], linking: [] }] })
    const e = parseSseEnvelope(JSON.stringify({ t: 'p', i: 12, d: body }))
    expect(e).toEqual({ type: 'page', pageIndex: 12, payload: body })
    // The body is a string, not an object — parsing it is the worker's job.
    expect(typeof (e as { payload: string }).payload).toBe('string')
  })

  it('reads a done envelope', () => {
    expect(parseSseEnvelope(JSON.stringify({ t: 'd' }))).toEqual({ type: 'done' })
  })

  it('drops a malformed envelope rather than throwing', () => {
    expect(parseSseEnvelope('{not json')).toBeNull()
    expect(parseSseEnvelope(JSON.stringify({ t: 'p' }))).toBeNull()
    expect(parseSseEnvelope(JSON.stringify({ t: 'p', i: 'x', d: '{}' }))).toBeNull()
    expect(parseSseEnvelope(JSON.stringify({ t: 'z' }))).toBeNull()
  })

  it('drops a page envelope with a non-string body', () => {
    expect(parseSseEnvelope(JSON.stringify({ t: 'p', i: 1, d: { form: [] } }))).toBeNull()
  })
})
