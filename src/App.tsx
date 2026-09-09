import { useEffect, useRef, useState } from "react"

import { Session } from "@/app/session"
import { StatusBar } from "@/components/StatusBar"
import { TreeView } from "@/components/TreeView"
import { Button } from "@/components/ui/button"
import type { NodeArrays } from "@/data/nodes"
import { canRedo, canUndo, redo, undo, useStore } from "@/store/store"

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const [nodes, setNodes] = useState<NodeArrays | null>(null)
  const [stats, setStats] = useState({ fps: 0, zoom: 0.35 })
  const [stream, setStream] = useState({
    pagesReceived: 0,
    shielded: 0,
    connected: false,
    done: false,
  })
  const selectedId = useStore((s) => s.selectedId)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const session = new Session(canvas)
    sessionRef.current = session
    setNodes(session.nodes)

    let frames = 0
    let since = performance.now()
    const offFrame = session.engine.onFrame(() => {
      frames++
      const now = performance.now()
      if (now - since >= 500) {
        setStats({
          fps: Math.round((frames * 1000) / (now - since)),
          zoom: session.engine.viewport.scale,
        })
        frames = 0
        since = now
      }
    })
    void session.connectStream(() => setStream({ ...session.status }))

    return () => {
      offFrame()
      session.dispose()
      sessionRef.current = null
      setNodes(null)
    }
  }, [])

  return (
    <div className="flex h-svh flex-col bg-background text-foreground antialiased">
      <header className="sticky top-0 z-50 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur-lg">
        <span className="text-sm font-semibold tracking-tight">Layout Repair</span>
        <span className="text-xs text-muted-foreground">
          {selectedId === null ? "no selection" : `node #${selectedId}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={!canUndo()} onClick={() => undo()}>
            Undo
          </Button>
          <Button size="sm" variant="outline" disabled={!canRedo()} onClick={() => redo()}>
            Redo
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <TreeView
          nodes={nodes}
          version={stream.pagesReceived}
          onFocus={(id) => sessionRef.current?.focusNode(id)}
        />
        <div className="relative min-h-0 flex-1">
          <canvas ref={canvasRef} className="block h-full w-full touch-none" />
        </div>
      </div>
      <StatusBar nodes={nodes?.count ?? 0} {...stats} {...stream} />
    </div>
  )
}

export default App
