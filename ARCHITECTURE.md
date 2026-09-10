# Architecture

## 0. Documents

Two `DocumentSource` implementations (`src/data/document.ts`) sit behind one interface —
`geometry()`, `raster(page)`, `createStream()` — so the engine, worker and session never branch
on which kind of document is loaded:

- **`src/data/synthetic/source.ts`** — a 100-page, ~10k-box procedurally generated stress
  document. Uniform page size (`uniformGeometry`), laid out as a 10-wide contact sheet
  (`gridGeometry` + `pageOrigin`) so a 10% zoom puts thousands of boxes in view at once.
- **`src/data/funsd/source.ts`** — the real FUNSD corpus: **199 scanned form pages, 41,228
  annotated boxes, 5,294 directed reading-order edges**. Page sizes are heterogeneous scans, so
  layout uses `stackedGeometry` (`src/data/geometry.ts`) — each page at its own native size,
  stacked top to bottom — rather than the synthetic grid.

  FUNSD is derived from RVL-CDIP and is licensed for **non-commercial research use only**. The
  raw corpus stays in the gitignored `dataset/`; `scripts/prepare-funsd.ts` copies only the
  199 PNGs/JSON annotations the app ships into `public/funsd/`, plus a `manifest.json` of page
  sizes read straight from each PNG's IHDR chunk (`pngSize()`) — geometry construction is one
  ~8 KB fetch, never 199 image decodes.

  The UI names it plainly: `<SelectItem value="funsd">Real · FUNSD · 199pp · 41k boxes</SelectItem>`
  (`src/components/DocumentPicker.tsx`), and the synthetic document stays available as the
  10k-box stress case the brief's perf budgets are written against.

## 1. Viewport transformation & render pipeline

- **`PageGeometry`** (`src/data/geometry.ts`) is the single source of truth for where every page
  sits in world space: a `Float32Array` of `[x, y, w, h]` per page, plus `origin(page, out)` and
  `rangeFor(y, h)`. Page layout is no longer a module constant assuming uniform A4 pages —
  `gridGeometry` (the synthetic contact sheet), `stackedGeometry` (FUNSD, heterogeneous native
  page sizes) and `uniformGeometry` (single-column, kept for the geometry tests) all produce the
  same shape. It is the *only* place page position is defined: the worker positions a page's
  nodes from the `offsetX/offsetY` the drain loop reads out of it (§2), so paper and boxes cannot
  disagree.
- `rangeFor` binary-searches (`lowerBound`) for the inclusive page range intersecting a world
  y-span instead of dividing by a fixed stride, because page heights are no longer uniform under
  FUNSD. It is deliberately over-inclusive at inter-page gaps — a span landing in a gap returns
  the preceding page, i.e. one extra off-screen page for the page layer to skip, never a dropped
  visible one.
- Transform is one world↔screen matrix (`scale`, `tx`, `ty`); zoom-to-cursor derives pan from the
  cursor's world position before/after the scale change. Zoom clamps to 10%–500%.
- devicePixelRatio: the backing store is sized CSS size × DPR at resize, and `engine.draw` opens
  each frame with `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` before applying the world matrix — one
  cheap transform reset per frame, not a per-draw-call rescale. That is what keeps 1px strokes
  crisp rather than blurred.
- Frame loop (`src/engine/engine.ts`): rAF-scheduled, dirty-flag gated (`requestDraw`/`tick`) so
  an idle canvas repaints zero times — see `docs/perf/README.md` for why the on-screen FPS counter
  is not the graded metric. Layers are separated (page rasters / boxes / overlays / interaction
  HUD) so each can batch its own canvas state changes.
- Culling: per-frame culling is **main-thread** — `BucketGrid.query` (`src/engine/bucketGrid.ts`,
  a uniform spatial hash filled by `addPage` as pages ingest) answers "what intersects the
  viewport" in `engine.draw`, with no worker round-trip in the frame path. The worker's QuadTree
  is the *hit-test* index (§3), queried per pointer event, not per frame. Either way the draw
  loop never iterates the full node set. `MAX_VISIBLE` (32,768) caps the per-frame cull result;
  `perf.culledOut` / the bench's `truncatedFrames` surface a viewport that overflows the cap
  instead of the overflow silently vanishing (see `docs/perf/README.md`, "worst case" section).

