import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { NodeType, type NodeArrays } from "@/data/nodes"
import { cn } from "@/lib/utils"
import { useStore } from "@/store/store"

export type TreeRow = {
  id: number
  depth: number
  type: NodeType
  label: string
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

/** Flattens the node hierarchy to the rows currently revealed. */
export function buildTreeRows(nodes: NodeArrays, expanded: Set<number>): TreeRow[] {
  const childrenOf = new Map<number, number[]>()
  const roots: number[] = []
  for (let i = 0; i < nodes.count; i++) {
    const p = nodes.parents[i]
    if (p < 0) {
      roots.push(i)
      continue
    }
    const list = childrenOf.get(p)
    if (list) list.push(i)
    else childrenOf.set(p, [i])
  }

  const rows: TreeRow[] = []
  const visit = (index: number, depth: number) => {
    const kids = childrenOf.get(index)
    const id = nodes.ids[index]
    rows.push({
      id,
      depth,
      type: nodes.types[index] as NodeType,
      label: `${TYPE_LABEL[nodes.types[index]] ?? "Node"} ${id}`,
      hasChildren: !!kids?.length,
    })
    if (!kids || !expanded.has(id)) return
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
}

/**
 * Hand-virtualized: 10k rows of DOM would reintroduce the very bottleneck the
 * canvas exists to avoid.
 */
export function TreeView({ nodes, version, onFocus }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Narrow subscriptions — selecting whole state would re-render on every stream write.
  const selectedId = useStore((s) => s.selectedId)
  const hoveredId = useStore((s) => s.hoveredId)

  const rows = useMemo(
    () => (nodes ? buildTreeRows(nodes, expanded) : []),
    [nodes, expanded, version],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // Canvas → tree: scroll the selected row into view.
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
    <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card">
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
        onMouseLeave={() => useStore.setState({ hoveredId: null })}
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
                onMouseEnter={() => useStore.setState({ hoveredId: row.id })}
                onClick={() => {
                  useStore.setState({ selectedId: row.id })
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
                <span className="truncate">{row.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
