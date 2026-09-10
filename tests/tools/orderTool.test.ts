// tests/tools/orderTool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { arrowPath, hitEndpoint, OrderTool, type ArrowRecord } from '@/tools/orderTool'
import { undo, redo, useStore } from '@/store/store'
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
