import { PAGE_GAP, PAGE_H, PAGE_W, PAGES_PER_ROW } from '@/data/generator'
import { geometryBounds, gridGeometry, type PageGeometry } from '@/data/geometry'
import type { NodeArrays } from '@/data/nodes'
import type { PageRenderFn } from '@/data/pageRenderer'
import { BucketGrid } from './bucketGrid'
import { crispOffset, sizeCanvas } from './canvas'
import { BoxLayer } from './layers/boxes'
import { PageLayer } from './layers/pages'
import { clampPan, visibleWorldRect, type Viewport } from './viewport'

/**
 * Cull-result capacity. The cull truncates at this cap, so it must exceed the
 * most boxes a viewport can ever hold — with the contact-sheet layout, zooming
 * to 10% puts the whole document in view. 32k indices is 128 KB, plus one
 * same-sized style bucket per group; cheaper than silently dropping boxes.
 */
const MAX_VISIBLE = 32768

export type FrameHook = (ms: number) => void
/**
 * Called once per animation frame whether or not we drew. `drew` separates
 * "the display is keeping up" from "we had something to repaint" — the
 * dirty-flag loop means a frame counter alone measures input rate, not speed.
 */
export type TickHook = (drew: boolean, ms: number) => void
/** Extra painting on top of the box layer — tools draw their HUD here. */
export type Overlay = (ctx: CanvasRenderingContext2D, vp: Viewport) => void

/** Per-frame cost breakdown, overwritten in place — no per-frame allocation. */
export type FramePerf = {
  total: number
  pages: number
  cull: number
  boxes: number
  overlays: number
  visible: number
  /** True when the cull hit MAX_VISIBLE and dropped boxes that were in view. */
  culledOut: boolean
}

/**
 * Owns the canvas, the transform, and the frame loop. Framework-agnostic:
 * React only constructs and disposes it. No React state on this path.
 */
export class CanvasEngine {
  private ctx: CanvasRenderingContext2D
  private vp: Viewport = { scale: 1, tx: 0, ty: 0 }
  private nodes: NodeArrays | null = null
  private geometry: PageGeometry = gridGeometry(0, PAGE_W, PAGE_H, PAGE_GAP, PAGES_PER_ROW)
  private bounds = { maxX: 0, maxY: 0 }
  private grid: BucketGrid = new BucketGrid()
  private readonly boxes = new BoxLayer(MAX_VISIBLE)
  /** Public so a document switch can swap the raster source without rebuilding the engine. */
  readonly pageLayer = new PageLayer()
  /** Exposed for the perf bench: page raster count lives on the cache. */
  get pageCache() {
    return this.pageLayer.cache
  }
  /** Swaps the page raster source in place — used when the document changes. */
  setPageRenderer(render: PageRenderFn, onReady: () => void): void {
    this.pageLayer.setRenderer(render, onReady)
  }
  /** preallocated cull result — never reallocated per frame */
  private readonly visible = new Uint32Array(MAX_VISIBLE)
  private visibleCount = 0
  /**
   * Bench escape hatch: skip the cull and submit every node, measuring the draw
   * path's worst case directly rather than inferring it from whatever the
   * viewport happened to hold.
   */
  cullDisabled = false
  private overlays: Overlay[] = []
  private frameHooks = new Set<FrameHook>()
  private tickHooks = new Set<TickHook>()
  readonly perf: FramePerf = {
    total: 0,
    pages: 0,
    cull: 0,
    boxes: 0,
    overlays: 0,
    visible: 0,
    culledOut: false,
  }

  private raf = 0
  private dirty = true
  private disposed = false
  private dpr = 1
  private cssW = 0
  private cssH = 0
  private ro: ResizeObserver | null = null
  private dprQuery: MediaQueryList | null = null

