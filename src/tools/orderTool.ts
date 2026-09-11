import type { Rect } from '@/data/nodes'
import { drawSelectionHud } from '@/engine/layers/hud'
import type { Viewport } from '@/engine/viewport'
import { commit, setUiState, useStore } from '@/store/store'
import { HANDLE_SLOP_PX, type Tool, type ToolEvent } from './types'

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

export type EdgeEndpoint = { from: number; to: number; end: 'head' | 'tail' }

/** One arrow the overlay actually painted, in world coords. */
export type ArrowRecord = { from: number; to: number; x1: number; y1: number; x2: number; y2: number }

/**
 * Which arrow endpoint a world point grabs. Only the arrows the overlay drew
 * last frame are candidates — the graph has tens of thousands of edges, but the
 * reviewer can only grab one that is on screen, so hit-testing the painted set
 * is both correct and O(visible arrows).
 *
 * `slopWorld` is screen slop / scale, so the grab target is constant in screen
 * px at any zoom. Heads win a tie: re-pointing a successor is the frequent
 * gesture, re-pointing a predecessor the rare one.
 */
export function hitEndpoint(
  arrows: readonly ArrowRecord[],
  count: number,
  wx: number,
  wy: number,
  slopWorld: number,
): EdgeEndpoint | null {
  let best: EdgeEndpoint | null = null
  let bestD = slopWorld
  for (let i = 0; i < count; i++) {
    const a = arrows[i]
    const dh = Math.hypot(wx - a.x2, wy - a.y2)
    if (dh <= bestD) {
      bestD = dh
      best = { from: a.from, to: a.to, end: 'head' }
    }
    const dt = Math.hypot(wx - a.x1, wy - a.y1)
    if (dt < bestD) {
      bestD = dt
      best = { from: a.from, to: a.to, end: 'tail' }
    }
  }
  return best
}

export type OrderToolDeps = {
  getRect(id: number): Rect | null
  pick(wx: number, wy: number): Promise<number | null>
  requestDraw(): void
  hasEdge(from: number, to: number): boolean
  /** The arrows the overlay painted last frame — the endpoint hit-test candidates. */
  arrows(): { list: readonly ArrowRecord[]; count: number }
}

/** Drag from a selected box onto another to make it the successor. */
export class OrderTool implements Tool {
  readonly name = 'order'
  readonly ephemeralRect = null
  private dragFrom: number | null = null
  private cursor: [number, number] | null = null
  private reparent: { endpoint: EdgeEndpoint; cursor: [number, number] } | null = null
  private deps: OrderToolDeps

  constructor(deps: OrderToolDeps) {
    this.deps = deps
  }

  /**
   * Two paths set this true, on different clocks. `dragFrom` (link gesture) is
   * set asynchronously inside `pick().then()`, so it is NOT true at
   * `onPointerDown` return time — the adapter reads `capturing` again at
   * pointer-up, by which point the promise has resolved, so `dragFrom` must be
   * cleared explicitly on teardown; see `reset()`. `reparent` (endpoint drag)
   * is set synchronously inside `onPointerDown` itself — grabbing a live arrow
   * endpoint is detected without a `pick()` round-trip — and is cleared
   * synchronously at the top of `onPointerUp`, before the async `pick().then()`
   * that resolves the commit.
   */
  get capturing(): boolean {
    return this.reparent !== null || this.dragFrom !== null
  }

  /** Drops any in-flight link-drag or re-parent state. Called when this tool stops owning the pointer. */
  reset(): void {
    this.dragFrom = null
    this.cursor = null
    this.reparent = null
  }

  get linking(): { from: number; cursor: [number, number] } | null {
    return this.dragFrom === null || !this.cursor
      ? null
      : { from: this.dragFrom, cursor: this.cursor }
  }

  /** In-flight endpoint drag, for the HUD and tests. */
  get dragging(): { endpoint: EdgeEndpoint; cursor: [number, number] } | null {
    return this.reparent
  }

  onPointerDown(e: ToolEvent): void {
    const { list, count } = this.deps.arrows()
    const grabbed = hitEndpoint(list, count, e.world[0], e.world[1], HANDLE_SLOP_PX / e.scale)
    if (grabbed) {
      // Grabbing a live arrow endpoint is a re-parent, not a new link.
      this.reparent = { endpoint: grabbed, cursor: [e.world[0], e.world[1]] }
      this.deps.requestDraw()
      return
    }
    void this.deps.pick(e.world[0], e.world[1]).then((id) => {
      if (id === null) return
      this.dragFrom = id
      this.cursor = [e.world[0], e.world[1]]
      setUiState({ selectedId: id })
      this.deps.requestDraw()
    })
  }

