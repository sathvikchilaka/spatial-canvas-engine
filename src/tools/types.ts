import type { Rect } from '@/data/nodes'
import type { Viewport } from '@/engine/viewport'

export type ToolEvent = {
  world: [number, number]
  screen: [number, number]
  scale: number
  shift: boolean
  alt: boolean
}

export type Tool = {
  name: string
  onPointerDown(e: ToolEvent): void
  onPointerMove(e: ToolEvent): void
  onPointerUp(e: ToolEvent): void
  onKeyDown?(e: KeyboardEvent): void
  drawHud(ctx: CanvasRenderingContext2D, vp: Viewport): void
  /** Geometry mid-gesture; the store sees nothing until commit. */
  readonly ephemeralRect: Rect | null
  /**
   * True while the tool owns the pointer. The adapter suppresses the pan
   * fallback on this, not on `ephemeralRect` — a tool can hold a gesture
   * (dragging a table divider) without producing a draft rect.
   */
  readonly capturing?: boolean
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | null

/** Handle hit slop and snap tolerance, in SCREEN px — divided by scale to reach world units. */
export const HANDLE_SLOP_PX = 8
export const SNAP_TOLERANCE_PX = 6
export const MIN_SIZE = 4
