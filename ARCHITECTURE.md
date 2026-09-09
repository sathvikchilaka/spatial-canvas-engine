# Architecture

> **Status: skeleton.** This is a graded deliverable (see `docs/ASSIGNMENT.md`). Every section
> below must be filled with what was actually built, not intentions. Delete this banner when done.

## 1. Viewport transformation & canvas rendering pipeline
- World space vs screen space definition; page layout in world coordinates.
- The transform matrix (`scale`, `tx`, `ty` / DOMMatrix), and the single source of truth for it.
- Zoom-to-cursor derivation; clamping to 10%–500%.
- devicePixelRatio handling: backing-store size vs CSS size, stroke alignment for crisp 1px edges.
- Frame loop: rAF scheduling, dirty-rect vs full redraw, layer separation (page raster / boxes /
  overlays / interaction HUD).
- Culling: which index answers "what intersects the viewport", and its per-frame cost.

## 2. Web Worker thread communication strategy
- Thread ownership: what lives on the worker (parse, index, hit-test) vs main (render, input).
- Transport: native `postMessage` vs comlink; message schema and versioning.
- Payload representation (typed arrays / transferables) and why, with structured-clone cost notes.
- Backpressure and out-of-order SSE event handling; how partial pages become renderable state.
- Cancellation and teardown (worker lifecycle, avoiding orphaned listeners).

## 3. Spatial indexing for hit-testing
- Structure chosen (QuadTree / R-Tree) and the parameters (max depth, bucket size, bulk-load).
- Build cost vs query cost; incremental insert on streamed pages.
- Point-in-polygon query path and how < 2ms click-to-selection is achieved and measured.
- Invalidation on mutation (box drag, split, merge) without full rebuilds.

## 4. State & transactional history
- Store shape, immutability strategy (Immer patches vs snapshots), and why.
- Undo/redo stack: ≥50 levels, what constitutes one transaction, coalescing during drags.
- Conflict rule: how streamed updates merge without corrupting locally edited nodes.

## 5. Memory management & frame-rate optimization
- Allocation discipline in the frame loop; object pooling if used.
- Image/texture handling for 100 pages (decode, cache eviction, `createImageBitmap`).
- Leak avoidance across load/undo/redo cycles, and how it was verified.
- Techniques applied, each with a before/after number.

## 6. Performance evidence
- Chrome DevTools Performance traces: link the screenshots / exported `.json` under `docs/perf/`.
- Numbers against each benchmark: FPS during pan/zoom @10k boxes, long-task duration during SSE
  ingestion, hit-test latency, heap across cycles.

## 7. Known limitations & trade-offs
- What was deliberately cut inside the 48h box, and what would be done next.
