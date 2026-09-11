import type { Rect } from '@/data/nodes'

/**
 * The extraction's semantic label, as a small integer so it can ride a
 * `Uint8Array` across the seam. FUNSD's four classes plus `Word` for the
 * child word boxes and `None` for documents that carry no labels at all
 * (the synthetic stress corpus).
 */
export const SemanticLabel = {
  None: 0,
  Question: 1,
  Answer: 2,
  Header: 3,
  Other: 4,
  Word: 5,
} as const
export type SemanticLabel = (typeof SemanticLabel)[keyof typeof SemanticLabel]

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
  /** Extracted text, if the source has any. */
  text?: string
  label?: SemanticLabel
}

export type SerializedPage = { pageIndex: number; nodes: SerializedNode[] }

export type Req = { id: number } & (
  | { kind: 'init'; bounds: Rect }
  | { kind: 'ingestPage'; page: SerializedPage }
  | { kind: 'ingestUrl'; pageIndex: number; url: string; offsetX: number; offsetY: number }
  | { kind: 'ingestJson'; pageIndex: number; json: string; offsetX: number; offsetY: number }
  | { kind: 'hitTest'; x: number; y: number }
  | { kind: 'queryRect'; x: number; y: number; w: number; h: number }
  | { kind: 'updateNode'; nodeId: number; old: Rect; next: Rect }
  | { kind: 'insertNode'; node: SerializedNode }
  | { kind: 'removeNode'; nodeId: number; rect: Rect }
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
  /**
   * Text parallel to `ids`, `''` where the source has none. Strings cannot be
   * transferred, only structured-cloned — but one array of ≤536 short strings
   * per page is negligible beside the six typed arrays, and cloning it here is
   * what keeps `JSON.parse` off the main thread.
   */
  texts: string[]
  /** `SemanticLabel` parallel to `ids`. */
  labels: Uint8Array
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
