import { generatePage } from '@/data/generator'
import { NodeType } from '@/data/nodes'
import type { SerializedNode } from '@/worker/protocol'

/**
 * Nodes for one generated page, in the wire shape the worker parses.
 *
 * The page origin is *passed in*, never recomputed here: the document's
 * `PageGeometry` is the single source of truth for where a page sits in world
 * space, and the worker forwards the offsets the drain loop read from it. A
 * second, local layout formula is exactly how the paper and the boxes drifted
 * apart before.
 */
export function serializeGeneratedPage(
  pageIndex: number,
  seed: number,
  offsetX = 0,
  offsetY = 0,
): SerializedNode[] {
  const page = generatePage(pageIndex, seed)
  const ox = offsetX
  const oy = offsetY
  const out: SerializedNode[] = []
  let id = pageIndex * 1000 + 1
  let order = 0
  for (const b of page.blocks) {
    const parent = id
    out.push({
      id: id++, page: pageIndex, x: ox + b.x, y: oy + b.y, w: b.w, h: b.h,
      type: b.kind === 'figure' ? NodeType.Figure : NodeType.Paragraph,
      parent: -1, order: order++,
    })
    for (const k of b.cells ?? b.lines ?? []) {
      out.push({
        id: id++, page: pageIndex, x: ox + k.x, y: oy + k.y, w: k.w, h: k.h,
        type: b.cells ? NodeType.Cell : NodeType.Line,
        parent, order: order++,
      })
    }
  }
  return out
}
