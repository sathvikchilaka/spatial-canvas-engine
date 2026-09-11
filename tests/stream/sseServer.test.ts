// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { envelope, shuffledPages } from '../../server/sse.mjs'
import { parseSseEnvelope } from '@/stream/sseSource'

describe('sse dev server', () => {
  it('emits an envelope the client can parse', () => {
    const body = JSON.stringify({ form: [] })
    const line = envelope(12, body)
    expect(line.startsWith('data: ')).toBe(true)
    expect(line.endsWith('\n\n')).toBe(true)
    const parsed = parseSseEnvelope(line.slice('data: '.length).trimEnd())
    expect(parsed).toEqual({ type: 'page', pageIndex: 12, payload: body })
  })

  it('keeps the body opaque even when it contains quotes and newlines', () => {
    const body = '{"form":[{"text":"He said \\"hi\\"\\n"}]}'
    const line = envelope(0, body)
    const parsed = parseSseEnvelope(line.slice('data: '.length).trimEnd())
    expect((parsed as { payload: string }).payload).toBe(body)
  })

  it('never emits a bare newline inside the data field', () => {
    // A literal \n in an SSE data line would terminate the event early.
    const line = envelope(0, '{"a":"x\ny"}')
    expect(line.slice(0, -2).includes('\n')).toBe(false)
  })

  it('shuffles every page exactly once, deterministically', () => {
    const a = shuffledPages(50, 7)
    const b = shuffledPages(50, 7)
    expect(a).toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i))
    expect(a).not.toEqual(Array.from({ length: 50 }, (_, i) => i))
  })
})
