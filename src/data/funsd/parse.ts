import { NodeType } from '@/data/nodes'
import { SemanticLabel, type SerializedNode } from '@/worker/protocol'

export type FunsdWord = { box: [number, number, number, number]; text: string }
export type FunsdEntity = {
  id: number
  box: [number, number, number, number]
  text: string
  label: 'question' | 'answer' | 'header' | 'other'
  words: FunsdWord[]
  linking: [number, number][]
}
export type FunsdForm = { form: FunsdEntity[] }

/**
 * Global id = pageIndex * ID_STRIDE + a per-page counter. The densest page in
 * the corpus holds 536 nodes, so 1000 leaves headroom and keeps ids readable.
 */
export const ID_STRIDE = 1000

const TYPE_OF_LABEL: Record<FunsdEntity['label'], NodeType> = {
  question: NodeType.KeyValue,
  answer: NodeType.KeyValue,
  header: NodeType.Paragraph,
  other: NodeType.Paragraph,
}

const LABEL_OF: Record<FunsdEntity['label'], SemanticLabel> = {
  question: SemanticLabel.Question,
  answer: SemanticLabel.Answer,
  header: SemanticLabel.Header,
  other: SemanticLabel.Other,
}

export type ParsedPage = { nodes: SerializedNode[]; edges: number[] }

/**
 * One FUNSD form → flat nodes + directed edges, both in global id space.
 * Pure and DOM-free: this runs inside the worker.
 */
export function parseFunsdPage(
  form: FunsdForm,
  pageIndex: number,
  offsetX: number,
  offsetY: number,
): ParsedPage {
  const nodes: SerializedNode[] = []
  const base = pageIndex * ID_STRIDE
  /** FUNSD's per-file entity id → our global id */
  const globalOf = new Map<number, number>()
  let next = base
  let order = 0

  for (const entity of form.form) {
    const entityId = next++
    globalOf.set(entity.id, entityId)
    const [x0, y0, x1, y1] = entity.box
    nodes.push({
      id: entityId,
      page: pageIndex,
      x: offsetX + x0,
      y: offsetY + y0,
      w: x1 - x0,
      h: y1 - y0,
      type: TYPE_OF_LABEL[entity.label] ?? NodeType.Paragraph,
      parent: -1,
      order: order++,
      text: entity.text ?? '',
      label: LABEL_OF[entity.label] ?? SemanticLabel.Other,
    })
    for (const word of entity.words ?? []) {
      const [wx0, wy0, wx1, wy1] = word.box
      nodes.push({
        id: next++,
        page: pageIndex,
        x: offsetX + wx0,
        y: offsetY + wy0,
        w: wx1 - wx0,
        h: wy1 - wy0,
        type: NodeType.Line,
        parent: entityId,
        order: order++,
        text: word.text ?? '',
        label: SemanticLabel.Word,
      })
    }
  }

  // `linking` is recorded on BOTH endpoints, so the raw corpus lists 10,624
  // refs for ~5,312 real edges. Dedupe on the ordered pair.
  const edges: number[] = []
  const seen = new Set<number>()
  for (const entity of form.form) {
    for (const [from, to] of entity.linking ?? []) {
      const gFrom = globalOf.get(from)
      const gTo = globalOf.get(to)
      if (gFrom === undefined || gTo === undefined) continue
      const key = (gFrom - base) * ID_STRIDE + (gTo - base)
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(gFrom, gTo)
    }
  }

  return { nodes, edges }
}
