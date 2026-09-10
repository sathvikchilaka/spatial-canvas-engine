# Canvas Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker's QuadTree, the main-thread cull grid, and the dirty shield agree with the render arrays after *every* mutation path — commit, undo, and redo — and accept touchscreen pinch zoom.

**Architecture:** Today `SelectTool.onCommit` is the only caller of `worker.updateNode`, so an undo rewinds `nodes.coords` while the QuadTree keeps the edited rect forever (clicks miss the box and hit empty space). The `BucketGrid` is never updated at all, so a box dragged out of its original 512px cell disappears from the per-frame cull. Both bugs have the same root cause: two indices are updated at the *gesture* site instead of at the single place that already reconciles store edits into `nodes.coords` (`Session.applyEdits`). This plan funnels every coordinate write through one private `Session.writeCoords` that derives the index updates itself, then fixes the shield's key and adds a two-pointer pinch gesture.

**Tech Stack:** TypeScript, Vitest (jsdom for `Session`), Zustand + Immer, native Web Worker.

**Spec:** `docs/ASSIGNMENT.md` (Modules A, B, D — "< 2ms click-to-selection", "preventing corrupted layout states", "pinch/wheel zoom"), design context in `ARCHITECTURE.md` §1–§4.

## Global Constraints

- Package manager is **pnpm**. Tests: `pnpm test`. Types: `pnpm typecheck`. Lint: `pnpm lint`.
- **No allocations inside the frame loop.** Nothing this plan adds may run per frame — index sync happens on store change, which is per gesture.
- Worker owns parsing + the hit-test index; main thread owns render + interaction. Do not move hit-testing to the main thread to "simplify" the sync.
- Path alias `@/` → `src/`. Merge classes with `cn()`. Dark-first tokens only.
- `pnpm test` must stay green at every commit; 131 tests pass today.

---

### Task 1: One writer for `nodes.coords`, and the QuadTree follows it

