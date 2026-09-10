import type { Rect } from '@/data/nodes'
import {
  UNSOLICITED,
  type PageIngested,
  type Req,
  type Res,
  type SerializedNode,
  type SerializedPage,
} from './protocol'

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void }

/** Omit over a union must distribute, or every member loses its own fields. */
type ReqBody = Req extends infer T ? (T extends Req ? Omit<T, 'id'> : never) : never

/**
 * Main-thread wrapper: typed postMessage with reqId-matched promises, plus a
 * subscription channel for the worker's unsolicited page-ingest events.
 */
export class WorkerClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly pageSubs = new Set<(p: PageIngested) => void>()
  private readonly errorSubs = new Set<(e: Error) => void>()
  private disposed = false

  private readonly worker: Worker

  constructor(worker: Worker) {
    this.worker = worker
    this.worker.onmessage = (e: MessageEvent<Res>) => this.receive(e.data)
    this.worker.onerror = (e) => {
      const err = new Error((e as ErrorEvent).message || 'worker error')
      for (const cb of this.errorSubs) cb(err)
    }
  }

  init(bounds: Rect): Promise<void> {
    return this.request({ kind: 'init', bounds }) as Promise<void>
  }

  hitTest(x: number, y: number): Promise<number | null> {
    return this.request({ kind: 'hitTest', x, y }) as Promise<number | null>
  }

  queryRect(r: Rect): Promise<Uint32Array> {
    return this.request({ kind: 'queryRect', ...r }) as Promise<Uint32Array>
  }

  updateNode(nodeId: number, old: Rect, next: Rect): Promise<void> {
    return this.request({ kind: 'updateNode', nodeId, old, next }) as Promise<void>
  }

  /** Adds a reviewer-created node to the index (a split table cell). */
  insertNode(node: SerializedNode): Promise<void> {
    return this.request({ kind: 'insertNode', node }) as Promise<void>
  }

  /** Drops a node from the index so it stops answering hit tests. */
  removeNode(nodeId: number, rect: Rect): Promise<void> {
    return this.request({ kind: 'removeNode', nodeId, rect }) as Promise<void>
  }

  reset(): Promise<void> {
    return this.request({ kind: 'reset' }) as Promise<void>
  }

  /** Fire-and-forget: ingestion answers via the pageIngested subscription. */
  ingestPage(page: SerializedPage): void {
    this.worker.postMessage({ id: UNSOLICITED, kind: 'ingestPage', page } satisfies Req)
  }

  /** Fire-and-forget: the worker fetches and parses; we only get typed arrays back. */
  ingestUrl(pageIndex: number, url: string, offsetX: number, offsetY: number): void {
    this.worker.postMessage({
      id: UNSOLICITED, kind: 'ingestUrl', pageIndex, url, offsetX, offsetY,
    } satisfies Req)
  }

  /**
   * Hands the worker a raw payload string. The caller must NOT parse it first —
   * `JSON.parse` of a page body on the main thread is precisely the long task
   * this architecture exists to avoid.
   */
  ingestJson(pageIndex: number, json: string, offsetX: number, offsetY: number): Promise<void> {
    return this.request({ kind: 'ingestJson', pageIndex, json, offsetX, offsetY }) as Promise<void>
  }

  onPageIngested(cb: (p: PageIngested) => void): () => void {
    this.pageSubs.add(cb)
    return () => this.pageSubs.delete(cb)
  }

  onError(cb: (e: Error) => void): () => void {
    this.errorSubs.add(cb)
    return () => this.errorSubs.delete(cb)
  }

  /** Rejects everything in flight before terminating — otherwise teardown leaks promises. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const p of this.pending.values()) p.reject(new Error('worker disposed'))
    this.pending.clear()
    this.pageSubs.clear()
    this.errorSubs.clear()
    this.worker.terminate()
  }

  private request(body: ReqBody): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('worker disposed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject })
      this.worker.postMessage({ id, ...body } as Req)
    })
  }

  private receive(msg: Res) {
    if (msg.kind === 'pageIngested') {
      for (const cb of this.pageSubs) cb(msg)
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.kind === 'error') p.reject(new Error(msg.message))
    else if (msg.kind === 'hit') p.resolve(msg.nodeId as never)
    else if (msg.kind === 'rect') p.resolve(msg.ids as never)
    else p.resolve(undefined as never)
  }
}
