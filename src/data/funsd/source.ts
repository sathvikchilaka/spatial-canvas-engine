import { PAGE_GAP } from '@/data/generator'
import { stackedGeometry, type PageGeometry } from '@/data/geometry'
import type { PageBitmap } from '@/data/pageRenderer'
import type { DocumentSource } from '@/data/document'
import { FunsdStreamSource } from '@/stream/funsdSource'

type ManifestPage = { id: string; w: number; h: number }

export async function createFunsdDocument(): Promise<DocumentSource> {
  const res = await fetch('/funsd/manifest.json')
  if (!res.ok) throw new Error('funsd manifest missing — run `pnpm prepare:funsd`')
  const { pages } = (await res.json()) as { pages: ManifestPage[] }
  // Sizes come from the manifest, so geometry costs one small fetch rather
  // than 199 image decodes.
  const geometry: PageGeometry = stackedGeometry(pages, PAGE_GAP)

  return {
    id: 'funsd',
    pageCount: pages.length,
    async geometry() {
      return geometry
    },
    async raster(page) {
      const img = await fetch(`/funsd/images/${pages[page].id}.png`)
      if (!img.ok) throw new Error(`funsd image ${pages[page].id} missing`)
      return (await createImageBitmap(await img.blob())) as PageBitmap
    },
    createStream() {
      return new FunsdStreamSource(pages.map((p) => p.id))
    },
  }
}
