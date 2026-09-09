# Spatial Canvas Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A HITL document layout repair workspace that renders 100 synthetic scanned pages with ~10,000 bounding boxes at 60 FPS, ingests an out-of-order SSE stream without blocking the main thread, and supports box / reading-order / table editing with ≥50-level undo.

**Architecture:** Four isolated units — a plain-TS Canvas2D engine owning the transform and frame loop, a Web Worker owning parsing and a QuadTree spatial index, a Zustand+Immer store owning editable state and patch-based history, and React as chrome only. Nodes travel as parallel typed arrays so the worker boundary is a transfer rather than a structured clone, and the draw loop is allocation-free.

**Tech Stack:** Vite 8 · React 19 · TypeScript · Tailwind 4 · shadcn/ui (radix-vega, stone) · Zustand · Immer · native Web Workers · Vitest · Playwright · Node http (dev SSE server)

**Spec:** `docs/superpowers/specs/2026-09-10-spatial-canvas-engine-design.md`
**Brief:** `docs/ASSIGNMENT.md`

## Commit convention

Commit messages for this plan are plain sequential WIP markers — `WIP1`, `WIP2`, `WIP3`, … —
one per task step that says "Commit". No conventional-commit prefixes, no body, no
`Co-Authored-By` trailer. Where a task below shows a `git commit -m "feat(...): ..."`
example, use the next `WIP<n>` instead.

## Global Constraints

- **No DOM overlays for boxes.** All 10k boxes render into one `<canvas>` via Canvas2D. A `<div>` per box fails the brief.
- **Zoom range 0.1–5.0** (10%–500%), zoom anchored on cursor.
- **60 FPS** sustained during continuous pan/zoom with 10,000 boxes.
- **< 16ms** main-thread long tasks during SSE ingestion.
- **< 2ms** click-to-selection hit-test across 10,000 nodes.
- **≥ 50** undo levels (implemented as 100).
- **Zero heap growth** across repeated load/undo/redo cycles.
- No allocations inside the frame loop — no `.map`/`.filter`/object literals per box per frame.
- Path alias `@/` → `src/`. Merge classes with `cn()` from `@/lib/utils`.
- Dark-first, theme tokens only (`bg-background`, `border-border`, …), no hex literals.
- Package manager is **pnpm**. UI primitives via `pnpm dlx shadcn@latest add <name>` — never hand-written.
- Commit after every task. Conventional commit prefixes (`feat:`, `test:`, `perf:`, `docs:`).

## File Structure

```
src/
  engine/
    viewport.ts        # Viewport type + world↔screen math + zoomAt. Pure, no DOM.
    canvas.ts          # DPR sizing, context acquisition, resize observation.
    engine.ts          # CanvasEngine class: rAF loop, layer orchestration, dispose.
    layers/
      pages.ts         # page raster drawing + bitmap cache/eviction
      boxes.ts         # batched box stroking, grouped by style
      overlays.ts      # reading-order arrows, table mesh
      hud.ts           # selection handles, snap guides
    input.ts           # pointer/wheel → world coords → active tool
    bucketGrid.ts      # coarse main-thread grid for per-frame culling
  worker/
    index.worker.ts    # worker entry: message router
    quadtree.ts        # QuadTree implementation
    protocol.ts        # shared message types (imported by both threads)
    client.ts          # main-thread wrapper: typed postMessage + reqId promises
  data/
    nodes.ts           # NodeArrays typed-array container + accessors
    generator.ts       # seeded synthetic document generator
    pageRenderer.ts    # draws synthetic page ink to an OffscreenCanvas
  store/
    store.ts           # Zustand store + Immer patch middleware
    history.ts         # undo/redo ring buffer over patches
    merge.ts           # dirty-node shielded stream application
  stream/
    source.ts          # SSESource interface + selector
    sseSource.ts       # real EventSource client
    mockSource.ts      # in-app emitter fallback
  tools/
    types.ts           # Tool state-machine interface
    selectTool.ts      # select / move / resize + snapping
    orderTool.ts       # reading-order re-linking
    tableTool.ts       # table mesh dividers (6b: split/merge)
  components/          # React chrome: Toolbar, TreeView, PageRail, StatusBar
  App.tsx
server/
  sse.mjs              # dev SSE endpoint
tests/                 # Vitest unit tests mirroring src/
e2e/                   # Playwright smoke test
```

---

### Task 1: Viewport transform math

Pure functions, no DOM. This is the foundation everything else builds on and the thing the interview will probe hardest.

**Files:**
- Create: `src/engine/viewport.ts`
- Test: `tests/engine/viewport.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Viewport = { scale: number; tx: number; ty: number }`
  - `worldToScreen(vp: Viewport, wx: number, wy: number): [number, number]`
  - `screenToWorld(vp: Viewport, sx: number, sy: number): [number, number]`
  - `zoomAt(vp: Viewport, sx: number, sy: number, factor: number): Viewport`
  - `panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport`
  - `visibleWorldRect(vp: Viewport, cssW: number, cssH: number): { x, y, w, h }`
  - `MIN_SCALE = 0.1`, `MAX_SCALE = 5`

- [x] **Step 1: Install test tooling**

```bash
pnpm add -D vitest @vitest/coverage-v8 jsdom
```

Add to `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
```

- [x] **Step 2: Write the failing tests**

```ts
// tests/engine/viewport.test.ts
import { describe, it, expect } from 'vitest'
import {
  worldToScreen, screenToWorld, zoomAt, panBy, visibleWorldRect,
  MIN_SCALE, MAX_SCALE, type Viewport,
} from '@/engine/viewport'

const vp = (scale = 1, tx = 0, ty = 0): Viewport => ({ scale, tx, ty })

describe('worldToScreen / screenToWorld', () => {
  it('round-trips at many scales and offsets', () => {
    for (const s of [0.1, 0.37, 1, 2.5, 5]) {
      for (const t of [-1000, -13.7, 0, 250]) {
        const v = vp(s, t, -t)
        const [sx, sy] = worldToScreen(v, 123.456, -78.9)
        const [wx, wy] = screenToWorld(v, sx, sy)
        expect(wx).toBeCloseTo(123.456, 6)
        expect(wy).toBeCloseTo(-78.9, 6)
      }
    }
  })

  it('applies scale then translate', () => {
    expect(worldToScreen(vp(2, 10, 20), 5, 5)).toEqual([20, 30])
  })
})

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const before = vp(1, 40, -15)
    const cursor: [number, number] = [317, 209]
    const anchor = screenToWorld(before, ...cursor)
    for (const factor of [1.1, 0.9, 2, 0.5]) {
      const after = zoomAt(before, cursor[0], cursor[1], factor)
      const [sx, sy] = worldToScreen(after, anchor[0], anchor[1])
      expect(sx).toBeCloseTo(cursor[0], 6)
      expect(sy).toBeCloseTo(cursor[1], 6)
    }
  })

  it('clamps to MIN_SCALE and MAX_SCALE', () => {
    expect(zoomAt(vp(MIN_SCALE), 0, 0, 0.01).scale).toBe(MIN_SCALE)
    expect(zoomAt(vp(MAX_SCALE), 0, 0, 100).scale).toBe(MAX_SCALE)
  })

  it('does not drift the anchor when clamped', () => {
    const v = vp(MAX_SCALE, 12, 34)
    const anchor = screenToWorld(v, 100, 100)
    const after = zoomAt(v, 100, 100, 4)
    const [sx, sy] = worldToScreen(after, ...anchor)
    expect(sx).toBeCloseTo(100, 6)
    expect(sy).toBeCloseTo(100, 6)
  })
})

describe('panBy', () => {
  it('translates in screen pixels regardless of scale', () => {
    expect(panBy(vp(3, 0, 0), 10, -5)).toEqual({ scale: 3, tx: 10, ty: -5 })
  })
})

describe('visibleWorldRect', () => {
  it('returns the world rect covering the canvas', () => {
    const r = visibleWorldRect(vp(2, -100, -50), 800, 600)
    expect(r.x).toBeCloseTo(50)
    expect(r.y).toBeCloseTo(25)
    expect(r.w).toBeCloseTo(400)
    expect(r.h).toBeCloseTo(300)
  })
})
```

- [x] **Step 3: Run tests to verify they fail**

Run: `pnpm test tests/engine/viewport.test.ts`
Expected: FAIL — cannot resolve `@/engine/viewport`.

- [x] **Step 4: Implement**

```ts
// src/engine/viewport.ts
export type Viewport = { scale: number; tx: number; ty: number }

export const MIN_SCALE = 0.1
export const MAX_SCALE = 5

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/** world → screen (CSS px): p_screen = p_world * scale + t */
export function worldToScreen(vp: Viewport, wx: number, wy: number): [number, number] {
  return [wx * vp.scale + vp.tx, wy * vp.scale + vp.ty]
}

/** screen (CSS px) → world */
export function screenToWorld(vp: Viewport, sx: number, sy: number): [number, number] {
  return [(sx - vp.tx) / vp.scale, (sy - vp.ty) / vp.scale]
}

/**
 * Zoom about a screen point. Solving for the translate that keeps the world
 * point under the cursor fixed:
 *   sx = wx * s  + tx   →   wx = (sx - tx) / s
 *   sx = wx * s' + tx'  →   tx' = sx - wx * s'
 */
export function zoomAt(vp: Viewport, sx: number, sy: number, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor)
  if (scale === vp.scale) return vp
  const [wx, wy] = screenToWorld(vp, sx, sy)
  return { scale, tx: sx - wx * scale, ty: sy - wy * scale }
}

export function panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { scale: vp.scale, tx: vp.tx + dxScreen, ty: vp.ty + dyScreen }
}

export function visibleWorldRect(vp: Viewport, cssW: number, cssH: number) {
  const [x, y] = screenToWorld(vp, 0, 0)
  return { x, y, w: cssW / vp.scale, h: cssH / vp.scale }
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm test tests/engine/viewport.test.ts`
Expected: PASS, all cases.

