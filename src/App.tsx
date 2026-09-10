import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { benchPan, benchPick } from "@/app/bench"
import { ingestReport, markStreamDone, startIngestProbe, stopIngestProbe } from "@/app/ingestProbe"
import { Session } from "@/app/session"
import { DocumentPicker, type DocumentId } from "@/components/DocumentPicker"
import { InspectorPanel } from "@/components/InspectorPanel"
import { StatusBar } from "@/components/StatusBar"
import { Toolbar, type ToolName } from "@/components/Toolbar"
import { TreeView } from "@/components/TreeView"
import { Button } from "@/components/ui/button"
import { createFunsdDocument } from "@/data/funsd/source"
import { ASSIGNABLE } from "@/data/labels"
import type { NodeArrays } from "@/data/nodes"
import { createSyntheticDocument } from "@/data/synthetic/source"
import { canRedo, canUndo, redo, resetHistory, undo, useStore } from "@/store/store"
import { SemanticLabel } from "@/worker/protocol"

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const [nodes, setNodes] = useState<NodeArrays | null>(null)
  const [stats, setStats] = useState({ fps: 0, drawMs: 0, drawn: 0, zoom: 0.35 })
  const [stream, setStream] = useState({
    pagesReceived: 0,
    shielded: 0,
    connected: false,
    done: false,
  })
  const [tool, setTool] = useState<ToolName>("select")
  const [docId, setDocId] = useState<DocumentId>("funsd")
  const selectedId = useStore((s) => s.selectedId)
  const treeMeta = useMemo(
    () => ({
      textOf: (id: number) => sessionRef.current?.textOf(id) ?? "",
      labelOf: (id: number) => sessionRef.current?.labelOf(id) ?? SemanticLabel.None,
    }),
    [],
  )
  const rectOf = useCallback((id: number) => sessionRef.current?.rectOf(id) ?? null, [])
  const focusNode = useCallback((id: number) => sessionRef.current?.focusNode(id), [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let offFrame: (() => void) | null = null
    // The probe is a module-scope rAF loop + PerformanceObserver; it must be
    // owned by the mount, or it outlives every session it was measuring.
    startIngestProbe()

    const build = async () => {
      const doc =
        docId === "funsd" ? await createFunsdDocument() : createSyntheticDocument(100, 1)
      if (cancelled) return

      const session = new Session(canvas, doc)
      sessionRef.current = session
      // Console perf harness: `await __bench()` for a 5s scripted pan.
      // Dev always; in a production build only with ?bench=1, so the handles
      // never dangle in a real deployment.
      if (import.meta.env.DEV || new URLSearchParams(location.search).has("bench")) {
        const w = window as unknown as Record<string, unknown>
        w.__session = session
        w.__bench = (opts?: unknown) => benchPan(session, opts as never)
        w.__pick = (samples?: number) => benchPick(session, samples)
        w.__ingest = () => ingestReport()
      }
      setNodes(session.nodes)

      // fps = animation-frame rate (are we keeping up with the display), drawMs =
      // worst repaint cost in the window. Counting only repainted frames would
      // report the input event rate: a dirty-flag loop draws nothing when idle.
      let ticks = 0
      let drawn = 0
      let worst = 0
      let since = performance.now()
      offFrame = session.engine.onTick((drew, ms) => {
        ticks++
        if (drew) {
          drawn++
          if (ms > worst) worst = ms
        }
        const now = performance.now()
        if (now - since >= 500) {
          setStats({
            fps: Math.round((ticks * 1000) / (now - since)),
            drawMs: Math.round(worst * 100) / 100,
            drawn,
            zoom: session.engine.viewport.scale,
          })
          ticks = 0
          drawn = 0
          worst = 0
          since = now
        }
      })
      void session.connectStream(() => {
        if (session.status.done) markStreamDone()
        setStream({ ...session.status })
      })
    }
    void build()

    // V / O / T, as the toolbar's labels promise. Owned by the same effect as
    // the session so the listener cannot outlive it.
    const onToolKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (document.querySelector('[role="combobox"][data-state="open"]')) return
      const k = e.key.toLowerCase()
      const next: ToolName | null =
        k === "v" ? "select" : k === "o" ? "order" : k === "t" ? "table" : null
      if (next) {
        setTool(next)
        sessionRef.current?.setTool(next)
        return
      }
      // 1–4 relabel the selection: the fast path for bulk correction.
      const digit = "1234".indexOf(e.key)
      if (digit >= 0) {
        const sel = useStore.getState().selectedId
        if (sel !== null) sessionRef.current?.setLabel(sel, ASSIGNABLE[digit])
        return
      }
    }
    window.addEventListener("keydown", onToolKey)

    return () => {
      window.removeEventListener("keydown", onToolKey)
      cancelled = true
      stopIngestProbe()
      offFrame?.()
      sessionRef.current?.dispose()
      sessionRef.current = null
      // The perf handles must never address a disposed session — null them
      // alongside the ref so a stray `__bench()` from the console (or a
      // build still in flight) fails loudly instead of touching a corpse.
      const w = window as unknown as Record<string, unknown>
      w.__session = null
      w.__bench = null
      w.__pick = null
      w.__ingest = null
      setNodes(null)
      setStream({ pagesReceived: 0, shielded: 0, connected: false, done: false })
      useStore.setState(
        { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
        true,
      )
      resetHistory()
    }
  }, [docId])

  return (
    <div className="flex h-svh flex-col bg-background text-foreground antialiased">
      <header className="sticky top-0 z-50 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-2 backdrop-blur-lg">
        <span className="text-sm font-semibold tracking-tight">Layout Repair</span>
        <span className="text-xs text-muted-foreground">
          {selectedId === null ? "no selection" : `node #${selectedId}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <DocumentPicker value={docId} onChange={setDocId} />
          <Toolbar
            active={tool}
            onChange={(t) => {
              setTool(t)
              sessionRef.current?.setTool(t)
            }}
          />
          <Button size="sm" variant="outline" disabled={!canUndo()} onClick={() => undo()}>
            Undo
          </Button>
          <Button size="sm" variant="outline" disabled={!canRedo()} onClick={() => redo()}>
            Redo
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 shrink-0 flex-col">
          <div className="flex min-h-0 flex-1">
            <TreeView
              nodes={nodes}
              version={stream.pagesReceived}
              onFocus={focusNode}
              meta={treeMeta}
              onRelabel={(id, label) => sessionRef.current?.setLabel(id, label)}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-border">
            <InspectorPanel
              nodes={nodes}
              version={stream.pagesReceived}
              meta={treeMeta}
              rectOf={rectOf}
              onFocus={focusNode}
            />
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <canvas ref={canvasRef} className="block h-full w-full touch-none" />
        </div>
      </div>
      <StatusBar nodes={nodes?.count ?? 0} {...stats} {...stream} />
    </div>
  )
}

export default App
