import type { Rect } from '@/data/nodes'
import type { Viewport } from '@/engine/viewport'
import { NodeType } from '@/data/nodes'
import { commit, useStore } from '@/store/store'
import {
  buildMesh,
  cellRect,
  hitDivider,
  mergeCells,
  moveDivider,
  splitCell,
  type CellInput,
  type Mesh,
} from './tableMesh'
import { HANDLE_SLOP_PX, type Tool, type ToolEvent } from './types'

export type TableSnapshot = { tableId: number; cells: CellInput[] }

export type TableToolDeps = {
  /** The table containing `nodeId` (the node itself, or its parent), or null. */
  tableAt(nodeId: number): TableSnapshot | null
  pick(wx: number, wy: number): Promise<number | null>
  requestDraw(): void
  /** A fresh node id that can never collide with a streamed one. */
  allocId(): number
  /** The page/parent/order a split cell must inherit from its sibling. */
  nodeMeta(id: number): { page: number; parent: number; order: number } | null
}

/** Cells whose derived rect differs from the geometry the mesh was built from. */
export function meshEdits(mesh: Mesh, original: Map<number, Rect>): Map<number, Rect> {
  const out = new Map<number, Rect>()
  for (const c of mesh.cells) {
    const next = cellRect(mesh, c)
    const prev = original.get(c.id)
    if (!prev || prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h) {
      out.set(c.id, next)
    }
  }
  return out
}

/**
 * Table repair: adopt the table under the cursor, drag its dividers, commit
 * every recalculated cell rect in one transaction.
 *
 * The commit writes ordinary `edits[id].rect` entries, which is the whole
 * reason this tool is small: `Session.writeCoords` already funnels a rect edit
 * into the render arrays, the worker's QuadTree and the cull grid, and the
 * history already treats one `commit()` as one undo entry.
 */
export class TableTool implements Tool {
  readonly name = 'table'
  readonly ephemeralRect = null

  private deps: TableToolDeps
  private snapshot: TableSnapshot | null = null
  private meshState: Mesh | null = null
  /** Geometry the current mesh was derived from — the diff baseline. */
  private original = new Map<number, Rect>()
  private drag: { axis: 'row' | 'col'; index: number } | null = null
  /** The previously selected cell — what `M` merges the selection with. */
  private mergePartner: number | null = null
  private hover: { axis: 'row' | 'col'; index: number } | null = null

  constructor(deps: TableToolDeps) {
    this.deps = deps
  }

  get mesh(): Mesh | null {
    return this.meshState
  }

  get tableId(): number | null {
    return this.snapshot?.tableId ?? null
  }

  /** True while the tool owns the pointer — suppresses the adapter's pan fallback. */
  get capturing(): boolean {
    return this.drag !== null
  }

  /** Rebuilds the mesh for whichever table holds `nodeId`. Cheap; not per frame. */
  async adopt(nodeId: number): Promise<void> {
    const snap = this.deps.tableAt(nodeId)
    this.snapshot = snap
    if (!snap) {
      this.meshState = null
      this.original.clear()
      this.deps.requestDraw()
      return
    }
    this.meshState = buildMesh(snap.cells)
    this.original.clear()
    // Baseline is the mesh's *own* rects, not the ragged input: building the
    // mesh regularises the table, and that regularisation is a repair the
    // reviewer opted into by picking up this tool — it should not be committed
    // silently as if they had dragged something.
    for (const c of this.meshState.cells) this.original.set(c.id, cellRect(this.meshState, c))
    this.deps.requestDraw()
  }

  onPointerDown(e: ToolEvent): void {
    if (this.meshState) {
      const hit = hitDivider(this.meshState, e.world[0], e.world[1], HANDLE_SLOP_PX / e.scale)
      if (hit) {
        this.drag = hit
        return
      }
    }
    // Not on a divider: treat it as "adopt whatever table is under here".
    void this.deps.pick(e.world[0], e.world[1]).then((id) => {
      if (id === null) return
      const prev = useStore.getState().selectedId
      // Remember the previous cell so `M` has something to merge with.
      this.mergePartner = prev !== null && prev !== id ? prev : null
      useStore.setState({ selectedId: id })
      void this.adopt(id)
    })
  }

  onPointerMove(e: ToolEvent): void {
    if (!this.meshState) return
    if (!this.drag) {
      const hit = hitDivider(this.meshState, e.world[0], e.world[1], HANDLE_SLOP_PX / e.scale)
      const changed = hit?.axis !== this.hover?.axis || hit?.index !== this.hover?.index
      this.hover = hit
      if (changed) this.deps.requestDraw()
      return
    }
    this.meshState = moveDivider(
      this.meshState,
      this.drag.axis,
      this.drag.index,
      this.drag.axis === 'col' ? e.world[0] : e.world[1],
    )
    this.deps.requestDraw()
  }