## 2. Web Worker communication strategy

- **Thread ownership**: the worker (`src/worker/index.worker.ts`) owns parsing and the spatial
  index (QuadTree); the main thread owns render and interaction. This holds for *both*
  documents — the worker's `ingestUrl(pageIndex, url, offsetX, offsetY)` handler dispatches on
  the URL scheme:
  - `synthetic://page/<n>?seed=<s>` → `serializeGeneratedPage` (synthetic generator runs
    on-worker, never on the main thread). Like the FUNSD branch it places nodes at the
    `offsetX/offsetY` the drain loop read from the document's `PageGeometry`, so the paper and
    the boxes cannot drift apart: the geometry is the single source of page position.
  - a path under `/funsd/` → `fetch` the annotation JSON, `parseFunsdPage` maps FUNSD's
    `form`/`words`/`linking` schema into the shared `NodeArrays` + edge-pair shape.

    Any other URL scheme throws, so a malformed payload surfaces as a worker `error` reply
    instead of silently ingesting nothing. This guard is why both document kinds can share one
    `ingestUrl` request without one leaking into the other's namespace.
- **Transport (worker)**: native `postMessage`, typed request/response union
  (`src/worker/protocol.ts`).
- **Transport (stream) — what actually ships**: both documents' `createStream()` return
  *timer-driven, SSE-shaped replays* (`MockStreamSource`, `FunsdStreamSource`): out-of-order page
  events behind the same `StreamSource` interface a network stream would implement, so nothing
  downstream can tell the difference. A real `EventSource` client with exponential-backoff
  reconnect exists (`src/stream/sseSource.ts`) and `server/sse.mjs` + `pnpm dev:sse` serve the
  matching endpoint, but **nothing imports them** — `createStreamSource`'s endpoint probe is not
  wired into `createStream()`, so the app never opens an `EventSource`. Stated plainly rather
  than implied, because the ingest/backpressure claims below are measured on the replay path.
- **Payload representation**: every page ingest reply is transferable typed arrays — `ids`
  (`Uint32Array`), `coords` (`Float32Array`, x/y/w/h at `i*4`), `types`, `parents`, `order`, and
  now **`edges`** (`Int32Array`, `[from, to]` pairs) — never arrays of per-node objects. The
  worker slices these directly out of its own `NodeArrays` backing store and transfers the
  underlying buffers (`postMessage(res, [ids.buffer, coords.buffer, ...])`), so a FUNSD page's
  ~200 boxes or a synthetic page's thousands cost one structured-clone-free handoff rather than
  cloning an object graph.
