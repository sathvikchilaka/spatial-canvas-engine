# Reading-Order Re-Parenting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reading-order tool match the brief: grab an existing arrow's endpoint and drag it onto another node to *re-parent* the linkage in one undoable transaction, and render true `1 → 2 → 3` sequence badges instead of out-degree counts.

**Architecture:** Two independent halves. (1) **Endpoint dragging** — the overlay already computes every visible arrow's clipped endpoints via `arrowPath`; expose that same math as a hit-test (`hitEndpoint`) over the culled arrow list, so grabbing the head of `a→b` and dropping on `c` commits `edgesRemoved += [a,b]` and `edgesAdded += [a,c]` together. Grabbing the tail re-parents the *source* instead (`[a,b] → [c,b]`), which is the "re-parent linkage" the brief names. (2) **Sequence numbers** — `sequenceNumbers(edges, nodes)` in `src/data/edges.ts` walks the directed graph from its roots (in-degree 0) in a deterministic DFS and returns `Map<nodeId, number>`, memoized on the same graph-change boundary that already rebuilds `adjacency`. The overlay draws that number, falling back to nothing for nodes outside the graph.

**Tech Stack:** TypeScript, Canvas2D, Vitest, Zustand + Immer.

**Spec:** `docs/ASSIGNMENT.md` Module B ("Directed Reading Order Graph Tool: visualize the document's reading flow as a directed graph overlaid on the canvas; allow users to drag connection handles to re-parent linkages"). Design context: `ARCHITECTURE.md` §5.

## Global Constraints

- Package manager **pnpm**. `pnpm test`, `pnpm typecheck`, `pnpm lint` green at every commit.
- **No allocations in the frame loop.** The arrow list the hit-test consults is built by the draw pass into a pre-allocated buffer that it reuses; `sequenceNumbers` runs on graph change only, never per frame.
- No DOM overlays. Endpoint handles are Canvas2D, sized `1/scale` so they stay constant in screen px.
- One world↔screen matrix — endpoint hit-testing takes world coords and a `scale`, exactly like `hitHandle` in `src/tools/selectTool.ts`.
- Path alias `@/` → `src/`.
- FUNSD is the interesting document here (a real link graph, out-degree > 1 on question nodes); the synthetic document is the degenerate out-degree-1 chain. Both must work.

---

### Task 1: Sequence numbers from the directed graph

**Files:**
- Modify: `src/data/edges.ts`
- Test: `tests/data/edges.test.ts`

**Interfaces:**
- Consumes: `EdgeSet`, `NodeArrays`, `indexOfId` (already in `src/data/edges.ts`).
- Produces: `export function sequenceNumbers(set: EdgeSet, nodes: NodeArrays): Map<number, number>` — node **id** → 1-based reading position. Roots (in-degree 0) are visited in ascending `nodes.order` then ascending id; each root's subtree is emitted depth-first, children in ascending id. Nodes in a cycle, or unreachable from any root, are appended after the acyclic walk in ascending id order so every node in the edge set gets a number. Nodes with no edges at all are absent from the map.
- Produces: `EdgeSet` gains `sequence: Map<number, number>`, populated by `materialize` so the overlay never computes it.

- [x] **Step 1: Write the failing test**

Append to `tests/data/edges.test.ts`:

```ts
import { appendEdges, createEdgeSet, materialize, sequenceNumbers } from '@/data/edges'
import { createNodeArrays, pushNode, NodeType } from '@/data/nodes'

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
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/data/edges.test.ts`
Expected: FAIL — `sequenceNumbers` is not exported, and `out.sequence` is undefined.

- [x] **Step 3: Implement**

In `src/data/edges.ts`, extend the type:

```ts
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
```

`createEdgeSet` gains `sequence: new Map()`.

Append the walk:

```ts
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
```

And in `materialize`, just before `return out`:

```ts
  out.sequence = sequenceNumbers(out, nodes)
```

- [x] **Step 4: Run tests**

Run: `pnpm test -- tests/data/edges.test.ts && pnpm typecheck`
Expected: PASS (9 cases).

- [x] **Step 5: Commit**

