import type { SerializedNode } from '@/worker/protocol'

export type StreamEvent =
  | { type: 'page'; pageIndex: number; nodes: SerializedNode[] }
  | { type: 'done' }

export interface StreamSource {
  start(onEvent: (e: StreamEvent) => void): void
  stop(): void
  readonly connected: boolean
}
