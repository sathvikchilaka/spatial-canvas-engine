# Node Text, Relabelling and JSON/Markdown Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the extracted **text** and semantic **label** through the worker seam into the app, let a reviewer re-label a node (an undoable edit), and give Module D the side-by-side **JSON / Markdown** view the brief asks for — replacing the current tree that can only say `"Paragraph 1234"`.

**Architecture:** Three layers, each shippable alone.

1. **Payload.** `parseFunsdPage` already reads `entity.text` and `entity.label` and throws both away. `SerializedNode` gains `text?: string` and `label?: string`, and `PageIngested` gains two parallel arrays (`texts: string[]`, `labels: Uint8Array` over a small `SemanticLabel` enum). Strings cannot be transferred, only cloned — one string array per page (≤536 entries) is a rounding error next to the six typed arrays, and it keeps the *parse* on the worker, which is the property the brief grades.
2. **Store.** `Session` holds `texts: Map<number, string>` and `baseLabels: Map<number, SemanticLabel>` beside the typed arrays — text is variable-length and inherently non-numeric, so it does not belong in a `Float32Array`. `Edit.label` finally gets a writer and a reader: the label override drives `nodes.types[i]`, so re-labelling repaints the box colour immediately and undo restores it.
3. **UI.** The existing `TreeView` shows real text. A new `InspectorPanel` puts JSON and Markdown side by side behind the already-installed `tabs` primitive, rendering the **selected node's subtree** rather than the whole 41k-node document, and highlights bi-directionally with the canvas (clicking a row in either selects; the selection already drives the canvas HUD).

**Tech Stack:** TypeScript, React 19, Tailwind 4, Radix (`tabs`), Vitest, native Web Worker.

**Spec:** `docs/ASSIGNMENT.md` Module D ("bi-directional highlight sync … a side-by-side JSON/Markdown hierarchical tree view"). Design context: `ARCHITECTURE.md` §2, §6.

## Global Constraints

- Package manager **pnpm**. `pnpm test`, `pnpm typecheck`, `pnpm lint` green at every commit.
- **Worker owns parsing.** No `JSON.parse` of a document payload on the main thread; the text arrives already extracted.
- **No React state in the per-frame path.** The inspector subscribes narrowly (`selectedId` only) and renders the selected subtree, never per-frame data.
- No allocations in the frame loop — this plan touches no draw code except the type→colour lookup that already exists.
- UI: dark-first, tokens only (`bg-card`, `border-border`, `text-muted-foreground`), classes merged with `cn()`, `pnpm dlx shadcn@latest add` for anything not already in `src/components/ui`. `tabs.tsx` and `badge.tsx` are already installed — do not hand-write them.
- FUNSD is the document with real text; the synthetic generator has none. Every view must degrade to a type-and-id label when text is absent, exactly as today.
- FUNSD raw `dataset/` stays gitignored, non-commercial research use only. Test fixtures use `tests/data/funsd/fixture.json`.

---

### Task 1: Carry `text` and `label` across the worker seam

**Files:**
- Modify: `src/worker/protocol.ts`, `src/data/funsd/parse.ts`, `src/worker/index.worker.ts`, `src/worker/client.ts`
- Test: `tests/data/funsd/parse.test.ts`, `tests/worker/client.test.ts`

**Interfaces:**
- Produces in `src/worker/protocol.ts`:
  - `export const SemanticLabel = { None: 0, Question: 1, Answer: 2, Header: 3, Other: 4, Word: 5 } as const` and `export type SemanticLabel = (typeof SemanticLabel)[keyof typeof SemanticLabel]`
  - `SerializedNode` gains `text?: string` and `label?: SemanticLabel`
  - `PageIngested` gains `texts: string[]` (parallel to `ids`, `''` when absent) and `labels: Uint8Array`
- Produces in `src/data/funsd/parse.ts`: unchanged signature; `nodes[i].text` / `.label` are now populated. Word nodes get their own `word.text` and `SemanticLabel.Word`.

- [x] **Step 1: Write the failing parse test**

Append to `tests/data/funsd/parse.test.ts`:

```ts
import { SemanticLabel } from '@/worker/protocol'

describe('text and label passthrough', () => {
  it('keeps each entity\'s text and maps its label', () => {
    const parsed = parseFunsdPage(fixture as FunsdForm, 0, 0, 0)
    const entity = parsed.nodes.find((n) => n.parent === -1)!
    expect(entity.text).toBe(fixture.form[0].text)
    expect(entity.label).toBe(SemanticLabel.Question)
  })

  it('keeps each word\'s own text and labels it Word', () => {
    const parsed = parseFunsdPage(fixture as FunsdForm, 0, 0, 0)
    const word = parsed.nodes.find((n) => n.parent !== -1)!
    expect(word.text).toBe(fixture.form[0].words[0].text)
    expect(word.label).toBe(SemanticLabel.Word)
  })

  it('tolerates an entity with no text field', () => {
    const form = { form: [{ ...fixture.form[0], text: undefined, words: [] }] }
    const parsed = parseFunsdPage(form as unknown as FunsdForm, 0, 0, 0)
    expect(parsed.nodes[0].text).toBe('')
  })

  it('maps every FUNSD label to a SemanticLabel', () => {
    const labels = ['question', 'answer', 'header', 'other'] as const
    const got = labels.map((label) => {
      const form = { form: [{ ...fixture.form[0], label, words: [] }] }
      return parseFunsdPage(form as unknown as FunsdForm, 0, 0, 0).nodes[0].label
    })
    expect(got).toEqual([
      SemanticLabel.Question,
      SemanticLabel.Answer,
      SemanticLabel.Header,
      SemanticLabel.Other,
    ])
  })
})
```

