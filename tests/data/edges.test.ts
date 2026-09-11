import { describe, expect, it } from 'vitest'
import { appendEdges, createEdgeSet, hasEdge, materialize, sequenceNumbers } from '@/data/edges'
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

/** Ids 10..N with ascending `order`, so root tie-breaks are testable. */
function nodesWith(ids: number[]) {
  const n = createNodeArrays(ids.length)
  ids.forEach((id, k) =>
    pushNode(n, {
      id, page: 0, x: 0, y: k * 10, w: 5, h: 5,
      type: NodeType.Line, parent: -1, order: k,
    }),
  )
  return n
}

describe('sequenceNumbers', () => {
  it('numbers a simple chain 1,2,3', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(10, 11, 11, 12))
    const seq = sequenceNumbers(set, nodesWith([10, 11, 12]))
    expect(seq.get(10)).toBe(1)
    expect(seq.get(11)).toBe(2)
    expect(seq.get(12)).toBe(3)
  })

  it('numbers a fan-out depth-first, children in ascending id', () => {
    // 10 → {12, 11}; 11 → 13. DFS order: 10, 11, 13, 12.
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(10, 12, 10, 11, 11, 13))
    const seq = sequenceNumbers(set, nodesWith([10, 11, 12, 13]))
    expect([seq.get(10), seq.get(11), seq.get(13), seq.get(12)]).toEqual([1, 2, 3, 4])
  })

  it('starts at the in-degree-0 root, not at the lowest id', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(12, 10, 10, 11))
    const seq = sequenceNumbers(set, nodesWith([10, 11, 12]))
    expect(seq.get(12)).toBe(1)
    expect(seq.get(10)).toBe(2)
    expect(seq.get(11)).toBe(3)
  })

  it('picks between two roots by document order', () => {
    // 12 and 10 are both roots; 10 has the lower `order`, so it goes first.
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(10, 11, 12, 13))
    const seq = sequenceNumbers(set, nodesWith([10, 11, 12, 13]))
    expect(seq.get(10)).toBe(1)
    expect(seq.get(11)).toBe(2)
    expect(seq.get(12)).toBe(3)
    expect(seq.get(13)).toBe(4)
  })

  it('visits a diamond once per node', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(10, 11, 10, 12, 11, 13, 12, 13))
    const seq = sequenceNumbers(set, nodesWith([10, 11, 12, 13]))
    expect(new Set(seq.values()).size).toBe(4)
    expect(seq.get(13)).toBe(3)
  })

  it('still numbers every node in a pure cycle', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(10, 11, 11, 10))
    const seq = sequenceNumbers(set, nodesWith([10, 11]))
    expect([...seq.values()].sort()).toEqual([1, 2])
  })

  it('omits nodes with no edges', () => {
    const set = createEdgeSet()
    appendEdges(set, Int32Array.of(10, 11))
    const seq = sequenceNumbers(set, nodesWith([10, 11, 12]))
    expect(seq.has(12)).toBe(false)
  })

  it('is precomputed on the materialized set', () => {
    const base = createEdgeSet()
    appendEdges(base, Int32Array.of(10, 11))
    const out = materialize(base, [[11, 12]], [], nodesWith([10, 11, 12]))
    expect(out.sequence.get(12)).toBe(3)
  })

  it('is empty for an empty graph', () => {
    expect(sequenceNumbers(createEdgeSet(), nodesWith([10])).size).toBe(0)
  })
})
