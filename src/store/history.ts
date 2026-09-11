import type { Patch } from 'immer'

export const HISTORY_LIMIT = 100
/** Rapid edits with the same key inside this window merge into one entry. */
export const COALESCE_MS = 300

export type HistoryEntry = {
  name: string
  patches: Patch[]
  inverse: Patch[]
  at: number
}

/** Undo/redo ring. Inverse patches make undo O(change), not O(document). */
export class History {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  push(entry: HistoryEntry): void {
    const last = this.undoStack[this.undoStack.length - 1]
    if (last && last.name === entry.name && entry.at - last.at < COALESCE_MS) {
      // Merge: patches append in order, inverses prepend so undo unwinds backwards.
      last.patches.push(...entry.patches)
      last.inverse.unshift(...entry.inverse)
      last.at = entry.at
    } else {
      this.undoStack.push(entry)
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift()
    }
    this.redoStack.length = 0
  }

  popUndo(): HistoryEntry | undefined {
    const e = this.undoStack.pop()
    if (e) this.redoStack.push(e)
    return e
  }

  popRedo(): HistoryEntry | undefined {
    const e = this.redoStack.pop()
    if (e) this.undoStack.push(e)
    return e
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}
