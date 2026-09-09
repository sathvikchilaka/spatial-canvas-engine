import { generatePage, pageOrigin } from '@/data/generator'
import { NodeType } from '@/data/nodes'
import type { SerializedNode } from '@/worker/protocol'
import type { StreamEvent, StreamSource } from './source'

function mulberry32(a: number) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Page indices in a seeded shuffle — arrival is guaranteed out of order. */
export function shuffledPages(count: number, seed: number): number[] {
  const rnd = mulberry32(seed || 1)
  const order = Array.from({ length: count }, (_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

/** Nodes for one generated page, in the wire shape the worker parses. */
export function serializeGeneratedPage(pageIndex: number, seed: number): SerializedNode[] {
  const page = generatePage(pageIndex, seed)
  const [ox, oy] = pageOrigin(pageIndex)
  const out: SerializedNode[] = []
  let id = pageIndex * 1000 + 1
  let order = 0
  for (const b of page.blocks) {
    const parent = id
    out.push({
      id: id++, page: pageIndex, x: ox + b.x, y: oy + b.y, w: b.w, h: b.h,
      type: b.kind === 'figure' ? NodeType.Figure : NodeType.Paragraph,
      parent: -1, order: order++,
    })
    for (const k of b.cells ?? b.lines ?? []) {
      out.push({
        id: id++, page: pageIndex, x: ox + k.x, y: oy + k.y, w: k.w, h: k.h,
        type: b.cells ? NodeType.Cell : NodeType.Line,
        parent, order: order++,
      })
    }
  }
  return out
}

/**
 * In-app fallback behind the same interface as the real endpoint, so the rest
 * of the app cannot tell which one it is talking to.
 */
export class MockStreamSource implements StreamSource {
  private timers: number[] = []
  private stopped = false
  private readonly pageCount: number
  private readonly seed: number

  constructor(pageCount: number, seed = 1) {
    this.pageCount = pageCount
    this.seed = seed
  }

  get connected(): boolean {
    return !this.stopped
  }

  start(onEvent: (e: StreamEvent) => void): void {
    this.stopped = false
    const order = shuffledPages(this.pageCount, this.seed)
    const rnd = mulberry32(this.seed + 99)
    let t = 0
    order.forEach((pageIndex) => {
      t += 20 + Math.floor(rnd() * 100)
      this.timers.push(
        setTimeout(() => {
          if (this.stopped) return
          onEvent({ type: 'page', pageIndex, nodes: serializeGeneratedPage(pageIndex, this.seed) })
        }, t) as unknown as number,
      )
    })
    this.timers.push(
      setTimeout(() => {
        if (!this.stopped) onEvent({ type: 'done' })
      }, t + 40) as unknown as number,
    )
  }

  stop(): void {
    this.stopped = true
    for (const id of this.timers) clearTimeout(id)
    this.timers.length = 0
  }
}