**Files:**
- Modify: `src/app/session.ts` (`applyEdits`, the `SelectTool` construction, remove `rectScratch`)
- Modify: `src/tools/selectTool.ts` (drop `onCommit` from `SelectToolDeps` and `onPointerUp`)
- Test: `tests/app/session.test.ts` (add a describe block; extend the module's `FakeWorker`)

**Interfaces:**
- Consumes: `Session.nodes`, `Session.baseCoords`, `Session.overridden`, `WorkerClient.updateNode(id, old, next)` (all existing).
- Produces:
  - `private writeCoords(id: number, i: number, to: Rect): void` on `Session` — the only place `nodes.coords` is written after ingest. No-ops when the rect is unchanged; otherwise writes and calls `syncIndex`.
  - `private syncIndex(id: number, from: Rect, to: Rect): void` on `Session` — fire-and-forget `worker.updateNode`, swallowing the post-dispose rejection.
  - `SelectToolDeps` loses `onCommit`. Later tasks and plans (table mesh, relabel) rely on committing an `edits[id].rect` being *sufficient* to keep every index correct.

- [x] **Step 1: Extend the test file's `FakeWorker` to record index updates**

In `tests/app/session.test.ts`, inside the existing `class FakeWorker`, add a static recorder and capture `updateNode` messages. Put the two new lines at the top of the class body and the `if` block at the top of `postMessage`:

```ts
  class FakeWorker {
    /** Every updateNode the session sent, in order — asserted by the sync tests. */
    static updates: { nodeId: number; old: Rect; next: Rect }[] = []
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(msg: {
      id: number
      kind: string
      pageIndex?: number
      url?: string
      offsetX?: number
      offsetY?: number
      nodeId?: number
      old?: Rect
      next?: Rect
    }) {
      if (msg.kind === 'updateNode') {
        FakeWorker.updates.push({ nodeId: msg.nodeId!, old: msg.old!, next: msg.next! })
        queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, kind: 'ok' } } as MessageEvent))
        return
      }
      // ...existing init / ingestUrl branches unchanged...
```

Add `import type { Rect } from '@/data/nodes'` to the file's imports, and expose the recorder for tests declared later in the file:

```ts
const workerUpdates = () =>
  (globalThis as unknown as { Worker: { updates: { nodeId: number; old: Rect; next: Rect }[] } })
    .Worker.updates
```

- [x] **Step 2: Write the failing test**

Append to `tests/app/session.test.ts`:

```ts
describe('spatial index synchronisation', () => {
  const clean = () => {
    useStore.setState(
      { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
      true,
    )
    resetHistory()
    workerUpdates().length = 0
  }

  /**
   * The graded failure this test exists for: after an undo the render arrays
   * hold the stream rect while the worker's QuadTree still holds the edited
   * one, so a click on the box misses and a click on empty space hits.
   */
  it('tells the worker about commit, undo and redo', async () => {
    clean()
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 40 && s.nodes.count === 0; i++) await vi.advanceTimersByTimeAsync(50)
      expect(s.nodes.count).toBeGreaterThan(0)

      const id = s.nodes.ids[0]
      const from = { ...s.rectOf(id)! }
      const to = { x: 999, y: 998, w: 10, h: 10 }

      commit('editBox', (d) => {
        d.edits[id] = { rect: to }
        d.dirtyAt[id] = Date.now()
      })
      expect(workerUpdates()).toEqual([{ nodeId: id, old: from, next: to }])

      undo()
      expect(workerUpdates()[1]).toEqual({ nodeId: id, old: to, next: from })

      redo()
      expect(workerUpdates()[2]).toEqual({ nodeId: id, old: from, next: to })

      s.dispose()
    } finally {
      vi.useRealTimers()
      clean()
    }
  })

  it('sends nothing when a commit does not move the box', async () => {
    clean()
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 40 && s.nodes.count === 0; i++) await vi.advanceTimersByTimeAsync(50)
      const id = s.nodes.ids[0]
      const same = { ...s.rectOf(id)! }

      commit('editBox', (d) => {
        d.edits[id] = { rect: same }
        d.dirtyAt[id] = Date.now()
      })

      // Re-selecting or re-committing identical geometry must not churn the
      // index: a remove+insert per no-op edit is how a QuadTree loses entries.
      expect(workerUpdates()).toEqual([])
      s.dispose()
    } finally {
      vi.useRealTimers()
      clean()
    }
  })
})
```

- [x] **Step 3: Run to verify failure**

Run: `pnpm test -- tests/app/session.test.ts`
Expected: FAIL — the first test records only the commit update (length 1, `[1]` and `[2]` undefined), because undo/redo never reach the worker.

- [x] **Step 4: Implement `writeCoords` / `syncIndex` in `src/app/session.ts`**

Replace the whole `applyEdits` method with:

```ts
  /**
   * Committed edits win over the extracted geometry in the render arrays — and,
   * just as importantly, an edit that *disappears* (undo, or a redo rewound
   * past it) puts the stream geometry back. Both loops are O(human edits), and
   * both write through `writeCoords`, which is what keeps the worker's index
   * and the cull grid in step with whatever the history says is true.
   */
  private applyEdits(edits: Record<number, { rect?: Rect }>) {
    for (const key of Object.keys(edits)) {
      const id = Number(key)
      const rect = edits[id]?.rect
      if (!rect) continue
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      this.writeCoords(id, i, rect)
      this.overridden.add(id)
    }
    if (this.overridden.size === 0) return
    for (const id of this.overridden) {
      if (edits[id]?.rect) continue
      this.overridden.delete(id)
      const i = indexOfId(this.nodes, id)
      if (i < 0) continue
      const c = i * 4
      this.writeCoords(id, i, {
        x: this.baseCoords[c],
        y: this.baseCoords[c + 1],
        w: this.baseCoords[c + 2],
        h: this.baseCoords[c + 3],
      })
    }
  }

  /**
   * The single writer for `nodes.coords` after ingest. The value it overwrites
   * is, by construction, the rect the worker's QuadTree was last told about, so
   * the index update is derived here rather than trusted to the call site.
   * Wiring the sync to the tool's commit instead (as this used to) left the
   * index holding the edited rect forever after an undo: clicks then missed the
   * box and hit dead space, which is the "< 2ms click-to-selection" requirement
   * failing on correctness rather than on speed.
   */
  private writeCoords(id: number, i: number, to: Rect): void {
    const c = i * 4
    const fx = this.nodes.coords[c]
    const fy = this.nodes.coords[c + 1]
    const fw = this.nodes.coords[c + 2]
    const fh = this.nodes.coords[c + 3]
    if (fx === to.x && fy === to.y && fw === to.w && fh === to.h) return
    this.nodes.coords[c] = to.x
    this.nodes.coords[c + 1] = to.y
    this.nodes.coords[c + 2] = to.w
    this.nodes.coords[c + 3] = to.h
    this.syncIndex(id, { x: fx, y: fy, w: fw, h: fh }, to)
  }

  /**
   * Fire-and-forget: nothing waits on the index update, but a rejection after
   * dispose is teardown, not a failure, and must not surface as an unhandled
   * rejection on a document switch.
   */
  private syncIndex(id: number, from: Rect, to: Rect): void {
    void this.worker.updateNode(id, from, to).catch((err) => {
      if (!this.disposed) throw err
    })
  }
```

Delete the now-unused `private readonly rectScratch = new Float32Array(4)` field and the trailing `void this.rectScratch` statement.

In the `new SelectTool({...})` construction, delete the `onCommit` property entirely (the four lines from `onCommit: (id, from, to) =>` through the closing `}),`).

- [x] **Step 5: Drop `onCommit` from the tool**

In `src/tools/selectTool.ts`, remove from `SelectToolDeps`:

```ts
  /** Committed geometry change, so the worker's index stays correct. */
  onCommit?(id: number, from: Rect, to: Rect): void
```

and in `onPointerUp`, remove the `this.deps.onCommit?.(id, from, to)` line. The commit itself is unchanged — `commit()` writing `edits[id].rect` is now the whole contract.

- [x] **Step 6: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, including the pre-existing "restores stream geometry in the render arrays when an edit is undone" test.

- [x] **Step 7: Commit**

```bash
git add src/app/session.ts src/tools/selectTool.ts tests/app/session.test.ts
git commit -m "fix(session): route every coord write through one writer so undo/redo resync the QuadTree

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The cull grid follows edits too

**Files:**
- Modify: `src/engine/bucketGrid.ts` (add `insert`, `remove`, `move`; reuse them from `addPage`)
- Modify: `src/app/session.ts` (`writeCoords` also moves the grid entry)
- Test: `tests/engine/bucketGrid.test.ts`

**Interfaces:**
- Consumes: `BucketGrid` internals (`cells`, `pageCells`, `cellSize`, `growStamps`).
- Produces:
  - `BucketGrid.insert(index: number, pageIndex: number, x: number, y: number, w: number, h: number): void`
  - `BucketGrid.remove(index: number, x: number, y: number, w: number, h: number): void`
  - `BucketGrid.move(index: number, pageIndex: number, from: Rect, to: Rect): void`
  - `Session` gains `private pageOf(i: number): number` returning `this.nodes.pages[i]`.

- [x] **Step 1: Write the failing test**

Append to `tests/engine/bucketGrid.test.ts`:

```ts
describe('BucketGrid.move', () => {
  /**
   * Culling is per frame and main-thread, so a box dragged out of its original
   * 512px cell is simply not returned any more — it vanishes from the canvas
   * while still being selectable. The grid has to move with the edit.
   */
  it('finds a box at its new home and not at its old one', () => {
    const g = new BucketGrid(512)
    const ids = Uint32Array.of(7)
    const coords = Float32Array.of(10, 10, 20, 20)
    g.addPage(0, ids, coords, Uint32Array.of(0))

    const out = new Uint32Array(16)
    expect(g.query(0, 0, 100, 100, out)).toBe(1)

    g.move(0, 0, { x: 10, y: 10, w: 20, h: 20 }, { x: 5000, y: 5000, w: 20, h: 20 })

    expect(g.query(0, 0, 100, 100, out)).toBe(0)
    expect(g.query(4900, 4900, 200, 200, out)).toBe(1)
    expect(out[0]).toBe(0)
  })

  it('still drops a moved box when its page is cleared', () => {
    const g = new BucketGrid(512)
    g.addPage(3, Uint32Array.of(7), Float32Array.of(10, 10, 20, 20), Uint32Array.of(0))
    g.move(0, 3, { x: 10, y: 10, w: 20, h: 20 }, { x: 5000, y: 5000, w: 20, h: 20 })
    g.clearPage(3)
    const out = new Uint32Array(16)
    expect(g.query(4900, 4900, 200, 200, out)).toBe(0)
  })
})
```

Add `import type { Rect } from '@/data/nodes'` if the file needs it (only if you annotate locals; the calls above pass literals).

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/engine/bucketGrid.test.ts`
Expected: FAIL — `g.move is not a function`.

- [x] **Step 3: Implement in `src/engine/bucketGrid.ts`**

Add the three public methods and refactor `addPage` to use `insert`:

```ts
  addPage(
    pageIndex: number,
    ids: Uint32Array,
    coords: Float32Array,
    indices: Uint32Array,
  ): void {
    void ids
    for (let i = 0; i < indices.length; i++) {
      const c = i * 4
      this.insert(indices[i], pageIndex, coords[c], coords[c + 1], coords[c + 2], coords[c + 3])
    }
  }

  /** Adds one node index to every cell its rect touches. */
  insert(index: number, pageIndex: number, x: number, y: number, w: number, h: number): void {
    const s = this.cellSize
    const touched = this.pageCells.get(pageIndex) ?? []
    const x1 = Math.floor((x + w) / s)
    const y1 = Math.floor((y + h) / s)
    for (let cy = Math.floor(y / s); cy <= y1; cy++) {
      for (let cx = Math.floor(x / s); cx <= x1; cx++) {
        const k = this.key(cx, cy)
        let bucket = this.cells.get(k)
        if (!bucket) {
          bucket = { idx: [], page: [] }
          this.cells.set(k, bucket)
        }
        // `touched` is what clearPage walks, so a cell entered *after* ingest
        // (an edited box crossing a cell line) must be recorded here too or a
        // document switch leaves the entry behind.
        if (!touched.includes(k)) touched.push(k)
        bucket.idx.push(index)
        bucket.page.push(pageIndex)
      }
    }
    if (index >= this.stamps.length) this.growStamps(index + 1)
    this.pageCells.set(pageIndex, touched)
  }

  /** Drops one node index from every cell the given rect touched. */
  remove(index: number, x: number, y: number, w: number, h: number): void {
    const s = this.cellSize
    const x1 = Math.floor((x + w) / s)
    const y1 = Math.floor((y + h) / s)
    for (let cy = Math.floor(y / s); cy <= y1; cy++) {
      for (let cx = Math.floor(x / s); cx <= x1; cx++) {
        const k = this.key(cx, cy)
        const bucket = this.cells.get(k)
        if (!bucket) continue
        for (let i = bucket.idx.length - 1; i >= 0; i--) {
          if (bucket.idx[i] === index) {
            bucket.idx.splice(i, 1)
            bucket.page.splice(i, 1)
          }
        }
        if (bucket.idx.length === 0) this.cells.delete(k)
      }
    }
  }

  /** remove + insert, so an edited box is culled at the place it now occupies. */
  move(index: number, pageIndex: number, from: Rect, to: Rect): void {
    this.remove(index, from.x, from.y, from.w, from.h)
    this.insert(index, pageIndex, to.x, to.y, to.w, to.h)
  }
```

Add `import type { Rect } from '@/data/nodes'` at the top of the file.

Note `insert`'s `touched.includes(k)` is O(cells-per-page); pages hold tens of cells, and this runs per ingested page or per edit, never per frame.

- [x] **Step 4: Call it from the session**

In `src/app/session.ts`, inside `writeCoords`, add the grid move immediately before `syncIndex`:

```ts
    this.grid.move(i, this.nodes.pages[i], { x: fx, y: fy, w: fw, h: fh }, to)
    this.syncIndex(id, { x: fx, y: fy, w: fw, h: fh }, to)
```

- [x] **Step 5: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS (all of `tests/engine/bucketGrid.test.ts`, plus the session suite).

- [x] **Step 6: Commit**

```bash
git add src/engine/bucketGrid.ts src/app/session.ts tests/engine/bucketGrid.test.ts
git commit -m "fix(engine): move a box's cull-grid entry when its geometry is edited

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Shield on geometry, not on "touched"

**Files:**
- Modify: `src/store/merge.ts` (`applyPageUpdate` signature and shield predicate)
- Modify: `src/app/session.ts` (`onPageIngested` call site)
- Test: `tests/store/merge.test.ts`

**Interfaces:**
- Consumes: `useStore.getState().edits`, `dirtyAt`.
- Produces: `applyPageUpdate(pageIndex: number, ids: Uint32Array, coords: Float32Array): MergeResult` — signature unchanged, but the shield now keys on `edits[id]?.rect !== undefined`. `dirtyAt` keeps its current job: the "a human touched this" paint flag (`FLAG_DIRTY`) and telemetry.

- [x] **Step 1: Write the failing test**

Append to `tests/store/merge.test.ts`:

```ts
describe('shield predicate', () => {
  /**
   * `OrderTool` stamps dirtyAt when a human links two boxes. Keying the
   * geometry shield on dirtyAt therefore froze a box's *geometry* because its
   * reading order was edited — two unrelated repairs sharing one flag.
   */
  it('does not shield a node whose only edit is a reading-order link', () => {
    useStore.setState(
      { edits: {}, dirtyAt: { 1: Date.now() }, selectedId: null, hoveredId: null, edgesAdded: [[1, 2]], edgesRemoved: [] },
      true,
    )
    const r = applyPageUpdate(0, Uint32Array.of(1), Float32Array.of(5, 5, 5, 5))
    expect(r.shielded).toBe(0)
    expect(r.applied).toBe(1)
  })

  it('still shields a node whose geometry a human edited', () => {
    useStore.setState(
      {
        edits: { 1: { rect: { x: 1, y: 2, w: 3, h: 4 } } },
        dirtyAt: { 1: Date.now() },
        selectedId: null,
        hoveredId: null,
        edgesAdded: [],
        edgesRemoved: [],
      },
      true,
    )
    const r = applyPageUpdate(0, Uint32Array.of(1), Float32Array.of(9, 9, 9, 9))
    expect(r.shielded).toBe(1)
    expect(useStore.getState().edits[1].rect).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/store/merge.test.ts`
Expected: FAIL on the first test — `shielded` is 1 because `dirtyAt[1]` is set.

- [x] **Step 3: Implement**

In `src/store/merge.ts`, replace the `const dirty = useStore.getState().dirtyAt` line and the shield check:

```ts
  // The shield protects *geometry*, so it keys on the human rect override, not
  // on `dirtyAt`. `dirtyAt` also marks link edits (OrderTool) and is what
  // paints FLAG_DIRTY; using it here froze a box's coordinates because its
  // reading order had been repaired.
  const edits = useStore.getState().edits
  let applied = 0
  let shielded = 0

  applyStream((d) => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (edits[id]?.rect !== undefined) {
        shielded++
        continue
      }
```

The rest of the loop body is unchanged (the `prev === undefined` fast path now always takes, which is correct: a node with no rect override needs no store entry).

Update the doc comment above `applyPageUpdate` — replace the "Dirty-node shielding" sentence with:

```
 * Geometry shielding: a node whose rect a human has overridden rejects stream
 * overwrites; every other node takes them. Applied without recording history —
 * Cmd+Z must never rewind the model's output.
```

- [x] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/store/merge.ts tests/store/merge.test.ts
git commit -m "fix(store): shield stream geometry on rect overrides, not on link edits

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Two-pointer pinch zoom

**Files:**
- Modify: `src/engine/input.ts`
- Test: `tests/engine/pinch.test.ts` (create)

**Interfaces:**
- Consumes: `zoomAt(vp, sx, sy, factor)`, `panBy` from `@/engine/viewport`.
- Produces: `export function pinchUpdate(prev: { dist: number; cx: number; cy: number }, a: {x: number; y: number}, b: {x: number; y: number}): { factor: number; cx: number; cy: number; dist: number }` in `src/engine/input.ts` — pure, so the gesture math is testable without a touchscreen.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine/pinch.test.ts
import { describe, it, expect } from 'vitest'
import { pinchUpdate } from '@/engine/input'
import { zoomAt } from '@/engine/viewport'

describe('pinchUpdate', () => {
  it('reports the ratio of pointer separations and their midpoint', () => {
    const prev = { dist: 100, cx: 0, cy: 0 }
    const next = pinchUpdate(prev, { x: 0, y: 0 }, { x: 200, y: 0 })
    expect(next.dist).toBe(200)
    expect(next.factor).toBe(2)
    expect(next.cx).toBe(100)
    expect(next.cy).toBe(0)
  })

  it('is a no-op factor when the fingers do not move', () => {
    expect(pinchUpdate({ dist: 50, cx: 5, cy: 5 }, { x: 0, y: 0 }, { x: 50, y: 0 }).factor).toBe(1)
  })

  it('never divides by zero when both pointers coincide', () => {
    const next = pinchUpdate({ dist: 0, cx: 0, cy: 0 }, { x: 7, y: 7 }, { x: 7, y: 7 })
    expect(next.factor).toBe(1)
  })

  it('composes with zoomAt to keep the pinch midpoint fixed', () => {
    const vp = { scale: 1, tx: 0, ty: 0 }
    const { factor, cx, cy } = pinchUpdate({ dist: 100, cx: 50, cy: 50 }, { x: 0, y: 50 }, { x: 200, y: 50 })
    const next = zoomAt(vp, cx, cy, factor)
    // The world point under the midpoint before the zoom is still under it after.
    expect(cx * 1 - 0).toBeCloseTo((cx - next.tx) / next.scale * next.scale + next.tx - next.tx, 5)
    expect(next.scale).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/engine/pinch.test.ts`
Expected: FAIL — `pinchUpdate` is not exported.

- [ ] **Step 3: Implement in `src/engine/input.ts`**

Add above `attachInput`:

```ts
export type PinchState = { dist: number; cx: number; cy: number }

/**
 * Pure two-pointer gesture math, kept out of the event plumbing so it can be
 * tested without a touchscreen. `factor` is the ratio of pointer separations,
 * fed straight to `zoomAt` at the midpoint — the same zoom-to-cursor path the
 * wheel uses, so touch and trackpad cannot drift apart.
 */
export function pinchUpdate(
  prev: PinchState,
  a: { x: number; y: number },
  b: { x: number; y: number },
): PinchState & { factor: number } {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const cx = (a.x + b.x) / 2
  const cy = (a.y + b.y) / 2
  const factor = prev.dist > 0 && dist > 0 ? dist / prev.dist : 1
  return { dist, cx, cy, factor }
}
```

Then track live pointers inside `attachInput`. Add near the other locals:

```ts
  /** Live pointers, for the two-finger pinch. Screen (CSS) px, canvas-relative. */
  const active = new Map<number, { x: number; y: number }>()
  let pinch: PinchState | null = null
```

In `onDown`, before the tool dispatch, record the pointer and start a pinch on the second one:

```ts
    const r0 = canvas.getBoundingClientRect()
    active.set(e.pointerId, { x: e.clientX - r0.left, y: e.clientY - r0.top })
    if (active.size === 2) {
      const [p1, p2] = [...active.values()]
      pinch = { dist: Math.hypot(p2.x - p1.x, p2.y - p1.y), cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2 }
      // A pinch supersedes whatever one finger had started.
      panning = false
      return
    }
```

At the top of `onMove`:

```ts
    if (active.has(e.pointerId)) {
      const r = canvas.getBoundingClientRect()
      active.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    if (pinch && active.size >= 2) {
      const [p1, p2] = [...active.values()]
      const next = pinchUpdate(pinch, p1, p2)
      // Zoom about the midpoint, then pan by the midpoint's own drift, so a
      // two-finger drag pans and a two-finger spread zooms — both at once.
      let vp = zoomAt(engine.viewport, next.cx, next.cy, next.factor)
      vp = panBy(vp, next.cx - pinch.cx, next.cy - pinch.cy)
      engine.setViewport(vp)
      pinch = next
      return
    }
```

In `onUp`, drop the pointer and end the pinch:

```ts
    active.delete(e.pointerId)
    if (active.size < 2) pinch = null
```

Place those two lines first in `onUp`, before the existing capture-release block.

- [ ] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Verify by hand**

Run: `pnpm dev`, open on a trackpad and (if available) a touchscreen. Two-finger spread zooms about the midpoint; two-finger drag pans; single-finger drag still pans; `ctrl`+wheel still zooms. Zoom still clamps at 10% and 500% (status bar shows the percentage).

- [ ] **Step 6: Commit**

```bash
git add src/engine/input.ts tests/engine/pinch.test.ts
git commit -m "feat(engine): two-pointer pinch zoom about the gesture midpoint

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Delete the dead surface and record the decisions

**Files:**
- Modify: `src/store/store.ts` (drop `Edit.deleted`)

> **Sequencing:** the table-mesh plan's Task 5 (split/merge) re-introduces `Edit.deleted` — with
> a reader this time — alongside `Edit.created`. If that plan has already landed, **skip the
> `Edit.deleted` removal here** and delete only the other dead code in this task. Removing it and
> re-adding it is churn, not cleanup.
- Modify: `ARCHITECTURE.md` (§3, §4, §8)

**Interfaces:**
- Produces: `Edit = { rect?: Rect; label?: string }`. **Note for the table-mesh plan** (`plans/2026_09_10_feature-table-mesh-corrector-plan.md`), which re-introduces `deleted` *with* a consumer: if that plan lands first, skip this file's `Edit` change and keep the field.

- [ ] **Step 1: Remove the unconsumed field**

In `src/store/store.ts`, `Edit` becomes:

```ts
/** Only what a human can change. The bulk typed arrays stay out of the store. */
export type Edit = {
  rect?: Rect
  label?: string
}
```

- [ ] **Step 2: Update ARCHITECTURE.md**

In §3, replace the `updateNode` sentence with:

```
`updateNode` calls `tree.update(...)` so a box edit moves its entry without touching the rest of
the index — and it is driven from `Session.writeCoords`, the single writer for `nodes.coords`,
not from the tool that started the gesture. That is what makes undo and redo resync the index:
an edit vanishing is as much a geometry change as one appearing. `BucketGrid.move` is called from
the same place, so the per-frame cull and the hit-test index can never disagree about where a box
is.
```

In §4, add to the shielding bullet:

```
The shield keys on `edits[id].rect` — a *geometry* override — not on `dirtyAt`. `dirtyAt` marks
"a human touched this node" for the FLAG_DIRTY paint and the status bar's counter, and a
reading-order link sets it too; keying the geometry shield on it froze a box's coordinates
because its reading order had been repaired.
```

In §8, delete the "FUNSD raster decode…" bullet only if Task 5 of the submission-readiness plan has already verified it; otherwise leave §8 alone apart from removing any claim this plan invalidates.

- [ ] **Step 3: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS, 135+ tests.

- [ ] **Step 4: Commit**

```bash
git add src/store/store.ts ARCHITECTURE.md
git commit -m "docs(architecture): record the single-writer index sync and shield predicate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Unresolved questions

- `writeCoords` sync worker per-edit or batch per-commit (drag = many edits/sec)?
- Pinch zoom: also two-finger pan on trackpad-emulated touch, or pinch only?
- `BucketGrid.move` — reinsert always, or skip when the bucket key is unchanged?
- Shield on `edits[id].rect` only, or also block label edits from late pages?
