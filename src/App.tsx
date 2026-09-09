import { useEffect, useRef, useState } from "react"

import { generateDocument } from "@/data/generator"
import { BucketGrid } from "@/engine/bucketGrid"
import { CanvasEngine } from "@/engine/engine"
import { attachInput } from "@/engine/input"

export function App() {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stats, setStats] = useState({ nodes: 0, fps: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const engine = new CanvasEngine(canvas)
    const { nodes, pages } = generateDocument(100, 1)

    const grid = new BucketGrid()
    const indices = new Uint32Array(nodes.count)
    for (let i = 0; i < nodes.count; i++) indices[i] = i
    grid.addPage(0, nodes.ids, nodes.coords, indices)

    engine.setData(nodes, pages, grid)
    engine.start()
    const detach = attachInput(engine, canvas, () => null)

    let frames = 0
    let since = performance.now()
    const offFrame = engine.onFrame(() => {
      frames++
      const now = performance.now()
      if (now - since >= 500) {
        setStats({ nodes: nodes.count, fps: Math.round((frames * 1000) / (now - since)) })
        frames = 0
        since = now
      }
    })
    setStats((s) => ({ ...s, nodes: nodes.count }))

    return () => {
      offFrame()
      detach()
      engine.dispose()
      grid.clear()
    }
  }, [])

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur-lg">
        <span className="text-sm font-semibold tracking-tight">Layout Repair</span>
        <span className="text-xs text-muted-foreground">
          {stats.nodes.toLocaleString()} boxes · 100 pages
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {stats.fps} fps
        </span>
      </header>
      <div ref={hostRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      </div>
    </div>
  )
}

export default App
