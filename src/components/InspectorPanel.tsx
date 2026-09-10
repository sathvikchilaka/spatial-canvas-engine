import { useMemo } from "react"

import type { NodeArrays, Rect } from "@/data/nodes"
import { cn } from "@/lib/utils"
import { useStore } from "@/store/store"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { RowMeta } from "./TreeView"
import { subtreeOf, toJson, toMarkdown } from "./inspectorModel"

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

  const json = useMemo(() => (tree ? toJson(tree) : ""), [tree])
  const markdown = useMemo(() => (tree ? toMarkdown(tree) : ""), [tree])

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
        <Pane text={json} />
      </TabsContent>
      <TabsContent value="markdown" className="min-h-0 flex-1 overflow-auto p-0">
        <Pane text={markdown} />
      </TabsContent>
      <TabsContent value="split" className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="grid h-full grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
          <div className="min-h-0 overflow-auto">
            <Pane text={json} />
          </div>
          <div className="min-h-0 overflow-auto">
            <Pane text={markdown} />
          </div>
        </div>
      </TabsContent>
    </Tabs>
  )
}

function Pane({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {text}
    </pre>
  )
}
