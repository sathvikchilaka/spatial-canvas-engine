import { generateDocument, type GeneratedPage } from '@/data/generator'
import { FLAG_DIRTY, FLAG_SELECTED, indexOfId, type NodeArrays, type Rect } from '@/data/nodes'
import { BucketGrid } from '@/engine/bucketGrid'
import { CanvasEngine } from '@/engine/engine'
import { attachInput } from '@/engine/input'
import { redo, undo, useStore } from '@/store/store'
import { toolHandlers } from '@/tools/adapter'
import { SelectTool } from '@/tools/selectTool'
import { applyPageUpdate } from '@/store/merge'
import type { StreamEvent, StreamSource } from '@/stream/source'
import { createStreamSource } from '@/stream/sseSource'
import { WorkerClient } from '@/worker/client'
import type { SerializedPage } from '@/worker/protocol'

const WORLD: Rect = { x: -2000, y: -2000, w: 20000, h: 400000 }

/**
 * Owns the whole non-React runtime: engine, worker, grid, tools. React
 * constructs one of these and disposes it; nothing here re-renders per frame.
 */
export class Session {
  readonly engine: CanvasEngine
  readonly worker: WorkerClient
  readonly grid = new BucketGrid()
  nodes: NodeArrays
  pages: GeneratedPage[]

