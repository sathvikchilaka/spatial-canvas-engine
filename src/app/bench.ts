import { zoomAt } from '@/engine/viewport'
import type { Session } from './session'

export type BenchResult = {
  frames: number
  seconds: number
  fps: number
  draw: { p50: number; p95: number; max: number }
  avg: { pages: number; cull: number; boxes: number; overlays: number }
  visible: { avg: number; min: number; max: number }
  /** Frames where the cull hit its cap and dropped in-view boxes. */
  truncatedFrames: number
  pageRasters: number
  longTasks: { count: number; total: number; max: number }
  pointerMoves: number
}

export type BenchOptions = {
  ms?: number
  /** Pan half-amplitude in CSS px. Oscillates, so the viewport stays over content. */
  amplitude?: number
  /** Also dispatch pointermove on the canvas, exercising hover picks + React. */
  hover?: boolean
  /** Bypass culling and draw every node — the 10k-boxes-in-one-frame worst case. */
  stress?: boolean
  /**
   * Also oscillate scale via `zoomAt` about the canvas centre — the real
   * zoom-to-cursor path, not a synthetic scale write. `zoomRange` is how far
   * the scale swings either side of the start (e.g. 2 → between start/2 and
   * start*2), covering the raster-threshold crossing pan alone never hits.
   */
  zoom?: boolean
  zoomRange?: number
}

/**
 * Scripted pan bench. Oscillates around the current viewport so it never
 * drifts off the document (a drifted bench reports 60 FPS on blank canvas),
 * and reports the per-frame cost breakdown plus main-thread long tasks —
 * a frame counter alone cannot say which layer or which thread is at fault.
 */
export function benchPan(session: Session, opts: BenchOptions | number = {}): Promise<BenchResult> {
  const {
    ms = 5000,
    amplitude = 400,
    hover = false,
    stress = false,
    zoom = false,
    zoomRange = 2,
  } = typeof opts === 'number' ? { ms: opts } : opts

  const engine = session.engine
  const canvas = engine.canvasEl
  const draws: number[] = []
  const sums = { pages: 0, cull: 0, boxes: 0, overlays: 0, visible: 0 }
  let truncated = 0
  let visMin = Infinity
  let visMax = 0
  const rasters0 = engine.pageCache.rasters
  let pointerMoves = 0

  const long = { count: 0, total: 0, max: 0 }
  let po: PerformanceObserver | null = null
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        long.count++
        long.total += e.duration
        if (e.duration > long.max) long.max = e.duration
      }
    })
    po.observe({ entryTypes: ['longtask'] })
  } catch {
    po = null // Safari/Firefox: no longtask entries.
  }

  const off = engine.onFrame(() => {
    const p = engine.perf
    draws.push(p.total)
    sums.pages += p.pages
    sums.cull += p.cull
    sums.boxes += p.boxes
    sums.overlays += p.overlays
    sums.visible += p.visible
    if (p.visible < visMin) visMin = p.visible
    if (p.visible > visMax) visMax = p.visible
    if (p.culledOut) truncated++
  })

  engine.cullDisabled = stress
  const start = engine.viewport
  const rect = canvas.getBoundingClientRect()
  const t0 = performance.now()

  return new Promise((resolve) => {
    const step = () => {
      const t = performance.now() - t0
      // Two out-of-phase sines: motion in both axes, always returning to start.
      const phase = (t / 1000) * Math.PI
      if (zoom) {
        // Log-space sine so the swing is symmetric in scale (start/zoomRange
        // .. start*zoomRange), not skewed toward one side. `zoomAt` is
        // multiplicative and stateful, so drive it off the *current* scale
        // rather than integrating drift frame to frame.
        const targetScale = start.scale * Math.pow(zoomRange, Math.sin(phase * 0.5))
        const cx = rect.width / 2
        const cy = rect.height / 2
        const factor = targetScale / engine.viewport.scale
        const zoomed = zoomAt(engine.viewport, cx, cy, factor)
        engine.setViewport({
          scale: zoomed.scale,
          tx: start.tx + Math.sin(phase) * amplitude,
          ty: start.ty + Math.sin(phase * 0.7) * amplitude,
        })
      } else {
        engine.setViewport({
          scale: start.scale,
          tx: start.tx + Math.sin(phase) * amplitude,
          ty: start.ty + Math.sin(phase * 0.7) * amplitude,
        })
      }

      if (hover) {
        pointerMoves++
        canvas.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            clientX: rect.left + rect.width * (0.5 + 0.25 * Math.sin(phase * 1.3)),
            clientY: rect.top + rect.height * (0.5 + 0.25 * Math.cos(phase * 1.1)),
          }),
        )
      }

      if (t < ms) {
        requestAnimationFrame(step)
        return
      }

      off()
      po?.disconnect()
      engine.cullDisabled = false
      engine.setViewport(start)
      const seconds = (performance.now() - t0) / 1000
      const n = Math.max(1, draws.length)
      const sorted = draws.slice().sort((a, b) => a - b)
      const r2 = (v: number) => Math.round(v * 100) / 100
      resolve({
        frames: draws.length,
        seconds: r2(seconds),
        fps: r2(draws.length / seconds),
        draw: {
          p50: r2(sorted[n >> 1] ?? 0),
          p95: r2(sorted[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0),
          max: r2(sorted[n - 1] ?? 0),
        },
        avg: {
          pages: r2(sums.pages / n),
          cull: r2(sums.cull / n),
          boxes: r2(sums.boxes / n),
          overlays: r2(sums.overlays / n),
        },
        visible: {
          avg: Math.round(sums.visible / n),
          min: visMin === Infinity ? 0 : visMin,
          max: visMax,
        },
        truncatedFrames: truncated,
        pageRasters: engine.pageCache.rasters - rasters0,
        longTasks: { count: long.count, total: r2(long.total), max: r2(long.max) },
        pointerMoves,
      })
    }
    requestAnimationFrame(step)
  })
}

