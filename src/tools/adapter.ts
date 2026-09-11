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
 * so an unclaimed move can only ever update hover state.
 *
 * `onUp` is gated on `claimed` snapshotted at down-time OR `tool.capturing`
 * read fresh at up-time. The fresh read matters for a tool like `OrderTool`
 * whose gesture starts inside an async `pick().then()`: `claimed` is always
 * false right after `onPointerDown` returns because that promise has not
 * resolved yet, but by the time a real pointer-up fires it almost always has,
 * so `capturing` is what tells `onUp` there is a gesture to terminate. Without
 * this, such a tool's `dragFrom`/similar in-flight state is only ever set, so
 * an idle move after one click updates its cursor forever.
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
      if (!claimed && !tool.capturing) return
      tool.onPointerUp(toEvent(p, engine.viewport.scale))
      claimed = false
    },
    onKey(e) {
      tool.onKeyDown?.(e)
    },
  }
}
