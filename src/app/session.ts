import { createNodeArrays, FLAG_DIRTY, FLAG_SELECTED, indexOfId, pushNode, type NodeArrays, type NodeType, type Rect } from '@/data/nodes'
import type { DocumentSource } from '@/data/document'
import type { PageGeometry } from '@/data/geometry'
import { BucketGrid } from '@/engine/bucketGrid'
import { CanvasEngine } from '@/engine/engine'
import { attachInput } from '@/engine/input'
import { screenToWorld } from '@/engine/viewport'
import { redo, undo, useStore } from '@/store/store'
import { toolHandlers } from '@/tools/adapter'
import { OrderTool } from '@/tools/orderTool'
import { SelectTool } from '@/tools/selectTool'
import { OrderOverlay } from '@/engine/layers/overlays'
import { appendEdges, createEdgeSet, hasEdge, materialize, type EdgeSet } from '@/data/edges'
import type { Tool } from '@/tools/types'
import { applyPageUpdate } from '@/store/merge'
import type { StreamEvent, StreamSource } from '@/stream/source'
import { WorkerClient } from '@/worker/client'
import type { PageIngested } from '@/worker/protocol'

const WORLD: Rect = { x: -2000, y: -2000, w: 20000, h: 400000 }

/**
 * Owns the whole non-React runtime: engine, worker, grid, tools. React
 * constructs one of these and disposes it; nothing here re-renders per frame.
 */
export class Session {
  readonly engine: CanvasEngine
  readonly worker: WorkerClient
  readonly grid = new BucketGrid()
  /** Empty until the stream ingests pages — there is no local truth ahead of it. */
  nodes: NodeArrays = createNodeArrays(1024)
  /** Resolves once the document's geometry is known and the engine has it. */
  readonly ready: Promise<void>

  private readonly doc: DocumentSource
  private geometry!: PageGeometry