  onPointerUp(): void {
    const mesh = this.meshState
    if (!this.drag || !mesh) {
      this.drag = null
      return
    }
    this.drag = null
    const diff = meshEdits(mesh, this.original)
    if (diff.size === 0) return
    const at = Date.now()
    commit('tableDivider', (d) => {
      for (const [id, rect] of diff) {
        d.edits[id] = { ...d.edits[id], rect }
        d.dirtyAt[id] = at
      }
    })
    for (const [id, rect] of diff) this.original.set(id, rect)
    this.deps.requestDraw()
  }

  /**
   * `S` splits the selected cell along the axis it is longest in; `M` merges
   * the selected cell with the last-selected neighbour. Both commit in one
   * transaction so undo is one keystroke. No mesh or no selection is a no-op —
   * the FUNSD corpus has no tables at all.
   */
  onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const mesh = this.meshState
    const sel = useStore.getState().selectedId
    if (!mesh || sel === null) return
    const cell = mesh.cells.find((c) => c.id === sel)
    if (!cell) return

    if (e.key === 's' || e.key === 'S') {
      const meta = this.deps.nodeMeta(sel)
      if (!meta) return
      const rect = cellRect(mesh, cell)
      const axis = rect.w >= rect.h ? 'col' : 'row'
      const newId = this.deps.allocId()
      const next = splitCell(mesh, sel, axis, newId)
      if (next === mesh) return
      const fresh = next.cells.find((c) => c.id === newId)
      if (!fresh) return
      const freshRect = cellRect(next, fresh)
      this.meshState = next
      const at = Date.now()
      const diff = meshEdits(next, this.original)
      commit('tableSplit', (d) => {
        for (const [id, r] of diff) {
          if (id === newId) continue
          d.edits[id] = { ...d.edits[id], rect: r }
          d.dirtyAt[id] = at
        }
        d.edits[newId] = {
          created: { page: meta.page, type: NodeType.Cell, parent: meta.parent, order: meta.order },
          rect: freshRect,
        }
        d.dirtyAt[newId] = at
      })
      for (const [id, r] of diff) this.original.set(id, r)
      this.original.set(newId, freshRect)
      this.deps.requestDraw()
      return
    }

    if ((e.key === 'm' || e.key === 'M') && this.mergePartner !== null && this.mergePartner !== sel) {
      const next = mergeCells(mesh, sel, this.mergePartner)
      if (next === mesh) return
      const gone = this.mergePartner
      this.meshState = next
      const at = Date.now()
      const diff = meshEdits(next, this.original)
      commit('tableMerge', (d) => {
        for (const [id, r] of diff) {
          d.edits[id] = { ...d.edits[id], rect: r }
          d.dirtyAt[id] = at
        }
        d.edits[gone] = { ...d.edits[gone], deleted: true }
        d.dirtyAt[gone] = at
      })
      for (const [id, r] of diff) this.original.set(id, r)
      this.original.delete(gone)
      this.mergePartner = null
      this.deps.requestDraw()
    }
  }

  /**
   * Mesh lines, the grabbed/hovered line highlighted. Widths divide by scale so
   * they stay 1–2 screen px at any zoom.
   */
  drawHud(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    const mesh = this.meshState
    if (!mesh || mesh.cells.length === 0) return
    const px = 1 / vp.scale
    const active = this.drag ?? this.hover
    ctx.save()

    ctx.strokeStyle = 'rgba(255, 190, 120, 0.55)'
    ctx.lineWidth = px
    ctx.beginPath()
    for (let i = 0; i < mesh.cols.length; i++) {
      const x = mesh.cols[i]
      ctx.moveTo(x, mesh.bounds.y)
      ctx.lineTo(x, mesh.bounds.y + mesh.bounds.h)
    }
    for (let i = 0; i < mesh.rows.length; i++) {
      const y = mesh.rows[i]
      ctx.moveTo(mesh.bounds.x, y)
      ctx.lineTo(mesh.bounds.x + mesh.bounds.w, y)
    }
    ctx.stroke()

    if (active) {
      ctx.strokeStyle = 'rgba(255, 210, 90, 0.95)'
      ctx.lineWidth = 2 * px
      ctx.beginPath()
      if (active.axis === 'col') {
        const x = mesh.cols[active.index]
        ctx.moveTo(x, mesh.bounds.y)
        ctx.lineTo(x, mesh.bounds.y + mesh.bounds.h)
      } else {
        const y = mesh.rows[active.index]
        ctx.moveTo(mesh.bounds.x, y)
        ctx.lineTo(mesh.bounds.x + mesh.bounds.w, y)
      }
      ctx.stroke()
    }

    ctx.restore()
  }
}
