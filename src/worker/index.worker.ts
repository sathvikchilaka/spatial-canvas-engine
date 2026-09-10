/// <reference lib="webworker" />
import { createNodeArrays, pushNode, type NodeArrays, type NodeType, type Rect } from '@/data/nodes'
import { parseFunsdPage, type FunsdForm } from '@/data/funsd/parse'
import { serializeGeneratedPage } from '@/data/synthetic/serialize'
import { QuadTree } from './quadtree'
import { SemanticLabel, UNSOLICITED, type Req, type Res, type SerializedPage } from './protocol'

const SYNTHETIC = 'synthetic://page/'

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

function ingest(page: SerializedPage, edges: number[] = []) {
  const start = nodes.count
  for (const n of page.nodes) {
    const i = pushNode(nodes, {
      id: n.id, page: n.page, x: n.x, y: n.y, w: n.w, h: n.h,
      type: n.type as NodeType, parent: n.parent, order: n.order,
    })
    indexById.set(n.id, i)
    tree.insert(n.id, n.x, n.y, n.w, n.h)
  }
  // Slice out this page's rows and transfer them — cloning 10k objects would
  // itself blow the 16ms ingestion budget.
  const ids = nodes.ids.slice(start, nodes.count)
  const coords = nodes.coords.slice(start * 4, nodes.count * 4)
  const types = nodes.types.slice(start, nodes.count)
  const parents = nodes.parents.slice(start, nodes.count)
  const order = nodes.order.slice(start, nodes.count)
  const edgeArray = Int32Array.from(edges)
  const texts = new Array<string>(page.nodes.length)
  const labels = new Uint8Array(page.nodes.length)
  for (let i = 0; i < page.nodes.length; i++) {
    texts[i] = page.nodes[i].text ?? ''
    labels[i] = page.nodes[i].label ?? SemanticLabel.None
  }
  const res: Res = {
    id: UNSOLICITED, kind: 'pageIngested', pageIndex: page.pageIndex,
    ids, coords, types, parents, order, edges: edgeArray, texts, labels,
  }
  ;(self as unknown as Worker).postMessage(res, [
    ids.buffer, coords.buffer, types.buffer, parents.buffer, order.buffer, edgeArray.buffer,
    labels.buffer,
  ] as Transferable[])
}

/**
 * Parse one page's annotation JSON and publish the result. Shared by
 * `ingestUrl` (worker fetches the asset) and `ingestJson` (a live SSE event
 * pushed the body inline) so there is exactly one parser call site.
 */
function ingestForm(pageIndex: number, text: string, offsetX: number, offsetY: number) {
  const form = JSON.parse(text) as FunsdForm
  const { nodes: parsed, edges } = parseFunsdPage(form, pageIndex, offsetX, offsetY)
  ingest({ pageIndex, nodes: parsed }, edges)
}

/**
 * The whole point of the worker: annotation files are fetched, parsed and
 * indexed here. The main thread only ever sees transferable typed arrays.
 * An unknown/malformed URL or a failed fetch throws — the caller replies
 * with an `error` message rather than silently ingesting an empty page.
 */
async function ingestUrl(pageIndex: number, url: string, offsetX: number, offsetY: number) {
  if (url.startsWith(SYNTHETIC)) {
    const seed = Number(new URL(url).searchParams.get('seed') ?? 1)
    // Same contract as the FUNSD branch: the page's world origin comes from
    // the caller's PageGeometry, never from a layout formula duplicated here.
    ingest({ pageIndex, nodes: serializeGeneratedPage(pageIndex, seed, offsetX, offsetY) })
    return
  }
  if (!url.startsWith('/funsd/')) {
    throw new Error(`ingestUrl: unrecognized URL scheme "${url}"`)
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`funsd fetch failed: ${res.status}`)
  const text = await res.text()
  ingestForm(pageIndex, text, offsetX, offsetY)
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
      case 'ingestUrl':
        void ingestUrl(msg.pageIndex, msg.url, msg.offsetX, msg.offsetY).catch((err) =>
          reply({ id: UNSOLICITED, kind: 'error', message: (err as Error).message }),
        )
        break
      case 'ingestJson': {
        try {
          ingestForm(msg.pageIndex, msg.json, msg.offsetX, msg.offsetY)
          reply({ id: msg.id, kind: 'ok' })
        } catch (err) {
          // A single malformed event must not kill the worker — the other 198
          // pages are still coming.
          reply({ id: msg.id, kind: 'error', message: String((err as Error).message ?? err) })
        }
        break
      }
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
      case 'insertNode': {
        const n = msg.node
        // A node id can be re-inserted (redo of a creation, or unhiding a
        // merged-away cell): reuse its row rather than appending a duplicate.
        const existing = indexById.get(n.id)
        const i =
          existing ??
          pushNode(nodes, {
            id: n.id, page: n.page, x: n.x, y: n.y, w: n.w, h: n.h,
            type: n.type as NodeType, parent: n.parent, order: n.order,
          })
        if (existing !== undefined) {
          const c = existing * 4
          nodes.coords[c] = n.x
          nodes.coords[c + 1] = n.y
          nodes.coords[c + 2] = n.w
          nodes.coords[c + 3] = n.h
        }
        indexById.set(n.id, i)
        tree.insert(n.id, n.x, n.y, n.w, n.h)
        reply({ id: msg.id, kind: 'ok' })
        break
      }
      case 'removeNode': {
        // The row stays in `nodes` (indices are stable and referenced by
        // `indexById`); dropping it from the tree is what makes it unhittable.
        tree.remove(msg.nodeId, msg.rect.x, msg.rect.y, msg.rect.w, msg.rect.h)
        reply({ id: msg.id, kind: 'ok' })
        break
      }
    }
  } catch (err) {
    // One bad payload must never poison the document.
    reply({ id: msg.id, kind: 'error', message: (err as Error).message })
  }
}
