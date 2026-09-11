import { NodeType } from '@/data/nodes'
import { SemanticLabel } from '@/worker/protocol'

/** Display names, indexed by `SemanticLabel`. Also the store's on-the-wire form. */
export const LABEL_NAMES = ['none', 'question', 'answer', 'header', 'other', 'word'] as const

export function labelName(l: SemanticLabel): string {
  return LABEL_NAMES[l] ?? 'none'
}

export function labelFromName(name: string): SemanticLabel {
  const i = LABEL_NAMES.indexOf(name as (typeof LABEL_NAMES)[number])
  return (i < 0 ? SemanticLabel.None : i) as SemanticLabel
}

/**
 * The render type a label implies. Type drives the box colour, so re-labelling
 * a node has to move its type too — otherwise the reviewer's correction is
 * invisible on the canvas, which is where they are looking.
 */
export const TYPE_OF_LABEL: Record<SemanticLabel, NodeType> = {
  [SemanticLabel.None]: NodeType.Paragraph,
  [SemanticLabel.Question]: NodeType.KeyValue,
  [SemanticLabel.Answer]: NodeType.KeyValue,
  [SemanticLabel.Header]: NodeType.Paragraph,
  [SemanticLabel.Other]: NodeType.Paragraph,
  [SemanticLabel.Word]: NodeType.Line,
}

/** The labels a reviewer may choose. `Word` and `None` are structural, not choices. */
export const ASSIGNABLE: readonly SemanticLabel[] = [
  SemanticLabel.Question,
  SemanticLabel.Answer,
  SemanticLabel.Header,
  SemanticLabel.Other,
]
