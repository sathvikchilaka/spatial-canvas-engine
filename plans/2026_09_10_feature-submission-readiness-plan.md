# Submission Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every non-code deliverable the brief names and the audit found missing: a real README, a working `Dockerfile`, an end-to-end Playwright smoke test, the captured performance evidence that `docs/perf/README.md` currently promises in empty table rows, and a deployed demo link.

**Architecture:** Five independent tasks, no shared code. The only sequencing constraint is that the perf capture (Task 4) should run against the **final** build, so run it after the feature plans land — everything else can go at any time. Tasks 1–3 are automatable; Task 4 needs a human with a browser and DevTools, and this plan says exactly which buttons to press and which files to produce rather than pretending an agent can do it.

**Tech Stack:** Playwright, Docker, nginx (static serve), Vite 8, Vitest.

**Spec:** `docs/ASSIGNMENT.md` "Deliverables" (GitHub repo; `npm run dev` or Docker; pre-loaded 100-page/10,000-box Stress Test Document behind a toggle; `ARCHITECTURE.md` covering the four named topics; Flamegraph or DevTools performance evidence). Design context: `docs/perf/README.md`.

## Global Constraints

- Package manager **pnpm**. `pnpm test`, `pnpm typecheck`, `pnpm lint` green at every commit.
- The brief says `npm run dev` **or** Docker. This repo is pnpm-only, so **Docker is the portable path** and the README must not tell a reviewer to run `npm install` against a `pnpm-lock.yaml`.
- FUNSD raw `dataset/` stays gitignored and is **non-commercial research use only**. The Docker image must not embed the corpus unless `public/funsd` has already been prepared locally; the README says how, and the container works without it (the synthetic Stress document is self-contained).
- Perf numbers are measured on a **production build** (`pnpm build && pnpm preview`), never dev.
- No new runtime dependencies. Playwright is a devDependency.

---

### Task 1: Playwright end-to-end smoke test

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/smoke.spec.ts`
- Modify: `package.json` (`test:e2e`), `.gitignore` (`playwright-report/`, `test-results/`)
- Modify: `eslint.config.js` (ignore `e2e/` from the React-hooks rules if it complains)

**Interfaces:**
- Produces: `pnpm test:e2e` runs Playwright against a `pnpm preview` server it starts itself. `pnpm test` stays Vitest-only, so CI and the unit loop are unaffected.
- The spec asserts the graded user-visible behaviours end to end: the app boots, the Stress document toggle loads 10k+ boxes, a click selects in under 2ms-ish (asserted via the exposed `__pick()` harness rather than wall-clock flake), pan/zoom does not throw, and undo/redo round-trips an edit.

- [x] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

- [x] **Step 2: Write the config**

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

/**
 * Runs against the production build, not the dev server: the perf harness is
 * gated behind `?bench=1` in production, dev has different chunking, and the
 * numbers this suite asserts are only meaningful on the shipped bundle.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    // DPR 2 so the devicePixelRatio path is the one under test.
    deviceScaleFactor: 2,
    viewport: { width: 1440, height: 900 },
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
```

- [x] **Step 3: Write the spec**