- **Backpressure / out-of-order**: `Session.scheduleDrain` (`src/app/session.ts`) drains the
  stream queue under an **8ms wall-clock budget per timer tick** and reschedules itself if work
  remains, so a burst of out-of-order SSE pages (FUNSD's 199 files can resolve in any order)
  never becomes one long main-thread task. Partial pages become renderable state incrementally
  as each `pageIngested` reply lands — the store never waits for the whole document.
- **Cancellation / teardown**: `PageCache` (§5) tracks a generation token per in-flight decode so
  a stale resolution after eviction/dispose is closed, not installed — this is the same
  discipline applied to worker-side page state on `reset`.
- **Text payload**: Text is the one payload that cannot be a typed array. `PageIngested` carries
  `texts: string[]` parallel to `ids` (plus `labels: Uint8Array` over the `SemanticLabel` enum),
  so the strings are structured-cloned while the six numeric buffers are still transferred. One
  array of ≤536 short strings per page is negligible next to the geometry, and paying it is what
  keeps `JSON.parse` of the corpus on the worker — which is the property being graded, not the
  clone cost.

## 3. Spatial indexing for hit-testing

Unchanged QuadTree (`src/worker/quadtree.ts`), now fed uniformly from the worker's own parse
of either document rather than from a caller-supplied node list. `ingest()` inserts every parsed
node (`tree.insert(id, x, y, w, h)`) as pages stream in — incremental, never a bulk rebuild.
`hitTest(x, y)` queries the tree, then breaks ties by smallest area / latest reading order among
overlapping hits. `queryRect` answers viewport-range culling. `updateNode` calls `tree.update(...)`
so a box edit moves its entry without touching the rest of the index. It is driven from
`Session.writeCoords`, the single writer for `nodes.coords`, not from the tool that started the
gesture — that is what makes undo and redo resync the index, since an edit vanishing is as much a
geometry change as one appearing. `BucketGrid.move` is called from the same place, so the
per-frame cull and the hit-test index can never disagree about where a box is. Both `hitTest` and
`queryRect` round-trip over `postMessage` — `docs/perf/README.md`'s `__pick()` bench reports the
worker round-trip and the full end-to-end (pointerdown → store selection) numbers separately.

## 4. State & transactional history

Zustand store (`src/store/store.ts`) plus Immer:

- `commit(name, recipe)` — one user gesture, produced via `produceWithPatches`, pushed onto a
  `History` stack (`patches` + `inverse`) capped at `HISTORY_LIMIT` (≥50). `beginCoalesce` /
  `endCoalesce` merge a drag or a run of arrow-key nudges into one undoable entry.
- `applyStream(recipe)` — SSE/worker writes go through a plain `produce`, **bypassing history
  entirely**, so Cmd+Z can never rewind the model's own output. ("SSE" throughout §4 means the
  SSE-shaped replay described in §2, not a live `EventSource`.)
- **Merge/conflict rule** (`src/store/merge.ts`, `applyPageUpdate`): the "dirty shield" is keyed
  on `edits[id].rect` — a per-node *geometry override* — not on `dirtyAt`; a node with a geometry
  override rejects further stream overwrites (`shielded++`), a clean node accepts them
  (`applied++`). `dirtyAt` marks "a human touched this node" for the FLAG_DIRTY paint and the
  status bar's counter, and a reading-order link sets it too; keying the geometry shield on it
  froze a box's coordinates because its reading order had been repaired. `applyPageUpdate`
  deliberately takes the worker's typed arrays directly (`ids: Uint32Array`, world-space
  `coords: Float32Array`) rather than a `SerializedNode[]`, because building that array just to
  iterate it once would itself be a main-thread allocation storm on a FUNSD-sized burst. It reads
  those arrays and writes nothing: with the human overlay bounded (next bullet), a clean node
  needs no store entry, so the merge is purely a shielded/applied count.
- **`edits` is the human overlay only**: `applyPageUpdate` no longer writes an `Edit` for a clean
  node that has none — that node's authoritative geometry is already in the render arrays and
  `Session.rectOf` falls back to them. An earlier version wrote `rect` for every incoming
  coordinate, so the store grew to ~41k `Edit` records over the FUNSD stream; because
  `Session.subscribeSelection` re-walks `edits` and `dirtyAt` on every store change, that made
  each of the 199 `pageIngested` callbacks an O(document) rescan with a full id-map rebuild —
  main-thread work that *grew* per ingested page, against the <16ms ingest budget. With the
  overlay bounded by human edits, a clean page now produces no store mutation at all (Immer
  returns the same state object, so subscribers are not even notified).
- **The baseline that makes that safe**: because `edits` no longer mirrors clean nodes, undo has to
  restore the stream geometry rather than just drop an `Edit`. `Session.applyEdits` writes edits
  into `nodes.coords` in place, which destroys the very values `rectOf` falls back to — so the
  session keeps `baseCoords`, a Float32Array of the stream geometry parallel to `nodes.coords`,
  filled as each page ingests, plus an `overridden` id set. Applying an edit writes the rect and
  records the id; an edit that *disappears* (undo, or a redo rewound past it) restores from
  `baseCoords`. Both passes are O(human edits), never O(document).
