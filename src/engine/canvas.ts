/** Sizes the backing store in device pixels and the element in CSS pixels. */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  dpr: number,
): void {
  canvas.width = Math.ceil(cssW * dpr)
  canvas.height = Math.ceil(cssH * dpr)
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
}

/** Half a device pixel, in CSS units — puts 1px strokes on a pixel boundary. */
export const crispOffset = (dpr: number) => 0.5 / dpr
