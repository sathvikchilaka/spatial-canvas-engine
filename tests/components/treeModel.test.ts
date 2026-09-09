// tests/components/treeModel.test.ts
import { describe, it, expect } from 'vitest'
import { buildTreeRows } from '@/components/TreeView'
import { createNodeArrays, pushNode, NodeType } from '@/data/nodes'

function tree() {
  const a = createNodeArrays(8)
  pushNode(a, { id: 1, page: 0, x: 0, y: 0, w: 10, h: 10, type: NodeType.Paragraph, parent: -1, order: 0 })
  pushNode(a, { id: 2, page: 0, x: 0, y: 0, w: 5, h: 2, type: NodeType.Line, parent: 0, order: 1 })
  pushNode(a, { id: 3, page: 0, x: 0, y: 3, w: 5, h: 2, type: NodeType.Line, parent: 0, order: 2 })
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
