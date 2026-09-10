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
  /**
   * node id → 1-based reading position. Precomputed alongside `adjacency`
   * because the badge painter runs inside the frame loop and must do a map
   * lookup, not a graph walk.
   */
  sequence: Map<number, number>
}

const INITIAL = 256

export function createEdgeSet(): EdgeSet {
  return { count: 0, pairs: new Int32Array(INITIAL * 2), adjacency: new Map(), sequence: new Map() }
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
  out.sequence = sequenceNumbers(out, nodes)
  return out
}

/**
 * 1-based reading position per node id.
 *
 * The graph is a DAG in the happy case but nothing enforces that — a reviewer
 * can link a cycle, and an extraction can already contain one — so the walk is
 * an explicit-stack DFS with a visited set, and anything left unreached is
 * appended afterwards. Every node the edge set mentions gets exactly one
 * number, which is what makes the badges trustworthy.
 *
 * Ordering is fully deterministic (roots by document order then id, children by
 * id) so the same graph always renders the same numbers; a badge that shuffled
 * between frames would be worse than no badge.
 */
export function sequenceNumbers(set: EdgeSet, nodes: NodeArrays): Map<number, number> {
  const seq = new Map<number, number>()
  if (set.count === 0) return seq

  const outgoing = new Map<number, number[]>()
  const mentioned = new Set<number>()
  const hasIncoming = new Set<number>()
  for (let i = 0; i < set.count; i++) {
    const f = set.pairs[i * 2]
    const t = set.pairs[i * 2 + 1]
    mentioned.add(f)
    mentioned.add(t)
    hasIncoming.add(t)
    const list = outgoing.get(f)
    if (list) list.push(t)
    else outgoing.set(f, [t])
  }
  for (const list of outgoing.values()) list.sort((a, b) => a - b)

  const orderOf = (id: number) => {
    const i = indexOfId(nodes, id)
    return i < 0 ? Number.MAX_SAFE_INTEGER : nodes.order[i]
  }
  const roots = [...mentioned]
    .filter((id) => !hasIncoming.has(id))
    .sort((a, b) => orderOf(a) - orderOf(b) || a - b)

  let n = 0
  const visit = (start: number) => {
    const stack = [start]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (seq.has(id)) continue
      seq.set(id, ++n)
      const kids = outgoing.get(id)
      if (!kids) continue
      // Reversed so the lowest id is popped first.
      for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k])
    }
  }
  for (const r of roots) visit(r)
  // Cycles have no root; number them so no linked node is left blank.
  for (const id of [...mentioned].sort((a, b) => a - b)) if (!seq.has(id)) visit(id)

  return seq
}
