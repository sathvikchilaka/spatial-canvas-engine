/** Shared geometry type, in world units. */
export type Rect = { x: number; y: number; w: number; h: number }

export enum NodeType {
  Paragraph = 0,
  Line = 1,
  Cell = 2,
  KeyValue = 3,
  Figure = 4,
}

export const FLAG_DIRTY = 1
export const FLAG_SELECTED = 2
export const FLAG_HIDDEN = 4

export type NodeArrays = {
  count: number
  capacity: number
  /** x, y, w, h per node at offset i * 4 */
  coords: Float32Array
  ids: Uint32Array
  pages: Uint16Array
  types: Uint8Array
  parents: Int32Array
  /** reading-order index, -1 if none */
  order: Int32Array
  flags: Uint8Array
  /** lazily built id → index, invalidated on push */
  _index?: Map<number, number> | null
}

export type NodeInit = {
  id: number
  page: number
  x: number
  y: number
  w: number
  h: number
  type: NodeType
  parent: number
  order: number
}

export function createNodeArrays(capacity: number): NodeArrays {
  return {
    count: 0,
    capacity,
    coords: new Float32Array(capacity * 4),
    ids: new Uint32Array(capacity),
    pages: new Uint16Array(capacity),
    types: new Uint8Array(capacity),
    parents: new Int32Array(capacity),
    order: new Int32Array(capacity),
    flags: new Uint8Array(capacity),
    _index: null,
  }
}

function grow(a: NodeArrays, min: number) {
  let cap = a.capacity || 1
  while (cap < min) cap *= 2
  const coords = new Float32Array(cap * 4); coords.set(a.coords)
  const ids = new Uint32Array(cap); ids.set(a.ids)
  const pages = new Uint16Array(cap); pages.set(a.pages)
  const types = new Uint8Array(cap); types.set(a.types)
  const parents = new Int32Array(cap); parents.set(a.parents)
  const order = new Int32Array(cap); order.set(a.order)
  const flags = new Uint8Array(cap); flags.set(a.flags)
  a.coords = coords; a.ids = ids; a.pages = pages; a.types = types
  a.parents = parents; a.order = order; a.flags = flags
  a.capacity = cap
}

/** Appends a node, growing 2× when full. Returns its index. */
export function pushNode(a: NodeArrays, n: NodeInit): number {
  if (a.count >= a.capacity) grow(a, a.count + 1)
  const i = a.count++
  const c = i * 4
  a.coords[c] = n.x
  a.coords[c + 1] = n.y
  a.coords[c + 2] = n.w
  a.coords[c + 3] = n.h
  a.ids[i] = n.id
  a.pages[i] = n.page
  a.types[i] = n.type
  a.parents[i] = n.parent
  a.order[i] = n.order
  a.flags[i] = 0
  a._index = null
  return i
}

/** Writes x, y, w, h of node `i` into `out`. Allocation-free. */
export function getRect(a: NodeArrays, i: number, out: Float32Array): void {
  const c = i * 4
  out[0] = a.coords[c]
  out[1] = a.coords[c + 1]
  out[2] = a.coords[c + 2]
  out[3] = a.coords[c + 3]
}

/**
 * id → index via a cached map. A linear scan over 10k nodes on every click
 * would eat the 2ms selection budget.
 */
export function indexOfId(a: NodeArrays, id: number): number {
  let map = a._index
  if (!map) {
    map = new Map<number, number>()
    for (let i = 0; i < a.count; i++) map.set(a.ids[i], i)
    a._index = map
  }
  const i = map.get(id)
  return i === undefined ? -1 : i
}

/** Backing buffers, for postMessage's transfer list. */
export function transferables(a: NodeArrays): ArrayBuffer[] {
  return [
    a.coords.buffer, a.ids.buffer, a.pages.buffer, a.types.buffer,
    a.parents.buffer, a.order.buffer, a.flags.buffer,
  ] as ArrayBuffer[]
}
