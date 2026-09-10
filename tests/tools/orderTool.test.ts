// tests/tools/orderTool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { arrowPath, OrderTool } from '@/tools/orderTool'
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
