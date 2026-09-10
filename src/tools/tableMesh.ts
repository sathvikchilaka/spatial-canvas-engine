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
 * Clusters 1-D points that are within `MIN_BAND` of their neighbour, collapsing
 * near-duplicate edges (e.g. every row's column-0 left edge) into one representative
 * value per cluster.
 */
function clusterPoints(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const clusters: number[][] = []
  for (const v of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && v - last[last.length - 1] < MIN_BAND) {
      last.push(v)
    } else {
      clusters.push([v])
    }
  }
  return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length)
}

/**
 * Groups a set of cells' 1-D extents into bands, one per column/row. Cluster the
 * start edges and end edges *separately* (rather than merging overlapping full
 * extents) so a cell that already spans several bands — whose own extent overlaps
 * every band it covers — does not collapse those bands into one. This is what
 * makes inset cells (`w: colW - 12`) collapse into one band per column instead of
 * one per cell edge, while still letting `buildMesh` detect a genuinely spanning
 * cell against the un-collapsed grid.
 */
function bandsOf(extents: { lo: number; hi: number }[]): Band[] {
  if (extents.length === 0) return []
  const los = clusterPoints(extents.map((e) => e.lo))
  const his = clusterPoints(extents.map((e) => e.hi))
  const n = Math.min(los.length, his.length)
  const bands: Band[] = []
  for (let i = 0; i < n; i++) bands.push({ lo: los[i], hi: his[i] })
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
