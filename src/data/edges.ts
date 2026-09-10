import { indexOfId, type NodeArrays } from './nodes'

/**
 * The reading-order graph. A directed edge set rather than a linear chain,
 * because FUNSD questions link to several answers and a chain cannot say that.
 * A synthetic document is the degenerate case: out-degree 1 everywhere.
 */
export type EdgeSet = {
  count: number
  /** [fromId, toId] at i * 2 */
  pairs: Int32Array
  /** node index → target node ids. Built once per graph change, never per frame. */
  adjacency: Map<number, number[]>
}

const INITIAL = 256

export function createEdgeSet(): EdgeSet {
  return { count: 0, pairs: new Int32Array(INITIAL * 2), adjacency: new Map() }
}

export function appendEdges(set: EdgeSet, pairs: Int32Array): void {
  const need = set.count * 2 + pairs.length
  if (need > set.pairs.length) {
    let cap = set.pairs.length || 2
    while (cap < need) cap *= 2
    const grown = new Int32Array(cap)
    grown.set(set.pairs)
    set.pairs = grown
  }
  set.pairs.set(pairs, set.count * 2)
  set.count += pairs.length / 2
}

export function hasEdge(set: EdgeSet, from: number, to: number): boolean {
  for (let i = 0; i < set.count; i++) {
    if (set.pairs[i * 2] === from && set.pairs[i * 2 + 1] === to) return true
  }
  return false
}

/**
 * base ∪ added ∖ removed, plus the adjacency the overlay draws from. Called
 * when the graph changes (an edit, a new page) — never inside the frame loop.
 */
export function materialize(
  base: EdgeSet,
  added: [number, number][],
  removed: [number, number][],
  nodes: NodeArrays,
): EdgeSet {
  const drop = new Set<string>()
  for (const [f, t] of removed) drop.add(`${f}>${t}`)

  const out = createEdgeSet()
  const seen = new Set<string>()
  const push = (f: number, t: number) => {
    const key = `${f}>${t}`
    if (drop.has(key) || seen.has(key)) return
    seen.add(key)
    appendEdges(out, Int32Array.of(f, t))
  }

  for (let i = 0; i < base.count; i++) push(base.pairs[i * 2], base.pairs[i * 2 + 1])
  for (const [f, t] of added) push(f, t)

  for (let i = 0; i < out.count; i++) {
    const fromIndex = indexOfId(nodes, out.pairs[i * 2])
    if (fromIndex < 0) continue
    const list = out.adjacency.get(fromIndex)
    if (list) list.push(out.pairs[i * 2 + 1])
    else out.adjacency.set(fromIndex, [out.pairs[i * 2 + 1]])
  }
  return out
}
