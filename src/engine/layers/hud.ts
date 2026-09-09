import type { Rect } from '@/data/nodes'

const HANDLE_PX = 8

/** Handle centres as [dx, dy] fractions of the rect. */
const HANDLES: [number, number][] = [
  [0, 0], [0.5, 0], [1, 0],
  [1, 0.5], [1, 1], [0.5, 1],
  [0, 1], [0, 0.5],
]

/**
 * Selection outline, eight handles, and snap guides. Sizes divide by scale so
 * they stay constant in screen pixels at any zoom.
 */
export function drawSelectionHud(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  scale: number,
  guides: number[] = [],
): void {
  const px = 1 / scale
  ctx.save()
  ctx.lineWidth = 1.5 * px
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)

  const s = HANDLE_PX * px
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.strokeStyle = 'rgba(20,20,20,0.9)'
  ctx.lineWidth = px
  for (const [fx, fy] of HANDLES) {
    const hx = rect.x + rect.w * fx - s / 2
    const hy = rect.y + rect.h * fy - s / 2
    ctx.fillRect(hx, hy, s, s)
    ctx.strokeRect(hx, hy, s, s)
  }

  if (guides.length) {
    ctx.strokeStyle = 'rgba(120,200,255,0.9)'
    ctx.lineWidth = px
    ctx.setLineDash([6 * px, 4 * px])
    const span = 4000 * px * scale
    ctx.beginPath()
    for (let i = 0; i < guides.length; i += 2) {
      const axis = guides[i]
      const coord = guides[i + 1]
      if (axis === 0) {
        ctx.moveTo(coord, rect.y - span)
        ctx.lineTo(coord, rect.y + rect.h + span)
      } else {
        ctx.moveTo(rect.x - span, coord)
        ctx.lineTo(rect.x + rect.w + span, coord)
      }
    }
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.restore()
}
