import { applyStream, useStore } from './store'

export type MergeResult = { applied: number; shielded: number }

/**
 * Dirty-node shielding: a node the human has touched rejects stream overwrites;
 * clean nodes take them. Applied without recording history — Cmd+Z must never
 * rewind the model's output.
 *
 * `edits` is the *human* overlay only. A clean node's stream rect is not
 * mirrored into it — that value is already the base geometry in the render
 * arrays — so the store stays O(human edits) rather than O(document).
 *
 * Takes the worker's typed arrays directly (`ids` + page-local `coords`,
 * x/y/w/h at `i * 4`) rather than an array of per-node objects — a FUNSD page
 * can carry thousands of nodes per burst, well inside the drain loop's
 * per-tick budget, and building a `SerializedNode[]` just to iterate it once
 * here would be a main-thread allocation storm for no benefit.
 */
export function applyPageUpdate(
  pageIndex: number,
  ids: Uint32Array,
  coords: Float32Array,
): MergeResult {
  void pageIndex
  const dirty = useStore.getState().dirtyAt
  let applied = 0
  let shielded = 0

  applyStream((d) => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (dirty[id] !== undefined) {
        shielded++
        continue
      }
      const c = i * 4
      const x = coords[c]
      const y = coords[c + 1]
      const w = coords[c + 2]
      const h = coords[c + 3]
      const prev = d.edits[id]?.rect
      // A clean node with no human edit needs no store entry at all: the
      // authoritative stream geometry is already in the render arrays, and
      // `Session.rectOf` falls back to them. Writing one Edit per clean node
      // grew `edits` to ~41k over the FUNSD stream and made every subsequent
      // store change an O(all nodes) rescan on the main thread — the exact
      // per-page growth the <16ms ingest budget cannot absorb.
      if (prev === undefined) {
        applied++
        continue
      }
      if (prev.x === x && prev.y === y && prev.w === w && prev.h === h) {
        applied++
        continue
      }
      d.edits[id] = { ...d.edits[id], rect: { x, y, w, h } }
      applied++
    }
  })

  return { applied, shielded }
}
