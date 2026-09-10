import { describe, it, expect } from "vitest"
import {
  buildMesh,
  cellRect,
  hitDivider,
  moveDivider,
  MIN_BAND,
  type CellInput,
  type Mesh,
} from "@/tools/tableMesh"

/** Shared invariant: derived lines are always strictly increasing. */
export function expectMonotonic(mesh: Mesh): void {
  for (let i = 1; i < mesh.rows.length; i++)
    expect(mesh.rows[i]).toBeGreaterThan(mesh.rows[i - 1])
  for (let i = 1; i < mesh.cols.length; i++)
    expect(mesh.cols[i]).toBeGreaterThan(mesh.cols[i - 1])
}

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

describe("buildMesh", () => {
  it("places one divider between adjacent bands, not one per cell edge", () => {
    const m = buildMesh(insetGrid())
    expectMonotonic(m)
    expect(m.cols).toHaveLength(3)
    expect(m.rows).toHaveLength(4)
  })

  it("anchors outer lines on the outermost cell edges", () => {
    const m = buildMesh(insetGrid())
    expectMonotonic(m)
    expect(m.cols[0]).toBe(106)
    expect(m.cols[2]).toBe(194)
    expect(m.rows[0]).toBe(206)
    expect(m.rows[3]).toBe(254)
  })

  it("puts interior lines midway between neighbouring bands", () => {
    const m = buildMesh(insetGrid())
    expectMonotonic(m)
    // band 0 ends at 144, band 1 starts at 156 → divider at 150
    expect(m.cols[1]).toBe(150)
    expect(m.rows[1]).toBe(220)
  })

  it("keeps every cell, with span 1 and its band indices", () => {
    const m = buildMesh(insetGrid())
    expectMonotonic(m)
    expect(m.cells).toHaveLength(6)
    expect(m.cells.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(m.cells[0]).toEqual({
      id: 1,
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
    })
    expect(m.cells[5]).toEqual({
      id: 6,
      row: 2,
      col: 1,
      rowSpan: 1,
      colSpan: 1,
    })
  })

  it("reports bounds as the outer lines", () => {
    const m = buildMesh(insetGrid())
    expectMonotonic(m)
    expect(m.bounds).toEqual({ x: 106, y: 206, w: 88, h: 48 })
  })

  it("detects a cell that already spans two columns", () => {
    const cells = insetGrid()
    // Widen cell 1 so it covers both column bands.
    cells[0] = { id: 1, x: 106, y: 206, w: 88, h: 14 }
    const m = buildMesh(cells)
    expectMonotonic(m)
    expect(m.cells.find((c) => c.id === 1)!.colSpan).toBe(2)
  })

  it("detects a cell that already spans two rows without drifting a divider", () => {
    const cells = insetGrid()
    // Cell 1 covers row bands 0 and 1 (206..234).
    cells[0] = { id: 1, x: 106, y: 206, w: 38, h: 28 }
    const m = buildMesh(cells)
    expectMonotonic(m)
    expect(m.cells.find((c) => c.id === 1)!.rowSpan).toBe(2)
    // The spanning cell is excluded from band definition, so the interior dividers
    // stay exactly where the unspanned rows put them (240, not 241).
    expect(m.rows).toEqual([206, 220, 240, 254])
  })

  it("keeps a ragged column in one band", () => {
    const cells = insetGrid()
    // Misalign one column-0 cell by 10px — far beyond MIN_BAND.
    cells[0] = { ...cells[0], x: cells[0].x + 10 }
    const m = buildMesh(cells)
    expectMonotonic(m)
    expect(m.cols).toHaveLength(3)
    expect(m.cells.every((c) => c.colSpan === 1)).toBe(true)
  })

  it("bounds contain every input cell when extents disagree", () => {
    const cells: CellInput[] = [
      { id: 1, x: 0, y: 0, w: 10, h: 10 },
      { id: 2, x: 5, y: 0, w: 25, h: 10 },
    ]
    const m = buildMesh(cells)
    expectMonotonic(m)
    for (const c of cells) {
      expect(m.bounds.x).toBeLessThanOrEqual(c.x)
      expect(m.bounds.y).toBeLessThanOrEqual(c.y)
      expect(m.bounds.x + m.bounds.w).toBeGreaterThanOrEqual(c.x + c.w)
      expect(m.bounds.y + m.bounds.h).toBeGreaterThanOrEqual(c.y + c.h)
    }
  })

  it("handles a single cell", () => {
    const m = buildMesh([{ id: 7, x: 10, y: 20, w: 30, h: 40 }])
    expectMonotonic(m)
    expect(m.cols).toEqual([10, 40])
    expect(m.rows).toEqual([20, 60])
    expect(m.cells).toEqual([{ id: 7, row: 0, col: 0, rowSpan: 1, colSpan: 1 }])
  })

  it("is independent of input order", () => {
    const a = buildMesh(insetGrid())
    const b = buildMesh([...insetGrid()].reverse())
    expectMonotonic(b)
    expect(b.rows).toEqual(a.rows)
    expect(b.cols).toEqual(a.cols)
  })

  it("drops non-finite cells rather than propagating NaN", () => {
    const m = buildMesh([
      ...insetGrid(),
      { id: 99, x: NaN, y: 0, w: Infinity, h: 1 },
    ])
    expectMonotonic(m)
    expect(m.cells.some((c) => c.id === 99)).toBe(false)
    expect(m.bounds).toEqual({ x: 106, y: 206, w: 88, h: 48 })
  })

  it("pins MIN_BAND as a drag constraint, not a derivation tolerance", () => {
    // Band derivation is tolerance-free (occupancy gaps), so this value only ever
    // limits what a divider drag may leave behind.
    expect(MIN_BAND).toBe(8)
  })

  it("returns an empty mesh for no cells rather than throwing", () => {
    const m = buildMesh([])
    expectMonotonic(m)
    expect(m.cells).toEqual([])
    expect(m.rows).toEqual([])
    expect(m.cols).toEqual([])
    expect(m.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it("keeps a genuinely wide column as its own band, distinct from its neighbours", () => {
    // col1 [0,50], col2 [60,110], col3 [120,270] — col3 is 3x wider than the
    // others but does not bridge a gap between any other extents, so it must
    // stay its own band rather than being excluded and swallowed into col2's.
    const cells: CellInput[] = [
      { id: 1, x: 0, y: 0, w: 50, h: 20 },
      { id: 2, x: 60, y: 0, w: 50, h: 20 },
      { id: 3, x: 120, y: 0, w: 150, h: 20 },
    ]
    const m = buildMesh(cells)
    expectMonotonic(m)
    expect(m.cols).toHaveLength(4)
    const c2 = m.cells.find((c) => c.id === 2)!
    const c3 = m.cells.find((c) => c.id === 3)!
    expect(c2.col).not.toBe(c3.col)
    // lines = [0, 55, 115, 270]: dividers sit midway between neighbouring bands,
    // so col3's true rect starts at 115 (midpoint of the 110..120 gap), not at
    // its own raw x of 120.
    expect(cellRect(m, c3)).toEqual({ x: 115, y: 0, w: 155, h: 20 })
  })

  it("distinguishes a wide column from a cell that actually spans two bands", () => {
    // Same wide col3 as above, plus a cell (id 4) that genuinely spans col1+col2.
    // The spanning cell must be removed and the col1/col2 divider restored; the
    // wide col3 must still stand alone.
    const cells: CellInput[] = [
      { id: 1, x: 0, y: 0, w: 50, h: 20 },
      { id: 2, x: 60, y: 0, w: 50, h: 20 },
      { id: 3, x: 120, y: 0, w: 150, h: 20 },
      { id: 4, x: 0, y: 0, w: 110, h: 20 },
    ]
    const m = buildMesh(cells)
    expectMonotonic(m)
    expect(m.cols).toHaveLength(4)
    const c1 = m.cells.find((c) => c.id === 1)!
    const c3 = m.cells.find((c) => c.id === 3)!
    const c4 = m.cells.find((c) => c.id === 4)!
    expect(c4.colSpan).toBe(2)
    expect(c4.col).toBe(c1.col)
    expect(c3.colSpan).toBe(1)
    expect(c3.col).not.toBe(c4.col)
    expect(cellRect(m, c3)).toEqual({ x: 115, y: 0, w: 155, h: 20 })
  })

  it("recovers nested bands under two levels of spanning cells", () => {
    // Four narrow columns A[0,10] B[20,30] C[40,50] D[60,70]. A top-level cell
    // (id 5) spans all four; a second cell (id 6) nested inside that range spans
    // only B+C. Splitting must recurse: removing id5 reveals [0,10],[20,50],[60,70],
    // and removing id6 from the middle interval reveals [20,30] and [40,50].
    const cells: CellInput[] = [
      { id: 1, x: 0, y: 0, w: 10, h: 20 },
      { id: 2, x: 20, y: 0, w: 10, h: 20 },
      { id: 3, x: 40, y: 0, w: 10, h: 20 },
      { id: 4, x: 60, y: 0, w: 10, h: 20 },
      { id: 5, x: 0, y: 0, w: 70, h: 20 },
      { id: 6, x: 20, y: 0, w: 30, h: 20 },
    ]
    const m = buildMesh(cells)
    expectMonotonic(m)
    expect(m.cols).toHaveLength(5)
    expect(m.cols).toEqual([0, 15, 35, 55, 70])
    const spanAll = m.cells.find((c) => c.id === 5)!
    const spanMid = m.cells.find((c) => c.id === 6)!
    expect(spanAll.colSpan).toBe(4)
    expect(spanAll.col).toBe(0)
    expect(spanMid.colSpan).toBe(2)
    expect(spanMid.col).toBe(1)
  })

  it("bounds contain every input cell with wide and spanning cells present", () => {
    const cells: CellInput[] = [
      { id: 1, x: 0, y: 0, w: 50, h: 20 },
      { id: 2, x: 60, y: 0, w: 50, h: 20 },
      { id: 3, x: 120, y: 0, w: 150, h: 20 },
      { id: 4, x: 0, y: 0, w: 110, h: 20 },
    ]
    const m = buildMesh(cells)
    expectMonotonic(m)
    for (const c of cells) {
      expect(m.bounds.x).toBeLessThanOrEqual(c.x)
      expect(m.bounds.y).toBeLessThanOrEqual(c.y)
      expect(m.bounds.x + m.bounds.w).toBeGreaterThanOrEqual(c.x + c.w)
      expect(m.bounds.y + m.bounds.h).toBeGreaterThanOrEqual(c.y + c.h)
    }
  })
})

describe("cellRect", () => {
  it("re-derives a cell rect from the mesh lines", () => {
    const m = buildMesh(insetGrid())
    expectMonotonic(m)
    expect(cellRect(m, m.cells[0])).toEqual({ x: 106, y: 206, w: 44, h: 14 })
  })

  it("covers the whole span of a spanning cell", () => {
    const m = buildMesh(insetGrid())
    expectMonotonic(m)
    // rows = [206, 220, 240, 254]: row band extents are [206,214],[226,234],[246,254],
    // so interior dividers sit at band midpoints (220, 240), not band edges. A cell
    // spanning row 0..2 therefore covers rows[0]->rows[2] = 206->240, i.e. h = 34.
    const spanning = { id: 1, row: 0, col: 0, rowSpan: 2, colSpan: 2 }
    expect(cellRect(m, spanning)).toEqual({ x: 106, y: 206, w: 88, h: 34 })
  })

  it("returns a zero rect on a degenerate mesh", () => {
    const empty = buildMesh([])
    expect(
      cellRect(empty, { id: 1, row: 0, col: 0, rowSpan: 1, colSpan: 1 })
    ).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    })
  })
})

describe("moveDivider", () => {
  it("moves an interior line and recalculates both neighbouring cells", () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, "col", 1, 170)
    expectMonotonic(m1)
    expect(m1.cols).toEqual([106, 170, 194])
    expect(cellRect(m1, m1.cells[0])).toEqual({ x: 106, y: 206, w: 64, h: 14 })
    expect(cellRect(m1, m1.cells[1])).toEqual({ x: 170, y: 206, w: 24, h: 14 })
  })

  it("does not mutate the input mesh", () => {
    const m0 = buildMesh(insetGrid())
    moveDivider(m0, "col", 1, 170)
    expect(m0.cols[1]).toBe(150)
  })

  it("clamps against the previous neighbour", () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, "col", 1, 0)
    expectMonotonic(m1)
    expect(m1.cols[1]).toBe(106 + MIN_BAND)
  })

  it("clamps against the next neighbour", () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, "col", 1, 9999)
    expectMonotonic(m1)
    expect(m1.cols[1]).toBe(194 - MIN_BAND)
  })

  it("lets an outer line grow the table", () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, "row", 3, 300)
    expectMonotonic(m1)
    expect(m1.rows[3]).toBe(300)
    expect(m1.bounds.h).toBe(94)
  })

  it("clamps an outer line against its only neighbour", () => {
    const m0 = buildMesh(insetGrid())
    const m1 = moveDivider(m0, "row", 0, 9999)
    expectMonotonic(m1)
    expect(m1.rows[0]).toBe(220 - MIN_BAND)
  })

  it("ignores an out-of-range index", () => {
    const m0 = buildMesh(insetGrid())
    expect(moveDivider(m0, "col", 99, 10)).toBe(m0)
  })
})

describe("hitDivider", () => {
  it("finds a line within screen-constant slop", () => {
    const m = buildMesh(insetGrid())
    expect(hitDivider(m, 151, 230, 4)).toEqual({ axis: "col", index: 1 })
    expect(hitDivider(m, 130, 221, 4)).toEqual({ axis: "row", index: 1 })
  })

  it("misses outside the table bounds", () => {
    const m = buildMesh(insetGrid())
    expect(hitDivider(m, 150, 900, 4)).toBeNull()
    expect(hitDivider(m, 900, 220, 4)).toBeNull()
  })

  it("returns null in open cell space", () => {
    const m = buildMesh(insetGrid())
    // Brief used wy=210, which is exactly 4px (the slop) from rows[0]=206 —
    // a boundary hit, not a miss. Moved to 213 so the point is unambiguously
    // >4px from every line (rows: 7/7/33/47, cols: 14/30/74), preserving the
    // "open cell space" intent without relying on a <= tie.
    expect(hitDivider(m, 120, 213, 4)).toBeNull()
  })
})
