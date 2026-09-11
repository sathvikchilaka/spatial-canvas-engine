# Spatial Canvas Engine

A human-in-the-loop **document layout repair workspace**. It renders multi-page document scans
with 10,000+ interactive bounding boxes at a sustained 60 FPS, fed by an out-of-order streaming
extraction feed, with all parsing and spatial indexing on a Web Worker — and tools to fix what
the extraction got wrong.

**Live demo:** <!-- deployed URL, see plans/…-submission-readiness-plan.md Task 5 -->
**Architecture & trade-offs:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
**Performance evidence:** [`docs/perf/README.md`](./docs/perf/README.md)
**Assignment brief:** [`docs/ASSIGNMENT.md`](./docs/ASSIGNMENT.md)

## Run it

Requires **Node 22+** and **pnpm 9+** (`corepack enable` gets you pnpm).

```bash
pnpm install
pnpm dev            # http://localhost:5173
```

The **Stress · 100pp · 10k boxes** document is generated in-browser and needs no assets — open
the app, click it, and the 100-page / ~10,000-box corpus streams in.


### The FUNSD document (optional)

The second document is the real **FUNSD** corpus: 199 pages, 41,228 boxes, 5,294 reading-order
edges, with page scans. It is **not** in the repo — FUNSD is derived from RVL-CDIP and licensed
for **non-commercial research use only**, so `dataset/` is gitignored.

```bash
# put the FUNSD release under ./dataset/ first (see docs/ASSIGNMENT.md)
pnpm prepare:funsd     # → public/funsd/{manifest.json,annotations,images}
pnpm dev
```

Without this step the FUNSD picker entry reports the missing manifest and the synthetic document
still works.

### Live SSE feed (optional, dev only)

```bash
pnpm dev:all       # vite + the SSE dev server together
```

`server/sse.mjs` pushes the FUNSD pages over `text/event-stream`, shuffled and jittered. The app
HEAD-probes `/events` and adopts the live transport when it is there; otherwise it runs the
deterministic replay, and the status bar says which. See `ARCHITECTURE.md` §2.

## What to look at

| | |
| --- | --- |
| **Canvas engine** | `src/engine/` — dirty-flag rAF loop, one world↔screen matrix, style-grouped batching, `BucketGrid` viewport culling. No DOM node per box. |
| **Worker seam** | `src/worker/` — fetches, parses and indexes off the main thread; replies in transferable typed arrays. Loose-parent QuadTree for O(log N) hit-testing. |
| **Tools** | `src/tools/` — box editor with snapping, reading-order graph with drag-to-re-parent, table grid mesh with divider drag / split / merge. Geometry math is pure and unit-tested. |
| **State** | `src/store/` — Zustand + Immer `produceWithPatches`, one gesture = one undo entry, 100-level history, and a dirty shield so late stream pages never clobber a human edit. |

## Commands

```bash
pnpm dev          # dev server
pnpm dev:all      # dev server + SSE feed
pnpm build        # tsc -b && vite build
pnpm preview      # serve the production build (what perf numbers are measured on)
pnpm test         # vitest, unit + integration
pnpm test:e2e     # playwright smoke suite against the production build
pnpm typecheck
pnpm lint
pnpm prepare:funsd
```

## Measuring it yourself

Open the production build with `?bench=1` and use the harness from the console:

```js
await __bench()             // oscillating pan, frame timings
await __bench({ zoom: true }) // + oscillating zoom-to-cursor sweep
await __pick(200)           // click→selection latency, worker and end-to-end
__ingest()                  // main-thread long tasks during stream ingest
```

`docs/perf/README.md` explains every field, why the on-screen FPS counter is *not* the metric,
and what the numbers were on the reference machine.

## Licence & data

Code: for assignment review. **FUNSD data is non-commercial research use only** and is not
redistributed here.
