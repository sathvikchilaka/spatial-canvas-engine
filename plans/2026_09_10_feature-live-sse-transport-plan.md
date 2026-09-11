# Live SSE Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SSE path real. `SseStreamSource` is written, tested and dead — both documents return timer replays and nothing imports the EventSource client. Wire it in: the dev server emits FUNSD-shaped payloads over `text/event-stream`, the worker parses those payloads off the main thread, and `createStream()` uses the live endpoint when it is there and falls back to the replay when it is not.

**Architecture:** The blocker is a shape mismatch. `StreamEvent` is `{ type: 'page', pageIndex, url }` — a *pointer*, which the worker then fetches itself. A real SSE feed pushes the payload **inline**, and the current `server/sse.mjs` pushes `{ type: 'page', pageIndex, nodes: [...] }`, which no consumer understands. Two changes close the gap:

1. `StreamEvent`'s page variant becomes `{ pageIndex, url?, payload? }` — exactly one of the two. A `url` keeps today's fetch-in-worker path (used by the replay sources and the raster fetch); a `payload` is a raw JSON **string** forwarded to a new worker request `ingestJson`, so `JSON.parse` of a live event still happens on the worker thread. Passing the *string* rather than a parsed object is the whole point: parsing on the main thread to hand the worker an object would put the cost back exactly where the brief forbids it.
2. `server/sse.mjs` emits the FUNSD `{ form: [...] }` shape, so `parseFunsdPage` — already the worker's parser, already tested — consumes a live event with no new parser.

`createStream()` then becomes a choice rather than a constant: HEAD-probe `/events`, and adopt the live source only if the endpoint agrees on page count (`X-Page-Count`), otherwise replay. Disagreement is silent corruption — a 100-page feed into a 199-page document would drop pages on the floor — so it is checked, not assumed.

**Tech Stack:** TypeScript, native Web Worker, EventSource, Node `http`, Vite dev proxy, Vitest.

**Spec:** `docs/ASSIGNMENT.md` Module C ("Simulate a real-time extraction pipeline using SSE or WebSockets; process incoming payloads on a Web Worker … main-thread blocking under 16ms during ingest"). Design context: `ARCHITECTURE.md` §2.

## Global Constraints

- Package manager **pnpm**. `pnpm test`, `pnpm typecheck`, `pnpm lint` green at every commit.
- **No `JSON.parse` of a document payload on the main thread**, ever. The SSE client hands the worker a string.
- `< 16ms` main-thread long tasks during ingest — the existing 8ms drain budget in `Session.scheduleDrain` and the `PerformanceObserver` probe in `src/app/ingestProbe.ts` are the measurement; this plan must not regress either.
- Out-of-order arrival must keep working: the dev server shuffles, and the dirty shield in `src/store/merge.ts` still protects human edits from late pages.
- The SSE endpoint is **dev-only** (`vite.config.ts` proxies `/events` on the dev server; `vite preview` and a static deploy do not). The fallback is therefore load-bearing, not a nicety, and must be documented as such.
- FUNSD raw `dataset/` stays gitignored, non-commercial research use only. The dev server reads from `public/funsd/annotations/`, which `pnpm prepare:funsd` produces.

---

### Task 1: `StreamEvent` carries an inline payload

**Files:**
- Modify: `src/stream/source.ts`, `src/stream/sseSource.ts`
- Test: `tests/stream/source.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StreamEvent =
    | { type: 'page'; pageIndex: number; url: string; payload?: undefined }
    | { type: 'page'; pageIndex: number; payload: string; url?: undefined }
    | { type: 'done' }
  ```
- `SseStreamSource.onmessage` no longer `JSON.parse`s the page body. It parses only the *envelope* — `{"t":"p","i":12,"d":"<json string>"}` for a page, `{"t":"d"}` for done — and forwards `d` as an opaque string. Envelope parsing is a ~30 byte object; the 40KB page body is never touched on the main thread.
- Produces `export function parseSseEnvelope(data: string): StreamEvent | null` — exported so the envelope contract is testable without an `EventSource`.

- [x] **Step 1: Write the failing test**

Append to `tests/stream/source.test.ts`:

