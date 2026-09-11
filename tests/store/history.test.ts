// tests/store/history.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useStore, commit, applyStream, undo, redo, canUndo, canRedo, setUiState, HISTORY_LIMIT } from '@/store/store'

const reset = () =>
  useStore.setState(
    { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
    true,
  )

describe('history', () => {
  beforeEach(reset)

  it('undoes and redoes a single edit', () => {
    commit('move', (d) => { d.edits[1] = { rect: { x: 5, y: 5, w: 10, h: 10 } } })
    expect(useStore.getState().edits[1]?.rect?.x).toBe(5)
    undo()
    expect(useStore.getState().edits[1]).toBeUndefined()
    redo()
    expect(useStore.getState().edits[1]?.rect?.x).toBe(5)
  })

  it('supports at least 50 levels', () => {
    for (let i = 0; i < 60; i++) commit('m', (d) => { d.edits[i] = { label: `L${i}` } })
    for (let i = 0; i < 60; i++) undo()
    expect(Object.keys(useStore.getState().edits)).toHaveLength(0)
  })

  it('caps the stack at HISTORY_LIMIT without corrupting state', () => {
    for (let i = 0; i < HISTORY_LIMIT + 40; i++) commit('m', (d) => { d.edits[i] = { label: 'x' } })
    let n = 0
    while (canUndo() && n < 500) { undo(); n++ }
    expect(n).toBeLessThanOrEqual(HISTORY_LIMIT)
  })

  it('returns to the exact initial state over a randomized sequence', () => {
    const before = JSON.stringify(useStore.getState().edits)
    let s = 12345
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 200; i++) {
      const id = Math.floor(rnd() * 20)
      commit('r', (d) => {
        if (rnd() < 0.4) delete d.edits[id]
        else d.edits[id] = { rect: { x: rnd()*100, y: rnd()*100, w: 10, h: 10 }, label: `n${i}` }
      })
    }
    while (canUndo()) undo()
    expect(JSON.stringify(useStore.getState().edits)).toBe(before)
  })

  it('does not record stream applications in history', () => {
    applyStream((d) => { d.edits[9] = { label: 'from server' } })
    expect(canUndo()).toBe(false)
    expect(useStore.getState().edits[9]?.label).toBe('from server')
  })

  it('clears the redo stack on a new commit after undo', () => {
    commit('a', (d) => { d.edits[1] = { label: 'a' } })
    undo()
    commit('b', (d) => { d.edits[2] = { label: 'b' } })
    expect(canRedo()).toBe(false)
  })

  it('undoes and redoes an edge mutation without touching unrelated edges', () => {
    commit('link:1', (d) => { d.edgesAdded = [...d.edgesAdded, [1, 2]] })
    commit('link:2', (d) => { d.edgesAdded = [...d.edgesAdded, [3, 4]] })
    expect(useStore.getState().edgesAdded).toEqual([[1, 2], [3, 4]])
    undo()
    expect(useStore.getState().edgesAdded).toEqual([[1, 2]])
    redo()
    expect(useStore.getState().edgesAdded).toEqual([[1, 2], [3, 4]])
    undo()
    undo()
    expect(useStore.getState().edgesAdded).toEqual([])
  })

  it('does not clear history on a selection/hover change (setUiState)', () => {
    commit('move', (d) => { d.edits[1] = { rect: { x: 5, y: 5, w: 10, h: 10 } } })
    setUiState({ selectedId: 1 })
    setUiState({ hoveredId: 2 })
    expect(canUndo()).toBe(true)
    undo()
    expect(useStore.getState().edits[1]).toBeUndefined()
  })

  it('coalesces rapid same-key edits into one entry', () => {
    commit('nudge:1', (d) => { d.edits[1] = { rect: { x: 1, y: 0, w: 4, h: 4 } } })
    commit('nudge:1', (d) => { d.edits[1] = { rect: { x: 2, y: 0, w: 4, h: 4 } } })
    commit('nudge:1', (d) => { d.edits[1] = { rect: { x: 3, y: 0, w: 4, h: 4 } } })
    undo()
    expect(useStore.getState().edits[1]).toBeUndefined()
  })
})
