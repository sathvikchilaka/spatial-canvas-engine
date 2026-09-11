import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ASSIGNABLE, labelFromName, labelName } from "@/data/labels"
import { NodeType, indexOfId, type NodeArrays } from "@/data/nodes"
import { cn } from "@/lib/utils"
import { setUiState, useStore } from "@/store/store"
import { SemanticLabel } from "@/worker/protocol"

export type RowMeta = {
  textOf(id: number): string
  labelOf(id: number): SemanticLabel
}

export type TreeRow = {
  id: number
  depth: number
  type: NodeType
  /** Type-and-id fallback, e.g. "Line 1042". Always present. */
  title: string
  /** Extracted text, `''` when the source has none. */
  text: string
  label: SemanticLabel
  hasChildren: boolean
}

const ROW_H = 24
const OVERSCAN = 6

const TYPE_LABEL: Record<number, string> = {
  [NodeType.Paragraph]: "Paragraph",
  [NodeType.Line]: "Line",
  [NodeType.Cell]: "Cell",
  [NodeType.KeyValue]: "Key/Value",
  [NodeType.Figure]: "Figure",
}

/**
 * Sorts sibling node *indices* into the order a human reads the page: page,
 * then line, then left-to-right.
 *
 * `nodes.order` is not usable here — FUNSD's parser restarts it at 0 on every
 * page, so sorting by it interleaves all 199 pages. And sorting on raw y alone
 * scrambles words that share a line but whose tops differ by a pixel or two
 * ("INTERNATIONAL" y=1115 would land after "TOBACCO" y=1113), so nodes are
 * clustered into lines first and x decides within a line.
 */
function sortReadingOrder(indices: number[], nodes: NodeArrays): void {
  if (indices.length < 2) return
  const xOf = (i: number) => nodes.coords[i * 4]
  const yOf = (i: number) => nodes.coords[i * 4 + 1]

  indices.sort(
    (a, b) => nodes.pages[a] - nodes.pages[b] || yOf(a) - yOf(b) || xOf(a) - xOf(b),
  )

  // Second pass over the y-sorted run, so the line clustering stays transitive:
  // a comparator with a fuzzy y would not be a total order.
  let start = 0
  for (let i = 1; i <= indices.length; i++) {
    const head = indices[start]
    const sameLine =
      i < indices.length &&
      nodes.pages[indices[i]] === nodes.pages[head] &&
      yOf(indices[i]) - yOf(head) <= Math.max(nodes.coords[head * 4 + 3] * 0.6, 1)
    if (sameLine) continue
    if (i - start > 1) {
      const line = indices.slice(start, i).sort((a, b) => xOf(a) - xOf(b))
      for (let k = 0; k < line.length; k++) indices[start + k] = line[k]
    }
    start = i
  }
}

/** Flattens the node hierarchy to the rows currently revealed. */
export function buildTreeRows(
  nodes: NodeArrays,
  expanded: Set<number>,
  meta?: RowMeta,
): TreeRow[] {
  // `parents[i]` holds the parent's *id* (the wire shape), not its row index.
  const childrenOf = new Map<number, number[]>()
  const roots: number[] = []
  for (let i = 0; i < nodes.count; i++) {
    const pid = nodes.parents[i]
    if (pid < 0) {
      roots.push(i)
      continue
    }
    const list = childrenOf.get(pid)
    if (list) list.push(i)
    else childrenOf.set(pid, [i])
  }

  sortReadingOrder(roots, nodes)

  const rows: TreeRow[] = []
  const visit = (index: number, depth: number) => {
    const id = nodes.ids[index]
    const kids = childrenOf.get(id)
    rows.push({
      id,
      depth,
      type: nodes.types[index] as NodeType,
      title: `${TYPE_LABEL[nodes.types[index]] ?? "Node"} ${id}`,
      text: meta?.textOf(id) ?? "",
      label: meta?.labelOf(id) ?? SemanticLabel.None,
      hasChildren: !!kids?.length,
    })
    if (!kids || !expanded.has(id)) return
    // Sorted on reveal, not up front: collapsed subtrees are the common case
    // and the stream rebuilds these rows on every page that lands.
    sortReadingOrder(kids, nodes)
    for (const k of kids) visit(k, depth + 1)
  }
  for (const r of roots) visit(r, 0)
  return rows
}

