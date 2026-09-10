import { generateDocument, PAGE_GAP, PAGE_H, PAGE_W, PAGES_PER_ROW } from '@/data/generator'
import { gridGeometry } from '@/data/geometry'
import { drawPageInk, type PageBitmap } from '@/data/pageRenderer'
import { MockStreamSource } from '@/stream/mockSource'
import type { DocumentSource } from '@/data/document'

export function createSyntheticDocument(pageCount: number, seed: number): DocumentSource {
  const doc = generateDocument(pageCount, seed)
  return {
    id: 'synthetic',
    pageCount,
    async geometry() {
      // Contact sheet, not a tall column: a single column caps a 10% viewport
      // at ~6 pages, which can never exercise the 10k-boxes-in-view bar. The
      // worker derives every node's world position from these rects.
      return gridGeometry(pageCount, PAGE_W, PAGE_H, PAGE_GAP, PAGES_PER_ROW)
    },
    async raster(page) {
      const canvas = new OffscreenCanvas(PAGE_W, PAGE_H)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2d context unavailable for page raster')
      drawPageInk(ctx, doc.pages[page])
      return canvas as PageBitmap
    },
    createStream() {
      // No live transport: synthetic pages are generated inside the worker from
      // a `synthetic://` URL, so there is nothing for a feed to push. The SSE
      // endpoint serves FUNSD.
      return new MockStreamSource(pageCount, seed)
    },
  }
}
