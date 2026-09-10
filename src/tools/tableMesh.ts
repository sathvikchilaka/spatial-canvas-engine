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

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Bands are *occupancy intervals*: a new band starts only across a genuinely empty
 * gap, so two cells in the same column misaligned by any amount still overlap and
 * stay one band. No tolerance constant is involved.
 *
 * Cells wider than 1.5x the median extent are set aside first — a cell spanning two
 * bands must not merge them. (If every extent is excluded we fall back to all of them.)
 *
 * Documented limitation: cells sharing an *exact* edge (a table with no insets) touch,
 * so they land in one band. The synthetic generator always emits a 6px inset, so real
 * input separates cleanly.
 */
function bandsOf(extents: Extent[]): Band[] {
  if (extents.length === 0) return []
  const med = median(extents.map((e) => e.hi - e.lo))
  const kept = extents.filter((e) => e.hi - e.lo <= med * 1.5)
  const use = kept.length > 0 ? kept : extents

  const sorted = [...use].sort((a, b) => a.lo - b.lo)
  const bands: Band[] = [{ lo: sorted[0].lo, hi: sorted[0].hi }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = bands[bands.length - 1]
    if (sorted[i].lo > cur.hi)
      bands.push({ lo: sorted[i].lo, hi: sorted[i].hi })
    else if (sorted[i].hi > cur.hi) cur.hi = sorted[i].hi
  }
  return bands
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
