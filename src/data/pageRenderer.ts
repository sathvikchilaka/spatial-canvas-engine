import { PAGE_H, PAGE_W, type Block, type GeneratedPage } from './generator'

export type PageBitmap = ImageBitmap | OffscreenCanvas
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const PAPER = '#faf8f4'
const INK = '#3a3a3a'

/** Draws a generated page's ink. Deterministic — same page, same pixels. */
export function drawPageInk(ctx: Ctx2D, page: GeneratedPage): void {
  ctx.save()
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, PAGE_W, PAGE_H)

  // Scan feel: a fraction of a degree of skew about the page centre.
  const skew = ((page.index % 5) - 2) * 0.0009
  ctx.translate(PAGE_W / 2, PAGE_H / 2)
  ctx.rotate(skew)
  ctx.translate(-PAGE_W / 2, -PAGE_H / 2)

  for (const b of page.blocks) drawBlock(ctx, b)

  ctx.restore()
  drawVignette(ctx)
}

function drawBlock(ctx: Ctx2D, b: Block) {
  ctx.globalAlpha = 0.82
  ctx.fillStyle = INK

  if (b.kind === 'figure') {
    ctx.globalAlpha = 0.16
    ctx.fillRect(b.x, b.y, b.w, b.h)
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = INK
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(b.x, b.y + b.h)
    ctx.lineTo(b.x + b.w, b.y)
    ctx.stroke()
    ctx.globalAlpha = 1
    return
  }

  if (b.kind === 'heading') {
    ctx.fillRect(b.x, b.y + b.h * 0.25, b.w, b.h * 0.5)
    ctx.globalAlpha = 1
    return
  }

  if (b.cells) {
    ctx.globalAlpha = 0.25
    ctx.strokeStyle = INK
    ctx.lineWidth = 1
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h)
    ctx.globalAlpha = 0.7
    ctx.fillStyle = INK
    for (const c of b.cells) {
      const bar = c.h * 0.5
      ctx.fillRect(c.x, c.y + (c.h - bar) / 2, c.w * 0.72, bar)
    }
    ctx.globalAlpha = 1
    return
  }

  if (b.lines) {
    for (const l of b.lines) {
      const bar = l.h * 0.62
      ctx.fillRect(l.x, l.y + (l.h - bar) / 2, l.w, bar)
    }
  }
  ctx.globalAlpha = 1
}

function drawVignette(ctx: Ctx2D) {
  const g = ctx.createLinearGradient(0, 0, PAGE_W, PAGE_H)
  g.addColorStop(0, 'rgba(0,0,0,0.03)')
  g.addColorStop(0.5, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.05)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, PAGE_W, PAGE_H)
}

/**
 * `page` is an opaque hint only `defaultRender` cares about (the synthetic
 * generator's per-page block data). A `DocumentSource`-backed renderer closes
 * over its own document and ignores it entirely.
 */
export type PageRenderFn = (index: number, page?: unknown) => PageBitmap | Promise<PageBitmap>

function defaultRender(index: number, page?: unknown): PageBitmap {
  if (!page) throw new Error(`no page data for index ${index}`)
  const canvas = new OffscreenCanvas(PAGE_W, PAGE_H)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable for page raster')
  drawPageInk(ctx, page as GeneratedPage)
  return canvas
}

function closeBitmap(bmp: PageBitmap) {
  if (typeof (bmp as ImageBitmap).close === 'function') (bmp as ImageBitmap).close()
}

/**
 * LRU cache of rendered page rasters. 100 decoded A4 pages would be ~800MB;
 * only the pages near the viewport are ever resident.
 *
 * Rendering may be async (real FUNSD PNG decodes). `ensure` never blocks: a miss
 * kicks off a load and the frame paints blank paper until it resolves. Every
 * pending load carries a generation token so a decode that resolves after its
 * page was evicted, reissued, or the cache disposed is closed rather than
 * retained — never entering the map.
 */
export class PageCache {
  private readonly cache = new Map<number, PageBitmap>()
  /** index -> token of the in-flight load for that index. */
  private readonly pending = new Map<number, number>()
  private nextToken = 0
  private disposed = false

  /** Cumulative page rasters — a pan that keeps incrementing this is thrashing. */
  rasters = 0

  private readonly maxPages: number
  private readonly render: PageRenderFn
  private readonly onReady?: () => void

  constructor(maxPages: number, render: PageRenderFn = defaultRender, onReady?: () => void) {
    this.maxPages = maxPages
    this.render = render
    this.onReady = onReady
  }

  get size(): number {
    return this.cache.size
  }

  get(index: number): PageBitmap | null {
    return this.cache.get(index) ?? null
  }

  /**
   * Starts a render if absent; marks it most-recently used either way.
   * `page` may be undefined (e.g. FUNSD pages not yet fetched) — in that case
   * this returns early without caching, rather than rendering `undefined`.
   * Non-blocking: a miss returns immediately and `get` keeps returning null
   * until the render resolves.
   */
  ensure(index: number, page?: unknown): void {
    if (this.disposed) return
    const hit = this.cache.get(index)
    if (hit !== undefined) {
      this.cache.delete(index)
      this.cache.set(index, hit)
      return
    }
    if (!page) return
    if (this.pending.has(index)) return

    const token = ++this.nextToken
    this.pending.set(index, token)
    let result: PageBitmap | Promise<PageBitmap>
    try {
      result = this.render(index, page)
    } catch (err) {
      this.fail(index, token, err)
      return
    }
    if (!(result instanceof Promise)) {
      this.settle(index, token, result)
      return
    }
    void result.then(
      (bmp) => this.settle(index, token, bmp),
      (err) => this.fail(index, token, err),
    )
  }

  /**
   * A render can fail synchronously (e.g. defaultRender's missing-context
   * branch) or via a rejected promise. Either way the pending entry for this
   * token must be cleared so a later `ensure` can retry — otherwise the
   * `pending.has` guard would block that index forever.
   */
  private fail(index: number, token: number, err: unknown) {
    if (this.pending.get(index) === token) this.pending.delete(index)
    console.warn(`page raster render failed for index ${index}`, err)
  }

  /**
   * A raster can land after its page was evicted, reissued, or the cache
   * disposed. Closing it there — rather than storing it — is the difference
   * between a flat heap and a leak across reloads.
   */
  private settle(index: number, token: number, bmp: PageBitmap) {
    const stillWanted = this.pending.get(index) === token
    if (this.disposed || !stillWanted) {
      closeBitmap(bmp)
      return
    }
    this.pending.delete(index)
    this.rasters++
    this.cache.set(index, bmp)
    while (this.cache.size > this.maxPages) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.drop(oldest.value)
    }
    this.onReady?.()
  }

  /** Drops every page outside [from, to] inclusive, pending loads included. */
  evictOutside(from: number, to: number): void {
    for (const index of Array.from(this.cache.keys())) {
      if (index < from || index > to) this.drop(index)
    }
    for (const index of Array.from(this.pending.keys())) {
      if (index < from || index > to) this.pending.delete(index)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const index of Array.from(this.cache.keys())) this.drop(index)
    this.pending.clear()
  }

  private drop(index: number) {
    const bmp = this.cache.get(index)
    // Closing is the difference between a flat heap and a leak across reloads.
    if (bmp) closeBitmap(bmp)
    this.cache.delete(index)
  }
}
