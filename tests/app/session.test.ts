// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '@/app/session'
import { indexOfId, NodeType, type Rect } from '@/data/nodes'
import { createSyntheticDocument } from '@/data/synthetic/source'
import { serializeGeneratedPage } from '@/data/synthetic/serialize'
import { commit, redo, resetHistory, undo, useStore } from '@/store/store'
import type { PageIngested, Res } from '@/worker/protocol'

/**
 * jsdom ships no canvas backend, ResizeObserver, matchMedia, rAF or
 * OffscreenCanvas. Stub just enough that construction, disposal, and (for the
 * raster/stream tests below) the real page-render and worker-ingest code
 * paths run without throwing.
 */
function fakeContext(): CanvasRenderingContext2D {
  const noop = () => {}
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'canvas') return undefined
        if (prop === 'createLinearGradient') return () => ({ addColorStop: noop })
        return noop
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
}

HTMLCanvasElement.prototype.getContext = ((() => fakeContext()) as unknown) as typeof HTMLCanvasElement.prototype.getContext
if (typeof globalThis.OffscreenCanvas === 'undefined') {
  class FakeOffscreenCanvas {
    width: number
    height: number
    constructor(w: number, h: number) {
      this.width = w
      this.height = h
    }
    getContext() {
      return fakeContext()
    }
  }
  ;(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeOffscreenCanvas
}
if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
if (typeof globalThis.Worker === 'undefined') {
  // Echoes just enough to resolve `WorkerClient.init` and, for `synthetic://`
  // ingestUrl requests, to mirror the real worker's `ingest()` — building the
  // same typed-array reply from `serializeGeneratedPage` — so a drained
  // stream really grows `session.nodes`, not just `pagesReceived`.
  class FakeWorker {
    /** Every updateNode the session sent, in order — asserted by the sync tests. */
    static updates: { nodeId: number; old: Rect; next: Rect }[] = []
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(msg: {
      id: number
      kind: string
      pageIndex?: number
      url?: string
      offsetX?: number
      offsetY?: number
      nodeId?: number
      old?: Rect
      next?: Rect
    }) {
      if (msg.kind === 'updateNode') {
        FakeWorker.updates.push({ nodeId: msg.nodeId!, old: msg.old!, next: msg.next! })
        queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, kind: 'ok' } } as MessageEvent))
        return
      }
      if (msg.kind === 'init') {
        queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, kind: 'ready' } } as MessageEvent))
        return
      }
      if (msg.kind === 'ingestUrl' && msg.url?.startsWith('synthetic://page/')) {
        const pageIndex = msg.pageIndex!
        const seed = Number(new URL(msg.url).searchParams.get('seed') ?? 1)
        queueMicrotask(() => {
          // Mirrors the real worker: the page origin comes from the caller's
          // PageGeometry, forwarded on the message.
          const nodes = serializeGeneratedPage(pageIndex, seed, msg.offsetX ?? 0, msg.offsetY ?? 0)
          const ids = Uint32Array.from(nodes.map((n) => n.id))
          const coords = new Float32Array(nodes.length * 4)
          const types = Uint8Array.from(nodes.map((n) => n.type))
          const parents = Int32Array.from(nodes.map((n) => n.parent))
          const order = Int32Array.from(nodes.map((n) => n.order))
          nodes.forEach((n, i) => {
            coords[i * 4] = n.x
            coords[i * 4 + 1] = n.y
            coords[i * 4 + 2] = n.w
            coords[i * 4 + 3] = n.h
          })
          const res: Res = {
            id: -1,
            kind: 'pageIngested',
            pageIndex,
            ids,
            coords,
            types,
            parents,
            order,
            edges: new Int32Array(0),
          } as PageIngested & { id: number }
          this.onmessage?.({ data: res } as MessageEvent)
        })
      }
    }
    terminate() {}
  }
  ;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
}
if (typeof window.requestAnimationFrame === 'undefined') {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame
}

const workerUpdates = () =>
  (globalThis as unknown as { Worker: { updates: { nodeId: number; old: Rect; next: Rect }[] } })
    .Worker.updates

