/**
 * The single source of truth for where pages sit in world space. Replaces the
 * constant-stride arithmetic that assumed every page was the same A4 slot.
 */
export type PageGeometry = {
  count: number
  /** x, y, w, h per page at i * 4 — world units */
  rects: Float32Array
  origin(page: number, out: Float32Array): void
  /**
   * Inclusive [from, to] page range intersecting a world y-span. Over-inclusive at
   * inter-page gaps: a span lying wholly in a gap yields the preceding page. That is
   * one extra off-screen page for culling to skip, never a dropped visible one.
   */
  rangeFor(y: number, h: number): [number, number]
}

function build(rects: Float32Array, count: number): PageGeometry {
  return {
    count,
    rects,
    origin(page, out) {
      const c = page * 4
      out[0] = rects[c]
      out[1] = rects[c + 1]
      out[2] = rects[c + 2]
      out[3] = rects[c + 3]
    },
    rangeFor(y, h) {
      if (count === 0) return [0, -1]
      return [lowerBound(rects, count, y), lowerBound(rects, count, y + h)]
    },
  }
}

/**
 * Last page whose top is <= `y`, clamped into range. Binary search rather than
 * a divide, because page heights are no longer uniform.
 */
function lowerBound(rects: Float32Array, count: number, y: number): number {
  let lo = 0
  let hi = count - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rects[mid * 4 + 1] <= y) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/**
 * Contact-sheet layout: `perRow` uniform pages per row. `rangeFor` widens a row
 * span to whole rows, which the over-inclusive contract allows — the page layer
 * discards the off-screen columns, and box culling is 2D via the bucket grid.
 *
 * A single column caps a 10% viewport at ~6 pages (~460 boxes), which can never
 * exercise the 10k-boxes-in-view load this renderer exists for.
 */
export function gridGeometry(
  count: number,
  w: number,
  h: number,
  gap: number,
  perRow: number,
): PageGeometry {
  const rects = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const c = i * 4
    rects[c] = (i % perRow) * (w + gap)
    rects[c + 1] = Math.floor(i / perRow) * (h + gap)
    rects[c + 2] = w
    rects[c + 3] = h
  }
  const stride = h + gap
  const lastRow = Math.max(0, Math.ceil(count / perRow) - 1)
  const rowOf = (y: number) => Math.min(lastRow, Math.max(0, Math.floor(y / stride)))
  return {
    count,
    rects,
    origin(page, out) {
      const c = page * 4
      out[0] = rects[c]
      out[1] = rects[c + 1]
      out[2] = rects[c + 2]
      out[3] = rects[c + 3]
    },
    rangeFor(y, hSpan) {
      if (count === 0) return [0, -1]
      const from = rowOf(y) * perRow
      const to = Math.min(count - 1, rowOf(y + hSpan) * perRow + perRow - 1)
      return [from, to]
    },
  }
}

/** Every page the same size — the synthetic document. */
export function uniformGeometry(count: number, w: number, h: number, gap: number): PageGeometry {
  const rects = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const c = i * 4
    rects[c] = 0
    rects[c + 1] = i * (h + gap)
    rects[c + 2] = w
    rects[c + 3] = h
  }
  return build(rects, count)
}

/** Pages at their own native sizes, stacked top to bottom — the FUNSD document. */
export function stackedGeometry(sizes: { w: number; h: number }[], gap: number): PageGeometry {
  const rects = new Float32Array(sizes.length * 4)
  let y = 0
  for (let i = 0; i < sizes.length; i++) {
    const c = i * 4
    rects[c] = 0
    rects[c + 1] = y
    rects[c + 2] = sizes[i].w
    rects[c + 3] = sizes[i].h
    y += sizes[i].h + gap
  }
  return build(rects, sizes.length)
}
