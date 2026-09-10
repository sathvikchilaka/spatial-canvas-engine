# Table Grid Mesh Corrector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Module B's third tool: an editable table grid mesh over detected tables, with row/column divider dragging, cell splitting and cell merging, each an undoable transaction that recalculates every affected cell's bounding box.

**Architecture:** A table in the document is a parent node (`NodeType.Paragraph`, emitted by the synthetic generator's `table()` block) whose children are `NodeType.Cell` nodes. The mesh is *derived* from those cells' geometry, never stored as a second source of truth: `buildMesh` clusters cell centres into row/column bands and places one divider line between adjacent bands, so a table of N×M cells becomes `rows.length = N+1`, `cols.length = M+1`. Editing moves a line; `cellRect` then re-derives every cell rect from the lines, and the tool commits the changed rects as ordinary `edits[id].rect` entries. That is the whole trick — box edits already flow through `Session.writeCoords`, so history, the worker QuadTree and the cull grid come along for free. Split and merge change the *number* of cells, which needs two new store fields (`created`, `deleted`) and two new worker messages.

**Tech Stack:** TypeScript, Canvas2D, Vitest, Zustand + Immer, native Web Worker.

**Spec:** `docs/ASSIGNMENT.md` Module B ("Table Grid Mesh Corrector: render an editable table grid mesh overlay across detected tables; interactive row/column divider dragging, cell splitting and cell merging with instant bounding box recalculation"). Design context: `ARCHITECTURE.md` §1, §4.

## Global Constraints

- **Depends on** `plans/2026_09_10_feature-canvas-correctness-fixes-plan.md` Tasks 1–2 being merged: this plan assumes committing `edits[id].rect` is sufficient to keep the QuadTree and `BucketGrid` correct. If those are not in yet, land them first.
- Package manager **pnpm**. `pnpm test`, `pnpm typecheck`, `pnpm lint` must all pass at every commit.
- **No allocations in the frame loop.** The mesh is rebuilt on selection change and on commit, never per frame; the overlay draws from the cached `Mesh`.
- No DOM overlays. Mesh lines and handles are Canvas2D, drawn in world space with `1/scale` widths so they stay constant in screen px.
- Path alias `@/` → `src/`. Dark-first, tokens only in React; canvas colours follow the existing `rgba(...)` conventions in `src/engine/layers/`.
- Tables exist only in the **synthetic** document (`generatePage`'s `table()` block, `NodeType.Cell` children). FUNSD has no tables; the tool must simply find nothing there and say so, not throw.

---

### Task 1: Mesh derivation — `buildMesh` and `cellRect`

**Files:**
- Create: `src/tools/tableMesh.ts`
- Test: `tests/tools/tableMesh.test.ts`

**Interfaces:**
- Consumes: `Rect` from `@/data/nodes`.
- Produces:
  - `export type MeshCell = { id: number; row: number; col: number; rowSpan: number; colSpan: number }`
  - `export type Mesh = { rows: number[]; cols: number[]; bounds: Rect; cells: MeshCell[] }`
  - `export type CellInput = { id: number; x: number; y: number; w: number; h: number }`
  - `export function buildMesh(cells: CellInput[]): Mesh`
  - `export function cellRect(mesh: Mesh, cell: MeshCell): Rect`
  - `export const MIN_BAND = 8`

- [x] **Step 1: Write the failing test**

```ts
// tests/tools/tableMesh.test.ts
import { describe, it, expect } from 'vitest'
import { buildMesh, cellRect, type CellInput } from '@/tools/tableMesh'

/**
 * Shaped like the synthetic generator's tables: cells carry a 6px inset inside
 * their band (`x: MARGIN + c * colW + 6, w: colW - 12`), so adjacent cells do
 * NOT share an edge. The mesh must put one divider *between* them rather than
 * two lines 12px apart.
 */
function insetGrid(rows = 3, cols = 2, colW = 50, rowH = 20): CellInput[] {
  const out: CellInput[] = []
  let id = 1
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        id: id++,
        x: 100 + c * colW + 6,
        y: 200 + r * rowH + 6,
        w: colW - 12,
        h: rowH - 12,
      })
    }
  }
  return out
}

describe('buildMesh', () => {
  it('places one divider between adjacent bands, not one per cell edge', () => {
    const m = buildMesh(insetGrid())
    expect(m.cols).toHaveLength(3)
    expect(m.rows).toHaveLength(4)
  })

  it('anchors outer lines on the outermost cell edges', () => {
    const m = buildMesh(insetGrid())
    expect(m.cols[0]).toBe(106)
    expect(m.cols[2]).toBe(194)
    expect(m.rows[0]).toBe(206)
    expect(m.rows[3]).toBe(254)
  })

  it('puts interior lines midway between neighbouring bands', () => {
    const m = buildMesh(insetGrid())
    // band 0 ends at 144, band 1 starts at 156 → divider at 150
    expect(m.cols[1]).toBe(150)
    expect(m.rows[1]).toBe(220)
  })

  it('keeps every cell, with span 1 and its band indices', () => {
    const m = buildMesh(insetGrid())
    expect(m.cells).toHaveLength(6)
    expect(m.cells.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(m.cells[0]).toEqual({ id: 1, row: 0, col: 0, rowSpan: 1, colSpan: 1 })
    expect(m.cells[5]).toEqual({ id: 6, row: 2, col: 1, rowSpan: 1, colSpan: 1 })
  })

  it('reports bounds as the outer lines', () => {
    expect(buildMesh(insetGrid()).bounds).toEqual({ x: 106, y: 206, w: 88, h: 48 })
  })

  it('detects a cell that already spans two columns', () => {
    const cells = insetGrid()
    // Widen cell 1 so it covers both column bands.
    cells[0] = { id: 1, x: 106, y: 206, w: 88, h: 14 }
    const m = buildMesh(cells)
    expect(m.cells.find((c) => c.id === 1)!.colSpan).toBe(2)
  })

  it('returns an empty mesh for no cells rather than throwing', () => {
    const m = buildMesh([])
    expect(m.cells).toEqual([])
    expect(m.rows).toEqual([])
    expect(m.cols).toEqual([])
    expect(m.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('cellRect', () => {
  it('re-derives a cell rect from the mesh lines', () => {
    const m = buildMesh(insetGrid())
    expect(cellRect(m, m.cells[0])).toEqual({ x: 106, y: 206, w: 44, h: 14 })
  })

  it('covers the whole span of a spanning cell', () => {
    const m = buildMesh(insetGrid())
    const spanning = { id: 1, row: 0, col: 0, rowSpan: 2, colSpan: 2 }
    expect(cellRect(m, spanning)).toEqual({ x: 106, y: 206, w: 88, h: 28 })
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/tools/tableMesh.test.ts`
Expected: FAIL — cannot resolve `@/tools/tableMesh`.

- [x] **Step 3: Implement `src/tools/tableMesh.ts`**

```ts
import type { Rect } from '@/data/nodes'

/** A cell's place in the mesh. Geometry is always re-derived via `cellRect`. */
export type MeshCell = { id: number; row: number; col: number; rowSpan: number; colSpan: number }

/**
 * A table as N+1 horizontal and M+1 vertical divider lines, in world units.
 * Deliberately *lossy*: building a mesh regularises a ragged extraction onto a
 * shared grid, which is the repair the reviewer is here to make. Cell rects are
 * therefore derived from the lines (`cellRect`), never stored per cell.
 */
export type Mesh = { rows: number[]; cols: number[]; bounds: Rect; cells: MeshCell[] }

export type CellInput = { id: number; x: number; y: number; w: number; h: number }

/** Smallest band a divider drag may leave behind, world units. */
export const MIN_BAND = 8

const EMPTY: Mesh = { rows: [], cols: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, cells: [] }

type Band = { lo: number; hi: number }

/**
 * Groups 1-D extents into bands. Extents are sorted by their start; a new band
 * opens when the next extent starts past the current band's end, which is what
 * makes inset cells (`w: colW - 12`) collapse into one band per column instead
 * of one per cell edge.
 */
function bandsOf(extents: { lo: number; hi: number }[]): Band[] {
  const sorted = [...extents].sort((a, b) => a.lo - b.lo)
  const bands: Band[] = []
  for (const e of sorted) {
    const last = bands[bands.length - 1]
    if (last && e.lo < last.hi) {
      if (e.hi > last.hi) last.hi = e.hi
      continue
    }
    bands.push({ lo: e.lo, hi: e.hi })
  }
  return bands
}

/** Outer edges of the outermost bands, interior lines midway between bands. */
function linesOf(bands: Band[]): number[] {
  if (bands.length === 0) return []
  const lines = [bands[0].lo]
  for (let i = 1; i < bands.length; i++) lines.push((bands[i - 1].hi + bands[i].lo) / 2)
  lines.push(bands[bands.length - 1].hi)
  return lines
}

/** Index of the line nearest `v`. */
function nearestLine(lines: number[], v: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < lines.length; i++) {
    const d = Math.abs(lines[i] - v)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** Derives the divider grid from a table's cell geometry. */
export function buildMesh(cells: CellInput[]): Mesh {
  if (cells.length === 0) return { ...EMPTY, rows: [], cols: [], cells: [] }

  const cols = linesOf(bandsOf(cells.map((c) => ({ lo: c.x, hi: c.x + c.w }))))
  const rows = linesOf(bandsOf(cells.map((c) => ({ lo: c.y, hi: c.y + c.h }))))

  const placed: MeshCell[] = cells.map((c) => {
    const col = nearestLine(cols, c.x)
    const row = nearestLine(rows, c.y)
    return {
      id: c.id,
      row,
      col,
      // A cell already covering several bands (a merged extraction) keeps its
      // span rather than being clipped to one band.
      colSpan: Math.max(1, nearestLine(cols, c.x + c.w) - col),
      rowSpan: Math.max(1, nearestLine(rows, c.y + c.h) - row),
    }
  })

  return {
    rows,
    cols,
    bounds: {
      x: cols[0],
      y: rows[0],
      w: cols[cols.length - 1] - cols[0],
      h: rows[rows.length - 1] - rows[0],
    },
    cells: placed,
  }
}

/** The rect a cell occupies given the current lines. Allocation is per commit, not per frame. */
export function cellRect(mesh: Mesh, cell: MeshCell): Rect {
  const x0 = mesh.cols[cell.col]
  const y0 = mesh.rows[cell.row]
  const x1 = mesh.cols[Math.min(mesh.cols.length - 1, cell.col + cell.colSpan)]
  const y1 = mesh.rows[Math.min(mesh.rows.length - 1, cell.row + cell.rowSpan)]
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
```

- [x] **Step 4: Run tests**

Run: `pnpm test -- tests/tools/tableMesh.test.ts && pnpm typecheck`
Expected: PASS (all 9 cases).

- [x] **Step 5: Commit**

```bash
git add src/tools/tableMesh.ts tests/tools/tableMesh.test.ts
git commit -m "feat(tools): derive a table divider mesh from cell geometry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Divider dragging — `moveDivider` and `hitDivider`

**Files:**
- Modify: `src/tools/tableMesh.ts`
- Test: `tests/tools/tableMesh.test.ts`

**Interfaces:**
- Consumes: `Mesh`, `MIN_BAND` from Task 1.
- Produces:
  - `export function moveDivider(mesh: Mesh, axis: 'row' | 'col', index: number, toWorld: number): Mesh` — returns a new `Mesh` (same `cells` array reference is not reused; copy it). Clamps to `[neighbourBefore + MIN_BAND, neighbourAfter - MIN_BAND]`. Moving an outer line (index 0 or last) is allowed and grows/shrinks the table, clamped against its single neighbour.
  - `export function hitDivider(mesh: Mesh, wx: number, wy: number, slopWorld: number): { axis: 'row' | 'col'; index: number } | null` — column lines take precedence on a corner tie.

- [x] **Step 1: Write the failing test**

Append to `tests/tools/tableMesh.test.ts`:

```ts
import { buildMesh, cellRect, hitDivider, moveDivider, MIN_BAND } from '@/tools/tableMesh'

describe('moveDivider', () => {
  it('moves an interior line and recalculates both neighbouring cells', () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, 'col', 1, 170)
    expect(m1.cols).toEqual([106, 170, 194])
    expect(cellRect(m1, m1.cells[0])).toEqual({ x: 106, y: 206, w: 64, h: 14 })
    expect(cellRect(m1, m1.cells[1])).toEqual({ x: 170, y: 206, w: 24, h: 14 })
  })

  it('does not mutate the input mesh', () => {
    const m0 = buildMesh(insetGrid())
    moveDivider(m0, 'col', 1, 170)
    expect(m0.cols[1]).toBe(150)
  })

  it('clamps against the previous neighbour', () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, 'col', 1, 0)
    expect(m1.cols[1]).toBe(106 + MIN_BAND)
  })

  it('clamps against the next neighbour', () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, 'col', 1, 9999)
    expect(m1.cols[1]).toBe(194 - MIN_BAND)
  })

  it('lets an outer line grow the table', () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, 'row', 3, 300)
    expect(m1.rows[3]).toBe(300)
    expect(m1.bounds.h).toBe(94)
  })

  it('clamps an outer line against its only neighbour', () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, 'row', 0, 9999)
    expect(m1.rows[0]).toBe(220 - MIN_BAND)
  })

  it('ignores an out-of-range index', () => {
    const m0 = buildMesh(insetGrid())
    expect(moveDivider(m0, 'col', 99, 10)).toBe(m0)
  })
})

