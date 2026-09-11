// tests/store/merge.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useStore, commit, undo, canUndo, resetHistory } from '@/store/store'
import { applyPageUpdate } from '@/store/merge'

const reset = () => (resetHistory(), useStore.setState({ edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null }, true))

/** Builds the (ids, coords) typed-array pair `applyPageUpdate` now takes. */
function page(...nodes: { id: number; x: number }[]): [Uint32Array, Float32Array] {
  const ids = Uint32Array.from(nodes.map((n) => n.id))
  const coords = new Float32Array(nodes.length * 4)
  nodes.forEach((n, i) => {
    coords[i * 4] = n.x
    coords[i * 4 + 1] = 0
    coords[i * 4 + 2] = 10
    coords[i * 4 + 3] = 10
  })
  return [ids, coords]
}

describe('applyPageUpdate', () => {
  beforeEach(reset)

  // `edits` is the human overlay: a clean node with no prior edit takes the
  // stream value in the render arrays and needs no store entry, which is what
  // keeps the store O(human edits) instead of O(document).
  it('accepts updates for clean nodes without growing the store', () => {
    const r = applyPageUpdate(0, ...page({ id: 1, x: 50 }))
    expect(r.applied).toBe(1)
    expect(r.shielded).toBe(0)
    expect(useStore.getState().edits[1]).toBeUndefined()
  })

  it('leaves the store untouched across a whole clean page', () => {
    const before = useStore.getState()
    applyPageUpdate(0, ...page({ id: 1, x: 50 }, { id: 2, x: 60 }, { id: 3, x: 70 }))
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
    expect(useStore.getState()).toBe(before)
  })

  it('shields nodes the user has edited', () => {
    commit('move', (d) => {
      d.edits[1] = { rect: { x: 999, y: 0, w: 10, h: 10 } }
      d.dirtyAt[1] = Date.now()
    })
    const r = applyPageUpdate(0, ...page({ id: 1, x: 50 }, { id: 2, x: 60 }))
    expect(r.shielded).toBe(1)
    expect(r.applied).toBe(1)
    expect(useStore.getState().edits[1]?.rect?.x).toBe(999)
    expect(useStore.getState().edits[2]).toBeUndefined()
  })

  it('does not add to the undo stack', () => {
    // A node with a dirty flag but no rect override (e.g. a reading-order
    // link edit): the shield now keys on the rect override, so the stream is
    // free to overwrite geometry, and that write must still not be undoable.
    commit('move', (d) => { d.dirtyAt[1] = Date.now() })
    const r = applyPageUpdate(0, ...page({ id: 1, x: 50 }))
    // The discriminating assertion: under the old `dirtyAt`-keyed predicate
    // this node would have been shielded.
    expect(r.shielded).toBe(0)
    expect(r.applied).toBe(1)
    expect(useStore.getState().edits[1]).toBeUndefined()
    // Only the human's commit is on the stack — the stream write recorded
    // nothing, so one undo empties it.
    undo()
    expect(canUndo()).toBe(false)
  })

  it('clears the dirty flag when the last edit on a node is undone', () => {
    commit('move', (d) => {
      d.edits[1] = { rect: { x: 999, y: 0, w: 10, h: 10 } }
      d.dirtyAt[1] = Date.now()
    })
    undo()
    expect(useStore.getState().dirtyAt[1]).toBeUndefined()
    expect(applyPageUpdate(0, ...page({ id: 1, x: 50 })).applied).toBe(1)
  })

  it('is idempotent for a repeated identical payload', () => {
    commit('move', (d) => { d.edits[1] = { rect: { x: 999, y: 0, w: 10, h: 10 } } })
    applyPageUpdate(0, ...page({ id: 1, x: 50 }))
    const a = JSON.stringify(useStore.getState().edits)
    applyPageUpdate(0, ...page({ id: 1, x: 50 }))
    expect(JSON.stringify(useStore.getState().edits)).toBe(a)
  })
})

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

  it('still shields a node whose geometry a human edited, and does not touch history', () => {
    resetHistory()
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
    const canUndoBefore = canUndo()
    const r = applyPageUpdate(0, Uint32Array.of(1), Float32Array.of(9, 9, 9, 9))
    // The shielded branch is a bare `continue` before any `d.edits` write today —
    // assert that explicitly so a future edit to that branch that starts writing
    // (and thus recording history) is caught here.
    expect(canUndo()).toBe(canUndoBefore)
    expect(r.shielded).toBe(1)
    expect(useStore.getState().edits[1].rect).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })
})