  private readonly detachers: (() => void)[] = []
  private readonly tool: SelectTool
  private readonly rectScratch = new Float32Array(4)
  private ingestTimer = 0
  private stream: StreamSource | null = null
  private streamQueue: StreamEvent[] = []
  private drainTimer = 0
  /** Reported to the UI: pages seen, and edits the shield preserved. */
  status = { pagesReceived: 0, shielded: 0, connected: false, done: false }
  private onStatusChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, pageCount = 100, seed = 1) {
    this.engine = new CanvasEngine(canvas)
    this.worker = new WorkerClient(
      new Worker(new URL('../worker/index.worker.ts', import.meta.url), { type: 'module' }),
    )
    void this.worker.init(WORLD)

    const doc = generateDocument(pageCount, seed)
    this.nodes = doc.nodes
    this.pages = doc.pages

    // The worker owns the authoritative index; it needs the same nodes.
    // Chunked across frames — serializing 100 pages at once would be a long task.
    this.queueIngest()

    const indices = new Uint32Array(this.nodes.count)
    for (let i = 0; i < this.nodes.count; i++) indices[i] = i
    this.grid.addPage(0, this.nodes.ids, this.nodes.coords, indices)
    this.engine.setData(this.nodes, this.pages, this.grid)

    this.tool = new SelectTool({
      getRect: (id) => this.rectOf(id),
      pick: (x, y) => this.worker.hitTest(x, y),
      nearby: (rect, pad, out, excludeId) => this.nearby(rect, pad, out, excludeId),
      requestDraw: () => this.engine.requestDraw(),
      onCommit: (id, from, to) => void this.worker.updateNode(id, from, to),
    })

    this.detachers.push(this.engine.addOverlay((ctx, vp) => this.tool.drawHud(ctx, vp)))
    const handlers = toolHandlers(this.tool, this.engine)
    this.detachers.push(attachInput(this.engine, canvas, () => handlers))
    this.detachers.push(this.subscribeSelection())
    this.detachers.push(bindShortcuts())

    this.engine.start()
  }

  /**
   * Connects the live stream. Events queue and drain a bounded slice per tick
   * so ingestion never blocks a frame.
   */
  async connectStream(onStatusChange?: () => void): Promise<void> {
    this.onStatusChange = onStatusChange ?? null
    this.stream = await createStreamSource({
      pageCount: this.pages.length,
      seed: 1,
      onStatus: (connected) => {
        this.status.connected = connected
        this.onStatusChange?.()
      },
    })
    this.status.connected = true
    this.stream.start((e) => {
      this.streamQueue.push(e)
      this.scheduleDrain()
    })
  }

  private scheduleDrain() {
    if (this.drainTimer) return
    this.drainTimer = window.setTimeout(() => {
      this.drainTimer = 0
      const budgetEnd = performance.now() + 8
      while (this.streamQueue.length && performance.now() < budgetEnd) {
        const e = this.streamQueue.shift()!
        if (e.type === 'done') {
          this.status.done = true
          continue
        }
        this.worker.ingestPage({ pageIndex: e.pageIndex, nodes: e.nodes })
        const r = applyPageUpdate(e.pageIndex, e.nodes)
        this.status.pagesReceived++
        this.status.shielded += r.shielded
      }
      this.onStatusChange?.()
      this.engine.requestDraw()
      if (this.streamQueue.length) this.scheduleDrain()
    }, 0)
  }

  /** Feeds pages to the worker a few per tick so no task exceeds the budget. */
  private queueIngest(batch = 4) {
    let next = 0
    const step = () => {
      const end = Math.min(this.pages.length, next + batch)
      for (; next < end; next++) this.worker.ingestPage(this.serializePage(next))
      if (next < this.pages.length) this.ingestTimer = window.setTimeout(step, 0)
      else this.ingestTimer = 0
    }
    this.ingestTimer = window.setTimeout(step, 0)
  }

  get activeTool() {
    return this.tool
  }

  /** Live geometry: the human edit if there is one, else the extracted box. */
  rectOf(id: number): Rect | null {
    const edit = useStore.getState().edits[id]
    if (edit?.rect) return edit.rect
    const i = indexOfId(this.nodes, id)
    if (i < 0) return null
    const c = i * 4
    return {
      x: this.nodes.coords[c],
      y: this.nodes.coords[c + 1],
      w: this.nodes.coords[c + 2],
      h: this.nodes.coords[c + 3],
    }
  }

  serializePage(pageIndex: number): SerializedPage {
    const nodes = []
    for (let i = 0; i < this.nodes.count; i++) {
      if (this.nodes.pages[i] !== pageIndex) continue
      const c = i * 4
      nodes.push({
        id: this.nodes.ids[i],
        page: pageIndex,
        x: this.nodes.coords[c],
        y: this.nodes.coords[c + 1],
        w: this.nodes.coords[c + 2],
        h: this.nodes.coords[c + 3],
        type: this.nodes.types[i],
        parent: this.nodes.parents[i],
        order: this.nodes.order[i],
      })
    }
    return { pageIndex, nodes }
  }

  /** Candidate rects near `rect`, for snapping. Writes into `out`. */
  private nearby(rect: Rect, pad: number, out: Float32Array, excludeId: number): number {
    const idx = new Uint32Array(out.length / 4)
    const n = this.grid.query(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2, idx)
    let k = 0
    for (let j = 0; j < n && k * 4 + 3 < out.length; j++) {
      const i = idx[j]
      if (this.nodes.ids[i] === excludeId) continue
      const c = i * 4
      out[k * 4] = this.nodes.coords[c]
      out[k * 4 + 1] = this.nodes.coords[c + 1]
      out[k * 4 + 2] = this.nodes.coords[c + 2]
      out[k * 4 + 3] = this.nodes.coords[c + 3]
      k++
    }
    return k
  }

  /** Mirrors store selection/dirty state into the render flags. */
  private subscribeSelection(): () => void {
    let prevSelected = -1
    return useStore.subscribe((state) => {
      if (prevSelected >= 0) this.nodes.flags[prevSelected] &= ~FLAG_SELECTED
      const i = state.selectedId === null ? -1 : indexOfId(this.nodes, state.selectedId)
      if (i >= 0) this.nodes.flags[i] |= FLAG_SELECTED
      prevSelected = i
      for (const key of Object.keys(state.dirtyAt)) {
        const di = indexOfId(this.nodes, Number(key))
        if (di >= 0) this.nodes.flags[di] |= FLAG_DIRTY
      }
      this.applyEdits(state.edits)
      this.engine.requestDraw()
    })
  }

  /** Committed edits win over the extracted geometry in the render arrays. */
  private applyEdits(edits: Record<number, { rect?: Rect }>) {
    for (const key of Object.keys(edits)) {
      const rect = edits[Number(key)]?.rect
      if (!rect) continue
      const i = indexOfId(this.nodes, Number(key))
      if (i < 0) continue
      const c = i * 4
      this.nodes.coords[c] = rect.x
      this.nodes.coords[c + 1] = rect.y
      this.nodes.coords[c + 2] = rect.w
      this.nodes.coords[c + 3] = rect.h
    }
    void this.rectScratch
  }

  dispose(): void {
    this.stream?.stop()
    this.stream = null
    this.streamQueue.length = 0
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = 0
    this.onStatusChange = null
    if (this.ingestTimer) clearTimeout(this.ingestTimer)
    this.ingestTimer = 0
    for (const off of this.detachers) off()
    this.detachers.length = 0
    this.engine.dispose()
    this.worker.dispose()
    this.grid.clear()
  }
}

function bindShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod || e.key.toLowerCase() !== 'z') return
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
