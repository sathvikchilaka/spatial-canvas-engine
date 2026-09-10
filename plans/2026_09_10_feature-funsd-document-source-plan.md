# FUNSD Document Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 199-page FUNSD corpus (41,228 real boxes, ~5,312 real directed link edges) as a first-class document alongside the existing 100-page/10k synthetic stress document, behind one `DocumentSource` interface.

**Architecture:** A `DocumentSource` seam supplies page geometry, page rasters, and a stream for each document kind. Page layout stops being a module constant and becomes a `PageGeometry` table with binary-searched viewport range queries. All parsing — FUNSD *and* synthetic — moves into the worker behind a single `ingestUrl` request. The linear reading-order chain is replaced by a directed edge set, which FUNSD populates from real `linking` data and synthetic populates with a degenerate chain.

**Tech Stack:** Vite 8 · React 19 · TypeScript · Vitest 5 · native Web Worker · Canvas2D · Zustand + Immer

**Spec:** `docs/superpowers/specs/2026-09-10-funsd-document-source-design.md`

## Global Constraints

- No DOM overlays for boxes. Canvas2D only.
- Viewport culling every frame — the draw loop never iterates all nodes.
- No allocations inside the frame loop: no `.map`/`.filter`/object literals per box per frame.
- Worker owns parsing + spatial index; main thread owns render + interaction.
- Worker payloads are transferable typed arrays, never arrays of objects.
- Zero leaks across repeated load/undo/redo cycles — every `ImageBitmap` gets `.close()`.
- Path alias `@/` → `src/`. Merge classes with `cn()` from `@/lib/utils`.
- Dark-first, achromatic surfaces, design tokens only (`bg-background`, `border-border`) — no hex in UI.
- Package manager is **pnpm**. Tests: `pnpm test`. Types: `pnpm typecheck`.
- `dataset/` stays gitignored (raw source). Shipped assets live in `public/funsd/` and ARE committed.
- FUNSD is RVL-CDIP-derived, non-commercial research use — must be noted in `ARCHITECTURE.md`.

---

### Task 1: FUNSD asset preparation script

Copies the gitignored raw corpus into `public/funsd/` and derives a page-size manifest by reading PNG IHDR headers, so page geometry never requires decoding 199 images.

