export type StreamEvent =
  | { type: 'page'; pageIndex: number; url: string }
  | { type: 'done' }

export interface StreamSource {
  start(onEvent: (e: StreamEvent) => void): void
  stop(): void
  readonly connected: boolean
}