```ts
// e2e/smoke.spec.ts
import { expect, test, type Page } from '@playwright/test'

/** The bench flag exposes `__bench`/`__pick`/`__ingest` on a production build. */
const APP = '/?bench=1'

type Status = { connected: boolean; done: boolean; pagesReceived: number; nodeCount: number }

declare global {
  interface Window {
    __status?: () => Status
    __pick?: (n?: number) => Promise<{
      worker: { p50: number; p95: number; max: number; over2ms: number }
      endToEnd: { p50: number; p95: number; max: number; over2ms: number }
      hits: number
      samples: number
    }>
    __bench?: (o?: Record<string, unknown>) => Promise<{ fps: number; draw: { p95: number; max: number }; visible: { avg: number }; longTasks: number }>
  }
}

/** Waits for the stream to finish rather than for a fixed time — arrival is jittered. */
async function waitForStream(page: Page) {
  await expect(page.getByText(/stream complete/i)).toBeVisible({ timeout: 60_000 })
}

test.describe('spatial canvas engine', () => {
  test('boots and renders the canvas at the device pixel ratio', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(String(e)))

    await page.goto(APP)
    const canvas = page.locator('canvas').first()
    await expect(canvas).toBeVisible()

    // devicePixelRatio-correct sizing: the backing store is 2x the CSS box.
    const scaled = await canvas.evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect()
      return { ratio: el.width / r.width, dpr: window.devicePixelRatio }
    })
    expect(scaled.ratio).toBeCloseTo(scaled.dpr, 1)
    expect(errors).toEqual([])
  })

  test('the Stress Test Document toggle loads 10,000+ boxes', async ({ page }) => {
    await page.goto(APP)
    // The brief asks for a pre-loaded 100-page / 10,000-box document behind a
    // toggle button — this is that button.
    await page.getByRole('button', { name: /stress/i }).click()
    await waitForStream(page)

    const status = await page.evaluate(() => window.__status?.())
    expect(status?.pagesReceived).toBe(100)
    expect(status?.nodeCount).toBeGreaterThan(10_000)
  })

  test('pan and zoom sustain the frame budget under the full load', async ({ page }) => {
    await page.goto(APP)
    await page.getByRole('button', { name: /stress/i }).click()
    await waitForStream(page)

    const bench = await page.evaluate(() => window.__bench?.({ ms: 4000 }))
    expect(bench!.fps).toBeGreaterThan(55)
    // 16.6ms is the budget; assert well inside it so this fails on a regression,
    // not on CI noise.
    expect(bench!.draw.p95).toBeLessThan(8)
    expect(bench!.longTasks).toBe(0)
    expect(bench!.visible.avg).toBeGreaterThan(0)
  })

  test('click-to-selection stays inside the hit-test budget', async ({ page }) => {
    await page.goto(APP)
    await page.getByRole('button', { name: /stress/i }).click()
    await waitForStream(page)

    const pick = await page.evaluate(() => window.__pick?.(200))
    // Every sampled box must actually be hit — a shortfall means the worker
    // index and the rendered geometry disagree, which is a correctness bug.
    expect(pick!.hits).toBe(pick!.samples)
    expect(pick!.worker.p95).toBeLessThan(2)
    expect(pick!.endToEnd.p95).toBeLessThan(16)
  })

  test('an edit survives undo and redo', async ({ page }) => {
    await page.goto(APP)
    await page.getByRole('button', { name: /stress/i }).click()
    await waitForStream(page)

    const canvas = page.locator('canvas').first()
    const box = (await canvas.boundingBox())!

    // Click near the middle, then drag the selection a little.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const selected = await page.evaluate(() => window.__status?.())
    expect(selected).toBeTruthy()

    const before = await page.evaluate(() => Object.keys((window as unknown as { __edits?: () => object }).__edits?.() ?? {}).length)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 8 })
    await page.mouse.up()

    const after = await page.evaluate(() => Object.keys((window as unknown as { __edits?: () => object }).__edits?.() ?? {}).length)
    expect(after).toBeGreaterThan(before)

    await page.keyboard.press('Meta+z')
    expect(
      await page.evaluate(() => Object.keys((window as unknown as { __edits?: () => object }).__edits?.() ?? {}).length),
    ).toBe(before)

    await page.keyboard.press('Meta+Shift+z')
    expect(
      await page.evaluate(() => Object.keys((window as unknown as { __edits?: () => object }).__edits?.() ?? {}).length),
    ).toBe(after)
  })
})
```

- [x] **Step 4: Expose the two harness hooks the spec needs**

The spec reads `window.__status()` and `window.__edits()`. `src/app/bench.ts` already installs `__bench`/`__pick`/`__ingest`; add the two read-only accessors next to them, behind the same gate:

```ts
  /** Read-only status for the e2e suite — the same object the status bar renders. */
  w.__status = () => session.status
  /** Read-only edit map, so the suite can assert undo/redo without reading the DOM. */
  w.__edits = () => useStore.getState().edits
```

If `session.status` does not currently include `nodeCount`, add it (`nodeCount: this.nodes.count`) — the status bar wants it anyway.

- [x] **Step 5: Scripts and ignores**

`package.json`:

```json
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
```

