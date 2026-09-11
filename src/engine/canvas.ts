/**
 * Sizes the backing store in device pixels and the element in CSS pixels.
 *
 * Every write here is guarded on an actual change. The caller is a
 * ResizeObserver on the canvas's own parent, so an unconditional style write
 * invalidates the layout of the subtree being observed and can re-arm the
 * observer that just fired — an invalidate/measure loop that shows up as a
 * forced reflow on every burst.
 */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  dpr: number,
): void {
  const w = Math.ceil(cssW * dpr)
  const h = Math.ceil(cssH * dpr)
  // Assigning width/height also clears the canvas, so skipping the no-op write
  // saves a full repaint, not just the layout.
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const styleW = `${cssW}px`
  const styleH = `${cssH}px`
  if (canvas.style.width !== styleW) canvas.style.width = styleW
  if (canvas.style.height !== styleH) canvas.style.height = styleH
}

/** Half a device pixel, in CSS units — puts 1px strokes on a pixel boundary. */
export const crispOffset = (dpr: number) => 0.5 / dpr
