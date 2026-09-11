import { shuffledPages } from './mockSource'
import type { StreamEvent, StreamSource } from './source'

/** Replays the corpus out of order, as a live extraction feed would arrive. */
export class FunsdStreamSource implements StreamSource {
  private timers: number[] = []
  private stopped = false
  private readonly ids: string[]
  private readonly seed: number

  constructor(ids: string[], seed = 1) {
    this.ids = ids
    this.seed = seed
  }

  get connected(): boolean {
    return !this.stopped
  }

  start(onEvent: (e: StreamEvent) => void): void {
    this.stopped = false
    let t = 0
    for (const pageIndex of shuffledPages(this.ids.length, this.seed)) {
      t += 8 + ((pageIndex * 37) % 40)
      this.timers.push(
        setTimeout(() => {
          if (this.stopped) return
          onEvent({
            type: 'page',
            pageIndex,
            url: `/funsd/annotations/${this.ids[pageIndex]}.json`,
          })
        }, t) as unknown as number,
      )
    }
    this.timers.push(
      setTimeout(() => {
        if (!this.stopped) onEvent({ type: 'done' })
      }, t + 40) as unknown as number,
    )
  }

  stop(): void {
    this.stopped = true
    for (const id of this.timers) clearTimeout(id)
    this.timers.length = 0
  }
}
