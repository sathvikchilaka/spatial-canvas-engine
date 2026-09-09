// tests/worker/client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WorkerClient } from '@/worker/client'

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  posted: unknown[] = []
  terminated = false
  postMessage(m: never) { this.posted.push(m) }
  terminate() { this.terminated = true }
  reply(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
}

describe('WorkerClient', () => {
  it('resolves a request by matching reqId', async () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const p = c.hitTest(10, 20)
    const sent = w.posted[0] as { id: number }
    w.reply({ id: sent.id, kind: 'hit', nodeId: 42 })
    await expect(p).resolves.toBe(42)
  })

  it('keeps concurrent requests independent', async () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const a = c.hitTest(1, 1), b = c.hitTest(2, 2)
    const [ra, rb] = w.posted as { id: number }[]
    w.reply({ id: rb.id, kind: 'hit', nodeId: 2 })
    w.reply({ id: ra.id, kind: 'hit', nodeId: 1 })
    expect(await a).toBe(1)
    expect(await b).toBe(2)
  })

  it('rejects on an error response', async () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const p = c.hitTest(0, 0)
    w.reply({ id: (w.posted[0] as { id: number }).id, kind: 'error', message: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('delivers unsolicited page events to subscribers and unsubscribes', () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const cb = vi.fn()
    const off = c.onPageIngested(cb)
    w.reply({ id: -1, kind: 'pageIngested', pageIndex: 3, ids: new Uint32Array(0) })
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    w.reply({ id: -1, kind: 'pageIngested', pageIndex: 4, ids: new Uint32Array(0) })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('terminates and rejects pending requests on dispose', async () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const p = c.hitTest(0, 0)
    c.dispose()
    expect(w.terminated).toBe(true)
    await expect(p).rejects.toThrow()
  })
})
