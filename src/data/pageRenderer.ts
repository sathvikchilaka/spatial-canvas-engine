import { PAGE_H, PAGE_W, type Block, type GeneratedPage } from './generator'

export type PageBitmap = ImageBitmap | OffscreenCanvas
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
export type PageRenderFn = (page: GeneratedPage) => PageBitmap

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

function defaultRender(page: GeneratedPage): PageBitmap {
  const canvas = new OffscreenCanvas(PAGE_W, PAGE_H)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable for page raster')
  drawPageInk(ctx, page)
  return canvas
}

/**
 * LRU cache of rendered page rasters. 100 decoded A4 pages would be ~800MB;
 * only the pages near the viewport are ever resident.
 */
export class PageCache {
  private readonly cache = new Map<number, PageBitmap>()

  private readonly maxPages: number
  private readonly render: PageRenderFn

  constructor(maxPages: number, render: PageRenderFn = defaultRender) {
    this.maxPages = maxPages
    this.render = render
  }

  get size(): number {
    return this.cache.size
  }

  get(page: GeneratedPage): PageBitmap | null {
    return this.cache.get(page.index) ?? null
  }

  /** Renders the page if absent; marks it most-recently used either way. */
  ensure(page: GeneratedPage): void {
    const hit = this.cache.get(page.index)
    if (hit !== undefined) {
      this.cache.delete(page.index)
      this.cache.set(page.index, hit)
      return
    }
    this.cache.set(page.index, this.render(page))
    while (this.cache.size > this.maxPages) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.drop(oldest.value)
    }
  }

  /** Drops every page outside [from, to] inclusive. */
  evictOutside(from: number, to: number): void {
    for (const index of Array.from(this.cache.keys())) {
      if (index < from || index > to) this.drop(index)
    }
  }

  dispose(): void {
    for (const index of Array.from(this.cache.keys())) this.drop(index)
  }

  private drop(index: number) {
    const bmp = this.cache.get(index)
    // Closing is the difference between a flat heap and a leak across reloads.
    if (bmp && typeof (bmp as ImageBitmap).close === 'function') (bmp as ImageBitmap).close()
    this.cache.delete(index)
  }
}