```ts
import { parseSseEnvelope } from '@/stream/sseSource'

describe('parseSseEnvelope', () => {
  it('reads a page envelope and leaves the body as an opaque string', () => {
    const body = JSON.stringify({ form: [{ id: 1, box: [0, 0, 1, 1], text: 'x', label: 'other', words: [], linking: [] }] })
    const e = parseSseEnvelope(JSON.stringify({ t: 'p', i: 12, d: body }))
    expect(e).toEqual({ type: 'page', pageIndex: 12, payload: body })
    // The body is a string, not an object — parsing it is the worker's job.
    expect(typeof (e as { payload: string }).payload).toBe('string')
  })

  it('reads a done envelope', () => {
    expect(parseSseEnvelope(JSON.stringify({ t: 'd' }))).toEqual({ type: 'done' })
  })

  it('drops a malformed envelope rather than throwing', () => {
    expect(parseSseEnvelope('{not json')).toBeNull()
    expect(parseSseEnvelope(JSON.stringify({ t: 'p' }))).toBeNull()
    expect(parseSseEnvelope(JSON.stringify({ t: 'p', i: 'x', d: '{}' }))).toBeNull()
    expect(parseSseEnvelope(JSON.stringify({ t: 'z' }))).toBeNull()
  })

  it('drops a page envelope with a non-string body', () => {
    expect(parseSseEnvelope(JSON.stringify({ t: 'p', i: 1, d: { form: [] } }))).toBeNull()
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/stream/source.test.ts`
Expected: FAIL — `parseSseEnvelope` is not exported.

- [x] **Step 3: Implement**

`src/stream/source.ts`:

```ts
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
```

`src/stream/sseSource.ts` — delete the "NOT WIRED" banner (it stops being true in Task 4) and replace it with a description of the envelope, then add:

```ts
/**
 * The wire envelope, kept deliberately tiny: `t` for type, `i` for page index,
 * `d` for the page body **as a string**. Only the envelope is parsed on the
 * main thread; the body — tens of KB per page — is forwarded to the worker
 * untouched, which is what keeps ingest off the 16ms budget.
 */
export function parseSseEnvelope(data: string): StreamEvent | null {
  let env: unknown
  try {
    env = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof env !== 'object' || env === null) return null
  const e = env as { t?: unknown; i?: unknown; d?: unknown }
  if (e.t === 'd') return { type: 'done' }
  if (e.t !== 'p') return null
  if (typeof e.i !== 'number' || !Number.isInteger(e.i) || e.i < 0) return null
  if (typeof e.d !== 'string') return null
  return { type: 'page', pageIndex: e.i, payload: e.d }
}
```

and in `open()`:

```ts
    es.onmessage = (ev) => {
      const parsed = parseSseEnvelope(ev.data)
      // Malformed payload: drop it. One bad page never poisons the document.
      if (parsed) this.handler?.(parsed)
    }
```

- [x] **Step 4: Run tests**

Run: `pnpm test -- tests/stream/source.test.ts && pnpm typecheck`
Expected: PASS. The typecheck may flag `MockStreamSource`/`FunsdStreamSource` if they build page events without `url` — they both set `url`, so they satisfy the first union member unchanged.

- [x] **Step 5: Commit**

