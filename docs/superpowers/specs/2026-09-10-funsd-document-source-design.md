# FUNSD Document Source — Design

Date: 2026-09-10
Status: approved, pending implementation plan

## Problem

The workspace renders one kind of document: procedurally generated A4 pages from
`src/data/generator.ts`. Everything downstream assumes it — a single page size welded into
`PAGE_W`/`PAGE_H`/`pageOrigin`, a synchronous page rasteriser, and a reading order modelled as a
linear chain.

That is enough to hit the brief's 10,000-box stress target, but it makes the demo unconvincing:
every box is a rectangle over synthetic ink, the reading-order graph is a chain nobody extracted,
and the "structural repair" tools have nothing real to repair.

The FUNSD corpus (199 scanned forms, already downloaded to the gitignored `dataset/`) supplies
real scans, real labels, and — critically — a real directed link graph:

| | |
|---|---|
| Pages | 199 (149 train + 50 test) |
| Entities | 9,743 (~49/page) |
| Word boxes | 31,485 (~158/page) |
| **Total boxes** | **41,228** (~207/page) |
| Link refs | 10,624 → ~5,312 unique directed edges |
| Labels | question 4,343 · answer 3,623 · other 1,214 · header 563 |
| Images | grayscale PNG, 754–802 × 1000 |
| On disk | 35 MB |

41k real boxes is 4× the brief's requirement, so the real document becomes the *more* demanding
render case, not a toy alongside the stress test.

## Goals

- Ship two documents behind one interface: FUNSD (199pp, 41k boxes) and synthetic (100pp, 10k).
- Reading order becomes a real DAG driven by FUNSD `linking`, with drag-to-rewire.
- All parsing moves into the worker — including the synthetic path, which currently parses on the
  main thread.
- No regression to the graded non-negotiables: 60 FPS, per-frame culling, <16ms tasks, zero leaks.

## Non-goals

- Table mesh work. FUNSD is form-structured and has no tables; the table corrector stays on
  synthetic data.
- Any preprocessing of FUNSD into a binary bundle. PNGs and JSONs ship as-is (35 MB) and the worker
  parses at runtime.
- Text rendering / OCR display. `text` fields are ignored for now beyond the Tree View label.

## Constraints

- FUNSD derives from RVL-CDIP and is distributed for non-commercial research use. Note this in
  `ARCHITECTURE.md`.
- `dataset/` stays gitignored as raw source; shipped assets live in `public/funsd/`.

---

## §1 — Document layer & page geometry

### `src/data/geometry.ts` (new)

```ts
export type PageGeometry = {
  count: number
  /** x, y, w, h per page at i * 4 — world units */
  rects: Float32Array
  origin(page: number, out: Float32Array): void
  /** inclusive [from, to] page range intersecting a world y-span */
  rangeFor(y: number, h: number): [number, number]
}
```

`rangeFor` binary-searches the cumulative y column. `uniformGeometry(count, w, h, gap)` reproduces
today's constant-stride behaviour exactly, so the synthetic path is unchanged in effect.

`visiblePageRange` (`src/engine/layers/pages.ts`) and `PageLayer.draw` take a `PageGeometry` rather
than deriving layout from module constants. `PAGE_W`/`PAGE_H`/`PAGE_GAP`/`pageOrigin` remain
exported from `generator.ts`, used only by the synthetic document.

### `src/data/document.ts` (new)

```ts
export interface DocumentSource {
  readonly id: 'funsd' | 'synthetic'
  readonly pageCount: number
  geometry(): Promise<PageGeometry>
  raster(page: number): Promise<PageBitmap>
  createStream(): StreamSource
}
```

Implementations in `src/data/synthetic/` (wrapping today's `generator.ts`, `pageRenderer.ts`,
`MockStreamSource`) and `src/data/funsd/`.

### Geometry without decoding images

`scripts/prepare-funsd.ts` copies all 199 PNGs and JSONs from `dataset/` into
`public/funsd/{images,annotations}/` and writes `public/funsd/manifest.json` — `[{ id, w, h }]` per
page, read from PNG IHDR headers. `geometry()` is therefore one ~8 KB fetch, not 199 image decodes.

Pages stack vertically at native pixel size, left-aligned at x=0, separated by `PAGE_GAP`. Total
world height ≈ 199 × 1040 ≈ 207k units, within the existing `WORLD` bound of 400k
(`src/app/session.ts`).

The script is idempotent and safe to re-run.

## §2 — Worker protocol & parsing

One new request kind, one new array on the response:

```ts
| { kind: 'ingestUrl'; pageIndex: number; url: string }

type PageIngested = {
  // …existing ids / coords / types / parents / order
  edges: Int32Array   // flat [fromId, toId, ...] pairs
}
```