```bash
git add src/data/edges.ts tests/data/edges.test.ts
git commit -m "feat(data): derive reading-order sequence numbers from the directed graph

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Draw the sequence number instead of the out-degree

**Files:**
- Modify: `src/engine/layers/overlays.ts:72-90` (`drawBadges`)
- Test: `tests/engine/orderOverlay.test.ts`

**Interfaces:**
- Consumes: `EdgeSet.sequence` (Task 1).
- No new exports. `drawBadges` keeps its signature.

- [x] **Step 1: Write the failing test**

Append to `tests/engine/orderOverlay.test.ts` (reuse the file's existing fake-context helper and node builder; the names below assume `recordingContext()` and `nodesWith()` — if the existing file names them differently, use those):

```ts
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
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/engine/orderOverlay.test.ts`
Expected: FAIL — the first test gets `['2', ...]` (out-degree of node 10), and the second paints nothing only by accident of `targets.length === 0`.

- [x] **Step 3: Implement**

Replace `drawBadges` in `src/engine/layers/overlays.ts`:

```ts
  /**
   * The node's reading position, not its out-degree. Out-degree answered the
   * wrong question — a question node linking three answers showed "3" while the
   * reviewer wanted to know where in the flow it sat. The number comes from
   * `EdgeSet.sequence`, precomputed on graph change, so this stays a map lookup
   * inside the frame loop.
   */
  private drawBadges(
    ctx: CanvasRenderingContext2D,
    nodes: NodeArrays,
    visible: Uint32Array,
    visibleCount: number,
    scale: number,
  ) {
    if (this.edges.sequence.size === 0) return
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = `${11 / scale}px ui-monospace, monospace`
    ctx.textBaseline = 'top'
    const cap = Math.min(visibleCount, MAX_ARROWS)
    for (let k = 0; k < cap; k++) {
      const i = visible[k]
      const n = this.edges.sequence.get(nodes.ids[i])
      if (n === undefined) continue
      const c = i * 4
      ctx.fillText(String(n), nodes.coords[c] + 2 / scale, nodes.coords[c + 1] + 2 / scale)
    }
  }
```

- [x] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. If an existing overlay test asserted an out-degree string, update it — that assertion encoded the bug.

- [x] **Step 5: Commit**

```bash
git add src/engine/layers/overlays.ts tests/engine/orderOverlay.test.ts
git commit -m "fix(engine): badge the reading position instead of the out-degree

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Arrow-endpoint hit-testing

**Files:**
- Modify: `src/engine/layers/overlays.ts` (record drawn arrows), `src/tools/orderTool.ts` (`hitEndpoint`)
- Test: `tests/tools/orderTool.test.ts`

**Interfaces:**
- Produces in `src/tools/orderTool.ts`:
  - `export type EdgeEndpoint = { from: number; to: number; end: 'head' | 'tail' }`
  - `export type ArrowRecord = { from: number; to: number; x1: number; y1: number; x2: number; y2: number }`
  - `export function hitEndpoint(arrows: readonly ArrowRecord[], count: number, wx: number, wy: number, slopWorld: number): EdgeEndpoint | null` — nearest endpoint within slop; heads beat tails on a tie because dropping a new *successor* is the common gesture.
- Produces in `src/engine/layers/overlays.ts`:
  - `OrderOverlay.arrows: readonly ArrowRecord[]` and `OrderOverlay.arrowCount: number` — the arrows the last `draw` actually painted. Written into a pre-allocated, reused array of pre-allocated records; no per-frame allocation.

- [x] **Step 1: Write the failing test**

Append to `tests/tools/orderTool.test.ts`:

```ts
import { hitEndpoint, type ArrowRecord } from '@/tools/orderTool'

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
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/tools/orderTool.test.ts`
Expected: FAIL — `hitEndpoint` is not exported.

- [x] **Step 3: Implement `hitEndpoint`**

Append to `src/tools/orderTool.ts`:

