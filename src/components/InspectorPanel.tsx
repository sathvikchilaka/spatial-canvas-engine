import { useMemo } from "react"

import type { NodeArrays, Rect } from "@/data/nodes"
import { cn } from "@/lib/utils"
import { setUiState, useStore } from "@/store/store"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { RowMeta } from "./TreeView"
import { flattenInspectorTree, subtreeOf, type InspectorNode, type InspectorRow } from "./inspectorModel"

type Props = {
  nodes: NodeArrays | null
  /** Bumped by the session when the document changes. */
  version: number
  meta: RowMeta
  rectOf(id: number): Rect | null
  onFocus(id: number): void
}

/**
 * JSON and Markdown views of the selected node's subtree. Subscribes to
 * `selectedId` and `edits` only — the stream writes to the typed arrays, not to
 * React, so this never re-renders during ingest.
 *
 * Rendered as per-node rows (not a flat `<pre>` string) so the panel can
 * highlight-sync with the canvas/tree bi-directionally: clicking any node's
 * row here selects it via `setUiState`, and the row matching `selectedId` is
 * highlighted, mirroring `TreeView.tsx`'s row pattern.
 */
export function InspectorPanel({ nodes, version, meta, rectOf, onFocus }: Props) {
  const selectedId = useStore((s) => s.selectedId)
  const edits = useStore((s) => s.edits)

  const tree = useMemo(
    () =>
      nodes === null || selectedId === null
        ? null
        : subtreeOf(nodes, selectedId, meta, rectOf, (id) => edits[id] !== undefined),
    [nodes, selectedId, meta, rectOf, edits, version],
  )

  const rows = useMemo(() => (tree ? flattenInspectorTree(tree) : []), [tree])

  if (!tree) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        Select a box to inspect its structure.
      </div>
    )
  }

  return (
    <Tabs defaultValue="json" className="flex h-full flex-col gap-0">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <TabsList className="h-7">
          <TabsTrigger value="json" className="h-6 px-2 text-xs">
            JSON
          </TabsTrigger>
          <TabsTrigger value="markdown" className="h-6 px-2 text-xs">
            Markdown
          </TabsTrigger>
          <TabsTrigger value="split" className="h-6 px-2 text-xs">
            Split
          </TabsTrigger>
        </TabsList>
        <button
          type="button"
          onClick={() => onFocus(tree.id)}
          className="cursor-pointer rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Focus #{tree.id}
        </button>
      </div>

      <TabsContent value="json" className="min-h-0 flex-1 overflow-auto p-0">
        <RowPane rows={rows} selectedId={selectedId} variant="json" onFocus={onFocus} />
      </TabsContent>
      <TabsContent value="markdown" className="min-h-0 flex-1 overflow-auto p-0">
        <RowPane rows={rows} selectedId={selectedId} variant="markdown" onFocus={onFocus} />
      </TabsContent>
      <TabsContent value="split" className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="grid h-full grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
          <div className="min-h-0 overflow-auto">
            <RowPane rows={rows} selectedId={selectedId} variant="json" onFocus={onFocus} />
          </div>
          <div className="min-h-0 overflow-auto">
            <RowPane rows={rows} selectedId={selectedId} variant="markdown" onFocus={onFocus} />
          </div>
        </div>
      </TabsContent>
    </Tabs>
  )
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** One row's text for the JSON-flavored rendering — compact, still valid-looking JSON per node. */
function jsonLine(n: InspectorNode): string {
  const rect = `{ "x": ${r2(n.rect.x)}, "y": ${r2(n.rect.y)}, "w": ${r2(n.rect.w)}, "h": ${r2(n.rect.h)} }`
  return `{ "id": ${n.id}, "type": "${n.type}", "label": "${n.label}", "text": ${JSON.stringify(n.text)}, "rect": ${rect}, "modified": ${n.modified} }`
}

/** One row's text for the Markdown-flavored rendering — heading for branches, list item for leaves. */
function markdownLine(n: InspectorNode, depth: number): string {
  if (n.children.length === 0) return `- ${n.text || `#${n.id}`}${n.modified ? " *(edited)*" : ""}`
  const head = "#".repeat(Math.min(6, depth + 2))
  const name = n.label === "none" || n.label === "word" ? `#${n.id}` : n.label
  return `${head} ${name}${n.modified ? " *(edited)*" : ""}`
}

/**
 * Renders one flattened subtree as clickable, individually-addressable rows.
 * Clicking a row selects that node via the store's `setUiState` (never raw
 * `useStore.setState`, which would wipe undo history) and recenters the
 * canvas on it — the same bi-directional contract `TreeView.tsx` rows have.
 */
function RowPane({
  rows,
  selectedId,
  variant,
  onFocus,
}: {
  rows: InspectorRow[]
  selectedId: number | null
  variant: "json" | "markdown"
  onFocus(id: number): void
}) {
  return (
    <div className="py-1 font-mono text-[11px] leading-relaxed">
      {rows.map(({ node, depth }) => (
        <div
          key={node.id}
          role="button"
          tabIndex={0}
          onClick={() => {
            setUiState({ selectedId: node.id })
            onFocus(node.id)
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return
            e.preventDefault()
            setUiState({ selectedId: node.id })
            onFocus(node.id)
          }}
          style={{ paddingLeft: 12 + depth * 12 }}
          className={cn(
            "cursor-pointer whitespace-pre-wrap break-words py-0.5 pr-3 text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-accent-foreground",
            node.id === selectedId && "bg-accent text-accent-foreground",
          )}
        >
          {variant === "json" ? jsonLine(node) : markdownLine(node, depth)}
        </div>
      ))}
    </div>
  )
}
