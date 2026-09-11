import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"

import { benchPan, benchPick } from "@/app/bench"
import { ingestReport, markStreamDone, startIngestProbe, stopIngestProbe } from "@/app/ingestProbe"
import { Session } from "@/app/session"
import { DocumentPicker, type DocumentId } from "@/components/DocumentPicker"
import { InspectorPanel } from "@/components/InspectorPanel"
import { StatusBar } from "@/components/StatusBar"
import { Toolbar, type ToolName } from "@/components/Toolbar"
import { TreeView } from "@/components/TreeView"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { createFunsdDocument } from "@/data/funsd/source"
import { ASSIGNABLE } from "@/data/labels"
import type { NodeArrays } from "@/data/nodes"
import { createSyntheticDocument } from "@/data/synthetic/source"
import { zoomAt } from "@/engine/viewport"
import { canRedo, canUndo, redo, resetHistory, undo, useStore } from "@/store/store"
import { SemanticLabel } from "@/worker/protocol"

/**
 * How long the structure tree may lag the stream. `buildTreeRows` is O(n log n)
 * over the whole document, so it must not run once per ingested page.
 */
const TREE_REBUILD_MS = 400

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const streamFrameRef = useRef<number | null>(null)
  const treeTimerRef = useRef<number | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const [, startVersionTransition] = useTransition()
  const [nodes, setNodes] = useState<NodeArrays | null>(null)
  const [stats, setStats] = useState({ fps: 0, drawMs: 0, drawn: 0, zoom: 0.35 })
  const [stream, setStream] = useState({
    pagesReceived: 0,
    shielded: 0,
    connected: false,
    done: false,
    transport: "replay" as "sse" | "replay",
    failed: 0,
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
  const zoomStep = useCallback((factor: number) => {
    const engine = sessionRef.current?.engine
    if (!engine) return
    const { w, h } = engine.size
    engine.setViewport(zoomAt(engine.viewport, w / 2, h / 2, factor))
  }, [])
  const handleToolChange = useCallback((t: ToolName) => {
    setTool(t)
    sessionRef.current?.setTool(t)
  }, [])
  const handleRelabel = useCallback((id: number, label: SemanticLabel) => {
    sessionRef.current?.setLabel(id, label)
  }, [])

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
        // Read-only status for the e2e suite — the same object the status bar renders.
        w.__status = () => session.status
        // Read-only edit map, so the suite can assert undo/redo without reading the DOM.
        w.__edits = () => useStore.getState().edits
        // Selection state. `__status()` does not carry it, so a test asserting
        // "the click selected something" had no way to actually check.
        w.__ui = () => {
          const s = useStore.getState()
          return { selectedId: s.selectedId, hoveredId: s.hoveredId }
        }
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
      const bumpTree = () => {
        treeTimerRef.current = null
        // Low-priority: React may yield mid-render instead of blocking on the
        // whole rebuild.
        startVersionTransition(() => setTreeVersion(session.status.pagesReceived))
      }

      void session.connectStream(() => {
        if (session.status.done) markStreamDone()
        // Ingest fires this on nearly every drained chunk. Coalescing to one
        // React commit per animation frame keeps status updates from forcing
        // a re-render on every SSE tick. The status bar is cheap, so it may
        // track the stream this closely.
        if (streamFrameRef.current === null) {
          streamFrameRef.current = requestAnimationFrame(() => {
            streamFrameRef.current = null
            setStream({ ...session.status })
          })
        }
        // The tree is the expensive consumer: `buildTreeRows` sorts every node
        // in the document, so bumping its version once per ingested page costs
        // 199 full O(n log n) rebuilds over 41k nodes on FUNSD. Throttle it —
        // a row count that trails the stream by a beat is the right trade for
        // an unblocked main thread — but never skip the last page.
        if (session.status.done) {
          if (treeTimerRef.current !== null) clearTimeout(treeTimerRef.current)
          bumpTree()
          return
        }
        if (treeTimerRef.current === null) {
          treeTimerRef.current = window.setTimeout(bumpTree, TREE_REBUILD_MS)
        }
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
      if (streamFrameRef.current !== null) {
        cancelAnimationFrame(streamFrameRef.current)
        streamFrameRef.current = null
      }
      if (treeTimerRef.current !== null) {
        clearTimeout(treeTimerRef.current)
        treeTimerRef.current = null
      }
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
      w.__status = null
      w.__edits = null
      setNodes(null)
      setTreeVersion(0)
      setStream({
        pagesReceived: 0,
        shielded: 0,
        connected: false,
        done: false,
        transport: "replay",
        failed: 0,
      })
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
          <Toolbar active={tool} onChange={handleToolChange} />
          <Button size="sm" variant="outline" disabled={!canUndo()} onClick={() => undo()}>
            Undo
          </Button>
          <Button size="sm" variant="outline" disabled={!canRedo()} onClick={() => redo()}>
            Redo
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal" autoSave="layout-repair-columns">
          <ResizablePanel defaultSize="20" minSize="14" maxSize="35" className="bg-card">
            <TreeView
              nodes={nodes}
              version={treeVersion}
              onFocus={focusNode}
              meta={treeMeta}
              onRelabel={handleRelabel}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="55" minSize="30">
            <div className="relative h-full min-h-0">
              <canvas ref={canvasRef} className="block h-full w-full touch-none" />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="25" minSize="18" maxSize="45" className="bg-card">
            <InspectorPanel
              nodes={nodes}
              version={treeVersion}
              meta={treeMeta}
              rectOf={rectOf}
              onFocus={focusNode}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar
        nodes={nodes?.count ?? 0}
        {...stats}
        {...stream}
        onZoomIn={() => zoomStep(1.2)}
        onZoomOut={() => zoomStep(1 / 1.2)}
      />
    </div>
  )
}

export default App
