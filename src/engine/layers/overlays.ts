import type { NodeArrays, Rect } from '@/data/nodes'
import { arrowPath } from '@/tools/orderTool'

const MAX_ARROWS = 300
const HEAD = 9
const BADGE_MIN_SCALE = 0.6

/**
 * Reading-order arrows, drawn only between nodes already culled in — 10k
 * arrows would destroy the frame budget on their own. Past the cap only the
 * selected node's neighbours are drawn.
 */
export class OrderOverlay {
  private readonly rectA: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private readonly rectB: Rect = { x: 0, y: 0, w: 0, h: 0 }
  /** node index → position in the reading sequence, rebuilt on demand */
  private seqOf = new Int32Array(0)
  private seq: Uint32Array = new Uint32Array(0)

  setSequence(nodes: NodeArrays, seq: Uint32Array, indexOfId: (id: number) => number): void {
    this.seq = seq
    this.seqOf = new Int32Array(nodes.count).fill(-1)
    for (let k = 0; k < seq.length; k++) {
      const i = indexOfId(seq[k])
      if (i >= 0) this.seqOf[i] = k
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    nodes: NodeArrays,
    visible: Uint32Array,
    visibleCount: number,
    scale: number,
    selectedIndex: number,
    indexOfId: (id: number) => number,
  ): void {
    if (this.seq.length === 0) return
    const onScreen = new Set<number>()
    for (let k = 0; k < visibleCount; k++) onScreen.add(visible[k])

    const budget = visibleCount > MAX_ARROWS && selectedIndex >= 0 ? 2 : MAX_ARROWS
    ctx.save()
    ctx.strokeStyle = 'rgba(120, 220, 180, 0.8)'
    ctx.fillStyle = 'rgba(120, 220, 180, 0.8)'
    ctx.lineWidth = 1.25 / scale

    let drawn = 0
    const start =
      budget === 2 && selectedIndex >= 0 ? Math.max(0, this.seqOf[selectedIndex] - 1) : 0
    for (let k = start; k < this.seq.length - 1 && drawn < budget; k++) {
      const ia = indexOfId(this.seq[k])
      const ib = indexOfId(this.seq[k + 1])
      if (ia < 0 || ib < 0) continue
      if (!onScreen.has(ia) && !onScreen.has(ib)) continue
      readRect(nodes, ia, this.rectA)
      readRect(nodes, ib, this.rectB)
      const p = arrowPath(this.rectA, this.rectB)
      ctx.beginPath()
      ctx.moveTo(p.x1, p.y1)
      ctx.lineTo(p.x2, p.y2)
      ctx.stroke()
      const h = HEAD / scale
      ctx.beginPath()
      ctx.moveTo(p.x2, p.y2)
      ctx.lineTo(
        p.x2 - h * Math.cos(p.headAngle - 0.4),
        p.y2 - h * Math.sin(p.headAngle - 0.4),
      )
      ctx.lineTo(
        p.x2 - h * Math.cos(p.headAngle + 0.4),
        p.y2 - h * Math.sin(p.headAngle + 0.4),
      )
      ctx.closePath()
      ctx.fill()
      drawn++
    }

    if (scale >= BADGE_MIN_SCALE) this.drawBadges(ctx, nodes, visible, visibleCount, scale)
    ctx.restore()
  }

  private drawBadges(
    ctx: CanvasRenderingContext2D,
    nodes: NodeArrays,
    visible: Uint32Array,
    visibleCount: number,
    scale: number,
  ) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = `${11 / scale}px ui-monospace, monospace`
    ctx.textBaseline = 'top'
    const cap = Math.min(visibleCount, MAX_ARROWS)
    for (let k = 0; k < cap; k++) {
      const i = visible[k]
      const seq = this.seqOf[i]
      if (seq < 0) continue
      const c = i * 4
      ctx.fillText(String(seq), nodes.coords[c] + 2 / scale, nodes.coords[c + 1] + 2 / scale)
    }
  }
}

function readRect(nodes: NodeArrays, i: number, out: Rect) {
  const c = i * 4
  out.x = nodes.coords[c]
  out.y = nodes.coords[c + 1]
  out.w = nodes.coords[c + 2]
  out.h = nodes.coords[c + 3]
}
