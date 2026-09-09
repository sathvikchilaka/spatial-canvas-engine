import { PAGE_GAP, PAGE_H, PAGE_W, pageOrigin, type GeneratedPage } from '@/data/generator'
import { PageCache } from '@/data/pageRenderer'

/** Inclusive page index range intersecting a world-space y span. */
export function visiblePageRange(
  y: number,
  h: number,
  pageCount: number,
): [number, number] {
  const stride = PAGE_H + PAGE_GAP
  const from = Math.max(0, Math.floor(y / stride))
  const to = Math.min(pageCount - 1, Math.floor((y + h) / stride))
  return [from, to]
}

export class PageLayer {
  readonly cache: PageCache

  constructor(maxResident = 12) {
    this.cache = new PageCache(maxResident)
  }

  draw(
    ctx: CanvasRenderingContext2D,
    pages: GeneratedPage[],
    from: number,
    to: number,
  ): void {
    for (let p = from; p <= to; p++) {
      const page = pages[p]
      if (!page) continue
      const [ox, oy] = pageOrigin(p)
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(ox + 4, oy + 6, PAGE_W, PAGE_H)
      this.cache.ensure(page)
      const bmp = this.cache.get(page)
      if (bmp) {
        ctx.drawImage(bmp as CanvasImageSource, ox, oy, PAGE_W, PAGE_H)
      } else {
        ctx.fillStyle = '#faf8f4'
        ctx.fillRect(ox, oy, PAGE_W, PAGE_H)
      }
    }
    // Keep one page of slack either side so scrolling never shows blank paper.
    this.cache.evictOutside(from - 1, to + 1)
  }

  dispose(): void {
    this.cache.dispose()
  }
}