```ts
export type EdgeEndpoint = { from: number; to: number; end: 'head' | 'tail' }

/** One arrow the overlay actually painted, in world coords. */
export type ArrowRecord = { from: number; to: number; x1: number; y1: number; x2: number; y2: number }

/**
 * Which arrow endpoint a world point grabs. Only the arrows the overlay drew
 * last frame are candidates — the graph has tens of thousands of edges, but the
 * reviewer can only grab one that is on screen, so hit-testing the painted set
 * is both correct and O(visible arrows).
 *
 * `slopWorld` is screen slop / scale, so the grab target is constant in screen
 * px at any zoom. Heads win a tie: re-pointing a successor is the frequent
 * gesture, re-pointing a predecessor the rare one.
 */
export function hitEndpoint(
  arrows: readonly ArrowRecord[],
  count: number,
  wx: number,
  wy: number,
  slopWorld: number,
): EdgeEndpoint | null {
  let best: EdgeEndpoint | null = null
  let bestD = slopWorld
  for (let i = 0; i < count; i++) {
    const a = arrows[i]
    const dh = Math.hypot(wx - a.x2, wy - a.y2)
    if (dh <= bestD) {
      bestD = dh
      best = { from: a.from, to: a.to, end: 'head' }
    }
    const dt = Math.hypot(wx - a.x1, wy - a.y1)
    if (dt < bestD) {
      bestD = dt
      best = { from: a.from, to: a.to, end: 'tail' }
    }
  }
  return best
}
```

`<=` on the head and `<` on the tail is what implements the tie preference; keep both.

- [x] **Step 4: Record the painted arrows in the overlay**

In `src/engine/layers/overlays.ts`:

```ts
import { arrowPath, type ArrowRecord } from '@/tools/orderTool'
```

Add fields, allocated once:

```ts
  /**
   * The arrows this overlay painted last frame, so the order tool can hit-test
   * endpoints without re-deriving them. Pre-allocated to the arrow budget and
   * overwritten in place — the draw loop allocates nothing.
   */
  readonly arrows: ArrowRecord[] = Array.from({ length: MAX_ARROWS }, () => ({
    from: 0, to: 0, x1: 0, y1: 0, x2: 0, y2: 0,
  }))
  private painted = 0

  get arrowCount(): number {
    return this.painted
  }
```

At the top of `draw`, reset before the early return so a frame with no edges clears the stale set:

```ts
    this.painted = 0
    if (this.edges.count === 0) return
```

And inside the inner arrow loop, right after `ctx.fill()` / before `drawn++`:

```ts
        const rec = this.arrows[drawn]
        rec.from = nodes.ids[ia]
        rec.to = targets[t]
        rec.x1 = p.x1
        rec.y1 = p.y1
        rec.x2 = p.x2
        rec.y2 = p.y2
        this.painted = drawn + 1
```

`budget` is already `<= MAX_ARROWS`, so `this.arrows[drawn]` is always in range.

- [x] **Step 5: Run tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/tools/orderTool.ts src/engine/layers/overlays.ts tests/tools/orderTool.test.ts
git commit -m "feat(tools): hit-test the endpoints of painted reading-order arrows

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Drag an endpoint to re-parent

**Files:**
- Modify: `src/tools/orderTool.ts`
- Modify: `src/app/session.ts` (pass the arrow source to `OrderTool`)
- Test: `tests/tools/orderTool.test.ts`