  private readonly detachers: (() => void)[] = []
  private readonly selectTool: SelectTool
  private readonly orderTool: OrderTool
  private readonly orderOverlay = new OrderOverlay()
  private tool: Tool
  private toolName: 'select' | 'order' = 'select'
  private orderDirty = true
  private baseEdges: EdgeSet = createEdgeSet()
  private effectiveEdges: EdgeSet = createEdgeSet()
  private readonly pageRect = new Float32Array(4)
  /**
   * The stream's geometry per node, parallel to `nodes.coords` (x/y/w/h at
   * `i * 4`). `applyEdits` writes human edits *into* `nodes.coords`, which
   * destroys the baseline it would need to put a node back when its edit is
   * undone — so the baseline is kept here instead of being re-derived.
   */
  private baseCoords = new Float32Array(1024 * 4)
  /** Node ids whose `nodes.coords` currently hold an edit, not the stream value. */
  private readonly overridden = new Set<number>()
  private stream: StreamSource | null = null
  /** Set by `dispose()`. Guards every continuation that resumes after an await. */
  private disposed = false
  private streamQueue: StreamEvent[] = []
  private drainTimer = 0
  /** Reported to the UI: pages seen, and edits the shield preserved. */
  status = { pagesReceived: 0, shielded: 0, connected: false, done: false }
  private onStatusChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, doc: DocumentSource) {
    this.doc = doc
    this.engine = new CanvasEngine(canvas)
    this.worker = new WorkerClient(
      new Worker(new URL('../worker/index.worker.ts', import.meta.url), { type: 'module' }),
    )
    // Disposing before `init` settles rejects it; that is expected teardown,
    // not a failure, and an unhandled rejection would surface as a console
    // error on every fast document switch.
    void this.worker.init(WORLD).catch((err) => {
      if (!this.disposed) throw err
    })

    // Swap the raster source in without reconstructing the engine — a raster
    // decode is async (real FUNSD PNGs), the engine construction is not.
    this.engine.setPageRenderer(
      (index) => doc.raster(index),
      () => this.engine.requestDraw(),
    )

    this.ready = doc.geometry().then((geometry) => {
      // Same continuation hazard as `connectStream`: geometry can settle after
      // a document switch already tore this session down.
      if (this.disposed) return
      this.geometry = geometry
      this.engine.setData(this.nodes, this.grid, geometry)
    })

    this.selectTool = new SelectTool({
      getRect: (id) => this.rectOf(id),
      pick: (x, y) => this.worker.hitTest(x, y),
      nearby: (rect, pad, out, excludeId) => this.nearby(rect, pad, out, excludeId),
      requestDraw: () => this.engine.requestDraw(),
    })
    this.orderTool = new OrderTool({
      getRect: (id) => this.rectOf(id),
      pick: (x, y) => this.worker.hitTest(x, y),
      requestDraw: () => this.engine.requestDraw(),
      hasEdge: (f, t) => hasEdge(this.effectiveEdges, f, t),
    })
    this.tool = this.selectTool

    this.detachers.push(this.worker.onPageIngested((p) => this.onPageIngested(p)))
    this.detachers.push(this.engine.addOverlay((ctx, vp) => this.drawOrder(ctx, vp.scale)))
    this.detachers.push(this.engine.addOverlay((ctx, vp) => this.drawHover(ctx, vp.scale)))
    this.detachers.push(this.engine.addOverlay((ctx, vp) => this.tool.drawHud(ctx, vp)))
    this.detachers.push(this.trackHover(canvas))
    const handlerCache = new Map<Tool, ReturnType<typeof toolHandlers>>()
    this.detachers.push(
      attachInput(this.engine, canvas, () => {
        let h = handlerCache.get(this.tool)
        if (!h) {
          h = toolHandlers(this.tool, this.engine)
          handlerCache.set(this.tool, h)
        }
        return h
      }),
    )
    this.detachers.push(this.subscribeSelection())
    this.detachers.push(bindShortcuts())

    this.engine.start()
  }

  /**
   * Connects the live stream. Events queue and drain a bounded slice per tick
   * so ingestion never blocks a frame. Waits for `ready` first — the drain
   * loop needs page geometry to compute each page's world origin.
   */
  async connectStream(onStatusChange?: () => void): Promise<void> {
    this.onStatusChange = onStatusChange ?? null
    await this.ready
    // Switching documents can dispose this session while `doc.geometry()` is
    // still pending. Without this guard the continuation installs a live source
    // on a corpse: its timers fire forever into a terminated worker.
    if (this.disposed) return
    this.stream = this.doc.createStream()
    this.status.connected = true
    this.onStatusChange?.()
    this.stream.start((e) => {
      this.streamQueue.push(e)
      this.scheduleDrain()
    })
  }

  private scheduleDrain() {
    if (this.drainTimer || this.disposed) return
    this.drainTimer = window.setTimeout(() => {
      this.drainTimer = 0
      const budgetEnd = performance.now() + 8
      while (this.streamQueue.length && performance.now() < budgetEnd) {
        const e = this.streamQueue.shift()!
        if (e.type === 'done') {
          this.status.done = true
          continue
        }
        // The worker fetches/parses the url and reports back via
        // onPageIngested — the main thread never touches the raw payload.
        this.geometry.origin(e.pageIndex, this.pageRect)
        this.worker.ingestUrl(e.pageIndex, e.url, this.pageRect[0], this.pageRect[1])
      }
      this.onStatusChange?.()
      this.engine.requestDraw()
      if (this.streamQueue.length) this.scheduleDrain()
    }, 0)
  }

  /**
   * The worker's authoritative reply for one page: appends its nodes/edges
   * into the local arrays and the grid, then runs the dirty shield (R6) so a
   * late-arriving page can never clobber a box the human already edited.
   */
  private onPageIngested(p: PageIngested) {
    const indices = new Uint32Array(p.ids.length)
    for (let i = 0; i < p.ids.length; i++) {
      const c = i * 4
      indices[i] = pushNode(this.nodes, {
        id: p.ids[i],
        page: p.pageIndex,
        x: p.coords[c],
        y: p.coords[c + 1],
        w: p.coords[c + 2],
        h: p.coords[c + 3],
        type: p.types[i] as NodeType,
        parent: p.parents[i],
        order: p.order[i],
      })
    }
    this.rememberBase(indices, p.coords)
    this.grid.addPage(p.pageIndex, p.ids, p.coords, indices)
    if (p.edges.length > 0) {
      appendEdges(this.baseEdges, p.edges)
    }
    this.orderDirty = true

    // Typed arrays straight in — no per-node object just to shield-merge them.
    const r = applyPageUpdate(p.pageIndex, p.ids, p.coords)
    this.status.pagesReceived++
    this.status.shielded += r.shielded
    this.onStatusChange?.()
    this.engine.requestDraw()
  }

  get activeTool() {
    return this.tool
  }

  setTool(name: 'select' | 'order'): void {
    this.toolName = name
    this.tool = name === 'order' ? this.orderTool : this.selectTool
    this.showOrder = name === 'order'
    this.engine.requestDraw()
  }

  get currentTool(): 'select' | 'order' {
    return this.toolName
  }

  showOrder = false

  /** Reading-order arrows, rebuilt lazily — the graph changes rarely. */
  private drawOrder(ctx: CanvasRenderingContext2D, scale: number) {
    if (!this.showOrder) return
    if (this.orderDirty) {
      const s = useStore.getState()
      this.effectiveEdges = materialize(this.baseEdges, s.edgesAdded, s.edgesRemoved, this.nodes)
      this.orderOverlay.setGraph(this.effectiveEdges)
      this.orderDirty = false
    }
    const sel = useStore.getState().selectedId
    const { indices, count } = this.engine.lastVisible
    this.orderOverlay.draw(
      ctx, this.nodes, indices, count, scale,
      sel === null ? -1 : indexOfId(this.nodes, sel),
      (id) => indexOfId(this.nodes, id),
    )
  }

  /** Tree → canvas: outline whatever the store says is hovered. */
  private drawHover(ctx: CanvasRenderingContext2D, scale: number) {
    const id = useStore.getState().hoveredId
    if (id === null || id === useStore.getState().selectedId) return
    const r = this.rectOf(id)
    if (!r) return
    ctx.save()
    ctx.lineWidth = 2 / scale
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)'
    ctx.strokeRect(r.x, r.y, r.w, r.h)
    ctx.restore()
  }

  /** Canvas → tree: hover picks are worker-side, coalesced to one per frame. */
  private trackHover(canvas: HTMLCanvasElement): () => void {
    let pending = false
    let lastX = 0
    let lastY = 0
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      lastX = e.clientX - rect.left
      lastY = e.clientY - rect.top
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        const [wx, wy] = screenToWorld(this.engine.viewport, lastX, lastY)
        void this.worker
          .hitTest(wx, wy)
          .then((id) => {
            if (this.disposed) return
            if (useStore.getState().hoveredId !== id) useStore.setState({ hoveredId: id })
          })
          .catch((err) => {
            if (!this.disposed) throw err
          })
      })
    }
    canvas.addEventListener('pointermove', onMove)
    return () => canvas.removeEventListener('pointermove', onMove)
  }

  /** Centres the viewport on a node — the tree's click target. */
  focusNode(id: number): void {
    const r = this.rectOf(id)
    if (!r) return
    const { w, h } = this.engine.size
    const vp = this.engine.viewport
    const scale = Math.min(2, Math.max(vp.scale, 0.6))
    this.engine.setViewport({
      scale,
      tx: w / 2 - (r.x + r.w / 2) * scale,
      ty: h / 2 - (r.y + r.h / 2) * scale,
    })
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

  /**
   * Records the stream geometry for a freshly ingested page, growing in step
   * with `nodes.coords` so index `i` means the same node in both.
   */
  private rememberBase(indices: Uint32Array, coords: Float32Array) {
    if (this.baseCoords.length < this.nodes.coords.length) {
      const grown = new Float32Array(this.nodes.coords.length)
      grown.set(this.baseCoords)
      this.baseCoords = grown
    }
    for (let i = 0; i < indices.length; i++) {
      const dst = indices[i] * 4
      const src = i * 4
      this.baseCoords[dst] = coords[src]
      this.baseCoords[dst + 1] = coords[src + 1]
      this.baseCoords[dst + 2] = coords[src + 2]
      this.baseCoords[dst + 3] = coords[src + 3]
    }
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
      this.orderDirty = true
      this.engine.requestDraw()
    })
  }

  /**
   * Committed edits win over the extracted geometry in the render arrays — and,
   * just as importantly, an edit that *disappears* (undo, or a redo rewound
   * past it) puts the stream geometry back. Both loops are O(human edits), and
   * both write through `writeCoords`, which is what keeps the worker's index
   * and the cull grid in step with whatever the history says is true.
   */
  private applyEdits(edits: Record<number, { rect?: Rect }>) {
    for (const key of Object.keys(edits)) {
      const id = Number(key)
      const rect = edits[id]?.rect
      if (!rect) continue
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      this.writeCoords(id, i, rect)
      this.overridden.add(id)
    }
    if (this.overridden.size === 0) return
    for (const id of this.overridden) {
      if (edits[id]?.rect) continue
      this.overridden.delete(id)
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      const c = i * 4
      this.writeCoords(id, i, {
        x: this.baseCoords[c],
        y: this.baseCoords[c + 1],
        w: this.baseCoords[c + 2],
        h: this.baseCoords[c + 3],
      })
    }
  }

  /**
   * The single writer for `nodes.coords` after ingest. The value it overwrites
   * is, by construction, the rect the worker's QuadTree was last told about, so
   * the index update is derived here rather than trusted to the call site.
   * Wiring the sync to the tool's commit instead (as this used to) left the
   * index holding the edited rect forever after an undo: clicks then missed the
   * box and hit dead space, which is the "< 2ms click-to-selection" requirement
   * failing on correctness rather than on speed.
   */
  private writeCoords(id: number, i: number, to: Rect): void {
    const c = i * 4
    const fx = this.nodes.coords[c]
    const fy = this.nodes.coords[c + 1]
    const fw = this.nodes.coords[c + 2]
    const fh = this.nodes.coords[c + 3]
    if (fx === to.x && fy === to.y && fw === to.w && fh === to.h) return
    this.nodes.coords[c] = to.x
    this.nodes.coords[c + 1] = to.y
    this.nodes.coords[c + 2] = to.w
    this.nodes.coords[c + 3] = to.h
    this.grid.move(i, this.pageOf(i), { x: fx, y: fy, w: fw, h: fh }, to)
    this.syncIndex(id, { x: fx, y: fy, w: fw, h: fh }, to)
  }

  private pageOf(i: number): number {
    return this.nodes.pages[i]
  }

  /**
   * Fire-and-forget: nothing waits on the index update, but a rejection after
   * dispose is teardown, not a failure, and must not surface as an unhandled
   * rejection on a document switch.
   */
  private syncIndex(id: number, from: Rect, to: Rect): void {
    void this.worker.updateNode(id, from, to).catch((err) => {
      if (!this.disposed) throw err
    })
  }

  dispose(): void {
    this.disposed = true
    this.stream?.stop()
    this.stream = null
    this.streamQueue.length = 0
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = 0
    this.onStatusChange = null
    for (const off of this.detachers) off()
    this.detachers.length = 0
    this.overridden.clear()
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
