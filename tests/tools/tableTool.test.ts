import { beforeEach, describe, expect, it } from 'vitest'
import { buildMesh, moveDivider } from '@/tools/tableMesh'
import { TableTool, meshEdits, type TableSnapshot } from '@/tools/tableTool'
import { canUndo, resetHistory, undo, useStore } from '@/store/store'
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
    // Moving the interior column line touches every cell adjoining it on either row.
    expect([...diff.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(diff.get(1)).toEqual({ x: 106, y: 206, w: 64, h: 14 })
    expect(diff.get(2)).toEqual({ x: 170, y: 206, w: 24, h: 14 })
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
      allocId: () => 5000,
      nodeMeta: () => ({ page: 0, parent: 900, order: 0 }),
    })
    await tool.adopt(3)
    expect(tool.tableId).toBe(900)
    expect(tool.mesh?.cols).toHaveLength(3)
  })

  it('reports no mesh when the pick is not in a table', async () => {
    const tool = new TableTool({ tableAt: () => null, pick: async () => 7, requestDraw: () => {}, allocId: () => 5000, nodeMeta: () => ({ page: 0, parent: 900, order: 0 }) })
    await tool.adopt(7)
    expect(tool.mesh).toBeNull()
    expect(tool.tableId).toBeNull()
  })

  it('a divider drag is exactly one undoable commit that moves both bands', async () => {
    const tool = new TableTool({
      tableAt: () => snapshot(),
      pick: async () => 1,
      requestDraw: () => {},
      allocId: () => 5000,
      nodeMeta: () => ({ page: 0, parent: 900, order: 0 }),
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
      allocId: () => 5000,
      nodeMeta: () => ({ page: 0, parent: 900, order: 0 }),
    })
    await tool.adopt(1)
    // (120, 210) sits within 8px slop of row line y=206, which would wrongly
    // start a drag; (300, 300) is well outside the mesh bounds and every
    // line's slop, so no divider is hit.
    tool.onPointerDown({ world: [300, 300], screen: [0, 0], scale: 1, shift: false, alt: false })
    expect(tool.ephemeralRect).toBeNull()
    expect(tool.capturing).toBe(false)
    tool.onPointerUp({ world: [300, 300], screen: [0, 0], scale: 1, shift: false, alt: false })
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('does not start a drag on pointer down near a divider but releases without moving', async () => {
    const tool = new TableTool({
      tableAt: () => snapshot(),
      pick: async () => 1,
      requestDraw: () => {},
      allocId: () => 5000,
      nodeMeta: () => ({ page: 0, parent: 900, order: 0 }),
    })
    await tool.adopt(1)
    // Within 8px slop of row line y=206: a drag does start here (unlike the
    // out-of-bounds case above), but releasing without a move commits nothing.
    tool.onPointerDown({ world: [120, 210], screen: [0, 0], scale: 1, shift: false, alt: false })
    expect(tool.capturing).toBe(true)
    tool.onPointerUp({ world: [120, 210], screen: [0, 0], scale: 1, shift: false, alt: false })
    expect(tool.capturing).toBe(false)
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('draws mesh lines only when a table is adopted', async () => {
    const tool = new TableTool({ tableAt: () => null, pick: async () => 1, requestDraw: () => {}, allocId: () => 5000, nodeMeta: () => ({ page: 0, parent: 900, order: 0 }) })
    const a = ctx()
    tool.drawHud(a.proxy, { scale: 1, tx: 0, ty: 0 })
    expect(a.calls.filter((c) => c.startsWith('moveTo'))).toHaveLength(0)

    const tool2 = new TableTool({
      tableAt: () => snapshot(),
      pick: async () => 1,
      requestDraw: () => {},
      allocId: () => 5000,
      nodeMeta: () => ({ page: 0, parent: 900, order: 0 }),
    })
    await tool2.adopt(1)
    const b = ctx()
    tool2.drawHud(b.proxy, { scale: 1, tx: 0, ty: 0 })
    // 3 column lines + 3 row lines
    expect(b.calls.filter((c) => c.startsWith('moveTo'))).toHaveLength(6)
  })
})

/** No jsdom in this suite: onKeyDown only reads `key` and the modifier flags. */
const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods }) as KeyboardEvent