(The fixture's first entity is a `question` — confirm with `head -40 tests/data/funsd/fixture.json` and, if it is not, use whichever label it actually has in the first assertion.)

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/data/funsd/parse.test.ts`
Expected: FAIL — `SemanticLabel` is not exported and `entity.text` is `undefined`.

- [x] **Step 3: Implement the protocol and parse changes**

In `src/worker/protocol.ts`:

```ts
/**
 * The extraction's semantic label, as a small integer so it can ride a
 * `Uint8Array` across the seam. FUNSD's four classes plus `Word` for the
 * child word boxes and `None` for documents that carry no labels at all
 * (the synthetic stress corpus).
 */
export const SemanticLabel = {
  None: 0,
  Question: 1,
  Answer: 2,
  Header: 3,
  Other: 4,
  Word: 5,
} as const
export type SemanticLabel = (typeof SemanticLabel)[keyof typeof SemanticLabel]

export type SerializedNode = {
  id: number
  page: number
  x: number
  y: number
  w: number
  h: number
  type: number
  parent: number
  order: number
  /** Extracted text, if the source has any. */
  text?: string
  label?: SemanticLabel
}
```

and on `PageIngested`:

```ts
  /**
   * Text parallel to `ids`, `''` where the source has none. Strings cannot be
   * transferred, only structured-cloned — but one array of ≤536 short strings
   * per page is negligible beside the six typed arrays, and cloning it here is
   * what keeps `JSON.parse` off the main thread.
   */
  texts: string[]
  /** `SemanticLabel` parallel to `ids`. */
  labels: Uint8Array
```

In `src/data/funsd/parse.ts`:

```ts
import { SemanticLabel, type SerializedNode } from '@/worker/protocol'

const LABEL_OF: Record<FunsdEntity['label'], SemanticLabel> = {
  question: SemanticLabel.Question,
  answer: SemanticLabel.Answer,
  header: SemanticLabel.Header,
  other: SemanticLabel.Other,
}
```

In the entity push add `text: entity.text ?? '', label: LABEL_OF[entity.label] ?? SemanticLabel.Other`, and in the word push add `text: word.text ?? '', label: SemanticLabel.Word`.

- [x] **Step 4: Populate the arrays in the worker**

In `src/worker/index.worker.ts`, wherever the `pageIngested` reply is built, add alongside the existing arrays:

```ts
  const texts = new Array<string>(nodes.length)
  const labels = new Uint8Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    texts[i] = nodes[i].text ?? ''
    labels[i] = nodes[i].label ?? SemanticLabel.None
  }
```

and include `texts, labels` in the posted message. `texts` is **not** added to the transfer list (strings are not transferable); `labels.buffer` **is**, next to the existing five buffers — the transfer list grows from 6 to 7 entries.

- [x] **Step 5: Extend the client test and any fake page builders**

`tests/worker/client.test.ts` and `tests/app/session.test.ts` both hand-build `pageIngested` replies. Add to each:

```ts
            texts: nodes.map((n) => n.text ?? ''),
            labels: Uint8Array.from(nodes.map((n) => n.label ?? 0)),
```

In `tests/worker/client.test.ts` add a case:

```ts
  it('forwards texts and labels to the ingest handler', async () => {
    // Extend the existing fake reply with the two new fields and assert the
    // handler receives them verbatim — the seam is the only place text can be
    // silently dropped, and it already was once.
    const received: string[][] = []
    client.onPageIngested((p) => received.push([...p.texts]))
    postFakePage({ texts: ['Name:', 'Name'], labels: Uint8Array.of(1, 5) })
    await Promise.resolve()
    expect(received[0]).toEqual(['Name:', 'Name'])
  })
