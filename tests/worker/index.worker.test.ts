// tests/worker/index.worker.test.ts
import { describe, it, expect } from 'vitest'
import { SemanticLabel, UNSOLICITED, type PageIngested, type Req, type Res } from '@/worker/protocol'

/**
 * Drives the worker's own `ingest()` (via its `self.onmessage` entry point)
 * directly, rather than through `WorkerClient` — the producer side of the
 * text/label seam. A synthetic-generator node never carries `text`/`label`
 * fields (see `src/data/synthetic/serialize.ts`), so this is the only path
 * that exercises the `?? ''` / `?? SemanticLabel.None` defaults in
 * `src/worker/index.worker.ts`'s `ingest()`.
 */
describe('worker ingest() text/label defaults', () => {
  it('fills texts with "" and labels with SemanticLabel.None for a synthetic page', async () => {
    // The module installs `self.onmessage` and posts replies via
    // `self.postMessage` as a side effect of import — capture the latter.
    const posted: Res[] = []
    const fakeSelf = { postMessage: (msg: Res) => posted.push(msg), onmessage: null as unknown }
    ;(globalThis as unknown as { self: unknown }).self = fakeSelf

    await import('@/worker/index.worker')

    const msg: Req = {
      id: UNSOLICITED,
      kind: 'ingestUrl',
      pageIndex: 0,
      url: 'synthetic://page/0?seed=1',
      offsetX: 0,
      offsetY: 0,
    }
    ;(fakeSelf.onmessage as (e: MessageEvent<Req>) => void)({ data: msg } as MessageEvent<Req>)

    // `ingestUrl`'s synthetic branch has no `await` before calling `ingest()`,
    // so the reply is posted synchronously within the call above.
    const reply = posted.find((r) => r.kind === 'pageIngested') as PageIngested | undefined
    expect(reply).toBeDefined()
    expect(reply!.ids.length).toBeGreaterThan(0)
    expect(reply!.texts.every((t) => t === '')).toBe(true)
    expect(Array.from(reply!.labels).every((l) => l === SemanticLabel.None)).toBe(true)
  })
})