- [x] **Step 6: Commit**

```bash
git add vitest.config.ts package.json pnpm-lock.yaml src/engine/viewport.ts tests/engine/viewport.test.ts
git commit -m "feat(engine): viewport transform math with zoom-to-cursor"
```

---

### Task 2: Node storage as typed arrays

The representation that makes the worker boundary cheap and the draw loop allocation-free.

**Files:**
- Create: `src/data/nodes.ts`
- Test: `tests/data/nodes.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Rect = { x: number; y: number; w: number; h: number }` — the shared geometry type, imported by every later task
  - `enum NodeType { Paragraph=0, Line=1, Cell=2, KeyValue=3, Figure=4 }`
  - `const FLAG_DIRTY = 1, FLAG_SELECTED = 2, FLAG_HIDDEN = 4`
  - `type NodeArrays = { count, capacity, coords: Float32Array, ids: Uint32Array, pages: Uint16Array, types: Uint8Array, parents: Int32Array, order: Int32Array, flags: Uint8Array }`
  - `createNodeArrays(capacity: number): NodeArrays`
  - `pushNode(a: NodeArrays, n: { id, page, x, y, w, h, type, parent, order }): number` — returns index, grows by 2× when full
  - `getRect(a: NodeArrays, i: number, out: Float32Array): void` — writes x,y,w,h into `out`, allocation-free
  - `indexOfId(a: NodeArrays, id: number): number`
  - `transferables(a: NodeArrays): ArrayBuffer[]`

- [x] **Step 1: Write the failing tests**

```ts
// tests/data/nodes.test.ts
import { describe, it, expect } from 'vitest'
import {
  createNodeArrays, pushNode, getRect, indexOfId, NodeType, FLAG_DIRTY,
} from '@/data/nodes'

const mk = (id: number, x = 0) => ({
  id, page: 0, x, y: 1, w: 2, h: 3, type: NodeType.Line, parent: -1, order: id,
})

describe('NodeArrays', () => {
  it('stores and reads back a node', () => {
    const a = createNodeArrays(4)
    const i = pushNode(a, mk(7, 10))
    expect(i).toBe(0)
    expect(a.count).toBe(1)
    const out = new Float32Array(4)
    getRect(a, i, out)
    expect(Array.from(out)).toEqual([10, 1, 2, 3])
    expect(a.ids[0]).toBe(7)
  })

  it('grows past initial capacity preserving contents', () => {
    const a = createNodeArrays(2)
    for (let n = 0; n < 10; n++) pushNode(a, mk(n, n))
    expect(a.count).toBe(10)
    expect(a.capacity).toBeGreaterThanOrEqual(10)
    const out = new Float32Array(4)
    getRect(a, 9, out)
    expect(out[0]).toBe(9)
    expect(a.ids[9]).toBe(9)
  })

  it('finds an index by id and returns -1 when absent', () => {
    const a = createNodeArrays(4)
    pushNode(a, mk(100)); pushNode(a, mk(200))
    expect(indexOfId(a, 200)).toBe(1)
    expect(indexOfId(a, 999)).toBe(-1)
  })

  it('getRect allocates nothing (reuses the out array)', () => {
    const a = createNodeArrays(2)
    pushNode(a, mk(1))
    const out = new Float32Array(4)
    getRect(a, 0, out)
    const same = out
    getRect(a, 0, out)
    expect(out).toBe(same)
  })

  it('flags are independent bits', () => {
    const a = createNodeArrays(2)
    const i = pushNode(a, mk(1))
    a.flags[i] |= FLAG_DIRTY
    expect(a.flags[i] & FLAG_DIRTY).toBeTruthy()
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/data/nodes.test.ts` → FAIL, module not found.

- [x] **Step 3: Implement `src/data/nodes.ts`**

Implement exactly the interface above. Notes for the implementer:
- `coords` holds 4 floats per node at offset `i * 4`.
- Growth: allocate new arrays at `capacity * 2`, `.set()` the old ones in, replace the fields on the same `NodeArrays` object (callers hold the container, not the arrays).
- `indexOfId` uses a lazily built `Map<number, number>` cached on the container and invalidated on push; a linear scan over 10k on every click would blow the 2ms budget.
- `transferables` returns the `.buffer` of every typed array, for `postMessage`'s transfer list.

- [x] **Step 4: Run tests to verify they pass** → `pnpm test tests/data/nodes.test.ts`

- [x] **Step 5: Commit**

```bash
git add src/data/nodes.ts tests/data/nodes.test.ts
git commit -m "feat(data): typed-array node storage"
```

---

### Task 3: Seeded synthetic document generator

Produces both the box nodes and the page ink instructions from one seed, so boxes align with text by construction. This is also the Stress Test Document deliverable.

**Files:**
- Create: `src/data/generator.ts`
- Test: `tests/data/generator.test.ts`

**Interfaces:**
- Consumes: `NodeArrays`, `NodeType` (Task 2)
- Produces:
  - `const PAGE_W = 1240, PAGE_H = 1754` (A4 @ 150dpi), `const PAGE_GAP = 40`
  - `type Block = { kind: 'heading'|'paragraph'|'table'|'figure'|'caption'|'kv'; x, y, w, h: number; lines?: { x, y, w, h }[]; cells?: { x, y, w, h, row, col }[] }`
  - `type GeneratedPage = { index: number; blocks: Block[]; nodeCount: number }`
  - `generatePage(pageIndex: number, seed: number): GeneratedPage`
  - `appendPageNodes(a: NodeArrays, page: GeneratedPage, nextId: { v: number }): void` — world coords = page-local + `pageOrigin(page.index)`
  - `pageOrigin(pageIndex: number): [number, number]` — vertical stack, `y = index * (PAGE_H + PAGE_GAP)`
  - `generateDocument(pageCount: number, seed: number): { nodes: NodeArrays; pages: GeneratedPage[] }`

- [x] **Step 1: Write the failing tests**

```ts
// tests/data/generator.test.ts
import { describe, it, expect } from 'vitest'
import { generatePage, generateDocument, pageOrigin, PAGE_W, PAGE_H } from '@/data/generator'

describe('generator', () => {
  it('is deterministic for a given seed', () => {
    expect(JSON.stringify(generatePage(3, 42))).toBe(JSON.stringify(generatePage(3, 42)))
  })

  it('differs across pages and across seeds', () => {
    expect(JSON.stringify(generatePage(3, 42))).not.toBe(JSON.stringify(generatePage(4, 42)))
    expect(JSON.stringify(generatePage(3, 42))).not.toBe(JSON.stringify(generatePage(3, 43)))
  })

  it('keeps every block inside the page bounds', () => {
    for (let p = 0; p < 20; p++) {
      for (const b of generatePage(p, 7).blocks) {
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.y).toBeGreaterThanOrEqual(0)
        expect(b.x + b.w).toBeLessThanOrEqual(PAGE_W)
        expect(b.y + b.h).toBeLessThanOrEqual(PAGE_H)
      }
    }
  })

  it('never overlaps sibling blocks vertically', () => {
    const blocks = generatePage(1, 7).blocks.slice().sort((a, b) => a.y - b.y)
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].y).toBeGreaterThanOrEqual(blocks[i - 1].y + blocks[i - 1].h - 0.001)
    }
  })

  it('stacks pages vertically without overlap', () => {
    expect(pageOrigin(0)[1]).toBe(0)
    expect(pageOrigin(1)[1]).toBeGreaterThanOrEqual(PAGE_H)
  })

  it('produces ~10k nodes across 100 pages', () => {
    const { nodes } = generateDocument(100, 1)
    expect(nodes.count).toBeGreaterThan(8000)
    expect(nodes.count).toBeLessThan(14000)
  })

  it('gives every node a unique id and a valid parent', () => {
    const { nodes } = generateDocument(5, 1)
    const seen = new Set<number>()
    for (let i = 0; i < nodes.count; i++) {
      expect(seen.has(nodes.ids[i])).toBe(false)
      seen.add(nodes.ids[i])
      const p = nodes.parents[i]
      expect(p === -1 || p < nodes.count).toBe(true)
    }
  })
})
```

- [x] **Step 2: Run to verify failure** → `pnpm test tests/data/generator.test.ts`

- [x] **Step 3: Implement**

Implementer notes:
- **RNG:** mulberry32 seeded with `seed * 73856093 ^ pageIndex * 19349663` so pages are independent but reproducible.

```ts
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
```

- **Layout:** margin 90px. Walk `y` downward emitting blocks until the page is full:
  title (page 0 only), heading, 6–10 paragraphs, occasionally a 2-column stretch, a table
  every ~3 pages, a figure + caption every ~4 pages, a 4–6 row key-value group every ~5 pages.
- **Paragraph:** 4–12 line boxes, line height 22, last line 40–90% width, others 92–100%.
- **Table:** 4–9 rows × 3–6 cols, cell boxes with `row`/`col` recorded.
- **Node emission:** block → node (type by kind), each line/cell → child node with `parent`
  set to the block's index. `order` increments in emission sequence (that IS the reading order).
- Target ~100 nodes/page so 100 pages ≈ 10,000.

- [x] **Step 4: Verify tests pass**

- [x] **Step 5: Commit**

```bash
git add src/data/generator.ts tests/data/generator.test.ts
git commit -m "feat(data): seeded synthetic document generator"
```

---

### Task 4: Synthetic page renderer

Draws a generated page's ink to an offscreen canvas, with an LRU bitmap cache so 100 pages never sit decoded in memory at once.