  private readonly canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.observeSize()
  }

  /** The backing canvas — the bench dispatches synthetic pointer events at it. */
  get canvasEl(): HTMLCanvasElement {
    return this.canvas
  }

  get viewport(): Viewport {
    return this.vp
  }

  setViewport(vp: Viewport): void {
    this.vp = clampPan(vp, this.bounds, this.cssW, this.cssH)
    this.requestDraw()
  }

  get size(): { w: number; h: number } {
    return { w: this.cssW, h: this.cssH }
  }

  setData(nodes: NodeArrays, grid: BucketGrid, geometry: PageGeometry): void {
    this.nodes = nodes
    this.geometry = geometry
    this.bounds = geometryBounds(geometry)
    this.grid = grid
    this.setViewport(this.vp)
  }

  addOverlay(o: Overlay): () => void {
    this.overlays.push(o)
    return () => {
      this.overlays = this.overlays.filter((x) => x !== o)
    }
  }

  onFrame(cb: FrameHook): () => void {
    this.frameHooks.add(cb)
    return () => this.frameHooks.delete(cb)
  }

  onTick(cb: TickHook): () => void {
    this.tickHooks.add(cb)
    return () => this.tickHooks.delete(cb)
  }

  /** Marks the frame dirty. Input handlers call this and never draw directly. */
  requestDraw(): void {
    this.dirty = true
  }

  start(): void {
    if (this.raf) return
    const tick = () => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(tick)
      if (!this.dirty) {
        for (const cb of this.tickHooks) cb(false, 0)
        return
      }
      this.dirty = false
      const t0 = performance.now()
      this.draw()
      const ms = performance.now() - t0
      this.perf.total = ms
      for (const cb of this.frameHooks) cb(ms)
      for (const cb of this.tickHooks) cb(true, ms)
    }
    this.raf = requestAnimationFrame(tick)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.ro?.disconnect()
    this.ro = null
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.dprQuery = null
    this.overlays = []
    this.frameHooks.clear()
    this.tickHooks.clear()
    this.pageLayer.dispose()
    this.nodes = null
  }

  /** Culled node indices from the last frame — tools reuse them for picking. */
  get lastVisible(): { indices: Uint32Array; count: number } {
    return { indices: this.visible, count: this.visibleCount }
  }

  private draw() {
    const { ctx, vp } = this
    const nodes = this.nodes
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.fillStyle = '#111111'
    ctx.fillRect(0, 0, this.cssW, this.cssH)

    const world = visibleWorldRect(vp, this.cssW, this.cssH)

    ctx.save()
    ctx.translate(vp.tx + crispOffset(this.dpr), vp.ty + crispOffset(this.dpr))
    ctx.scale(vp.scale, vp.scale)

    const perf = this.perf
    let t = performance.now()
    if (this.geometry.count) {
      const [from, to] = this.geometry.rangeFor(world.y, world.h)
      this.pageLayer.draw(ctx, this.geometry, from, to, world.x, world.w, vp.scale)
    }
    const tPages = performance.now()
    perf.pages = tPages - t
    t = tPages

    if (nodes) {
      if (this.cullDisabled) {
        const n = Math.min(nodes.count, this.visible.length)
        for (let i = 0; i < n; i++) this.visible[i] = i
        this.visibleCount = n
      } else {
        this.visibleCount = this.grid.query(world.x, world.y, world.w, world.h, this.visible)
      }
      const tCull = performance.now()
      perf.cull = tCull - t
      t = tCull
      this.boxes.draw(ctx, nodes, this.visible, this.visibleCount, vp.scale)
      perf.boxes = performance.now() - t
    } else {
      perf.cull = 0
      perf.boxes = 0
    }
    perf.visible = this.visibleCount
    perf.culledOut = this.visibleCount >= this.visible.length

    t = performance.now()
    for (const o of this.overlays) o(ctx, vp)
    perf.overlays = performance.now() - t
    ctx.restore()
  }

  private onDprChange = () => {
    this.resize()
    this.watchDpr()
  }

  private watchDpr() {
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this.dprQuery.addEventListener('change', this.onDprChange)
  }

  private observeSize() {
    this.ro = new ResizeObserver((entries) => {
      // The entry already carries the measured box. Calling
      // `getBoundingClientRect` here instead would force a synchronous layout
      // flush inside the callback — the reflow the DevTools "Forced reflow"
      // insight flags, and the single largest main-thread stall in the app.
      const box = entries[entries.length - 1]?.borderBoxSize?.[0]
      if (box) this.resize(box.inlineSize, box.blockSize)
      else this.resize() // Older Safari: no borderBoxSize, fall back to measuring.
    })
    this.ro.observe(this.canvas.parentElement ?? this.canvas)
    this.watchDpr()
    this.resize()
  }

  /**
   * `w`/`h` come from the ResizeObserver entry when there is one; measuring is
   * only for the paths that have no entry to read (first call, dpr change).
   */
  private resize(w?: number, h?: number) {
    if (w === undefined || h === undefined) {
      const host = this.canvas.parentElement ?? this.canvas
      const rect = host.getBoundingClientRect()
      w = rect.width
      h = rect.height
    }
    const cssW = Math.max(1, w)
    const cssH = Math.max(1, h)
    const dpr = window.devicePixelRatio || 1
    // A ResizeObserver fires for changes that leave the box identical (a
    // reflow elsewhere, a style write of the same value). Bailing here keeps
    // those from clearing the canvas and re-clamping the viewport.
    if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr) return
    this.cssW = cssW
    this.cssH = cssH
    this.dpr = dpr
    sizeCanvas(this.canvas, cssW, cssH, dpr)
    this.setViewport(this.vp)
  }
}
