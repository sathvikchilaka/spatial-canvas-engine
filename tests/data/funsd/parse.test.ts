import { describe, expect, it } from 'vitest'
import { ID_STRIDE, parseFunsdPage, type FunsdForm } from '@/data/funsd/parse'
import { NodeType } from '@/data/nodes'
import { SemanticLabel } from '@/worker/protocol'
import fixture from './fixture.json'

const form = fixture as FunsdForm

describe('parseFunsdPage', () => {
  it('converts [x0,y0,x1,y1] to {x,y,w,h} and applies the page offset', () => {
    const { nodes } = parseFunsdPage(form, 0, 0, 500)
    const first = nodes[0]
    expect([first.x, first.y, first.w, first.h]).toEqual([10, 520, 100, 20])
  })

  it('emits one node per entity plus one per word', () => {
    const { nodes } = parseFunsdPage(form, 0, 0, 0)
    expect(nodes).toHaveLength(3 + 4)
  })

  it('maps labels onto node types', () => {
    const { nodes } = parseFunsdPage(form, 0, 0, 0)
    const entities = nodes.filter((n) => n.parent === -1)
    expect(entities.map((n) => n.type)).toEqual([
      NodeType.KeyValue, // question
      NodeType.KeyValue, // answer
      NodeType.Paragraph, // header
    ])
  })

  it('parents words to their entity', () => {
    const { nodes } = parseFunsdPage(form, 0, 0, 0)
    const words = nodes.filter((n) => n.type === NodeType.Line)
    expect(words).toHaveLength(4)
    for (const w of words) expect(w.parent).not.toBe(-1)
  })

  it('namespaces ids by page so two pages never collide', () => {
    const a = parseFunsdPage(form, 0, 0, 0).nodes
    const b = parseFunsdPage(form, 1, 0, 0).nodes
    expect(a[0].id).toBeLessThan(ID_STRIDE)
    expect(b[0].id).toBeGreaterThanOrEqual(ID_STRIDE)
    const overlap = new Set(a.map((n) => n.id))
    expect(b.some((n) => overlap.has(n.id))).toBe(false)
  })

  it('dedupes links that appear on both endpoints', () => {
    // The fixture states [0,1] twice — once per entity. That is one edge.
    const { edges } = parseFunsdPage(form, 0, 0, 0)
    expect(edges).toHaveLength(2)
  })

  it('emits edges in global id space', () => {
    const { nodes, edges } = parseFunsdPage(form, 3, 0, 0)
    const ids = new Set(nodes.map((n) => n.id))
    expect(ids.has(edges[0])).toBe(true)
    expect(ids.has(edges[1])).toBe(true)
  })

  it('drops a link whose target does not exist', () => {
    const broken: FunsdForm = { form: [{ ...form.form[0], linking: [[0, 99]] }] }
    expect(parseFunsdPage(broken, 0, 0, 0).edges).toHaveLength(0)
  })
})

describe('text and label passthrough', () => {
  it("keeps each entity's text and maps its label", () => {
    const parsed = parseFunsdPage(fixture as FunsdForm, 0, 0, 0)
    const entity = parsed.nodes.find((n) => n.parent === -1)!
    expect(entity.text).toBe(fixture.form[0].text)
    expect(entity.label).toBe(SemanticLabel.Question)
  })

  it("keeps each word's own text and labels it Word", () => {
    const parsed = parseFunsdPage(fixture as FunsdForm, 0, 0, 0)
    const word = parsed.nodes.find((n) => n.parent !== -1)!
    expect(word.text).toBe(fixture.form[0].words[0].text)
    expect(word.label).toBe(SemanticLabel.Word)
  })

  it('tolerates an entity with no text field', () => {
    const form = { form: [{ ...fixture.form[0], text: undefined, words: [] }] }
    const parsed = parseFunsdPage(form as unknown as FunsdForm, 0, 0, 0)
    expect(parsed.nodes[0].text).toBe('')
  })

  it('maps every FUNSD label to a SemanticLabel', () => {
    const labels = ['question', 'answer', 'header', 'other'] as const
    const got = labels.map((label) => {
      const form = { form: [{ ...fixture.form[0], label, words: [] }] }
      return parseFunsdPage(form as unknown as FunsdForm, 0, 0, 0).nodes[0].label
    })
    expect(got).toEqual([
      SemanticLabel.Question,
      SemanticLabel.Answer,
      SemanticLabel.Header,
      SemanticLabel.Other,
    ])
  })
})