function canvas() {
  const el = document.createElement('canvas')
  el.getBoundingClientRect = () => ({ width: 800, height: 600, top: 0, left: 0 }) as DOMRect
  return el
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Session lifecycle', () => {
  it('constructs and disposes 20 times without growing listeners', async () => {
    const before = { add: 0, remove: 0 }
    const origAdd = window.addEventListener.bind(window)
    const origRemove = window.removeEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((...a) => { before.add++; return origAdd(...a) })
    vi.spyOn(window, 'removeEventListener').mockImplementation((...a) => { before.remove++; return origRemove(...a) })

    for (let i = 0; i < 20; i++) {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      s.dispose()
    }

    // Every listener a session adds must come back off on dispose.
    expect(before.remove).toBe(before.add)
  })

  it('drops page rasters on dispose', async () => {
    const s = new Session(canvas(), createSyntheticDocument(4, 1))
    await s.ready

    // Drive the real raster path directly rather than through the rAF loop
    // (the rAF stub above is a bare setTimeout that this test never lets
    // fire) — `ensure` kicks off `doc.raster`, which is async even for the
    // synthetic source, so flush microtasks until it lands in the cache.
    s.engine.pageLayer.cache.ensure(0, true)
    for (let i = 0; i < 10 && s.engine.pageLayer.cache.size === 0; i++) {
      await Promise.resolve()
    }
    expect(s.engine.pageLayer.cache.size).toBeGreaterThan(0)

    s.dispose()
    expect(s.engine.pageLayer.cache.size).toBe(0)
  })

  it('drains a synthetic stream to the ~10k stress-corpus node count', async () => {
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(100, 1))
      await s.ready
      await s.connectStream()

      // MockStreamSource staggers 100 pages over seed-dependent delays, each
      // followed by a worker round-trip and an 8ms-budgeted drain retry —
      // advance in slices, flushing microtasks between each, until `done`.
      for (let i = 0; i < 400 && !s.status.done; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }
      await vi.advanceTimersByTimeAsync(50)

      expect(s.status.done).toBe(true)
      expect(s.nodes.count).toBeGreaterThan(9000)
      s.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a stream when disposed while geometry is pending', async () => {
    vi.useFakeTimers()
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const doc = createSyntheticDocument(100, 1)
      // A document whose geometry never settles before dispose — the fast
      // double-switch the picker allows.
      let release: (() => void) | null = null
      const gate = new Promise<void>((r) => { release = r })
      const inner = doc.geometry.bind(doc)
      doc.geometry = async () => { await gate; return inner() }

      const s = new Session(canvas(), doc)
      const started = s.connectStream()
      s.dispose()
      const timersBefore = timerSpy.mock.calls.length
      release!()
      await started

      // No source installed, so none of MockStreamSource's ~100 setTimeouts
      // were ever scheduled, and nothing can drain into a dead worker.
      expect(s.status.connected).toBe(false)
      expect(timerSpy.mock.calls.length).toBe(timersBefore)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The store holds only human edits, so the render arrays are the baseline the
   * UI falls back to. Undo therefore has to put the stream geometry *back* into
   * `nodes.coords` — an edit vanishing is as much a change as one appearing.
   */
  it('restores stream geometry in the render arrays when an edit is undone', async () => {
    useStore.setState(
      { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
      true,
    )
    resetHistory()
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 40 && s.nodes.count === 0; i++) {
        await vi.advanceTimersByTimeAsync(50)
      }
      expect(s.nodes.count).toBeGreaterThan(0)

      const id = s.nodes.ids[0]
      const streamX = s.nodes.coords[0]
      expect(s.rectOf(id)?.x).toBe(streamX)

      commit('editBox', (d) => {
        d.edits[id] = { rect: { x: 999, y: 998, w: 10, h: 10 } }
        d.dirtyAt[id] = Date.now()
      })
      expect(s.nodes.coords[0]).toBe(999)
      expect(s.rectOf(id)?.x).toBe(999)

      undo()
      expect(s.nodes.coords[0]).toBe(streamX)
      expect(s.nodes.coords[1]).toBe(s.rectOf(id)?.y)
      expect(s.rectOf(id)?.x).toBe(streamX)

      redo()
      expect(s.nodes.coords[0]).toBe(999)
      expect(s.rectOf(id)?.x).toBe(999)

      s.dispose()
    } finally {
      vi.useRealTimers()
      useStore.setState(
        { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
        true,
      )
      resetHistory()
    }
  })

  it('switching documents produces no console errors', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s1 = new Session(canvas(), createSyntheticDocument(4, 1))
    await s1.ready
    s1.dispose()

    const s2 = new Session(canvas(), createSyntheticDocument(4, 2))
    await s2.ready
    s2.dispose()

    expect(errors).not.toHaveBeenCalled()
  })
})