`.gitignore`:

```
playwright-report/
test-results/
```

- [x] **Step 6: Run it**

Run: `pnpm test:e2e`
Expected: 5 passing. If the perf assertions flake on a loaded machine, loosen the *thresholds* with a comment recording the observed value — never delete the assertion.

- [x] **Step 7: Commit**

```bash
git add playwright.config.ts e2e package.json .gitignore src/app/bench.ts
git commit -m "test(e2e): Playwright smoke suite covering load, perf budgets and undo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Rewrite the README

**Files:**
- Rewrite: `README.md`

**Interfaces:** None. It is still the untouched `React + TypeScript + Vite + shadcn/ui` template — the first thing a reviewer opens.

- [x] **Step 1: Write it**

```markdown
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

### Docker

No local toolchain needed:

```bash
docker build -t spatial-canvas-engine .
docker run --rm -p 8080:80 spatial-canvas-engine   # http://localhost:8080
```

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
await __bench()        // pan/zoom frame timings
await __pick(200)      // click→selection latency, worker and end-to-end
__ingest()             // main-thread long tasks during stream ingest
```

`docs/perf/README.md` explains every field, why the on-screen FPS counter is *not* the metric,
and what the numbers were on the reference machine.

## Licence & data

Code: for assignment review. **FUNSD data is non-commercial research use only** and is not
redistributed here.
```

Replace the demo-link placeholder in Task 5. Do not leave the HTML comment in the final commit of that task.

- [x] **Step 2: Check every command in it actually runs**

```bash
pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

Any command the README names that fails is a broken promise on the first page — fix the command or the README, not the reviewer's expectations.

- [x] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: replace the template README with real project documentation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Dockerfile

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker/nginx.conf`

**Interfaces:** `docker build -t spatial-canvas-engine . && docker run --rm -p 8080:80 spatial-canvas-engine` serves the production build on port 80. The app is a static SPA — no server-side rendering, no API — so nginx serving `dist/` is the whole runtime.

- [x] **Step 1: Write `.dockerignore`**

```
node_modules
dist
dataset
.git
.github
playwright-report
test-results
docs/perf/*.json
*.log
```

`dataset/` is excluded explicitly: it is the FUNSD corpus, non-commercial research use only, and must not end up baked into a distributable image. `public/funsd/` (the *prepared* assets) is **not** excluded, so an image built after `pnpm prepare:funsd` includes both documents and an image built without it still ships the synthetic one.

- [x] **Step 2: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1

# The app is a static SPA — no SSR, no API — so the runtime stage is just nginx
# serving `dist/`. Two stages keeps the toolchain out of the shipped image.
FROM node:22-alpine AS build
WORKDIR /app

# corepack pins pnpm from package.json's own field, so the lockfile is honoured.
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# `pnpm build` runs `tsc -b` first, so a type error fails the image rather than
# shipping a broken bundle.
RUN pnpm build

FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ >/dev/null || exit 1
```

- [x] **Step 3: Write `docker/nginx.conf`**

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;

  # Hashed bundles are immutable; the entry HTML must never be cached or a
  # reviewer sees a stale build after a redeploy.
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # The FUNSD page scans are large PNGs fetched one page at a time.
  location /funsd/ {
    expires 7d;
    add_header Cache-Control "public";
  }

  location / {
    try_files $uri $uri/ /index.html;
    add_header Cache-Control "no-cache";
  }

  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;
  gzip_min_length 1024;
}
```

There is no `/events` proxy: the SSE feed is a dev-server process (see `ARCHITECTURE.md` §2), so a container serves the replay transport. The status bar says `replay`, which is honest.

- [x] **Step 4: Build and run it**

```bash
docker build -t spatial-canvas-engine .
docker run --rm -p 8080:80 spatial-canvas-engine
```

Open `http://localhost:8080`, click **Stress**, confirm the document streams in and pan/zoom is smooth. Confirm the FUNSD entry degrades gracefully if `public/funsd` was absent at build time.

- [x] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker/nginx.conf
git commit -m "build: containerize the production build behind nginx

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Capture the performance evidence

