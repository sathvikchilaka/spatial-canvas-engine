// Dev SSE endpoint. Emits generated pages shuffled and jittered so arrival is
// guaranteed out of order, which is the whole point of the exercise.
import http from 'node:http'

const PORT = Number(process.env.SSE_PORT ?? 8787)
const PAGE_COUNT = Number(process.env.SSE_PAGES ?? 100)
const SEED = Number(process.env.SSE_SEED ?? 1)

const PAGE_W = 1240
const PAGE_H = 1754
const PAGE_GAP = 40
const MARGIN = 90
const CONTENT_W = PAGE_W - MARGIN * 2
const LINE_H = 18

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A deliberately noisier take on the same layout: this is the "model output"
 * the human is repairing, so its boxes are close to but not identical to the
 * client's own generation.
 */
function pageNodes(pageIndex) {
  const rnd = mulberry32(Math.imul(SEED, 73856093) ^ Math.imul(pageIndex, 19349663))
  const oy = pageIndex * (PAGE_H + PAGE_GAP)
  const nodes = []
  let id = pageIndex * 1000 + 1
  let order = 0
  let y = MARGIN
  while (y < PAGE_H - MARGIN - 60) {
    const lines = 6 + Math.floor(rnd() * 9)
    const h = lines * LINE_H
    if (y + h > PAGE_H - MARGIN) break
    const parent = id
    nodes.push({
      id: id++, page: pageIndex, x: MARGIN, y: oy + y, w: CONTENT_W, h,
      type: 0, parent: -1, order: order++,
    })
    for (let i = 0; i < lines; i++) {
      const last = i === lines - 1
      // Sub-pixel jitter — the kind of drift a reviewer is there to fix.
      const jitter = (rnd() - 0.5) * 3
      nodes.push({
        id: id++, page: pageIndex,
        x: MARGIN + jitter,
        y: oy + y + i * LINE_H,
        w: CONTENT_W * (last ? 0.4 + rnd() * 0.5 : 0.92 + rnd() * 0.08),
        h: LINE_H - 5,
        type: 1, parent, order: order++,
      })
    }
    y += h + 18
  }
  return nodes
}

function shuffled(count, seed) {
  const rnd = mulberry32(seed || 1)
  const a = Array.from({ length: count }, (_, i) => i)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname !== '/events') {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const order = shuffled(PAGE_COUNT, SEED)
  const timers = []
  let t = 0
  for (const pageIndex of order) {
    t += 20 + Math.floor(Math.random() * 100)
    timers.push(
      setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({ type: 'page', pageIndex, nodes: pageNodes(pageIndex) })}\n\n`,
        )
      }, t),
    )
  }
  timers.push(setTimeout(() => res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`), t + 50))

  // Without this the process accumulates timers for every disconnected client.
  req.on('close', () => {
    for (const id of timers) clearTimeout(id)
  })
})

server.listen(PORT, () => {
  console.log(`SSE dev endpoint on http://localhost:${PORT}/events`)
})
