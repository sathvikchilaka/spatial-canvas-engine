import type { Rect } from '@/data/nodes'
import { indexOfId, type NodeArrays } from '@/data/nodes'
import { drawSelectionHud } from '@/engine/layers/hud'
import type { Viewport } from '@/engine/viewport'
import { commit, useStore, type Edit } from '@/store/store'
import type { Tool, ToolEvent } from './types'

/** Reading sequence after edits: `orderNext` overrides re-parent the chain. */
export function orderedIds(nodes: NodeArrays, edits: Record<number, Edit>): Uint32Array {
  const base: number[] = []
  for (let i = 0; i < nodes.count; i++) base.push(nodes.ids[i])
  base.sort((a, b) => nodes.order[indexOfId(nodes, a)] - nodes.order[indexOfId(nodes, b)])
  let seq: Uint32Array<ArrayBufferLike> = Uint32Array.from(base)
  for (const key of Object.keys(edits)) {
    const from = Number(key)
    const next = edits[from]?.orderNext
    if (next !== undefined && next !== null) seq = relink(seq, from, next)
  }
  return Uint32Array.from(seq)
}

/** Makes `toId` the immediate successor of `fromId`, without gaps or duplicates. */
export function relink(order: Uint32Array, fromId: number, toId: number): Uint32Array {
  if (fromId === toId) return order
  const list = Array.from(order)
  const to = list.indexOf(toId)
  if (to < 0) return order
  list.splice(to, 1)
  const from = list.indexOf(fromId)
  if (from < 0) return order
  list.splice(from + 1, 0, toId)
  return Uint32Array.from(list)
}

export type Arrow = { x1: number; y1: number; x2: number; y2: number; headAngle: number }

/** Centre-to-centre segment, clipped to each rect's edge. */
export function arrowPath(a: Rect, b: Rect): Arrow {
  const ax = a.x + a.w / 2
  const ay = a.y + a.h / 2
  const bx = b.x + b.w / 2
  const by = b.y + b.h / 2
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x1: ax, y1: ay, x2: bx, y2: by, headAngle: 0 }
  const ux = dx / len
  const uy = dy / len
  const clip = (r: Rect, sx: number, sy: number, vx: number, vy: number) => {
    const tx = vx === 0 ? Infinity : (r.w / 2) / Math.abs(vx)
    const ty = vy === 0 ? Infinity : (r.h / 2) / Math.abs(vy)
    const t = Math.min(tx, ty)
    return [sx + vx * t, sy + vy * t] as const
  }
  const [x1, y1] = clip(a, ax, ay, ux, uy)
  const [x2, y2] = clip(b, bx, by, -ux, -uy)
  return { x1, y1, x2, y2, headAngle: Math.atan2(dy, dx) }
}

export type OrderToolDeps = {
  getRect(id: number): Rect | null
  pick(wx: number, wy: number): Promise<number | null>
  requestDraw(): void
}

/** Drag from a selected box onto another to make it the successor. */
export class OrderTool implements Tool {
  readonly name = 'order'
  readonly ephemeralRect = null
  private dragFrom: number | null = null
  private cursor: [number, number] | null = null
  private deps: OrderToolDeps

  constructor(deps: OrderToolDeps) {
    this.deps = deps
  }

  get linking(): { from: number; cursor: [number, number] } | null {
    return this.dragFrom === null || !this.cursor
      ? null
      : { from: this.dragFrom, cursor: this.cursor }
  }

  onPointerDown(e: ToolEvent): void {
    void this.deps.pick(e.world[0], e.world[1]).then((id) => {
      if (id === null) return
      this.dragFrom = id
      this.cursor = [e.world[0], e.world[1]]
      useStore.setState({ selectedId: id })
      this.deps.requestDraw()
    })
  }

  onPointerMove(e: ToolEvent): void {
    if (this.dragFrom === null) return
    this.cursor = [e.world[0], e.world[1]]
    this.deps.requestDraw()
  }

  onPointerUp(e: ToolEvent): void {
    const from = this.dragFrom
    this.dragFrom = null
    this.cursor = null
    if (from === null) return
    void this.deps.pick(e.world[0], e.world[1]).then((to) => {
      if (to !== null && to !== from) {
        commit('relink', (d) => {
          d.edits[from] = { ...d.edits[from], orderNext: to }
          d.dirtyAt[from] = Date.now()
        })
      }
      this.deps.requestDraw()
    })
  }

  drawHud(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    const id = useStore.getState().selectedId
    const rect = id === null ? null : this.deps.getRect(id)
    if (rect) drawSelectionHud(ctx, rect, vp.scale)
    const link = this.linking
    if (!link) return
    const from = this.deps.getRect(link.from)
    if (!from) return
    ctx.save()
    ctx.strokeStyle = 'rgba(255, 210, 90, 0.95)'
    ctx.lineWidth = 2 / vp.scale
    ctx.beginPath()
    ctx.moveTo(from.x + from.w / 2, from.y + from.h / 2)
    ctx.lineTo(link.cursor[0], link.cursor[1])
    ctx.stroke()
    ctx.restore()
  }
}
