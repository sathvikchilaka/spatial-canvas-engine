import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer'
import { create } from 'zustand'

import type { NodeType, Rect } from '@/data/nodes'
import { History, HISTORY_LIMIT } from './history'

enablePatches()

export { HISTORY_LIMIT }

/** Only what a human can change. The bulk typed arrays stay out of the store. */
export type Edit = {
  rect?: Rect
  label?: string
  /** Merged away or removed by the reviewer — rendered hidden, kept for undo. */
  deleted?: true
  /**
   * A node the reviewer created (a split table cell). The store is the only
   * record of it, so its identity travels in the patch and redo can recreate
   * it byte-for-byte.
   */
  created?: { page: number; type: NodeType; parent: number; order: number }
}

export type AppState = {
  edits: Record<number, Edit>
  /** timestamp of the last human edit per node — the dirty shield */
  dirtyAt: Record<number, number>
  selectedId: number | null
  hoveredId: number | null
  /** Human-added graph edges, [from, to]. Base edges live outside the store. */
  edgesAdded: [number, number][]
  /** Base edges the human deleted. */
  edgesRemoved: [number, number][]
}

const initial: AppState = {
  edits: {},
  dirtyAt: {},
  selectedId: null,
  hoveredId: null,
  edgesAdded: [],
  edgesRemoved: [],
}

export const useStore = create<AppState>(() => ({ ...initial }))

const history = new History()

/**
 * Patches only make sense against the state they were recorded on. A wholesale
 * setState from outside (a document reload, a test harness reset) invalidates
 * them, so the history is dropped rather than left to misapply.
 */
let internal = false
const runInternal = (fn: () => void) => {
  internal = true
  try {
    fn()
  } finally {
    internal = false
  }
}
useStore.subscribe(() => {
  if (!internal) history.clear()
})
/** Bumped on every history/edit change so React chrome can subscribe coarsely. */
let coalesceKey: string | null = null

/** One user gesture = one undoable entry. */
export function commit(name: string, recipe: (draft: AppState) => void): void {
  const base = useStore.getState()
  const [next, patches, inverse] = produceWithPatches(base, recipe)
  if (patches.length === 0) return
  runInternal(() => useStore.setState(next, true))
  history.push({ name: coalesceKey ?? name, patches, inverse, at: Date.now() })
}

/** Stream writes bypass history entirely — Cmd+Z never rewinds the model. */
export function applyStream(recipe: (draft: AppState) => void): void {
  runInternal(() => useStore.setState(produce(useStore.getState(), recipe), true))
}

export function undo(): void {
  const e = history.popUndo()
  if (!e) return
  runInternal(() => useStore.setState(applyPatches(useStore.getState(), e.inverse), true))
}

export function redo(): void {
  const e = history.popRedo()
  if (!e) return
  runInternal(() => useStore.setState(applyPatches(useStore.getState(), e.patches), true))
}

export const canUndo = () => history.canUndo
export const canRedo = () => history.canRedo

/** Merges every commit until endCoalesce into one entry (arrow-key nudges, drags). */
export function beginCoalesce(key: string): void {
  coalesceKey = key
}

export function endCoalesce(): void {
  coalesceKey = null
}

export function resetHistory(): void {
  history.clear()
}