describe('spatial index synchronisation', () => {
  const clean = () => {
    useStore.setState(
      { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
      true,
    )
    resetHistory()
    workerUpdates().length = 0
  }

  /**
   * The graded failure this test exists for: after an undo the render arrays
   * hold the stream rect while the worker's QuadTree still holds the edited
   * one, so a click on the box misses and a click on empty space hits.
   */
  it('tells the worker about commit, undo and redo', async () => {
    clean()
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 40 && s.nodes.count === 0; i++) await vi.advanceTimersByTimeAsync(50)
      expect(s.nodes.count).toBeGreaterThan(0)

      const id = s.nodes.ids[0]
      const from = { ...s.rectOf(id)! }
      const to = { x: 999, y: 998, w: 10, h: 10 }

      // The cull grid is the main-thread half of the same seam: `updateNode`
      // keeps the worker's QuadTree honest, `grid.move` keeps the draw loop's
      // culling honest. Assert the entry actually relocates and comes back.
      const idx = indexOfId(s.nodes, id)
      const out = new Uint32Array(4096)
      const inGrid = (r: Rect) => {
        const n = s.grid.query(r.x, r.y, r.w, r.h, out)
        for (let i = 0; i < n; i++) if (out[i] === idx) return true
        return false
      }
      expect(inGrid(from)).toBe(true)
      expect(inGrid(to)).toBe(false)

      commit('editBox', (d) => {
        d.edits[id] = { rect: to }
        d.dirtyAt[id] = Date.now()
      })
      expect(workerUpdates()).toEqual([{ nodeId: id, old: from, next: to }])
      expect(inGrid(to)).toBe(true)

      undo()
      expect(workerUpdates()[1]).toEqual({ nodeId: id, old: to, next: from })
      expect(inGrid(to)).toBe(false)
      expect(inGrid(from)).toBe(true)

      redo()
      expect(workerUpdates()[2]).toEqual({ nodeId: id, old: from, next: to })

      s.dispose()
    } finally {
      vi.useRealTimers()
      clean()
    }
  })

  it('sends nothing when a commit does not move the box', async () => {
    clean()
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 40 && s.nodes.count === 0; i++) await vi.advanceTimersByTimeAsync(50)
      const id = s.nodes.ids[0]
      const same = { ...s.rectOf(id)! }

      commit('editBox', (d) => {
        d.edits[id] = { rect: same }
        d.dirtyAt[id] = Date.now()
      })

      // Re-selecting or re-committing identical geometry must not churn the
      // index: a remove+insert per no-op edit is how a QuadTree loses entries.
      expect(workerUpdates()).toEqual([])
      s.dispose()
    } finally {
      vi.useRealTimers()
      clean()
    }
  })
})

describe('table detection', () => {
  it('finds the cells of the table under a cell node, and nothing under a line', async () => {
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(8, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 60 && !s.status.done; i++) await vi.advanceTimersByTimeAsync(50)

      // The synthetic generator emits table cells as NodeType.Cell children of
      // a Paragraph block; every even page carries a table with p=0.16.
      let cellIndex = -1
      for (let i = 0; i < s.nodes.count; i++) {
        if (s.nodes.types[i] === NodeType.Cell) {
          cellIndex = i
          break
        }
      }
      expect(cellIndex).toBeGreaterThanOrEqual(0)

      const snap = s.tableAt(s.nodes.ids[cellIndex])
      expect(snap).not.toBeNull()
      expect(snap!.tableId).toBe(s.nodes.parents[cellIndex])
      expect(snap!.cells.length).toBeGreaterThanOrEqual(12)
      // Picking the table's parent node resolves to the same table.
      expect(s.tableAt(snap!.tableId)!.tableId).toBe(snap!.tableId)

      let lineIndex = -1
      for (let i = 0; i < s.nodes.count; i++) {
        if (s.nodes.types[i] === NodeType.Line) {
          lineIndex = i
          break
        }
      }
      expect(lineIndex).toBeGreaterThanOrEqual(0)
      expect(s.tableAt(s.nodes.ids[lineIndex])).toBeNull()

      s.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('selecting the table tool does not throw on a document with no tables', async () => {
    const s = new Session(canvas(), createSyntheticDocument(1, 1))
    await s.ready
    s.setTool('table')
    expect(s.currentTool).toBe('table')
    s.dispose()
  })

  /**
   * The FUNSD case in miniature: adopting a node that is not part of any table
   * must leave the tool with no mesh instead of throwing or drawing a lie.
   */
  it('adopts nothing when the selected node is not a table cell', async () => {
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(8, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 60 && !s.status.done; i++) await vi.advanceTimersByTimeAsync(50)

      let lineIndex = -1
      for (let i = 0; i < s.nodes.count; i++) {
        if (s.nodes.types[i] === NodeType.Line) {
          lineIndex = i
          break
        }
      }
      expect(lineIndex).toBeGreaterThanOrEqual(0)
      useStore.setState({ selectedId: s.nodes.ids[lineIndex] })
      s.setTool('table')
      await Promise.resolve()
      expect(s.activeTool.name).toBe('table')
      expect((s.activeTool as { mesh?: unknown }).mesh ?? null).toBeNull()

      // A cell, by contrast, yields a mesh with at least one interior divider.
      let cellIndex = -1
      for (let i = 0; i < s.nodes.count; i++) {
        if (s.nodes.types[i] === NodeType.Cell) {
          cellIndex = i
          break
        }
      }
      expect(cellIndex).toBeGreaterThanOrEqual(0)
      useStore.setState({ selectedId: s.nodes.ids[cellIndex] })
      s.setTool('select')
      s.setTool('table')
      await Promise.resolve()
      const mesh = (s.activeTool as { mesh?: { cols: number[]; rows: number[] } | null }).mesh
      expect(mesh).not.toBeNull()
      expect(mesh!.cols.length).toBeGreaterThanOrEqual(4)
      expect(mesh!.rows.length).toBeGreaterThanOrEqual(5)

      s.dispose()
    } finally {
      vi.useRealTimers()
      useStore.setState({ selectedId: null })
    }
  })
})