```bash
git add src/stream/source.ts src/stream/sseSource.ts tests/stream/source.test.ts
git commit -m "feat(stream): let a stream event carry an inline payload string

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `ingestJson` — the worker parses the pushed payload

**Files:**
- Modify: `src/worker/protocol.ts`, `src/worker/index.worker.ts`, `src/worker/client.ts`
- Test: `tests/worker/client.test.ts`

**Interfaces:**
- Produces:
  - `Req` gains `{ kind: 'ingestJson'; pageIndex: number; json: string; offsetX: number; offsetY: number }`
  - `WorkerClient.ingestJson(pageIndex: number, json: string, offsetX: number, offsetY: number): Promise<void>` — resolves when the worker acknowledges; the resulting nodes arrive on the existing unsolicited `pageIngested` channel, exactly like `ingestUrl`.
- The worker's handler is the *same* code path as `ingestUrl` minus the fetch. Extract the shared tail into `ingestForm(pageIndex, text, offsetX, offsetY)` so there is one parser call site, not two.

- [x] **Step 1: Write the failing test**

Append to `tests/worker/client.test.ts`:

```ts
describe('ingestJson', () => {
  it('sends the raw JSON string to the worker, unparsed', async () => {
    const json = '{"form":[]}'
    const pending = client.ingestJson(7, json, 100, 200)
    const sent = fakeWorker.sent.at(-1)!
    expect(sent.kind).toBe('ingestJson')
    expect(sent.pageIndex).toBe(7)
    // A string, not an object: parsing on this thread is the thing we avoid.
    expect(sent.json).toBe(json)
    expect(sent.offsetX).toBe(100)
    expect(sent.offsetY).toBe(200)
    fakeWorker.reply({ id: sent.id, kind: 'ok' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects when the worker reports a parse error', async () => {
    const pending = client.ingestJson(7, '{bad', 0, 0)
    const sent = fakeWorker.sent.at(-1)!
    fakeWorker.reply({ id: sent.id, kind: 'error', message: 'bad json' })
    await expect(pending).rejects.toThrow('bad json')
  })
})
```

Use the file's existing fake-worker helper names (`fakeWorker.sent` / `.reply` above are placeholders for whatever it already provides — match them).

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/worker/client.test.ts`
Expected: FAIL — `client.ingestJson is not a function`.

- [x] **Step 3: Implement**

`src/worker/protocol.ts` — add to `Req`:

```ts
  | { kind: 'ingestJson'; pageIndex: number; json: string; offsetX: number; offsetY: number }
```

`src/worker/index.worker.ts` — factor the existing `ingestUrl` body so the parse-and-reply tail is shared:

```ts
/**
 * Parse one page's annotation JSON and publish the result. Shared by
 * `ingestUrl` (worker fetches the asset) and `ingestJson` (a live SSE event
 * pushed the body inline) so there is exactly one parser call site.
 */
function ingestForm(reqId: number, pageIndex: number, text: string, offsetX: number, offsetY: number) {
  const form = JSON.parse(text) as FunsdForm
  const parsed = parseFunsdPage(form, pageIndex, offsetX, offsetY)
  publishPage(reqId, pageIndex, parsed)
}
```

(`publishPage` is whatever the file already does after parsing — indexing into the QuadTree and posting the `pageIngested` message. Extract it too if it is currently inline.)

Then:

```ts
      case 'ingestJson': {
        try {
          ingestForm(msg.id, msg.pageIndex, msg.json, msg.offsetX, msg.offsetY)
          reply({ id: msg.id, kind: 'ok' })
        } catch (err) {
          // A single malformed event must not kill the worker — the other 198
          // pages are still coming.
          reply({ id: msg.id, kind: 'error', message: String((err as Error).message ?? err) })
        }
        break
      }
```

`src/worker/client.ts`:

```ts
  /**
   * Hands the worker a raw payload string. The caller must NOT parse it first —
   * `JSON.parse` of a page body on the main thread is precisely the long task
   * this architecture exists to avoid.
   */
  ingestJson(pageIndex: number, json: string, offsetX: number, offsetY: number): Promise<void> {
    return this.request({ kind: 'ingestJson', pageIndex, json, offsetX, offsetY }) as Promise<void>
  }
```

- [x] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/worker tests/worker/client.test.ts
git commit -m "feat(worker): add ingestJson so a pushed payload parses off the main thread

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Route payload events in the session

**Files:**
- Modify: `src/app/session.ts`
- Test: `tests/app/session.test.ts`

**Interfaces:**
- Consumes: `WorkerClient.ingestJson` (Task 2), `StreamEvent.payload` (Task 1).
- No new exports. The queue entry the drain loop consumes gains a `payload?: string` beside its `url`, and `scheduleDrain` calls `ingestJson` or `ingestUrl` accordingly.

- [x] **Step 1: Write the failing test**

Append to `tests/app/session.test.ts`. The `FakeWorker` must learn `ingestJson`; extend it to parse the pushed body and reply with the same typed arrays it already builds for `synthetic://`:

```ts
describe('inline payload ingest', () => {
  it('forwards a payload event to the worker without parsing it on this thread', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    vi.useFakeTimers()
    try {
      const doc = createSyntheticDocument(2, 1)
      // A source that pushes one inline page, as a live feed does.
      const body = JSON.stringify({ form: [] })
      doc.createStream = () => ({
        connected: true,
        start(onEvent) {
          onEvent({ type: 'page', pageIndex: 0, payload: body })
          onEvent({ type: 'done' })
        },
        stop() {},
      })

      const s = new Session(canvas(), doc)
      await s.ready
      const before = parseSpy.mock.calls.length
      await s.connectStream()
      for (let i = 0; i < 20 && !s.status.done; i++) await vi.advanceTimersByTimeAsync(20)

      const sent = (globalThis as unknown as { __fakeWorkerSent: { kind: string; json?: string }[] })
        .__fakeWorkerSent
      expect(sent.some((m) => m.kind === 'ingestJson' && m.json === body)).toBe(true)
      // The session never parsed the body itself.
      expect(parseSpy.mock.calls.slice(before).some(([arg]) => arg === body)).toBe(false)

      s.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
```

Have `FakeWorker.postMessage` push every message onto `globalThis.__fakeWorkerSent` (initialize the array at module scope) and answer `ingestJson` with `{ id: msg.id, kind: 'ok' }`.

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/app/session.test.ts`
Expected: FAIL — no `ingestJson` message is ever sent; the session drops the payload event because its queue entry has no `url`.

- [x] **Step 3: Implement**

In `src/app/session.ts`, the stream handler currently enqueues `{ pageIndex, url }`. Widen it:

```ts
  /** One queued page: either an asset the worker fetches, or a pushed body. */
  private readonly queue: { pageIndex: number; url?: string; payload?: string }[] = []
```

The `onEvent` callback:

```ts
      if (e.type === 'done') {
        this.streamDone = true
        this.scheduleDrain()
        return
      }
      this.queue.push({ pageIndex: e.pageIndex, url: e.url, payload: e.payload })
      this.scheduleDrain()
```

and in `scheduleDrain`'s per-entry dispatch, replace the single `ingestUrl` call:

```ts
      const geo = this.geometry
      const origin = geo ? geo.originOf(entry.pageIndex) : { x: 0, y: 0 }
      const done =
        entry.payload !== undefined
          ? // A pushed body: hand the worker the string. Parsing it here would
            // put a 40KB JSON.parse on the frame thread, per page.
            this.worker.ingestJson(entry.pageIndex, entry.payload, origin.x, origin.y)
          : this.worker.ingestUrl(entry.pageIndex, entry.url!, origin.x, origin.y)
      void done.catch((err) => {
        if (!this.disposed) console.warn('page ingest failed', entry.pageIndex, err)
      })
```

Match the surrounding code's actual names for the geometry origin lookup and the existing `ingestUrl` arguments — the only real change is the ternary. A failed ingest is warned and skipped, not thrown: one malformed event must not stop the other 198 pages, and `status.pagesReceived` already tells the reviewer if the count is short.

- [x] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/app/session.ts tests/app/session.test.ts
git commit -m "feat(app): route inline stream payloads to the worker unparsed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Rewrite the dev server to emit FUNSD-shaped events

**Files:**
- Rewrite: `server/sse.mjs`
- Modify: none — `dev:sse` and `dev:all` already exist in `package.json`
- Modify: `vite.config.ts` (proxy comment only, if anything)
- Test: `tests/stream/sseServer.test.ts` (new; node environment, spawns nothing — imports the pure helpers)

**Interfaces:**
- `server/sse.mjs` exports (for the test) `export function envelope(pageIndex, body)` and `export function shuffledPages(count, seed)`; running it as a script still starts the server.
- `GET /events` emits `data: {"t":"p","i":<n>,"d":"<annotation json>"}` per page, shuffled and jittered, then `data: {"t":"d"}`.
- `HEAD /events` answers `200` with `X-Page-Count: <n>` and `Access-Control-Allow-Origin: *`.
- Page bodies come from `public/funsd/annotations/<id>.json`, listed from `public/funsd/manifest.json`. If the manifest is missing the server exits with the same message the app uses: `funsd manifest missing — run \`pnpm prepare:funsd\``.

- [x] **Step 1: Write the failing test**

```js
// tests/stream/sseServer.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { envelope, shuffledPages } from '../../server/sse.mjs'
import { parseSseEnvelope } from '@/stream/sseSource'

describe('sse dev server', () => {
  it('emits an envelope the client can parse', () => {
    const body = JSON.stringify({ form: [] })
    const line = envelope(12, body)
    expect(line.startsWith('data: ')).toBe(true)
    expect(line.endsWith('\n\n')).toBe(true)
    const parsed = parseSseEnvelope(line.slice('data: '.length).trimEnd())
    expect(parsed).toEqual({ type: 'page', pageIndex: 12, payload: body })
  })

  it('keeps the body opaque even when it contains quotes and newlines', () => {
    const body = '{"form":[{"text":"He said \\"hi\\"\\n"}]}'
    const line = envelope(0, body)
    const parsed = parseSseEnvelope(line.slice('data: '.length).trimEnd())
    expect((parsed as { payload: string }).payload).toBe(body)
  })

  it('never emits a bare newline inside the data field', () => {
    // A literal \n in an SSE data line would terminate the event early.
    const line = envelope(0, '{"a":"x\ny"}')
    expect(line.slice(0, -2).includes('\n')).toBe(false)
  })

  it('shuffles every page exactly once, deterministically', () => {
    const a = shuffledPages(50, 7)
    const b = shuffledPages(50, 7)
    expect(a).toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i))
    expect(a).not.toEqual(Array.from({ length: 50 }, (_, i) => i))
  })
})
```

Add `server/**` to the `vitest.config.ts` `test.include` globs only if it restricts includes to `tests/**` — the test above lives under `tests/`, so the import path is all that matters. If `allowJs`/`.mjs` resolution complains under `tsc --noEmit`, add `// @ts-expect-error untyped dev-server module` above the import and note why.

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/stream/sseServer.test.ts`
Expected: FAIL — `server/sse.mjs` exports nothing.

- [x] **Step 3: Rewrite `server/sse.mjs`**

```js
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
```

The `done` frame is delayed 200ms past the last page (was 50) because each page now reads a file before writing; 50ms risked `done` overtaking the tail.

No script changes needed. `package.json` already has both, and `concurrently` is already a
devDependency — use these, do not invent a `dev:full`:

```json
    "dev:sse": "node server/sse.mjs",
    "dev:all": "concurrently -k \"pnpm dev\" \"pnpm dev:sse\""
```

- [x] **Step 4: Run tests**

Run: `pnpm test -- tests/stream/sseServer.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [x] **Step 5: Verify the server by hand**

```bash
pnpm prepare:funsd   # if public/funsd is not populated
pnpm dev:sse &
curl -sI http://localhost:8787/events | grep -i x-page-count   # → 199
curl -sN http://localhost:8787/events | head -c 400            # → data: {"t":"p","i":...,"d":"{\"form\":[...
kill %1
```

- [x] **Step 6: Commit**

```bash
git add server/sse.mjs package.json tests/stream/sseServer.test.ts
git commit -m "feat(server): push real FUNSD payloads over SSE with a page-count header

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Adopt the live source when it agrees with the document

**Files:**
- Modify: `src/stream/sseSource.ts` (`createStreamSource` gains the page-count check)
- Modify: `src/data/funsd/source.ts` (`createStream` becomes async-aware)
- Modify: `src/data/document.ts` (`DocumentSource.createStream` may return a promise)
- Modify: `src/app/session.ts` (`await` the source)
- Modify: `src/components/StatusBar.tsx` (say which transport is live)
- Test: `tests/stream/source.test.ts`

**Interfaces:**
- Produces:
  - `createStreamSource(opts)` gains `expectPages?: number`; it adopts `SseStreamSource` only when the HEAD probe is `ok` **and** (`expectPages` is undefined **or** `X-Page-Count` equals it). Anything else → the fallback source, which callers now supply directly: `opts.fallback: () => StreamSource`.
  - `DocumentSource.createStream(): StreamSource | Promise<StreamSource>`.
  - `Session.status` gains `transport: 'sse' | 'replay'`.

- [x] **Step 1: Write the failing test**

Append to `tests/stream/source.test.ts`:

```ts
import { createStreamSource } from '@/stream/sseSource'
import { MockStreamSource } from '@/stream/mockSource'

const fallback = () => new MockStreamSource(4, 1)

function headStub(status: number, pageCount?: string) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'x-page-count' ? (pageCount ?? null) : null) },
  })) as unknown as typeof fetch
}

