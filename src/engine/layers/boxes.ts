import { FLAG_DIRTY, FLAG_HIDDEN, FLAG_SELECTED, NodeType, type NodeArrays } from '@/data/nodes'

/**
 * Style groups. The number of canvas state changes per frame is bounded by the
 * number of groups, not by the number of boxes.
 */
const GROUPS = [
  { key: 'paragraph', stroke: 'rgba(120, 170, 255, 0.75)' },
  { key: 'line', stroke: 'rgba(150, 150, 160, 0.45)' },
  { key: 'cell', stroke: 'rgba(255, 190, 120, 0.65)' },
  { key: 'kv', stroke: 'rgba(160, 235, 190, 0.7)' },
  { key: 'figure', stroke: 'rgba(220, 140, 220, 0.7)' },
  { key: 'edited', stroke: 'rgba(255, 210, 90, 0.95)' },
  { key: 'selected', stroke: 'rgba(255, 255, 255, 1)' },
] as const

const GROUP_COUNT = GROUPS.length
const SELECTED_GROUP = GROUP_COUNT - 1
const EDITED_GROUP = GROUP_COUNT - 2

const GROUP_OF_TYPE = new Uint8Array(8)
GROUP_OF_TYPE[NodeType.Paragraph] = 0
GROUP_OF_TYPE[NodeType.Line] = 1
GROUP_OF_TYPE[NodeType.Cell] = 2
GROUP_OF_TYPE[NodeType.KeyValue] = 3
GROUP_OF_TYPE[NodeType.Figure] = 4

/** Preallocated per-group index buckets — the draw loop allocates nothing. */
export class BoxLayer {
  private readonly buckets: Uint32Array[] = []
  private readonly counts = new Uint32Array(GROUP_COUNT)

  constructor(capacity = 16384) {
    for (let g = 0; g < GROUP_COUNT; g++) this.buckets.push(new Uint32Array(capacity))
  }

  /**
   * Draws `visible` node indices, grouped by style, one path per group.
   * Assumes the world transform is already applied to `ctx`.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    nodes: NodeArrays,
    visible: Uint32Array,
    visibleCount: number,
    scale: number,
  ): void {
    this.counts.fill(0)
    // Below ~2 screen px a box is invisible but still costs paint.
    const minWorld = 2 / scale

    for (let k = 0; k < visibleCount; k++) {
      const i = visible[k]
      const flags = nodes.flags[i]
      if (flags & FLAG_HIDDEN) continue
      const c = i * 4
      if (nodes.coords[c + 2] < minWorld && nodes.coords[c + 3] < minWorld) continue
      const g =
        flags & FLAG_SELECTED
          ? SELECTED_GROUP
          : flags & FLAG_DIRTY
            ? EDITED_GROUP
            : GROUP_OF_TYPE[nodes.types[i]]
      const bucket = this.buckets[g]
      const n = this.counts[g]
      if (n < bucket.length) {
        bucket[n] = i
        this.counts[g] = n + 1
      }
    }

    ctx.lineWidth = 1 / scale
    for (let g = 0; g < GROUP_COUNT; g++) {
      const n = this.counts[g]
      if (n === 0) continue
      const bucket = this.buckets[g]
      ctx.strokeStyle = GROUPS[g].stroke
      ctx.beginPath()
      for (let k = 0; k < n; k++) {
        const c = bucket[k] * 4
        ctx.rect(nodes.coords[c], nodes.coords[c + 1], nodes.coords[c + 2], nodes.coords[c + 3])
      }
      ctx.stroke()
    }
  }
}