export type PickResult = {
  samples: number
  /** Worker round-trip only: postMessage → reply. */
  worker: { p50: number; p95: number; max: number; over2ms: number }
  /** End-to-end: pointerdown dispatch → store selection changed. */
  endToEnd: { p50: number; p95: number; max: number; over2ms: number } | null
  /**
   * Why `endToEnd` has the sample count it does. A null `endToEnd` used to be
   * indistinguishable from a broken harness, which is exactly what it was:
   * `onScreen: 0` says the candidates were never clickable, `timedOut` says the
   * clicks landed but no selection followed.
   */
  e2e: { candidates: number; onScreen: number; timedOut: number; measured: number }
  hits: number
  nodes: number
}

const pct = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0) * 100) / 100

/**
 * Click → selection latency. Samples box centres, so every pick is a real hit;
 * random empty space would measure the cheap miss path and flatter the numbers.
 *
 * `endToEnd` dispatches a real pointerdown and stops when the store's selection
 * changes — that is the number the "< 2ms click-to-selection" budget names. The
 * `worker` figure isolates the round-trip from tool and React overhead.
 */
export async function benchPick(session: Session, samples = 200, endToEnd = true): Promise<PickResult> {
  const nodes = session.nodes
  const engine = session.engine
  const canvas = engine.canvasEl
  const rect = canvas.getBoundingClientRect()
  const workerMs: number[] = []
  const e2eMs: number[] = []
  let hits = 0
  let e2eCandidates = 0
  let e2eOnScreen = 0
  let e2eTimedOut = 0

  const step = Math.max(1, Math.floor(nodes.count / samples))

  for (let i = 0; i < nodes.count && workerMs.length < samples; i += step) {
    const c = i * 4
    const wx = nodes.coords[c] + nodes.coords[c + 2] / 2
    const wy = nodes.coords[c + 1] + nodes.coords[c + 3] / 2

    const t0 = performance.now()
    const id = await session.worker.hitTest(wx, wy)
    workerMs.push(performance.now() - t0)
    if (id !== null) hits++
  }

  if (endToEnd) {
    const { useStore } = await import('@/store/store')
    // Candidates come from the culled draw list, not from an index stride over
    // the whole document. Striding by index and then filtering on "is it on
    // screen" collected *zero* samples on the contact-sheet layout — at 0.35
    // zoom none of those 50 particular nodes was in the viewport, so every
    // candidate was skipped and `endToEnd` silently reported null. These are
    // the nodes the draw loop just rendered, so they are on screen by
    // construction.
    const visible = engine.lastVisible
    e2eCandidates = visible.count
    const want = Math.min(50, samples)
    const vStep = Math.max(1, Math.floor(visible.count / want))
    for (let v = 0; v < visible.count && e2eMs.length < want; v += vStep) {
      const i = visible.indices[v]
      const c = i * 4
      const vp = engine.viewport
      // Click the centre of the box's intersection with the canvas, not the
      // box's own centre. The cull keeps boxes whose *bounds* overlap the
      // viewport, so a box larger than the canvas or straddling its edge has
      // an off-screen centre — on the stress document the first visible box is
      // 1060x170 at scale 1, centred 92px above the canvas. Using the box
      // centre discarded those samples (and made the same click miss entirely
      // in the e2e suite); the intersection centre is inside the box and on
      // screen by construction.
      const x0 = Math.max(0, nodes.coords[c] * vp.scale + vp.tx)
      const y0 = Math.max(0, nodes.coords[c + 1] * vp.scale + vp.ty)
      const x1 = Math.min(rect.width, (nodes.coords[c] + nodes.coords[c + 2]) * vp.scale + vp.tx)
      const y1 = Math.min(rect.height, (nodes.coords[c + 1] + nodes.coords[c + 3]) * vp.scale + vp.ty)
      if (x1 <= x0 || y1 <= y0) continue
      const sx = (x0 + x1) / 2
      const sy = (y0 + y1) / 2
      e2eOnScreen++

      // Clear the selection first, or this measures the wrong gesture.
      // `SelectTool.onPointerDown` hit-tests the *currently selected* rect
      // before anything else and, on a hit, enters its drag phase and returns
      // without ever calling `pick`. Sampling adjacent boxes means the next
      // click often lands inside the box just selected, so it became a drag,
      // no selection change followed, and the sample timed out — 16 of 53
      // dropped that way, and the survivors skewed the percentiles.
      if (useStore.getState().selectedId !== null) {
        useStore.setState({ selectedId: null })
      }

      const t0 = performance.now()
      const settled = new Promise<number>((resolve) => {
        const off = useStore.subscribe((s, p) => {
          if (s.selectedId !== p.selectedId) {
            off()
            resolve(performance.now() - t0)
          }
        })
        setTimeout(() => {
          off()
          resolve(-1)
        }, 250)
      })
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: rect.left + sx,
          clientY: rect.top + sy,
        }),
      )
      canvas.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          clientX: rect.left + sx,
          clientY: rect.top + sy,
        }),
      )
      const ms = await settled
      if (ms >= 0) e2eMs.push(ms)
      else e2eTimedOut++
    }
  }

  const w = workerMs.slice().sort((a, b) => a - b)
  const e = e2eMs.slice().sort((a, b) => a - b)
  return {
    samples: workerMs.length,
    worker: {
      p50: pct(w, 0.5),
      p95: pct(w, 0.95),
      max: pct(w, 1),
      over2ms: workerMs.filter((v) => v > 2).length,
    },
    endToEnd: e.length
      ? { p50: pct(e, 0.5), p95: pct(e, 0.95), max: pct(e, 1), over2ms: e2eMs.filter((v) => v > 2).length }
      : null,
    e2e: {
      candidates: e2eCandidates,
      onScreen: e2eOnScreen,
      timedOut: e2eTimedOut,
      measured: e2eMs.length,
    },
    hits,
    nodes: nodes.count,
  }
}
