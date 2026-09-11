import type { Rect } from '@/data/nodes'

type Bucket = { idx: number[]; page: number[] }

/**
 * Coarse main-thread index used only for per-frame culling. The frame loop
 * cannot await a worker round-trip, so culling is approximate and conservative
 * (it may return a few off-screen nodes, never miss an on-screen one);
 * hit-testing stays exact and lives in the worker.
 */
export class BucketGrid {
  private readonly cells = new Map<number, Bucket>()
  private readonly pageCells = new Map<number, number[]>()
  /** visit stamps for dedupe, keyed by node index; bumped, never cleared */
  private stamps = new Uint32Array(0)
  private generation = 0

  private readonly cellSize: number

  constructor(cellSize = 512) {
    this.cellSize = cellSize
  }

  private key(cx: number, cy: number) {
    return cy * 1e6 + cx
  }

  addPage(
    pageIndex: number,
    ids: Uint32Array,
    coords: Float32Array,
    indices: Uint32Array,
  ): void {
    void ids
    for (let i = 0; i < indices.length; i++) {
      const c = i * 4
      this.insert(indices[i], pageIndex, coords[c], coords[c + 1], coords[c + 2], coords[c + 3])
    }
  }

  /** Adds one node index to every cell its rect touches. */
  insert(index: number, pageIndex: number, x: number, y: number, w: number, h: number): void {
    const s = this.cellSize
    const touched = this.pageCells.get(pageIndex) ?? []
    const x1 = Math.floor((x + w) / s)
    const y1 = Math.floor((y + h) / s)
    for (let cy = Math.floor(y / s); cy <= y1; cy++) {
      for (let cx = Math.floor(x / s); cx <= x1; cx++) {
        const k = this.key(cx, cy)
        let bucket = this.cells.get(k)
        if (!bucket) {
          bucket = { idx: [], page: [] }
          this.cells.set(k, bucket)
        }
        // `touched` is what clearPage walks, so a cell entered *after* ingest
        // (an edited box crossing a cell line) must be recorded here too or a
        // document switch leaves the entry behind.
        if (!touched.includes(k)) touched.push(k)
        bucket.idx.push(index)
        bucket.page.push(pageIndex)
      }
    }
    if (index >= this.stamps.length) this.growStamps(index + 1)
    this.pageCells.set(pageIndex, touched)
  }

  /** Drops one node index from every cell the given rect touched. */
  remove(index: number, x: number, y: number, w: number, h: number): void {
    const s = this.cellSize
    const x1 = Math.floor((x + w) / s)
    const y1 = Math.floor((y + h) / s)
    for (let cy = Math.floor(y / s); cy <= y1; cy++) {
      for (let cx = Math.floor(x / s); cx <= x1; cx++) {
        const k = this.key(cx, cy)
        const bucket = this.cells.get(k)
        if (!bucket) continue
        for (let i = bucket.idx.length - 1; i >= 0; i--) {
          if (bucket.idx[i] === index) {
            bucket.idx.splice(i, 1)
            bucket.page.splice(i, 1)
          }
        }
        if (bucket.idx.length === 0) this.cells.delete(k)
      }
    }
  }

  /** remove + insert, so an edited box is culled at the place it now occupies. */
  move(index: number, pageIndex: number, from: Rect, to: Rect): void {
    this.remove(index, from.x, from.y, from.w, from.h)
    this.insert(index, pageIndex, to.x, to.y, to.w, to.h)
  }

  /** Writes node indices into `out`, returns the count. Allocation-free. */
  query(x: number, y: number, w: number, h: number, out: Uint32Array): number {
    const s = this.cellSize
    const gen = ++this.generation
    let n = 0
    const cx1 = Math.floor((x + w) / s)
    const cy1 = Math.floor((y + h) / s)
    for (let cy = Math.floor(y / s); cy <= cy1; cy++) {
      for (let cx = Math.floor(x / s); cx <= cx1; cx++) {
        const bucket = this.cells.get(this.key(cx, cy))
        if (!bucket) continue
        for (let i = 0; i < bucket.idx.length; i++) {
          const idx = bucket.idx[i]
          if (idx >= this.stamps.length) this.growStamps(idx + 1)
          if (this.stamps[idx] === gen) continue
          this.stamps[idx] = gen
          if (n >= out.length) return n
          out[n++] = idx
        }
      }
    }
    return n
  }

  clearPage(pageIndex: number): void {
    const touched = this.pageCells.get(pageIndex)
    if (!touched) return
    // Cells are shared between pages — drop only this page's entries.
    for (const k of touched) {
      const bucket = this.cells.get(k)
      if (!bucket) continue
      for (let i = bucket.page.length - 1; i >= 0; i--) {
        if (bucket.page[i] === pageIndex) {
          bucket.page.splice(i, 1)
          bucket.idx.splice(i, 1)
        }
      }
      if (bucket.idx.length === 0) this.cells.delete(k)
    }
    this.pageCells.delete(pageIndex)
  }

  clear(): void {
    this.cells.clear()
    this.pageCells.clear()
    this.generation = 0
    this.stamps = new Uint32Array(0)
  }

  private growStamps(min: number) {
    let cap = Math.max(1024, this.stamps.length || 1024)
    while (cap < min) cap *= 2
    const next = new Uint32Array(cap)
    next.set(this.stamps)
    this.stamps = next
  }
}
