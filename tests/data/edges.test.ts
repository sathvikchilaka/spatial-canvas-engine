import { describe, expect, it } from 'vitest'
import { appendEdges, createEdgeSet, hasEdge, materialize } from '@/data/edges'
import { createNodeArrays, pushNode, NodeType, indexOfId } from '@/data/nodes'

function nodesOf(ids: number[]) {
  const a = createNodeArrays(ids.length)
  for (const id of ids) {
    pushNode(a, { id, page: 0, x: 0, y: 0, w: 1, h: 1, type: NodeType.Paragraph, parent: -1, order: id })
  }
  return a
}

describe('EdgeSet', () => {
  it('accumulates edges across pages', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(1, 2))
    appendEdges(set, Int32Array.of(3, 4))
    expect(set.count).toBe(2)
    expect(Array.from(set.pairs.subarray(0, 4))).toEqual([1, 2, 3, 4])
  })

  it('reports membership', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(1, 2))
    expect(hasEdge(set, 1, 2)).toBe(true)
    expect(hasEdge(set, 2, 1)).toBe(false)
  })

  it('materializes base plus added minus removed', () => {
    const nodes = nodesOf([1, 2, 3])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 2, 3))

    const eff = materialize(base, [[1, 3]], [[2, 3]], nodes)

    expect(hasEdge(eff, 1, 2)).toBe(true)
    expect(hasEdge(eff, 1, 3)).toBe(true)
    expect(hasEdge(eff, 2, 3)).toBe(false)
  })

  it('indexes adjacency by node index for the render loop', () => {
    const nodes = nodesOf([1, 2, 3])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 1, 3))

    const eff = materialize(base, [], [], nodes)

    expect(eff.adjacency.get(indexOfId(nodes, 1))).toEqual([2, 3])
    expect(eff.adjacency.has(indexOfId(nodes, 2))).toBe(false)
  })

  it('supports out-degree greater than one — a DAG, not a chain', () => {
    const nodes = nodesOf([1, 2, 3])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2, 1, 3))
    expect(materialize(base, [], [], nodes).adjacency.get(indexOfId(nodes, 1))).toHaveLength(2)
  })

  it('ignores an added edge that duplicates a base edge', () => {
    const nodes = nodesOf([1, 2])
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(1, 2))
    expect(materialize(base, [[1, 2]], [], nodes).count).toBe(1)
  })
})