/** Lets the `pick` promise chain in `onPointerDown` settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('TableTool split and merge', () => {
  const mkTool = (pick: number) =>
    new TableTool({
      tableAt: () => snapshot(),
      pick: async () => pick,
      requestDraw: () => {},
      allocId: () => 5000,
      nodeMeta: () => ({ page: 0, parent: 900, order: 0 }),
    })

  it('S splits the selected cell in one undoable commit, moving no other cell', async () => {
    const tool = mkTool(1)
    useStore.setState({ selectedId: 1 })
    await tool.adopt(1)
    // Cell 1 is 44x14, so the split is along the column axis at x = 128.
    tool.onKeyDown(key('s'))

    const edits = useStore.getState().edits
    // Cells 2, 3 and 4 keep their rects, so only the target and the new cell
    // are committed: cell 1 keeps the low half, 5000 takes the high half.
    expect(Object.keys(edits)).toEqual(['1', '5000'])
    expect(edits[1].rect).toEqual({ x: 106, y: 206, w: 22, h: 14 })
    expect(edits[5000].created).toEqual({ page: 0, type: 2, parent: 900, order: 0 })
    expect(edits[5000].rect).toEqual({ x: 128, y: 206, w: 22, h: 14 })
    expect(tool.mesh!.cols).toHaveLength(4)

    expect(canUndo()).toBe(true)
    undo()
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
    expect(canUndo()).toBe(false)
  })

  it('S is a no-op without a mesh, a selection, or a cell under the selection', async () => {
    const bare = new TableTool({
      tableAt: () => null,
      pick: async () => 1,
      requestDraw: () => {},
      allocId: () => 5000,
      nodeMeta: () => ({ page: 0, parent: 900, order: 0 }),
    })
    useStore.setState({ selectedId: 1 })
    bare.onKeyDown(key('s'))
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)

    const tool = mkTool(1)
    await tool.adopt(1)
    useStore.setState({ selectedId: null })
    tool.onKeyDown(key('s'))
    // A node that is not one of this table's cells.
    useStore.setState({ selectedId: 77 })
    tool.onKeyDown(key('s'))
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('Cmd+S is left to the browser', async () => {
    const tool = mkTool(1)
    useStore.setState({ selectedId: 1 })
    await tool.adopt(1)
    tool.onKeyDown(key('s', { metaKey: true }))
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('M merges the selection with the previously selected cell in one commit', async () => {
    const tool = mkTool(2)
    useStore.setState({ selectedId: 1 })
    await tool.adopt(1)
    // Clicking cell 2 in open cell space makes cell 1 the merge partner. At
    // scale 4 the divider slop is 2 world units, so (180, 213) is nowhere near
    // a line and the click really goes to `pick`.
    tool.onPointerDown({ world: [180, 213], screen: [0, 0], scale: 4, shift: false, alt: false })
    await settle()
    expect(useStore.getState().selectedId).toBe(2)

    tool.onKeyDown(key('m'))
    const edits = useStore.getState().edits
    expect(edits[2].rect).toEqual({ x: 106, y: 206, w: 88, h: 14 })
    expect(edits[1].deleted).toBe(true)
    expect(tool.mesh!.cells).toHaveLength(3)

    // One keystroke, one undo entry — both halves of the merge come back.
    undo()
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
    expect(canUndo()).toBe(false)
  })

  it('M without a remembered partner does nothing', async () => {
    const tool = mkTool(1)
    useStore.setState({ selectedId: 1 })
    await tool.adopt(1)
    tool.onKeyDown(key('m'))
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('M refuses a non-adjacent partner', async () => {
    const tool = mkTool(4)
    useStore.setState({ selectedId: 1 })
    await tool.adopt(1)
    tool.onPointerDown({ world: [180, 229], screen: [0, 0], scale: 4, shift: false, alt: false })
    await settle()
    expect(useStore.getState().selectedId).toBe(4)
    tool.onKeyDown(key('m'))
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })
})
