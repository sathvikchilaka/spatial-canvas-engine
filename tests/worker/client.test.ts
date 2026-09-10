// tests/worker/client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WorkerClient } from '@/worker/client'
import { UNSOLICITED } from '@/worker/protocol'

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

describe('WorkerClient.ingestUrl', () => {
  it('posts an ingestUrl request with the page offset', () => {
    const postMessage = vi.fn()
    const worker = { postMessage, terminate: vi.fn() } as unknown as Worker
    const client = new WorkerClient(worker)

    client.ingestUrl(7, '/funsd/annotations/abc.json', 0, 7280)

    expect(postMessage).toHaveBeenCalledWith({
      id: UNSOLICITED,
      kind: 'ingestUrl',
      pageIndex: 7,
      url: '/funsd/annotations/abc.json',
      offsetX: 0,
      offsetY: 7280,
    })
    client.dispose()
  })

  it('forwards the edges array to page subscribers', () => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker
    const client = new WorkerClient(worker)
    const seen: Int32Array[] = []
    client.onPageIngested((p) => seen.push(p.edges))

    worker.onmessage?.({
      data: {
        id: UNSOLICITED, kind: 'pageIngested', pageIndex: 0,
        ids: new Uint32Array(0), coords: new Float32Array(0), types: new Uint8Array(0),
        parents: new Int32Array(0), order: new Int32Array(0), edges: Int32Array.of(1, 2),
        texts: [], labels: new Uint8Array(0),
      },
    } as MessageEvent)

    expect(Array.from(seen[0])).toEqual([1, 2])
    client.dispose()
  })

  it('forwards texts and labels to the ingest handler', async () => {
    // Extend the existing fake reply with the two new fields and assert the
    // handler receives them verbatim — the seam is the only place text can be
    // silently dropped, and it already was once.
    const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker
    const client = new WorkerClient(worker)
    const received: string[][] = []
    client.onPageIngested((p) => received.push([...p.texts]))

    worker.onmessage?.({
      data: {
        id: UNSOLICITED, kind: 'pageIngested', pageIndex: 0,
        ids: new Uint32Array(0), coords: new Float32Array(0), types: new Uint8Array(0),
        parents: new Int32Array(0), order: new Int32Array(0), edges: new Int32Array(0),
        texts: ['Name:', 'Name'], labels: Uint8Array.of(1, 5),
      },
    } as MessageEvent)

    await Promise.resolve()
    expect(received[0]).toEqual(['Name:', 'Name'])
    client.dispose()
  })
})
