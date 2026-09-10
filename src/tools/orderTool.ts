import type { Rect } from '@/data/nodes'
import { drawSelectionHud } from '@/engine/layers/hud'
import type { Viewport } from '@/engine/viewport'
import { commit, setUiState, useStore } from '@/store/store'
import type { Tool, ToolEvent } from './types'

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
  hasEdge(from: number, to: number): boolean
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

  /**
   * `dragFrom` is set asynchronously inside `pick().then()`, so it is never
   * true at `onPointerDown` return time — the adapter's `claimed` check reads
   * this getter before that promise resolves. Because of that, `onUp` is
   * never gated in from the app today (pre-existing; link commits are
   * unreachable that way), so `dragFrom` must be cleared elsewhere: see
   * `reset()`.
   */
  get capturing(): boolean {
    return this.dragFrom !== null
  }

  /** Drops any in-flight link-drag state. Called when this tool stops owning the pointer. */
  reset(): void {
    this.dragFrom = null
    this.cursor = null
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
      setUiState({ selectedId: id })
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
        const exists = this.deps.hasEdge(from, to)
        commit(exists ? 'unlink' : 'link', (d) => {
          if (exists) d.edgesRemoved = [...d.edgesRemoved, [from, to]]
          else d.edgesAdded = [...d.edgesAdded, [from, to]]
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
