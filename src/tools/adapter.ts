import type { CanvasEngine } from '@/engine/engine'
import type { ToolHandlers, WorldPointer } from '@/engine/input'
import type { Tool, ToolEvent } from './types'

const toEvent = (p: WorldPointer, scale: number): ToolEvent => ({
  world: [p.x, p.y],
  screen: [p.sx, p.sy],
  scale,
  shift: p.shift,
  alt: p.alt,
})

/**
 * Adapts a Tool to the input layer. `onDown` returns true when the tool claims
 * the gesture, which suppresses the pan fallback.
 *
 * Pointer *moves* are forwarded whether or not the tool claimed anything, so a
 * tool can render a pre-grab affordance under an idle cursor (the table tool's
 * divider highlight). Every tool's `onPointerMove` already returns immediately
 * unless it holds a gesture, and the input layer swallows moves while panning,
 * so an unclaimed move can only ever update hover state. `onUp` stays gated:
 * only the tool that claimed the gesture may terminate and commit it.
 */
export function toolHandlers(tool: Tool, engine: CanvasEngine): ToolHandlers {
  let claimed = false
  return {
    onDown(p) {
      tool.onPointerDown(toEvent(p, engine.viewport.scale))
      claimed = tool.capturing ?? tool.ephemeralRect !== null
      return claimed
    },
    onMove(p) {
      tool.onPointerMove(toEvent(p, engine.viewport.scale))
    },
    onUp(p) {
      if (!claimed) return
      tool.onPointerUp(toEvent(p, engine.viewport.scale))
      claimed = false
    },
    onKey(e) {
      tool.onKeyDown?.(e)
    },
  }
}
