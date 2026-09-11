import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Width/height straight out of the IHDR chunk — no image decode. */
export function pngSize(buf: Uint8Array): { w: number; h: number } {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error('not a png')
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { w: view.getUint32(16), h: view.getUint32(20) }
}

export type ManifestPage = { id: string; w: number; h: number }
export type Manifest = { pages: ManifestPage[] }

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIRS = ['dataset/training_data', 'dataset/testing_data']
const OUT = path.join(ROOT, 'public/funsd')

async function main() {
  await mkdir(path.join(OUT, 'images'), { recursive: true })
  await mkdir(path.join(OUT, 'annotations'), { recursive: true })

  const pages: ManifestPage[] = []
  for (const dir of SRC_DIRS) {
    const abs = path.join(ROOT, dir)
    if (!existsSync(abs)) throw new Error(`missing raw corpus: ${dir}`)
    const files = (await readdir(path.join(abs, 'images'))).filter((f) => f.endsWith('.png'))
    files.sort()
    for (const file of files) {
      const id = path.basename(file, '.png')
      const png = await readFile(path.join(abs, 'images', file))
      pages.push({ id, ...pngSize(png) })
      // Idempotent: skip a copy whose bytes already match.
      await copyIfChanged(path.join(abs, 'images', file), path.join(OUT, 'images', file))
      await copyIfChanged(
        path.join(abs, 'annotations', `${id}.json`),
        path.join(OUT, 'annotations', `${id}.json`),
      )
    }
  }

  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify({ pages } satisfies Manifest))
  console.log(`prepared ${pages.length} FUNSD pages`)
}

async function copyIfChanged(from: string, to: string) {
  if (existsSync(to)) {
    const [a, b] = await Promise.all([readFile(from), readFile(to)])
    if (createHash('sha1').update(a).digest('hex') === createHash('sha1').update(b).digest('hex')) {
      return
    }
  }
  await copyFile(from, to)
}

// Run when executed directly (via `pnpm prepare:funsd` / vite-node), not when
// imported for its `pngSize` export — e.g. by the Vitest test suite, which
// sets `VITEST` in the environment.
if (!process.env.VITEST) await main()
