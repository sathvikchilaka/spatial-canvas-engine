import type { Rect } from '@/data/nodes'
import type { Viewport } from '@/engine/viewport'
import { drawSelectionHud } from '@/engine/layers/hud'
import { beginCoalesce, commit, endCoalesce, useStore } from '@/store/store'
import {
  HANDLE_SLOP_PX, MIN_SIZE, SNAP_TOLERANCE_PX,
  type Handle, type Tool, type ToolEvent,
} from './types'

/** Which handle the world point lands on. Slop is constant in screen px. */
export function hitHandle(rect: Rect, wx: number, wy: number, scale: number): Handle {
  const slop = HANDLE_SLOP_PX / scale
  const { x, y, w, h } = rect
  const nearL = Math.abs(wx - x) <= slop
  const nearR = Math.abs(wx - (x + w)) <= slop
  const nearT = Math.abs(wy - y) <= slop
  const nearB = Math.abs(wy - (y + h)) <= slop
  const insideX = wx >= x - slop && wx <= x + w + slop
  const insideY = wy >= y - slop && wy <= y + h + slop

  if (insideX && insideY) {
    if (nearL && nearT) return 'nw'
    if (nearR && nearT) return 'ne'
    if (nearL && nearB) return 'sw'
    if (nearR && nearB) return 'se'
    if (nearT) return 'n'
    if (nearB) return 's'
    if (nearL) return 'w'
    if (nearR) return 'e'
  }
  if (wx >= x && wx <= x + w && wy >= y && wy <= y + h) return 'move'
  return null
}

/** Resize from the handle's opposite anchor. Clamps rather than inverting. */
export function resizeRect(rect: Rect, handle: Handle, dx: number, dy: number): Rect {
  if (!handle) return rect
  if (handle === 'move') return { ...rect, x: rect.x + dx, y: rect.y + dy }

  let { x, y, w, h } = rect
  if (handle.includes('w')) {
    const nx = Math.min(x + dx, x + w - MIN_SIZE)
    w += x - nx
    x = nx
  }
  if (handle.includes('e')) w = Math.max(MIN_SIZE, w + dx)
  if (handle.includes('n')) {
    const ny = Math.min(y + dy, y + h - MIN_SIZE)
    h += y - ny
    y = ny
  }
  if (handle.includes('s')) h = Math.max(MIN_SIZE, h + dy)
  return { x, y, w: Math.max(MIN_SIZE, w), h: Math.max(MIN_SIZE, h) }
}

export type Snaps = { dx: number; dy: number; guides: number[] }

/**
 * Nearest edge alignment to any candidate rect within tolerance.
 * `guides` is a flat [axis, coord, …] list — 0 = vertical, 1 = horizontal.
 */
export function findSnaps(
  rect: Rect,
  candidates: Float32Array,
  count: number,
  toleranceWorld: number,
): Snaps {
  let bestDx = 0
  let bestDy = 0
  let bestXDist = toleranceWorld
  let bestYDist = toleranceWorld
  let guideX = 0
  let guideY = 0
  let hasX = false
  let hasY = false

  const rx = [rect.x, rect.x + rect.w]
  const ry = [rect.y, rect.y + rect.h]

  for (let i = 0; i < count; i++) {
    const c = i * 4
    const cx = [candidates[c], candidates[c] + candidates[c + 2]]
    const cy = [candidates[c + 1], candidates[c + 1] + candidates[c + 3]]
    for (const a of rx) {
      for (const b of cx) {
        const d = Math.abs(b - a)
        if (d < bestXDist) {
          bestXDist = d
          bestDx = b - a
          guideX = b
          hasX = true
        }
      }
    }
    for (const a of ry) {
      for (const b of cy) {
        const d = Math.abs(b - a)
        if (d < bestYDist) {
          bestYDist = d
          bestDy = b - a
          guideY = b
          hasY = true
        }
      }
    }
  }

  const guides: number[] = []
  if (hasX) guides.push(0, guideX)
  if (hasY) guides.push(1, guideY)
  return { dx: bestDx, dy: bestDy, guides }
}

