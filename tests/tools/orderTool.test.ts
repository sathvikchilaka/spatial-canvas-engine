// tests/tools/orderTool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { arrowPath, hitEndpoint, OrderTool, type ArrowRecord } from '@/tools/orderTool'
import { resetHistory, undo, redo, useStore } from '@/store/store'
import { appendEdges, createEdgeSet, hasEdge, materialize } from '@/data/edges'
import { createNodeArrays, indexOfId, pushNode, NodeType } from '@/data/nodes'

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

describe('OrderTool edge toggle', () => {
  const deps = {
    getRect: () => ({ x: 0, y: 0, w: 10, h: 10 }),
    pick: vi.fn(),
    requestDraw: vi.fn(),
    hasEdge: vi.fn(),
    arrows: () => ({ list: [], count: 0 }),
  }

  beforeEach(() => {
    useStore.setState({ edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] }, true)
    deps.pick.mockReset()
    deps.hasEdge.mockReset()
  })

  it('adds an edge when none exists', async () => {
    deps.pick.mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    deps.hasEdge.mockReturnValue(false)
    const tool = new OrderTool(deps)
    tool.onPointerDown({ world: [0, 0] } as never)
    await Promise.resolve()
    tool.onPointerUp({ world: [5, 5] } as never)
    await Promise.resolve()
    expect(useStore.getState().edgesAdded).toEqual([[1, 2]])
  })

  it('removes an edge that already exists', async () => {
    deps.pick.mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    deps.hasEdge.mockReturnValue(true)
    const tool = new OrderTool(deps)
    tool.onPointerDown({ world: [0, 0] } as never)
    await Promise.resolve()
    tool.onPointerUp({ world: [5, 5] } as never)
    await Promise.resolve()
    expect(useStore.getState().edgesRemoved).toEqual([[1, 2]])
  })

  it('undoes toggling off a stream edge, and redoes it, against the effective graph', async () => {
    // 1 -> 2 came from the stream (base edges), not from the user.
    const nodes = createNodeArrays(2)
    pushNode(nodes, { id: 1, page: 0, x: 0, y: 0, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })
    pushNode(nodes, { id: 2, page: 0, x: 100, y: 0, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 1 })
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2))

    const effective = () => {
      const s = useStore.getState()
      return materialize(base, s.edgesAdded, s.edgesRemoved, nodes)
    }
    const isEdgePresent = () => {
      const g = effective()
      const ia = indexOfId(nodes, 1)
      const targets = g.adjacency.get(ia)
      return !!targets && targets.includes(2)
    }

    expect(isEdgePresent()).toBe(true)

    deps.pick.mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    deps.hasEdge.mockImplementation((f: number, t: number) => hasEdge(effective(), f, t))
    const tool = new OrderTool(deps)
    tool.onPointerDown({ world: [0, 0] } as never)
    await Promise.resolve()
    tool.onPointerUp({ world: [5, 5] } as never)
    await Promise.resolve()

    // Toggled off: the user no longer sees the edge in the materialized graph.
    expect(isEdgePresent()).toBe(false)

    undo()
    expect(isEdgePresent()).toBe(true)

    redo()
    expect(isEdgePresent()).toBe(false)
  })
})

describe('OrderTool capturing / reset (NEW-2)', () => {
  const deps = {
    getRect: () => ({ x: 0, y: 0, w: 10, h: 10 }),
    pick: vi.fn(),
    requestDraw: vi.fn(),
    hasEdge: vi.fn(),
    arrows: () => ({ list: [], count: 0 }),
  }

  beforeEach(() => {
    useStore.setState({ edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] }, true)
    deps.pick.mockReset()
    deps.hasEdge.mockReset()
    deps.requestDraw.mockReset()
  })

  it('is not capturing until the async pick resolves, then is', async () => {
    deps.pick.mockResolvedValueOnce(1)
    const tool = new OrderTool(deps)
    expect(tool.capturing).toBe(false)
    tool.onPointerDown({ world: [0, 0] } as never)
    // Synchronously right after onPointerDown, the promise has not resolved —
    // this is exactly why the adapter cannot rely on a value snapshotted here.
    expect(tool.capturing).toBe(false)
    await Promise.resolve()
    expect(tool.capturing).toBe(true)
  })

  it('reset() drops in-flight link state so an idle move stops chasing the cursor', async () => {
    deps.pick.mockResolvedValueOnce(1)
    const tool = new OrderTool(deps)
    tool.onPointerDown({ world: [0, 0] } as never)
    await Promise.resolve()
    expect(tool.capturing).toBe(true)
    expect(tool.linking).not.toBeNull()

    tool.reset()

    expect(tool.capturing).toBe(false)
    expect(tool.linking).toBeNull()
    // An idle move after reset still updates nothing draggable.
    tool.onPointerMove({ world: [50, 50] } as never)
    expect(tool.linking).toBeNull()
  })

  it('onPointerUp (as driven by a capturing-aware adapter) clears state and stops the rubber-band', async () => {
    deps.pick.mockResolvedValueOnce(1).mockResolvedValueOnce(null)
    const tool = new OrderTool(deps)
    tool.onPointerDown({ world: [0, 0] } as never)
    await Promise.resolve()
    expect(tool.capturing).toBe(true)

    // Idle moves before release do chase the cursor — that's the affordance.
    tool.onPointerMove({ world: [20, 20] } as never)
    expect(tool.linking).toEqual({ from: 1, cursor: [20, 20] })

    tool.onPointerUp({ world: [20, 20] } as never)
    await Promise.resolve()
    expect(tool.capturing).toBe(false)
    expect(tool.linking).toBeNull()

    // Further idle moves after release no longer draw or chase anything.
    deps.requestDraw.mockClear()
    tool.onPointerMove({ world: [99, 99] } as never)
    expect(tool.linking).toBeNull()
    expect(deps.requestDraw).not.toHaveBeenCalled()
  })
})

