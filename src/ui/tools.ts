// Active tool (shape editing or a brush) and brush options, plus stroke spacing shared by
// the sky view and the minimap.

import { BrushOptions, BrushTool, DEFAULT_BRUSH, PaintLayers } from '../paint';

export type Mode = 'shapes' | BrushTool;

export class ToolState {
  mode: Mode = 'shapes';
  brush: BrushOptions = { ...DEFAULT_BRUSH };
  private listeners = new Set<() => void>();

  get painting(): boolean {
    return this.mode !== 'shapes';
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    if (mode !== 'shapes') this.brush.tool = mode;
    this.emit();
  }

  setBrush(changes: Partial<BrushOptions>): void {
    Object.assign(this.brush, changes);
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Turns pointer positions (map km) into evenly spaced dabs. */
export class Stroke {
  /** Position of the last dab (or the stroke start). */
  private lastDab: [number, number] | null = null;

  constructor(private layers: PaintLayers, private tools: ToolState) {}

  begin(p: [number, number]): void {
    this.layers.beginStroke();
    this.lastDab = p;
    // Smudge needs movement; every other brush dabs on press.
    if (this.tools.brush.tool !== 'smudge') this.layers.dab(this.tools.brush, p[0], p[1]);
  }

  move(p: [number, number]): void {
    if (!this.lastDab) return;
    const spacing = Math.max(this.tools.brush.size * 0.25, 0.05);
    // Step from the last dab toward the pointer; each dab's delta is the step itself,
    // which the smudge brush uses as the drag vector.
    for (let guard = 0; guard < 1000; guard++) {
      const [lx, lz] = this.lastDab;
      const dx = p[0] - lx;
      const dz = p[1] - lz;
      const dist = Math.hypot(dx, dz);
      if (dist < spacing) break;
      const q: [number, number] = [lx + (dx / dist) * spacing, lz + (dz / dist) * spacing];
      this.layers.dab(this.tools.brush, q[0], q[1], [q[0] - lx, q[1] - lz]);
      this.lastDab = q;
    }
  }

  end(): void {
    if (!this.lastDab) return;
    this.lastDab = null;
    this.layers.endStroke();
  }

  get active(): boolean {
    return this.lastDab !== null;
  }
}