The FUNSD stream emits `{ type: 'page', pageIndex, url }` — a ~60-byte event carrying no node
payload. `Session` forwards it to the worker as `ingestUrl`; the worker fetches, parses, indexes
into the QuadTree, and posts back transferable typed arrays. The 199 JSON files never cross the
main thread.

### Parse mapping

- entity `box: [x0,y0,x1,y1]` → `{x: x0, y: y0, w: x1-x0, h: y1-y0}`, plus the page's y-offset
- `label: question | answer` → `NodeType.KeyValue`; `header | other` → `NodeType.Paragraph`
- each `words[i]` → child node, `NodeType.Line`, `parent` = the entity's global id
- global id = `pageIndex * 1000 + localCounter`; max observed is 536 nodes/page, so the existing
  1000 stride holds
- `linking` pairs deduped — they appear on both endpoints, which is why the raw ref count is 10,624
  for ~5,312 real edges — then mapped local→global and emitted in `edges`

The synthetic document routes through the same `ingestUrl` path using a `synthetic://page/N` URL the
worker recognises and generates in-worker. `serializeGeneratedPage` and its main-thread parse are
deleted.

## §3 — Edge model

### `src/data/edges.ts` (new)

```ts
export type EdgeSet = {
  count: number
  pairs: Int32Array        // [fromId, toId] at i*2
  /** nodeIndex → offsets into `pairs`, rebuilt only when the graph changes */
  adjacency: Map<number, number[]>
}
```

Base edges arrive from the worker and accumulate per page. They live outside React and are never
allocated per frame.

Human edits stay in the store, so undo/redo needs no new machinery:

```ts
type AppState = {
  // …
  edgesAdded: [number, number][]     // replaces Edit.orderNext
  edgesRemoved: [number, number][]
}
```

`Edit.orderNext` is removed. The effective graph is `base ∪ added ∖ removed`, materialised into
`adjacency` when the store's edge arrays change, gated by the existing `orderDirty` flag.

`orderedIds()` and `relink()` are deleted. Synthetic documents get a linear chain synthesised at
parse time (edge `i → i+1` over the sorted `order` field), so a chain is a DAG with out-degree 1 and
both documents share one code path.

### Overlay

`OrderOverlay` inverts its loop. It currently walks the entire sequence and skips off-screen pairs —
O(all nodes) per frame, which violates the culling rule. The new version iterates
`engine.lastVisible`, looks up each node's outgoing edges in `adjacency`, and draws only those.
`MAX_ARROWS = 300` and the neighbours-only fallback past the cap carry over unchanged.

### Tool

`OrderTool` drag becomes a toggle: drag A→B adds the edge, or removes it if it already exists. Drag
onto empty space cancels. One gesture, one `commit('link' | 'unlink', …)`, one undo entry.

## §4 — Render path

`PageRenderFn` widens to `(page) => PageBitmap | Promise<PageBitmap>`. `PageCache.ensure()` stays
synchronous and non-blocking: on a miss it records a pending marker and starts the load. `get()`
returns `null` while pending, and `PageLayer` already paints blank paper in that case — the fallback
exists today but never fires.

**Leak guard.** A raster can resolve after its page was evicted or the session disposed. Each
pending load carries a generation counter; a resolution whose page is no longer wanted calls
`bitmap.close()` immediately rather than caching it. Without this, fast scrolling through 199 pages
retains every decode.

FUNSD raster = `fetch → blob → createImageBitmap`. At `maxResident = 12` and ~754×1000 RGBA,
resident cost is ~36 MB, the same order as the current synthetic cache.

## §5 — UI

A `Select` in the header (`src/App.tsx`):

- "Real · FUNSD · 199pp · 41k boxes"
- "Stress · 100pp · 10k boxes"

Switching disposes the `Session` and constructs a new one with the other `DocumentSource`.
`useStore.setState` to initial clears edits, and the existing subscriber drops history
automatically. This control satisfies the brief's required "Stress Test Document toggle"
deliverable.

## §6 — Testing

Vitest units for:

- FUNSD parse against one committed fixture JSON — box conversion, id namespacing, `linking`
  dedup (2 refs → 1 edge)
- `PageGeometry.rangeFor` — parity with the old stride math on the uniform case, correctness on a
  variable-height table
- edge toggle — add, remove, undo round-trip
- construct/dispose ×20 asserting no growth in cache size or listener count, covering the "zero
  leaks" non-negotiable

## §7 — Performance evidence

Profiler traces captured on both documents. 41k real boxes is now the more demanding case and
becomes the headline number in `ARCHITECTURE.md`.

## Risks

- **35 MB of committed assets.** Accepted deliberately; keeps `pnpm dev` a one-step run with no
  download step.
- **Widening `PageCache` to async** touches the one piece of code with a live leak guarantee. The
  generation-counter guard and the dispose-loop test exist specifically to cover it.
- **Deleting the linear order model** is the largest single refactor. It is contained to
  `orderTool.ts`, `overlays.ts`, and the `Edit` shape in `store.ts`.
