// Dev SSE endpoint. Pushes real FUNSD annotation payloads inline, shuffled and
// jittered so arrival is guaranteed out of order — which is the whole point of
// the exercise. The client forwards each body to the worker unparsed, so the
// wire shape is deliberately just an envelope around the corpus's own JSON.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public', 'funsd')
const PORT = Number(process.env.SSE_PORT ?? 8787)
const SEED = Number(process.env.SSE_SEED ?? 1)

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A deterministic permutation of [0, count). */
export function shuffledPages(count, seed) {
  const rnd = mulberry32(seed || 1)
  const a = Array.from({ length: count }, (_, i) => i)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * One SSE frame. `d` holds the page body as a JSON *string*, so
 * `JSON.stringify` escapes every newline for us — a literal newline in a data
 * line would terminate the event early and silently truncate the page.
 */
export function envelope(pageIndex, body) {
  return `data: ${JSON.stringify({ t: 'p', i: pageIndex, d: body })}\n\n`
}

async function loadManifest() {
  try {
    const raw = await readFile(path.join(PUBLIC, 'manifest.json'), 'utf8')
    return JSON.parse(raw).pages
  } catch {
    console.error('funsd manifest missing — run `pnpm prepare:funsd`')
    process.exit(1)
  }
}

async function main() {
  const pages = await loadManifest()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname !== '/events') {
      res.writeHead(404).end()
      return
    }

    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      // The client refuses to adopt a feed that disagrees with the document's
      // page count — a short feed would silently drop pages.
      'X-Page-Count': String(pages.length),
      'Access-Control-Expose-Headers': 'X-Page-Count',
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }

    const timers = []
    let closed = false
    req.on('close', () => {
      closed = true
      // Without this the process accumulates timers for every disconnected client.
      for (const id of timers) clearTimeout(id)
    })

    let t = 0
    for (const pageIndex of shuffledPages(pages.length, SEED)) {
      t += 20 + Math.floor(Math.random() * 100)
      timers.push(
        setTimeout(async () => {
          if (closed) return
          try {
            const body = await readFile(path.join(PUBLIC, 'annotations', `${pages[pageIndex].id}.json`), 'utf8')
            res.write(envelope(pageIndex, body))
          } catch (err) {
            // One unreadable page must not end the feed.
            console.warn(`page ${pageIndex} unreadable:`, err.message)
          }
        }, t),
      )
    }
    timers.push(setTimeout(() => !closed && res.write(`data: ${JSON.stringify({ t: 'd' })}\n\n`), t + 200))
  })

  server.listen(PORT, () => {
    console.log(`SSE dev endpoint on http://localhost:${PORT}/events (${pages.length} pages)`)
  })
}

// Only start the server when run directly — importing this module (e.g. from
// tests, for the pure `envelope`/`shuffledPages` helpers) must not bind a port.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