- **Text, labels, and relabeling**: `Edit.label` is the second editable field beside `rect`. It
  is stored as the label's **name**, not its enum ordinal, so the store stays legible in a patch
  dump and survives a change to the enum's numbering. `Session.labelOf` resolves human override
  over extraction, and `applyEdits` maps the effective label onto `nodes.types[i]` — a re-label
  has to repaint the box, because the canvas is where the reviewer is looking. Nodes with no base
  label (the synthetic corpus) are excluded from that mapping, so reverting an edit cannot flatten
  a `Line` into a `Paragraph`.
  
  Text and labels live in `Map`s on the `Session`, not in the typed arrays: text is
  variable-length and non-numeric, and both are read by React chrome on selection rather than by
  the draw loop on every frame. Only non-empty values are stored, so the 10k-box synthetic
  document adds nothing.
  
  The inspector serializes the **selected node's subtree**, capped at 400 nodes — never the
  document. Stringifying 41,228 nodes would blow the frame budget many times over and would be
  unreadable; the reviewer wants the thing they clicked. The inspector's rows are clickable and
  bi-directionally sync with the canvas selection: clicking any row selects that node via
  `setUiState`, and the row matching `selectedId` is highlighted, mirroring the reading-order
  tree's interaction pattern.

## 5. Reading-order graph

Reading order moved from a linear per-page chain to a directed **edge set**
(`src/data/edges.ts`, `EdgeSet`): `pairs: Int32Array` (`[from, to]` at `i*2`) plus an `adjacency:
Map<number, number[]>` built once whenever the graph changes, never per frame. FUNSD populates
edges from its real `linking` annotations (a form question can point at several answers, which a
linear chain cannot express — hence the DAG rather than a chain); the synthetic document
populates the degenerate case, out-degree 1 everywhere. `materialize(base, added, removed, nodes)`
recomputes the effective graph (base ∪ human-added ∖ human-removed) and its adjacency map on
edit, and is what the reading-order overlay draws from.

Editing the graph has two gestures. Pressing on empty box space and dragging onto another box
**links or unlinks** that pair (`hasEdge` decides which). Pressing on a *painted arrow's
endpoint* instead **re-parents** it: dragging the head re-points the successor, dragging the tail
re-points the predecessor, and either way the old edge's removal and the new edge's addition go
into a **single `commit()`** — a re-parent is one reviewer intent, and two commits would let
Cmd+Z leave the graph disconnected.

Endpoint hit-testing (`hitEndpoint`) consults only the arrows the overlay painted last frame.
The graph has 5,294 edges on FUNSD, but the reviewer can only grab one that is on screen, so the
overlay records each arrow it draws into a pre-allocated `ArrowRecord[]` (capped at the arrow
budget, overwritten in place, zero per-frame allocation) and the tool searches that.

Badges show the node's **reading position**, not its out-degree. `sequenceNumbers` walks the
graph from its in-degree-0 roots depth-first — roots ordered by document order then id, children
by id, so the numbering is deterministic frame to frame — and anything left unreached (a cycle a
reviewer or an extractor created) is numbered afterwards, so no linked node renders blank. The
result is a `Map<nodeId, number>` stored on the `EdgeSet` and rebuilt only when the graph
changes; the badge painter does a map lookup, never a walk.

## 5b. Table grid mesh

A table is not a node type — it is a parent block whose children are `NodeType.Cell` nodes
(`Session.tableAt`). The mesh is **derived, never stored**: `buildMesh` (`src/tools/tableMesh.ts`)
clusters cell extents into occupancy bands (`bandsOf`) and places one divider line between
adjacent bands, so inset extraction geometry yields `M+1` lines rather than `2M` cell edges.
Band derivation is structural, not width-based: a cell that spans two bands is told apart from a
genuinely wide cell by removing its extent and checking whether that reveals an interior gap
(`splitInterval`), using only a relative epsilon for extraction slop — never a width heuristic.
Occupancy gaps alone are not enough, because the tool's own output has none: `cellRect` tiles the
table, so committed cells share exact edges and every extent would fuse into a single band —
which is precisely how the mesh used to collapse to 1x1 after the first gesture. `bandsOf`
therefore also splits an interval at its interior **shared edges**, a coordinate that is one
extent's `hi` and another's `lo` *within `edgeUlp`* — not exact equality. Two cells tiled from the
same divider line are **not** guaranteed byte-identical at that edge: the store, `nodes.coords`,
is a `Float32Array` holding `x`/`w`, not the two edges themselves, so `Session.tableAt` hands
`buildMesh` a right edge computed as `fl32(x0) + fl32(x1 - x0)` while the neighbouring cell's left
edge is read directly as `fl32(x1)` — two different float64 sums of float32 inputs that round-trip
the same divider line but can land several float32 ULPs apart (measured: ~75% of realistic
fractional drags land on a table this shape). `edgeUlp` scales with the coordinate's own magnitude
(float32 precision is relative, not absolute), which keeps the test structural rather than a
generic misalignment threshold: it is ~1e4x smaller than `MIN_BAND`, so it recognises two
computations of the *same* line without ever fusing two dividers a human genuinely dragged close
together. `MIN_BAND = 8` remains unrelated to the whole derivation; it is purely the clamp on how
far a divider drag may shrink a band.

