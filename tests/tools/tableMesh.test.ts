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
    // rows = [206, 220, 240, 254]: row band extents are [206,214],[226,234],[246,254],
    // so interior dividers sit at band midpoints (220, 240), not band edges. A cell
    // spanning row 0..2 therefore covers rows[0]->rows[2] = 206->240, i.e. h = 34.
    const spanning = { id: 1, row: 0, col: 0, rowSpan: 2, colSpan: 2 }
    expect(cellRect(m, spanning)).toEqual({ x: 106, y: 206, w: 88, h: 34 })
  })
})
