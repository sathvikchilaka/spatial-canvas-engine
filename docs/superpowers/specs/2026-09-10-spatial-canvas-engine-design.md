# Design — Spatial Canvas Engine (HITL Document Layout Repair Workspace)

Date: 2026-09-10
Brief: `docs/ASSIGNMENT.md`
Status: approved for planning

## 1. Goal

A React + TypeScript workspace where a human reviewer repairs AI document-layout
extraction: 100 synthetic scanned pages overlaid with ~10,000 bounding boxes, panned and
zoomed at 60 FPS, fed by a live out-of-order SSE stream, with box / reading-order / table
editing backed by ≥50-level undo.

Success is measured by four numbers before it is measured by features: 60 FPS during
pan/zoom at 10k boxes, <16ms main-thread long tasks during ingestion, <2ms
click-to-selection, and a flat heap across load/undo/redo cycles.

## 2. Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Renderer | Raw Canvas2D, hand-written | Boxes are axis-aligned rects; a library would hide the coordinate math and frame loop the brief singles out. No scene graph to fight. |
| Dataset | Fully synthetic, generated in-repo | One seeded generator emits both the page ink and the box nodes, so boxes align with text by construction. No assets committed. |
| SSE | Real Node endpoint in dev, in-app emitter fallback | Satisfies a literal reading of the brief while keeping the deployed demo one-click. |
| Stream vs edit conflict | Dirty-node shielding | Edited nodes reject stream overwrites; clean nodes accept. No merge UI to build. |
| State | Zustand + Immer patches | Patches make ≥50-level undo cheap and let stream writes bypass history. |
| Worker transport | Native `postMessage`, transferable typed arrays | Structured-cloning 10k objects would itself blow the 16ms budget. |
| Table split/merge | Optional, last phase | Highest cost, lowest weight. Cut with a stated reason beats half-built. |

## 3. Architecture

Four units, deliberately isolated. The seam that matters most is store ≠ engine: React
must never re-render per frame or per mousemove.

```
        ┌─────────────────────────────────────────────┐
        │  React (chrome only)                        │
        │  toolbar · tree view · page rail · badges   │
        └───────────────┬─────────────────────────────┘
                        │ subscribe (coarse: selection, counts)
        ┌───────────────▼─────────────────────────────┐
        │  Store — Zustand + Immer                    │
        │  editable nodes · selection · undo stack    │
        └───────┬───────────────────────┬─────────────┘
   commit tx    │                       │ read
        ┌───────▼───────────┐   ┌───────▼─────────────┐
        │  Engine (plain TS)│   │  Worker             │
        │  transform matrix │◄──┤  parse · QuadTree   │
        │  rAF loop · cull  │   │  hit-test · viewport│
        │  draw · input     ├──►│  queries            │
        └───────────────────┘   └───────▲─────────────┘
                                        │ events
                                 ┌──────┴──────┐
                                 │ SSE source  │
                                 └─────────────┘
```

### 3.1 Engine (`src/engine/`)

Framework-agnostic. Constructed once with a canvas element; React only mounts and disposes it.

- **Transform.** A single `Viewport` holding `scale`, `tx`, `ty`. Two functions,
  `worldToScreen` / `screenToWorld`, are the only places the math appears. Zoom-to-cursor
  solves for the pan that keeps the world point under the cursor fixed:
  `tx' = cx - wx * s'`. Scale clamped to [0.1, 5.0].
- **DPR.** Backing store sized `cssSize * devicePixelRatio`, context scaled once per resize.
  Strokes offset by half a device pixel so 1px borders land on pixel boundaries rather than
  straddling two. Re-evaluated on `resize` and on monitor change.
- **Frame loop.** One rAF. Input handlers mark dirty and never draw directly; the loop
  coalesces. Idle frames cost nothing.
- **Layers, drawn in order:** page rasters → boxes → overlays (reading-order arrows, table
  mesh) → interaction HUD (handles, snap guides, marquee). The HUD is redrawn every frame
  during a drag; the box layer only when the viewport or data changes.
- **Culling.** Each frame resolves the visible ids from a main-thread bucket grid (see 3.3)
  and draws only those. The draw loop never iterates all nodes and never awaits the worker.
- **Batching.** Boxes are grouped by style (type + state) and stroked in a single path per
  group, so the number of context state changes is bounded by the number of styles, not by
  the number of boxes.

### 3.2 Data representation

Nodes live as parallel typed arrays, not objects:

```
Float32Array coords   // x, y, w, h per node — 4 slots
Uint32Array  ids
Uint8Array   types    // paragraph | line | cell | kv | figure
Int32Array   parents
Int32Array   order    // reading order index, -1 if none
Uint8Array   flags    // dirty | selected | hidden
```

This is what makes the worker boundary cheap (transfer, not clone) and the draw loop
allocation-free. A parallel `Map<id, meta>` on the main thread carries the rare
non-numeric fields (label text) for the few nodes that need them.

### 3.3 Worker (`src/worker/`)

Owns parsing and the spatial index. Never touches React or the DOM.

- **Index.** QuadTree over world space, bulk-loaded per page on arrival, max depth 8,
  bucket size 16. Insert is incremental so streamed pages join without a rebuild.
- **Queries.** `hitTest(worldPoint) -> id | null` (topmost by z, then smallest area) and
  `queryRect(viewport) -> Uint32Array of ids`.
