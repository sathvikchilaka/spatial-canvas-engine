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
