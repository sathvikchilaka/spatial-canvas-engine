/// <reference lib="webworker" />
import { createNodeArrays, pushNode, type NodeArrays, type NodeType, type Rect } from '@/data/nodes'
import { QuadTree } from './quadtree'
import { UNSOLICITED, type Req, type Res, type SerializedPage } from './protocol'

const WORLD: Rect = { x: -10000, y: -10000, w: 100000, h: 4000000 }

let tree = new QuadTree(WORLD)
let nodes: NodeArrays = createNodeArrays(1024)
/** id → index into `nodes`, so hit results can resolve their geometry. */
const indexById = new Map<number, number>()
const scratch: number[] = []

function reset(bounds: Rect = WORLD) {
  tree = new QuadTree(bounds)
  nodes = createNodeArrays(1024)
  indexById.clear()
}

function ingest(page: SerializedPage) {
  const start = nodes.count
  for (const n of page.nodes) {
    const i = pushNode(nodes, {
      id: n.id, page: n.page, x: n.x, y: n.y, w: n.w, h: n.h,
      type: n.type as NodeType, parent: n.parent, order: n.order,
    })
    indexById.set(n.id, i)
    tree.insert(n.id, n.x, n.y, n.w, n.h)
  }
  const count = nodes.count - start
  // Slice out this page's rows and transfer them — cloning 10k objects would
  // itself blow the 16ms ingestion budget.
  const ids = nodes.ids.slice(start, nodes.count)
  const coords = nodes.coords.slice(start * 4, nodes.count * 4)
  const types = nodes.types.slice(start, nodes.count)
  const parents = nodes.parents.slice(start, nodes.count)
  const order = nodes.order.slice(start, nodes.count)
  void count
  const res: Res = {
    id: UNSOLICITED, kind: 'pageIngested', pageIndex: page.pageIndex,
    ids, coords, types, parents, order,
  }
  ;(self as unknown as Worker).postMessage(res, [
    ids.buffer, coords.buffer, types.buffer, parents.buffer, order.buffer,
  ] as Transferable[])
}

/** Topmost hit: smallest area wins, ties broken by later reading order. */
function hitTest(x: number, y: number): number | null {
  tree.queryPoint(x, y, scratch)
  let best = -1
  let bestArea = Infinity
  let bestOrder = -Infinity
  for (let k = 0; k < scratch.length; k++) {
    const id = scratch[k]
    const i = indexById.get(id)
    if (i === undefined) continue
    const c = i * 4
    const area = nodes.coords[c + 2] * nodes.coords[c + 3]
    const ord = nodes.order[i]
    if (area < bestArea || (area === bestArea && ord > bestOrder)) {
      best = id
      bestArea = area
      bestOrder = ord
    }
  }
  return best === -1 ? null : best
}

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data
  const reply = (r: Res, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(r, transfer ?? [])
  try {
    switch (msg.kind) {
      case 'init':
        reset(msg.bounds)
        reply({ id: msg.id, kind: 'ready' })
        break
      case 'reset':
        reset()
        reply({ id: msg.id, kind: 'ok' })
        break
      case 'ingestPage':
        ingest(msg.page)
        break
      case 'hitTest':
        reply({ id: msg.id, kind: 'hit', nodeId: hitTest(msg.x, msg.y) })
        break
      case 'queryRect': {
        tree.queryRect(msg.x, msg.y, msg.w, msg.h, scratch)
        const ids = Uint32Array.from(scratch)
        reply({ id: msg.id, kind: 'rect', ids }, [ids.buffer as Transferable])
        break
      }
      case 'updateNode': {
        const { old, next } = msg
        tree.update(msg.nodeId, old.x, old.y, old.w, old.h, next.x, next.y, next.w, next.h)
        const i = indexById.get(msg.nodeId)
        if (i !== undefined) {
          const c = i * 4
          nodes.coords[c] = next.x
          nodes.coords[c + 1] = next.y
          nodes.coords[c + 2] = next.w
          nodes.coords[c + 3] = next.h
        }
        reply({ id: msg.id, kind: 'ok' })
        break
      }
    }
  } catch (err) {
    // One bad payload must never poison the document.
    reply({ id: msg.id, kind: 'error', message: (err as Error).message })
  }
}