**Files:**
- Create: `src/data/pageRenderer.ts`
- Test: `tests/data/pageRenderer.test.ts`

**Interfaces:**
- Consumes: `GeneratedPage`, `PAGE_W`, `PAGE_H` (Task 3)
- Produces:
  - `class PageCache { constructor(maxPages: number); get(page: GeneratedPage): ImageBitmap | OffscreenCanvas | null; ensure(page: GeneratedPage): void; evictOutside(from: number, to: number): void; get size(): number; dispose(): void }`
  - `drawPageInk(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, page: GeneratedPage): void`

- [x] **Step 1: Write the failing tests**

Test the cache policy, not the pixels (pixel output isn't meaningfully assertable and jsdom has no canvas). Use a fake renderer injected into `PageCache` so tests stay environment-free.

```ts
// tests/data/pageRenderer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PageCache } from '@/data/pageRenderer'

const fakePage = (index: number) => ({ index, blocks: [], nodeCount: 0 })

describe('PageCache', () => {
  it('renders on first ensure and reuses afterwards', () => {
    const render = vi.fn(() => ({} as never))
    const c = new PageCache(3, render)
    c.ensure(fakePage(0)); c.ensure(fakePage(0))
    expect(render).toHaveBeenCalledTimes(1)
    expect(c.get(fakePage(0))).not.toBeNull()
  })

  it('never holds more than maxPages', () => {
    const c = new PageCache(3, () => ({} as never))
    for (let i = 0; i < 10; i++) c.ensure(fakePage(i))
    expect(c.size).toBeLessThanOrEqual(3)
  })

  it('evicts pages outside the visible range', () => {
    const c = new PageCache(10, () => ({} as never))
    for (let i = 0; i < 8; i++) c.ensure(fakePage(i))
    c.evictOutside(5, 7)
    expect(c.get(fakePage(0))).toBeNull()
    expect(c.get(fakePage(6))).not.toBeNull()
  })

  it('drops everything on dispose', () => {
    const c = new PageCache(4, () => ({} as never))
    c.ensure(fakePage(1)); c.dispose()
    expect(c.size).toBe(0)
  })
})
```

- [x] **Step 2: Run to verify failure**

- [x] **Step 3: Implement**

- `PageCache(maxPages, renderFn = defaultRender)` — second param injectable for tests.
- `Map<number, Bitmap>` in insertion order = LRU; `ensure` deletes+reinserts on hit.
- `defaultRender` creates an `OffscreenCanvas(PAGE_W, PAGE_H)` and calls `drawPageInk`.
- `drawPageInk`: paper fill `#faf8f4`, subtle vignette, blocks as grey bars (`#3a3a3a` at
  0.82 alpha, height ~0.62 of line height, 1px radius), table rules as thin lines, figure as
  a light grey rect with a diagonal, ~0.3° rotation on the whole page for scan feel.
- `dispose()` calls `.close()` on any `ImageBitmap` before clearing — this is the leak the
  memory benchmark looks for.

- [x] **Step 4: Verify tests pass**

- [x] **Step 5: Commit**

```bash
git add src/data/pageRenderer.ts tests/data/pageRenderer.test.ts
git commit -m "feat(data): synthetic page renderer with LRU bitmap cache"
```

---

### Task 5: QuadTree

**Files:**
- Create: `src/worker/quadtree.ts`
- Test: `tests/worker/quadtree.test.ts`

**Interfaces:**
- Consumes: nothing (operates on raw rect arrays so it is worker-safe)
- Produces:
  - `class QuadTree { constructor(bounds: {x,y,w,h}, maxDepth = 8, bucketSize = 16); insert(id: number, x, y, w, h: number): void; bulkLoad(ids: Uint32Array, coords: Float32Array, count: number): void; queryPoint(x, y: number, out: number[]): number[]; queryRect(x, y, w, h: number, out: number[]): number[]; remove(id: number, x, y, w, h: number): boolean; update(id, ox, oy, ow, oh, nx, ny, nw, nh: number): void; get size(): number; clear(): void }`

- [x] **Step 1: Write the failing tests, including a brute-force oracle**

```ts
// tests/worker/quadtree.test.ts
import { describe, it, expect } from 'vitest'
import { QuadTree } from '@/worker/quadtree'

const BOUNDS = { x: 0, y: 0, w: 10000, h: 100000 }

function makeRects(n: number, seed = 1) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const ids = new Uint32Array(n)
  const coords = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    ids[i] = i + 1
    coords[i * 4] = rnd() * 9800
    coords[i * 4 + 1] = rnd() * 99000
    coords[i * 4 + 2] = 5 + rnd() * 180
    coords[i * 4 + 3] = 5 + rnd() * 40
  }
  return { ids, coords }
}

const bruteRect = (ids: Uint32Array, c: Float32Array, n: number, x: number, y: number, w: number, h: number) => {
  const r: number[] = []
  for (let i = 0; i < n; i++) {
    const [bx, by, bw, bh] = [c[i*4], c[i*4+1], c[i*4+2], c[i*4+3]]
    if (bx < x + w && bx + bw > x && by < y + h && by + bh > y) r.push(ids[i])
  }
  return r.sort((a, b) => a - b)
}

const brutePoint = (ids: Uint32Array, c: Float32Array, n: number, x: number, y: number) => {
  const r: number[] = []
  for (let i = 0; i < n; i++) {
    const [bx, by, bw, bh] = [c[i*4], c[i*4+1], c[i*4+2], c[i*4+3]]
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) r.push(ids[i])
  }
  return r.sort((a, b) => a - b)
}

describe('QuadTree', () => {
  it('matches brute force on rect queries', () => {
    const n = 3000
    const { ids, coords } = makeRects(n)
    const qt = new QuadTree(BOUNDS)
    qt.bulkLoad(ids, coords, n)
    for (const q of [[0,0,500,500],[4000,50000,1200,900],[0,0,10000,100000],[9990,99990,5,5]]) {
      const got = qt.queryRect(q[0], q[1], q[2], q[3], []).slice().sort((a,b)=>a-b)
      expect(got).toEqual(bruteRect(ids, coords, n, q[0], q[1], q[2], q[3]))
    }
  })

  it('matches brute force on point queries', () => {
    const n = 2000
    const { ids, coords } = makeRects(n, 9)
    const qt = new QuadTree(BOUNDS)
    qt.bulkLoad(ids, coords, n)
    for (let t = 0; t < 200; t++) {
      const x = (t * 137) % 10000, y = (t * 4409) % 100000
      const got = qt.queryPoint(x, y, []).slice().sort((a,b)=>a-b)
      expect(got).toEqual(brutePoint(ids, coords, n, x, y))
    }
  })

  it('supports incremental insert matching bulk load', () => {
    const n = 800
    const { ids, coords } = makeRects(n, 3)
    const bulk = new QuadTree(BOUNDS); bulk.bulkLoad(ids, coords, n)
    const inc = new QuadTree(BOUNDS)
    for (let i = 0; i < n; i++) inc.insert(ids[i], coords[i*4], coords[i*4+1], coords[i*4+2], coords[i*4+3])
    const a = bulk.queryRect(100, 100, 3000, 3000, []).sort((x,y)=>x-y)
    const b = inc.queryRect(100, 100, 3000, 3000, []).sort((x,y)=>x-y)
    expect(b).toEqual(a)
  })

  it('removes and updates', () => {
    const qt = new QuadTree(BOUNDS)
    qt.insert(1, 10, 10, 20, 20)
    expect(qt.queryPoint(15, 15, [])).toContain(1)
    qt.update(1, 10, 10, 20, 20, 500, 500, 20, 20)
    expect(qt.queryPoint(15, 15, [])).not.toContain(1)
    expect(qt.queryPoint(505, 505, [])).toContain(1)
    expect(qt.remove(1, 500, 500, 20, 20)).toBe(true)
    expect(qt.size).toBe(0)
  })

  it('answers 10k-node point queries in well under 2ms', () => {
    const n = 10000
    const { ids, coords } = makeRects(n, 5)
    const qt = new QuadTree(BOUNDS)
    qt.bulkLoad(ids, coords, n)
    const out: number[] = []
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) qt.queryPoint((i * 977) % 10000, (i * 3571) % 100000, out)
    const perQuery = (performance.now() - t0) / 1000
    expect(perQuery).toBeLessThan(0.5)
  })

  it('clear empties the tree', () => {
    const qt = new QuadTree(BOUNDS)
    qt.insert(1, 0, 0, 5, 5); qt.clear()
    expect(qt.size).toBe(0)
    expect(qt.queryPoint(1, 1, [])).toEqual([])
  })
})
```

- [x] **Step 2: Run to verify failure**

- [x] **Step 3: Implement**

Implementer notes:
- Rects can straddle child boundaries. Store an item in a node when it does not fit wholly
  within one child — the standard "loose parent" rule. Do **not** duplicate into multiple
  children; duplication breaks `remove` and inflates results.
- Split when a node's own bucket exceeds `bucketSize` and `depth < maxDepth`; on split,
  push down only the items that fit wholly in one child.
- `queryPoint` / `queryRect` take an `out` array and `out.length = 0` it — callers reuse one
  array so the hot path allocates nothing.
- `size` tracks a counter, not a traversal.

- [x] **Step 4: Verify tests pass, including the perf assertion**

- [x] **Step 5: Commit**

```bash
git add src/worker/quadtree.ts tests/worker/quadtree.test.ts
git commit -m "feat(worker): quadtree spatial index verified against brute force"
```

---

### Task 6: Worker protocol and client

**Files:**
- Create: `src/worker/protocol.ts`, `src/worker/index.worker.ts`, `src/worker/client.ts`
- Test: `tests/worker/client.test.ts`

**Interfaces:**
- Consumes: `QuadTree` (Task 5), `NodeArrays` (Task 2), generator (Task 3)
- Produces:
  - `type SerializedNode = { id: number; page: number; x: number; y: number; w: number; h: number; type: number; parent: number; order: number }`
  - `type SerializedPage = { pageIndex: number; nodes: SerializedNode[] }`
  - `type Req = { id: number } & ({ kind: 'init'; bounds: Rect } | { kind: 'ingestPage'; page: SerializedPage } | { kind: 'hitTest'; x: number; y: number } | { kind: 'queryRect'; x, y, w, h: number } | { kind: 'updateNode'; nodeId: number; old: Rect; next: Rect } | { kind: 'reset' })`
  - `type Res = { id: number } & ({ kind: 'ready' } | { kind: 'pageIngested'; pageIndex: number; ids: Uint32Array; coords: Float32Array; types: Uint8Array; parents: Int32Array; order: Int32Array } | { kind: 'hit'; nodeId: number | null } | { kind: 'rect'; ids: Uint32Array } | { kind: 'ok' } | { kind: 'error'; message: string })`
  - `class WorkerClient { constructor(worker: Worker); init(bounds): Promise<void>; hitTest(x, y): Promise<number | null>; queryRect(r): Promise<Uint32Array>; updateNode(...): Promise<void>; onPageIngested(cb: (p: PageIngested) => void): () => void; ingestPage(page): void; reset(): Promise<void>; dispose(): void }`

- [x] **Step 1: Write the failing tests** — drive `WorkerClient` against a fake worker so no real thread is needed.

```ts
// tests/worker/client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WorkerClient } from '@/worker/client'

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  posted: unknown[] = []
  terminated = false
  postMessage(m: never) { this.posted.push(m) }
  terminate() { this.terminated = true }
  reply(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
}

describe('WorkerClient', () => {
  it('resolves a request by matching reqId', async () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const p = c.hitTest(10, 20)
    const sent = w.posted[0] as { id: number }
    w.reply({ id: sent.id, kind: 'hit', nodeId: 42 })
    await expect(p).resolves.toBe(42)
  })

  it('keeps concurrent requests independent', async () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const a = c.hitTest(1, 1), b = c.hitTest(2, 2)
    const [ra, rb] = w.posted as { id: number }[]
    w.reply({ id: rb.id, kind: 'hit', nodeId: 2 })
    w.reply({ id: ra.id, kind: 'hit', nodeId: 1 })
    expect(await a).toBe(1)
    expect(await b).toBe(2)
  })

  it('rejects on an error response', async () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const p = c.hitTest(0, 0)
    w.reply({ id: (w.posted[0] as { id: number }).id, kind: 'error', message: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('delivers unsolicited page events to subscribers and unsubscribes', () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const cb = vi.fn()
    const off = c.onPageIngested(cb)
    w.reply({ id: -1, kind: 'pageIngested', pageIndex: 3, ids: new Uint32Array(0) })
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    w.reply({ id: -1, kind: 'pageIngested', pageIndex: 4, ids: new Uint32Array(0) })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('terminates and rejects pending requests on dispose', async () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const p = c.hitTest(0, 0)
    c.dispose()
    expect(w.terminated).toBe(true)
    await expect(p).rejects.toThrow()
  })
})
```

- [x] **Step 2: Run to verify failure**

- [x] **Step 3: Implement**

- `client.ts`: monotonic `reqId`, `Map<number, {resolve, reject}>`, unsolicited messages
  (`id === -1`) fan out to subscribers. `dispose()` rejects every pending entry then
  terminates — otherwise a teardown mid-flight leaks promises.
- `index.worker.ts`: owns one `QuadTree` plus the parsed `NodeArrays`. On `ingestPage`,
  parse → append → `bulkLoad` that page's rects → post back the page's slices **with a
  transfer list** so nothing is cloned. On `hitTest`, `queryPoint` then pick the topmost
  (smallest area wins, ties broken by higher `order`).
- Vite worker import: `new Worker(new URL('./index.worker.ts', import.meta.url), { type: 'module' })`.

- [x] **Step 4: Verify tests pass**

- [x] **Step 5: Commit**

```bash
git add src/worker tests/worker/client.test.ts
git commit -m "feat(worker): typed worker protocol and request/response client"
```

---

### Task 7: Bucket grid for per-frame culling

The frame loop cannot await the worker, so the main thread keeps a coarse conservative index used only for culling.

**Files:**
- Create: `src/engine/bucketGrid.ts`
- Test: `tests/engine/bucketGrid.test.ts`

**Interfaces:**
- Consumes: `NodeArrays` (Task 2)
- Produces:
  - `class BucketGrid { constructor(cellSize = 512); addPage(pageIndex: number, ids: Uint32Array, coords: Float32Array, indices: Uint32Array): void; query(x, y, w, h: number, out: Uint32Array): number` — writes node **indices** into `out`, returns the count; `clearPage(pageIndex: number): void; clear(): void`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/engine/bucketGrid.test.ts
import { describe, it, expect } from 'vitest'
import { BucketGrid } from '@/engine/bucketGrid'

describe('BucketGrid', () => {
  it('is conservative: never misses an intersecting rect', () => {
    const g = new BucketGrid(100)
    const ids = new Uint32Array([1, 2, 3])
    const coords = new Float32Array([0,0,50,50, 480,480,60,60, 5000,5000,10,10])
    g.addPage(0, ids, coords, new Uint32Array([0, 1, 2]))
    const out = new Uint32Array(64)
    const n = g.query(470, 470, 100, 100, out)
    expect(Array.from(out.slice(0, n))).toContain(1)
  })

  it('excludes far-away rects', () => {
    const g = new BucketGrid(100)
    g.addPage(0, new Uint32Array([1]), new Float32Array([0,0,10,10]), new Uint32Array([0]))
    const out = new Uint32Array(16)
    expect(g.query(9000, 9000, 100, 100, out)).toBe(0)
  })

  it('handles rects spanning many cells', () => {
    const g = new BucketGrid(100)
    g.addPage(0, new Uint32Array([1]), new Float32Array([0,0,1000,1000]), new Uint32Array([0]))
    const out = new Uint32Array(16)
    expect(g.query(900, 900, 10, 10, out)).toBe(1)
  })

  it('clears a single page without touching others', () => {
    const g = new BucketGrid(100)
    g.addPage(0, new Uint32Array([1]), new Float32Array([0,0,10,10]), new Uint32Array([0]))
    g.addPage(1, new Uint32Array([2]), new Float32Array([0,0,10,10]), new Uint32Array([1]))
    g.clearPage(0)
    const out = new Uint32Array(16)
    const n = g.query(0, 0, 20, 20, out)
    expect(Array.from(out.slice(0, n))).toEqual([1])
  })

  it('does not overflow the out array', () => {
    const g = new BucketGrid(100)
    const n = 50
    const ids = new Uint32Array(n), coords = new Float32Array(n * 4), idx = new Uint32Array(n)
    for (let i = 0; i < n; i++) { ids[i] = i + 1; idx[i] = i; coords[i*4+2] = 10; coords[i*4+3] = 10 }
    g.addPage(0, ids, coords, idx)
    const out = new Uint32Array(8)
    expect(g.query(0, 0, 100, 100, out)).toBeLessThanOrEqual(8)
  })

  it('returns each index at most once', () => {
    const g = new BucketGrid(100)
    g.addPage(0, new Uint32Array([1]), new Float32Array([0,0,1000,1000]), new Uint32Array([0]))
    const out = new Uint32Array(64)
    const n = g.query(0, 0, 1000, 1000, out)
    expect(new Set(Array.from(out.slice(0, n))).size).toBe(n)
  })
})
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

- `Map<cellKey, number[]>` where `cellKey = cy * 1e6 + cx`. A rect is pushed into every cell
  it overlaps, so results may contain duplicates across cells — dedupe with a `Uint8Array`
  visit-stamp keyed by node index (reset by bumping a generation counter, not by clearing).
- Track which cells each page touched, so `clearPage` is O(cells touched).
- Never allocate in `query` — `out` is caller-owned and reused every frame.

- [ ] **Step 4: Verify tests pass**

- [ ] **Step 5: Commit**

```bash
git add src/engine/bucketGrid.ts tests/engine/bucketGrid.test.ts
git commit -m "feat(engine): conservative bucket grid for viewport culling"
```

---

### Task 8: Canvas engine — DPR, frame loop, culled box rendering

The first task with visible output, and the one that must be profiled before anything else is built on it.

**Files:**
- Create: `src/engine/canvas.ts`, `src/engine/engine.ts`, `src/engine/layers/boxes.ts`, `src/engine/layers/pages.ts`, `src/engine/input.ts`
- Modify: `src/App.tsx`
- Test: `tests/engine/canvas.test.ts`

**Interfaces:**
- Consumes: viewport (1), nodes (2), generator (3), PageCache (4), BucketGrid (7)
- Produces:
  - `sizeCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): void`
  - `crispOffset(dpr: number): number` — half-device-pixel offset for 1px strokes
  - `class CanvasEngine { constructor(canvas: HTMLCanvasElement); setData(nodes: NodeArrays, pages: GeneratedPage[], grid: BucketGrid): void; get viewport(): Viewport; setViewport(vp: Viewport): void; requestDraw(): void; start(): void; dispose(): void; onFrame(cb: (ms: number) => void): () => void }`

- [ ] **Step 1: Write the failing tests** (pure functions only — the loop is verified by profiling, not unit tests)

```ts
// tests/engine/canvas.test.ts
import { describe, it, expect } from 'vitest'
import { sizeCanvas, crispOffset } from '@/engine/canvas'

const fakeCanvas = () => ({ width: 0, height: 0, style: {} as Record<string, string> })

describe('sizeCanvas', () => {
  it('sizes the backing store by dpr and the element by css px', () => {
    const c = fakeCanvas()
    sizeCanvas(c as never, 800, 600, 2)
    expect(c.width).toBe(1600)
    expect(c.height).toBe(1200)
    expect(c.style.width).toBe('800px')
    expect(c.style.height).toBe('600px')
  })

  it('rounds fractional dpr up to whole device pixels', () => {
    const c = fakeCanvas()
    sizeCanvas(c as never, 801, 601, 1.5)
    expect(Number.isInteger(c.width)).toBe(true)
    expect(Number.isInteger(c.height)).toBe(true)
  })
})

describe('crispOffset', () => {
  it('is half a device pixel in css units', () => {
    expect(crispOffset(1)).toBeCloseTo(0.5)
    expect(crispOffset(2)).toBeCloseTo(0.25)
  })
})
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement the engine**

`canvas.ts`:
```ts
export function sizeCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number) {
  canvas.width = Math.ceil(cssW * dpr)
  canvas.height = Math.ceil(cssH * dpr)
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
}
export const crispOffset = (dpr: number) => 0.5 / dpr
```

`engine.ts` requirements:
- One rAF loop. `requestDraw()` sets `dirty = true`; the loop draws only when dirty, then clears it. Idle frames must cost nothing.
- Per frame: compute `visibleWorldRect` → `grid.query` into a **preallocated** `Uint32Array(8192)` → draw pages for the visible index range → draw boxes.
- `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` once per resize; the viewport transform is applied
  as `ctx.translate(tx, ty); ctx.scale(s, s)` around the box drawing, with `lineWidth = 1 / s`
  so strokes stay 1 CSS px at every zoom.
- `ResizeObserver` on the container, plus a `matchMedia('(resolution: …)')` listener to catch
  monitor changes; both call `sizeCanvas` and `requestDraw`.
- `dispose()` cancels the rAF, disconnects observers, removes listeners, disposes the page cache.
- `onFrame(cb)` reports frame duration — used by the bench harness in Task 15.

`layers/boxes.ts` requirements:
- Group visible indices by style (type + selected/dirty flags) into preallocated index buckets.
- One `beginPath()` per style group, `rect()` per box, single `stroke()`. Do not set
  `strokeStyle` per box.
- Skip boxes whose on-screen size is below ~2px at the current zoom (invisible, costs paint).

`input.ts`: wheel → `zoomAt` (ctrl/⌘+wheel and pinch both map to zoom; plain wheel pans),
pointer drag → `panBy`. All handlers call `requestDraw()` and never draw directly. Use
`{ passive: false }` on wheel and `preventDefault()`.

`App.tsx`: full-screen container, mounts the engine in an effect, loads a 100-page document,
disposes on unmount.

- [ ] **Step 4: Verify tests pass and the app renders**

Run: `pnpm test tests/engine/canvas.test.ts` and `pnpm dev`.
Manually confirm: pages visible, boxes drawn, wheel zooms toward the cursor, drag pans.

- [ ] **Step 5: Profile before going further — this is a gate**

Open DevTools → Performance, record ~10s of continuous pan and zoom over the stress document.
Confirm frames stay ≤16ms. If not, fix it now: check for per-frame allocation, unbatched
strokes, or drawing culled-out boxes. Do not start Task 9 until this passes. Save the trace to
`docs/perf/phase1-pan-zoom.json`.

- [ ] **Step 6: Commit**

```bash
git add src/engine src/App.tsx tests/engine/canvas.test.ts docs/perf
git commit -m "feat(engine): DPR-correct canvas, rAF loop, culled batched box rendering"
```

---

### Task 9: Store with patch-based undo/redo

**Files:**
- Create: `src/store/store.ts`, `src/store/history.ts`
- Test: `tests/store/history.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Edit = { rect?: Rect; label?: string; orderNext?: number | null; deleted?: true }`
  - `type AppState = { edits: Record<number, Edit>; dirtyAt: Record<number, number>; selectedId: number | null; hoveredId: number | null }`
  - `useStore` — Zustand hook
  - `commit(name: string, recipe: (draft: AppState) => void): void` — one undoable transaction
  - `applyStream(recipe: (draft: AppState) => void): void` — applies WITHOUT recording history
  - `undo(): void`, `redo(): void`, `canUndo(): boolean`, `canRedo(): boolean`
  - `beginCoalesce(key: string)` / `endCoalesce()` — merge rapid same-key edits within 300ms
  - `HISTORY_LIMIT = 100`

- [ ] **Step 1: Install deps**

```bash
pnpm add zustand immer
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/store/history.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useStore, commit, applyStream, undo, redo, canUndo, canRedo, HISTORY_LIMIT } from '@/store/store'