**Files:**
- Create: `scripts/prepare-funsd.ts`
- Create: `tests/scripts/pngSize.test.ts`
- Modify: `package.json` (add `prepare:funsd` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `pngSize(buf: Uint8Array): { w: number; h: number }` exported from `scripts/prepare-funsd.ts`. Emits `public/funsd/manifest.json` of shape `{ pages: { id: string; w: number; h: number }[] }`, `public/funsd/images/<id>.png`, `public/funsd/annotations/<id>.json`.

- [x] **Step 1: Write the failing test**

`tests/scripts/pngSize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { pngSize } from '../../scripts/prepare-funsd'

/** Minimal PNG: 8-byte signature, then a length+type+IHDR body. */
function fakePng(w: number, h: number): Uint8Array {
  const buf = new Uint8Array(33)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(buf.buffer)
  view.setUint32(8, 13)
  buf.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  view.setUint32(16, w)
  view.setUint32(20, h)
  return buf
}

describe('pngSize', () => {
  it('reads width and height from the IHDR chunk', () => {
    expect(pngSize(fakePng(754, 1000))).toEqual({ w: 754, h: 1000 })
  })

  it('rejects a buffer that is not a PNG', () => {
    expect(() => pngSize(new Uint8Array(33))).toThrow(/not a png/i)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/scripts/pngSize.test.ts`
Expected: FAIL — cannot resolve `scripts/prepare-funsd`.

- [x] **Step 3: Write the script**

`scripts/prepare-funsd.ts`:

```ts
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

if (process.argv[1]?.endsWith('prepare-funsd.ts')) await main()
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/scripts/pngSize.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Add the npm script**

In `package.json` `"scripts"`, after `"dev:all"`:

```json
"prepare:funsd": "vite-node scripts/prepare-funsd.ts"
```

Then: `pnpm add -D vite-node`

- [x] **Step 6: Run it and verify output**

Run: `pnpm prepare:funsd`
Expected: `prepared 199 FUNSD pages`.

Verify: `ls public/funsd/images | wc -l` → `199`; `ls public/funsd/annotations | wc -l` → `199`.

Run it a second time and confirm it is idempotent (same output, no errors).

- [x] **Step 7: Commit**

```bash
git add scripts/prepare-funsd.ts tests/scripts/pngSize.test.ts package.json pnpm-lock.yaml public/funsd
git commit -m "feat(data): prepare FUNSD assets and page-size manifest"
```

---

### Task 2: PageGeometry

Replaces the constant-stride page layout with a table that supports variable page sizes, keeping the uniform case bit-identical to today.

**Files:**
- Create: `src/data/geometry.ts`
- Create: `tests/data/geometry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PageGeometry = { count: number; rects: Float32Array; origin(page: number, out: Float32Array): void; rangeFor(y: number, h: number): [number, number] }`
  - `uniformGeometry(count: number, w: number, h: number, gap: number): PageGeometry`
  - `stackedGeometry(sizes: { w: number; h: number }[], gap: number): PageGeometry`

- [x] **Step 1: Write the failing test**

`tests/data/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { stackedGeometry, uniformGeometry } from '@/data/geometry'
import { PAGE_GAP, PAGE_H, PAGE_W, pageOrigin } from '@/data/generator'

describe('uniformGeometry', () => {
  const g = uniformGeometry(100, PAGE_W, PAGE_H, PAGE_GAP)
  const out = new Float32Array(4)

  it('matches the legacy pageOrigin for every page', () => {
    for (let p = 0; p < 100; p++) {
      const [ox, oy] = pageOrigin(p)
      g.origin(p, out)
      expect([out[0], out[1]]).toEqual([ox, oy])
    }
  })

  it('matches the legacy constant-stride range math', () => {
    const stride = PAGE_H + PAGE_GAP
    for (const y of [0, stride * 3.5, stride * 99]) {
      const legacyFrom = Math.max(0, Math.floor(y / stride))
      const legacyTo = Math.min(99, Math.floor((y + 2000) / stride))
      expect(g.rangeFor(y, 2000)).toEqual([legacyFrom, legacyTo])
    }
  })
})

describe('stackedGeometry', () => {
  // Deliberately variable heights — the case uniform math cannot express.
  const g = stackedGeometry([{ w: 10, h: 100 }, { w: 20, h: 50 }, { w: 30, h: 200 }], 10)
  const out = new Float32Array(4)

  it('stacks pages at their own heights', () => {
    g.origin(0, out); expect([out[1], out[3]]).toEqual([0, 100])
    g.origin(1, out); expect([out[1], out[3]]).toEqual([110, 50])
    g.origin(2, out); expect([out[1], out[3]]).toEqual([170, 200])
  })

  it('finds the pages intersecting a span', () => {
    expect(g.rangeFor(0, 5)).toEqual([0, 0])
    expect(g.rangeFor(115, 10)).toEqual([1, 1])
    expect(g.rangeFor(0, 400)).toEqual([0, 2])
  })

  it('clamps a span above the document to the last page', () => {
    expect(g.rangeFor(10_000, 100)).toEqual([2, 2])
  })

  it('clamps a span below the document to the first page', () => {
    expect(g.rangeFor(-500, 100)).toEqual([0, 0])
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/data/geometry.test.ts`
Expected: FAIL — cannot resolve `@/data/geometry`.

- [x] **Step 3: Write the implementation**

`src/data/geometry.ts`:

```ts
/**
 * The single source of truth for where pages sit in world space. Replaces the
 * constant-stride arithmetic that assumed every page was the same A4 slot.
 */
export type PageGeometry = {
  count: number
  /** x, y, w, h per page at i * 4 — world units */
  rects: Float32Array
  origin(page: number, out: Float32Array): void
  /** inclusive [from, to] page range intersecting a world y-span */
  rangeFor(y: number, h: number): [number, number]
}

function build(rects: Float32Array, count: number): PageGeometry {
  return {
    count,
    rects,
    origin(page, out) {
      const c = page * 4
      out[0] = rects[c]
      out[1] = rects[c + 1]
      out[2] = rects[c + 2]
      out[3] = rects[c + 3]
    },
    rangeFor(y, h) {
      if (count === 0) return [0, -1]
      return [lowerBound(rects, count, y), lowerBound(rects, count, y + h)]
    },
  }
}

/**
 * Last page whose top is <= `y`, clamped into range. Binary search rather than
 * a divide, because page heights are no longer uniform.
 */
function lowerBound(rects: Float32Array, count: number, y: number): number {
  let lo = 0
  let hi = count - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rects[mid * 4 + 1] <= y) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/** Every page the same size — the synthetic document. */
export function uniformGeometry(count: number, w: number, h: number, gap: number): PageGeometry {
  const rects = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const c = i * 4
    rects[c] = 0
    rects[c + 1] = i * (h + gap)
    rects[c + 2] = w
    rects[c + 3] = h
  }
  return build(rects, count)
}

/** Pages at their own native sizes, stacked top to bottom — the FUNSD document. */
export function stackedGeometry(sizes: { w: number; h: number }[], gap: number): PageGeometry {
  const rects = new Float32Array(sizes.length * 4)
  let y = 0
  for (let i = 0; i < sizes.length; i++) {
    const c = i * 4
    rects[c] = 0
    rects[c + 1] = y
    rects[c + 2] = sizes[i].w
    rects[c + 3] = sizes[i].h
    y += sizes[i].h + gap
  }
  return build(rects, sizes.length)
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/data/geometry.test.ts`
Expected: PASS (7 tests).

- [x] **Step 5: Commit**

```bash
git add src/data/geometry.ts tests/data/geometry.test.ts
git commit -m "feat(data): add PageGeometry with variable page sizes"
```

---

### Task 3: PageLayer consumes PageGeometry

Removes the last hard-coded page-layout arithmetic from the render path.

**Files:**
- Modify: `src/engine/layers/pages.ts` (replace `visiblePageRange`, rewrite `PageLayer.draw`)
- Modify: `src/engine/engine.ts` (pass geometry through — grep for `visiblePageRange` and `PageLayer`)
- Modify: `tests/engine/*` if a test calls `visiblePageRange` (grep first)

**Interfaces:**
- Consumes: `PageGeometry`, `uniformGeometry` from Task 2.
- Produces: `PageLayer.draw(ctx, pages, geometry, from, to)`. `visiblePageRange` is **deleted** — callers use `geometry.rangeFor(y, h)`.

- [x] **Step 1: Find every caller**

Run: `grep -rn "visiblePageRange\|PageLayer\|pageOrigin" src tests`
Record the list — every hit must be updated in this task.

- [x] **Step 2: Write the failing test**

Append to `tests/data/geometry.test.ts`:

```ts
import { PageLayer } from '@/engine/layers/pages'

describe('PageLayer with geometry', () => {
  it('draws each page at its geometry rect, not a constant stride', () => {
    const g = stackedGeometry([{ w: 10, h: 100 }, { w: 20, h: 50 }], 10)
    const calls: number[][] = []
    const ctx = {
      fillStyle: '',
      fillRect: (x: number, y: number, w: number, h: number) => calls.push([x, y, w, h]),
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D

    const layer = new PageLayer(4)
    layer.draw(ctx, [], g, 0, 1)

    // Page 1's paper rect starts at y=110 and is 50 tall.
    expect(calls.some(([, y, w, h]) => y === 110 && w === 20 && h === 50)).toBe(true)
    layer.dispose()
  })
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/data/geometry.test.ts`
Expected: FAIL — `draw` has the old 4-argument signature.

- [x] **Step 4: Rewrite `src/engine/layers/pages.ts`**

```ts
import { PageCache, type PageBitmap } from '@/data/pageRenderer'
import type { PageGeometry } from '@/data/geometry'
import type { GeneratedPage } from '@/data/generator'

const SHADOW = 'rgba(0,0,0,0.35)'
const PAPER = '#faf8f4'

export class PageLayer {
  readonly cache: PageCache
  private readonly rect = new Float32Array(4)

  constructor(maxResident = 12) {
    this.cache = new PageCache(maxResident)
  }

  draw(
    ctx: CanvasRenderingContext2D,
    pages: GeneratedPage[],
    geometry: PageGeometry,
    from: number,
    to: number,
  ): void {
    for (let p = from; p <= to; p++) {
      geometry.origin(p, this.rect)
      const [ox, oy, w, h] = this.rect
      ctx.fillStyle = SHADOW
      ctx.fillRect(ox + 4, oy + 6, w, h)

      this.cache.ensure(p, pages[p])
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
```

Note this changes `PageCache.ensure`/`get` to be keyed by page **index** rather than by a `GeneratedPage` object — Task 8 completes that change. For now update `src/data/pageRenderer.ts` `ensure(page: GeneratedPage)` → `ensure(index: number, page?: GeneratedPage)` and `get(page: GeneratedPage)` → `get(index: number)`, keeping the existing synchronous body otherwise.

- [x] **Step 5: Update `src/engine/engine.ts`**

Replace the `visiblePageRange(...)` call with `this.geometry.rangeFor(vp.worldY, vp.worldH)` (match the local variable names already present), add a `geometry: PageGeometry` field defaulting to `uniformGeometry(pages.length, PAGE_W, PAGE_H, PAGE_GAP)` inside `setData`, and pass it into `pageLayer.draw`.

- [x] **Step 6: Run the whole suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Fix any test that still calls the deleted `visiblePageRange`.

- [x] **Step 7: Commit**

```bash
git add src tests
git commit -m "refactor(engine): drive page layout from PageGeometry"
```

---

### Task 4: FUNSD annotation parser

A pure function, worker-safe (no DOM), turning one FUNSD JSON into flat nodes plus deduped edges.

**Files:**
- Create: `src/data/funsd/parse.ts`
- Create: `tests/data/funsd/fixture.json`
- Create: `tests/data/funsd/parse.test.ts`

**Interfaces:**
- Consumes: `NodeType`, `SerializedNode` (existing).
- Produces:
  - `type FunsdForm = { form: FunsdEntity[] }`
  - `parseFunsdPage(form: FunsdForm, pageIndex: number, offsetX: number, offsetY: number): { nodes: SerializedNode[]; edges: number[] }` — `edges` is a flat `[fromId, toId, ...]` array, deduped.
  - `ID_STRIDE = 1000`

- [x] **Step 1: Create the fixture**

`tests/data/funsd/fixture.json` — a hand-cut two-entity form exercising both a word child and a bidirectional link:

```json
{
  "form": [
    {
      "id": 0,
      "box": [10, 20, 110, 40],
      "text": "NAME",
      "label": "question",
      "words": [
        { "box": [10, 20, 60, 40], "text": "NA" },
        { "box": [60, 20, 110, 40], "text": "ME" }
      ],
      "linking": [[0, 1]]
    },
    {
      "id": 1,
      "box": [120, 20, 300, 40],
      "text": "Ada",
      "label": "answer",
      "words": [{ "box": [120, 20, 300, 40], "text": "Ada" }],
      "linking": [[0, 1]]
    },
    {
      "id": 2,
      "box": [10, 60, 300, 80],
      "text": "Section A",
      "label": "header",
      "words": [{ "box": [10, 60, 300, 80], "text": "Section A" }],
      "linking": []
    }
  ]
}
```

- [x] **Step 2: Write the failing test**

`tests/data/funsd/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ID_STRIDE, parseFunsdPage, type FunsdForm } from '@/data/funsd/parse'
import { NodeType } from '@/data/nodes'
import fixture from './fixture.json'

const form = fixture as FunsdForm

describe('parseFunsdPage', () => {
  it('converts [x0,y0,x1,y1] to {x,y,w,h} and applies the page offset', () => {
    const { nodes } = parseFunsdPage(form, 0, 0, 500)
    const first = nodes[0]
    expect([first.x, first.y, first.w, first.h]).toEqual([10, 520, 100, 20])
  })

  it('emits one node per entity plus one per word', () => {
    const { nodes } = parseFunsdPage(form, 0, 0, 0)
    expect(nodes).toHaveLength(3 + 4)
  })

  it('maps labels onto node types', () => {
    const { nodes } = parseFunsdPage(form, 0, 0, 0)
    const entities = nodes.filter((n) => n.parent === -1)
    expect(entities.map((n) => n.type)).toEqual([
      NodeType.KeyValue, // question
      NodeType.KeyValue, // answer
      NodeType.Paragraph, // header
    ])
  })

  it('parents words to their entity', () => {
    const { nodes } = parseFunsdPage(form, 0, 0, 0)
    const words = nodes.filter((n) => n.type === NodeType.Line)
    expect(words).toHaveLength(4)
    for (const w of words) expect(w.parent).not.toBe(-1)
  })

  it('namespaces ids by page so two pages never collide', () => {
    const a = parseFunsdPage(form, 0, 0, 0).nodes
    const b = parseFunsdPage(form, 1, 0, 0).nodes
    expect(a[0].id).toBeLessThan(ID_STRIDE)
    expect(b[0].id).toBeGreaterThanOrEqual(ID_STRIDE)
    const overlap = new Set(a.map((n) => n.id))
    expect(b.some((n) => overlap.has(n.id))).toBe(false)
  })

  it('dedupes links that appear on both endpoints', () => {
    // The fixture states [0,1] twice — once per entity. That is one edge.
    const { edges } = parseFunsdPage(form, 0, 0, 0)
    expect(edges).toHaveLength(2)
  })

  it('emits edges in global id space', () => {
    const { nodes, edges } = parseFunsdPage(form, 3, 0, 0)
    const ids = new Set(nodes.map((n) => n.id))
    expect(ids.has(edges[0])).toBe(true)
    expect(ids.has(edges[1])).toBe(true)
  })

  it('drops a link whose target does not exist', () => {
    const broken: FunsdForm = { form: [{ ...form.form[0], linking: [[0, 99]] }] }
    expect(parseFunsdPage(broken, 0, 0, 0).edges).toHaveLength(0)
  })
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/data/funsd/parse.test.ts`
Expected: FAIL — cannot resolve `@/data/funsd/parse`.

- [x] **Step 4: Write the implementation**

`src/data/funsd/parse.ts`:

```ts
import { NodeType } from '@/data/nodes'
import type { SerializedNode } from '@/worker/protocol'

export type FunsdWord = { box: [number, number, number, number]; text: string }
export type FunsdEntity = {
  id: number
  box: [number, number, number, number]
  text: string
  label: 'question' | 'answer' | 'header' | 'other'
  words: FunsdWord[]
  linking: [number, number][]
}
export type FunsdForm = { form: FunsdEntity[] }

/**
 * Global id = pageIndex * ID_STRIDE + a per-page counter. The densest page in
 * the corpus holds 536 nodes, so 1000 leaves headroom and keeps ids readable.
 */
export const ID_STRIDE = 1000

const TYPE_OF_LABEL: Record<FunsdEntity['label'], NodeType> = {
  question: NodeType.KeyValue,
  answer: NodeType.KeyValue,
  header: NodeType.Paragraph,
  other: NodeType.Paragraph,
}

export type ParsedPage = { nodes: SerializedNode[]; edges: number[] }

/**
 * One FUNSD form → flat nodes + directed edges, both in global id space.
 * Pure and DOM-free: this runs inside the worker.
 */
export function parseFunsdPage(
  form: FunsdForm,
  pageIndex: number,
  offsetX: number,
  offsetY: number,
): ParsedPage {
  const nodes: SerializedNode[] = []
  const base = pageIndex * ID_STRIDE
  /** FUNSD's per-file entity id → our global id */
  const globalOf = new Map<number, number>()
  let next = base
  let order = 0

  for (const entity of form.form) {
    const entityId = next++
    globalOf.set(entity.id, entityId)
    const [x0, y0, x1, y1] = entity.box
    nodes.push({
      id: entityId,
      page: pageIndex,
      x: offsetX + x0,
      y: offsetY + y0,
      w: x1 - x0,
      h: y1 - y0,
      type: TYPE_OF_LABEL[entity.label] ?? NodeType.Paragraph,
      parent: -1,
      order: order++,
    })
    for (const word of entity.words) {
      const [wx0, wy0, wx1, wy1] = word.box
      nodes.push({
        id: next++,
        page: pageIndex,
        x: offsetX + wx0,
        y: offsetY + wy0,
        w: wx1 - wx0,
        h: wy1 - wy0,
        type: NodeType.Line,
        parent: entityId,
        order: order++,
      })
    }
  }

  // `linking` is recorded on BOTH endpoints, so the raw corpus lists 10,624
  // refs for ~5,312 real edges. Dedupe on the ordered pair.
  const edges: number[] = []
  const seen = new Set<number>()
  for (const entity of form.form) {
    for (const [from, to] of entity.linking) {
      const gFrom = globalOf.get(from)
      const gTo = globalOf.get(to)
      if (gFrom === undefined || gTo === undefined) continue
      const key = (gFrom - base) * ID_STRIDE + (gTo - base)
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(gFrom, gTo)
    }
  }

  return { nodes, edges }
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/data/funsd/parse.test.ts`
Expected: PASS (8 tests).

- [x] **Step 6: Sanity-check against the real corpus**

Run:

```bash
pnpm vite-node -e "
import { readFile, readdir } from 'node:fs/promises'
import { parseFunsdPage } from './src/data/funsd/parse.ts'
const dir = 'public/funsd/annotations'
let n = 0, e = 0
for (const f of await readdir(dir)) {
  const r = parseFunsdPage(JSON.parse(await readFile(dir + '/' + f, 'utf8')), 0, 0, 0)
  n += r.nodes.length; e += r.edges.length / 2
}
console.log({ nodes: n, edges: e })
"
```

Expected: `{ nodes: 41228, edges: 5312 }` (edges within ±20 — a handful of self-links and dangling refs are dropped by design). If nodes is not exactly 41228, the parse is wrong; stop and fix.

- [x] **Step 7: Commit**

```bash
git add src/data/funsd tests/data/funsd
git commit -m "feat(data): parse FUNSD annotations into nodes and edges"
```

---

### Task 5: Worker `ingestUrl` and edge transport

Moves all parsing into the worker and widens the ingest response with an edge array.

**Files:**
- Modify: `src/worker/protocol.ts`
- Modify: `src/worker/index.worker.ts`
- Modify: `src/worker/client.ts`
- Modify: `tests/worker/client.test.ts`

**Interfaces:**
- Consumes: `parseFunsdPage`, `ID_STRIDE` from Task 4.
- Produces:
  - `Req` gains `| { kind: 'ingestUrl'; pageIndex: number; url: string; offsetX: number; offsetY: number }`
  - `PageIngested` gains `edges: Int32Array`
  - `WorkerClient.ingestUrl(pageIndex: number, url: string, offsetX: number, offsetY: number): void`

- [x] **Step 1: Write the failing test**

Append to `tests/worker/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { WorkerClient } from '@/worker/client'
import { UNSOLICITED } from '@/worker/protocol'

describe('WorkerClient.ingestUrl', () => {
  it('posts an ingestUrl request with the page offset', () => {
    const postMessage = vi.fn()
    const worker = { postMessage, terminate: vi.fn() } as unknown as Worker
    const client = new WorkerClient(worker)

    client.ingestUrl(7, '/funsd/annotations/abc.json', 0, 7280)

    expect(postMessage).toHaveBeenCalledWith({
      id: UNSOLICITED,
      kind: 'ingestUrl',
      pageIndex: 7,
      url: '/funsd/annotations/abc.json',
      offsetX: 0,
      offsetY: 7280,
    })
    client.dispose()
  })

  it('forwards the edges array to page subscribers', () => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker
    const client = new WorkerClient(worker)
    const seen: Int32Array[] = []
    client.onPageIngested((p) => seen.push(p.edges))

    worker.onmessage?.({
      data: {
        id: UNSOLICITED, kind: 'pageIngested', pageIndex: 0,
        ids: new Uint32Array(0), coords: new Float32Array(0), types: new Uint8Array(0),
        parents: new Int32Array(0), order: new Int32Array(0), edges: Int32Array.of(1, 2),
      },
    } as MessageEvent)

    expect(Array.from(seen[0])).toEqual([1, 2])
    client.dispose()
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/worker/client.test.ts`
Expected: FAIL — `client.ingestUrl is not a function`.

- [x] **Step 3: Widen the protocol**

In `src/worker/protocol.ts`, add to the `Req` union:

```ts
  | { kind: 'ingestUrl'; pageIndex: number; url: string; offsetX: number; offsetY: number }
```

and add to `PageIngested`:

```ts
  edges: Int32Array
```

- [x] **Step 4: Add the client method**

In `src/worker/client.ts`, after `ingestPage`:

```ts
  /** Fire-and-forget: the worker fetches and parses; we only get typed arrays back. */
  ingestUrl(pageIndex: number, url: string, offsetX: number, offsetY: number): void {
    this.worker.postMessage({
      id: UNSOLICITED, kind: 'ingestUrl', pageIndex, url, offsetX, offsetY,
    } satisfies Req)
  }
```

- [x] **Step 5: Implement in the worker**

In `src/worker/index.worker.ts`, change `ingest` to accept edges and emit them:

```ts
function ingest(page: SerializedPage, edges: number[] = []) {
  const start = nodes.count
  for (const n of page.nodes) {
    const i = pushNode(nodes, {
      id: n.id, page: n.page, x: n.x, y: n.y, w: n.w, h: n.h,
      type: n.type as NodeType, parent: n.parent, order: n.order,
    })
    indexById.set(n.id, i)
    tree.insert(n.id, n.x, n.y, n.w, n.h)
  }
  const ids = nodes.ids.slice(start, nodes.count)
  const coords = nodes.coords.slice(start * 4, nodes.count * 4)
  const types = nodes.types.slice(start, nodes.count)
  const parents = nodes.parents.slice(start, nodes.count)
  const order = nodes.order.slice(start, nodes.count)
  const edgeArray = Int32Array.from(edges)
  const res: Res = {
    id: UNSOLICITED, kind: 'pageIngested', pageIndex: page.pageIndex,
    ids, coords, types, parents, order, edges: edgeArray,
  }
  ;(self as unknown as Worker).postMessage(res, [
    ids.buffer, coords.buffer, types.buffer, parents.buffer, order.buffer, edgeArray.buffer,
  ] as Transferable[])
}
```

Add the fetch-and-parse handler above `self.onmessage`:

```ts
import { parseFunsdPage, type FunsdForm } from '@/data/funsd/parse'
import { serializeGeneratedPage } from '@/data/synthetic/serialize'

const SYNTHETIC = 'synthetic://page/'

/**
 * The whole point of the worker: 199 annotation files are fetched, parsed and
 * indexed here. The main thread only ever sees transferable typed arrays.
 */
async function ingestUrl(pageIndex: number, url: string, offsetX: number, offsetY: number) {
  if (url.startsWith(SYNTHETIC)) {
    const seed = Number(new URL(url).searchParams.get('seed') ?? 1)
    ingest({ pageIndex, nodes: serializeGeneratedPage(pageIndex, seed) })
    return
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`funsd fetch failed: ${res.status}`)
  const form = (await res.json()) as FunsdForm
  const { nodes: parsed, edges } = parseFunsdPage(form, pageIndex, offsetX, offsetY)
  ingest({ pageIndex, nodes: parsed }, edges)
}
```

and the case in the switch, alongside `ingestPage`:

```ts
      case 'ingestUrl':
        void ingestUrl(msg.pageIndex, msg.url, msg.offsetX, msg.offsetY).catch((err) =>
          reply({ id: UNSOLICITED, kind: 'error', message: (err as Error).message }),
        )
        break
```

- [x] **Step 6: Move `serializeGeneratedPage` into the worker's reach**

Create `src/data/synthetic/serialize.ts` and move the body of `serializeGeneratedPage` there verbatim from `src/stream/mockSource.ts:32-53`. Delete it from `mockSource.ts` and re-export from `src/data/synthetic/serialize` at its old import sites so nothing breaks yet.

- [x] **Step 7: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. `PageIngested` now requires `edges` — add `edges: new Int32Array(0)` to any existing test fixture the compiler flags.

- [x] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat(worker): fetch and parse pages in-worker, transport edges"
```

---

### Task 6: Edge set and store state

Replaces the linear reading-order chain with a directed edge model that both documents share.

**Files:**
- Create: `src/data/edges.ts`
- Create: `tests/data/edges.test.ts`
- Modify: `src/store/store.ts` (drop `Edit.orderNext`, add `edgesAdded`/`edgesRemoved`)
- Modify: `src/tools/orderTool.ts` (delete `orderedIds`, `relink`)
- Modify: `tests/tools/orderTool.test.ts` (delete the chain tests, keep `arrowPath`)

**Interfaces:**
- Consumes: `NodeArrays`, `indexOfId` (existing).
- Produces:
  - `type EdgeSet = { count: number; pairs: Int32Array; adjacency: Map<number, number[]> }`
  - `createEdgeSet(): EdgeSet`
  - `appendEdges(set: EdgeSet, pairs: Int32Array): void`
  - `materialize(base: EdgeSet, added: [number, number][], removed: [number, number][], nodes: NodeArrays): EdgeSet` — returns a new set whose `adjacency` maps **node index** → array of *target node ids*
  - `hasEdge(set: EdgeSet, from: number, to: number): boolean`
  - `AppState` gains `edgesAdded: [number, number][]` and `edgesRemoved: [number, number][]`

- [x] **Step 1: Write the failing test**

`tests/data/edges.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { appendEdges, createEdgeSet, hasEdge, materialize } from '@/data/edges'
import { createNodeArrays, pushNode, NodeType, indexOfId } from '@/data/nodes'

function nodesOf(ids: number[]) {
  const a = createNodeArrays(ids.length)
  for (const id of ids) {
    pushNode(a, { id, page: 0, x: 0, y: 0, w: 1, h: 1, type: NodeType.Paragraph, parent: -1, order: id })
  }
  return a
}

describe('EdgeSet', () => {
  it('accumulates edges across pages', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(1, 2))
    appendEdges(set, Int32Array.of(3, 4))
    expect(set.count).toBe(2)
    expect(Array.from(set.pairs.subarray(0, 4))).toEqual([1, 2, 3, 4])
  })

  it('reports membership', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(1, 2))
    expect(hasEdge(set, 1, 2)).toBe(true)
    expect(hasEdge(set, 2, 1)).toBe(false)
  })

  it('materializes base plus added minus removed', () => {
    const nodes = nodesOf([1, 2, 3])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 2, 3))

    const eff = materialize(base, [[1, 3]], [[2, 3]], nodes)

    expect(hasEdge(eff, 1, 2)).toBe(true)
    expect(hasEdge(eff, 1, 3)).toBe(true)
    expect(hasEdge(eff, 2, 3)).toBe(false)
  })

  it('indexes adjacency by node index for the render loop', () => {
    const nodes = nodesOf([1, 2, 3])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 1, 3))

    const eff = materialize(base, [], [], nodes)

    expect(eff.adjacency.get(indexOfId(nodes, 1))).toEqual([2, 3])
    expect(eff.adjacency.has(indexOfId(nodes, 2))).toBe(false)
  })

  it('supports out-degree greater than one — a DAG, not a chain', () => {
    const nodes = nodesOf([1, 2, 3])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 1, 3))
    expect(materialize(base, [], [], nodes).adjacency.get(indexOfId(nodes, 1))).toHaveLength(2)
  })

  it('ignores an added edge that duplicates a base edge', () => {
    const nodes = nodesOf([1, 2])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2))
    expect(materialize(base, [[1, 2]], [], nodes).count).toBe(1)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/data/edges.test.ts`
Expected: FAIL — cannot resolve `@/data/edges`.

- [x] **Step 3: Write the implementation**

`src/data/edges.ts`:

```ts
import { indexOfId, type NodeArrays } from './nodes'

/**
 * The reading-order graph. A directed edge set rather than a linear chain,
 * because FUNSD questions link to several answers and a chain cannot say that.
 * A synthetic document is the degenerate case: out-degree 1 everywhere.
 */
export type EdgeSet = {
  count: number
  /** [fromId, toId] at i * 2 */
  pairs: Int32Array
  /** node index → target node ids. Built once per graph change, never per frame. */
  adjacency: Map<number, number[]>
}

const INITIAL = 256

export function createEdgeSet(): EdgeSet {
  return { count: 0, pairs: new Int32Array(INITIAL * 2), adjacency: new Map() }
}

export function appendEdges(set: EdgeSet, pairs: Int32Array): void {
  const need = set.count * 2 + pairs.length
  if (need > set.pairs.length) {
    let cap = set.pairs.length || 2
    while (cap < need) cap *= 2
    const grown = new Int32Array(cap)
    grown.set(set.pairs)
    set.pairs = grown
  }
  set.pairs.set(pairs, set.count * 2)
  set.count += pairs.length / 2
}

export function hasEdge(set: EdgeSet, from: number, to: number): boolean {
  for (let i = 0; i < set.count; i++) {
    if (set.pairs[i * 2] === from && set.pairs[i * 2 + 1] === to) return true
  }
  return false
}

/**
 * base ∪ added ∖ removed, plus the adjacency the overlay draws from. Called
 * when the graph changes (an edit, a new page) — never inside the frame loop.
 */
export function materialize(
  base: EdgeSet,
  added: [number, number][],
  removed: [number, number][],
  nodes: NodeArrays,
): EdgeSet {
  const drop = new Set<string>()
  for (const [f, t] of removed) drop.add(`${f}>${t}`)

  const out = createEdgeSet()
  const seen = new Set<string>()
  const push = (f: number, t: number) => {
    const key = `${f}>${t}`
    if (drop.has(key) || seen.has(key)) return
    seen.add(key)
    appendEdges(out, Int32Array.of(f, t))
  }

  for (let i = 0; i < base.count; i++) push(base.pairs[i * 2], base.pairs[i * 2 + 1])
  for (const [f, t] of added) push(f, t)

  for (let i = 0; i < out.count; i++) {
    const fromIndex = indexOfId(nodes, out.pairs[i * 2])
    if (fromIndex < 0) continue
    const list = out.adjacency.get(fromIndex)
    if (list) list.push(out.pairs[i * 2 + 1])
    else out.adjacency.set(fromIndex, [out.pairs[i * 2 + 1]])
  }
  return out
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/data/edges.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Update the store**

In `src/store/store.ts`: delete `orderNext` from `Edit`, and change `AppState` + `initial`:

```ts
export type AppState = {
  edits: Record<number, Edit>
  dirtyAt: Record<number, number>
  selectedId: number | null
  hoveredId: number | null
  /** Human-added graph edges, [from, to]. Base edges live outside the store. */
  edgesAdded: [number, number][]
  /** Base edges the human deleted. */
  edgesRemoved: [number, number][]
}

const initial: AppState = {
  edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null,
  edgesAdded: [], edgesRemoved: [],
}
```

- [x] **Step 6: Delete the chain model**

From `src/tools/orderTool.ts`, delete `orderedIds` and `relink` entirely. Keep `arrowPath`, `Arrow`, `OrderToolDeps`, `OrderTool`. From `tests/tools/orderTool.test.ts`, delete the `orderedIds`/`relink` describe blocks; keep the `arrowPath` ones.

- [x] **Step 7: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: type errors in `session.ts` and `overlays.ts` where `orderedIds` was called — those are fixed in Task 7. To keep this task independently green, temporarily comment out the `drawOrder` body in `session.ts` with a `// TASK 7` marker.

- [x] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat(data): replace linear reading order with a directed edge set"
```

---

### Task 7: Overlay and tool on the edge model

Makes the reading-order overlay culling-correct and turns the drag gesture into an edge toggle.

**Files:**
- Modify: `src/engine/layers/overlays.ts` (rewrite `OrderOverlay`)
- Modify: `src/tools/orderTool.ts` (`OrderTool.onPointerUp`)
- Modify: `src/app/session.ts` (`drawOrder`, remove the TASK 7 marker)
- Create: `tests/engine/orderOverlay.test.ts`
- Modify: `tests/tools/orderTool.test.ts`

**Interfaces:**
- Consumes: `EdgeSet`, `materialize`, `hasEdge` (Task 6); `arrowPath` (existing).
- Produces:
  - `OrderOverlay.setGraph(edges: EdgeSet): void` — replaces `setSequence`
  - `OrderOverlay.draw(ctx, nodes, visible, visibleCount, scale, selectedIndex, indexOfId)` — signature unchanged
  - `commit('link' | 'unlink', …)` writing `edgesAdded` / `edgesRemoved`

- [x] **Step 1: Write the failing test**

`tests/engine/orderOverlay.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { OrderOverlay } from '@/engine/layers/overlays'
import { appendEdges, createEdgeSet, materialize } from '@/data/edges'
import { createNodeArrays, indexOfId, pushNode, NodeType } from '@/data/nodes'

function scene(n: number) {
  const nodes = createNodeArrays(n)
  for (let i = 0; i < n; i++) {
    pushNode(nodes, {
      id: i + 1, page: 0, x: i * 100, y: 0, w: 50, h: 20,
      type: NodeType.Paragraph, parent: -1, order: i,
    })
  }
  return nodes
}

function stubCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
    fillText: vi.fn(), fillRect: vi.fn(), measureText: () => ({ width: 10 }),
    strokeStyle: '', fillStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
  } as unknown as CanvasRenderingContext2D
}

describe('OrderOverlay', () => {
  it('draws only edges leaving a visible node', () => {
    const nodes = scene(3)
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 2, 3))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))

    const ctx = stubCtx()
    // Only node index 0 is on screen, so only edge 1→2 may be drawn.
    overlay.draw(ctx, nodes, Uint32Array.of(0), 1, 1, -1, (id) => indexOfId(nodes, id))

    expect(ctx.stroke).toHaveBeenCalledTimes(1)
  })

  it('draws nothing when no node is visible', () => {
    const nodes = scene(3)
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))

    const ctx = stubCtx()
    overlay.draw(ctx, nodes, new Uint32Array(0), 0, 1, -1, (id) => indexOfId(nodes, id))

    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('draws both edges of a node with out-degree two', () => {
    const nodes = scene(3)
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 1, 3))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))

    const ctx = stubCtx()
    overlay.draw(ctx, nodes, Uint32Array.of(0), 1, 1, -1, (id) => indexOfId(nodes, id))

    expect(ctx.stroke).toHaveBeenCalledTimes(2)
  })

  it('caps the number of arrows drawn', () => {
    const nodes = scene(500)
    const base = createEdgeSet()
    const pairs: number[] = []
    for (let i = 1; i < 500; i++) pairs.push(i, i + 1)
    appendEdges(base, Int32Array.from(pairs))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))

    const visible = Uint32Array.from({ length: 500 }, (_, i) => i)
    const ctx = stubCtx()
    overlay.draw(ctx, nodes, visible, 500, 1, -1, (id) => indexOfId(nodes, id))

    expect((ctx.stroke as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(300)
  })
})
```

And append to `tests/tools/orderTool.test.ts`:

```ts
import { OrderTool } from '@/tools/orderTool'
import { useStore } from '@/store/store'