**Files:**
- Create: `docs/perf/synthetic-panzoom.json`, `docs/perf/synthetic-panzoom.png`
- Create: `docs/perf/funsd-panzoom.json`, `docs/perf/funsd-panzoom.png`
- Create: `docs/perf/funsd-ingest.json`, `docs/perf/funsd-ingest.png`
- Create: `docs/perf/memory-cycles.png`
- Modify: `docs/perf/README.md` (fill the empty "Contact-sheet layout, 10k+ boxes" table; replace the "FUNSD document — not yet captured" section with results)
- Modify: `.gitignore` — **remove** any `docs/perf/*.json` entry if one exists; these traces are the deliverable.

**Interfaces:** None. This task is a human with a browser. It is written as a script precisely because an agent cannot do it — do not let an agent "complete" it by editing the tables without the files existing.

> **This is the single most-cited gap in the audit.** The brief names "Flamegraph or DevTools performance recording" as a deliverable, and `docs/perf/` currently holds a `.gitkeep` and a README with empty rows. A strong methodology write-up with no captured artifact reads as an untested claim.

- [ ] **Step 1: Build and serve the real bundle**

```bash
pnpm prepare:funsd          # so the FUNSD runs are possible
pnpm build && pnpm preview  # http://localhost:4173
```

Numbers from `pnpm dev` are meaningless here — different chunking, no minification, dev-only instrumentation. Record the machine, browser and DPR; the README's "Measured" section states them and yours must too if they differ.

- [ ] **Step 2: Capture the synthetic contact-sheet runs**

Open `http://localhost:4173/?bench=1`, click **Stress · 100pp · 10k boxes**, wait for `stream complete`. Zoom out to ~10% so the contact sheet fills the viewport, then in the console:

```js
copy(JSON.stringify({
  panzoom:      await __bench({ ms: 5000 }),
  panzoomHover: await __bench({ ms: 5000, hover: true }),
  stress:       await __bench({ ms: 5000, stress: true }),
}, null, 2))
```

Paste into `docs/perf/synthetic-panzoom.json`. Check `visible.avg` is in the thousands — if it is in the dozens you are measuring blank canvas, which is the exact trap the README already documents. Then, with a DevTools **Performance** recording running across one `__bench({ ms: 5000 })`, screenshot the flame chart to `docs/perf/synthetic-panzoom.png`.

- [ ] **Step 3: Capture the FUNSD runs**

Reload, click **FUNSD · 199pp · 41k boxes**, wait for `stream complete`, then the same three benches into `docs/perf/funsd-panzoom.json`, plus a flame-chart screenshot to `docs/perf/funsd-panzoom.png`. Sweep the zoom by hand from 10% → 500% → 10% and confirm the boxes stay registered on the page scans at every level; that claim is currently marked unverified in the README.

- [ ] **Step 4: Capture the ingest trace (the graded < 16ms claim)**

This one must start **before** the first payload lands, so: open DevTools → Performance, tick **Screenshots**, press record, *then* reload the page with the FUNSD document selected. Stop recording once `stream complete` appears. In the console:

```js
copy(JSON.stringify(__ingest(), null, 2))
```

Paste into `docs/perf/funsd-ingest.json`. Export the DevTools trace ("Save profile") next to it if it is under ~10MB; otherwise screenshot the main-thread track to `docs/perf/funsd-ingest.png` with the longest task selected so its duration is legible. A clean run is `over16: 0` **and** an empty `frameGaps` — if it is not clean, say so in the table and note the worst task; a measured failure is worth more than an unmeasured claim.

- [ ] **Step 5: Capture the zero-leak evidence**

DevTools → Memory. Take a heap snapshot after load. Then: switch documents back and forth 5 times, do 20 box edits, press undo 20 times and redo 20 times, force GC (the bin icon in Performance), and take a second snapshot. Screenshot the two snapshot sizes side by side to `docs/perf/memory-cycles.png`. The claim is that the heap returns to roughly baseline; the README currently lists it as unverified.

- [ ] **Step 6: Fill the tables in `docs/perf/README.md`**

Replace `_To fill in from a run on the current build._` and the empty rows with the real numbers, and replace the whole "FUNSD document — not yet captured" section with a "FUNSD document" section listing the same table plus the ingest and memory results, each linking its artifact:

```markdown
### Contact-sheet layout, 10k+ boxes

Raw output: [`synthetic-panzoom.json`](./synthetic-panzoom.json) ·
flame chart: [`synthetic-panzoom.png`](./synthetic-panzoom.png)

| Run | fps | draw p50 / p95 / max | visible avg | truncated | long tasks |
| --- | --- | --- | --- | --- | --- |
| pan @ 10% zoom | | | | | |
| pan + hover @ 10% zoom | | | | | |
| stress (cull bypassed) | | | | | |

### FUNSD document — 199 pages, 41,228 boxes

Raw output: [`funsd-panzoom.json`](./funsd-panzoom.json) ·
flame chart: [`funsd-panzoom.png`](./funsd-panzoom.png)

| Run | fps | draw p50 / p95 / max | visible avg | truncated | long tasks |
| --- | --- | --- | --- | --- | --- |
| pan @ 10% zoom | | | | | |
| pan + hover @ 10% zoom | | | | | |
| stress (cull bypassed) | | | | | |

Boxes stay registered on the page scans across a 10% → 500% → 10% sweep. <!-- confirm or correct -->

#### Main-thread blocking during ingest

Probe output: [`funsd-ingest.json`](./funsd-ingest.json) ·
trace: [`funsd-ingest.png`](./funsd-ingest.png)

| window | count | over16 | over50 | max | frameGaps |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

#### Memory across load / undo / redo cycles

Snapshots: [`memory-cycles.png`](./memory-cycles.png)

| Snapshot | JS heap |
| --- | --- |
| after first load | |
| after 5 document switches + 20 edits + 20 undo + 20 redo, post-GC | |
```

Every "unverified" caveat that the captures now cover must come out of the README in the same commit — a stale caveat is as misleading as a missing number.

- [ ] **Step 7: Commit**

```bash
git add docs/perf .gitignore
git commit -m "docs(perf): capture the pan/zoom, ingest and memory evidence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Deploy the demo

**Files:**
- Modify: `README.md` (the live-demo link)
- Create: `.github/workflows/ci.yml`

**Interfaces:** A public URL serving the production build, and CI that proves `main` builds.

- [ ] **Step 1: Deploy the static build**

The app is fully static (the SSE feed is dev-only), so any static host works. Whichever you pick, the build command is `pnpm build` and the output directory is `dist`.

```bash
# Vercel
pnpm dlx vercel --prod

# or Cloudflare Pages
pnpm dlx wrangler pages deploy dist --project-name spatial-canvas-engine
```

If `public/funsd/` is present locally it ships with the build and both documents work on the demo; if not, the demo shows the synthetic Stress document only. Deploying **with** FUNSD publishes a non-commercial-research-only corpus to a public URL — that is the licence question to settle before shipping it, and it is listed as an unresolved question below.

- [ ] **Step 2: Put the URL in the README**

Replace the placeholder comment on the **Live demo** line with the real URL. Add a one-line note if the demo is synthetic-only:

```markdown
**Live demo:** https://… — the Stress Test Document is pre-loaded; the FUNSD corpus is not
redistributed on the demo (non-commercial research licence), so run it locally per below.
```

- [x] **Step 3: Add CI**

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm build

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      # The perf assertions are thresholded well inside budget, but a shared CI
      # runner is not a perf lab — a failure here is a signal to re-measure
      # locally, not proof of a regression.
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
```

- [ ] **Step 4: Verify**

Push the branch, confirm both jobs go green, and open the demo URL in a fresh browser profile — click **Stress**, confirm 10k boxes stream in and pan/zoom is smooth on a machine that is not yours.

- [ ] **Step 5: Commit**

```bash
git add README.md .github/workflows/ci.yml
git commit -m "ci: verify typecheck, lint, tests, build and e2e; link the live demo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Unresolved questions

- Publish FUNSD assets to the public demo (non-commercial research licence), or synthetic-only demo?
- Host: Vercel, Cloudflare Pages, or GitHub Pages?
- e2e perf assertions in CI — keep (flaky on shared runners) or gate behind a label?
- Commit the raw DevTools trace files (multi-MB) or screenshots only?