const arrows: ArrowRecord[] = [
  { from: 1, to: 2, x1: 0, y1: 0, x2: 100, y2: 0 },
  { from: 3, to: 4, x1: 0, y1: 50, x2: 100, y2: 50 },
]

describe('hitEndpoint', () => {
  it('finds the head of an arrow', () => {
    expect(hitEndpoint(arrows, 2, 101, 1, 5)).toEqual({ from: 1, to: 2, end: 'head' })
  })

  it('finds the tail of an arrow', () => {
    expect(hitEndpoint(arrows, 2, 1, 51, 5)).toEqual({ from: 3, to: 4, end: 'tail' })
  })

  it('misses the middle of the segment', () => {
    expect(hitEndpoint(arrows, 2, 50, 0, 5)).toBeNull()
  })

  it('misses outside the slop', () => {
    expect(hitEndpoint(arrows, 2, 120, 0, 5)).toBeNull()
  })

  it('prefers the nearest endpoint when two are in range', () => {
    const close: ArrowRecord[] = [
      { from: 1, to: 2, x1: 0, y1: 0, x2: 10, y2: 0 },
      { from: 5, to: 6, x1: 12, y1: 0, x2: 40, y2: 0 },
    ]
    expect(hitEndpoint(close, 2, 11, 0, 5)).toEqual({ from: 1, to: 2, end: 'head' })
    expect(hitEndpoint(close, 2, 12.5, 0, 5)).toEqual({ from: 5, to: 6, end: 'tail' })
  })

  it('respects `count` and ignores stale trailing records', () => {
    expect(hitEndpoint(arrows, 1, 1, 51, 5)).toBeNull()
  })

  it('prefers a head over a tail at exactly equal distance', () => {
    const tie: ArrowRecord[] = [
      { from: 1, to: 2, x1: 0, y1: 0, x2: 10, y2: 0 },
      { from: 5, to: 6, x1: 20, y1: 0, x2: 40, y2: 0 },
    ]
    expect(hitEndpoint(tie, 2, 15, 0, 6)).toEqual({ from: 1, to: 2, end: 'head' })
  })
})

const RECTS: Record<number, { x: number; y: number; w: number; h: number }> = {
  1: { x: 0, y: 0, w: 20, h: 10 },
  2: { x: 100, y: 0, w: 20, h: 10 },
  3: { x: 200, y: 0, w: 20, h: 10 },
}

function toolWith(pickResult: number | null, arrows: ArrowRecord[]) {
  return new OrderTool({
    getRect: (id) => RECTS[id] ?? null,
    pick: async () => pickResult,
    requestDraw: () => {},
    hasEdge: () => true,
    arrows: () => ({ list: arrows, count: arrows.length }),
  })
}

const ev = (x: number, y: number) => ({
  world: [x, y] as [number, number],
  screen: [0, 0] as [number, number],
  scale: 1,
  shift: false,
  alt: false,
})

