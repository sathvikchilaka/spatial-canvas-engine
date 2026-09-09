import type { GeneratedPage } from '@/data/generator'
import type { NodeArrays } from '@/data/nodes'
import { BucketGrid } from './bucketGrid'
import { crispOffset, sizeCanvas } from './canvas'
import { BoxLayer } from './layers/boxes'
import { PageLayer, visiblePageRange } from './layers/pages'
import { visibleWorldRect, type Viewport } from './viewport'

const MAX_VISIBLE = 8192

export type FrameHook = (ms: number) => void
/** Extra painting on top of the box layer — tools draw their HUD here. */
export type Overlay = (ctx: CanvasRenderingContext2D, vp: Viewport) => void

/**
 * Owns the canvas, the transform, and the frame loop. Framework-agnostic:
 * React only constructs and disposes it. No React state on this path.
 */
export class CanvasEngine {
  private ctx: CanvasRenderingContext2D
  private vp: Viewport = { scale: 0.35, tx: 40, ty: 20 }
  private nodes: NodeArrays | null = null
  private pages: GeneratedPage[] = []
  private grid: BucketGrid = new BucketGrid()
  private readonly boxes = new BoxLayer(MAX_VISIBLE)
  private readonly pageLayer = new PageLayer()
  /** preallocated cull result — never reallocated per frame */
  private readonly visible = new Uint32Array(MAX_VISIBLE)
  private visibleCount = 0
  private overlays: Overlay[] = []
  private frameHooks = new Set<FrameHook>()

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

  get viewport(): Viewport {
    return this.vp
  }

  setViewport(vp: Viewport): void {
    this.vp = vp
    this.requestDraw()
  }

  get size(): { w: number; h: number } {
    return { w: this.cssW, h: this.cssH }
  }

  setData(nodes: NodeArrays, pages: GeneratedPage[], grid: BucketGrid): void {
    this.nodes = nodes
    this.pages = pages
    this.grid = grid
    this.requestDraw()
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

  /** Marks the frame dirty. Input handlers call this and never draw directly. */
  requestDraw(): void {
    this.dirty = true
  }

  start(): void {
    if (this.raf) return
    const tick = () => {
      this.raf = requestAnimationFrame(tick)
      if (!this.dirty || this.disposed) return
      this.dirty = false
      const t0 = performance.now()
      this.draw()
      const ms = performance.now() - t0
      for (const cb of this.frameHooks) cb(ms)
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
    this.pageLayer.dispose()
    this.nodes = null
    this.pages = []
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

    if (this.pages.length) {
      const [from, to] = visiblePageRange(world.y, world.h, this.pages.length)
      this.pageLayer.draw(ctx, this.pages, from, to)
    }

    if (nodes) {
      this.visibleCount = this.grid.query(world.x, world.y, world.w, world.h, this.visible)
      this.boxes.draw(ctx, nodes, this.visible, this.visibleCount, vp.scale)
    }

    for (const o of this.overlays) o(ctx, vp)
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
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(this.canvas.parentElement ?? this.canvas)
    this.watchDpr()
    this.resize()
  }

  private resize() {
    const host = this.canvas.parentElement ?? this.canvas
    const rect = host.getBoundingClientRect()
    this.cssW = Math.max(1, rect.width)
    this.cssH = Math.max(1, rect.height)
    this.dpr = window.devicePixelRatio || 1
    sizeCanvas(this.canvas, this.cssW, this.cssH, this.dpr)
    this.requestDraw()
  }
}
