import type { CanvasEngine } from './engine'
import { panBy, screenToWorld, zoomAt } from './viewport'

export type WorldPointer = {
  x: number
  y: number
  sx: number
  sy: number
  shift: boolean
  alt: boolean
  button: number
}

/** A tool is a state machine over world-space pointer events. */
export type ToolHandlers = {
  onDown?(p: WorldPointer): boolean | void
  onMove?(p: WorldPointer): boolean | void
  onUp?(p: WorldPointer): boolean | void
  onKey?(e: KeyboardEvent): boolean | void
}

const ZOOM_PER_WHEEL = 0.0015

export type PinchState = { dist: number; cx: number; cy: number }

/**
 * Pure two-pointer gesture math, kept out of the event plumbing so it can be
 * tested without a touchscreen. `factor` is the ratio of pointer separations,
 * fed straight to `zoomAt` at the midpoint — the same zoom-to-cursor path the
 * wheel uses, so touch and trackpad cannot drift apart.
 */
export function pinchUpdate(
  prev: PinchState,
  a: { x: number; y: number },
  b: { x: number; y: number },
): PinchState & { factor: number } {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const cx = (a.x + b.x) / 2
  const cy = (a.y + b.y) / 2
  const factor = prev.dist > 0 && dist > 0 ? dist / prev.dist : 1
  return { dist, cx, cy, factor }
}

/**
 * Pointer/wheel → world coords → the active tool, falling back to pan/zoom.
 * Handlers only mark the frame dirty; they never draw.
 */
export function attachInput(
  engine: CanvasEngine,
  canvas: HTMLCanvasElement,
  getTool: () => ToolHandlers | null,
): () => void {
  let panning = false
  let lastX = 0
  let lastY = 0
  let pointerId = -1

  /** Live pointers, for the two-finger pinch. Client (viewport) px. */
  const active = new Map<number, { clientX: number; clientY: number }>()
  let pinch: PinchState | null = null
  /** The pointer ids the current `pinch` baseline was seeded from. */
  let pinchIds: [number, number] | null = null

  const toWorld = (e: PointerEvent): WorldPointer => {
    const r = canvas.getBoundingClientRect()
    const sx = e.clientX - r.left
    const sy = e.clientY - r.top
    const [x, y] = screenToWorld(engine.viewport, sx, sy)
    return { x, y, sx, sy, shift: e.shiftKey, alt: e.altKey, button: e.button }
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const r = canvas.getBoundingClientRect()
    const sx = e.clientX - r.left
    const sy = e.clientY - r.top
    if (e.ctrlKey || e.metaKey) {
      // ctrl/⌘+wheel and trackpad pinch both arrive here.
      engine.setViewport(zoomAt(engine.viewport, sx, sy, Math.exp(-e.deltaY * ZOOM_PER_WHEEL)))
    } else if (e.shiftKey) {
      engine.setViewport(panBy(engine.viewport, -e.deltaY, 0))
    } else {
      engine.setViewport(panBy(engine.viewport, -e.deltaX, -e.deltaY))
    }
  }

  const onDown = (e: PointerEvent) => {
    active.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })
    if (active.size >= 2) {
      // A second (or further) finger supersedes any single-pointer gesture in
      // progress. The pinch baseline itself is (re)seeded in `onMove`, so a
      // pair swap mid-gesture goes through the same seeding path (finding 2)
      // instead of being duplicated here.
      panning = false
      return
    }
    const p = toWorld(e)
    if (getTool()?.onDown?.(p)) {
      canvas.setPointerCapture(e.pointerId)
      pointerId = e.pointerId
      return
    }
    if (e.button === 0 || e.button === 1) {
      panning = true
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
      pointerId = e.pointerId
    }
  }

  const onMove = (e: PointerEvent) => {
    if (active.has(e.pointerId)) {
      active.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })
    }
    if (active.size >= 2) {
      const r = canvas.getBoundingClientRect()
      const entries = [...active.entries()]
      const [id1, c1] = entries[0]
      const [id2, c2] = entries[1]
      const p1 = { x: c1.clientX - r.left, y: c1.clientY - r.top }
      const p2 = { x: c2.clientX - r.left, y: c2.clientY - r.top }
      const samePair = pinch !== null && pinchIds !== null && pinchIds[0] === id1 && pinchIds[1] === id2
      if (!samePair) {
        // A fresh pinch, or the pinched pair's identity changed (a third
        // finger joined and one of the original two lifted) — reseed the
        // baseline instead of comparing against a stale pair (finding 2).
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        pinch = { dist, cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2 }
        pinchIds = [id1, id2]
      } else if (pinch) {
        const next = pinchUpdate(pinch, p1, p2)
        // Zoom about the midpoint, then pan by the midpoint's own drift, so a
        // two-finger drag pans and a two-finger spread zooms — both at once.
        let vp = zoomAt(engine.viewport, next.cx, next.cy, next.factor)
        vp = panBy(vp, next.cx - pinch.cx, next.cy - pinch.cy)
        engine.setViewport(vp)
        pinch = next
      }
      return
    }
    if (panning) {
      engine.setViewport(panBy(engine.viewport, e.clientX - lastX, e.clientY - lastY))
      lastX = e.clientX
      lastY = e.clientY
      return
    }
    getTool()?.onMove?.(toWorld(e))
  }

  const onUp = (e: PointerEvent) => {
    const wasPinching = pinch !== null
    active.delete(e.pointerId)

    if (pointerId === e.pointerId && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId)
    }
    pointerId = -1

    if (wasPinching) {
      if (active.size < 2) {
        pinch = null
        pinchIds = null
        if (active.size === 1) {
          // One finger survives the pinch: hand off to a pan using it, so the
          // canvas doesn't go dead until a full release+press cycle
          // (finding 1) — `onMove` will keep it moving from here.
          const [survivor] = active.values()
          panning = true
          lastX = survivor.clientX
          lastY = survivor.clientY
        } else {
          panning = false
        }
      }
      // A lifted pinch finger never drove the active tool; nothing else to do.
      return
    }

    if (panning) {
      panning = false
      return
    }
    getTool()?.onUp?.(toWorld(e))
  }

  const onKey = (e: KeyboardEvent) => {
    getTool()?.onKey?.(e)
  }

  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  window.addEventListener('keydown', onKey)

  return () => {
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onUp)
    window.removeEventListener('keydown', onKey)
  }
}
