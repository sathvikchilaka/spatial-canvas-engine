/**
 * One extraction event. A page arrives either as a `url` the worker fetches
 * itself (the replay sources, which point at static assets) or as an inline
 * `payload` string pushed by a live feed. Exactly one of the two — the union
 * makes that a type error rather than a runtime surprise.
 */
export type StreamEvent =
  | { type: 'page'; pageIndex: number; url: string; payload?: undefined }
  | { type: 'page'; pageIndex: number; payload: string; url?: undefined }
  | { type: 'done' }

export interface StreamSource {
  start(onEvent: (e: StreamEvent) => void): void
  stop(): void
  readonly connected: boolean
}