- **Protocol.** Typed request/response messages with a monotonic `reqId`. Two shapes:
  fire-and-forget (`ingestPage`) and request/response (`hitTest`, `queryRect`).
- **The synchronous-culling problem.** The frame loop cannot await a worker round-trip —
  that would add a frame of latency to every pan. Resolution: the worker owns the
  authoritative index; the main thread keeps a lightweight per-page bucket grid (page →
  coarse cell → ids) rebuilt on ingest, used for culling only. Clicks go to the worker,
  where the 2ms budget applies and a round-trip is invisible. Culling is approximate and
  conservative; hit-testing is exact.
- **Mutations.** Committed edits are posted to the worker so the index stays correct;
  in-flight drags are not.

### 3.4 Store & history (`src/store/`)

Zustand with Immer's patch recording. Holds only what a human can change — geometry
overrides, labels, reading-order links, table topology, selection — keyed by node id. The
bulk arrays are not in the store.

- **Transactions.** One user gesture = one entry. A drag records nothing until mouseup;
  the engine renders the in-progress geometry from ephemeral state. Rapid same-target edits
  (e.g. arrow-key nudges) coalesce within 300ms.
- **Undo stack.** Ring buffer of 100 patch pairs (comfortably over the required 50). Inverse
  patches make undo O(size of change), not O(document).
- **Stream writes bypass history** entirely — a separate action that applies without
  recording. `Cmd+Z` never rewinds the model's output.
- **Dirty shielding.** Any node the user edits gets `editedAt`. Stream application skips
  those nodes and counts them; the UI reports "Page 7 updated — 3 of your edits preserved."
  Undoing every edit on a node clears its dirty flag.

### 3.5 Streaming (`src/stream/`, `server/`)

- Dev: a small Node server exposes `GET /events` as `text/event-stream`, emitting page
  payloads shuffled and jittered to guarantee out-of-order arrival.
- Fallback: an in-app emitter behind the identical interface, selected when the endpoint is
  absent. The rest of the app cannot tell the difference.
- Payloads land in the worker, are parsed and indexed there, and arrive on the main thread
  as transferred arrays. Ingestion is chunked so no single message exceeds the 16ms budget.

### 3.6 Tools (`src/tools/`)

A tool is a small state machine receiving pointer events in world coordinates, drawing its
own HUD, and emitting a store transaction on commit. One active at a time.

- **Select/edit.** Click to select, drag to move, eight resize handles with hit slop scaled
  to stay ~8 screen px at any zoom. Snapping: candidate edges from nearby nodes via the
  bucket grid; within 6 screen px the edge snaps and a guide line draws.
- **Reading order.** Arrows follow the `order` array, drawn between box centres with
  arrowheads. Dragging an endpoint onto another box re-links the sequence; downstream
  indices renumber in the same transaction.
- **Table mesh.** Row/column divider lines over a detected table; dragging one resizes the
  adjacent cell bands and recomputes their boxes. Split and merge are phase 6b, optional.

### 3.7 Tree view & grounding (`src/components/`)

Virtualized tree of the node hierarchy beside the canvas. Selection lives in the store, so
sync is a consequence of shared state rather than bespoke wiring: canvas hover sets it and
the tree scrolls that row into view; tree hover sets it and the engine redraws the
highlight. Virtualization is required — 10k rows of DOM would reintroduce the very
bottleneck the canvas exists to avoid.

## 4. Error handling

- Worker crash: caught at the boundary, surfaced as a banner with a reload action; the
  canvas keeps rendering the data it already has.
- SSE drop: exponential-backoff reconnect with a visible connection indicator; already
  ingested pages are unaffected.
- Malformed page payload: rejected in the worker, logged, that page marked failed in the
  page rail. One bad page never poisons the document.
- Undo of a node the stream has since removed: the patch applies to a tombstone and is
  discarded rather than resurrecting it.

## 5. Testing

Vitest for the parts where correctness is provable and bugs are invisible:

- transform round-trip (`screenToWorld(worldToScreen(p)) ≈ p`) across scales; zoom-to-cursor
  invariant; DPR sizing
- QuadTree queries checked against a brute-force oracle on randomized inputs
- undo/redo over a randomized mutation sequence returns to the exact initial state
- dirty-node merge: edited nodes survive a stream update, clean nodes take it

Plus one Playwright smoke test: load the stress document, assert the canvas renders and a
click selects. No component tests — low value here.

## 6. Performance evidence

A `?bench` mode drives a scripted pan/zoom over the stress document while recording frame
times, so the numbers are reproducible rather than hand-waved. Chrome DevTools traces
exported to `docs/perf/`, and each benchmark in ARCHITECTURE.md answered with a measured
number.

## 7. Scope

**In:** everything in Modules A–D except table cell split/merge.

**Out, deliberately:** table split/merge (phase 6b, built only if time allows); multi-select
and marquee beyond single selection; real OCR or PDF ingestion; collaborative editing;
persistence beyond the session.

## 8. Risks

- **Phase 1 misses 60 FPS.** Most likely cause is per-frame allocation or unbatched strokes.
  Mitigation: profile at the end of phase 1, before any tool code exists to confound it.
- **Approximate culling drifts from the authoritative index** after many mutations.
  Mitigation: rebuild the bucket grid for a page on ingest and on committed structural edits.
- **Synthetic pages look cheap** and undercut the UX-polish score. Mitigation: invest in the
  generator — margins, varied line lengths, tables, figures, paper tint.
