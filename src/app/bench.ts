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
}

/**
 * Scripted pan bench. Oscillates around the current viewport so it never
 * drifts off the document (a drifted bench reports 60 FPS on blank canvas),
 * and reports the per-frame cost breakdown plus main-thread long tasks —
 * a frame counter alone cannot say which layer or which thread is at fault.
 */
export function benchPan(session: Session, opts: BenchOptions | number = {}): Promise<BenchResult> {
  const { ms = 5000, amplitude = 400, hover = false, stress = false } =
    typeof opts === 'number' ? { ms: opts } : opts

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
      engine.setViewport({
        scale: start.scale,
        tx: start.tx + Math.sin(phase) * amplitude,
        ty: start.ty + Math.sin(phase * 0.7) * amplitude,
      })

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
    for (let i = 0; i < nodes.count && e2eMs.length < Math.min(50, samples); i += step * 4) {
      const c = i * 4
      const wx = nodes.coords[c] + nodes.coords[c + 2] / 2
      const wy = nodes.coords[c + 1] + nodes.coords[c + 3] / 2
      const vp = engine.viewport
      const sx = wx * vp.scale + vp.tx
      const sy = wy * vp.scale + vp.ty
      // Only measurable while the point is actually on screen.
      if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) continue

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
    hits,
    nodes: nodes.count,
  }
}
