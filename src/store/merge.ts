import type { SerializedNode } from '@/worker/protocol'
import { applyStream, useStore } from './store'

export type MergeResult = { applied: number; shielded: number }

/**
 * Dirty-node shielding: a node the human has touched rejects stream overwrites;
 * clean nodes take them. Applied without recording history — Cmd+Z must never
 * rewind the model's output.
 */
export function applyPageUpdate(pageIndex: number, incoming: SerializedNode[]): MergeResult {
  void pageIndex
  const dirty = useStore.getState().dirtyAt
  let applied = 0
  let shielded = 0

  applyStream((d) => {
    for (const n of incoming) {
      if (dirty[n.id] !== undefined) {
        shielded++
        continue
      }
      const prev = d.edits[n.id]?.rect
      if (prev && prev.x === n.x && prev.y === n.y && prev.w === n.w && prev.h === n.h) {
        applied++
        continue
      }
      d.edits[n.id] = { ...d.edits[n.id], rect: { x: n.x, y: n.y, w: n.w, h: n.h } }
      applied++
    }
  })

  return { applied, shielded }
}
