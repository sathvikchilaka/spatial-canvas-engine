import { describe, expect, it, vi } from 'vitest'
import { OrderOverlay } from '@/engine/layers/overlays'
import { appendEdges, createEdgeSet, materialize } from '@/data/edges'
import { createNodeArrays, indexOfId, pushNode, NodeType } from '@/data/nodes'

function scene(n: number) {
  const nodes = createNodeArrays(n)
  for (let i = 0; i < n; i++) {
    pushNode(nodes, {
      id: i + 1, page: 0, x: i * 100, y: 0, w: 50, h: 20,
      type: NodeType.Paragraph, parent: -1, order: i,
    })
  }
  return nodes
}

function stubCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
    fillText: vi.fn(), fillRect: vi.fn(), measureText: () => ({ width: 10 }),
    strokeStyle: '', fillStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
  } as unknown as CanvasRenderingContext2D
}

function nodesWith(ids: number[]) {
  const nodes = createNodeArrays(ids.length)
  for (let i = 0; i < ids.length; i++) {
    pushNode(nodes, {
      id: ids[i], page: 0, x: i * 100, y: 0, w: 50, h: 20,
      type: NodeType.Paragraph, parent: -1, order: i,
    })
  }
  return nodes
}

function recordingContext() {
  const calls: string[] = []
  const proxy = {
    save: () => {}, restore: () => {}, beginPath: () => {}, moveTo: () => {},
    lineTo: () => {}, closePath: () => {}, stroke: () => {}, fill: () => {},
    fillText: (text: string, x: number, y: number) => calls.push(`fillText(${text},${x},${y})`),
    fillRect: () => {}, measureText: () => ({ width: 10 }),
    strokeStyle: '', fillStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
  } as unknown as CanvasRenderingContext2D
  return { calls, proxy }
}

describe('OrderOverlay', () => {
  it('draws only edges leaving a visible node', () => {
    const nodes = scene(3)
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 2, 3))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))

    const ctx = stubCtx()
    // Only node index 0 is on screen, so only edge 1→2 may be drawn.
    overlay.draw(ctx, nodes, Uint32Array.of(0), 1, 1, -1, (id) => indexOfId(nodes, id))

    expect(ctx.stroke).toHaveBeenCalledTimes(1)
  })

  it('draws nothing when no node is visible', () => {
    const nodes = scene(3)
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))

    const ctx = stubCtx()
    overlay.draw(ctx, nodes, new Uint32Array(0), 0, 1, -1, (id) => indexOfId(nodes, id))

    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('draws both edges of a node with out-degree two', () => {
    const nodes = scene(3)
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 1, 3))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))

    const ctx = stubCtx()
    overlay.draw(ctx, nodes, Uint32Array.of(0), 1, 1, -1, (id) => indexOfId(nodes, id))

    expect(ctx.stroke).toHaveBeenCalledTimes(2)
  })

  it('caps the number of arrows drawn', () => {
    const nodes = scene(500)
    const base = createEdgeSet()
    const pairs: number[] = []
    for (let i = 1; i < 500; i++) pairs.push(i, i + 1)
    appendEdges(base, Int32Array.from(pairs))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))

    const visible = Uint32Array.from({ length: 500 }, (_, i) => i)
    const ctx = stubCtx()
    overlay.draw(ctx, nodes, visible, 500, 1, -1, (id) => indexOfId(nodes, id))

    expect((ctx.stroke as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(300)
  })
})

describe('sequence badges', () => {
  it('paints the reading position, not the out-degree', () => {
    const nodes = nodesWith([10, 11, 12])
    const base = createEdgeSet()
    // 10 → 11 and 10 → 12: out-degree 2, but 10's reading position is 1.
    appendEdges(base, Int32Array.of(10, 11, 10, 12))
    const graph = materialize(base, [], [], nodes)

    const overlay = new OrderOverlay()
    overlay.setGraph(graph)
    const ctx = recordingContext()
    overlay.draw(ctx.proxy, nodes, Uint32Array.of(0, 1, 2), 3, 1, -1, (id) => indexOfId(nodes, id))

    const texts = ctx.calls
      .filter((c) => c.startsWith('fillText('))
      .map((c) => c.slice('fillText('.length).split(',')[0])
    expect(texts).toEqual(['1', '2', '3'])
  })

  it('paints nothing for a node outside the graph', () => {
    const nodes = nodesWith([10, 11, 12])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(10, 11))
    const overlay = new OrderOverlay()
    overlay.setGraph(materialize(base, [], [], nodes))
    const ctx = recordingContext()
    overlay.draw(ctx.proxy, nodes, Uint32Array.of(2), 1, 1, -1, (id) => indexOfId(nodes, id))
    expect(ctx.calls.filter((c) => c.startsWith('fillText('))).toHaveLength(0)
  })
})
