import { createNodeArrays, FLAG_DIRTY, FLAG_HIDDEN, FLAG_SELECTED, indexOfId, NodeType, pushNode, type NodeArrays, type Rect } from '@/data/nodes'
import type { DocumentSource } from '@/data/document'
import type { PageGeometry } from '@/data/geometry'
import { BucketGrid } from '@/engine/bucketGrid'
import { CanvasEngine } from '@/engine/engine'
import { attachInput } from '@/engine/input'
import { screenToWorld } from '@/engine/viewport'
import { commit, redo, setUiState, undo, useStore, type AppState, type Edit } from '@/store/store'
import { toolHandlers } from '@/tools/adapter'
import { OrderTool } from '@/tools/orderTool'
import { SelectTool } from '@/tools/selectTool'
import { TableTool, type TableSnapshot } from '@/tools/tableTool'
import { OrderOverlay } from '@/engine/layers/overlays'
import { appendEdges, createEdgeSet, hasEdge, materialize, type EdgeSet } from '@/data/edges'
import type { Tool } from '@/tools/types'
import { applyPageUpdate } from '@/store/merge'
import type { StreamEvent, StreamSource } from '@/stream/source'
import { SseStreamSource } from '@/stream/sseSource'
import { WorkerClient } from '@/worker/client'
import { SemanticLabel, type PageIngested } from '@/worker/protocol'
import { labelFromName, labelName, TYPE_OF_LABEL } from '@/data/labels'

const WORLD: Rect = { x: -2000, y: -2000, w: 20000, h: 400000 }