```

Match the file's existing helper names — if it does not have `postFakePage`, inline the same fake-reply construction the neighbouring tests use.

- [x] **Step 6: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/worker src/data/funsd/parse.ts tests
git commit -m "feat(worker): carry extracted text and semantic labels across the seam

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Hold text and labels in the session, and let `Edit.label` win

**Files:**
- Modify: `src/app/session.ts`
- Test: `tests/app/session.test.ts`

**Interfaces:**
- Consumes: `PageIngested.texts` / `.labels`, `SemanticLabel` (Task 1).
- Produces on `Session`:
  - `textOf(id: number): string` — `''` when unknown.
  - `labelOf(id: number): SemanticLabel` — the **effective** label: `edits[id].label` if set, else the streamed one.
  - `baseLabelOf(id: number): SemanticLabel` — the streamed one, for "modified" chrome.
  - `setLabel(id: number, label: SemanticLabel): void` — one `commit('relabel')`, writing `edits[id].label` (as the label's string name, so the store stays JSON-legible) and `dirtyAt[id]`.
  - `LABEL_NAMES: readonly string[]` exported from `src/data/labels.ts` (new), plus `labelFromName(name: string): SemanticLabel` and `labelName(l: SemanticLabel): string`.
- Behaviour: `applyEdits` maps the effective label onto `nodes.types[i]` via `TYPE_OF_LABEL`, so a re-label repaints. Undo removes the edit and the type reverts.

- [x] **Step 1: Write the failing test**

Append to `tests/app/session.test.ts`:

```ts
describe('labels', () => {
  it('relabelling changes the node type, repaints, and is undoable', async () => {
    useStore.setState(
      { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
      true,
    )
    resetHistory()
    vi.useFakeTimers()
    try {
      const s = new Session(canvas(), createSyntheticDocument(4, 1))
      await s.ready
      await s.connectStream()
      for (let i = 0; i < 40 && s.nodes.count === 0; i++) await vi.advanceTimersByTimeAsync(50)

      const id = s.nodes.ids[0]
      const baseType = s.nodes.types[0]

      s.setLabel(id, SemanticLabel.Header)
      expect(s.labelOf(id)).toBe(SemanticLabel.Header)
      expect(s.baseLabelOf(id)).not.toBe(SemanticLabel.Header)
      expect(s.nodes.types[0]).toBe(NodeType.Paragraph)
      expect(useStore.getState().dirtyAt[id]).toBeGreaterThan(0)

      undo()
      expect(s.labelOf(id)).toBe(s.baseLabelOf(id))
      expect(s.nodes.types[0]).toBe(baseType)

      redo()
      expect(s.nodes.types[0]).toBe(NodeType.Paragraph)
      s.dispose()
    } finally {
      vi.useRealTimers()
      useStore.setState(
        { edits: {}, dirtyAt: {}, selectedId: null, hoveredId: null, edgesAdded: [], edgesRemoved: [] },
        true,
      )
      resetHistory()
    }
  })

  it('returns empty text for a document with none, without throwing', async () => {
    const s = new Session(canvas(), createSyntheticDocument(1, 1))
    await s.ready
    expect(s.textOf(123456)).toBe('')
    expect(s.labelOf(123456)).toBe(SemanticLabel.None)
    s.dispose()
  })
})
```

Add `SemanticLabel` (from `@/worker/protocol`) and `NodeType` to the file's imports.

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/app/session.test.ts`
Expected: FAIL — `s.setLabel is not a function`.

- [x] **Step 3: Create `src/data/labels.ts`**

```ts
import { NodeType } from '@/data/nodes'
import { SemanticLabel } from '@/worker/protocol'

/** Display names, indexed by `SemanticLabel`. Also the store's on-the-wire form. */
export const LABEL_NAMES = ['none', 'question', 'answer', 'header', 'other', 'word'] as const

export function labelName(l: SemanticLabel): string {
  return LABEL_NAMES[l] ?? 'none'
}

export function labelFromName(name: string): SemanticLabel {
  const i = LABEL_NAMES.indexOf(name as (typeof LABEL_NAMES)[number])
  return (i < 0 ? SemanticLabel.None : i) as SemanticLabel
}

/**
 * The render type a label implies. Type drives the box colour, so re-labelling
 * a node has to move its type too — otherwise the reviewer's correction is
 * invisible on the canvas, which is where they are looking.
 */
export const TYPE_OF_LABEL: Record<SemanticLabel, NodeType> = {
  [SemanticLabel.None]: NodeType.Paragraph,
  [SemanticLabel.Question]: NodeType.KeyValue,
  [SemanticLabel.Answer]: NodeType.KeyValue,
  [SemanticLabel.Header]: NodeType.Paragraph,
  [SemanticLabel.Other]: NodeType.Paragraph,
  [SemanticLabel.Word]: NodeType.Line,
}

/** The labels a reviewer may choose. `Word` and `None` are structural, not choices. */
export const ASSIGNABLE: readonly SemanticLabel[] = [
  SemanticLabel.Question,
  SemanticLabel.Answer,
  SemanticLabel.Header,
  SemanticLabel.Other,
]
```

- [x] **Step 4: Implement in `src/app/session.ts`**

Add fields:

```ts
  /**
   * Text and labels live in maps, not in the typed arrays: text is
   * variable-length and non-numeric, and both are read by React chrome on
   * selection rather than by the draw loop on every frame.
   */
  private readonly texts = new Map<number, string>()
  private readonly baseLabels = new Map<number, SemanticLabel>()
```

In the page-ingest handler, next to the existing array copies:

```ts
    for (let i = 0; i < page.ids.length; i++) {
      const id = page.ids[i]
      if (page.texts[i]) this.texts.set(id, page.texts[i])
      if (page.labels[i]) this.baseLabels.set(id, page.labels[i] as SemanticLabel)
    }
```

Only non-empty values are stored, so the synthetic document's 10k nodes add nothing.

Accessors and the writer:

```ts
  textOf(id: number): string {
    return this.texts.get(id) ?? ''
  }

  baseLabelOf(id: number): SemanticLabel {
    return this.baseLabels.get(id) ?? SemanticLabel.None
  }

  /** The label the UI shows: the human's if they set one, else the extraction's. */
  labelOf(id: number): SemanticLabel {
    const override = useStore.getState().edits[id]?.label
    return override === undefined ? this.baseLabelOf(id) : labelFromName(override)
  }

  setLabel(id: number, label: SemanticLabel): void {
    const name = labelName(label)
    if (name === labelName(this.labelOf(id))) return
    commit('relabel', (d) => {
      d.edits[id] = { ...d.edits[id], label: name }
      d.dirtyAt[id] = Date.now()
    })
  }
```

In `applyEdits`, after the coords write, apply the label→type mapping:

```ts
      // A label edit repaints the box, so it has to reach `nodes.types`.
      const wantLabel = edit.label === undefined ? this.baseLabelOf(id) : labelFromName(edit.label)
      const wantType = TYPE_OF_LABEL[wantLabel]
      if (this.nodes.types[i] !== wantType) {
        this.nodes.types[i] = wantType
        dirty = true
      }
```

and in the same function's revert loop (the branch that restores a node whose edit disappeared), restore the base type:

```ts
      const baseType = TYPE_OF_LABEL[this.baseLabelOf(id)]
      if (this.nodes.types[i] !== baseType) {
        this.nodes.types[i] = baseType
        dirty = true
      }
```

For the synthetic document `baseLabelOf` is `None` → `NodeType.Paragraph`, which would flatten every `Line` and `Cell` back to `Paragraph` on revert. Guard it: only touch `types` when the node has a real base label.

```ts
      if (this.baseLabels.has(id)) {
        const baseType = TYPE_OF_LABEL[this.baseLabelOf(id)]
        ...
      }
```

Apply the same guard on the forward path when `edit.label === undefined`. Clear both maps in `dispose()` beside `this.overridden.clear()`.

Imports: `SemanticLabel` from `@/worker/protocol`; `labelFromName`, `labelName`, `TYPE_OF_LABEL` from `@/data/labels`.

- [x] **Step 5: Run tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. The synthetic-drain test is the canary for the guard above — if it starts reporting every node as `Paragraph`, the guard is missing.

- [x] **Step 6: Commit**

```bash
git add src/data/labels.ts src/app/session.ts tests/app/session.test.ts
git commit -m "feat(app): hold node text and labels, and let a relabel edit repaint the box

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Real text in the tree, and a relabel control

**Files:**
- Modify: `src/components/TreeView.tsx`
- Modify: `src/App.tsx` (pass the text/label accessors down)
- Test: `tests/components/treeModel.test.ts`

**Interfaces:**
- Produces:
  - `buildTreeRows(nodes: NodeArrays, expanded: Set<number>, meta?: RowMeta): TreeRow[]` where `export type RowMeta = { textOf(id: number): string; labelOf(id: number): SemanticLabel }`
  - `TreeRow` gains `text: string` and `label: SemanticLabel`. `label` field on `TreeRow` keeps the existing `label: string` name? **No** — rename the existing display string to `title` to avoid the collision: `TreeRow = { id, depth, type, title, text, label, hasChildren }`. Update every consumer.
  - `TreeView` props gain `meta?: RowMeta` and `onRelabel?(id: number, label: SemanticLabel): void`.

- [x] **Step 1: Write the failing test**

Append to `tests/components/treeModel.test.ts`:

```ts
import { SemanticLabel } from '@/worker/protocol'

describe('row text', () => {
  it('shows the extracted text when there is some', () => {
    const nodes = twoLevelNodes() // existing helper in this file
    const rows = buildTreeRows(nodes, new Set([nodes.ids[0]]), {
      textOf: (id) => (id === nodes.ids[1] ? 'Name of company' : ''),
      labelOf: () => SemanticLabel.Question,
    })
    const row = rows.find((r) => r.id === nodes.ids[1])!
    expect(row.text).toBe('Name of company')
    expect(row.label).toBe(SemanticLabel.Question)
  })

  it('falls back to the type-and-id title when text is empty', () => {
    const nodes = twoLevelNodes()
    const rows = buildTreeRows(nodes, new Set(), {
      textOf: () => '',
      labelOf: () => SemanticLabel.None,
    })
    expect(rows[0].text).toBe('')
    expect(rows[0].title).toMatch(/\d+$/)
  })

  it('works with no meta at all, as it did before', () => {
    const rows = buildTreeRows(twoLevelNodes(), new Set())
    expect(rows[0].text).toBe('')
    expect(rows[0].label).toBe(SemanticLabel.None)
  })
})
```

If the file's node helper is named differently, use its actual name.

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/components/treeModel.test.ts`
Expected: FAIL — `buildTreeRows` takes two arguments and `TreeRow` has no `text`.

- [x] **Step 3: Implement**

In `src/components/TreeView.tsx`:

```ts
export type RowMeta = {
  textOf(id: number): string
  labelOf(id: number): SemanticLabel
}

export type TreeRow = {
  id: number
  depth: number
  type: NodeType
  /** Type-and-id fallback, e.g. "Line 1042". Always present. */
  title: string
  /** Extracted text, `''` when the source has none. */
  text: string
  label: SemanticLabel
  hasChildren: boolean
}
```

```ts
export function buildTreeRows(
  nodes: NodeArrays,
  expanded: Set<number>,
  meta?: RowMeta,
): TreeRow[] {
```

and inside `visit`'s push:

```ts
    rows.push({
      id,
      depth,
      type: nodes.types[index] as NodeType,
      title: `${TYPE_LABEL[nodes.types[index]] ?? 'Node'} ${id}`,
      text: meta?.textOf(id) ?? '',
      label: meta?.labelOf(id) ?? SemanticLabel.None,
      hasChildren: !!kids?.length,
    })
```

In the row renderer, show the text when there is any and the title otherwise, plus a label chip:

```tsx
        <span className="truncate text-sm">{row.text || row.title}</span>
        {row.label !== SemanticLabel.None && row.label !== SemanticLabel.Word ? (
          <Badge variant="secondary" className="ml-auto shrink-0 text-[10px] uppercase tracking-wider">
            {labelName(row.label)}
          </Badge>
        ) : null}
```

Import `Badge` from `@/components/ui/badge` and `labelName` from `@/data/labels`.

- [x] **Step 4: Add the relabel control**

Below the tree, render a footer for the selected row only — a `Select` (already installed) over `ASSIGNABLE`:

```tsx
{selectedId !== null && onRelabel ? (
  <div className="flex items-center gap-2 border-t border-border px-3 py-2">
    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
      Label
    </span>
    <Select
      value={labelName(meta?.labelOf(selectedId) ?? SemanticLabel.None)}
      onValueChange={(v) => onRelabel(selectedId, labelFromName(v))}
    >
      <SelectTrigger className="h-7 w-32 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE.map((l) => (
          <SelectItem key={l} value={labelName(l)} className="text-xs">
            {labelName(l)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
) : null}
```

And keyboard parity, because a reviewer relabelling hundreds of boxes will not use a dropdown — in the `useEffect` that already owns the session in `src/App.tsx`, extend the tool-key handler (from the table-mesh plan's Task 4) with digit keys:

```tsx
      // 1–4 relabel the selection: the fast path for bulk correction.
      const digit = "1234".indexOf(e.key)
      if (digit >= 0) {
        const sel = useStore.getState().selectedId
        if (sel !== null) sessionRef.current?.setLabel(sel, ASSIGNABLE[digit])
        return
      }
```

If the table-mesh plan has not landed, add the same `keydown` listener here (registered and removed inside the session `useEffect`).

Pass the accessors from `src/App.tsx` into `TreeView`:

```tsx
  meta={useMemo(
    () => ({
      textOf: (id: number) => sessionRef.current?.textOf(id) ?? "",
      labelOf: (id: number) => sessionRef.current?.labelOf(id) ?? SemanticLabel.None,
    }),
    [],
  )}
  onRelabel={(id, label) => sessionRef.current?.setLabel(id, label)}
```

The `meta` object must be memoized — `buildTreeRows` runs in a `useMemo` keyed on it, and a fresh object each render would rebuild 41k rows every keystroke.

- [x] **Step 5: Run tests and drive it by hand**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

Run: `pnpm dev`, pick **FUNSD**, wait for the stream, expand a page in the tree — rows read `"Name of company"`, not `"Paragraph 1042"`. Select a box on the canvas; the tree row highlights. Press `3` — the box repaints as a header and the chip changes. `Cmd+Z` reverts both.

- [x] **Step 6: Commit**

```bash
git add src/components/TreeView.tsx src/App.tsx tests/components/treeModel.test.ts
git commit -m "feat(ui): show extracted text in the tree and add a relabel control

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Side-by-side JSON / Markdown inspector

**Files:**
- Create: `src/components/inspectorModel.ts`
- Create: `src/components/InspectorPanel.tsx`
- Modify: `src/App.tsx`
- Test: `tests/components/inspectorModel.test.ts`

**Interfaces:**
- Produces in `src/components/inspectorModel.ts`:
  - `export type InspectorNode = { id: number; type: string; label: string; text: string; rect: Rect; modified: boolean; children: InspectorNode[] }`
  - `export function subtreeOf(nodes: NodeArrays, rootId: number, meta: RowMeta, rectOf: (id: number) => Rect | null, modified: (id: number) => boolean, maxNodes?: number): InspectorNode | null`
  - `export function toJson(node: InspectorNode): string` — `JSON.stringify(node, null, 2)`, rects rounded to 2dp so the panel does not show `104.00000762939453`.
  - `export function toMarkdown(node: InspectorNode): string` — heading per label depth, text as body, `- ` list for word children.
- Produces in `src/components/InspectorPanel.tsx`: `export function InspectorPanel(props: { nodes: NodeArrays | null; version: number; meta: RowMeta; rectOf(id: number): Rect | null; onFocus(id: number): void }): JSX.Element`

- [x] **Step 1: Write the failing test**

```ts
// tests/components/inspectorModel.test.ts
import { describe, expect, it } from 'vitest'
import { createNodeArrays, pushNode, NodeType } from '@/data/nodes'
import { SemanticLabel } from '@/worker/protocol'
import { subtreeOf, toJson, toMarkdown } from '@/components/inspectorModel'

/** One question entity with two word children. */
function form() {
  const n = createNodeArrays(8)
  pushNode(n, { id: 1, page: 0, x: 10, y: 20, w: 100, h: 12, type: NodeType.KeyValue, parent: -1, order: 0 })
  pushNode(n, { id: 2, page: 0, x: 10, y: 20, w: 40, h: 12, type: NodeType.Line, parent: 1, order: 1 })
  pushNode(n, { id: 3, page: 0, x: 55, y: 20, w: 50, h: 12, type: NodeType.Line, parent: 1, order: 2 })
  return n
}

const TEXT: Record<number, string> = { 1: 'Name of company', 2: 'Name', 3: 'of company' }
const meta = {
  textOf: (id: number) => TEXT[id] ?? '',
  labelOf: (id: number) => (id === 1 ? SemanticLabel.Question : SemanticLabel.Word),
}
const rectOf = (id: number) => {
  const i = [1, 2, 3].indexOf(id)
  return i < 0 ? null : { x: [10, 10, 55][i], y: 20, w: [100, 40, 50][i], h: 12 }
}

describe('subtreeOf', () => {
  it('builds the selected node and its children', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false)!
    expect(t.id).toBe(1)
    expect(t.label).toBe('question')
    expect(t.text).toBe('Name of company')
    expect(t.children.map((c) => c.text)).toEqual(['Name', 'of company'])
  })

  it('roots at a child when a child is selected', () => {
    const t = subtreeOf(form(), 2, meta, rectOf, () => false)!
    expect(t.id).toBe(2)
    expect(t.children).toEqual([])
  })

  it('flags a modified node', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, (id) => id === 3)!
    expect(t.modified).toBe(false)
    expect(t.children[1].modified).toBe(true)
  })

  it('returns null for an unknown id', () => {
    expect(subtreeOf(form(), 999, meta, rectOf, () => false)).toBeNull()
  })

  it('caps the subtree so a huge parent cannot lock the panel', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false, 2)!
    expect(t.children).toHaveLength(1)
  })
})

