import { PageCache, type PageBitmap, type PageRenderFn } from '@/data/pageRenderer'
import type { PageGeometry } from '@/data/geometry'

const SHADOW = 'rgba(0,0,0,0.35)'
/**
 * Below this on-screen page width the ink is a grey smear anyway. Rastering it
 * would thrash a 12-page cache the moment the contact sheet shows 30 pages.
 */
const MIN_RASTER_PX = 140
const PAPER = '#faf8f4'

export class PageLayer {
  cache: PageCache
  private readonly maxResident: number
  private readonly rect = new Float32Array(4)

  constructor(maxResident = 12, render?: PageRenderFn, onReady?: () => void) {
    this.maxResident = maxResident
    this.cache = new PageCache(maxResident, render, onReady)
  }

  /**
   * Swaps the raster source without reconstructing the layer or the engine —
   * a document switch calls this once its geometry is ready. The old cache's
   * rasters are closed rather than left to a stray in-flight decode.
   */
  setRenderer(render: PageRenderFn, onReady: () => void): void {
    this.cache.dispose()
    this.cache = new PageCache(this.maxResident, render, onReady)
  }

  draw(
    ctx: CanvasRenderingContext2D,
    geometry: PageGeometry,
    from: number,
    to: number,
    /** Visible world span on x — a grid layout returns whole rows. */
    worldX = -Infinity,
    worldW = Infinity,
    scale = 1,
  ): void {
    const xMax = worldX + worldW
    for (let p = from; p <= to; p++) {
      geometry.origin(p, this.rect)
      const ox = this.rect[0]
      const oy = this.rect[1]
      const w = this.rect[2]
      const h = this.rect[3]
      // Rows are over-inclusive on x; drop the columns off either side.
      if (ox > xMax || ox + w < worldX) continue
      ctx.fillStyle = SHADOW
      ctx.fillRect(ox + 4, oy + 6, w, h)

      if (w * scale < MIN_RASTER_PX) {
        ctx.fillStyle = PAPER
        ctx.fillRect(ox, oy, w, h)
        continue
      }

      // The renderer closes over the document; the second argument only has
      // to be truthy so PageCache doesn't treat this as a "no data yet" miss.
      this.cache.ensure(p, true)
      const bmp = this.cache.get(p)
      if (bmp) {
        ctx.drawImage(bmp as CanvasImageSource, ox, oy, w, h)
      } else {
        ctx.fillStyle = PAPER
        ctx.fillRect(ox, oy, w, h)
      }
    }
    // One page of slack either side so scrolling never shows blank paper.
    this.cache.evictOutside(from - 1, to + 1)
  }

  dispose(): void {
    this.cache.dispose()
  }
}

export type { PageBitmap }