describe('createStreamSource', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('adopts SSE when the endpoint agrees on the page count', async () => {
    vi.stubGlobal('fetch', headStub(200, '199'))
    const s = await createStreamSource({ expectPages: 199, fallback })
    expect(s).toBeInstanceOf(SseStreamSource)
  })

  it('adopts SSE when no page count is expected', async () => {
    vi.stubGlobal('fetch', headStub(200))
    expect(await createStreamSource({ fallback })).toBeInstanceOf(SseStreamSource)
  })

  it('falls back when the endpoint disagrees on the page count', async () => {
    // A 100-page feed into a 199-page document would silently drop 99 pages.
    vi.stubGlobal('fetch', headStub(200, '100'))
    expect(await createStreamSource({ expectPages: 199, fallback })).toBeInstanceOf(MockStreamSource)
  })

  it('falls back when the endpoint is absent', async () => {
    vi.stubGlobal('fetch', headStub(404))
    expect(await createStreamSource({ expectPages: 199, fallback })).toBeInstanceOf(MockStreamSource)
  })

  it('falls back when the probe throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch)
    expect(await createStreamSource({ expectPages: 199, fallback })).toBeInstanceOf(MockStreamSource)
  })

  it('honours forceMock without probing at all', async () => {
    const f = headStub(200, '199')
    vi.stubGlobal('fetch', f)
    expect(await createStreamSource({ forceMock: true, expectPages: 199, fallback })).toBeInstanceOf(
      MockStreamSource,
    )
    expect(f).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/stream/source.test.ts`
Expected: FAIL — `createStreamSource` has no `fallback`/`expectPages` options and builds its own `MockStreamSource`.

- [x] **Step 3: Implement `createStreamSource`**

```ts
/**
 * Probes the endpoint and adopts the live transport only if it is both present
 * and consistent with the document. A feed that disagrees on page count is
 * worse than no feed — pages would go missing with no error anywhere — so
 * disagreement falls back rather than being trusted.
 *
 * The endpoint exists only under `pnpm dev` (`vite.config.ts` proxies
 * `/events`); `vite preview` and a static deploy have none. The fallback is
 * therefore the normal path in production, not an error case.
 */
export async function createStreamSource(opts: {
  fallback: () => StreamSource
  forceMock?: boolean
  expectPages?: number
  url?: string
  onStatus?: (connected: boolean) => void
  timeoutMs?: number
}): Promise<StreamSource> {
  if (opts.forceMock) return opts.fallback()
  const url = opts.url ?? '/events'
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 300)
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    clearTimeout(t)
    if (res.ok) {
      const advertised = res.headers.get('X-Page-Count')
      const agrees =
        opts.expectPages === undefined || advertised === null || Number(advertised) === opts.expectPages
      if (agrees) return new SseStreamSource(url, opts.onStatus)
    }
  } catch {
    // endpoint absent, blocked, or slow — fall through to the replay
  }
  return opts.fallback()
}
```

A missing `X-Page-Count` is treated as agreement: a third-party feed need not implement the header, and the reviewer can still see the page count in the status bar.

- [x] **Step 4: Wire the documents**

`src/data/document.ts`:

```ts
  /**
   * The transport for this document. May be async because the live endpoint is
   * probed before the replay is chosen.
   */
  createStream(): StreamSource | Promise<StreamSource>