export type SelectToolDeps = {
  /** Committed geometry of a node, or null if unknown. */
  getRect(id: number): Rect | null
  /** Async exact pick, worker-side. */
  pick(wx: number, wy: number): Promise<number | null>
  /** Candidate rects near a world rect, written into `out`; returns the count. */
  nearby(rect: Rect, pad: number, out: Float32Array, excludeId: number): number
  requestDraw(): void
}

type Phase = 'idle' | 'dragging'

/**
 * idle → dragging(handle) → commit. Mid-drag geometry lives here, not in the
 * store: one gesture must be exactly one undo entry.
 */
export class SelectTool implements Tool {
  readonly name = 'select'
  private phase: Phase = 'idle'
  private handle: Handle = null
  private startWorld: [number, number] = [0, 0]
  private originRect: Rect | null = null
  private draft: Rect | null = null
  private guides: number[] = []
  private readonly candidates = new Float32Array(512 * 4)
  private deps: SelectToolDeps

  constructor(deps: SelectToolDeps) {
    this.deps = deps
  }

  get ephemeralRect(): Rect | null {
    return this.draft
  }

  onPointerDown(e: ToolEvent): void {
    const selectedId = useStore.getState().selectedId
    const rect = selectedId === null ? null : this.deps.getRect(selectedId)
    // Test the current selection synchronously — a drag has to start on this
    // same gesture, so it cannot wait for the worker round-trip.
    const handle = rect ? hitHandle(rect, e.world[0], e.world[1], e.scale) : null
    if (rect && handle) {
      this.phase = 'dragging'
      this.handle = handle
      this.startWorld = [e.world[0], e.world[1]]
      this.originRect = rect
      this.draft = rect
      beginCoalesce(`editBox:${selectedId}`)
      return
    }
    void this.deps.pick(e.world[0], e.world[1]).then((id) => {
      useStore.setState({ selectedId: id })
      this.deps.requestDraw()
    })
  }

  onPointerMove(e: ToolEvent): void {
    if (this.phase !== 'dragging' || !this.originRect) return
    const dx = e.world[0] - this.startWorld[0]
    const dy = e.world[1] - this.startWorld[1]
    let next = resizeRect(this.originRect, this.handle, dx, dy)

    if (!e.alt) {
      const tol = SNAP_TOLERANCE_PX / e.scale
      const id = useStore.getState().selectedId ?? -1
      const n = this.deps.nearby(next, tol, this.candidates, id)
      const snap = findSnaps(next, this.candidates, n, tol)
      if (snap.dx || snap.dy) {
        next =
          this.handle === 'move'
            ? { ...next, x: next.x + snap.dx, y: next.y + snap.dy }
            : { ...next, w: next.w + snap.dx, h: next.h + snap.dy }
      }
      this.guides = snap.guides
    } else {
      this.guides = []
    }

    this.draft = next
    this.deps.requestDraw()
  }

  onPointerUp(): void {
    if (this.phase !== 'dragging' || !this.draft || !this.originRect) return
    const id = useStore.getState().selectedId
    const from = this.originRect
    const to = this.draft
    if (id !== null && (from.x !== to.x || from.y !== to.y || from.w !== to.w || from.h !== to.h)) {
      commit(`editBox:${id}`, (d) => {
        d.edits[id] = { ...d.edits[id], rect: to }
        d.dirtyAt[id] = Date.now()
      })
    }
    endCoalesce()
    this.phase = 'idle'
    this.handle = null
    this.draft = null
    this.originRect = null
    this.guides = []
    this.deps.requestDraw()
  }

  drawHud(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    const id = useStore.getState().selectedId
    const rect = this.draft ?? (id === null ? null : this.deps.getRect(id))
    if (!rect) return
    drawSelectionHud(ctx, rect, vp.scale, this.guides)
  }
}
