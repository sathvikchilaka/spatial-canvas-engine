# Assignment (source of truth)

**Sarvam Vision — Senior Frontend Engineer (Vision Workspaces & HITL Systems)**
Timebox: 48h. Verbatim requirements from the brief; do not edit to match what we built.

## Objective
Build a high-performance, real-time **Document Layout Repair Workspace** in React/TypeScript.
Render high-res multi-page document scans + 10,000+ interactive overlay bounding boxes, hold
60 FPS during pan/zoom, stream extraction progress over SSE/WebSocket, offload heavy state math
to Web Workers, and provide tools to edit boxes, table meshes, and directed reading-order graphs.

## Module A — Virtualized Spatial Canvas Engine (Canvas2D or WebGL)
- Render multi-page pages overlaid with up to **10,000** boxes (paragraphs, lines, table cells, key-value labels).
- **60 FPS pan & zoom**; pinch/wheel zoom from **10% to 500%**.
- **Spatial viewport culling** — only draw objects intersecting the active viewport.
- **DOM-based rendering for overlay boxes is strictly forbidden** (paint bottleneck).
- **High-DPI / Retina scaling** — crisp image textures and vector strokes, no blur.

## Module B — Interactive Structural Repair Tools
- **Bounding box editor**: click, drag-to-resize, move, re-label. Spatial snapping guidelines
  (snap box edges to nearby text blocks).
- **Directed reading-order graph**: arrows connecting blocks 1 → 2 → 3; drag connection handles
  to re-parent linkages visually.
- **Table grid mesh corrector**: editable grid mesh over detected tables; drag row/column dividers,
  split cells, merge cells, with instant bounding-box recalculation.

## Module C — Web Worker & Real-Time Streaming
- **Offloaded parsing**: incoming JSON extraction payloads (thousands of nodes) parsed, indexed,
  and transformed **inside a Web Worker**.
- **Spatial index in worker**: QuadTree or R-Tree for **O(log N)** point-in-polygon hit-testing on click.
- **Live SSE/WebSocket ingestion**: mock stream pushes **out-of-order** page extraction events;
  canvas renders partial page updates live without freezing the UI thread.

## Module D — Bi-Directional Grounding & Transactional History
- **Bi-directional highlight sync**: hover/click a box → scroll-into-view + highlight the node in a
  side-by-side JSON/Markdown hierarchical Tree View, and vice versa.
- **Transactional undo/redo**: immutable store (Zustand/Immer/custom tree engine), **≥50 levels**,
  covering all canvas mutations (box drag, re-ordering, table line splits).

## Permitted stack
- Framework: **React + TypeScript**.
- Rendering: HTML5 Canvas 2D **or** WebGL / Pixi.js / Konva.js. (Raw DOM overlays for 10k boxes penalized.)
- State: Zustand, Redux Toolkit, XState, or custom state machine + Immer.
- Workers: native Web Workers or **comlink**.
- Testing: Vitest / React Testing Library / Playwright.

## LLM policy
LLM use is permitted. The brief explicitly notes LLMs struggle with canvas coordinate transforms,
quadtree indexing, worker message passing, and frame-rate optimization. Evaluation is primarily on
**viewport fluidity, clean architecture, and responsiveness** — not on breadth of features.

## Deliverables
- [ ] GitHub repo, clean React + TS source.
- [ ] Live demo or easy local run (`npm run dev`, or Docker build).
- [ ] **Stress Test Document** toggle in the UI: 100 pages, 10,000 boxes, pre-loaded.
- [ ] **ARCHITECTURE.md** covering: viewport transformation matrix & render pipeline; worker
      communication strategy; spatial indexing structure; memory + frame-rate techniques.
- [ ] **Performance evidence**: Chrome DevTools Performance profiler screenshot / trace export
      proving frame stability under active canvas operations.

## Scoring
| Metric | Target | Weight |
|---|---|---|
| Viewport frame rate | constant 60 FPS, continuous pan/zoom, 10k boxes | 25% |
| Main-thread blocking | < 16ms long tasks during live SSE ingestion | 20% |
| Spatial hit-testing | < 2ms click-to-selection across 10,000 nodes | 15% |
| Memory footprint | zero leaks across repeated load/undo/redo cycles | 10% |

Remaining 30% qualitative (code review + deep-dive interview):
- **Canvas coordinate math** — clean world↔viewport transforms, zoom-to-cursor, devicePixelRatio.
- **Software architecture** — hard isolation between UI DOM, worker thread, and canvas engine.
- **UX precision** — pixel-perfect handles, responsive hover, smooth snapping, crisp high-DPI.
- **State rigor** — transactional undo/redo; no corrupted layout state when stream updates land.