  onPointerMove(e: ToolEvent): void {
    if (this.reparent) {
      this.reparent.cursor = [e.world[0], e.world[1]]
      this.deps.requestDraw()
      return
    }
    if (this.dragFrom === null) return
    this.cursor = [e.world[0], e.world[1]]
    this.deps.requestDraw()
  }

  onPointerUp(e: ToolEvent): void {
    const rp = this.reparent
    this.reparent = null
    if (rp) {
      void this.deps.pick(e.world[0], e.world[1]).then((target) => {
        this.commitReparent(rp.endpoint, target)
        this.deps.requestDraw()
      })
      return
    }
    const from = this.dragFrom
    this.dragFrom = null
    this.cursor = null
    if (from === null) return
    void this.deps.pick(e.world[0], e.world[1]).then((to) => {
      if (to !== null && to !== from) {
        const exists = this.deps.hasEdge(from, to)
        commit(exists ? 'unlink' : 'link', (d) => {
          if (exists) {
            d.edgesAdded = d.edgesAdded.filter(([f, t]) => !(f === from && t === to))
            d.edgesRemoved = [...d.edgesRemoved, [from, to]]
          } else {
            d.edgesRemoved = d.edgesRemoved.filter(([f, t]) => !(f === from && t === to))
            d.edgesAdded = [...d.edgesAdded, [from, to]]
          }
          d.dirtyAt[from] = Date.now()
        })
      }
      this.deps.requestDraw()
    })
  }

  /**
   * Removing the old edge and adding the new one in a *single* `commit` is the
   * whole point: a re-parent is one reviewer intent, so it must be one undo
   * step. Two commits would make Cmd+Z leave the graph disconnected.
   */
  private commitReparent(endpoint: EdgeEndpoint, target: number | null): void {
    if (target === null) return
    const { from, to, end } = endpoint
    const next: [number, number] = end === 'head' ? [from, target] : [target, to]
    // No-op drops: back onto the same node, or onto the other end (a self-edge).
    if (next[0] === next[1]) return
    if (next[0] === from && next[1] === to) return

    commit('reparent', (d) => {
      // Removing [from,to] may undo a pair a prior gesture added, and adding
      // `next` may resurrect a pair a prior gesture removed (drag an edge away
      // then back to its original target). Prune the opposing list both ways so
      // materialize's drop set never vetoes an edge a later gesture restores.
      d.edgesAdded = d.edgesAdded.filter(([f, t]) => !(f === from && t === to))
      d.edgesRemoved = d.edgesRemoved.filter(([f, t]) => !(f === next[0] && t === next[1]))
      d.edgesRemoved = [...d.edgesRemoved, [from, to]]
      d.edgesAdded = [...d.edgesAdded, next]
      d.dirtyAt[next[0]] = Date.now()
    })
  }

  drawHud(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    const id = useStore.getState().selectedId
    const rect = id === null ? null : this.deps.getRect(id)
    if (rect) drawSelectionHud(ctx, rect, vp.scale)
    const link = this.linking
    if (link) {
      const from = this.deps.getRect(link.from)
      if (from) {
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

    // Re-parent rubber band: anchored at the end that is NOT moving.
    if (this.reparent) {
      const { from, to, end } = this.reparent.endpoint
      const anchor = this.deps.getRect(end === 'head' ? from : to)
      if (anchor) {
        ctx.save()
        ctx.strokeStyle = 'rgba(255, 140, 90, 0.95)'
        ctx.lineWidth = 2 / vp.scale
        ctx.setLineDash([6 / vp.scale, 4 / vp.scale])
        ctx.beginPath()
        ctx.moveTo(anchor.x + anchor.w / 2, anchor.y + anchor.h / 2)
        ctx.lineTo(this.reparent.cursor[0], this.reparent.cursor[1])
        ctx.stroke()
        ctx.restore()
      }
    }

    // Endpoint handles, so it is visible that arrows are grabbable at all.
    const { list, count } = this.deps.arrows()
    if (count > 0) {
      const r = 3 / vp.scale
      ctx.save()
      ctx.fillStyle = 'rgba(255, 210, 90, 0.9)'
      ctx.beginPath()
      for (let i = 0; i < count; i++) {
        const a = list[i]
        ctx.moveTo(a.x2 + r, a.y2)
        ctx.arc(a.x2, a.y2, r, 0, Math.PI * 2)
        ctx.moveTo(a.x1 + r, a.y1)
        ctx.arc(a.x1, a.y1, r, 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.restore()
    }
  }
}