```

`src/data/funsd/source.ts`:

```ts
    createStream() {
      return createStreamSource({
        expectPages: pages.length,
        fallback: () => new FunsdStreamSource(pages.map((p) => p.id)),
      })
    },
```

`src/data/synthetic/source.ts` — the synthetic document's payloads are generated in the worker from a `synthetic://` URL, so there is no inline body to push and the live endpoint would serve the *wrong* document. Leave it on its replay and say so:

```ts
    createStream() {
      // No live transport: synthetic pages are generated inside the worker from
      // a `synthetic://` URL, so there is nothing for a feed to push. The SSE
      // endpoint serves FUNSD.
      return new MockStreamSource(pageCount, seed)
    },
```

`src/app/session.ts` — `connectStream` awaits the source (it is already async) and records the transport:

```ts
    const source = await Promise.resolve(this.doc.createStream())
    if (this.disposed) return
    this.transport = source instanceof SseStreamSource ? 'sse' : 'replay'
```

with `private transport: 'sse' | 'replay' = 'replay'` and `transport` added to whatever `status` returns. The existing dispose-during-pending-geometry test guards the `this.disposed` check — do not drop it.

- [x] **Step 5: Show the transport in the status bar**

`src/components/StatusBar.tsx` — beside the existing connected/pages readout:

```tsx
<Badge variant={status.transport === "sse" ? "default" : "secondary"} className="text-[10px] uppercase tracking-wider">
  {status.transport === "sse" ? "live sse" : "replay"}
