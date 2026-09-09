import { cn } from "@/lib/utils"

type Props = {
  nodes: number
  fps: number
  zoom: number
  pagesReceived: number
  shielded: number
  connected: boolean
  done: boolean
}

export function StatusBar({ nodes, fps, zoom, pagesReceived, shielded, connected, done }: Props) {
  return (
    <footer className="flex items-center gap-4 border-t border-border bg-card px-4 py-1.5 font-mono text-xs text-muted-foreground">
      <span>{nodes.toLocaleString()} boxes</span>
      <span>{Math.round(zoom * 100)}%</span>
      <span className={cn(fps > 0 && fps < 50 && "text-destructive")}>{fps} fps</span>
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
    </footer>
  )
}