/** The tools the UI can select. Mirrors `ToolName` in the toolbar. */
export type ToolKind = 'select' | 'order' | 'table'

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
  private readonly tableTool: TableTool
  private readonly orderOverlay = new OrderOverlay()
  private tool: Tool
  private toolName: ToolKind = 'select'
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
  /** Node ids whose `nodes.types` currently hold a relabel edit, not the base type. */
  private readonly labelOverridden = new Set<number>()
  /**
   * Text and labels live in maps, not in the typed arrays: text is
   * variable-length and non-numeric, and both are read by React chrome on
   * selection rather than by the draw loop on every frame.
   */
  private readonly texts = new Map<number, string>()
  private readonly baseLabels = new Map<number, SemanticLabel>()
  /** Node ids' `nodes.types` value as it was the first time a relabel overrode it. */
  private readonly baseTypes = new Map<number, NodeType>()
  /** Ids the reviewer created. Far above any streamed id (`page * 1000 + n`). */
  private nextLocalId = 1_000_000_000
  /** Created nodes already pushed into `nodes` — pushes are irreversible, so this is the mirror. */
  private readonly created = new Set<number>()
  /** Nodes currently hidden by a `deleted` edit, so undo can unhide exactly those. */
  private readonly hidden = new Set<number>()
  /**
   * Page indices already ingested this session. A reconnect (`SseStreamSource`
   * backs off and retries) restarts the feed from page 0 with no resume
   * support server-side, so every page arrives again; skipping an index
   * already in this set is what keeps a reconnect from duplicating every
   * unedited node into `nodes`/`grid`.
   */
  private readonly ingestedPages = new Set<number>()
  private stream: StreamSource | null = null
  /** Set by `dispose()`. Guards every continuation that resumes after an await. */
  private disposed = false
  private streamQueue: StreamEvent[] = []
  private drainTimer = 0
  /** Reported to the UI: pages seen, and edits the shield preserved. */
  status = {
    pagesReceived: 0,
    shielded: 0,
    connected: false,
    done: false,
    transport: 'replay' as 'sse' | 'replay',
    failed: 0,
  }
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
      arrows: () => ({
        list: this.orderOverlay.arrows,
        count: this.orderOverlay.arrowCount,
      }),
    })
    this.tableTool = new TableTool({
      tableAt: (id) => this.tableAt(id),
      pick: (x, y) => this.worker.hitTest(x, y),
      requestDraw: () => this.engine.requestDraw(),
      allocId: () => this.allocId(),
      nodeMeta: (id) => {
        const i = indexOfId(this.nodes, id)
        if (i < 0) return null
        return { page: this.nodes.pages[i], parent: this.nodes.parents[i], order: this.nodes.order[i] }
      },
    })
    this.tool = this.selectTool

    this.detachers.push(this.worker.onPageIngested((p) => this.onPageIngested(p)))
    this.detachers.push(
      this.worker.onError((err) => {
        // ingestUrl is fire-and-forget (UNSOLICITED) — this is the only signal
        // a failed fetch/parse for that path ever produces.
        if (this.disposed) return
        console.warn('worker ingest failed', err)
        this.status.failed++
        this.onStatusChange?.()
      }),
    )
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
   * Ids for reviewer-created nodes. Streamed ids are `page * ID_STRIDE + n`, so
   * this base is unreachable from ingest and a created cell can never collide
   * with a node that arrives later on the stream.
   */
  allocId(): number {
    return this.nextLocalId++
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
    const source = await Promise.resolve(
      this.doc.createStream((connected) => {
        // Live disconnect/reconnect after the initial connect — SseStreamSource
        // backs off and retries on error, so this can fire repeatedly.
        if (this.disposed) return
        this.status.connected = connected
        this.onStatusChange?.()
      }),
    )
    if (this.disposed) return
    this.stream = source
    this.status.transport = source instanceof SseStreamSource ? 'sse' : 'replay'
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
        // The worker fetches/parses the url, or ingests the pushed payload
        // string, and reports back via onPageIngested — the main thread
        // never touches the raw JSON either way.
        this.geometry.origin(e.pageIndex, this.pageRect)
        if (e.payload !== undefined) {
          // A pushed body: hand the worker the string. Parsing it here would
          // put a 40KB JSON.parse on the frame thread, per page.
          void this.worker
            .ingestJson(e.pageIndex, e.payload, this.pageRect[0], this.pageRect[1])
            .catch((err) => {
              if (this.disposed) return
              console.warn('page ingest failed', e.pageIndex, err)
              this.status.failed++
              this.onStatusChange?.()
            })
        } else {
          this.worker.ingestUrl(e.pageIndex, e.url, this.pageRect[0], this.pageRect[1])
        }
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
    // Reconnect replays the whole feed from page 0 with no resume support —
    // skip a page already ingested rather than re-pushing every node into
    // `nodes`/`grid` as a ghost duplicate.
    if (this.ingestedPages.has(p.pageIndex)) return
    this.ingestedPages.add(p.pageIndex)
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
    for (let i = 0; i < p.ids.length; i++) {
      const id = p.ids[i]
      if (p.texts[i]) this.texts.set(id, p.texts[i])
      if (p.labels[i]) this.baseLabels.set(id, p.labels[i] as SemanticLabel)
    }
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

  setTool(name: ToolKind): void {
    // Safety net for `OrderTool`: its gesture is normally cleared by `onUp`
    // (the adapter now reads `capturing` fresh at up-time), but a pointer
    // released outside the canvas never reaches it, so switching away must
    // not leave a stale `dragFrom` chasing the cursor in a tool nobody sees.
    if (this.toolName === 'order' && name !== 'order') this.orderTool.reset()
    this.toolName = name
    this.tool =
      name === 'order' ? this.orderTool : name === 'table' ? this.tableTool : this.selectTool
    this.showOrder = name === 'order'
    if (name === 'table') {
      const sel = useStore.getState().selectedId
      // Adopt whatever is already selected, so switching tools with a cell
      // selected shows its mesh immediately instead of demanding a second click.
      if (sel !== null) void this.tableTool.adopt(sel)
    }
    this.engine.requestDraw()
  }

  get currentTool(): ToolKind {
    return this.toolName
  }

  /**
   * The table containing `nodeId`: either the node is a `Cell` (its parent is
   * the table block) or it is the block itself. Tables are not a node type —
   * they are a parent whose children are cells — so detection is a parent/child
   * scan, not a flag lookup. O(document), but it only runs on tool adoption and
   * on a store change that actually moved geometry (a commit, an undo/redo) —
   * never per frame, and never on a hover or selection write. Index children by
   * parent id at ingest only if a profile shows FUNSD's 41k nodes making it
   * matter.
   */
  tableAt(nodeId: number): TableSnapshot | null {
    const i = indexOfId(this.nodes, nodeId)
    if (i < 0) return null
    const tableId = this.nodes.types[i] === NodeType.Cell ? this.nodes.parents[i] : nodeId
    if (tableId < 0) return null

    const cells: TableSnapshot['cells'] = []
    for (let j = 0; j < this.nodes.count; j++) {
      if (this.nodes.parents[j] !== tableId || this.nodes.types[j] !== NodeType.Cell) continue
      // A merged-away cell still owns its row (indices are stable); rebuilding
      // the mesh from it would resurrect the cell the reviewer just merged.
      if (this.nodes.flags[j] & FLAG_HIDDEN) continue
      const c = j * 4
      cells.push({
        id: this.nodes.ids[j],
        x: this.nodes.coords[c],
        y: this.nodes.coords[c + 1],
        w: this.nodes.coords[c + 2],
        h: this.nodes.coords[c + 3],
      })
    }
    return cells.length === 0 ? null : { tableId, cells }
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
            if (useStore.getState().hoveredId !== id) setUiState({ hoveredId: id })
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

  textOf(id: number): string {
    return this.texts.get(id) ?? ''
  }

  baseLabelOf(id: number): SemanticLabel {
    return this.baseLabels.get(id) ?? SemanticLabel.None
  }

  /** The label the UI shows: the human's if they set one, else the extraction's. */
  labelOf(id: number): SemanticLabel {
    const override = useStore.getState().edits[id]?.label
    return override === undefined ? this.baseLabelOf(id) : labelFromName(override)
  }

  setLabel(id: number, label: SemanticLabel): void {
    const name = labelName(label)
    if (name === labelName(this.labelOf(id))) return
    commit('relabel', (d) => {
      d.edits[id] = { ...d.edits[id], label: name }
      d.dirtyAt[id] = Date.now()
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
    let prevEdits: AppState['edits'] | null = null
    let prevEdgesAdded: AppState['edgesAdded'] | null = null
    let prevEdgesRemoved: AppState['edgesRemoved'] | null = null
    return useStore.subscribe((state) => {
      if (prevSelected >= 0) this.nodes.flags[prevSelected] &= ~FLAG_SELECTED
      const i = state.selectedId === null ? -1 : indexOfId(this.nodes, state.selectedId)
      if (i >= 0) this.nodes.flags[i] |= FLAG_SELECTED
      prevSelected = i
      // Structural edits first: a created node must exist in `nodes` before
      // `applyEdits` can position it, or be flagged dirty.
      this.materializeStructural(state.edits)
      for (const key of Object.keys(state.dirtyAt)) {
        const di = indexOfId(this.nodes, Number(key))
        if (di >= 0) this.nodes.flags[di] |= FLAG_DIRTY
      }
      this.applyEdits(state.edits)
      // Undo/redo rewrites cell geometry underneath the mesh; rebuild it from
      // the render arrays so the drawn dividers cannot lie about the boxes.
      // `adopt` only reads `this.nodes` and requests a draw, so it cannot loop
      // back through the store.
      //
      // Only when the geometry actually moved: `state.edits` keeps its identity
      // across a hover or selection write (Immer only replaces what a recipe
      // touches), and `tableAt` is O(document) plus a `buildMesh`, which must
      // not run at pointer-move rate. And never mid-gesture — `adopt` refuses
      // that itself, this is just the cheaper path to the same answer.
      const editsChanged = state.edits !== prevEdits
      const tableActive = this.toolName === 'table' && this.tableTool.tableId !== null
      if (editsChanged && tableActive && this.tableTool.capturing) {
        // Refused: do NOT advance `prevEdits`. A geometry-moving change that
        // arrives mid-drag (e.g. a keyboard undo while the pointer is held)
        // would otherwise consume its own change signal here and then be
        // skipped by `adopt`'s own `capturing` guard too. The gesture's
        // `commit()` normally re-adopts right after and this catches up on
        // its own — but `onPointerUp` returns early when it commits nothing
        // (press-and-release on a divider, or a drag back to the start), so
        // leaving the signal pending lets the *next* store change (whatever
        // it is) still see the diff and trigger the catch-up adopt, instead
        // of the mesh being left drawing dividers that no longer match the
        // arrays `applyEdits` just rewrote underneath it.
      } else {
        prevEdits = state.edits
        if (editsChanged && tableActive) void this.tableTool.adopt(this.tableTool.tableId)
      }
      // `sequenceNumbers` is a DFS walk — it must run on a real graph change
      // only, not on every store write. `edgesAdded`/`edgesRemoved` are always
      // replaced via spread in commit recipes (never mutated in place), so
      // identity comparison catches every real change and nothing else, same
      // pattern as `editsChanged` above.
      if (state.edgesAdded !== prevEdgesAdded || state.edgesRemoved !== prevEdgesRemoved) {
        prevEdgesAdded = state.edgesAdded
        prevEdgesRemoved = state.edgesRemoved
        this.orderDirty = true
      }
      this.engine.requestDraw()
    })
  }

  /**
   * Applies the two structural edit kinds. Node rows only ever grow — indices
   * are referenced by the cull grid, the worker's `indexById` and the tree — so
   * "undo a creation" means hide it and drop it from the hit-test index, not
   * splice it out. That keeps every index stable across arbitrarily deep
   * undo/redo, which is the property the memory-footprint and
   * no-corrupted-state criteria actually rest on.
   */
  private materializeStructural(edits: Record<number, Edit>): void {
    for (const key of Object.keys(edits)) {
      const id = Number(key)
      const e = edits[id]
      if (!e?.created) continue
      let i = indexOfId(this.nodes, id)
      if (i < 0) {
        const r = e.rect ?? { x: 0, y: 0, w: 0, h: 0 }
        i = pushNode(this.nodes, {
          id,
          page: e.created.page,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          type: e.created.type,
          parent: e.created.parent,
          order: e.created.order,
        })
        const c = i * 4
        this.rememberBase(Uint32Array.of(i), this.nodes.coords.slice(c, c + 4))
        this.grid.insert(i, e.created.page, r.x, r.y, r.w, r.h)
        this.insertIndex(id, i)
      } else if (this.created.has(id) && !e.deleted) {
        // Redo of a creation: unhide and re-index the row we kept. A cell that
        // is *also* `deleted` (split off, then merged away again) must stay
        // hidden — unhiding it here would put a merged-away cell back into the
        // draw loop and both indexes on the next unrelated store change.
        this.showNode(id, i)
      }
      this.created.add(id)
    }

    // A created node whose edit is gone (undo) is hidden and de-indexed.
    for (const id of this.created) {
      if (edits[id]?.created) continue
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      if (this.nodes.flags[i] & FLAG_HIDDEN) continue
      this.hideNode(id, i)
    }

    for (const key of Object.keys(edits)) {
      const id = Number(key)
      if (!edits[id]?.deleted) continue
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      // Reconcile against the flag rather than the mirror: `hideNode` is
      // idempotent, so re-asserting every tick is cheap and cannot drift.
      this.hideNode(id, i)
      this.hidden.add(id)
    }
    for (const id of this.hidden) {
      if (edits[id]?.deleted) continue
      this.hidden.delete(id)
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      this.showNode(id, i)
    }
  }

  /**
   * Hides a node and drops it from both spatial indexes, so it stops being
   * hittable. Idempotent: the flag is the single truth, so a second call adds
   * no second `grid.remove`/`removeNode` — and neither does a call for a node
   * two reconciliation loops both believe they own.
   */
  private hideNode(id: number, i: number): void {
    if (this.nodes.flags[i] & FLAG_HIDDEN) return
    const c = i * 4
    const r = {
      x: this.nodes.coords[c],
      y: this.nodes.coords[c + 1],
      w: this.nodes.coords[c + 2],
      h: this.nodes.coords[c + 3],
    }
    this.nodes.flags[i] |= FLAG_HIDDEN
    this.grid.remove(i, r.x, r.y, r.w, r.h)
    void this.worker.removeNode(id, r).catch((err) => {
      if (!this.disposed) throw err
    })
  }

  /**
   * The exact inverse of `hideNode`: back into the draw loop and both indexes.
   * Idempotent for the same reason — a double insert would leave a duplicate
   * QuadTree entry that a single later `removeNode` cannot clear.
   */
  private showNode(id: number, i: number): void {
    if (!(this.nodes.flags[i] & FLAG_HIDDEN)) return
    const c = i * 4
    this.nodes.flags[i] &= ~FLAG_HIDDEN
    this.grid.insert(
      i,
      this.nodes.pages[i],
      this.nodes.coords[c],
      this.nodes.coords[c + 1],
      this.nodes.coords[c + 2],
      this.nodes.coords[c + 3],
    )
    this.insertIndex(id, i)
  }

  /**
   * Fire-and-forget, same contract as `syncIndex`: nothing waits on the
   * QuadTree insert, but a rejection after dispose is teardown, not a failure.
   */
  private insertIndex(id: number, i: number): void {
    const c = i * 4
    void this.worker
      .insertNode({
        id,
        page: this.nodes.pages[i],
        x: this.nodes.coords[c],
        y: this.nodes.coords[c + 1],
        w: this.nodes.coords[c + 2],
        h: this.nodes.coords[c + 3],
        type: this.nodes.types[i],
        parent: this.nodes.parents[i],
        order: this.nodes.order[i],
      })
      .catch((err) => {
        if (!this.disposed) throw err
      })
  }

  /**
   * Committed edits win over the extracted geometry in the render arrays — and,
   * just as importantly, an edit that *disappears* (undo, or a redo rewound
   * past it) puts the stream geometry back. Both loops are O(human edits), and
   * both write through `writeCoords`, which is what keeps the worker's index
   * and the cull grid in step with whatever the history says is true.
   */
  private applyEdits(edits: Record<number, Edit>) {
    for (const key of Object.keys(edits)) {
      const id = Number(key)
      const edit = edits[id]
      const rect = edit?.rect
      if (rect) {
        const i = indexOfId(this.nodes, id)
        if (i >= 0) {
          this.writeCoords(id, i, rect)
          this.overridden.add(id)
        }
      }

      // A label edit repaints the box, so it has to reach `nodes.types`.
      if (edit?.label !== undefined) {
        const i = indexOfId(this.nodes, id)
        if (i >= 0) {
          const wantType = TYPE_OF_LABEL[labelFromName(edit.label)]
          if (this.nodes.types[i] !== wantType) {
            if (!this.baseTypes.has(id))
              this.baseTypes.set(id, this.nodes.types[i] as NodeType)
            this.nodes.types[i] = wantType
          }
          this.labelOverridden.add(id)
        }
      }
    }
    if (this.labelOverridden.size > 0) {
      for (const id of this.labelOverridden) {
        if (edits[id]?.label !== undefined) continue
        this.labelOverridden.delete(id)
        const i = indexOfId(this.nodes, id)
        if (i < 0) continue
        const baseType = this.baseTypes.get(id)
        if (baseType !== undefined && this.nodes.types[i] !== baseType) {
          this.nodes.types[i] = baseType
        }
      }
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
    // A hidden node is out of both indexes on purpose; a `move`/`update` here
    // would re-insert it and make a merged-away cell hittable again. `showNode`
    // re-indexes it from these coords if it ever comes back.
    if (this.nodes.flags[i] & FLAG_HIDDEN) return
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
    this.labelOverridden.clear()
    this.texts.clear()
    this.baseLabels.clear()
    this.baseTypes.clear()
    this.created.clear()
    this.hidden.clear()
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
