import { createNodeArrays, pushNode, NodeType, type NodeArrays } from './nodes'

/** A4 at 150dpi. */
export const PAGE_W = 1240
export const PAGE_H = 1754
export const PAGE_GAP = 40

const MARGIN = 90
const CONTENT_W = PAGE_W - MARGIN * 2
// Tightened from 18 so a 100-page document clears the 10k-box bar.
const LINE_H = 15

export type Line = { x: number; y: number; w: number; h: number }
export type Cell = { x: number; y: number; w: number; h: number; row: number; col: number }

export type BlockKind = 'heading' | 'paragraph' | 'table' | 'figure' | 'caption' | 'kv'

export type Block = {
  kind: BlockKind
  x: number
  y: number
  w: number
  h: number
  lines?: Line[]
  cells?: Cell[]
}

export type GeneratedPage = { index: number; blocks: Block[]; nodeCount: number }

/** Deterministic, independent per (seed, page). */
function mulberry32(a: number) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPE_OF_KIND: Record<BlockKind, NodeType> = {
  heading: NodeType.Paragraph,
  paragraph: NodeType.Paragraph,
  caption: NodeType.Paragraph,
  table: NodeType.Paragraph,
  figure: NodeType.Figure,
  kv: NodeType.KeyValue,
}

/**
 * Pages of the synthetic document sit in one column.
 * Must stay in step with the `gridGeometry` the engine builds for the paper —
 * this places the boxes, that places the paper under them.
 */
export const PAGES_PER_ROW = 1

/** Top-left of a page in world space. */
export function pageOrigin(pageIndex: number): [number, number] {
  return [
    (pageIndex % PAGES_PER_ROW) * (PAGE_W + PAGE_GAP),
    Math.floor(pageIndex / PAGES_PER_ROW) * (PAGE_H + PAGE_GAP),
  ]
}

export function generatePage(pageIndex: number, seed: number): GeneratedPage {
  const rnd = mulberry32(Math.imul(seed, 73856093) ^ Math.imul(pageIndex, 19349663))
  const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
  const blocks: Block[] = []
  let y = MARGIN
  const bottom = PAGE_H - MARGIN

  const fits = (h: number) => y + h <= bottom

  const heading = (big: boolean) => {
    const h = big ? 44 : 30
    if (!fits(h)) return false
    blocks.push({
      kind: 'heading',
      x: MARGIN,
      y,
      w: CONTENT_W * (big ? 0.78 : 0.52 + rnd() * 0.2),
      h,
    })
    y += h + 18
    return true
  }

  const paragraph = () => {
    const n = ri(8, 16)
    const h = n * LINE_H
    if (!fits(h)) return false
    const lines: Line[] = []
    for (let i = 0; i < n; i++) {
      const last = i === n - 1
      const w = CONTENT_W * (last ? 0.4 + rnd() * 0.5 : 0.92 + rnd() * 0.08)
      lines.push({ x: MARGIN, y: y + i * LINE_H, w, h: LINE_H - 5 })
    }
    blocks.push({ kind: 'paragraph', x: MARGIN, y, w: CONTENT_W, h, lines })
    y += h + 18
    return true
  }

  const table = () => {
    const rows = ri(4, 9)
    const cols = ri(3, 6)
    const rowH = 34
    const h = rows * rowH
    if (!fits(h)) return false
    const colW = CONTENT_W / cols
    const cells: Cell[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({
          x: MARGIN + c * colW + 6,
          y: y + r * rowH + 6,
          w: colW - 12,
          h: rowH - 12,
          row: r,
          col: c,
        })
      }
    }
    blocks.push({ kind: 'table', x: MARGIN, y, w: CONTENT_W, h, cells })
    y += h + 28
    return true
  }

  const figure = () => {
    const h = ri(180, 320)
    if (!fits(h + 26 + 24)) return false
    const w = CONTENT_W * (0.55 + rnd() * 0.45)
    blocks.push({ kind: 'figure', x: MARGIN, y, w, h })
    y += h + 10
    blocks.push({
      kind: 'caption',
      x: MARGIN,
      y,
      w: w * 0.9,
      h: 20,
      lines: [{ x: MARGIN, y, w: w * 0.9, h: 16 }],
    })
    y += 20 + 24
    return true
  }

  const kv = () => {
    const rows = ri(4, 6)
    const rowH = 32
    const h = rows * rowH
    if (!fits(h)) return false
    const lines: Line[] = []
    for (let r = 0; r < rows; r++) {
      lines.push({ x: MARGIN, y: y + r * rowH, w: CONTENT_W * 0.24, h: rowH - 12 })
      lines.push({
        x: MARGIN + CONTENT_W * 0.28,
        y: y + r * rowH,
        w: CONTENT_W * (0.3 + rnd() * 0.4),
        h: rowH - 12,
      })
    }
    blocks.push({ kind: 'kv', x: MARGIN, y, w: CONTENT_W, h, lines })
    y += h + 26
    return true
  }

  heading(pageIndex === 0)

  let sinceHeading = 0
  let guard = 0
  while (y < bottom && guard++ < 40) {
    const roll = rnd()
    let placed: boolean
    if (pageIndex % 2 === 0 && roll < 0.16) placed = table()
    else if (pageIndex % 4 === 1 && roll < 0.14) placed = figure()
    else if (pageIndex % 3 === 2 && roll < 0.14) placed = kv()
    else placed = paragraph()
    if (!placed) break
    if (++sinceHeading >= 3 && y < bottom - 200) {
      heading(false)
      sinceHeading = 0
    }
  }

  let nodeCount = 0
  for (const b of blocks) nodeCount += 1 + (b.lines?.length ?? 0) + (b.cells?.length ?? 0)
  return { index: pageIndex, blocks, nodeCount }
}

/**
 * Appends a page's nodes in reading order: block, then its children.
 * `order` is the emission sequence — that IS the reading order.
 */
export function appendPageNodes(
  a: NodeArrays,
  page: GeneratedPage,
  nextId: { v: number },
): void {
  const [ox, oy] = pageOrigin(page.index)
  for (const b of page.blocks) {
    const parentId = nextId.v++
    pushNode(a, {
      id: parentId,
      page: page.index,
      x: ox + b.x,
      y: oy + b.y,
      w: b.w,
      h: b.h,
      type: TYPE_OF_KIND[b.kind],
      parent: -1,
      order: a.count,
    })
    const kids = b.cells ?? b.lines
    if (!kids) continue
    const childType = b.cells ? NodeType.Cell : b.kind === 'kv' ? NodeType.KeyValue : NodeType.Line
    for (const k of kids) {
      pushNode(a, {
        id: nextId.v++,
        page: page.index,
        x: ox + k.x,
        y: oy + k.y,
        w: k.w,
        h: k.h,
        type: childType,
        parent: parentId,
        order: a.count,
      })
    }
  }
}

export function generateDocument(
  pageCount: number,
  seed: number,
): { nodes: NodeArrays; pages: GeneratedPage[] } {
  const pages: GeneratedPage[] = []
  const nodes = createNodeArrays(pageCount * 128)
  const nextId = { v: 1 }
  for (let p = 0; p < pageCount; p++) {
    const page = generatePage(p, seed)
    pages.push(page)
    appendPageNodes(nodes, page, nextId)
  }
  return { nodes, pages }
}
