export type Viewport = { scale: number; tx: number; ty: number }

export const MIN_SCALE = 0.1
export const MAX_SCALE = 5

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/** world → screen (CSS px): p_screen = p_world * scale + t */
export function worldToScreen(vp: Viewport, wx: number, wy: number): [number, number] {
  return [wx * vp.scale + vp.tx, wy * vp.scale + vp.ty]
}

/** screen (CSS px) → world */
export function screenToWorld(vp: Viewport, sx: number, sy: number): [number, number] {
  return [(sx - vp.tx) / vp.scale, (sy - vp.ty) / vp.scale]
}

/**
 * Zoom about a screen point. Solving for the translate that keeps the world
 * point under the cursor fixed:
 *   sx = wx * s  + tx   →   wx = (sx - tx) / s
 *   sx = wx * s' + tx'  →   tx' = sx - wx * s'
 */
export function zoomAt(vp: Viewport, sx: number, sy: number, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor)
  if (scale === vp.scale) return vp
  const [wx, wy] = screenToWorld(vp, sx, sy)
  return { scale, tx: sx - wx * scale, ty: sy - wy * scale }
}

export function panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { scale: vp.scale, tx: vp.tx + dxScreen, ty: vp.ty + dyScreen }
}

/**
 * Keeps the document's world-space bounds within reach of the viewport — no
 * panning into empty space beyond an edge. When content is smaller than the
 * viewport on an axis, that axis is centered instead of clamped to a range.
 */
export function clampPan(
  vp: Viewport,
  bounds: { maxX: number; maxY: number },
  cssW: number,
  cssH: number,
): Viewport {
  const contentW = bounds.maxX * vp.scale
  const contentH = bounds.maxY * vp.scale
  const tx = contentW <= cssW ? (cssW - contentW) / 2 : Math.min(0, Math.max(cssW - contentW, vp.tx))
  const ty = contentH <= cssH ? (cssH - contentH) / 2 : Math.min(0, Math.max(cssH - contentH, vp.ty))
  return tx === vp.tx && ty === vp.ty ? vp : { scale: vp.scale, tx, ty }
}

export function visibleWorldRect(vp: Viewport, cssW: number, cssH: number) {
  const [x, y] = screenToWorld(vp, 0, 0)
  return { x, y, w: cssW / vp.scale, h: cssH / vp.scale }
}