describe('OrderTool edge toggle', () => {
  const deps = {
    getRect: () => ({ x: 0, y: 0, w: 10, h: 10 }),
    pick: vi.fn(),
    requestDraw: vi.fn(),
    hasEdge: vi.fn(),
  }

  beforeEach(() => {
    useStore.setState({ edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] }, true)
    deps.pick.mockReset()
    deps.hasEdge.mockReset()
  })

  it('adds an edge when none exists', async () => {
    deps.pick.mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    deps.hasEdge.mockReturnValue(false)
    const tool = new OrderTool(deps)
    tool.onPointerDown({ world: [0, 0] } as never)
    await Promise.resolve()
    tool.onPointerUp({ world: [5, 5] } as never)
    await Promise.resolve()
    expect(useStore.getState().edgesAdded).toEqual([[1, 2]])
  })

  it('removes an edge that already exists', async () => {
    deps.pick.mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    deps.hasEdge.mockReturnValue(true)
    const tool = new OrderTool(deps)
    tool.onPointerDown({ world: [0, 0] } as never)
    await Promise.resolve()
    tool.onPointerUp({ world: [5, 5] } as never)
    await Promise.resolve()
    expect(useStore.getState().edgesRemoved).toEqual([[1, 2]])
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/engine/orderOverlay.test.ts tests/tools/orderTool.test.ts`
Expected: FAIL — `setGraph is not a function`, `hasEdge` not in deps.

- [x] **Step 3: Rewrite `OrderOverlay`**

In `src/engine/layers/overlays.ts`, replace `setSequence`, the `seq`/`seqOf` fields, and the `draw` loop:

```ts
  private edges: EdgeSet = createEdgeSet()

  setGraph(edges: EdgeSet): void {
    this.edges = edges
  }
```

and the body of `draw`, replacing the sequence walk:

```ts
    if (this.edges.count === 0) return
    const budget = visibleCount > MAX_ARROWS && selectedIndex >= 0 ? 2 : MAX_ARROWS
    ctx.save()
    ctx.strokeStyle = 'rgba(120, 220, 180, 0.8)'
    ctx.fillStyle = 'rgba(120, 220, 180, 0.8)'
    ctx.lineWidth = 1.25 / scale

    let drawn = 0
    // Iterate the culled set, not the whole graph: the draw loop must never
    // touch a node the viewport does not contain.
    for (let k = 0; k < visibleCount && drawn < budget; k++) {
      const ia = visible[k]
      const targets = this.edges.adjacency.get(ia)
      if (!targets) continue
      readRect(nodes, ia, this.rectA)
      for (let t = 0; t < targets.length && drawn < budget; t++) {
        const ib = indexOfId(targets[t])
        if (ib < 0) continue
        readRect(nodes, ib, this.rectB)
        const p = arrowPath(this.rectA, this.rectB)
        ctx.beginPath()
        ctx.moveTo(p.x1, p.y1)
        ctx.lineTo(p.x2, p.y2)
        ctx.stroke()
        const h = HEAD / scale
        ctx.beginPath()
        ctx.moveTo(p.x2, p.y2)
        ctx.lineTo(p.x2 - h * Math.cos(p.headAngle - 0.4), p.y2 - h * Math.sin(p.headAngle - 0.4))
        ctx.lineTo(p.x2 - h * Math.cos(p.headAngle + 0.4), p.y2 - h * Math.sin(p.headAngle + 0.4))
        ctx.closePath()
        ctx.fill()
        drawn++
      }
    }
```

Keep `drawBadges` and the `BADGE_MIN_SCALE` guard as they are.

- [x] **Step 4: Make the drag a toggle**

In `src/tools/orderTool.ts`, add `hasEdge(from: number, to: number): boolean` to `OrderToolDeps`, and replace the `onPointerUp` commit:

```ts
    void this.deps.pick(e.world[0], e.world[1]).then((to) => {
      if (to !== null && to !== from) {
        const exists = this.deps.hasEdge(from, to)
        commit(exists ? 'unlink' : 'link', (d) => {
          if (exists) d.edgesRemoved.push([from, to])
          else d.edgesAdded.push([from, to])
          d.dirtyAt[from] = Date.now()
        })
      }
      this.deps.requestDraw()
    })
```

- [x] **Step 5: Rewire `session.ts`**

Remove the `// TASK 7` marker. Add a `baseEdges = createEdgeSet()` field, append `p.edges` inside the `onPageIngested` subscription, and rewrite `drawOrder`:

```ts
  private effectiveEdges: EdgeSet = createEdgeSet()

  private drawOrder(ctx: CanvasRenderingContext2D, scale: number) {
    if (!this.showOrder) return
    if (this.orderDirty) {
      const s = useStore.getState()
      this.effectiveEdges = materialize(this.baseEdges, s.edgesAdded, s.edgesRemoved, this.nodes)
      this.orderOverlay.setGraph(this.effectiveEdges)
      this.orderDirty = false
    }
    const sel = useStore.getState().selectedId
    const { indices, count } = this.engine.lastVisible
    this.orderOverlay.draw(
      ctx, this.nodes, indices, count, scale,
      sel === null ? -1 : indexOfId(this.nodes, sel),
      (id) => indexOfId(this.nodes, id),
    )
  }
```

and pass `hasEdge: (f, t) => hasEdge(this.effectiveEdges, f, t)` into the `OrderTool` constructor.

- [x] **Step 6: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(engine): draw the reading-order DAG from culled nodes, toggle edges by drag"
```

---

### Task 8: Async page rasters with a leak guard

Lets real PNG decodes feed the page cache without blocking, and guarantees a decode that lands after eviction is closed rather than retained.

**Files:**
- Modify: `src/data/pageRenderer.ts`
- Modify: `tests/data/pageRenderer.test.ts`

**Interfaces:**
- Consumes: `PageBitmap` (existing).
- Produces:
  - `type PageRenderFn = (index: number, page?: GeneratedPage) => PageBitmap | Promise<PageBitmap>`
  - `new PageCache(maxPages, render, onReady?: () => void)`
  - `ensure(index: number, page?: GeneratedPage): void` (non-blocking)
  - `get(index: number): PageBitmap | null`

- [x] **Step 1: Write the failing test**

Append to `tests/data/pageRenderer.test.ts`:

```ts
describe('PageCache async rasters', () => {
  const fakeBitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap

  it('returns null while a raster is pending, then the bitmap', async () => {
    let resolve!: (b: ImageBitmap) => void
    const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)))

    cache.ensure(0)
    expect(cache.get(0)).toBeNull()

    const bmp = fakeBitmap()
    resolve(bmp)
    await Promise.resolve()
    expect(cache.get(0)).toBe(bmp)
    cache.dispose()
  })

  it('does not start a second load for a page already pending', () => {
    const render = vi.fn(() => new Promise<ImageBitmap>(() => {}))
    const cache = new PageCache(4, render)
    cache.ensure(0)
    cache.ensure(0)
    expect(render).toHaveBeenCalledTimes(1)
    cache.dispose()
  })

  it('closes a raster that resolves after its page was evicted', async () => {
    let resolve!: (b: ImageBitmap) => void
    const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)))

    cache.ensure(5)
    cache.evictOutside(0, 0) // page 5 is no longer wanted

    const bmp = fakeBitmap()
    resolve(bmp)
    await Promise.resolve()

    expect(bmp.close).toHaveBeenCalled()
    expect(cache.get(5)).toBeNull()
    cache.dispose()
  })

  it('closes a raster that resolves after dispose', async () => {
    let resolve!: (b: ImageBitmap) => void
    const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)))
    cache.ensure(0)
    cache.dispose()

    const bmp = fakeBitmap()
    resolve(bmp)
    await Promise.resolve()

    expect(bmp.close).toHaveBeenCalled()
  })

  it('notifies when a raster becomes available so the frame can redraw', async () => {
    let resolve!: (b: ImageBitmap) => void
    const onReady = vi.fn()
    const cache = new PageCache(4, () => new Promise<ImageBitmap>((r) => (resolve = r)), onReady)
    cache.ensure(0)
    resolve(fakeBitmap())
    await Promise.resolve()
    expect(onReady).toHaveBeenCalled()
    cache.dispose()
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/data/pageRenderer.test.ts`
Expected: FAIL — `ensure` still expects a `GeneratedPage` and is synchronous.

- [x] **Step 3: Rewrite `PageCache`**

Replace the class in `src/data/pageRenderer.ts`:

```ts
export type PageRenderFn = (index: number, page?: GeneratedPage) => PageBitmap | Promise<PageBitmap>

/**
 * LRU of rendered page rasters, keyed by page index. 199 decoded pages would be
 * hundreds of MB; only pages near the viewport are ever resident.
 */
export class PageCache {
  private readonly cache = new Map<number, PageBitmap>()
  private readonly pending = new Set<number>()
  private disposed = false

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

  /** Non-blocking. A miss starts a load; the frame paints blank paper meanwhile. */
  ensure(index: number, page?: GeneratedPage): void {
    if (this.disposed) return
    const hit = this.cache.get(index)
    if (hit !== undefined) {
      this.cache.delete(index)
      this.cache.set(index, hit)
      return
    }
    if (this.pending.has(index)) return

    const result = this.render(index, page)
    if (!(result instanceof Promise)) {
      this.store(index, result)
      return
    }
    this.pending.add(index)
    void result.then(
      (bmp) => this.settle(index, bmp),
      () => this.pending.delete(index),
    )
  }

  /**
   * A raster can land after its page was evicted or the cache disposed. Closing
   * it there is the difference between a flat heap and a leak across reloads.
   */
  private settle(index: number, bmp: PageBitmap) {
    const wanted = this.pending.delete(index)
    if (!wanted || this.disposed) {
      close(bmp)
      return
    }
    this.store(index, bmp)
    this.onReady?.()
  }

  private store(index: number, bmp: PageBitmap) {
    this.cache.set(index, bmp)
    while (this.cache.size > this.maxPages) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.drop(oldest.value)
    }
  }

  /** Drops every page outside [from, to] inclusive, pending loads included. */
  evictOutside(from: number, to: number): void {
    for (const index of Array.from(this.cache.keys())) {
      if (index < from || index > to) this.drop(index)
    }
    for (const index of Array.from(this.pending)) {
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
    if (bmp) close(bmp)
    this.cache.delete(index)
  }
}

function close(bmp: PageBitmap) {
  if (typeof (bmp as ImageBitmap).close === 'function') (bmp as ImageBitmap).close()
}

function defaultRender(index: number, page?: GeneratedPage): PageBitmap {
  if (!page) throw new Error(`no page data for index ${index}`)
  const canvas = new OffscreenCanvas(PAGE_W, PAGE_H)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable for page raster')
  drawPageInk(ctx, page)
  return canvas
}
```

- [x] **Step 4: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Update any older `pageRenderer` test still passing a `GeneratedPage` to `get`.

- [x] **Step 5: Commit**

```bash
git add src/data/pageRenderer.ts tests/data/pageRenderer.test.ts
git commit -m "feat(data): async page rasters with post-eviction leak guard"
```

---

### Task 9: DocumentSource implementations

Ties geometry, rasters, and streaming together behind one interface, with both documents implementing it.

**Files:**
- Create: `src/data/document.ts`
- Create: `src/data/funsd/source.ts`
- Create: `src/data/synthetic/source.ts`
- Create: `src/stream/funsdSource.ts`
- Modify: `src/stream/source.ts` (widen `StreamEvent`)
- Modify: `src/stream/mockSource.ts` (emit urls, not nodes)
- Create: `tests/data/document.test.ts`

**Interfaces:**
- Consumes: `PageGeometry`/`uniformGeometry`/`stackedGeometry` (Task 2), `Manifest` (Task 1), `PageBitmap` (Task 8).
- Produces:
  - `StreamEvent` becomes `| { type: 'page'; pageIndex: number; url: string } | { type: 'done' }`
  - `interface DocumentSource { readonly id: 'funsd' | 'synthetic'; readonly pageCount: number; geometry(): Promise<PageGeometry>; raster(page: number): Promise<PageBitmap>; createStream(): StreamSource }`
  - `createFunsdDocument(): Promise<DocumentSource>`
  - `createSyntheticDocument(pageCount: number, seed: number): DocumentSource`

- [x] **Step 1: Widen `StreamEvent`**

`src/stream/source.ts`:

```ts
export type StreamEvent =
  | { type: 'page'; pageIndex: number; url: string }
  | { type: 'done' }

export interface StreamSource {
  start(onEvent: (e: StreamEvent) => void): void
  stop(): void
  readonly connected: boolean
}
```

`MockStreamSource` now emits `url: \`synthetic://page/${pageIndex}?seed=${this.seed}\`` instead of calling `serializeGeneratedPage`. Its shuffle and jitter stay exactly as they are.

- [x] **Step 2: Write the failing test**

`tests/data/document.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSyntheticDocument } from '@/data/synthetic/source'
import { createFunsdDocument } from '@/data/funsd/source'
import { PAGE_GAP } from '@/data/generator'

describe('synthetic document', () => {
  it('reports its page count and uniform geometry', async () => {
    const doc = createSyntheticDocument(100, 1)
    expect(doc.id).toBe('synthetic')
    expect(doc.pageCount).toBe(100)
    const g = await doc.geometry()
    expect(g.count).toBe(100)
  })

  it('streams every page exactly once, out of order', async () => {
    const doc = createSyntheticDocument(20, 1)
    const stream = doc.createStream()
    const seen: number[] = []
    stream.start((e) => { if (e.type === 'page') seen.push(e.pageIndex) })
    await vi.waitFor(() => expect(seen).toHaveLength(20), { timeout: 5000 })
    expect([...seen].sort((a, b) => a - b)).toEqual([...Array(20).keys()])
    expect(seen).not.toEqual([...Array(20).keys()])
    stream.stop()
  })
})

describe('funsd document', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ pages: [{ id: 'a', w: 754, h: 1000 }, { id: 'b', w: 802, h: 1000 }] }),
    })))
  })

  it('stacks pages at their manifest sizes', async () => {
    const doc = await createFunsdDocument()
    expect(doc.pageCount).toBe(2)
    const g = await doc.geometry()
    const out = new Float32Array(4)
    g.origin(0, out); expect([out[2], out[3]]).toEqual([754, 1000])
    g.origin(1, out); expect(out[1]).toBe(1000 + PAGE_GAP)
  })

  it('streams annotation urls, not node payloads', async () => {
    const doc = await createFunsdDocument()
    const stream = doc.createStream()
    const urls: string[] = []
    stream.start((e) => { if (e.type === 'page') urls.push(e.url) })
    await vi.waitFor(() => expect(urls).toHaveLength(2), { timeout: 5000 })
    expect(urls.every((u) => u.startsWith('/funsd/annotations/'))).toBe(true)
    stream.stop()
  })
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/data/document.test.ts`
Expected: FAIL — cannot resolve the source modules.

- [x] **Step 4: Write `src/data/document.ts`**

```ts
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
```

- [x] **Step 5: Write `src/data/synthetic/source.ts`**

```ts
import { generateDocument, PAGE_GAP, PAGE_H, PAGE_W } from '@/data/generator'
import { uniformGeometry } from '@/data/geometry'
import { drawPageInk, type PageBitmap } from '@/data/pageRenderer'
import { MockStreamSource } from '@/stream/mockSource'
import type { DocumentSource } from '@/data/document'

export function createSyntheticDocument(pageCount: number, seed: number): DocumentSource {
  const doc = generateDocument(pageCount, seed)
  return {
    id: 'synthetic',
    pageCount,
    async geometry() {
      return uniformGeometry(pageCount, PAGE_W, PAGE_H, PAGE_GAP)
    },
    async raster(page) {
      const canvas = new OffscreenCanvas(PAGE_W, PAGE_H)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2d context unavailable for page raster')
      drawPageInk(ctx, doc.pages[page])
      return canvas as PageBitmap
    },
    createStream() {
      return new MockStreamSource(pageCount, seed)
    },
  }
}
```

- [x] **Step 6: Write `src/data/funsd/source.ts` and `src/stream/funsdSource.ts`**

`src/stream/funsdSource.ts` — the same shuffle-and-jitter emitter as `MockStreamSource`, but yielding annotation urls:

```ts
import { shuffledPages } from './mockSource'
import type { StreamEvent, StreamSource } from './source'

/** Replays the corpus out of order, as a live extraction feed would arrive. */
export class FunsdStreamSource implements StreamSource {
  private timers: number[] = []
  private stopped = false

  constructor(
    private readonly ids: string[],
    private readonly seed = 1,
  ) {}

  get connected(): boolean {
    return !this.stopped
  }

  start(onEvent: (e: StreamEvent) => void): void {
    this.stopped = false
    let t = 0
    for (const pageIndex of shuffledPages(this.ids.length, this.seed)) {
      t += 8 + ((pageIndex * 37) % 40)
      this.timers.push(
        setTimeout(() => {
          if (this.stopped) return
          onEvent({
            type: 'page',
            pageIndex,
            url: `/funsd/annotations/${this.ids[pageIndex]}.json`,
          })
        }, t) as unknown as number,
      )
    }
    this.timers.push(
      setTimeout(() => {
        if (!this.stopped) onEvent({ type: 'done' })
      }, t + 40) as unknown as number,
    )
  }

  stop(): void {
    this.stopped = true
    for (const id of this.timers) clearTimeout(id)
    this.timers.length = 0
  }
}
```

`src/data/funsd/source.ts`:

```ts
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
```

- [x] **Step 7: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat(data): DocumentSource seam with FUNSD and synthetic implementations"
```

---

### Task 10: Session wiring and the document toggle

Makes the app actually load either document, and proves the switch does not leak.

**Files:**
- Modify: `src/app/session.ts` (accept a `DocumentSource`, drop `generateDocument`, drop `queueIngest`)
- Modify: `src/App.tsx` (add the `Select`)
- Create: `src/components/DocumentPicker.tsx`
- Create: `tests/app/session.test.ts`

**Interfaces:**
- Consumes: `DocumentSource`, `createFunsdDocument`, `createSyntheticDocument` (Task 9).
- Produces: `new Session(canvas, doc: DocumentSource)`; `Session.ready: Promise<void>`.

- [x] **Step 1: Write the failing test**

`tests/app/session.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { Session } from '@/app/session'
import { createSyntheticDocument } from '@/data/synthetic/source'

function canvas() {
  const el = document.createElement('canvas')
  el.getBoundingClientRect = () => ({ width: 800, height: 600, top: 0, left: 0 }) as DOMRect
  return el
}

describe('Session lifecycle', () => {
  it('constructs and disposes 20 times without growing listeners', async () => {
    const before = { add: 0, remove: 0 }
    const origAdd = window.addEventListener.bind(window)
    const origRemove = window.removeEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((...a) => { before.add++; return origAdd(...a) })
    vi.spyOn(window, 'removeEventListener').mockImplementation((...a) => { before.remove++; return origRemove(...a) })

    for (let i = 0; i < 20; i++) {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      s.dispose()
    }

    // Every listener a session adds must come back off on dispose.
    expect(before.remove).toBe(before.add)
    vi.restoreAllMocks()
  })

  it('drops page rasters on dispose', async () => {
    const s = new Session(canvas(), createSyntheticDocument(4, 1))
    await s.ready
    s.dispose()
    expect(s.engine.pageLayer.cache.size).toBe(0)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/app/session.test.ts`
Expected: FAIL — `Session` still takes `(canvas, pageCount, seed)`.

- [x] **Step 3: Rewire `Session`**

Change the constructor to `constructor(canvas: HTMLCanvasElement, doc: DocumentSource)`. Delete the `generateDocument` call and the whole `queueIngest` method — pages now arrive **only** via the stream, which is the honest model and removes the duplicate ingest path. Add:

```ts
  readonly ready: Promise<void>
```

resolved once `doc.geometry()` returns and the engine has its geometry. Point the page cache's render function at `doc.raster`:

```ts
    this.engine.setPageRenderer((index) => doc.raster(index), () => this.engine.requestDraw())
```

In `connectStream`, replace `createStreamSource({...})` with `doc.createStream()`, and in the drain loop replace `this.worker.ingestPage(...)` + `applyPageUpdate(...)` with:

```ts
        this.geometry.origin(e.pageIndex, this.pageRect)
        this.worker.ingestUrl(e.pageIndex, e.url, this.pageRect[0], this.pageRect[1])
```

Node arrays and edges now arrive through the existing `worker.onPageIngested` subscription — append the returned typed arrays into `this.nodes` and `this.baseEdges`, set `orderDirty = true`, and bump `status.pagesReceived` there instead.

- [x] **Step 4: Add the picker**

`src/components/DocumentPicker.tsx`:

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type DocumentId = 'funsd' | 'synthetic'

export function DocumentPicker({
  value,
  onChange,
}: {
  value: DocumentId
  onChange: (id: DocumentId) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as DocumentId)}>
      <SelectTrigger size="sm" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="funsd">Real · FUNSD · 199pp · 41k boxes</SelectItem>
        <SelectItem value="synthetic">Stress · 100pp · 10k boxes</SelectItem>
      </SelectContent>
    </Select>
  )
}
```

If `src/components/ui/select.tsx` lacks any of these exports, run `pnpm dlx shadcn@latest add select` rather than hand-writing them.

- [x] **Step 5: Wire it into `App.tsx`**

Add `const [docId, setDocId] = useState<DocumentId>('funsd')`, add `docId` to the mount `useEffect` dependency array, and build the document at the top of the effect:

```tsx
    let cancelled = false
    const build = async () => {
      const doc =
        docId === 'funsd' ? await createFunsdDocument() : createSyntheticDocument(100, 1)
      if (cancelled) return
      const session = new Session(canvas, doc)
      // …existing FPS meter + connectStream wiring…
    }
    void build()
    return () => {
      cancelled = true
      // …existing teardown…
      useStore.setState(
        { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
        true,
      )
    }
```

Render `<DocumentPicker value={docId} onChange={setDocId} />` in the header, before `<Toolbar />`.

- [x] **Step 6: Run the suite and the app**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

Run: `pnpm dev`, then in the browser:
- FUNSD loads, real scans appear, boxes overlay them
- switch to Stress — synthetic pages load, node count reaches ~10,000
- switch back — no console errors, memory returns to baseline in DevTools after a manual GC

- [x] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(app): load either document through DocumentSource, add the toggle"
```

---

### Task 11: Documentation and performance evidence

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `CLAUDE.md` (stack line — note the two documents)
- Create: `docs/perf/` (trace exports and screenshots)

- [ ] **Step 1: Capture traces** — NOT DONE. No browser was available to the implementing
  agent to run `pnpm dev`/DevTools. Documented as an open item in `docs/perf/README.md` ("FUNSD
  document — not yet captured") and `ARCHITECTURE.md` §7 instead of fabricating trace files.

With `pnpm dev` running, for **each** document:
1. DevTools → Performance → Record
2. Pan continuously for 5s, then wheel-zoom 10% → 500% → 10%
3. Stop, export the trace to `docs/perf/<docId>-panzoom.json`, screenshot the FPS track to `docs/perf/<docId>-panzoom.png`

Then record a third trace during initial stream ingestion (reload with recording active) to `docs/perf/funsd-ingest.json` — this is the one proving **< 16ms long tasks**, which is 20% of the grade.

- [x] **Step 2: Update `ARCHITECTURE.md`**

Add or revise these sections:
- **Documents** — the two `DocumentSource` implementations, the 41,228/5,312 corpus figures, and the FUNSD licence note (RVL-CDIP derived, non-commercial research use)
- **Viewport transformation & render pipeline** — `PageGeometry` as the single layout source of truth, binary-searched page range
- **Worker communication** — `ingestUrl` and why parsing (both documents') lives in the worker; transferable typed arrays including `edges`
- **Spatial indexing** — unchanged QuadTree, now fed from the worker's own parse
- **Memory & frame rate** — the `PageCache` generation guard, LRU residency, the culled-set overlay loop
- Embed the `docs/perf/` screenshots

- [x] **Step 3: Update `CLAUDE.md`**

Revise the "What this is" paragraph to state that the workspace ships two documents — the 199-page FUNSD corpus (41k boxes, real link graph) and the 100-page/10k synthetic stress document.

- [x] **Step 4: Tick this plan's checkboxes and commit**

```bash
git add ARCHITECTURE.md CLAUDE.md docs/perf plans
git commit -m "docs: architecture notes and performance evidence for FUNSD"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 `PageGeometry` | 2, 3 |
| §1 `DocumentSource` | 9 |
| §1 manifest / asset prep | 1 |
| §2 worker protocol + `ingestUrl` | 5 |
| §2 parse mapping | 4 |
| §2 synthetic through the same path | 5, 9 |
| §3 `EdgeSet` + store state | 6 |
| §3 overlay inversion | 7 |
| §3 tool toggle | 7 |
| §4 async raster + leak guard | 8 |
| §5 UI toggle | 10 |
| §6 testing | 1, 2, 4, 6, 7, 8, 10 |
| §7 perf evidence | 11 |

No gaps.

**Placeholder scan:** no TBDs; every code step carries real code.

**Type consistency:** `PageCache.ensure(index, page?)`/`get(index)` are introduced in Task 3 and completed in Task 8 — Task 3 says so explicitly. `PageIngested.edges: Int32Array` is defined in Task 5 and consumed in Tasks 7 and 10. `OrderOverlay.setGraph` (Task 7) replaces `setSequence` and is the only name used downstream. `StreamEvent` carries `url` from Task 9 onward; Task 5's worker handler already expects that shape, so Tasks 5–9 must land in order.