type Props = {
  nodes: NodeArrays | null
  /** Bumped by the session when the document changes, to rebuild rows. */
  version: number
  onFocus(id: number): void
  meta?: RowMeta
  onRelabel?(id: number, label: SemanticLabel): void
}

/**
 * Hand-virtualized: 10k rows of DOM would reintroduce the very bottleneck the
 * canvas exists to avoid.
 */
export const TreeView = memo(function TreeView({
  nodes,
  version,
  onFocus,
  meta,
  onRelabel,
}: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Narrow subscriptions — selecting whole state would re-render on every stream write.
  const selectedId = useStore((s) => s.selectedId)
  const hoveredId = useStore((s) => s.hoveredId)

  const rows = useMemo(
    () => (nodes ? buildTreeRows(nodes, expanded, meta) : []),
    [nodes, expanded, version, meta],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Read the height off the entry, not `clientHeight`: a layout read inside
    // the callback flushes pending layout, and this observer shares a delivery
    // batch with the canvas engine's.
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.borderBoxSize?.[0]
      setHeight(box ? box.blockSize : el.clientHeight)
    })
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // Canvas → tree: a canvas pick usually lands on a leaf (Line/Cell) whose
  // parent is still collapsed, so the row does not exist yet. Expand the
  // ancestor chain on selection change; the scroll effect below then runs.
  useEffect(() => {
    if (!nodes) return
    return useStore.subscribe((state, prev) => {
      const id = state.selectedId
      if (id === null || id === prev.selectedId) return
      const chain: number[] = []
      let i = indexOfId(nodes, id)
      while (i >= 0) {
        const pid = nodes.parents[i]
        if (pid < 0) break
        chain.push(pid)
        i = indexOfId(nodes, pid)
      }
      if (!chain.length) return
      setExpanded((prevSet) => {
        if (chain.every((c) => prevSet.has(c))) return prevSet
        const next = new Set(prevSet)
        for (const c of chain) next.add(c)
        return next
      })
    })
  }, [nodes])

  // Scroll the selected row into view once it exists.
  useEffect(() => {
    if (selectedId === null) return
    const at = rows.findIndex((r) => r.id === selectedId)
    if (at < 0) return
    const el = scrollRef.current
    if (!el) return
    const top = at * ROW_H
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - ROW_H) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2)
    }
  }, [selectedId, rows])

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const visibleCount = Math.ceil(height / ROW_H) + OVERSCAN * 2
  const slice = rows.slice(first, first + visibleCount)

  return (
    <aside className="flex h-full w-full flex-col bg-card">
      <div className="border-b border-border px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Structure
        </span>
        <span className="ml-2 font-mono text-xs text-muted-foreground">
          {rows.length.toLocaleString()}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onMouseLeave={() => setUiState({ hoveredId: null })}
      >
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {slice.map((row, i) => {
            const index = first + i
            return (
              <button
                key={row.id}
                type="button"
                style={{ position: "absolute", top: index * ROW_H, height: ROW_H, left: 0, right: 0 }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-1 px-2 text-left text-xs transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  row.id === selectedId && "bg-accent text-accent-foreground",
                  row.id === hoveredId && row.id !== selectedId && "bg-muted",
                )}
                onMouseEnter={() => setUiState({ hoveredId: row.id })}
                onClick={() => {
                  setUiState({ selectedId: row.id })
                  onFocus(row.id)
                }}
              >
                <span style={{ width: row.depth * 12 }} aria-hidden />
                {row.hasChildren ? (
                  <span
                    className="w-3 text-muted-foreground"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(row.id)
                    }}
                  >
                    {expanded.has(row.id) ? "▾" : "▸"}
                  </span>
                ) : (
                  <span className="w-3" aria-hidden />
                )}
                <span className="truncate text-sm">{row.text || row.title}</span>
                {row.label !== SemanticLabel.None && row.label !== SemanticLabel.Word ? (
                  <Badge
                    variant="secondary"
                    className="ml-auto shrink-0 text-[10px] uppercase tracking-wider"
                  >
                    {labelName(row.label)}
                  </Badge>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
      {selectedId !== null && onRelabel ? (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Label
          </span>
          <Select
            value={labelName(meta?.labelOf(selectedId) ?? SemanticLabel.None)}
            onValueChange={(v) => onRelabel(selectedId, labelFromName(v))}
          >
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNABLE.map((l) => (
                <SelectItem key={l} value={labelName(l)} className="text-xs">
                  {labelName(l)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </aside>
  )
})
