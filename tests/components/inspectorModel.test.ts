import { describe, expect, it } from 'vitest'
import { createNodeArrays, pushNode, NodeType } from '@/data/nodes'
import { SemanticLabel } from '@/worker/protocol'
import { flattenInspectorTree, subtreeOf, toJson, toMarkdown } from '@/components/inspectorModel'

/** One question entity with two word children. */
function form() {
  const n = createNodeArrays(8)
  pushNode(n, { id: 1, page: 0, x: 10, y: 20, w: 100, h: 12, type: NodeType.KeyValue, parent: -1, order: 0 })
  pushNode(n, { id: 2, page: 0, x: 10, y: 20, w: 40, h: 12, type: NodeType.Line, parent: 1, order: 1 })
  pushNode(n, { id: 3, page: 0, x: 55, y: 20, w: 50, h: 12, type: NodeType.Line, parent: 1, order: 2 })
  return n
}

const TEXT: Record<number, string> = { 1: 'Name of company', 2: 'Name', 3: 'of company' }
const meta = {
  textOf: (id: number) => TEXT[id] ?? '',
  labelOf: (id: number) => (id === 1 ? SemanticLabel.Question : SemanticLabel.Word),
}
const rectOf = (id: number) => {
  const i = [1, 2, 3].indexOf(id)
  return i < 0 ? null : { x: [10, 10, 55][i], y: 20, w: [100, 40, 50][i], h: 12 }
}

describe('subtreeOf', () => {
  it('builds the selected node and its children', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false)!
    expect(t.id).toBe(1)
    expect(t.label).toBe('question')
    expect(t.text).toBe('Name of company')
    expect(t.children.map((c) => c.text)).toEqual(['Name', 'of company'])
  })

  it('roots at a child when a child is selected', () => {
    const t = subtreeOf(form(), 2, meta, rectOf, () => false)!
    expect(t.id).toBe(2)
    expect(t.children).toEqual([])
  })

  it('flags a modified node', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, (id) => id === 3)!
    expect(t.modified).toBe(false)
    expect(t.children[1].modified).toBe(true)
  })

  it('returns null for an unknown id', () => {
    expect(subtreeOf(form(), 999, meta, rectOf, () => false)).toBeNull()
  })

  it('caps the subtree so a huge parent cannot lock the panel', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false, 2)!
    expect(t.children).toHaveLength(1)
  })
})

describe('flattenInspectorTree', () => {
  it('depth-first flattens the subtree with depth per row', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false)!
    const rows = flattenInspectorTree(t)
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
    ])
  })

  it('roots depth at the given offset', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false)!
    const rows = flattenInspectorTree(t, 2)
    expect(rows.map((r) => r.depth)).toEqual([2, 3, 3])
  })

  it('flattens a leaf to a single row', () => {
    const t = subtreeOf(form(), 2, meta, rectOf, () => false)!
    expect(flattenInspectorTree(t)).toEqual([{ node: t, depth: 0 }])
  })
})

describe('toJson', () => {
  it('rounds coordinates to 2dp', () => {
    const t = subtreeOf(form(), 1, meta, () => ({ x: 1 / 3, y: 0, w: 1, h: 1 }), () => false)!
    expect(toJson(t)).toContain('"x": 0.33')
  })

  it('is valid JSON', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false)!
    expect(JSON.parse(toJson(t)).children).toHaveLength(2)
  })
})

describe('toMarkdown', () => {
  it('renders the label as a heading and words as a list', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false)!
    expect(toMarkdown(t)).toBe(
      ['## question', '', 'Name of company', '', '- Name', '- of company', ''].join('\n'),
    )
  })

  it('marks a modified node', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, (id) => id === 1)!
    expect(toMarkdown(t)).toContain('## question *(edited)*')
  })

  it('falls back to the id when there is no text', () => {
    const t = subtreeOf(form(), 1, { textOf: () => '', labelOf: () => SemanticLabel.None }, rectOf, () => false)!
    expect(toMarkdown(t)).toContain('#1')
  })
})
