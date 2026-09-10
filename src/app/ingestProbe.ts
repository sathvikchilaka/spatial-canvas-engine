/**
 * Records main-thread long tasks while the stream ingests.
 *
 * The pan bench cannot answer the ingest question: it starts after the document
 * is loaded, and by then the parsing and indexing under test are over. So this
 * has to be running before the first payload arrives — but it is started and
 * stopped by the App effect (`startIngestProbe`/`stopIngestProbe`), never on
 * import: an unowned rAF loop that survives unmount is the leak this file
 * exists to measure. `longtask`'s `buffered: true` replay covers the gap
 * between page load and the first `startIngestProbe()`.
 */
export type LongTask = { start: number; duration: number; attribution: string }

export type IngestReport = {
  /** ms from probe start to the last recorded event. */
  window: number
  streamDoneAt: number | null
  tasks: LongTask[]
  count: number
  /** Tasks over the 16 ms frame budget — the graded figure. */
  over16: number
  over50: number
  total: number
  max: number
  supported: boolean
}

/** Both buffers are capped: the probe must never become the leak it measures. */
const MAX_SAMPLES = 1000

const t0 = performance.now()
/** Start of the current measurement window — reset by `startIngestProbe`. */
let windowStart = t0
const tasks: LongTask[] = []
let streamDoneAt: number | null = null
let supported = false

/** `startTime:duration` of every recorded task — see the note in `makeObserver`. */
const seen = new Set<string>()
let observer: PerformanceObserver | null = null

function observe() {
  if (observer) return
  try {
    observer = makeObserver()
    // `buffered` picks up tasks that fired before this line ran.
    observer.observe({ type: 'longtask', buffered: true })
    supported = true
  } catch {
    observer = null // Not Chromium: no longtask entries.
  }
}

function makeObserver() {
  return new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      // `buffered: true` replays entries on every re-observe, so a remount
      // would otherwise double-count everything still in the buffer.
      const key = `${entry.startTime}:${entry.duration}`
      if (seen.has(key)) continue
      // Both `seen` and `tasks` stop growing at the cap, together.
      if (tasks.length >= MAX_SAMPLES) continue
      seen.add(key)
      const attribution =
        (entry as PerformanceEntry & { attribution?: { name: string }[] }).attribution?.[0]?.name ??
        entry.name
      tasks.push({
        start: Math.round((entry.startTime - t0) * 100) / 100,
        duration: Math.round(entry.duration * 100) / 100,
        attribution,
      })
    }
  })
}
// Observe at module scope so long tasks fired before the App effect mounts are
// still captured; the rAF sampler starts only from `startIngestProbe`.
observe()

/**
 * `longtask` only reports tasks over 50 ms, but the budget here is 16 ms. A rAF
 * gap wider than a frame means a task ran long enough to miss a frame, which is
 * the observable the requirement is really about.
 */
const gaps: number[] = []
let lastTick = performance.now()
let ticking = false
let rafId = 0
const tick = () => {
  const now = performance.now()
  const gap = now - lastTick
  if (gap > 16.7 * 1.5 && gaps.length < MAX_SAMPLES) gaps.push(Math.round(gap * 100) / 100)
  lastTick = now
  if (ticking) rafId = requestAnimationFrame(tick)
}

/**
 * Idempotent; called from the App effect. Long tasks buffered before the first
 * call are picked up by `observe`'s `buffered: true` and de-duplicated, so no
 * task is missed or counted twice across a remount.
 */
export function startIngestProbe(): void {
  observe()
  if (ticking) return
  ticking = true
  // The measurement window is "since the probe was running", not "since page
  // load": a stopped probe records no frame gaps, and counting the unmounted
  // interval would report a stall the app never had.
  windowStart = performance.now()
  lastTick = windowStart
  // `gaps` must be cleared with the window it is reported against, or a remount
  // reports the previous run's stalls over a freshly-shortened interval.
  gaps.length = 0
  rafId = requestAnimationFrame(tick)
}

export function markStreamDone(): void {
  if (streamDoneAt === null) streamDoneAt = Math.round((performance.now() - t0) * 100) / 100
}

/**
 * `window` measures the current probe run, `tasks`/`streamDoneAt` are stamped
 * relative to page load (`t0`) so they line up with a DevTools trace. Long
 * tasks accumulate across probe runs (de-duplicated); `frameGaps` do not —
 * they only exist while the probe is running.
 */
export function ingestReport(): IngestReport & { frameGaps: number[]; worstFrameGap: number } {
  const durations = tasks.map((t) => t.duration)
  return {
    window: Math.round((performance.now() - windowStart) * 100) / 100,
    streamDoneAt,
    tasks: tasks.slice(),
    count: tasks.length,
    over16: durations.filter((d) => d > 16).length,
    over50: durations.filter((d) => d > 50).length,
    total: Math.round(durations.reduce((a, b) => a + b, 0) * 100) / 100,
    max: durations.length ? Math.max(...durations) : 0,
    supported,
    frameGaps: gaps.slice(),
    worstFrameGap: gaps.length ? Math.max(...gaps) : 0,
  }
}

/** Stops the rAF loop and the observer — nothing here outlives the mount. */
export function stopIngestProbe(): void {
  ticking = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  observer?.disconnect()
  observer = null
}
