import { indexOfId, NodeType, type NodeArrays, type Rect } from '@/data/nodes'
import { labelName } from '@/data/labels'
import type { RowMeta } from './TreeView'

export type InspectorNode = {
  id: number
  type: string
  label: string
  text: string
  rect: Rect
  /** The human has edited this node — the inspector says so, in both views. */
  modified: boolean
  children: InspectorNode[]
}

const TYPE_NAME: Record<number, string> = {
  [NodeType.Paragraph]: 'paragraph',
  [NodeType.Line]: 'line',
  [NodeType.Cell]: 'cell',
  [NodeType.KeyValue]: 'keyValue',
  [NodeType.Figure]: 'figure',
}

/** Default node cap. A FUNSD entity has ≤40 words; the cap is for pathological parents. */
const MAX_NODES = 400

/**
 * The **selected** node's subtree, not the document. Serializing 41,228 nodes
 * to JSON would block the main thread for far longer than the 16ms budget and
 * would be unreadable anyway — the reviewer wants to see the thing they clicked.
 */
export function subtreeOf(
  nodes: NodeArrays,
  rootId: number,
  meta: RowMeta,
  rectOf: (id: number) => Rect | null,
  modified: (id: number) => boolean,
  maxNodes = MAX_NODES,
): InspectorNode | null {
  if (indexOfId(nodes, rootId) < 0) return null

  const childrenOf = new Map<number, number[]>()
  for (let i = 0; i < nodes.count; i++) {
    const pid = nodes.parents[i]
    if (pid < 0) continue
    const list = childrenOf.get(pid)
    if (list) list.push(i)
    else childrenOf.set(pid, [i])
  }

  let budget = maxNodes
  const build = (id: number): InspectorNode => {
    budget--
    const i = indexOfId(nodes, id)
    const r = rectOf(id) ?? { x: 0, y: 0, w: 0, h: 0 }
    const kids = childrenOf.get(id) ?? []
    const children: InspectorNode[] = []
    for (const k of kids) {
      if (budget <= 0) break
      children.push(build(nodes.ids[k]))
    }
    return {
      id,
      type: TYPE_NAME[nodes.types[i]] ?? 'node',
      label: labelName(meta.labelOf(id)),
      text: meta.textOf(id),
      rect: r,
      modified: modified(id),
      children,
    }
  }
  return build(rootId)
}

export type InspectorRow = {
  node: InspectorNode
  depth: number
}

/**
 * Depth-first flattening of a subtree, for row-based rendering (each node
 * becomes one clickable row instead of a flat JSON/Markdown string) — mirrors
 * `buildTreeRows` in `TreeView.tsx` but over an already-materialized subtree.
 */
export function flattenInspectorTree(node: InspectorNode, depth = 0): InspectorRow[] {
  const rows: InspectorRow[] = [{ node, depth }]
  for (const child of node.children) rows.push(...flattenInspectorTree(child, depth + 1))
  return rows
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * One node's compact JSON line — the single implementation of "how one node
 * renders" as JSON, shared by the per-row inspector panel and `toJson`'s
 * nested dump. Coordinates are rounded: `104.00000762939453` is Float32 noise,
 * not data.
 */
export function jsonLineFor(n: InspectorNode): string {
  const rect = `{ "x": ${r2(n.rect.x)}, "y": ${r2(n.rect.y)}, "w": ${r2(n.rect.w)}, "h": ${r2(n.rect.h)} }`
  return `{ "id": ${n.id}, "type": "${n.type}", "label": "${n.label}", "text": ${JSON.stringify(n.text)}, "rect": ${rect}, "modified": ${n.modified} }`
}

/** Pretty JSON with coordinates rounded — the nested-tree counterpart to `jsonLineFor`. */
export function toJson(node: InspectorNode): string {
  const clean = (n: InspectorNode): unknown => ({
    id: n.id,
    type: n.type,
    label: n.label,
    text: n.text,
    rect: { x: r2(n.rect.x), y: r2(n.rect.y), w: r2(n.rect.w), h: r2(n.rect.h) },
    modified: n.modified,
    children: n.children.map(clean),
  })
  return JSON.stringify(clean(node), null, 2)
}

/**
 * One node's Markdown rendering — heading + text body for a branch, list item
 * for a leaf. The single implementation of "how one node renders" as
 * Markdown, shared by the per-row inspector panel and `toMarkdown`'s prose
 * walk. Always includes the node's text body when present, so a re-labeled
 * or text-edited node is never silently dropped from either view.
 */
export function markdownLineFor(n: InspectorNode, depth: number, asLeaf = n.children.length === 0): string {
  const edited = n.modified ? ' *(edited)*' : ''
  if (asLeaf) return `- ${n.text || `#${n.id}`}${edited}`
  const head = '#'.repeat(Math.min(6, depth + 2))
  const name = n.label === 'none' || n.label === 'word' ? `#${n.id}` : n.label
  return n.text ? `${head} ${name}${edited}\n\n${n.text}` : `${head} ${name}${edited}`
}

/**
 * The same tree as prose. Depth becomes heading level (capped at h6), text
 * becomes the body, and leaf children become a list — which is what a document
 * extraction actually reads like once it is correct.
 */
export function toMarkdown(node: InspectorNode): string {
  const out: string[] = []
  const walk = (n: InspectorNode, depth: number) => {
    out.push(markdownLineFor(n, depth, false), '')
    const leaves = n.children.filter((c) => c.children.length === 0)
    const branches = n.children.filter((c) => c.children.length > 0)
    for (const l of leaves) out.push(markdownLineFor(l, depth + 1))
    if (leaves.length > 0) out.push('')
    for (const b of branches) walk(b, depth + 1)
  }
  walk(node, 0)
  return out.join('\n')
}
