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
    if (panning) {
      engine.setViewport(panBy(engine.viewport, e.clientX - lastX, e.clientY - lastY))
      lastX = e.clientX
      lastY = e.clientY
      return
    }
    getTool()?.onMove?.(toWorld(e))
  }

  const onUp = (e: PointerEvent) => {
    if (pointerId === e.pointerId && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId)
    }
    pointerId = -1
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
