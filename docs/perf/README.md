# Performance evidence

How to reproduce every number in this file, and what the numbers mean.

## Why the on-screen FPS counter is not the metric

The engine repaints only when the frame is marked dirty (`src/engine/engine.ts`,
`requestDraw` / `tick`). A counter of *repainted* frames therefore measures how
often input arrives, not how fast we draw:

| Situation | Repaints/sec | What it means |
| --- | --- | --- |
| Idle | 0 | Nothing changed. Not a stall. |
| Mouse wheel scroll | ~10–40 | Wheel event rate. Each frame still costs ~0.2 ms. |
| Trackpad / drag pan | ~60 | Pointer events coalesce to the display rate. |
| `__bench()` | 60 | Bench dirties the viewport every animation frame. |

DevTools' Frame Rate meter counts *presented* frames and behaves the same way —
a canvas that is not changing presents nothing and reads low.

So the status bar reports two things:

- **fps** — animation-frame rate (`onTick`), i.e. are we keeping up with the display.
- **ms draw** — worst repaint in the last 500 ms window, red past 16 ms. This is
  the number the 60 FPS requirement actually constrains.

## Running the bench

```bash
pnpm build && pnpm preview      # measure the production build, never dev
```

Open `http://localhost:4173/?bench=1` (the harness is exposed in dev always, and
in a production build only behind that flag), wait for `stream complete`, then:

```js
await __bench()                              // oscillating pan, render path only
await __bench({ hover: true })               // + hover picks + React re-renders
await __bench({ stress: true })              // cull bypassed: every node, every frame
await __bench({ ms: 10000, amplitude: 800 }) // longer / wider sweep
```

The pan **oscillates** around the current viewport. An early version panned in a
straight line, drifted off the document after ~2 s and reported a flawless 60 FPS
on blank canvas (`visible.avg: 54`) — always check `visible.avg` is the load you
meant to measure.

Reported fields:

| Field | Meaning |
| --- | --- |
| `fps`, `frames` | Animation frames completed during the run |
| `draw.p50/p95/max` | JS cost of `draw()` per frame, ms |
| `avg.{pages,cull,boxes,overlays}` | Where that time goes, ms/frame |
| `visible.{avg,min,max}` | Boxes surviving the cull — the actual load |
| `truncatedFrames` | Frames where the cull hit `MAX_VISIBLE` and dropped in-view boxes |
| `pageRasters` | Page rasterizations during the run; climbing = cache thrash |
| `longTasks` | Main-thread tasks > 50 ms (PerformanceObserver) |

### What the timers cannot see

`performance.now()` around `draw()` measures *command submission*. Canvas2D
rasterizes on the GPU asynchronously, so a low `draw.p95` with a low presented
frame rate means GPU-bound, not JS-bound — cross-check with a DevTools
Performance recording (main thread idle while frames drop).

## Main-thread blocking during SSE ingest (graded: < 16 ms long tasks)

The pan bench cannot answer this — it starts after the document has loaded, when
the parsing under test is already over. `src/app/ingestProbe.ts` installs at
module scope instead, before the first payload lands, with
`observe({ type: 'longtask', buffered: true })` so tasks fired even earlier are
still captured.

Reload the page, wait for `stream complete`, then:

```js
__ingest()
```

| Field | Meaning |
| --- | --- |
| `window`, `streamDoneAt` | ms since probe start; when ingest finished |
| `count`, `over16`, `over50` | Long tasks recorded, and how many broke each budget |
| `max`, `total` | Worst single task and cumulative blocking |
| `tasks[]` | Each task's start, duration, and attribution |
| `frameGaps`, `worstFrameGap` | rAF gaps > 1.5 frames |

`frameGaps` exists because the `longtask` API only reports tasks over **50 ms**,
while the budget here is **16 ms**. A missed animation frame is the observable
the requirement is actually about, so the probe watches rAF spacing as well; a
clean run is `over16: 0` **and** an empty `frameGaps`.

Ingest is already chunked against this: `Session.scheduleDrain` drains the
stream queue under an 8 ms wall-clock budget per timer and reschedules, so a
burst of out-of-order pages cannot become one long task.

## Click-to-selection latency (graded: < 2 ms across 10k nodes)

```js
await __pick()        // 200 worker round-trips + 50 end-to-end clicks
await __pick(500)
```

Picks sample **box centres**, not random points: random empty space would
measure the cheap miss path and flatter the result. Two numbers, because they
answer different questions:

- `worker` — `postMessage` → reply. The spatial index itself, plus transport.
- `endToEnd` — a real `pointerdown` dispatched at the box, stopping when the
  store's selection actually changes. This is the number the requirement names;
  it includes the tool state machine and the React commit.

