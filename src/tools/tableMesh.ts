import type { Rect } from "@/data/nodes"

/** A cell's place in the mesh. Geometry is always re-derived via `cellRect`. */
export type MeshCell = {
  id: number
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

/**
 * A table as N+1 horizontal and M+1 vertical divider lines, in world units.
 * Deliberately *lossy*: building a mesh regularises a ragged extraction onto a
 * shared grid, which is the repair the reviewer is here to make. Cell rects are
 * therefore derived from the lines (`cellRect`), never stored per cell.
 */
export type Mesh = {
  rows: number[]
  cols: number[]
  bounds: Rect
  cells: MeshCell[]
}

export type CellInput = {
  id: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * Smallest band a divider drag may leave behind, world units.
 *
 * This is a *drag constraint* only. Band derivation below is tolerance-free — it
 * uses occupancy gaps, not a misalignment threshold — so tuning this constant can
 * never silently change how a mesh is derived.
 */
export const MIN_BAND = 8

type Band = { lo: number; hi: number }
type Extent = { lo: number; hi: number }

function emptyMesh(): Mesh {
  return { rows: [], cols: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, cells: [] }
}

/**
 * Merges extents into occupancy intervals: a new interval starts only across a
 * genuinely empty gap, so two extents that overlap at all — however slightly —
 * stay in one interval. No tolerance constant is involved.
 */
function occupancy(extents: Extent[]): Band[] {
  if (extents.length === 0) return []
  const sorted = [...extents].sort((a, b) => a.lo - b.lo)
  const bands: Band[] = [{ lo: sorted[0].lo, hi: sorted[0].hi }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = bands[bands.length - 1]
    if (sorted[i].lo > cur.hi)
      bands.push({ lo: sorted[i].lo, hi: sorted[i].hi })
    else if (sorted[i].hi > cur.hi) cur.hi = sorted[i].hi
  }
  return bands
}

/**
 * Tries to split one occupancy interval. Finds the extents that *cover* it —
 * span essentially its whole width — and removes them; if what remains still
 * spans the full interval (no gap revealed), the covering extents were not
 * bridging anything and the interval is genuine, so it is kept whole. If the
 * remaining extents' own occupancy breaks into two or more sub-intervals, the
 * covering extents were bridging a real gap: recurse on each sub-interval,
 * built only from the (strictly smaller) remaining set so recursion always
 * terminates.
 *
 * "Covers essentially the whole interval" uses a small relative allowance,
 * not exact equality: real extraction geometry has sub-pixel slop, so an
 * extent that is the interval's true covering column/row may miss the
 * interval's exact lo/hi by a fraction of a pixel. Exact equality would treat
 * that as "not covering" and misclassify an ordinary wide column as a split.
 */
function splitInterval(interval: Band, extents: Extent[]): Band[] {
  const width = interval.hi - interval.lo
  const eps = width * 1e-6
  const inInterval = extents.filter(
    (e) => e.lo < interval.hi && e.hi > interval.lo
  )
  const covering = inInterval.filter(
    (e) => e.lo <= interval.lo + eps && e.hi >= interval.hi - eps
  )
  if (covering.length === 0) return [interval]

  const remaining = inInterval.filter((e) => !covering.includes(e))
  if (remaining.length === 0) return [interval]

  const subBands = occupancy(remaining)
  if (subBands.length < 2) return [interval]

  return subBands.flatMap((b) => splitInterval(b, remaining))
}

/**
 * Bands are occupancy intervals, recursively split wherever a covering extent
 * turns out to be bridging a real gap between other extents (see
 * `splitInterval`). A cell spanning two bands is distinguished from a
 * genuinely wide cell structurally — by whether removing it reveals an
 * interior gap — never by comparing widths.
 *
 * Documented limitation: cells sharing an *exact* edge (a table with no insets) touch,
 * so they land in one band. The synthetic generator always emits a 6px inset, so real
 * input separates cleanly.
 */
function bandsOf(extents: Extent[]): Band[] {
  if (extents.length === 0) return []
  const top = occupancy(extents)
  return top.flatMap((b) => splitInterval(b, extents))
}

/** Outer edges of the outermost bands, interior lines midway between bands. */
function linesOf(bands: Band[]): number[] {
  if (bands.length === 0) return []
  const lines = [bands[0].lo]
  for (let i = 1; i < bands.length; i++)
    lines.push((bands[i - 1].hi + bands[i].lo) / 2)
  lines.push(bands[bands.length - 1].hi)
  return lines
}

/**
 * A cell occupies every band whose midpoint falls inside its extent; the placement is
 * the first such band and the span is the count. Degenerate extents that occupy no
 * band fall back to the nearest band, span 1.
 */
function placeIn(
  bands: Band[],
  lo: number,
  hi: number
): { index: number; span: number } {
  let first = -1
  let count = 0
  for (let i = 0; i < bands.length; i++) {
    const mid = (bands[i].lo + bands[i].hi) / 2
    if (mid >= lo && mid <= hi) {
      if (first < 0) first = i
      count++
    }
  }
  if (first >= 0) return { index: first, span: count }

  const c = (lo + hi) / 2
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < bands.length; i++) {
    const mid = (bands[i].lo + bands[i].hi) / 2
    const d = Math.abs(mid - c)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return { index: best, span: 1 }
}

function finite(c: CellInput): boolean {
  return (
    Number.isFinite(c.x) &&
    Number.isFinite(c.y) &&
    Number.isFinite(c.w) &&
    Number.isFinite(c.h)
  )
}

/** Derives the divider grid from a table's cell geometry. */
export function buildMesh(input: CellInput[]): Mesh {
  const cells = input.filter(finite)
  if (cells.length === 0) return emptyMesh()

  const colBands = bandsOf(cells.map((c) => ({ lo: c.x, hi: c.x + c.w })))
  const rowBands = bandsOf(cells.map((c) => ({ lo: c.y, hi: c.y + c.h })))
  const cols = linesOf(colBands)
  const rows = linesOf(rowBands)

  const placed: MeshCell[] = cells.map((c) => {
    const h = placeIn(colBands, c.x, c.x + c.w)
    const v = placeIn(rowBands, c.y, c.y + c.h)
    return {
      id: c.id,
      row: v.index,
      col: h.index,
      rowSpan: v.span,
      colSpan: h.span,
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
  if (mesh.cols.length < 2 || mesh.rows.length < 2)
    return { x: 0, y: 0, w: 0, h: 0 }
  const x0 = mesh.cols[cell.col]
  const y0 = mesh.rows[cell.row]
  const x1 = mesh.cols[Math.min(mesh.cols.length - 1, cell.col + cell.colSpan)]
  const y1 = mesh.rows[Math.min(mesh.rows.length - 1, cell.row + cell.rowSpan)]
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
