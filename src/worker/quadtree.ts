export type Bounds = { x: number; y: number; w: number; h: number }

/**
 * Loose-parent quadtree over axis-aligned rects.
 *
 * A rect that straddles a child boundary lives in the parent rather than being
 * duplicated into every child it touches: duplication would break `remove` and
 * inflate query results.
 */
class QTNode {
  ids: number[] = []
  /** x, y, w, h per item, parallel to `ids` */
  rects: number[] = []
  children: QTNode[] | null = null

  constructor(
    readonly x: number,
    readonly y: number,
    readonly w: number,
    readonly h: number,
    readonly depth: number,
  ) {}
}

export class QuadTree {
  private root: QTNode
  private count = 0

  constructor(
    private readonly bounds: Bounds,
    private readonly maxDepth = 8,
    private readonly bucketSize = 16,
  ) {
    this.root = new QTNode(bounds.x, bounds.y, bounds.w, bounds.h, 0)
  }

  get size(): number {
    return this.count
  }

  clear(): void {
    this.root = new QTNode(this.bounds.x, this.bounds.y, this.bounds.w, this.bounds.h, 0)
    this.count = 0
  }

  insert(id: number, x: number, y: number, w: number, h: number): void {
    this.insertInto(this.root, id, x, y, w, h)
    this.count++
  }

  bulkLoad(ids: Uint32Array, coords: Float32Array, count: number): void {
    for (let i = 0; i < count; i++) {
      const c = i * 4
      this.insert(ids[i], coords[c], coords[c + 1], coords[c + 2], coords[c + 3])
    }
  }

  remove(id: number, x: number, y: number, w: number, h: number): boolean {
    let node: QTNode | null = this.root
    while (node) {
      const at = node.ids.indexOf(id)
      if (at !== -1) {
        node.ids.splice(at, 1)
        node.rects.splice(at * 4, 4)
        this.count--
        return true
      }
      node = node.children ? this.childFitting(node, x, y, w, h) : null
    }
    return false
  }

  update(
    id: number,
    ox: number, oy: number, ow: number, oh: number,
    nx: number, ny: number, nw: number, nh: number,
  ): void {
    if (this.remove(id, ox, oy, ow, oh)) this.insert(id, nx, ny, nw, nh)
  }

  /** Ids of every rect containing the point. `out` is reused — no allocation. */
  queryPoint(x: number, y: number, out: number[]): number[] {
    out.length = 0
    this.pointInto(this.root, x, y, out)
    return out
  }

  /** Ids of every rect intersecting the query rect. `out` is reused. */
  queryRect(x: number, y: number, w: number, h: number, out: number[]): number[] {
    out.length = 0
    this.rectInto(this.root, x, y, w, h, out)
    return out
  }

  // --- internals -----------------------------------------------------------

  private insertInto(node: QTNode, id: number, x: number, y: number, w: number, h: number) {
    let n = node
    for (;;) {
      if (n.children) {
        const child = this.childFitting(n, x, y, w, h)
        if (!child) break
        n = child
        continue
      }
      if (n.ids.length < this.bucketSize || n.depth >= this.maxDepth) break
      this.split(n)
      const child = this.childFitting(n, x, y, w, h)
      if (!child) break
      n = child
    }
    n.ids.push(id)
    n.rects.push(x, y, w, h)
  }

  private split(n: QTNode) {
    const hw = n.w / 2
    const hh = n.h / 2
    const d = n.depth + 1
    n.children = [
      new QTNode(n.x, n.y, hw, hh, d),
      new QTNode(n.x + hw, n.y, hw, hh, d),
      new QTNode(n.x, n.y + hh, hw, hh, d),
      new QTNode(n.x + hw, n.y + hh, hw, hh, d),
    ]
    // Push down only what fits wholly in one child.
    const ids = n.ids
    const rects = n.rects
    n.ids = []
    n.rects = []
    for (let i = 0; i < ids.length; i++) {
      const c = i * 4
      const child = this.childFitting(n, rects[c], rects[c + 1], rects[c + 2], rects[c + 3])
      const target = child ?? n
      target.ids.push(ids[i])
      target.rects.push(rects[c], rects[c + 1], rects[c + 2], rects[c + 3])
    }
  }

  /** The single child wholly containing the rect, or null if it straddles. */
  private childFitting(n: QTNode, x: number, y: number, w: number, h: number): QTNode | null {
    const kids = n.children
    if (!kids) return null
    for (let i = 0; i < 4; i++) {
      const k = kids[i]
      if (x >= k.x && y >= k.y && x + w <= k.x + k.w && y + h <= k.y + k.h) return k
    }
    return null
  }

  private pointInto(n: QTNode, x: number, y: number, out: number[]) {
    const r = n.rects
    for (let i = 0; i < n.ids.length; i++) {
      const c = i * 4
      if (x >= r[c] && x <= r[c] + r[c + 2] && y >= r[c + 1] && y <= r[c + 1] + r[c + 3]) {
        out.push(n.ids[i])
      }
    }
    const kids = n.children
    if (!kids) return
    for (let i = 0; i < 4; i++) {
      const k = kids[i]
      if (x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h) this.pointInto(k, x, y, out)
    }
  }

  private rectInto(n: QTNode, x: number, y: number, w: number, h: number, out: number[]) {
    const r = n.rects
    for (let i = 0; i < n.ids.length; i++) {
      const c = i * 4
      if (r[c] < x + w && r[c] + r[c + 2] > x && r[c + 1] < y + h && r[c + 1] + r[c + 3] > y) {
        out.push(n.ids[i])
      }
    }
    const kids = n.children
    if (!kids) return
    for (let i = 0; i < 4; i++) {
      const k = kids[i]
      if (k.x < x + w && k.x + k.w > x && k.y < y + h && k.y + k.h > y) {
        this.rectInto(k, x, y, w, h, out)
      }
    }
  }
}