</Badge>
```

This is the honest signal the audit wanted: whichever path is running, the reviewer can see it.

- [x] **Step 6: Run tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [x] **Step 7: Drive both paths by hand**

```bash
pnpm dev            # one terminal
pnpm dev:sse        # another
```
Pick **FUNSD** — the status bar reads `live sse`, pages land out of order, and the ingest probe in the status bar stays under 16ms. Kill the SSE process and reload — the badge reads `replay`, and the document still fills. Pick **Stress** — always `replay`.

- [x] **Step 8: Commit**

```bash
git add src/stream src/data src/app/session.ts src/components/StatusBar.tsx tests/stream/source.test.ts
git commit -m "feat(stream): adopt the live SSE feed when it matches the document

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Document the transport honestly

**Files:**
- Modify: `ARCHITECTURE.md` §2, §8

- [x] **Step 1: Replace the "Transport (stream)" text**

```markdown
### Transport (stream)

`StreamSource` emits `{ type: 'page', pageIndex, url }` **or**
`{ type: 'page', pageIndex, payload }` — a pointer the worker fetches itself, or a body a live
feed pushed inline. Both end at the same parser.

The live path is `SseStreamSource` over `EventSource` with exponential-backoff reconnect. Its
`onmessage` parses only a tiny envelope (`{"t":"p","i":12,"d":"<json string>"}`) and forwards `d`
**as a string** to the worker's `ingestJson`. That is the load-bearing detail: parsing a 40KB page
body on the main thread would reintroduce, once per page, exactly the long task this whole
architecture exists to remove. The main thread never sees a parsed document node.

`createStreamSource` HEAD-probes `/events` (300ms budget) and adopts the live source only if the
endpoint responds **and** its `X-Page-Count` matches the document's. A feed that disagrees is
worse than no feed — pages would go missing with no error surfaced anywhere — so it falls back to
the deterministic replay instead.

The endpoint is **dev-only**: `vite.config.ts` proxies `/events` to `server/sse.mjs` on the dev
server, and neither `vite preview` nor a static deploy has one. The replay is therefore the normal
production path, not a failure mode, and the status bar names which transport is live so the
distinction is never hidden. `pnpm dev:sse` starts the feed; it serves the FUNSD corpus, since
synthetic pages are generated inside the worker and have no body for a feed to push.
```

- [x] **Step 2: Add to §8**

```
- The SSE endpoint is a dev-server process, so the deployed demo runs the replay transport. Making
  the live path reachable in production means hosting a long-lived process, which is a deployment
  decision rather than an architectural one — the client is transport-agnostic either way.
- The envelope is bespoke rather than a standard (`event:` names, `id:` for resume). Resume-on-
  reconnect would need the server to remember what each client received; the replay's determinism
  covers the demo's needs.
```

- [x] **Step 3: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(architecture): describe the live SSE path and why replay is the default

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Unresolved questions

- Deploy a long-lived SSE process so the hosted demo shows the live path, or ship replay-only + a screen recording?
- `X-Page-Count` mismatch: fall back silently (planned) or surface a warning toast?
- Resume-on-reconnect (`Last-Event-ID`) — worth it, or over-engineering for a 48h build?