Both report `p50 / p95 / max` and `over2ms`, a count of samples that broke the
budget. `hits` should equal `samples` — a shortfall means the worker index and
the rendered geometry disagree, which is a correctness bug, not a slow one.

## Measured

MacBook, Brave/Chromium, production build, DPR 2.

### Baseline — single-column page layout, 8,298 boxes

| Run | fps | draw p50 / p95 / max | visible avg | long tasks | page rasters |
| --- | --- | --- | --- | --- | --- |
| pan | 59.9 | 0.20 / 0.30 / 0.30 ms | 66 | 0 | 0 |
| pan + hover | 60.0 | 0.20 / 0.30 / 0.70 ms | 66 | 0 | 0 |
| pan + hover, amplitude 150 | 59.8 | 0.20 / 0.30 / 0.70 ms | 328 | 0 | 2 |
| pan + hover, 10% zoom | 59.9 | 0.10 / 0.20 / 0.30 ms | 82 | 0 | 0 |

Budget is 16.6 ms/frame; worst observed repaint was 0.7 ms — roughly 20x headroom.
Hover picking and the React tree add no measurable per-frame cost, so the
interaction path is not on the frame's critical path.

**But the load was wrong.** Pages stacked in one vertical column and zoom floors
at 10%, so a viewport could hold at most ~6 pages ≈ 460 boxes. The renderer was
never shown the 10k-boxes-in-view case the brief grades. Fixed two ways:

- `gridGeometry` (`src/data/geometry.ts`) + `pageOrigin` (`src/data/generator.ts`)
  lay the synthetic document out as a 10-wide contact sheet, so zooming out puts
  thousands of boxes on screen.
- `__bench({ stress: true })` bypasses culling entirely and submits every node
  each frame, measuring the draw path's worst case directly.

### Worst case: every node submitted every frame

`__bench({ stress: true })`, culling bypassed:

| Run | fps | draw p50 / p95 / max | boxes/frame | long tasks |
| --- | --- | --- | --- | --- |
| stress | 59.93 | 0.80 / 1.00 / 1.10 ms | 8,192 | 0 |

Breakdown: boxes 0.65 ms, pages 0.06 ms, cull 0.01 ms, overlays 0.03 ms. So 8k
boxes cost ~0.65 ms of a 16.6 ms budget — roughly 16x headroom, and the cost is
linear in submitted boxes, not in document size.

Alongside, from the DevTools Performance monitor during the same run:

- **CPU usage 2.6%**
- **JS heap 8.1 MB**, flat across the run — no per-frame allocation
- **DOM nodes 342** — the boxes are not DOM. A `<div>` per box would read 10,000+.

This run also caught a latent bug: `visible` was exactly 8,192 on min, avg *and*
max, which is `MAX_VISIBLE`. `BucketGrid.query` truncates at the cull buffer's
capacity, so any viewport holding more boxes than the cap silently loses the
overflow. Harmless while a single-column layout capped a viewport at ~460 boxes;
a correctness bug the moment the contact sheet puts the whole document in view.
`MAX_VISIBLE` is now 32,768, and `perf.culledOut` / the bench's
`truncatedFrames` make a future truncation visible instead of silent.

### Contact-sheet layout, 10k+ boxes

_To fill in from a run on the current build._

| Run | fps | draw p50 / p95 / max | visible avg | truncated | long tasks |
| --- | --- | --- | --- | --- | --- |
| pan @ 10% zoom | | | | | |
| pan + hover @ 10% zoom | | | | | |
| stress (cull bypassed) | | | | | |

### FUNSD document — not yet captured

The two documents (synthetic and FUNSD) share the render, cull and worker path end to end, so
the numbers above are expected to carry over — but that is an expectation, not a measurement.
Nothing in this section has been run:

- `docs/perf/funsd-panzoom.json` / `.png` — 5s pan + 10%→500%→10% zoom sweep on the FUNSD document.
- `docs/perf/synthetic-panzoom.json` / `.png` — same sweep on the synthetic document, for
  comparison.
- `docs/perf/funsd-ingest.json` — a DevTools trace across a fresh page load of the FUNSD stream,
  captured alongside `__ingest()` (see above), to back the graded <16ms long-task claim with a
  visual trace and not just the probe's numbers.

Capturing these requires `pnpm dev`/`pnpm preview` and DevTools in hand — the agents that built
this feature did not have a browser available, so this is the concrete next step, not a design
gap. Until it's done, treat "FUNSD scans decode with boxes registered correctly over them" and
"heap returns to baseline after a manual GC across load/undo/redo cycles" as **unverified**
claims rather than confirmed results.
