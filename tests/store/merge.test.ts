// tests/store/merge.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useStore, commit, undo } from '@/store/store'
import { applyPageUpdate } from '@/store/merge'

const reset = () => useStore.setState({ edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null }, true)
const node = (id: number, x: number) => ({ id, page: 0, x, y: 0, w: 10, h: 10, type: 1, parent: -1, order: id })

describe('applyPageUpdate', () => {
  beforeEach(reset)

  it('applies updates to clean nodes', () => {
    const r = applyPageUpdate(0, [node(1, 50)])
    expect(r.applied).toBe(1)
    expect(r.shielded).toBe(0)
    expect(useStore.getState().edits[1]?.rect?.x).toBe(50)
  })

  it('shields nodes the user has edited', () => {
    commit('move', (d) => {
      d.edits[1] = { rect: { x: 999, y: 0, w: 10, h: 10 } }
      d.dirtyAt[1] = Date.now()
    })
    const r = applyPageUpdate(0, [node(1, 50), node(2, 60)])
    expect(r.shielded).toBe(1)
    expect(r.applied).toBe(1)
    expect(useStore.getState().edits[1]?.rect?.x).toBe(999)
    expect(useStore.getState().edits[2]?.rect?.x).toBe(60)
  })

  it('does not add to the undo stack', () => {
    const before = useStore.getState()
    applyPageUpdate(0, [node(1, 50)])
    undo()
    expect(useStore.getState().edits[1]?.rect?.x).toBe(50)
    expect(before).not.toBe(useStore.getState())
  })

  it('clears the dirty flag when the last edit on a node is undone', () => {
    commit('move', (d) => {
      d.edits[1] = { rect: { x: 999, y: 0, w: 10, h: 10 } }
      d.dirtyAt[1] = Date.now()
    })
    undo()
    expect(useStore.getState().dirtyAt[1]).toBeUndefined()
    expect(applyPageUpdate(0, [node(1, 50)]).applied).toBe(1)
  })

  it('is idempotent for a repeated identical payload', () => {
    applyPageUpdate(0, [node(1, 50)])
    const a = JSON.stringify(useStore.getState().edits)
    applyPageUpdate(0, [node(1, 50)])
    expect(JSON.stringify(useStore.getState().edits)).toBe(a)
  })
})