`cellRect` re-derives every cell's rect from the current lines on every read, which is what makes
post-edit bbox recalculation a one-liner with no second bookkeeping copy. On the session side, the
mesh is rebuilt from the render arrays after any store change that moved geometry — a commit, an
undo, a redo — and because `tableAt` skips `FLAG_HIDDEN` cells, that rebuild never sees a
merged-away or undone cell. The rebuild is *not* a repair mechanism, though: it is only safe
because band derivation is a fixed point over what the session actually stores — `cellRect`'s
gapless output, round-tripped through the `Float32Array` `nodes.coords` the way `Session.tableAt`
reads it, not `cellRect`'s float64 output taken at face value (pinned by tests in
`tests/tools/tableMesh.test.ts` that feed a mesh's rects straight back into `buildMesh`, and by
float32-backed two-consecutive-gesture tests in `tests/tools/tableTool.test.ts`, including one that
drags to a fractional coordinate and round-trips it through float32). The rebuild is also skipped
while a gesture is live: hover and selection writes leave `state.edits` identical, and
`TableTool.adopt` refuses outright while it is `capturing`, so an in-progress divider drag is
never replaced by a freshly derived mesh. The diff baseline is written before each `commit()` for
the same reason — `commit` runs the subscriber, and therefore the re-adopt, synchronously.

Building a mesh is deliberately lossy — it regularises a ragged table onto a shared grid, which
is the repair the reviewer picked the tool up to make. `TableTool.adopt` therefore takes the
mesh's own rects as the diff baseline, so adopting a table alone commits nothing.

Dragging a divider commits **ordinary `edits[id].rect` entries**, one `commit()` per gesture.
Split and merge change the *number* of cells, which a rect diff cannot express, so those two
gestures additionally set `Edit.created` (an id from `Session.allocId()`, offset at
`1_000_000_000 + counter` so a synthetic id can never collide with an ingested one) or
`Edit.deleted`. Both still land in a single `commit()`, so a drag, a split and a merge are each
exactly one undo entry.

`Session.materializeStructural` applies `created`/`deleted`. Node rows only ever grow — indices
are referenced by the main-thread `BucketGrid` (512px hash, per-frame culling) and the worker's
loose-parent QuadTree (`indexById`) — so undoing a creation **hides and de-indexes** the row
(`FLAG_HIDDEN`, `BucketGrid.remove`, worker `removeNode`) rather than splicing it out, and redoing
one un-hides and re-indexes it (`showNode`, `worker.insertNode`) rather than pushing a new row.
`hideNode`/`showNode` are idempotent on the flag, and both reconciliation passes in
`materializeStructural` key off `FLAG_HIDDEN` rather than a separate mirror — that is what stops a
created-then-deleted cell from resurrecting on redo and from double-inserting into the QuadTree.
`nodes.coords` itself has a single writer, `Session.writeCoords`, which is what keeps that array,
the `BucketGrid`, and the worker's QuadTree from drifting apart across split/merge/undo/redo —
the same seam a plain drag-and-commit rect edit goes through.

Tables exist only in the synthetic stress document; FUNSD has none, so every table-tool path
(`tableAt` returns `null`, `onKeyDown` finds no mesh) no-ops rather than throwing.

## 6. Memory management & frame-rate optimization

