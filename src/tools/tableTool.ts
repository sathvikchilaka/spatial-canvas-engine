import type { Rect } from '@/data/nodes'
import type { Viewport } from '@/engine/viewport'
import { commit, useStore } from '@/store/store'
import {
  buildMesh,
  cellRect,
  hitDivider,
  moveDivider,
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
    for (const x of mesh.cols) {
      ctx.moveTo(x, mesh.bounds.y)
      ctx.lineTo(x, mesh.bounds.y + mesh.bounds.h)
    }
    for (const y of mesh.rows) {
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
