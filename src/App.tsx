import { useEffect, useRef, useState } from "react"

import { Session } from "@/app/session"
import { canRedo, canUndo, redo, undo, useStore } from "@/store/store"
import { Button } from "@/components/ui/button"

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const [stats, setStats] = useState({ nodes: 0, fps: 0 })
  const [stream, setStream] = useState({ pagesReceived: 0, shielded: 0, connected: false, done: false })
  const selectedId = useStore((s) => s.selectedId)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const session = new Session(canvas)
    sessionRef.current = session

    let frames = 0
    let since = performance.now()
    const offFrame = session.engine.onFrame(() => {
      frames++
      const now = performance.now()
      if (now - since >= 500) {
        setStats({ nodes: session.nodes.count, fps: Math.round((frames * 1000) / (now - since)) })
        frames = 0
        since = now
      }
    })
    setStats((s) => ({ ...s, nodes: session.nodes.count }))
    void session.connectStream(() => setStream({ ...session.status }))

    return () => {
      offFrame()
      session.dispose()
      sessionRef.current = null
    }
  }, [])

  return (
    <div className="flex h-svh flex-col bg-background text-foreground antialiased">
      <header className="sticky top-0 z-50 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur-lg">
        <span className="text-sm font-semibold tracking-tight">Layout Repair</span>
        <span className="text-xs text-muted-foreground">
          {stats.nodes.toLocaleString()} boxes · 100 pages
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              {stream.connected && !stream.done && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
              )}
              <span
                className={
                  stream.connected
                    ? "relative inline-flex h-2 w-2 rounded-full bg-emerald-500"
                    : "relative inline-flex h-2 w-2 rounded-full bg-muted-foreground"
                }
              />
            </span>
            {stream.pagesReceived} pages
            {stream.shielded > 0 && ` · ${stream.shielded} edits preserved`}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {selectedId === null ? "no selection" : `#${selectedId}`}
          </span>
          <Button size="sm" variant="outline" disabled={!canUndo()} onClick={() => undo()}>
            Undo
          </Button>
          <Button size="sm" variant="outline" disabled={!canRedo()} onClick={() => redo()}>
            Redo
          </Button>
          <span className="font-mono text-xs text-muted-foreground">{stats.fps} fps</span>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      </div>
    </div>
  )
}

export default App