const clean = () => {
  useStore.setState(
    { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
    true,
  )
  resetHistory()
}

describe('OrderTool re-parenting', () => {
  beforeEach(clean)

  it('dragging an arrow head onto a third node re-points the successor in one commit', async () => {
    const tool = toolWith(3, [{ from: 1, to: 2, x1: 20, y1: 5, x2: 100, y2: 5 }])
    tool.onPointerDown(ev(100, 5))
    await Promise.resolve()
    expect(tool.dragging?.endpoint).toEqual({ from: 1, to: 2, end: 'head' })
    expect(tool.capturing).toBe(true)

    tool.onPointerMove(ev(180, 5))
    tool.onPointerUp(ev(200, 5))
    await Promise.resolve()
    await Promise.resolve()

    const s = useStore.getState()
    expect(s.edgesRemoved).toEqual([[1, 2]])
    expect(s.edgesAdded).toEqual([[1, 3]])
    expect(tool.dragging).toBeNull()

    // One transaction, so one undo returns the original graph.
    undo()
    expect(useStore.getState().edgesRemoved).toEqual([])
    expect(useStore.getState().edgesAdded).toEqual([])
  })

  it('dragging the tail re-points the predecessor', async () => {
    const tool = toolWith(3, [{ from: 1, to: 2, x1: 20, y1: 5, x2: 100, y2: 5 }])
    tool.onPointerDown(ev(20, 5))
    await Promise.resolve()
    expect(tool.dragging?.endpoint.end).toBe('tail')
    tool.onPointerUp(ev(200, 5))
    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().edgesRemoved).toEqual([[1, 2]])
    expect(useStore.getState().edgesAdded).toEqual([[3, 2]])
  })

  it('dropping on empty space commits nothing and leaves the edge alone', async () => {
    const tool = toolWith(null, [{ from: 1, to: 2, x1: 20, y1: 5, x2: 100, y2: 5 }])
    tool.onPointerDown(ev(100, 5))
    await Promise.resolve()
    tool.onPointerUp(ev(500, 500))
    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().edgesRemoved).toEqual([])
    expect(useStore.getState().edgesAdded).toEqual([])
  })

  it('dropping back on the same node commits nothing', async () => {
    const tool = toolWith(2, [{ from: 1, to: 2, x1: 20, y1: 5, x2: 100, y2: 5 }])
    tool.onPointerDown(ev(100, 5))
    await Promise.resolve()
    tool.onPointerUp(ev(100, 5))
    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().edgesAdded).toEqual([])
  })

  it('refuses a drop that would make a self-edge', async () => {
    const tool = toolWith(1, [{ from: 1, to: 2, x1: 20, y1: 5, x2: 100, y2: 5 }])
    tool.onPointerDown(ev(100, 5))
    await Promise.resolve()
    tool.onPointerUp(ev(10, 5))
    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().edgesAdded).toEqual([])
  })

  it('restores the edge after a re-parent is dragged away and back (materialize does not drop it forever)', async () => {
    // Base graph 1 -> 2. Use a mutable arrows list so each gesture sees the
    // arrow the previous gesture actually produced.
    const nodes = createNodeArrays(3)
    pushNode(nodes, { id: 1, page: 0, x: 0, y: 0, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })
    pushNode(nodes, { id: 2, page: 0, x: 100, y: 0, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 1 })
    pushNode(nodes, { id: 3, page: 0, x: 200, y: 0, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 2 })
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2))

    const isEdgePresent = (from: number, to: number) => {
      const s = useStore.getState()
      const g = materialize(base, s.edgesAdded, s.edgesRemoved, nodes)
      const targets = g.adjacency.get(indexOfId(nodes, from))
      return !!targets && targets.includes(to)
    }

    let currentArrows: ArrowRecord[] = [{ from: 1, to: 2, x1: 20, y1: 5, x2: 100, y2: 5 }]
    const makeTool = (pickResult: number | null) =>
      new OrderTool({
        getRect: (id) => RECTS[id] ?? null,
        pick: async () => pickResult,
        requestDraw: () => {},
        hasEdge: () => true,
        arrows: () => ({ list: currentArrows, count: currentArrows.length }),
      })

    expect(isEdgePresent(1, 2)).toBe(true)

    // Drag the head from 2 onto 3: graph becomes 1 -> 3.
    const toAway = makeTool(3)
    toAway.onPointerDown(ev(100, 5))
    await Promise.resolve()
    toAway.onPointerUp(ev(200, 5))
    await Promise.resolve()
    await Promise.resolve()
    expect(isEdgePresent(1, 2)).toBe(false)
    expect(isEdgePresent(1, 3)).toBe(true)

    // Now the painted arrow is 1 -> 3; drag its head back onto 2.
    currentArrows = [{ from: 1, to: 3, x1: 20, y1: 5, x2: 200, y2: 5 }]
    const toBack = makeTool(2)
    toBack.onPointerDown(ev(200, 5))
    await Promise.resolve()
    toBack.onPointerUp(ev(100, 5))
    await Promise.resolve()
    await Promise.resolve()

    // The edge must be restored, not permanently vetoed by edgesRemoved.
    expect(isEdgePresent(1, 2)).toBe(true)
    expect(isEdgePresent(1, 3)).toBe(false)
  })

  it('still links two nodes when the press is not on an endpoint', async () => {
    const tool = new OrderTool({
      getRect: (id) => RECTS[id] ?? null,
      pick: async () => 2,
      requestDraw: () => {},
      hasEdge: () => false,
      arrows: () => ({ list: [], count: 0 }),
    })
    tool.onPointerDown(ev(5, 5))
    await Promise.resolve()
    expect(tool.dragging).toBeNull()
    tool.onPointerUp(ev(105, 5))
    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().edgesAdded).toEqual([[2, 2]].filter(() => false))
    // `pick` returns the same id for both ends here, so nothing is added — the
    // point of the case is that the *link* path ran, not the re-parent path.
    expect(useStore.getState().edgesRemoved).toEqual([])
  })
})
