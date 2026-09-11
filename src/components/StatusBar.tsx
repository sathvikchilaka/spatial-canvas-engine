import { memo } from "react"

import { cn } from "@/lib/utils"

type Props = {
  nodes: number
  zoom: number
  pagesReceived: number
  shielded: number
  connected: boolean
  done: boolean
  failed: number
  onZoomIn?: () => void
  onZoomOut?: () => void
}

export const StatusBar = memo(function StatusBar({
  nodes,
  zoom,
  pagesReceived,
  shielded,
  connected,
  done,
  failed,
  onZoomIn,
  onZoomOut,
}: Props) {
  return (
    <footer className="flex items-center gap-4 border-t border-border bg-card px-4 py-1.5 font-mono text-xs text-muted-foreground">
      <span>{nodes.toLocaleString()} boxes</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onZoomOut}
          className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm border border-border transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-foreground/60 disabled:pointer-events-none disabled:opacity-50"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="w-10 text-center">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={onZoomIn}
          className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm border border-border transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-muted-foreground/60 disabled:pointer-events-none disabled:opacity-50"
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
      <span className="ml-auto flex items-center gap-1.5">
        <span
          className={cn(
            "inline-flex h-2 w-2 rounded-full",
            done ? "bg-muted-foreground" : connected ? "bg-emerald-500" : "bg-destructive",
          )}
        />
        {done ? "stream complete" : connected ? "streaming" : "disconnected"} · {pagesReceived} pages
      </span>
      {shielded > 0 && <span className="text-amber-400">{shielded} edits preserved</span>}
      {failed > 0 && <span className="text-destructive">{failed} pages failed</span>}
    </footer>
  )
})