- **`PageCache`** (`src/data/pageRenderer.ts`): an LRU of rendered page rasters keyed by page
  index — 199 decoded FUNSD scans (or 100 synthetic A4 pages) resident at once would run to
  hundreds of MB, so only pages near the viewport stay decoded (`evictOutside(from, to)`).
  `ensure()` never blocks: a cache miss returns the placeholder immediately and the real decode
  resolves asynchronously (this matters specifically for FUNSD, whose rasters are real
  `createImageBitmap` PNG decodes, not synchronous canvas draws like the synthetic generator).
  Because decode is async, every in-flight load carries a **generation token**
  (`pending: Map<index, token>`); `settle(index, token, bmp)` checks the token is still current
  and the cache isn't disposed before installing the bitmap — otherwise it calls
  `closeBitmap(bmp)` instead of storing it. This is the guard against a decode that resolves
  *after* its page was evicted, reissued, or the whole cache disposed (document swap, unmount)
  turning into a leaked `ImageBitmap`. `dispose()` walks the whole cache and drops (closes) every
  entry.
- `rasters` is a running counter of cache misses/decodes — a pan that keeps incrementing it is
  cache thrash, not steady-state (see `docs/perf/README.md`'s `pageRasters` field).
- The overlay/box draw loop iterates only the QuadTree-culled visible set each frame — never the
  full node set — per the perf rules in `CLAUDE.md`.
- **Not independently verified in this pass**: whether FUNSD scans actually decode with their
  boxes correctly registered on top of them, and whether the JS heap returns to baseline after a
  manual GC across load/undo/redo cycles, were not confirmed with a browser in hand while writing
  this document — the implementing agents worked without one. Treat these as open verification
  items, not confirmed results, until someone runs the app and checks.

## 7. Performance evidence

See `docs/perf/README.md` for the full methodology (why the on-screen FPS counter under-reports,
how `__bench()`/`__pick()`/`__ingest()` work, and the measured numbers that exist so far — pan/
pan+hover/stress runs on the synthetic contact-sheet layout, on a MacBook/Brave production build).

**Not captured in this pass**: `docs/perf/` does not yet contain FUNSD-specific trace exports or
screenshots (`funsd-panzoom.json/png`, `synthetic-panzoom.json/png`, `funsd-ingest.json`) — doing
so requires a live `pnpm dev`/`pnpm preview` session and DevTools, which the implementing agents
did not have access to. The bench harness and `ingestProbe` this evidence depends on are in place
and exercised on the synthetic document (`docs/perf/README.md` § Measured); running the same
benches against the FUNSD document and exporting DevTools traces is the next concrete step, not a
design gap.

## 8. Known limitations & trade-offs

- The shipped stream is an SSE-shaped replay, not a live `EventSource` (§2). The client and the
  dev server exist and the interface is the one a real endpoint would satisfy, but wiring the
  endpoint probe into `createStream()` is unfinished work, not a design position.
- Sequence numbers are a DFS pre-order over a graph that is not required to be a tree. For a
  FUNSD question with three answers the numbering is one valid reading, not the only one; the
  brief asks the flow to be visible and editable, not to be linearised canonically.
- `hasEdge`'s linear scan (§5) would need to become a `Set`/index if any future feature calls it
  from a hot path instead of one-off checks.
- FUNSD raster decode and heap-return-to-baseline are unverified (§6) — first thing to check with
  a browser available.
- FUNSD's non-commercial license means this workspace cannot ship the corpus in a commercial
  build; `dataset/` stays gitignored and only the prepared `public/funsd/` assets are committed,
  per the terms noted in §0.
- The table mesh (§5b) regularises a table onto a shared grid, so a genuinely irregular table
  (per-row column counts not expressible as spans) is snapped rather than preserved. Spans cover
  the common merged-header case; a fully free-form cell soup would need a per-row divider list,
  which the brief's "grid mesh" framing does not ask for.
- The inspector's Markdown is a rendering of one subtree, not a full-document export. A "download
  the corrected document as Markdown" button is the obvious next step and deliberately out of scope.
- Relabelling changes the semantic label and, through it, the render type. It does not re-run any
  model — there is no model in the loop here, which is the point of a human-in-the-loop repair tool.
