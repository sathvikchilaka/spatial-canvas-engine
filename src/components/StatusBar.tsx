import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type Props = {
  nodes: number
  fps: number
  /** Worst repaint cost in the last sample window, ms. */
  drawMs: number
  /** Frames actually repainted in the window — 0 means idle, not slow. */
  drawn: number
  zoom: number
  pagesReceived: number
  shielded: number
  connected: boolean
  done: boolean
  transport: "sse" | "replay"
  failed: number
}

export function StatusBar({
  nodes,
  fps,
  drawMs,
  drawn,
  zoom,
  pagesReceived,
  shielded,
  connected,
  done,
  transport,
  failed,
}: Props) {
  return (
    <footer className="flex items-center gap-4 border-t border-border bg-card px-4 py-1.5 font-mono text-xs text-muted-foreground">
      <span>{nodes.toLocaleString()} boxes</span>
      <span>{Math.round(zoom * 100)}%</span>
      <span className={cn(fps > 0 && fps < 50 && "text-destructive")}>{fps} fps</span>
      {/* Repaint cost is the real budget; fps alone tracks how often input arrives. */}
      <span className={cn(drawMs > 16 && "text-destructive")} title="worst repaint in last 500ms">
        {drawn === 0 ? "idle" : `${drawMs.toFixed(2)} ms draw`}
      </span>
      <Badge
        variant={transport === "sse" ? "default" : "secondary"}
        className="text-[10px] uppercase tracking-wider"
      >
        {transport === "sse" ? "live sse" : "replay"}
      </Badge>
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
}
