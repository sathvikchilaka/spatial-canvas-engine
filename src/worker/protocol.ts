import type { Rect } from '@/data/nodes'

export type SerializedNode = {
  id: number
  page: number
  x: number
  y: number
  w: number
  h: number
  type: number
  parent: number
  order: number
}

export type SerializedPage = { pageIndex: number; nodes: SerializedNode[] }

export type Req = { id: number } & (
  | { kind: 'init'; bounds: Rect }
  | { kind: 'ingestPage'; page: SerializedPage }
  | { kind: 'ingestUrl'; pageIndex: number; url: string; offsetX: number; offsetY: number }
  | { kind: 'hitTest'; x: number; y: number }
  | { kind: 'queryRect'; x: number; y: number; w: number; h: number }
  | { kind: 'updateNode'; nodeId: number; old: Rect; next: Rect }
  | { kind: 'reset' }
)

export type PageIngested = {
  kind: 'pageIngested'
  pageIndex: number
  ids: Uint32Array
  coords: Float32Array
  types: Uint8Array
  parents: Int32Array
  order: Int32Array
  edges: Int32Array
}

export type Res = { id: number } & (
  | { kind: 'ready' }
  | PageIngested
  | { kind: 'hit'; nodeId: number | null }
  | { kind: 'rect'; ids: Uint32Array }
  | { kind: 'ok' }
  | { kind: 'error'; message: string }
)

/** Unsolicited messages (worker → main, not answering a request) carry this id. */
export const UNSOLICITED = -1
