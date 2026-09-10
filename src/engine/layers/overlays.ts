import type { NodeArrays, Rect } from '@/data/nodes'
import { arrowPath } from '@/tools/orderTool'
import { createEdgeSet, type EdgeSet } from '@/data/edges'

const MAX_ARROWS = 300
const HEAD = 9
const BADGE_MIN_SCALE = 0.6

/**
 * Reading-order arrows, drawn only between nodes already culled in — 10k
 * arrows would destroy the frame budget on their own. Iterates the visible
 * set and looks up each node's out-edges from the pre-built adjacency map;
 * never scans the whole edge set in the draw loop.
 */
export class OrderOverlay {
  private readonly rectA: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private readonly rectB: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private edges: EdgeSet = createEdgeSet()

  setGraph(edges: EdgeSet): void {
    this.edges = edges
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
    if (this.edges.count === 0) return
    const budget = visibleCount > MAX_ARROWS && selectedIndex >= 0 ? 2 : MAX_ARROWS
    ctx.save()
    ctx.strokeStyle = 'rgba(120, 220, 180, 0.8)'
    ctx.fillStyle = 'rgba(120, 220, 180, 0.8)'
    ctx.lineWidth = 1.25 / scale

    let drawn = 0
    // Iterate the culled set, not the whole graph: the draw loop must never
    // touch a node the viewport does not contain.
    for (let k = 0; k < visibleCount && drawn < budget; k++) {
      const ia = visible[k]
      const targets = this.edges.adjacency.get(ia)
      if (!targets) continue
      readRect(nodes, ia, this.rectA)
      for (let t = 0; t < targets.length && drawn < budget; t++) {
        const ib = indexOfId(targets[t])
        if (ib < 0) continue
        readRect(nodes, ib, this.rectB)
        const p = arrowPath(this.rectA, this.rectB)
        ctx.beginPath()
        ctx.moveTo(p.x1, p.y1)
        ctx.lineTo(p.x2, p.y2)
        ctx.stroke()
        const h = HEAD / scale
        ctx.beginPath()
        ctx.moveTo(p.x2, p.y2)
        ctx.lineTo(p.x2 - h * Math.cos(p.headAngle - 0.4), p.y2 - h * Math.sin(p.headAngle - 0.4))
        ctx.lineTo(p.x2 - h * Math.cos(p.headAngle + 0.4), p.y2 - h * Math.sin(p.headAngle + 0.4))
        ctx.closePath()
        ctx.fill()
        drawn++
      }
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
      const targets = this.edges.adjacency.get(i)
      if (!targets || targets.length === 0) continue
      const c = i * 4
      ctx.fillText(String(targets.length), nodes.coords[c] + 2 / scale, nodes.coords[c + 1] + 2 / scale)
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