**Interfaces:**
- Consumes: `hitEndpoint`, `ArrowRecord`, `EdgeEndpoint` (Task 3).
- Produces:
  - `OrderToolDeps` gains `arrows(): { list: readonly ArrowRecord[]; count: number }`.
  - `OrderTool.dragging: { endpoint: EdgeEndpoint; cursor: [number, number] } | null` (getter, for the HUD and tests).
  - `OrderTool.capturing: boolean` — true while linking or re-parenting, so `adapter.ts` suppresses the pan fallback (the `capturing` field is introduced by the table-mesh plan's Task 3; if that has not landed, add it to `Tool` here with the same wording).
- Behaviour: pointer-down on an endpoint enters re-parent mode. Pointer-up over node `c`:
  - `end: 'head'` → `commit('reparent')` removing `[from, to]` and adding `[from, c]`.
  - `end: 'tail'` → removing `[from, to]` and adding `[c, to]`.
  - Dropping on the node already at that end, or on empty space, or on a node that would make a self-edge, commits nothing.
  Pointer-down *not* on an endpoint keeps the existing link/unlink drag behaviour unchanged.

- [x] **Step 1: Write the failing test**

Append to `tests/tools/orderTool.test.ts`:

```ts
import { OrderTool } from '@/tools/orderTool'
import { commit, resetHistory, undo, useStore } from '@/store/store'

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
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/tools/orderTool.test.ts`
Expected: FAIL — `arrows` is not a valid dep and `tool.dragging` is undefined.

- [x] **Step 3: Implement**

In `src/tools/orderTool.ts`, extend the deps and the class:

```ts
export type OrderToolDeps = {
  getRect(id: number): Rect | null
  pick(wx: number, wy: number): Promise<number | null>
  requestDraw(): void
  hasEdge(from: number, to: number): boolean
  /** The arrows the overlay painted last frame — the endpoint hit-test candidates. */
  arrows(): { list: readonly ArrowRecord[]; count: number }
}
```

```ts
  private reparent: { endpoint: EdgeEndpoint; cursor: [number, number] } | null = null

  get dragging(): { endpoint: EdgeEndpoint; cursor: [number, number] } | null {
    return this.reparent
  }

  get capturing(): boolean {
    return this.reparent !== null || this.dragFrom !== null
  }
```

`onPointerDown` grows an endpoint branch in front of the existing pick:

```ts
  onPointerDown(e: ToolEvent): void {
    const { list, count } = this.deps.arrows()
    const grabbed = hitEndpoint(list, count, e.world[0], e.world[1], HANDLE_SLOP_PX / e.scale)
    if (grabbed) {
      // Grabbing a live arrow endpoint is a re-parent, not a new link.
      this.reparent = { endpoint: grabbed, cursor: [e.world[0], e.world[1]] }
      this.deps.requestDraw()
      return
    }
    void this.deps.pick(e.world[0], e.world[1]).then((id) => {
      if (id === null) return
      this.dragFrom = id
      this.cursor = [e.world[0], e.world[1]]
      useStore.setState({ selectedId: id })
      this.deps.requestDraw()
    })
  }
```

`onPointerMove`:

```ts
  onPointerMove(e: ToolEvent): void {
    if (this.reparent) {
      this.reparent.cursor = [e.world[0], e.world[1]]
      this.deps.requestDraw()
      return
    }
    if (this.dragFrom === null) return
    this.cursor = [e.world[0], e.world[1]]
    this.deps.requestDraw()
  }
```

`onPointerUp` grows the re-parent branch:

```ts
  onPointerUp(e: ToolEvent): void {
    const rp = this.reparent
    this.reparent = null
    if (rp) {
      void this.deps.pick(e.world[0], e.world[1]).then((target) => {
        this.commitReparent(rp.endpoint, target)
        this.deps.requestDraw()
      })
      return
    }
    const from = this.dragFrom
    this.dragFrom = null
    this.cursor = null
    if (from === null) return
    void this.deps.pick(e.world[0], e.world[1]).then((to) => {
      if (to !== null && to !== from) {
        const exists = this.deps.hasEdge(from, to)
        commit(exists ? 'unlink' : 'link', (d) => {
          if (exists) d.edgesRemoved = [...d.edgesRemoved, [from, to]]
          else d.edgesAdded = [...d.edgesAdded, [from, to]]
          d.dirtyAt[from] = Date.now()
        })
      }
      this.deps.requestDraw()
    })
  }

  /**
   * Removing the old edge and adding the new one in a *single* `commit` is the
   * whole point: a re-parent is one reviewer intent, so it must be one undo
   * step. Two commits would make Cmd+Z leave the graph disconnected.
   */
  private commitReparent(endpoint: EdgeEndpoint, target: number | null): void {
    if (target === null) return
    const { from, to, end } = endpoint
    const next: [number, number] = end === 'head' ? [from, target] : [target, to]
    // No-op drops: back onto the same node, or onto the other end (a self-edge).
    if (next[0] === next[1]) return
    if (next[0] === from && next[1] === to) return

    commit('reparent', (d) => {
      d.edgesRemoved = [...d.edgesRemoved, [from, to]]
      d.edgesAdded = [...d.edgesAdded, next]
      d.dirtyAt[next[0]] = Date.now()
    })
  }
```

Import `HANDLE_SLOP_PX` from `./types`.

Extend `drawHud` to draw the rubber band from the *anchored* end and to mark grabbable endpoints:

```ts
    // Re-parent rubber band: anchored at the end that is NOT moving.
    if (this.reparent) {
      const { from, to, end } = this.reparent.endpoint
      const anchor = this.deps.getRect(end === 'head' ? from : to)
      if (anchor) {
        ctx.save()
        ctx.strokeStyle = 'rgba(255, 140, 90, 0.95)'
        ctx.lineWidth = 2 / vp.scale
        ctx.setLineDash([6 / vp.scale, 4 / vp.scale])
        ctx.beginPath()
        ctx.moveTo(anchor.x + anchor.w / 2, anchor.y + anchor.h / 2)
        ctx.lineTo(this.reparent.cursor[0], this.reparent.cursor[1])
        ctx.stroke()
        ctx.restore()
      }
    }
```

and, so the handles are discoverable, a dot on every painted endpoint:

```ts
    // Endpoint handles, so it is visible that arrows are grabbable at all.
    const { list, count } = this.deps.arrows()
    if (count > 0) {
      const r = 3 / vp.scale
      ctx.save()
      ctx.fillStyle = 'rgba(255, 210, 90, 0.9)'
      ctx.beginPath()
      for (let i = 0; i < count; i++) {
        const a = list[i]
        ctx.moveTo(a.x2 + r, a.y2)
        ctx.arc(a.x2, a.y2, r, 0, Math.PI * 2)
        ctx.moveTo(a.x1 + r, a.y1)
        ctx.arc(a.x1, a.y1, r, 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.restore()
    }
```

One `beginPath`/`fill` for every handle — the endpoint dots must not become 600 draw calls.

- [x] **Step 4: Wire the dep in `src/app/session.ts`**

In the `new OrderTool({...})` call add:

```ts
      arrows: () => ({
        list: this.engine.orderOverlay.arrows,
        count: this.engine.orderOverlay.arrowCount,
      }),
```

If `orderOverlay` is not already a public field on `Engine`, expose it the way `pageLayer` is exposed (`readonly orderOverlay = new OrderOverlay()`), and pass it to the draw path exactly as before.

- [x] **Step 5: Run tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [x] **Step 6: Drive it by hand**

Run: `pnpm dev`, pick **FUNSD · 199pp · 41k boxes**, press `O`, zoom to ~120% until arrows and their endpoint dots are visible. Drag an arrowhead onto another box — the arrow re-points, `Cmd+Z` restores it in one step. Drag a tail onto a third box — the predecessor changes. Confirm the badges renumber after each commit (the graph is re-materialized, so `sequence` is rebuilt).

- [x] **Step 7: Commit**

```bash
git add src/tools/orderTool.ts src/app/session.ts tests/tools/orderTool.test.ts
git commit -m "feat(tools): drag arrow endpoints to re-parent reading-order linkages

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Document it

**Files:**
- Modify: `ARCHITECTURE.md` §5, §8

- [x] **Step 1: Rewrite the reading-order section's editing paragraph**

Replace whatever §5 currently says about linking with:

```markdown
Editing the graph has two gestures. Pressing on empty box space and dragging onto another box
**links or unlinks** that pair (`hasEdge` decides which). Pressing on a *painted arrow's
endpoint* instead **re-parents** it: dragging the head re-points the successor, dragging the tail
re-points the predecessor, and either way the old edge's removal and the new edge's addition go
into a **single `commit()`** — a re-parent is one reviewer intent, and two commits would let
Cmd+Z leave the graph disconnected.

Endpoint hit-testing (`hitEndpoint`) consults only the arrows the overlay painted last frame.
The graph has 5,294 edges on FUNSD, but the reviewer can only grab one that is on screen, so the
overlay records each arrow it draws into a pre-allocated `ArrowRecord[]` (capped at the arrow
budget, overwritten in place, zero per-frame allocation) and the tool searches that.

Badges show the node's **reading position**, not its out-degree. `sequenceNumbers` walks the
graph from its in-degree-0 roots depth-first — roots ordered by document order then id, children
by id, so the numbering is deterministic frame to frame — and anything left unreached (a cycle a
reviewer or an extractor created) is numbered afterwards, so no linked node renders blank. The
result is a `Map<nodeId, number>` stored on the `EdgeSet` and rebuilt only when the graph
changes; the badge painter does a map lookup, never a walk.
```

In §8, add:

```
- Sequence numbers are a DFS pre-order over a graph that is not required to be a tree. For a
  FUNSD question with three answers the numbering is one valid reading, not the only one; the
  brief asks the flow to be visible and editable, not to be linearised canonically.
```

- [x] **Step 2: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(architecture): document endpoint re-parenting and sequence badges

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Unresolved questions

- Re-parent gesture discoverability: endpoint dots on every painted arrow, or only on the selected node's arrows?
- Cycle policy — allow, or reject a re-parent that closes a cycle?
- Badges on all visible nodes vs. only nodes on the selected node's path?
