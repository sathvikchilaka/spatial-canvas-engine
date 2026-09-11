// tests/components/treeModel.test.ts
import { describe, it, expect } from 'vitest'
import { buildTreeRows } from '@/components/TreeView'
import { createNodeArrays, pushNode, NodeType } from '@/data/nodes'
import { SemanticLabel } from '@/worker/protocol'

// `parent` is the parent's id (node 1), not its array index.
function tree() {
  const a = createNodeArrays(8)
  pushNode(a, { id: 1, page: 0, x: 0, y: 0, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })
  pushNode(a, { id: 2, page: 0, x: 0, y: 0, w: 5, h: 2, type: NodeType.Line, parent: 1, order: 1 })
  pushNode(a, { id: 3, page: 0, x: 0, y: 3, w: 5, h: 2, type: NodeType.Line, parent: 1, order: 2 })
  return a
}

describe('buildTreeRows', () => {
  it('shows only roots when nothing is expanded', () => {
    const rows = buildTreeRows(tree(), new Set())
    expect(rows.map(r => r.id)).toEqual([1])
    expect(rows[0].hasChildren).toBe(true)
  })

  it('reveals children of expanded nodes in order', () => {
    const rows = buildTreeRows(tree(), new Set([1]))
    expect(rows.map(r => r.id)).toEqual([1, 2, 3])
    expect(rows[1].depth).toBe(1)
  })

  it('marks leaves as having no children', () => {
    expect(buildTreeRows(tree(), new Set([1]))[1].hasChildren).toBe(false)
  })

  it('handles an empty document', () => {
    expect(buildTreeRows(createNodeArrays(4), new Set())).toEqual([])
  })
})

describe('reading order', () => {
  // The real words of FUNSD node #1073, pushed in the arrival order the parser
  // emits. Their tops disagree by a pixel or two across a single line, which is
  // exactly what a naive y-sort gets wrong.
  it('orders words on a shared line by x, not by raw y', () => {
    const a = createNodeArrays(16)
    const words: [number, string, number, number, number][] = [
      [1074, 'RESTRICTED', 286, 1085, 15],
      [1075, 'BROWN', 210, 1110, 15],
      [1076, '&', 251, 1112, 13],
      [1077, 'WILLIAMSON', 266, 1112, 15],
      [1078, 'INTERNATIONAL', 341, 1115, 12],
      [1079, 'TOBACCO', 439, 1113, 13],
      [1080, 'PRODUCT', 275, 1140, 13],
      [1081, 'SPECIFICATION', 332, 1142, 10],
    ]
    pushNode(a, { id: 1073, page: 0, x: 210, y: 1085, w: 287, h: 68, type: NodeType.Paragraph, parent: -1, order: 0 })
    for (const [id, , x, y, h] of words) {
      pushNode(a, { id, page: 0, x, y, w: 50, h, type: NodeType.Line, parent: 1073, order: 0 })
    }

    const rows = buildTreeRows(a, new Set([1073]))
    expect(rows.slice(1).map((r) => r.id)).toEqual([1074, 1075, 1076, 1077, 1078, 1079, 1080, 1081])
  })

  it('keeps pages apart even when their order counters both restart at 0', () => {
    // FUNSD's parser restarts `order` per page, and pages can sit side by side
    // in world space — so neither `order` nor world y alone separates them.
    const a = createNodeArrays(8)
    pushNode(a, { id: 20, page: 2, x: 900, y: 50, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })
    pushNode(a, { id: 10, page: 0, x: 100, y: 80, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 50 })
    pushNode(a, { id: 11, page: 0, x: 100, y: 20, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 99 })

    expect(buildTreeRows(a, new Set()).map((r) => r.id)).toEqual([11, 10, 20])
  })

  it('is unaffected by out-of-order stream arrival', () => {
    const a = createNodeArrays(8)
    pushNode(a, { id: 3, page: 0, x: 10, y: 300, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })
    pushNode(a, { id: 1, page: 0, x: 10, y: 100, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })
    pushNode(a, { id: 2, page: 0, x: 10, y: 200, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })

    expect(buildTreeRows(a, new Set()).map((r) => r.id)).toEqual([1, 2, 3])
  })
})

describe('row text', () => {
  it('shows the extracted text when there is some', () => {
    const nodes = tree()
    const rows = buildTreeRows(nodes, new Set([1]), {
      textOf: (id) => (id === 2 ? 'Name of company' : ''),
      labelOf: () => SemanticLabel.Question,
    })
    const row = rows.find((r) => r.id === 2)!
    expect(row.text).toBe('Name of company')
    expect(row.label).toBe(SemanticLabel.Question)
  })

  it('falls back to the type-and-id title when text is empty', () => {
    const nodes = tree()
    const rows = buildTreeRows(nodes, new Set(), {
      textOf: () => '',
      labelOf: () => SemanticLabel.None,
    })
    expect(rows[0].text).toBe('')
    expect(rows[0].title).toMatch(/\d+$/)
  })

  it('works with no meta at all, as it did before', () => {
    const rows = buildTreeRows(tree(), new Set())
    expect(rows[0].text).toBe('')
    expect(rows[0].label).toBe(SemanticLabel.None)
  })
})
