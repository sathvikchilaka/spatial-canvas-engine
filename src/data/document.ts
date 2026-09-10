import type { PageGeometry } from './geometry'
import type { PageBitmap } from './pageRenderer'
import type { StreamSource } from '@/stream/source'

/**
 * One seam for every kind of document. The engine, the worker and the session
 * know only this — not whether the pages are real scans or generated ink.
 */
export interface DocumentSource {
  readonly id: 'funsd' | 'synthetic'
  readonly pageCount: number
  geometry(): Promise<PageGeometry>
  raster(page: number): Promise<PageBitmap>
  createStream(): StreamSource
}