const reset = () => useStore.setState({ edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null }, true)

describe('history', () => {
  beforeEach(reset)

  it('undoes and redoes a single edit', () => {
    commit('move', (d) => { d.edits[1] = { rect: { x: 5, y: 5, w: 10, h: 10 } } })
    expect(useStore.getState().edits[1]?.rect?.x).toBe(5)
    undo()
    expect(useStore.getState().edits[1]).toBeUndefined()
    redo()
    expect(useStore.getState().edits[1]?.rect?.x).toBe(5)
  })

  it('supports at least 50 levels', () => {
    for (let i = 0; i < 60; i++) commit('m', (d) => { d.edits[i] = { label: `L${i}` } })
    for (let i = 0; i < 60; i++) undo()
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('caps the stack at HISTORY_LIMIT without corrupting state', () => {
    for (let i = 0; i < HISTORY_LIMIT + 40; i++) commit('m', (d) => { d.edits[i] = { label: 'x' } })
    let n = 0
    while (canUndo() && n < 500) { undo(); n++ }
    expect(n).toBeLessThanOrEqual(HISTORY_LIMIT)
  })

  it('returns to the exact initial state over a randomized sequence', () => {
    const before = JSON.stringify(useStore.getState().edits)
    let s = 12345
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 200; i++) {
      const id = Math.floor(rnd() * 20)
      commit('r', (d) => {
        if (rnd() < 0.4) delete d.edits[id]
        else d.edits[id] = { rect: { x: rnd()*100, y: rnd()*100, w: 10, h: 10 }, label: `n${i}` }
      })
    }
    while (canUndo()) undo()
    expect(JSON.stringify(useStore.getState().edits)).toBe(before)
  })

  it('does not record stream applications in history', () => {
    applyStream((d) => { d.edits[9] = { label: 'from server' } })
    expect(canUndo()).toBe(false)
    expect(useStore.getState().edits[9]?.label).toBe('from server')
  })

  it('clears the redo stack on a new commit after undo', () => {
    commit('a', (d) => { d.edits[1] = { label: 'a' } })
    undo()
    commit('b', (d) => { d.edits[2] = { label: 'b' } })
    expect(canRedo()).toBe(false)
  })

  it('coalesces rapid same-key edits into one entry', () => {
    commit('nudge:1', (d) => { d.edits[1] = { rect: { x: 1, y: 0, w: 4, h: 4 } } })
    commit('nudge:1', (d) => { d.edits[1] = { rect: { x: 2, y: 0, w: 4, h: 4 } } })
    commit('nudge:1', (d) => { d.edits[1] = { rect: { x: 3, y: 0, w: 4, h: 4 } } })
    undo()
    expect(useStore.getState().edits[1]).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run to verify failure**

- [ ] **Step 4: Implement**

- `enablePatches()` from Immer at module load.
- `commit` runs `produceWithPatches`, pushes `{ name, patches, inverse, at }` onto the undo
  ring, clears redo. Coalescing: if the new `name` equals the last entry's and `Date.now() -
  last.at < 300`, concatenate patches onto that entry instead of pushing.
- `applyStream` runs plain `produce` — no patch recording, history untouched.
- Ring buffer of `HISTORY_LIMIT`; dropping the oldest entry must not disturb indices — use a
  plain array with `shift()` at the cap (100 entries; the cost is irrelevant at this rate).

- [ ] **Step 5: Verify tests pass**

- [ ] **Step 6: Commit**

```bash
git add src/store tests/store package.json pnpm-lock.yaml
git commit -m "feat(store): zustand store with immer patch-based undo/redo"
```

---

### Task 10: Box editor tool with snapping

**Files:**
- Create: `src/tools/types.ts`, `src/tools/selectTool.ts`, `src/engine/layers/hud.ts`
- Modify: `src/engine/input.ts`, `src/engine/engine.ts`
- Test: `tests/tools/selectTool.test.ts`

**Interfaces:**
- Consumes: viewport (1), nodes (2), store (9), WorkerClient (6), BucketGrid (7)
- Produces:
  - `type Tool = { name: string; onPointerDown(e: ToolEvent): void; onPointerMove(e: ToolEvent): void; onPointerUp(e: ToolEvent): void; onKeyDown?(e: KeyboardEvent): void; drawHud(ctx, vp: Viewport): void; get ephemeralRect(): Rect | null }`
  - `type ToolEvent = { world: [number, number]; screen: [number, number]; scale: number; shift: boolean; alt: boolean }`
  - `type Handle = 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'move'|null`
  - `hitHandle(rect: Rect, wx: number, wy: number, scale: number): Handle` — hit slop is 8 **screen** px, i.e. `8 / scale` in world units
  - `resizeRect(rect: Rect, handle: Handle, dx: number, dy: number): Rect` — never inverts; min 4×4
  - `findSnaps(rect: Rect, candidates: Float32Array, count: number, toleranceWorld: number): { dx: number; dy: number; guides: number[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tools/selectTool.test.ts
import { describe, it, expect } from 'vitest'
import { hitHandle, resizeRect, findSnaps } from '@/tools/selectTool'

const R = { x: 100, y: 100, w: 200, h: 50 }

describe('hitHandle', () => {
  it('detects corners with screen-constant slop', () => {
    expect(hitHandle(R, 100, 100, 1)).toBe('nw')
    expect(hitHandle(R, 300, 150, 1)).toBe('se')
  })

  it('keeps slop constant in screen px as zoom changes', () => {
    expect(hitHandle(R, 106, 100, 1)).toBe('nw')      // 6 world px @ 1x = 6 screen px
    expect(hitHandle(R, 106, 100, 4)).not.toBe('nw')  // 6 world px @ 4x = 24 screen px
  })

  it('returns move inside and null outside', () => {
    expect(hitHandle(R, 200, 125, 1)).toBe('move')
    expect(hitHandle(R, 500, 500, 1)).toBeNull()
  })
})

describe('resizeRect', () => {
  it('resizes from the correct anchor', () => {
    expect(resizeRect(R, 'se', 10, 5)).toEqual({ x: 100, y: 100, w: 210, h: 55 })
    expect(resizeRect(R, 'nw', 10, 5)).toEqual({ x: 110, y: 105, w: 190, h: 45 })
  })

  it('moves without resizing', () => {
    expect(resizeRect(R, 'move', 10, -10)).toEqual({ x: 110, y: 90, w: 200, h: 50 })
  })

  it('clamps to a minimum size instead of inverting', () => {
    const r = resizeRect(R, 'se', -1000, -1000)
    expect(r.w).toBeGreaterThanOrEqual(4)
    expect(r.h).toBeGreaterThanOrEqual(4)
  })
})

describe('findSnaps', () => {
  const candidates = new Float32Array([98, 100, 200, 40])  // left edge at 98

  it('snaps a near edge and reports a guide', () => {
    const s = findSnaps({ x: 100, y: 300, w: 50, h: 20 }, candidates, 1, 6)
    expect(s.dx).toBeCloseTo(-2)
    expect(s.guides.length).toBeGreaterThan(0)
  })

  it('does not snap beyond tolerance', () => {
    const s = findSnaps({ x: 140, y: 300, w: 50, h: 20 }, candidates, 1, 6)
    expect(s.dx).toBe(0)
    expect(s.guides).toHaveLength(0)
  })

  it('prefers the nearest candidate edge', () => {
    const two = new Float32Array([98, 0, 10, 10, 103, 0, 10, 10])
    const s = findSnaps({ x: 100, y: 300, w: 50, h: 20 }, two, 2, 6)
    expect(Math.abs(s.dx)).toBeCloseTo(2)
  })
})
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

- `selectTool` state machine: `idle → maybeDrag → dragging(handle) → commit`. During
  `dragging` it mutates only its own `ephemeralRect`; the store is untouched until pointerup,
  which fires one `commit('editBox:' + id, …)`.
- Click resolves via `WorkerClient.hitTest` (async) — but a drag must start on the same
  gesture, so: on pointerdown, first test the currently selected rect's handles synchronously;
  only fall through to the worker when no handle is hit.
- Snap candidates come from `BucketGrid.query` over the dragged rect inflated by tolerance,
  excluding the dragged node itself. Tolerance is `6 / scale` world units.
- `hud.ts` draws 8 handles as 8×8 screen-px squares (`size / scale` in world units), the
  selection outline, and snap guides as 1px dashed lines spanning the visible rect.

- [ ] **Step 4: Verify tests pass, then check the feel in the browser**

Confirm: handles stay the same visual size at 10% and 500% zoom, snapping feels helpful and
not sticky, drag is smooth with 10k boxes loaded, and one drag is one undo step.

- [ ] **Step 5: Commit**

```bash
git add src/tools src/engine/layers/hud.ts src/engine/input.ts src/engine/engine.ts tests/tools
git commit -m "feat(tools): box editor with resize handles and edge snapping"
```

---

### Task 11: SSE stream, dev server, and dirty-node merge

**Files:**
- Create: `server/sse.mjs`, `src/stream/source.ts`, `src/stream/sseSource.ts`, `src/stream/mockSource.ts`, `src/store/merge.ts`
- Modify: `vite.config.ts` (proxy `/events` → `localhost:8787`), `package.json` (`dev:all`)
- Test: `tests/store/merge.test.ts`, `tests/stream/source.test.ts`

**Interfaces:**
- Consumes: store (9), worker client (6)
- Produces:
  - `type StreamEvent = { type: 'page'; pageIndex: number; nodes: SerializedNode[] } | { type: 'done' }`
  - `interface StreamSource { start(onEvent: (e: StreamEvent) => void): void; stop(): void; readonly connected: boolean }`
  - `createStreamSource(opts?: { forceMock?: boolean }): StreamSource` — probes `/events`, falls back to mock
  - `applyPageUpdate(pageIndex: number, incoming: SerializedNode[]): { applied: number; shielded: number }` — skips nodes with a `dirtyAt` entry

- [ ] **Step 1: Write the failing merge tests**

```ts
// tests/store/merge.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useStore, commit, undo } from '@/store/store'
import { applyPageUpdate } from '@/store/merge'

const reset = () => useStore.setState({ edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null }, true)
const node = (id: number, x: number) => ({ id, page: 0, x, y: 0, w: 10, h: 10, type: 1, parent: -1, order: id })

describe('applyPageUpdate', () => {
  beforeEach(reset)

  it('applies updates to clean nodes', () => {
    const r = applyPageUpdate(0, [node(1, 50)])
    expect(r.applied).toBe(1)
    expect(r.shielded).toBe(0)
    expect(useStore.getState().edits[1]?.rect?.x).toBe(50)
  })

  it('shields nodes the user has edited', () => {
    commit('move', (d) => {
      d.edits[1] = { rect: { x: 999, y: 0, w: 10, h: 10 } }
      d.dirtyAt[1] = Date.now()
    })
    const r = applyPageUpdate(0, [node(1, 50), node(2, 60)])
    expect(r.shielded).toBe(1)
    expect(r.applied).toBe(1)
    expect(useStore.getState().edits[1]?.rect?.x).toBe(999)
    expect(useStore.getState().edits[2]?.rect?.x).toBe(60)
  })

  it('does not add to the undo stack', () => {
    const before = useStore.getState()
    applyPageUpdate(0, [node(1, 50)])
    undo()
    expect(useStore.getState().edits[1]?.rect?.x).toBe(50)
    expect(before).not.toBe(useStore.getState())
  })

  it('clears the dirty flag when the last edit on a node is undone', () => {
    commit('move', (d) => {
      d.edits[1] = { rect: { x: 999, y: 0, w: 10, h: 10 } }
      d.dirtyAt[1] = Date.now()
    })
    undo()
    expect(useStore.getState().dirtyAt[1]).toBeUndefined()
    expect(applyPageUpdate(0, [node(1, 50)]).applied).toBe(1)
  })

  it('is idempotent for a repeated identical payload', () => {
    applyPageUpdate(0, [node(1, 50)])
    const a = JSON.stringify(useStore.getState().edits)
    applyPageUpdate(0, [node(1, 50)])
    expect(JSON.stringify(useStore.getState().edits)).toBe(a)
  })
})
```

```ts
// tests/stream/source.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MockStreamSource } from '@/stream/mockSource'

describe('MockStreamSource', () => {
  it('emits every page exactly once, then done', async () => {
    vi.useFakeTimers()
    const src = new MockStreamSource(10, 1)
    const seen: number[] = []
    let done = false
    src.start((e) => { e.type === 'page' ? seen.push(e.pageIndex) : (done = true) })
    await vi.runAllTimersAsync()
    expect(seen.slice().sort((a, b) => a - b)).toEqual([...Array(10).keys()])
    expect(done).toBe(true)
    vi.useRealTimers()
  })

  it('emits out of order', async () => {
    vi.useFakeTimers()
    const src = new MockStreamSource(30, 7)
    const seen: number[] = []
    src.start((e) => { if (e.type === 'page') seen.push(e.pageIndex) })
    await vi.runAllTimersAsync()
    expect(seen).not.toEqual([...Array(30).keys()])
    vi.useRealTimers()
  })

  it('stops emitting after stop()', async () => {
    vi.useFakeTimers()
    const src = new MockStreamSource(50, 3)
    const cb = vi.fn()
    src.start(cb)
    await vi.advanceTimersByTimeAsync(50)
    src.stop()
    const n = cb.mock.calls.length
    await vi.runAllTimersAsync()
    expect(cb.mock.calls.length).toBe(n)
  })
})
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

- `server/sse.mjs`: Node `http` server on 8787, `GET /events` with headers
  `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
  Emits pages in shuffled order with 20–120ms jitter, then a `done` event. Handles client
  disconnect (`req.on('close')`) so the process doesn't leak timers.
- `vite.config.ts`: `server.proxy = { '/events': 'http://localhost:8787' }`.
- `package.json`: `"dev:sse": "node server/sse.mjs"`, `"dev:all": "concurrently -k \"pnpm dev\" \"pnpm dev:sse\""` (`pnpm add -D concurrently`).
- `createStreamSource` HEADs `/events` with a 300ms timeout; on failure returns `MockStreamSource`.
- Ingestion path: event → `WorkerClient.ingestPage` (worker parses + indexes) → worker posts
  back typed arrays → main thread appends to `NodeArrays`, `BucketGrid.addPage`,
  `applyPageUpdate`, `engine.requestDraw()`. Chunk the main-thread append so no single task
  exceeds ~8ms — split by node count, not by page.
- Undo clearing `dirtyAt`: the inverse patch already removes the `dirtyAt[id]` entry because
  the commit that set it recorded it. Verify this rather than special-casing it.

- [ ] **Step 4: Verify tests pass and the live stream works**

Run `pnpm dev:all`. Confirm pages appear out of order, the canvas stays interactive
throughout, and DevTools shows no long task >16ms during ingestion. Save the trace to
`docs/perf/phase4-ingestion.json`.

- [ ] **Step 5: Commit**

```bash
git add server src/stream src/store/merge.ts vite.config.ts package.json pnpm-lock.yaml tests/stream tests/store/merge.test.ts docs/perf
git commit -m "feat(stream): SSE ingestion with dirty-node shielded merge"
```

---

### Task 12: Tree view and bi-directional grounding

**Files:**
- Create: `src/components/TreeView.tsx`, `src/components/StatusBar.tsx`
- Modify: `src/App.tsx`
- Test: `tests/components/treeModel.test.ts`

**Interfaces:**
- Consumes: nodes (2), store (9), engine (8)
- Produces:
  - `buildTreeRows(nodes: NodeArrays, expanded: Set<number>): TreeRow[]` where `TreeRow = { id: number; depth: number; type: NodeType; label: string; hasChildren: boolean }`
  - `TreeView` — virtualized list, only visible rows in the DOM

- [ ] **Step 1: Write the failing tests** (the flattening model is the testable part; rendering is not)

```ts
// tests/components/treeModel.test.ts
import { describe, it, expect } from 'vitest'
import { buildTreeRows } from '@/components/TreeView'
import { createNodeArrays, pushNode, NodeType } from '@/data/nodes'

function tree() {
  const a = createNodeArrays(8)
  pushNode(a, { id: 1, page: 0, x: 0, y: 0, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })
  pushNode(a, { id: 2, page: 0, x: 0, y: 0, w: 5, h: 2, type: NodeType.Line, parent: 0, order: 1 })
  pushNode(a, { id: 3, page: 0, x: 0, y: 3, w: 5, h: 2, type: NodeType.Line, parent: 0, order: 2 })
  return a
}

describe('buildTreeRows', () => {
  it('shows only roots when nothing is expanded', () => {
    const rows = buildTreeRows(tree(), new Set())
    expect(rows.map(r => r.id)).toEqual([1])
    expect(rows[0].hasChildren).toBe(true)
  })

  it('reveals children of expanded nodes in order', () => {
    const rows = buildTreeRows(tree(), new Set([1]))
    expect(rows.map(r => r.id)).toEqual([1, 2, 3])
    expect(rows[1].depth).toBe(1)
  })

  it('marks leaves as having no children', () => {
    expect(buildTreeRows(tree(), new Set([1]))[1].hasChildren).toBe(false)
  })

  it('handles an empty document', () => {
    expect(buildTreeRows(createNodeArrays(4), new Set())).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

- Virtualize by hand: fixed 24px rows, render `Math.ceil(height / 24) + 6` rows from a scroll
  offset. No library needed and 10k rows of DOM would defeat the point of the canvas.
- Hover/selection both live in the store, so grounding is a consequence of shared state:
  the engine writes `hoveredId` on canvas hover; a `useEffect` in `TreeView` scrolls that row
  into view. Tree hover writes `hoveredId`; the engine's store subscription calls `requestDraw`.
- **Subscribe narrowly** — `useStore(s => s.hoveredId)`, never the whole state — or React
  re-renders on every stream write.
- Add shadcn primitives as needed: `pnpm dlx shadcn@latest add scroll-area separator badge button tooltip`.

- [ ] **Step 4: Verify tests pass and both directions work in the browser**

- [ ] **Step 5: Commit**

```bash
git add src/components src/App.tsx tests/components
git commit -m "feat(ui): virtualized tree view with bi-directional canvas grounding"
```

---

### Task 13: Reading-order graph tool

**Files:**
- Create: `src/tools/orderTool.ts`, `src/engine/layers/overlays.ts`
- Modify: `src/engine/engine.ts`, `src/components/Toolbar.tsx`
- Test: `tests/tools/orderTool.test.ts`

**Interfaces:**
- Consumes: nodes (2), store (9), viewport (1)
- Produces:
  - `orderedIds(nodes: NodeArrays, edits: Record<number, Edit>): Uint32Array` — reading sequence after edits
  - `relink(order: Uint32Array, fromId: number, toId: number): Uint32Array` — makes `toId` the successor of `fromId`, renumbering the rest without duplicates or gaps
  - `arrowPath(a: Rect, b: Rect): { x1, y1, x2, y2, headAngle: number }` — centre-to-centre, clipped to rect edges

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tools/orderTool.test.ts
import { describe, it, expect } from 'vitest'
import { relink, arrowPath } from '@/tools/orderTool'

const u = (a: number[]) => new Uint32Array(a)

describe('relink', () => {
  it('moves a node to follow the target', () => {
    expect(Array.from(relink(u([1,2,3,4,5]), 1, 4))).toEqual([1,4,2,3,5])
  })

  it('is a no-op when already the successor', () => {
    expect(Array.from(relink(u([1,2,3]), 1, 2))).toEqual([1,2,3])
  })

  it('never duplicates or drops nodes', () => {
    const r = relink(u([1,2,3,4,5]), 5, 1)
    expect(Array.from(r).sort((a,b)=>a-b)).toEqual([1,2,3,4,5])
  })

  it('refuses to link a node to itself', () => {
    expect(Array.from(relink(u([1,2,3]), 2, 2))).toEqual([1,2,3])
  })

  it('handles the first and last positions', () => {
    expect(Array.from(relink(u([1,2,3]), 3, 1))).toEqual([2,3,1])
  })
})

describe('arrowPath', () => {
  it('runs between rect centres', () => {
    const p = arrowPath({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 0, w: 10, h: 10 })
    expect(p.x1).toBeGreaterThan(0)
    expect(p.x2).toBeLessThan(105)
    expect(p.y1).toBeCloseTo(5)
  })

  it('produces a finite path for coincident rects', () => {
    const p = arrowPath({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })
    expect(Number.isFinite(p.x1) && Number.isFinite(p.headAngle)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

- Overlay draws arrows **only between visible nodes** — culled like everything else, otherwise
  10k arrows destroy the frame budget. Cap at ~300 arrows on screen; beyond that draw only the
  selected node's neighbours.
- Drag: grab the arrowhead near a node, drag to another box, drop → one `commit('relink', …)`.
- Sequence numbers drawn as small badges at each box's top-left, only above ~0.6 zoom.

- [ ] **Step 4: Verify tests pass and the interaction works**

- [ ] **Step 5: Commit**

```bash
git add src/tools/orderTool.ts src/engine/layers/overlays.ts src/components tests/tools/orderTool.test.ts
git commit -m "feat(tools): directed reading-order graph with drag re-linking"
```

---

### Task 14: Table mesh — divider dragging

Split and merge are Task 16 (optional).

**Files:**
- Create: `src/tools/tableTool.ts`
- Test: `tests/tools/tableTool.test.ts`

**Interfaces:**
- Consumes: nodes (2), store (9)
- Produces:
  - `type Mesh = { rows: number[]; cols: number[]; bounds: Rect; cells: { row: number; col: number; rowSpan: number; colSpan: number; id: number }[] }`
  - `buildMesh(cells: { id, x, y, w, h, row, col }[]): Mesh`
  - `moveDivider(mesh: Mesh, axis: 'row'|'col', index: number, toWorld: number): Mesh` — clamped between neighbours, min band 8
  - `cellRect(mesh: Mesh, cell: Mesh['cells'][number]): Rect`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tools/tableTool.test.ts
import { describe, it, expect } from 'vitest'
import { buildMesh, moveDivider, cellRect } from '@/tools/tableTool'

const grid = () => {
  const cells = []
  let id = 1
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++)
    cells.push({ id: id++, x: 100 + c * 50, y: 200 + r * 20, w: 50, h: 20, row: r, col: c })
  return buildMesh(cells)
}

describe('buildMesh', () => {
  it('derives divider lines from cell geometry', () => {
    const m = grid()
    expect(m.cols).toEqual([100, 150, 200])
    expect(m.rows).toEqual([200, 220, 240, 260])
    expect(m.bounds).toEqual({ x: 100, y: 200, w: 100, h: 60 })
  })

  it('keeps every cell', () => {
    expect(grid().cells).toHaveLength(6)
  })
})

describe('moveDivider', () => {
  it('moves an interior divider and resizes both bands', () => {
    const m = moveDivider(grid(), 'col', 1, 170)
    expect(m.cols[1]).toBe(170)
    expect(cellRect(m, m.cells.find(c => c.col === 0)!).w).toBe(70)
    expect(cellRect(m, m.cells.find(c => c.col === 1)!).w).toBe(30)
  })

  it('clamps against the neighbouring divider', () => {
    const m = moveDivider(grid(), 'col', 1, 9999)
    expect(m.cols[1]).toBeLessThanOrEqual(m.cols[2] - 8)
  })

  it('leaves other dividers untouched', () => {
    const m = moveDivider(grid(), 'row', 1, 215)
    expect(m.rows[0]).toBe(200)
    expect(m.rows[2]).toBe(240)
  })

  it('refuses to move the outer edges past the bounds', () => {
    const m = moveDivider(grid(), 'col', 0, 9999)
    expect(m.cols[0]).toBeLessThanOrEqual(m.cols[1] - 8)
  })
})
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

- Mesh is derived from cell nodes, not stored separately — dividers are the sorted unique
  edges. Dragging writes new rects for every affected cell in **one** transaction.
- Hover within 4 screen px of a divider shows a resize cursor; the drag preview is ephemeral.

- [ ] **Step 4: Verify tests pass and dragging feels right**

- [ ] **Step 5: Commit**

```bash
git add src/tools/tableTool.ts tests/tools/tableTool.test.ts
git commit -m "feat(tools): table mesh with divider dragging"
```

---

### Task 15: Resilience — worker crash, stream drop, bad payloads

Implements spec §4. Small but graded: "preventing corrupted layout states" is an explicit
qualitative criterion.

**Files:**
- Modify: `src/worker/client.ts`, `src/stream/sseSource.ts`, `src/store/merge.ts`
- Create: `src/components/StatusBar.tsx` (if not already present in Task 12)
- Test: `tests/worker/resilience.test.ts`, `tests/stream/reconnect.test.ts`

**Interfaces:**
- Consumes: WorkerClient (6), StreamSource (11), store (9)
- Produces:
  - `WorkerClient.onError(cb: (err: Error) => void): () => void`
  - `SseStreamSource` gains `reconnect` with exponential backoff: 250ms → 500 → 1000 → 2000 → 4000, capped, reset on a successful message
  - `validatePage(raw: unknown): SerializedPage | null` in `merge.ts` — returns `null` for malformed input rather than throwing

- [ ] **Step 1: Write the failing tests**

```ts
// tests/worker/resilience.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WorkerClient } from '@/worker/client'
import { validatePage } from '@/store/merge'

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage() {}
  terminate() {}
}

describe('worker resilience', () => {
  it('surfaces a worker error to subscribers', () => {
    const w = new FakeWorker()
    const c = new WorkerClient(w as never)
    const cb = vi.fn()
    c.onError(cb)
    w.onerror?.(new ErrorEvent('error', { message: 'crashed' }))
    expect(cb).toHaveBeenCalled()
  })
})

describe('validatePage', () => {
  it('accepts a well-formed page', () => {
    const ok = { pageIndex: 1, nodes: [{ id: 1, page: 1, x: 0, y: 0, w: 1, h: 1, type: 0, parent: -1, order: 0 }] }
    expect(validatePage(ok)).not.toBeNull()
  })

  it('rejects malformed payloads without throwing', () => {
    for (const bad of [null, {}, { pageIndex: 'x', nodes: [] }, { pageIndex: 1, nodes: 'no' },
                       { pageIndex: 1, nodes: [{ id: 'a' }] }, { pageIndex: 1, nodes: [{ id: 1, x: NaN }] }]) {
      expect(validatePage(bad)).toBeNull()
    }
  })

  it('drops only the bad node, keeping the rest of the page', () => {
    const mixed = { pageIndex: 2, nodes: [
      { id: 1, page: 2, x: 0, y: 0, w: 1, h: 1, type: 0, parent: -1, order: 0 },
      { id: 2, page: 2, x: NaN, y: 0, w: 1, h: 1, type: 0, parent: -1, order: 1 },
    ] }
    expect(validatePage(mixed)?.nodes).toHaveLength(1)
  })
})
```

```ts
// tests/stream/reconnect.test.ts
import { describe, it, expect } from 'vitest'
import { backoffDelay } from '@/stream/sseSource'

describe('backoffDelay', () => {
  it('doubles then caps', () => {
    expect([0,1,2,3,4,5,6].map(backoffDelay)).toEqual([250, 500, 1000, 2000, 4000, 4000, 4000])
  })
})
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

- `WorkerClient`: attach `worker.onerror` and `onmessageerror`, fan out to `onError`
  subscribers, reject all pending requests. React shows a dismissible banner with a reload
  action; the canvas keeps rendering the data it already holds.
- `SseStreamSource`: on `error`, close and re-open after `backoffDelay(attempt)`; reset the
  attempt counter on the first successful message. Expose `connected` for the status indicator.
- `validatePage`: per-node numeric checks (`Number.isFinite`), drop bad nodes, return `null`
  only when the page envelope itself is unusable. Log once per rejected page, mark it failed
  in the page rail — one bad page must never poison the document.
- Undo of a node the stream has since removed: applying a patch to a missing key must be a
  no-op, not a resurrection. Guard in the patch applier.

- [ ] **Step 4: Verify tests pass**

Also verify by hand: kill `server/sse.mjs` mid-stream and confirm the UI reconnects when it
comes back, with no duplicate pages.

- [ ] **Step 5: Commit**

```bash
git add src/worker/client.ts src/stream/sseSource.ts src/store/merge.ts src/components tests/worker/resilience.test.ts tests/stream/reconnect.test.ts
git commit -m "feat: worker crash handling, SSE reconnect backoff, payload validation"
```

---

### Task 16: Benchmark mode, Playwright smoke test, ARCHITECTURE.md

**Files:**
- Create: `src/bench/harness.ts`, `e2e/smoke.spec.ts`, `playwright.config.ts`
- Modify: `ARCHITECTURE.md`, `README.md`, `src/components/Toolbar.tsx`
- Test: `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: engine (8), generator (3)
- Produces: `runBench(engine: CanvasEngine, durationMs: number): Promise<{ frames: number; p50: number; p95: number; worst: number; dropped: number }>`

- [ ] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test && pnpm exec playwright install chromium
```

- [ ] **Step 2: Write the smoke test**

```ts
// e2e/smoke.spec.ts
import { test, expect } from '@playwright/test'

test('loads the stress document and selects a box', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /stress test/i }).click()
  await expect(page.getByTestId('node-count')).toHaveText(/1[0-9],?\d{3}|\d{4,}/, { timeout: 15000 })
  const canvas = page.locator('canvas')
  const box = (await canvas.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('selection-label')).not.toHaveText('none')
})

test('sustains frame rate during a scripted pan', async ({ page }) => {
  await page.goto('/?bench=1')
  await page.getByRole('button', { name: /stress test/i }).click()
  const stats = await page.evaluate(() => (window as never as { __bench: () => Promise<{ p95: number }> }).__bench())
  expect(stats.p95).toBeLessThan(20)
})
```

- [ ] **Step 3: Run to verify failure**

- [ ] **Step 4: Implement**

- `runBench` drives a scripted pan/zoom via rAF, records `onFrame` durations, returns
  percentiles. Exposed as `window.__bench` when `?bench=1`.
- Toolbar gets the **Stress Test Document** toggle (100 pages / 10k boxes), a node count with
  `data-testid="node-count"`, and a selection label with `data-testid="selection-label"`.
- `playwright.config.ts` with `webServer: { command: 'pnpm dev', port: 5173, reuseExistingServer: true }`.

- [ ] **Step 5: Fill in ARCHITECTURE.md**

Replace every section of the skeleton with what was actually built, with measured numbers:
transform matrix and pipeline (Task 1, 8), worker strategy (6), quadtree and the
culling/hit-test split (5, 7), memory and frame-rate techniques (4, 8), and the four
benchmark results with links to the traces in `docs/perf/`. Delete the status banner.
Update `README.md` with `pnpm install && pnpm dev:all` and a note on the stress toggle.

- [ ] **Step 6: Run everything**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm exec playwright test
```

- [ ] **Step 7: Capture final performance evidence**

Record three DevTools traces on the stress document — continuous pan/zoom, live SSE
ingestion, and 50 load/undo/redo cycles with heap snapshots before and after — and save them
plus screenshots to `docs/perf/`.

- [ ] **Step 8: Deploy**

The mock stream fallback makes the build fully static, so no server is needed in production.

```bash
pnpm build && pnpm dlx vercel deploy --prod --yes
```

Add the resulting URL to `README.md`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: benchmark harness, e2e smoke test, architecture writeup"
```

---

### Task 17 (OPTIONAL — 6b): Table cell split and merge

Build only if Tasks 1–16 are done and time remains. If skipped, say so explicitly in
ARCHITECTURE.md §7 as a deliberate trade-off.

**Files:**
- Modify: `src/tools/tableTool.ts`
- Test: `tests/tools/tableTool.test.ts`

**Interfaces:**
- Produces: `splitCell(mesh: Mesh, cellId: number, axis: 'row'|'col'): Mesh`, `mergeCells(mesh: Mesh, aId: number, bId: number): Mesh`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { buildMesh, splitCell, mergeCells } from '@/tools/tableTool'

const grid = () => {
  const cells = []
  let id = 1
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++)
    cells.push({ id: id++, x: c * 50, y: r * 20, w: 50, h: 20, row: r, col: c })
  return buildMesh(cells)
}

describe('splitCell', () => {
  it('adds one cell and preserves total area', () => {
    const m = splitCell(grid(), 1, 'col')
    expect(m.cells).toHaveLength(5)
  })
  it('gives the new cells unique ids', () => {
    const m = splitCell(grid(), 1, 'row')
    expect(new Set(m.cells.map(c => c.id)).size).toBe(m.cells.length)
  })
})

describe('mergeCells', () => {
  it('merges two adjacent cells into one spanning cell', () => {
    const m = mergeCells(grid(), 1, 2)
    expect(m.cells).toHaveLength(3)
    expect(m.cells.find(c => c.colSpan === 2)).toBeTruthy()
  })
  it('refuses non-adjacent cells', () => {
    const before = grid()
    expect(mergeCells(before, 1, 4).cells).toHaveLength(before.cells.length)
  })
})
```

- [ ] **Step 2–5:** run to fail, implement, verify, commit.

```bash
git add src/tools/tableTool.ts tests/tools/tableTool.test.ts
git commit -m "feat(tools): table cell split and merge"
```

---

## Deliverables checklist

- [ ] Clean React + TS repo, pushed
- [ ] `pnpm install && pnpm dev:all` runs the app and the SSE server
- [ ] Stress Test Document toggle: 100 pages, ~10,000 boxes
- [ ] `ARCHITECTURE.md` complete with measured numbers
- [ ] Performance traces and screenshots in `docs/perf/`
- [ ] Deployed demo (Vercel, static build with the mock stream fallback)