describe('toJson', () => {
  it('rounds coordinates to 2dp', () => {
    const t = subtreeOf(form(), 1, meta, () => ({ x: 1 / 3, y: 0, w: 1, h: 1 }), () => false)!
    expect(toJson(t)).toContain('"x": 0.33')
  })

  it('is valid JSON', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false)!
    expect(JSON.parse(toJson(t)).children).toHaveLength(2)
  })
})

describe('toMarkdown', () => {
  it('renders the label as a heading and words as a list', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, () => false)!
    expect(toMarkdown(t)).toBe(
      ['## question', '', 'Name of company', '', '- Name', '- of company', ''].join('\n'),
    )
  })

  it('marks a modified node', () => {
    const t = subtreeOf(form(), 1, meta, rectOf, (id) => id === 1)!
    expect(toMarkdown(t)).toContain('## question *(edited)*')
  })

  it('falls back to the id when there is no text', () => {
    const t = subtreeOf(form(), 1, { textOf: () => '', labelOf: () => SemanticLabel.None }, rectOf, () => false)!
    expect(toMarkdown(t)).toContain('#1')
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm test -- tests/components/inspectorModel.test.ts`
Expected: FAIL — cannot resolve `@/components/inspectorModel`.

- [x] **Step 3: Implement `src/components/inspectorModel.ts`**

```ts
import { indexOfId, NodeType, type NodeArrays, type Rect } from '@/data/nodes'
import { labelName } from '@/data/labels'
import { SemanticLabel } from '@/worker/protocol'
import type { RowMeta } from './TreeView'

export type InspectorNode = {
  id: number
  type: string
  label: string
  text: string
  rect: Rect
  /** The human has edited this node — the inspector says so, in both views. */
  modified: boolean
  children: InspectorNode[]
}

const TYPE_NAME: Record<number, string> = {
  [NodeType.Paragraph]: 'paragraph',
  [NodeType.Line]: 'line',
  [NodeType.Cell]: 'cell',
  [NodeType.KeyValue]: 'keyValue',
  [NodeType.Figure]: 'figure',
}

/** Default node cap. A FUNSD entity has ≤40 words; the cap is for pathological parents. */
const MAX_NODES = 400

/**
 * The **selected** node's subtree, not the document. Serializing 41,228 nodes
 * to JSON would block the main thread for far longer than the 16ms budget and
 * would be unreadable anyway — the reviewer wants to see the thing they clicked.
 */
export function subtreeOf(
  nodes: NodeArrays,
  rootId: number,
  meta: RowMeta,
  rectOf: (id: number) => Rect | null,
  modified: (id: number) => boolean,
  maxNodes = MAX_NODES,
): InspectorNode | null {
  if (indexOfId(nodes, rootId) < 0) return null

  const childrenOf = new Map<number, number[]>()
  for (let i = 0; i < nodes.count; i++) {
    const pid = nodes.parents[i]
    if (pid < 0) continue
    const list = childrenOf.get(pid)
    if (list) list.push(i)
    else childrenOf.set(pid, [i])
  }

  let budget = maxNodes
  const build = (id: number): InspectorNode => {
    budget--
    const i = indexOfId(nodes, id)
    const r = rectOf(id) ?? { x: 0, y: 0, w: 0, h: 0 }
    const kids = childrenOf.get(id) ?? []
    const children: InspectorNode[] = []
    for (const k of kids) {
      if (budget <= 0) break
      children.push(build(nodes.ids[k]))
    }
    return {
      id,
      type: TYPE_NAME[nodes.types[i]] ?? 'node',
      label: labelName(meta.labelOf(id)),
      text: meta.textOf(id),
      rect: r,
      modified: modified(id),
      children,
    }
  }
  return build(rootId)
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** Pretty JSON with coordinates rounded — `104.00000762939453` is Float32 noise, not data. */
export function toJson(node: InspectorNode): string {
  const clean = (n: InspectorNode): unknown => ({
    id: n.id,
    type: n.type,
    label: n.label,
    text: n.text,
    rect: { x: r2(n.rect.x), y: r2(n.rect.y), w: r2(n.rect.w), h: r2(n.rect.h) },
    modified: n.modified,
    children: n.children.map(clean),
  })
  return JSON.stringify(clean(node), null, 2)
}

/**
 * The same tree as prose. Depth becomes heading level (capped at h6), text
 * becomes the body, and leaf children become a list — which is what a document
 * extraction actually reads like once it is correct.
 */
export function toMarkdown(node: InspectorNode): string {
  const out: string[] = []
  const walk = (n: InspectorNode, depth: number) => {
    const head = '#'.repeat(Math.min(6, depth + 2))
    const name = n.label === 'none' || n.label === 'word' ? `#${n.id}` : n.label
    out.push(`${head} ${name}${n.modified ? ' *(edited)*' : ''}`, '')
    if (n.text) out.push(n.text, '')
    const leaves = n.children.filter((c) => c.children.length === 0)
    const branches = n.children.filter((c) => c.children.length > 0)
    for (const l of leaves) out.push(`- ${l.text || `#${l.id}`}${l.modified ? ' *(edited)*' : ''}`)
    if (leaves.length > 0) out.push('')
    for (const b of branches) walk(b, depth + 1)
  }
  walk(node, 0)
  return out.join('\n')
}
```

- [x] **Step 4: Run the model tests**

Run: `pnpm test -- tests/components/inspectorModel.test.ts && pnpm typecheck`
Expected: PASS.

- [x] **Step 5: Implement `src/components/InspectorPanel.tsx`**

```tsx
import { useMemo } from "react"

import type { NodeArrays, Rect } from "@/data/nodes"
import { cn } from "@/lib/utils"
import { useStore } from "@/store/store"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { RowMeta } from "./TreeView"
import { subtreeOf, toJson, toMarkdown } from "./inspectorModel"

type Props = {
  nodes: NodeArrays | null
  /** Bumped by the session when the document changes. */
  version: number
  meta: RowMeta
  rectOf(id: number): Rect | null
  onFocus(id: number): void
}

/**
 * JSON and Markdown views of the selected node's subtree. Subscribes to
 * `selectedId` and `edits` only — the stream writes to the typed arrays, not to
 * React, so this never re-renders during ingest.
 */
export function InspectorPanel({ nodes, version, meta, rectOf, onFocus }: Props) {
  const selectedId = useStore((s) => s.selectedId)
  const edits = useStore((s) => s.edits)

  const tree = useMemo(
    () =>
      nodes === null || selectedId === null
        ? null
        : subtreeOf(nodes, selectedId, meta, rectOf, (id) => edits[id] !== undefined),
    [nodes, selectedId, meta, rectOf, edits, version],
  )

  const json = useMemo(() => (tree ? toJson(tree) : ""), [tree])
  const markdown = useMemo(() => (tree ? toMarkdown(tree) : ""), [tree])

  if (!tree) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        Select a box to inspect its structure.
      </div>
    )
  }

  return (
    <Tabs defaultValue="json" className="flex h-full flex-col gap-0">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <TabsList className="h-7">
          <TabsTrigger value="json" className="h-6 px-2 text-xs">
            JSON
          </TabsTrigger>
          <TabsTrigger value="markdown" className="h-6 px-2 text-xs">
            Markdown
          </TabsTrigger>
          <TabsTrigger value="split" className="h-6 px-2 text-xs">
            Split
          </TabsTrigger>
        </TabsList>
        <button
          type="button"
          onClick={() => onFocus(tree.id)}
          className="cursor-pointer rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Focus #{tree.id}
        </button>
      </div>

      <TabsContent value="json" className="min-h-0 flex-1 overflow-auto p-0">
        <Pane text={json} />
      </TabsContent>
      <TabsContent value="markdown" className="min-h-0 flex-1 overflow-auto p-0">
        <Pane text={markdown} />
      </TabsContent>
      <TabsContent value="split" className="min-h-0 flex-1 overflow-hidden p-0">
        <div className="grid h-full grid-cols-1 divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
          <div className="min-h-0 overflow-auto">
            <Pane text={json} />
          </div>
          <div className="min-h-0 overflow-auto">
            <Pane text={markdown} />
          </div>
        </div>
      </TabsContent>
    </Tabs>
  )
}

function Pane({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {text}
    </pre>
  )
}
```

`Split` is the brief's literal "side-by-side"; keep it as the third tab rather than the default, because at panel width the single views are more readable and the reviewer opts in.

- [x] **Step 6: Mount it in `src/App.tsx`**

Put the inspector under the tree in the existing right-hand rail, sharing the memoized `meta` object from Task 3:

```tsx
<div className="flex min-h-0 flex-1 flex-col border-t border-border">
  <InspectorPanel
    nodes={nodes}
    version={version}
    meta={meta}
    rectOf={(id) => sessionRef.current?.rectOf(id) ?? null}
    onFocus={focusNode}
  />
</div>
```

`rectOf` is a fresh closure each render, which would defeat the `useMemo`; hoist it with `useCallback(() => ..., [])` alongside `meta`.

- [x] **Step 7: Run tests and drive it by hand**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

Run: `pnpm dev`, FUNSD, click a question box. JSON shows the entity and its words with rounded rects; Markdown shows `## question` plus the word list; `Split` shows both. Drag the box — `modified: true` appears and Markdown gains `*(edited)*`. Click **Focus** — the canvas centres on it. Click a tree row — the inspector follows (both read `selectedId`).

- [x] **Step 8: Commit**

```bash
git add src/components/inspectorModel.ts src/components/InspectorPanel.tsx src/App.tsx tests/components/inspectorModel.test.ts
git commit -m "feat(ui): side-by-side JSON and Markdown inspector for the selected subtree

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Document it

**Files:**
- Modify: `ARCHITECTURE.md` §2, §6, §8

- [x] **Step 1: Add to the worker-seam section (§2)**

```markdown
Text is the one payload that cannot be a typed array. `PageIngested` carries `texts: string[]`
parallel to `ids` (plus `labels: Uint8Array` over the `SemanticLabel` enum), so the strings are
structured-cloned while the six numeric buffers are still transferred. One array of ≤536 short
strings per page is negligible next to the geometry, and paying it is what keeps `JSON.parse` of
the corpus on the worker — which is the property being graded, not the clone cost.
```

- [x] **Step 2: Add to the state section (§6)**

```markdown
`Edit.label` is the second editable field beside `rect`. It is stored as the label's **name**, not
its enum ordinal, so the store stays legible in a patch dump and survives a change to the enum's
numbering. `Session.labelOf` resolves human override over extraction, and `applyEdits` maps the
effective label onto `nodes.types[i]` — a re-label has to repaint the box, because the canvas is
where the reviewer is looking. Nodes with no base label (the synthetic corpus) are excluded from
that mapping, so reverting an edit cannot flatten a `Line` into a `Paragraph`.

Text and labels live in `Map`s on the `Session`, not in the typed arrays: text is variable-length
and non-numeric, and both are read by React chrome on selection rather than by the draw loop on
every frame. Only non-empty values are stored, so the 10k-box synthetic document adds nothing.

The inspector serializes the **selected node's subtree**, capped at 400 nodes — never the
document. Stringifying 41,228 nodes would blow the frame budget many times over and would be
unreadable; the reviewer wants the thing they clicked.
```

- [x] **Step 3: Add to §8**

```
- The inspector's Markdown is a rendering of one subtree, not a full-document export. A "download
  the corrected document as Markdown" button is the obvious next step and deliberately out of scope.
- Relabelling changes the semantic label and, through it, the render type. It does not re-run any
  model — there is no model in the loop here, which is the point of a human-in-the-loop repair tool.
```

- [x] **Step 4: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(architecture): document text payload, relabelling and the inspector

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Unresolved questions

- Relabel keys `1`–`4` — collide with anything you want reserved?
- Inspector default tab: JSON, or Split?
- Full-document Markdown export button — in scope, or leave as noted future work?
- Editing text itself (not just the label) — in scope? Brief only says re-label.