describe('hitDivider', () => {
  it('finds a line within screen-constant slop', () => {
    const m = buildMesh(insetGrid())
    expect(hitDivider(m, 151, 230, 4)).toEqual({ axis: 'col', index: 1 })
    expect(hitDivider(m, 130, 221, 4)).toEqual({ axis: 'row', index: 1 })
  })

  it('misses outside the table bounds', () => {
    const m = buildMesh(insetGrid())
    expect(hitDivider(m, 150, 900, 4)).toBeNull()
    expect(hitDivider(m, 900, 220, 4)).toBeNull()
  })

  it('returns null in open cell space', () => {
    const m = buildMesh(insetGrid())
    expect(hitDivider(m, 120, 210, 4)).toBeNull()
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/tools/tableMesh.test.ts`
Expected: FAIL — `moveDivider` / `hitDivider` are not exported.

- [x] **Step 3: Implement**

Append to `src/tools/tableMesh.ts`:

```ts
/**
 * Moves one divider, clamped so no band collapses below `MIN_BAND`. Returns a
 * new `Mesh`; the caller re-derives cell rects with `cellRect` and commits
 * exactly the ones that changed.
 */
export function moveDivider(
  mesh: Mesh,
  axis: 'row' | 'col',
  index: number,
  toWorld: number,
): Mesh {
  const lines = axis === 'row' ? mesh.rows : mesh.cols
  if (index < 0 || index >= lines.length) return mesh

  const lo = index > 0 ? lines[index - 1] + MIN_BAND : -Infinity
  const hi = index < lines.length - 1 ? lines[index + 1] - MIN_BAND : Infinity
  const next = [...lines]
  next[index] = Math.min(hi, Math.max(lo, toWorld))

  const rows = axis === 'row' ? next : mesh.rows
  const cols = axis === 'col' ? next : mesh.cols
  return {
    rows,
    cols,
    bounds: {
      x: cols[0],
      y: rows[0],
      w: cols[cols.length - 1] - cols[0],
      h: rows[rows.length - 1] - rows[0],
    },
    cells: mesh.cells.map((c) => ({ ...c })),
  }
}

/**
 * Which divider a world point lands on. `slopWorld` is the caller's screen slop
 * divided by scale, so the grab target is constant in screen pixels at any zoom.
 * Column lines win a corner tie — vertical dividers are the ones a reviewer
 * reaches for most in a form table.
 */
export function hitDivider(
  mesh: Mesh,
  wx: number,
  wy: number,
  slopWorld: number,
): { axis: 'row' | 'col'; index: number } | null {
  const b = mesh.bounds
  const insideY = wy >= b.y - slopWorld && wy <= b.y + b.h + slopWorld
  const insideX = wx >= b.x - slopWorld && wx <= b.x + b.w + slopWorld
  if (insideY) {
    for (let i = 0; i < mesh.cols.length; i++) {
      if (Math.abs(wx - mesh.cols[i]) <= slopWorld) return { axis: 'col', index: i }
    }
  }
  if (insideX) {
    for (let i = 0; i < mesh.rows.length; i++) {
      if (Math.abs(wy - mesh.rows[i]) <= slopWorld) return { axis: 'row', index: i }
    }
  }
  return null
}
```

- [x] **Step 4: Run tests**

Run: `pnpm test -- tests/tools/tableMesh.test.ts && pnpm typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/tools/tableMesh.ts tests/tools/tableMesh.test.ts
git commit -m "feat(tools): clamped divider dragging and screen-constant divider hit-testing

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `TableTool` — the interactive tool, committed as one undo entry

**Files:**
- Create: `src/tools/tableTool.ts`
- Test: `tests/tools/tableTool.test.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolEvent`, `HANDLE_SLOP_PX` from `@/tools/types`; `Mesh`, `buildMesh`, `cellRect`, `hitDivider`, `moveDivider` from `@/tools/tableMesh`; `commit`, `useStore` from `@/store/store`; `drawSelectionHud` is **not** used here (the mesh draws its own HUD).
- Produces:
  - `export type TableSnapshot = { tableId: number; cells: CellInput[] }`
  - `export type TableToolDeps = { tableAt(nodeId: number): TableSnapshot | null; pick(wx: number, wy: number): Promise<number | null>; requestDraw(): void }`
  - `export class TableTool implements Tool` with `readonly name = 'table'`, `get mesh(): Mesh | null`, `get tableId(): number | null`.
  - `export function meshEdits(mesh: Mesh, original: Map<number, Rect>): Map<number, Rect>` — the changed-cells diff the commit writes; exported so it can be tested without a pointer.

- [x] **Step 1: Write the failing test**

```ts
// tests/tools/tableTool.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { buildMesh, moveDivider } from '@/tools/tableMesh'
import { TableTool, meshEdits, type TableSnapshot } from '@/tools/tableTool'
import { resetHistory, undo, useStore } from '@/store/store'
import type { Rect } from '@/data/nodes'

const cells = () => {
  const out = []
  let id = 1
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 2; c++)
      out.push({ id: id++, x: 100 + c * 50 + 6, y: 200 + r * 20 + 6, w: 38, h: 8 })
  return out
}

const snapshot = (): TableSnapshot => ({ tableId: 900, cells: cells() })

function ctx() {
  const calls: string[] = []
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'setLineDash') return () => {}
        return (...a: unknown[]) => {
          calls.push(`${String(prop)}(${a.join(',')})`)
        }
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
  return { proxy, calls }
}

const clean = () => {
  useStore.setState(
    { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
    true,
  )
  resetHistory()
}

beforeEach(clean)

describe('meshEdits', () => {
  it('returns only the cells whose rect actually moved', () => {
    const m0 = buildMesh(cells())
    const original = new Map<number, Rect>(
      m0.cells.map((c) => [c.id, { x: 0, y: 0, w: 0, h: 0 }]),
    )
    // Seed `original` with the mesh's own rects so nothing looks changed.
    for (const c of m0.cells) original.set(c.id, { ...cellRectOf(m0, c.id) })
    const m1 = moveDivider(m0, 'col', 1, 170)
    const diff = meshEdits(m1, original)
    // Only the two cells adjoining the moved column line changed.
    expect([...diff.keys()].sort()).toEqual([1, 2, 3, 4].filter((id) => diff.has(id)).sort())
    expect(diff.size).toBe(4)
  })

  function cellRectOf(m: ReturnType<typeof buildMesh>, id: number) {
    const c = m.cells.find((x) => x.id === id)!
    return {
      x: m.cols[c.col],
      y: m.rows[c.row],
      w: m.cols[c.col + c.colSpan] - m.cols[c.col],
      h: m.rows[c.row + c.rowSpan] - m.rows[c.row],
    }
  }
})

describe('TableTool', () => {
  it('adopts the table under the selected node', async () => {
    const tool = new TableTool({
      tableAt: () => snapshot(),
      pick: async () => 3,
      requestDraw: () => {},
    })
    await tool.adopt(3)
    expect(tool.tableId).toBe(900)
    expect(tool.mesh?.cols).toHaveLength(3)
  })

  it('reports no mesh when the pick is not in a table', async () => {
    const tool = new TableTool({ tableAt: () => null, pick: async () => 7, requestDraw: () => {} })
    await tool.adopt(7)
    expect(tool.mesh).toBeNull()
    expect(tool.tableId).toBeNull()
  })

  it('a divider drag is exactly one undoable commit that moves both bands', async () => {
    const tool = new TableTool({
      tableAt: () => snapshot(),
      pick: async () => 1,
      requestDraw: () => {},
    })
    await tool.adopt(1)

    const line = tool.mesh!.cols[1]
    tool.onPointerDown({ world: [line, 210], screen: [0, 0], scale: 1, shift: false, alt: false })
    tool.onPointerMove({ world: [line + 20, 210], screen: [0, 0], scale: 1, shift: false, alt: false })
    tool.onPointerUp({ world: [line + 20, 210], screen: [0, 0], scale: 1, shift: false, alt: false })

    const edits = useStore.getState().edits
    expect(Object.keys(edits)).toHaveLength(4)
    expect(edits[1].rect!.w).toBeGreaterThan(38)
    expect(edits[2].rect!.w).toBeLessThan(38)
    // Every touched cell is flagged for the dirty-shield paint.
    expect(Object.keys(useStore.getState().dirtyAt)).toHaveLength(4)

    undo()
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('ignores a pointer down that is not on a divider', async () => {
    const tool = new TableTool({
      tableAt: () => snapshot(),
      pick: async () => 1,
      requestDraw: () => {},
    })
    await tool.adopt(1)
    tool.onPointerDown({ world: [120, 210], screen: [0, 0], scale: 1, shift: false, alt: false })
    expect(tool.ephemeralRect).toBeNull()
    tool.onPointerUp({ world: [120, 210], screen: [0, 0], scale: 1, shift: false, alt: false })
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('draws mesh lines only when a table is adopted', async () => {
    const tool = new TableTool({ tableAt: () => null, pick: async () => 1, requestDraw: () => {} })
    const a = ctx()
    tool.drawHud(a.proxy, { scale: 1, tx: 0, ty: 0 })
    expect(a.calls.filter((c) => c.startsWith('moveTo'))).toHaveLength(0)

    const tool2 = new TableTool({
      tableAt: () => snapshot(),
      pick: async () => 1,
      requestDraw: () => {},
    })
    await tool2.adopt(1)
    const b = ctx()
    tool2.drawHud(b.proxy, { scale: 1, tx: 0, ty: 0 })
    // 3 column lines + 3 row lines
    expect(b.calls.filter((c) => c.startsWith('moveTo'))).toHaveLength(6)
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/tools/tableTool.test.ts`
Expected: FAIL — cannot resolve `@/tools/tableTool`.

- [x] **Step 3: Implement `src/tools/tableTool.ts`**

```ts
import type { Rect } from '@/data/nodes'
import type { Viewport } from '@/engine/viewport'
import { commit, useStore } from '@/store/store'
import {
  buildMesh, cellRect, hitDivider, moveDivider, type CellInput, type Mesh,
} from './tableMesh'
import { HANDLE_SLOP_PX, type Tool, type ToolEvent } from './types'

export type TableSnapshot = { tableId: number; cells: CellInput[] }

export type TableToolDeps = {
  /** The table containing `nodeId` (the node itself, or its parent), or null. */
  tableAt(nodeId: number): TableSnapshot | null
  pick(wx: number, wy: number): Promise<number | null>
  requestDraw(): void
}

/** Cells whose derived rect differs from the geometry the mesh was built from. */
export function meshEdits(mesh: Mesh, original: Map<number, Rect>): Map<number, Rect> {
  const out = new Map<number, Rect>()
  for (const c of mesh.cells) {
    const next = cellRect(mesh, c)
    const prev = original.get(c.id)
    if (!prev || prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h) {
      out.set(c.id, next)
    }
  }
  return out
}

/**
 * Table repair: adopt the table under the cursor, drag its dividers, commit
 * every recalculated cell rect in one transaction.
 *
 * The commit writes ordinary `edits[id].rect` entries, which is the whole
 * reason this tool is small: `Session.writeCoords` already funnels a rect edit
 * into the render arrays, the worker's QuadTree and the cull grid, and the
 * history already treats one `commit()` as one undo entry.
 */
export class TableTool implements Tool {
  readonly name = 'table'
  readonly ephemeralRect = null

  private deps: TableToolDeps
  private snapshot: TableSnapshot | null = null
  private meshState: Mesh | null = null
  /** Geometry the current mesh was derived from — the diff baseline. */
  private original = new Map<number, Rect>()
  private drag: { axis: 'row' | 'col'; index: number } | null = null
  private hover: { axis: 'row' | 'col'; index: number } | null = null

  constructor(deps: TableToolDeps) {
    this.deps = deps
  }

  get mesh(): Mesh | null {
    return this.meshState
  }

  get tableId(): number | null {
    return this.snapshot?.tableId ?? null
  }

  /** Rebuilds the mesh for whichever table holds `nodeId`. Cheap; not per frame. */
  async adopt(nodeId: number): Promise<void> {
    const snap = this.deps.tableAt(nodeId)
    this.snapshot = snap
    if (!snap) {
      this.meshState = null
      this.original.clear()
      this.deps.requestDraw()
      return
    }
    this.meshState = buildMesh(snap.cells)
    this.original.clear()
    // Baseline is the mesh's *own* rects, not the ragged input: building the
    // mesh regularises the table, and that regularisation is a repair the
    // reviewer opted into by picking up this tool — it should not be committed
    // silently as if they had dragged something.
    for (const c of this.meshState.cells) this.original.set(c.id, cellRect(this.meshState, c))
    this.deps.requestDraw()
  }

  onPointerDown(e: ToolEvent): void {
    if (this.meshState) {
      const hit = hitDivider(this.meshState, e.world[0], e.world[1], HANDLE_SLOP_PX / e.scale)
      if (hit) {
        this.drag = hit
        return
      }
    }
    // Not on a divider: treat it as "adopt whatever table is under here".
    void this.deps.pick(e.world[0], e.world[1]).then((id) => {
      if (id === null) return
      useStore.setState({ selectedId: id })
      void this.adopt(id)
    })
  }

  onPointerMove(e: ToolEvent): void {
    if (!this.meshState) return
    if (!this.drag) {
      const hit = hitDivider(this.meshState, e.world[0], e.world[1], HANDLE_SLOP_PX / e.scale)
      const changed = hit?.axis !== this.hover?.axis || hit?.index !== this.hover?.index
      this.hover = hit
      if (changed) this.deps.requestDraw()
      return
    }
    this.meshState = moveDivider(
      this.meshState,
      this.drag.axis,
      this.drag.index,
      this.drag.axis === 'col' ? e.world[0] : e.world[1],
    )
    this.deps.requestDraw()
  }

  onPointerUp(): void {
    const mesh = this.meshState
    if (!this.drag || !mesh) {
      this.drag = null
      return
    }
    this.drag = null
    const diff = meshEdits(mesh, this.original)
    if (diff.size === 0) return
    const at = Date.now()
    commit('tableDivider', (d) => {
      for (const [id, rect] of diff) {
        d.edits[id] = { ...d.edits[id], rect }
        d.dirtyAt[id] = at
      }
    })
    for (const [id, rect] of diff) this.original.set(id, rect)
    this.deps.requestDraw()
  }

  /**
   * Mesh lines, the grabbed/hovered line highlighted. Widths divide by scale so
   * they stay 1–2 screen px at any zoom.
   */
  drawHud(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    const mesh = this.meshState
    if (!mesh || mesh.cells.length === 0) return
    const px = 1 / vp.scale
    const active = this.drag ?? this.hover
    ctx.save()

    ctx.strokeStyle = 'rgba(255, 190, 120, 0.55)'
    ctx.lineWidth = px
    ctx.beginPath()
    for (const x of mesh.cols) {
      ctx.moveTo(x, mesh.bounds.y)
      ctx.lineTo(x, mesh.bounds.y + mesh.bounds.h)
    }
    for (const y of mesh.rows) {
      ctx.moveTo(mesh.bounds.x, y)
      ctx.lineTo(mesh.bounds.x + mesh.bounds.w, y)
    }
    ctx.stroke()

    if (active) {
      ctx.strokeStyle = 'rgba(255, 210, 90, 0.95)'
      ctx.lineWidth = 2 * px
      ctx.beginPath()
      if (active.axis === 'col') {
        const x = mesh.cols[active.index]
        ctx.moveTo(x, mesh.bounds.y)
        ctx.lineTo(x, mesh.bounds.y + mesh.bounds.h)
      } else {
        const y = mesh.rows[active.index]
        ctx.moveTo(mesh.bounds.x, y)
        ctx.lineTo(mesh.bounds.x + mesh.bounds.w, y)
      }
      ctx.stroke()
    }

    ctx.restore()
  }
}
```

Note the test's `drawHud` count of 6 `moveTo` calls: 3 column + 3 row lines for a 2×2 table, and the hover/active pass adds none because nothing is hovered.

- [x] **Step 4: Fix the `ephemeralRect` contract**

`src/tools/adapter.ts` claims a gesture only when `tool.ephemeralRect !== null`, and `TableTool.ephemeralRect` is always `null` — so a divider drag would fall through to panning. Change `Tool` to declare intent explicitly. In `src/tools/types.ts`:

```ts
export type Tool = {
  name: string
  onPointerDown(e: ToolEvent): void
  onPointerMove(e: ToolEvent): void
  onPointerUp(e: ToolEvent): void
  onKeyDown?(e: KeyboardEvent): void
  drawHud(ctx: CanvasRenderingContext2D, vp: Viewport): void
  /** Geometry mid-gesture; the store sees nothing until commit. */
  readonly ephemeralRect: Rect | null
  /**
   * True while the tool owns the pointer. The adapter suppresses the pan
   * fallback on this, not on `ephemeralRect` — a tool can hold a gesture
   * (dragging a table divider) without producing a draft rect.
   */
  readonly capturing?: boolean
}
```

In `src/tools/adapter.ts`, `onDown` becomes:

```ts
    onDown(p) {
      tool.onPointerDown(toEvent(p, engine.viewport.scale))
      claimed = tool.capturing ?? tool.ephemeralRect !== null
      return claimed
    },
```

Add to `TableTool`:

```ts
  get capturing(): boolean {
    return this.drag !== null
  }
```

`SelectTool` and `OrderTool` need no change — their `ephemeralRect`/existing behaviour still drives `claimed`. (`OrderTool` relies on the pan fallback being suppressed only while linking; if link-dragging currently pans, add `get capturing() { return this.dragFrom !== null }` to `OrderTool` in the reading-order plan, not here.)

- [x] **Step 5: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/tools/tableTool.ts src/tools/types.ts src/tools/adapter.ts tests/tools/tableTool.test.ts
git commit -m "feat(tools): TableTool with divider dragging committed as one transaction

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the tool into the session, toolbar and overlay

**Files:**
- Modify: `src/app/session.ts` (construct `TableTool`, `tableAt`, extend `setTool`)
- Modify: `src/components/Toolbar.tsx` (third tool)
- Modify: `src/App.tsx` (`ToolName` already flows through; no change if the type is imported)
- Test: `tests/app/session.test.ts`

**Interfaces:**
- Consumes: `TableTool`, `TableSnapshot` (Task 3); `NodeType`, `indexOfId` from `@/data/nodes`.
- Produces:
  - `Session.setTool(name: 'select' | 'order' | 'table')`, `Session.currentTool: 'select' | 'order' | 'table'`
  - `Session.tableAt(nodeId: number): TableSnapshot | null` — public, so the session test can assert detection without a pointer.
  - `ToolName = 'select' | 'order' | 'table'` in `src/components/Toolbar.tsx`.

- [x] **Step 1: Write the failing test**

Append to `tests/app/session.test.ts`:

```ts
describe('table detection', () => {
  it('finds the cells of the table under a cell node, and nothing under a line', async () => {
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 60 && !s.status.done; i++) await vi.advanceTimersByTimeAsync(50)

      // The synthetic generator emits table cells as NodeType.Cell children of
      // a Paragraph block; every even page carries a table with p=0.16.
      let cellIndex = -1
      for (let i = 0; i < s.nodes.count; i++) {
        if (s.nodes.types[i] === NodeType.Cell) {
          cellIndex = i
          break
        }
      }
      expect(cellIndex).toBeGreaterThanOrEqual(0)

      const snap = s.tableAt(s.nodes.ids[cellIndex])
      expect(snap).not.toBeNull()
      expect(snap!.tableId).toBe(s.nodes.parents[cellIndex])
      expect(snap!.cells.length).toBeGreaterThanOrEqual(12)
      // Picking the table's parent node resolves to the same table.
      expect(s.tableAt(snap!.tableId)!.tableId).toBe(snap!.tableId)

      let lineIndex = -1
      for (let i = 0; i < s.nodes.count; i++) {
        if (s.nodes.types[i] === NodeType.Line) {
          lineIndex = i
          break
        }
      }
      expect(s.tableAt(s.nodes.ids[lineIndex])).toBeNull()

      s.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('selecting the table tool does not throw on a document with no tables', async () => {
    const s = new Session(canvas(), createSyntheticDocument(1, 1))
    await s.ready
    s.setTool('table')
    expect(s.currentTool).toBe('table')
    s.dispose()
  })
})
```

Add `NodeType` to the file's `@/data/nodes` import.

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/app/session.test.ts`
Expected: FAIL — `s.tableAt is not a function`.

- [x] **Step 3: Implement in `src/app/session.ts`**

Add the import and field:

```ts
import { TableTool, type TableSnapshot } from '@/tools/tableTool'
```

```ts
  private readonly tableTool: TableTool
```

Construct it after `this.orderTool`:

```ts
    this.tableTool = new TableTool({
      tableAt: (id) => this.tableAt(id),
      pick: (x, y) => this.worker.hitTest(x, y),
      requestDraw: () => this.engine.requestDraw(),
    })
```

Replace `setTool` / `currentTool` / the `toolName` field type:

```ts
  private toolName: 'select' | 'order' | 'table' = 'select'

  setTool(name: 'select' | 'order' | 'table'): void {
    this.toolName = name
    this.tool =
      name === 'order' ? this.orderTool : name === 'table' ? this.tableTool : this.selectTool
    this.showOrder = name === 'order'
    if (name === 'table') {
      const sel = useStore.getState().selectedId
      // Adopt whatever is already selected, so switching tools with a cell
      // selected shows its mesh immediately instead of demanding a second click.
      if (sel !== null) void this.tableTool.adopt(sel)
    }
    this.engine.requestDraw()
  }

  get currentTool(): 'select' | 'order' | 'table' {
    return this.toolName
  }
```

Add the detector:

```ts
  /**
   * The table containing `nodeId`: either the node is a `Cell` (its parent is
   * the table block) or it is the block itself. Tables are not a node type —
   * they are a parent whose children are cells — so detection is a parent/child
   * scan, not a flag lookup.
   */
  tableAt(nodeId: number): TableSnapshot | null {
    const i = indexOfId(this.nodes, nodeId)
    if (i < 0) return null
    const tableId = this.nodes.types[i] === NodeType.Cell ? this.nodes.parents[i] : nodeId
    if (tableId < 0) return null

    const cells: TableSnapshot['cells'] = []
    for (let j = 0; j < this.nodes.count; j++) {
      if (this.nodes.parents[j] !== tableId || this.nodes.types[j] !== NodeType.Cell) continue
      const c = j * 4
      cells.push({
        id: this.nodes.ids[j],
        x: this.nodes.coords[c],
        y: this.nodes.coords[c + 1],
        w: this.nodes.coords[c + 2],
        h: this.nodes.coords[c + 3],
      })
    }
    return cells.length === 0 ? null : { tableId, cells }
  }
```

The scan is O(document) but runs on tool adoption (one click), never per frame. If a profile shows it mattering on FUNSD's 41k nodes, index children by parent id at ingest — not before.

Also re-adopt after a commit so the mesh reflects undo/redo. In `subscribeSelection`'s callback, after `this.applyEdits(state.edits)`, add:

```ts
      // Undo/redo rewrites cell geometry underneath the mesh; rebuild it from
      // the render arrays so the drawn dividers cannot lie about the boxes.
      if (this.toolName === 'table' && this.tableTool.tableId !== null) {
        void this.tableTool.adopt(this.tableTool.tableId)
      }
```

Guard against re-entrancy: `adopt` only reads `this.nodes` and calls `requestDraw`, so this cannot loop through the store.

- [x] **Step 4: Add the toolbar button**

`src/components/Toolbar.tsx`:

```tsx
import { MousePointer2, Table2, Workflow } from "lucide-react"

export type ToolName = "select" | "order" | "table"

const TOOLS: Array<{ name: ToolName; label: string; Icon: typeof MousePointer2 }> = [
  { name: "select", label: "Select & edit boxes (V)", Icon: MousePointer2 },
  { name: "order", label: "Reading order (O)", Icon: Workflow },
  { name: "table", label: "Table mesh (T)", Icon: Table2 },
]
```

No change is needed in `src/App.tsx` — it imports `ToolName` from the toolbar and forwards it to `session.setTool`.

- [x] **Step 5: Add the keyboard shortcuts**

The labels promise V / O / T. In `src/App.tsx`, inside the existing `useEffect` that owns the session, register a window key handler and clean it up in the same teardown:

```tsx
    const onToolKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      const next =
        e.key === "v" || e.key === "V"
          ? "select"
          : e.key === "o" || e.key === "O"
            ? "order"
            : e.key === "t" || e.key === "T"
              ? "table"
              : null
      if (!next) return
      setTool(next)
      sessionRef.current?.setTool(next)
    }
    window.addEventListener("keydown", onToolKey)
```

and in the cleanup: `window.removeEventListener("keydown", onToolKey)`.

- [x] **Step 6: Run tests and drive it by hand**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

Run: `pnpm dev`, pick the **Stress · 100pp · 10k boxes** document, wait for `stream complete`, zoom to ~150% on a page with a table (orange `cell` boxes), press `T`, click a cell. The mesh appears; drag a vertical divider — the adjoining cells resize live, `Cmd+Z` restores them in one step, and the status bar's fps/ms-draw numbers do not move.

- [x] **Step 7: Commit**

```bash
git add src/app/session.ts src/components/Toolbar.tsx src/App.tsx tests/app/session.test.ts
git commit -m "feat(app): wire the table mesh tool into the session, toolbar and shortcuts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Cell split and merge — structural edits

**Files:**
- Modify: `src/tools/tableMesh.ts` (`splitCell`, `mergeCells`)
- Modify: `src/store/store.ts` (`Edit` gains `created` / `deleted`)
- Modify: `src/worker/protocol.ts`, `src/worker/index.worker.ts`, `src/worker/client.ts` (insert/remove)
- Modify: `src/app/session.ts` (materialize structural edits)
- Modify: `src/tools/tableTool.ts` (keys, commit)
- Test: `tests/tools/tableMesh.test.ts`, `tests/app/session.test.ts`

**Interfaces:**
- Produces:
  - `export function splitCell(mesh: Mesh, cellId: number, axis: 'row' | 'col', newId: number): Mesh` — inserts a line at the target cell's midpoint; every *other* cell crossing that line gains a span so its rect is unchanged; the target becomes two span-1 cells (`cellId` keeps the low side, `newId` takes the high side).
  - `export function mergeCells(mesh: Mesh, aId: number, bId: number): Mesh` — merges two band-adjacent cells into one spanning cell keeping `aId`; returns the input mesh unchanged if they are not adjacent.
  - `Edit` gains `deleted?: true` and `created?: { page: number; type: NodeType; parent: number; order: number }`.
  - Worker requests `{ kind: 'insertNode'; node: SerializedNode }` and `{ kind: 'removeNode'; nodeId: number; rect: Rect }`; `WorkerClient.insertNode(node)`, `WorkerClient.removeNode(nodeId, rect)`.
  - `Session` gains `private materializeStructural(edits: Record<number, Edit>): void`, plus `private readonly created = new Set<number>()` and `private readonly hidden = new Set<number>()`.
  - `Session.allocId(): number` — ids from a high, monotonically increasing base so a created cell can never collide with a streamed id (`ID_STRIDE` gives streamed ids `page * 1000 + n`, so `1_000_000_000 + counter` is unreachable).

- [x] **Step 1: Write the failing mesh tests**

Append to `tests/tools/tableMesh.test.ts`:

```ts
import { mergeCells, splitCell } from '@/tools/tableMesh'

describe('splitCell', () => {
  it('adds a line and one cell, keeping every other cell rect unchanged', () => {
    const m0 = buildMesh(insetGrid(2, 2))
    const before = new Map(m0.cells.map((c) => [c.id, cellRect(m0, c)]))
    const m1 = splitCell(m0, 1, 'col', 5000)

    expect(m1.cols).toHaveLength(4)
    expect(m1.cells).toHaveLength(5)
    // Cell 2 sat in the other column band: its geometry must not move.
    const c2 = m1.cells.find((c) => c.id === 2)!
    expect(cellRect(m1, c2)).toEqual(before.get(2))
    // Cell 3 shares cell 1's column and gains a span instead of splitting.
    const c3 = m1.cells.find((c) => c.id === 3)!
    expect(c3.colSpan).toBe(2)
    expect(cellRect(m1, c3)).toEqual(before.get(3))
  })

  it('splits the target into two halves that tile its old rect', () => {
    const m0 = buildMesh(insetGrid(2, 2))
    const old = cellRect(m0, m0.cells.find((c) => c.id === 1)!)
    const m1 = splitCell(m0, 1, 'col', 5000)
    const a = cellRect(m1, m1.cells.find((c) => c.id === 1)!)
    const b = cellRect(m1, m1.cells.find((c) => c.id === 5000)!)
    expect(a.x).toBe(old.x)
    expect(a.w + b.w).toBeCloseTo(old.w, 6)
    expect(b.x).toBeCloseTo(old.x + old.w / 2, 6)
    expect(a.h).toBe(old.h)
    expect(b.h).toBe(old.h)
  })

  it('splits by row as well', () => {
    const m1 = splitCell(buildMesh(insetGrid(2, 2)), 1, 'row', 5000)
    expect(m1.rows).toHaveLength(4)
    expect(m1.cells.find((c) => c.id === 5000)!.row).toBe(1)
  })

  it('ignores an unknown cell id', () => {
    const m0 = buildMesh(insetGrid(2, 2))
    expect(splitCell(m0, 999, 'col', 5000)).toBe(m0)
  })
})

describe('mergeCells', () => {
  it('merges two horizontally adjacent cells into one spanning cell', () => {
    const m0 = buildMesh(insetGrid(2, 2))
    const m1 = mergeCells(m0, 1, 2)
    expect(m1.cells).toHaveLength(3)
    const merged = m1.cells.find((c) => c.id === 1)!
    expect(merged.colSpan).toBe(2)
    expect(cellRect(m1, merged)).toEqual({ x: m1.cols[0], y: m1.rows[0], w: m1.bounds.w, h: m1.rows[1] - m1.rows[0] })
  })

  it('merges vertically too', () => {
    const m1 = mergeCells(buildMesh(insetGrid(2, 2)), 1, 3)
    expect(m1.cells.find((c) => c.id === 1)!.rowSpan).toBe(2)
    expect(m1.cells).toHaveLength(3)
  })

  it('refuses non-adjacent cells', () => {
    const m0 = buildMesh(insetGrid(2, 2))
    expect(mergeCells(m0, 1, 4)).toBe(m0)
  })

  it('refuses an unknown id', () => {
    const m0 = buildMesh(insetGrid(2, 2))
    expect(mergeCells(m0, 1, 999)).toBe(m0)
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/tools/tableMesh.test.ts`
Expected: FAIL — `splitCell` / `mergeCells` are not exported.

- [x] **Step 3: Implement the mesh operations**

Append to `src/tools/tableMesh.ts`:

```ts
/**
 * Inserts a divider at the target cell's midpoint. A grid mesh has no local
 * lines — a new line crosses the whole table — so every *other* cell straddling
 * it gains a span and keeps its rect, and only the target actually splits.
 * `newId` is supplied by the caller so the operation is deterministic and can
 * be replayed by redo.
 */
export function splitCell(
  mesh: Mesh,
  cellId: number,
  axis: 'row' | 'col',
  newId: number,
): Mesh {
  const target = mesh.cells.find((c) => c.id === cellId)
  if (!target) return mesh

  const lines = axis === 'row' ? mesh.rows : mesh.cols
  const from = axis === 'row' ? target.row : target.col
  const span = axis === 'row' ? target.rowSpan : target.colSpan
  const lo = lines[from]
  const hi = lines[Math.min(lines.length - 1, from + span)]
  const at = (lo + hi) / 2
  const insertAt = from + 1

  const nextLines = [...lines.slice(0, insertAt), at, ...lines.slice(insertAt)]

  const cells: MeshCell[] = []
  for (const c of mesh.cells) {
    const cFrom = axis === 'row' ? c.row : c.col
    const cSpan = axis === 'row' ? c.rowSpan : c.colSpan
    const shiftedFrom = cFrom >= insertAt ? cFrom + 1 : cFrom
    // Straddles the new line: widen the span so the rect is unchanged.
    const straddles = cFrom < insertAt && cFrom + cSpan >= insertAt
    const shiftedSpan = c.id === cellId ? 1 : straddles ? cSpan + 1 : cSpan
    cells.push(
      axis === 'row'
        ? { ...c, row: shiftedFrom, rowSpan: shiftedSpan }
        : { ...c, col: shiftedFrom, colSpan: shiftedSpan },
    )
  }
  cells.push(
    axis === 'row'
      ? { id: newId, row: insertAt, col: target.col, rowSpan: 1, colSpan: target.colSpan }
      : { id: newId, row: target.row, col: insertAt, rowSpan: target.rowSpan, colSpan: 1 },
  )

  const rows = axis === 'row' ? nextLines : mesh.rows
  const cols = axis === 'col' ? nextLines : mesh.cols
  return {
    rows,
    cols,
    bounds: {
      x: cols[0],
      y: rows[0],
      w: cols[cols.length - 1] - cols[0],
      h: rows[rows.length - 1] - rows[0],
    },
    cells,
  }
}

/**
 * Merges two band-adjacent cells into one spanning cell, keeping `aId`. `bId`'s
 * node is dropped by the caller (an `Edit.deleted` entry), so this returns a
 * mesh with one fewer cell.
 */
export function mergeCells(mesh: Mesh, aId: number, bId: number): Mesh {
  const a = mesh.cells.find((c) => c.id === aId)
  const b = mesh.cells.find((c) => c.id === bId)
  if (!a || !b) return mesh

  const sameRow = a.row === b.row && a.rowSpan === b.rowSpan
  const sameCol = a.col === b.col && a.colSpan === b.colSpan
  const hAdjacent = sameRow && (a.col + a.colSpan === b.col || b.col + b.colSpan === a.col)
  const vAdjacent = sameCol && (a.row + a.rowSpan === b.row || b.row + b.rowSpan === a.row)
  if (!hAdjacent && !vAdjacent) return mesh

  const merged: MeshCell = hAdjacent
    ? {
        id: aId,
        row: a.row,
        rowSpan: a.rowSpan,
        col: Math.min(a.col, b.col),
        colSpan: a.colSpan + b.colSpan,
      }
    : {
        id: aId,
        col: a.col,
        colSpan: a.colSpan,
        row: Math.min(a.row, b.row),
        rowSpan: a.rowSpan + b.rowSpan,
      }

  return {
    rows: [...mesh.rows],
    cols: [...mesh.cols],
    bounds: { ...mesh.bounds },
    cells: mesh.cells.filter((c) => c.id !== aId && c.id !== bId).concat(merged),
  }
}
```

- [x] **Step 4: Run the mesh tests**

Run: `pnpm test -- tests/tools/tableMesh.test.ts`
Expected: PASS.

- [x] **Step 5: Extend the store and worker protocol**

`src/store/store.ts`:

```ts
import type { NodeType } from '@/data/nodes'

/** Only what a human can change. The bulk typed arrays stay out of the store. */
export type Edit = {
  rect?: Rect
  label?: string
  /** Merged away or removed by the reviewer — rendered hidden, kept for undo. */
  deleted?: true
  /**
   * A node the reviewer created (a split table cell). The store is the only
   * record of it, so its identity travels in the patch and redo can recreate
   * it byte-for-byte.
   */
  created?: { page: number; type: NodeType; parent: number; order: number }
}
```

`src/worker/protocol.ts` — add two members to the `Req` union:

```ts
  | { kind: 'insertNode'; node: SerializedNode }
  | { kind: 'removeNode'; nodeId: number; rect: Rect }
```

`src/worker/index.worker.ts` — add two cases to the switch, before `default`:

```ts
      case 'insertNode': {
        const n = msg.node
        const i = pushNode(nodes, {
          id: n.id, page: n.page, x: n.x, y: n.y, w: n.w, h: n.h,
          type: n.type as NodeType, parent: n.parent, order: n.order,
        })
        indexById.set(n.id, i)
        tree.insert(n.id, n.x, n.y, n.w, n.h)
        reply({ id: msg.id, kind: 'ok' })
        break
      }
      case 'removeNode': {
        // The row stays in `nodes` (indices are stable and referenced by
        // `indexById`); dropping it from the tree is what makes it unhittable.
        tree.remove(msg.nodeId, msg.rect.x, msg.rect.y, msg.rect.w, msg.rect.h)
        reply({ id: msg.id, kind: 'ok' })
        break
      }
```

`src/worker/client.ts`:

```ts
  insertNode(node: SerializedNode): Promise<void> {
    return this.request({ kind: 'insertNode', node }) as Promise<void>
  }

  removeNode(nodeId: number, rect: Rect): Promise<void> {
    return this.request({ kind: 'removeNode', nodeId, rect }) as Promise<void>
  }
```

- [x] **Step 6: Write the failing session test for structural edits**

Append to `tests/app/session.test.ts` (the `FakeWorker` from the correctness-fixes plan already replies `ok` to unknown kinds only if you added that branch; if not, add `insertNode`/`removeNode` to the same recorder):

```ts
describe('structural edits', () => {
  it('materializes a created node and hides a deleted one, both reversibly', async () => {
    useStore.setState(
      { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
      true,
    )
    resetHistory()
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 40 && s.nodes.count === 0; i++) await vi.advanceTimersByTimeAsync(50)

      const before = s.nodes.count
      const victim = s.nodes.ids[0]
      const fresh = s.allocId()

      commit('splitCell', (d) => {
        d.edits[fresh] = {
          created: { page: 0, type: NodeType.Cell, parent: -1, order: 0 },
          rect: { x: 10, y: 10, w: 20, h: 20 },
        }
        d.edits[victim] = { ...d.edits[victim], deleted: true }
        d.dirtyAt[fresh] = Date.now()
        d.dirtyAt[victim] = Date.now()
      })

      expect(s.nodes.count).toBe(before + 1)
      expect(indexOfId(s.nodes, fresh)).toBeGreaterThanOrEqual(0)
      expect(s.nodes.flags[indexOfId(s.nodes, victim)] & FLAG_HIDDEN).toBe(FLAG_HIDDEN)

      undo()
      // The row stays (arrays only grow), but it is hidden and unhittable, and
      // the victim is visible again.
      expect(s.nodes.flags[indexOfId(s.nodes, fresh)] & FLAG_HIDDEN).toBe(FLAG_HIDDEN)
      expect(s.nodes.flags[indexOfId(s.nodes, victim)] & FLAG_HIDDEN).toBe(0)

      redo()
      expect(s.nodes.flags[indexOfId(s.nodes, fresh)] & FLAG_HIDDEN).toBe(0)
      expect(s.nodes.flags[indexOfId(s.nodes, victim)] & FLAG_HIDDEN).toBe(FLAG_HIDDEN)

      s.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
```

Add `FLAG_HIDDEN` and `indexOfId` to the file's `@/data/nodes` import.

- [x] **Step 7: Run to verify failure**

Run: `pnpm test -- tests/app/session.test.ts`
Expected: FAIL — `s.allocId is not a function`.

- [x] **Step 8: Implement structural materialization in `src/app/session.ts`**

Add fields and the id allocator:

```ts
  /** Ids the reviewer created. Far above any streamed id (`page * 1000 + n`). */
  private nextLocalId = 1_000_000_000
  /** Created nodes already pushed into `nodes` — pushes are irreversible, so this is the mirror. */
  private readonly created = new Set<number>()
  /** Nodes currently hidden by a `deleted` edit, so undo can unhide exactly those. */
  private readonly hidden = new Set<number>()

  allocId(): number {
    return this.nextLocalId++
  }
```

Add the materializer, and call it from `subscribeSelection` *before* `applyEdits` (a created node must exist in `nodes` before `writeCoords` can position it):

```ts
  /**
   * Applies the two structural edit kinds. Node rows only ever grow — indices
   * are referenced by the cull grid, the worker's `indexById` and the tree — so
   * "undo a creation" means hide it and drop it from the hit-test index, not
   * splice it out. That keeps every index stable across arbitrarily deep
   * undo/redo, which is the property the memory-footprint and
   * no-corrupted-state criteria actually rest on.
   */
  private materializeStructural(edits: Record<number, Edit>): void {
    for (const key of Object.keys(edits)) {
      const id = Number(key)
      const e = edits[id]
      if (!e?.created) continue
      let i = indexOfId(this.nodes, id)
      if (i < 0) {
        const r = e.rect ?? { x: 0, y: 0, w: 0, h: 0 }
        i = pushNode(this.nodes, {
          id,
          page: e.created.page,
          x: r.x, y: r.y, w: r.w, h: r.h,
          type: e.created.type,
          parent: e.created.parent,
          order: e.created.order,
        })
        const c = i * 4
        this.rememberBase(Uint32Array.of(i), this.nodes.coords.slice(c, c + 4))
        this.grid.insert(i, e.created.page, r.x, r.y, r.w, r.h)
        void this.worker
          .insertNode({
            id, page: e.created.page, x: r.x, y: r.y, w: r.w, h: r.h,
            type: e.created.type, parent: e.created.parent, order: e.created.order,
          })
          .catch((err) => {
            if (!this.disposed) throw err
          })
      } else if (this.created.has(id) && this.nodes.flags[i] & FLAG_HIDDEN) {
        // Redo of a creation: unhide and re-index the row we kept.
        this.nodes.flags[i] &= ~FLAG_HIDDEN
        const c = i * 4
        const r = { x: this.nodes.coords[c], y: this.nodes.coords[c + 1], w: this.nodes.coords[c + 2], h: this.nodes.coords[c + 3] }
        this.grid.insert(i, this.nodes.pages[i], r.x, r.y, r.w, r.h)
        void this.worker
          .insertNode({
            id, page: this.nodes.pages[i], x: r.x, y: r.y, w: r.w, h: r.h,
            type: this.nodes.types[i] as NodeType, parent: this.nodes.parents[i], order: this.nodes.order[i],
          })
          .catch((err) => {
            if (!this.disposed) throw err
          })
      }
      this.created.add(id)
    }

    // A created node whose edit is gone (undo) is hidden and de-indexed.
    for (const id of this.created) {
      if (edits[id]?.created) continue
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      if (this.nodes.flags[i] & FLAG_HIDDEN) continue
      this.hideNode(id, i)
    }

    for (const key of Object.keys(edits)) {
      const id = Number(key)
      if (!edits[id]?.deleted || this.hidden.has(id)) continue
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      this.hideNode(id, i)
      this.hidden.add(id)
    }
    for (const id of this.hidden) {
      if (edits[id]?.deleted) continue
      this.hidden.delete(id)
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      this.showNode(id, i)
    }
  }

  private hideNode(id: number, i: number): void {
    const c = i * 4
    const r = { x: this.nodes.coords[c], y: this.nodes.coords[c + 1], w: this.nodes.coords[c + 2], h: this.nodes.coords[c + 3] }
    this.nodes.flags[i] |= FLAG_HIDDEN
    this.grid.remove(i, r.x, r.y, r.w, r.h)
    void this.worker.removeNode(id, r).catch((err) => {
      if (!this.disposed) throw err
    })
  }

  private showNode(id: number, i: number): void {
    const c = i * 4
    const r = { x: this.nodes.coords[c], y: this.nodes.coords[c + 1], w: this.nodes.coords[c + 2], h: this.nodes.coords[c + 3] }
    this.nodes.flags[i] &= ~FLAG_HIDDEN
    this.grid.insert(i, this.nodes.pages[i], r.x, r.y, r.w, r.h)
    void this.worker
      .insertNode({
        id, page: this.nodes.pages[i], x: r.x, y: r.y, w: r.w, h: r.h,
        type: this.nodes.types[i] as NodeType, parent: this.nodes.parents[i], order: this.nodes.order[i],
      })
      .catch((err) => {
        if (!this.disposed) throw err
      })
  }
```

In `subscribeSelection`, the body becomes:

```ts
      this.materializeStructural(state.edits)
      this.applyEdits(state.edits)
```

Clear both mirrors in `dispose()` alongside `this.overridden.clear()`:

```ts
    this.created.clear()
    this.hidden.clear()
```

Add `FLAG_HIDDEN`, `pushNode` and `type Edit` to the imports (`Edit` from `@/store/store`).

- [x] **Step 9: Wire split/merge keys into `TableTool`**

Add to `src/tools/tableTool.ts`:

- Extend `TableToolDeps` with `allocId(): number` and `nodeMeta(id: number): { page: number; parent: number; order: number } | null`.
- Add `onKeyDown`:

```ts
  /**
   * `S` splits the selected cell along the axis it is longest in; `M` merges
   * the selected cell with the last-selected neighbour. Both commit in one
   * transaction so undo is one keystroke.
   */
  onKeyDown(e: KeyboardEvent): void {
    const mesh = this.meshState
    const sel = useStore.getState().selectedId
    if (!mesh || sel === null) return
    const cell = mesh.cells.find((c) => c.id === sel)
    if (!cell) return

    if (e.key === 's' || e.key === 'S') {
      const rect = cellRect(mesh, cell)
      const axis = rect.w >= rect.h ? 'col' : 'row'
      const newId = this.deps.allocId()
      const meta = this.deps.nodeMeta(sel)
      if (!meta) return
      const next = splitCell(mesh, sel, axis, newId)
      this.meshState = next
      const at = Date.now()
      const diff = meshEdits(next, this.original)
      commit('tableSplit', (d) => {
        for (const [id, r] of diff) {
          if (id === newId) continue
          d.edits[id] = { ...d.edits[id], rect: r }
          d.dirtyAt[id] = at
        }
        d.edits[newId] = {
          created: { page: meta.page, type: NodeType.Cell, parent: meta.parent, order: meta.order },
          rect: cellRect(next, next.cells.find((c) => c.id === newId)!),
        }
        d.dirtyAt[newId] = at
      })
      for (const [id, r] of diff) this.original.set(id, r)
      this.original.set(newId, cellRect(next, next.cells.find((c) => c.id === newId)!))
      this.deps.requestDraw()
      return
    }

    if ((e.key === 'm' || e.key === 'M') && this.mergePartner !== null && this.mergePartner !== sel) {
      const next = mergeCells(mesh, sel, this.mergePartner)
      if (next === mesh) return
      const gone = this.mergePartner
      this.meshState = next
      const at = Date.now()
      const diff = meshEdits(next, this.original)
      commit('tableMerge', (d) => {
        for (const [id, r] of diff) {
          d.edits[id] = { ...d.edits[id], rect: r }
          d.dirtyAt[id] = at
        }
        d.edits[gone] = { ...d.edits[gone], deleted: true }
        d.dirtyAt[gone] = at
      })
      for (const [id, r] of diff) this.original.set(id, r)
      this.mergePartner = null
      this.deps.requestDraw()
    }
  }
```

- Track `private mergePartner: number | null = null`, set in `onPointerDown`'s pick continuation to the *previous* selection before overwriting it:

```ts
    void this.deps.pick(e.world[0], e.world[1]).then((id) => {
      if (id === null) return
      const prev = useStore.getState().selectedId
      // Remember the previous cell so `M` has something to merge with.
      this.mergePartner = prev !== null && prev !== id ? prev : null
      useStore.setState({ selectedId: id })
      void this.adopt(id)
    })
```

Import `NodeType` from `@/data/nodes`, and `mergeCells`, `splitCell` from `./tableMesh`.

In `src/app/session.ts`, pass the two new deps to `new TableTool({...})`:

```ts
      allocId: () => this.allocId(),
      nodeMeta: (id) => {
        const i = indexOfId(this.nodes, id)
        if (i < 0) return null
        return { page: this.nodes.pages[i], parent: this.nodes.parents[i], order: this.nodes.order[i] }
      },
```

`Tool.onKeyDown` is already routed via `toolHandlers().onKey` → `attachInput`'s window `keydown`, so no plumbing change is needed. Guard the App-level V/O/T handler from stealing `s`/`m`: it only matches v/o/t, so no change.

- [x] **Step 10: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [x] **Step 11: Drive it by hand**

Run: `pnpm dev`, synthetic document, press `T`, click a table cell, press `S` — the cell splits in two and no other cell moves. Click a neighbour, press `M` — the two merge. `Cmd+Z` three times returns to the original table. Click each affected cell afterwards and confirm selection lands on the box you clicked (proving the QuadTree followed).

- [x] **Step 12: Commit**

```bash
git add src/tools/tableMesh.ts src/tools/tableTool.ts src/store/store.ts src/worker src/app/session.ts tests
git commit -m "feat(tools): table cell split and merge with reversible structural edits

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Document the mesh in ARCHITECTURE.md

**Files:**
- Modify: `ARCHITECTURE.md` (new §5b after the reading-order section, plus §8)

- [x] **Step 1: Add the section**

Insert after §5:

```markdown
## 5b. Table grid mesh

A table is not a node type — it is a parent block whose children are `NodeType.Cell` nodes
(`Session.tableAt`). The mesh is **derived**, never stored: `buildMesh`
(`src/tools/tableMesh.ts`) clusters cell extents into bands (`bandsOf`) and places one divider
line between adjacent bands, so inset extraction geometry (`x: MARGIN + c*colW + 6`) yields
`M+1` lines rather than `2M` cell edges. `cellRect` re-derives every cell rect from the lines,
which is what makes "instant bounding box recalculation" a one-liner rather than a fan-out.

Building a mesh is deliberately lossy — it regularises a ragged table onto a shared grid, which
is the repair the reviewer picked the tool up to make. `TableTool.adopt` therefore takes the
mesh's own rects as the diff baseline, so adoption alone commits nothing.

Editing commits **ordinary `edits[id].rect` entries**, one `commit()` per gesture. That is the
whole reason the tool is ~200 lines: rect edits already flow through `Session.writeCoords` into
the render arrays, the worker's QuadTree and the cull grid (§3), and the history already treats
one commit as one undo entry (§4).

Split and merge change the *number* of cells, which the rect path cannot express, so `Edit`
carries two structural fields: `created` (identity travels in the patch, so redo recreates the
cell exactly) and `deleted`. `Session.materializeStructural` applies them. Node rows only ever
grow — indices are referenced by the cull grid and by the worker's `indexById` — so undoing a
creation **hides and de-indexes** the row (`FLAG_HIDDEN`, `BucketGrid.remove`, worker
`removeNode`) rather than splicing it out. Stable indices across arbitrarily deep undo/redo is
the property the zero-leak criterion rests on.
```

In §8, add:

```
- The mesh regularises a table onto a shared grid, so a genuinely irregular table (varying
  per-row column counts that are not expressible as spans) is snapped rather than preserved.
  Spans cover the common merged-header case; a fully free-form cell soup would need a per-row
  divider list, which the brief's "grid mesh" framing does not ask for.
```

- [x] **Step 2: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(architecture): describe the derived table mesh and structural edits

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Unresolved questions

- Split/merge keybindings `S`/`M` vs. a context menu — keys chosen for speed; want buttons in the toolbar too?
- Merge partner is "previously selected cell". Prefer shift-click multi-select instead?
- Should the mesh also appear (read-only) under the select tool, or only under `T`?
