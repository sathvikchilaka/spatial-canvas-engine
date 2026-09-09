# spatial-canvas-engine

HITL **Document Layout Repair Workspace** — 48h takeaway assignment for Sarvam Vision
(Senior Frontend Engineer, Vision Workspaces & HITL Systems).

Full brief: `docs/ASSIGNMENT.md` (source of truth — read before proposing scope).
Design/architecture decisions: `ARCHITECTURE.md` (a graded deliverable, keep it current).

## What this is
Renders multi-page document scans with **10,000+ interactive bounding-box overlays** at a
sustained 60 FPS, fed by a live SSE stream of out-of-order extraction events, with all parsing
and spatial indexing on a Web Worker, plus editing tools (box editor, reading-order graph,
table mesh) backed by ≥50-level undo/redo.

## Non-negotiables (graded)
- **No DOM overlays for boxes.** Canvas2D/WebGL only. A `<div>` per box fails the brief.
- **60 FPS pan/zoom @ 10k boxes**, zoom 10%–500%, zoom-to-cursor.
- **Viewport culling** every frame — never iterate all nodes in the draw loop.
- **devicePixelRatio-correct** canvas sizing; crisp strokes and textures.
- **< 16ms** main-thread long tasks while SSE payloads ingest.
- **< 2ms** click → selection via worker-side QuadTree/R-Tree.
- **Zero leaks** across repeated load/undo/redo cycles.
- Worker owns parsing + spatial index. Main thread owns render + interaction. Keep the seam clean.

## Stack (already scaffolded)
Vite 8 · React 19 · TypeScript · Tailwind 4 · shadcn/ui (`radix-vega` style, base `stone`, RTL on)
· lucide icons · Inter variable · ESLint + Prettier.

Not yet added — pick per `ARCHITECTURE.md`: rendering lib (raw Canvas2D vs Pixi/Konva),
state (Zustand + Immer), worker transport (native vs comlink), tests (Vitest/Playwright).

## Commands
```bash
pnpm dev        # vite dev server
pnpm build      # tsc -b && vite build
pnpm typecheck  # tsc --noEmit
pnpm lint
pnpm format
```
Package manager is **pnpm**. Use `pnpm dlx shadcn@latest add <component>` for UI primitives —
don't hand-write shadcn components.

## Conventions
- Path alias `@/` → `src/`. UI primitives in `src/components/ui` (generated, avoid editing).
- Always merge classes with `cn()` from `@/lib/utils`.
- Dark-first, achromatic surfaces, tokens only (`bg-background`, `border-border`, …) — no hex.
- Keep the canvas engine framework-agnostic: plain TS modules, React only at the mount boundary.
  No React state in the per-frame path.
- Plans live in `plans/` as `plans/<YYYY_MM_DD>_feature-<name>-plan.md`; tick checkboxes as phases land.

## Perf rules for anyone touching the render path
- No allocations inside the frame loop (no `.map`/`.filter`/object literals per box per frame).
- Batch canvas state changes; group draws by style, not by node.
- Transforms are matrices — one world↔screen source of truth, no ad-hoc `x * zoom + panX` sprinkled around.
- Structured-clone cost is real: prefer transferable typed arrays over arrays of objects for worker payloads.
- Measure before and after with the DevTools profiler; performance evidence is a deliverable.
