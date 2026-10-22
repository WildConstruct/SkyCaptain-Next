// One undo history for every kind of edit (shape layers, paint strokes).
// An entry restores its saved state and returns the inverse entry, so undo and redo
// are the same operation in opposite stacks.

export interface HistoryEntry {
  /** Restores the saved state; returns an entry that restores the state just replaced. */
  apply(): HistoryEntry;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(private limit = 200) {}

  push(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  /** Forgets all undo and redo steps (e.g. after opening a document). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push(entry.apply());
    this.emit();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push(entry.apply());
    this.emit();
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
