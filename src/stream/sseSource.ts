import type { StreamEvent, StreamSource } from './source'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000

/** EventSource client with exponential-backoff reconnect. */
export class SseStreamSource implements StreamSource {
  private es: EventSource | null = null
  private attempt = 0
  private stopped = false
  private handler: ((e: StreamEvent) => void) | null = null
  private retryTimer = 0
  private readonly url: string
  private readonly onStatus?: (connected: boolean) => void

  constructor(url = '/events', onStatus?: (connected: boolean) => void) {
    this.url = url
    this.onStatus = onStatus
  }

  get connected(): boolean {
    return this.es?.readyState === 1
  }

  start(onEvent: (e: StreamEvent) => void): void {
    this.handler = onEvent
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retryTimer = 0
    this.es?.close()
    this.es = null
    this.onStatus?.(false)
  }

  private open() {
    if (this.stopped) return
    const es = new EventSource(this.url)
    this.es = es
    es.onopen = () => {
      this.attempt = 0
      this.onStatus?.(true)
    }
    es.onmessage = (ev) => {
      try {
        this.handler?.(JSON.parse(ev.data) as StreamEvent)
      } catch {
        // Malformed payload: drop it. One bad page never poisons the document.
      }
    }
    es.onerror = () => {
      es.close()
      this.es = null
      this.onStatus?.(false)
      if (this.stopped) return
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt++)
      this.retryTimer = setTimeout(() => this.open(), delay) as unknown as number
    }
  }
}

/** Probes the endpoint; falls back to the in-app emitter when it is absent. */
export async function createStreamSource(opts?: {
  forceMock?: boolean
  pageCount?: number
  seed?: number
  url?: string
  onStatus?: (connected: boolean) => void
}): Promise<StreamSource> {
  const { MockStreamSource } = await import('./mockSource')
  const pageCount = opts?.pageCount ?? 100
  if (opts?.forceMock) return new MockStreamSource(pageCount, opts?.seed ?? 1)
  const url = opts?.url ?? '/events'
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 300)
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    clearTimeout(t)
    if (res.ok) return new SseStreamSource(url, opts?.onStatus)
  } catch {
    // endpoint absent — fall through
  }
  return new MockStreamSource(pageCount, opts?.seed ?? 1)
}
