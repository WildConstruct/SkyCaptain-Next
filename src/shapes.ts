// Shape layers: weather generators placed on the map. They resolve into the weather map
// on the GPU (weather.wgsl); this module owns the editable model, its undo snapshots,
// GPU packing, and the CPU geometry used for hit testing and outlines.

import type { History, HistoryEntry } from './history';

export type ShapeKind = 'cumulus_field' | 'storm_cell' | 'front' | 'clear_hole' | 'haze_sheet';

export const SHAPE_KINDS: { kind: ShapeKind; label: string; defaults: Partial<ShapeLayer> }[] = [
  { kind: 'cumulus_field', label: 'Cumulus field', defaults: { size: 25, aspect: 0.7 } },
  { kind: 'storm_cell', label: 'Storm cell', defaults: { size: 6, aspect: 0.8 } },
  { kind: 'front', label: 'Front', defaults: { size: 40, aspect: 0.2 } },
  { kind: 'clear_hole', label: 'Clear hole', defaults: { size: 12, aspect: 0.8 } },
  { kind: 'haze_sheet', label: 'Haze sheet', defaults: { size: 35, aspect: 0.6 } },
];

const KIND_INDEX: Record<ShapeKind, number> = {
  cumulus_field: 0, storm_cell: 1, front: 2, clear_hole: 3, haze_sheet: 4,
};

export const MAX_SHAPES = 16;
export const SHAPES_BUFFER_SIZE = 16 + MAX_SHAPES * 48;

export interface ShapeLayer {
  id: string;
  kind: ShapeKind;
  /** Map position, km. +x east, +z north, eye at the origin. */
  x: number;
  z: number;
  /** Half-length along the main axis, km. */
  size: number;
  /** Width / length. */
  aspect: number;
  /** Degrees, counter-clockwise from east as seen on the north-up map. */
  rotation: number;
  strength: number;
  /** Cloud type 0..1, or null for the generator's own profile. */
  type: number | null;
  seed: number;
  visible: boolean;
  /** Set when a sky graph (PSG) produced this layer: its shape.N slot. Rerolls replace these. */
  psgSlot?: number;
}

let nextId = 1;

export function createShape(kind: ShapeKind, x: number, z: number, seed: number): ShapeLayer {
  const spec = SHAPE_KINDS.find((k) => k.kind === kind)!;
  return {
    // Unique across sessions so shapes from opened documents never collide.
    id: `shape-${Date.now().toString(36)}-${nextId++}`,
    kind, x, z,
    size: 15, aspect: 0.7, rotation: 0, strength: 1, type: null, seed, visible: true,
    ...spec.defaults,
  };
}

export function labelFor(kind: ShapeKind): string {
  return SHAPE_KINDS.find((k) => k.kind === kind)!.label;
}

export function packShapes(shapes: ShapeLayer[], baseAmount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(SHAPES_BUFFER_SIZE);
  const visible = shapes.filter((s) => s.visible).slice(0, MAX_SHAPES);
  new Uint32Array(buffer, 0, 1)[0] = visible.length;
  new Float32Array(buffer, 4, 1)[0] = baseAmount;
  const f = new Float32Array(buffer, 16);
  visible.forEach((s, i) => {
    const r = (s.rotation * Math.PI) / 180;
    f.set([
      s.x, s.z, s.size, s.aspect,
      Math.cos(r), Math.sin(r), s.strength, s.type ?? -1,
      KIND_INDEX[s.kind], s.seed, 0, 0,
    ], i * 12);
  });
  return buffer;
}

/** Normalised distance from a map point to the shape (1 = boundary). Mirrors to_local() in weather.wgsl. */
export function shapeDistance(s: ShapeLayer, x: number, z: number): number {
  const r = (s.rotation * Math.PI) / 180;
  const rx = x - s.x;
  const rz = z - s.z;
  const px = Math.cos(r) * rx + Math.sin(r) * rz;
  const py = -Math.sin(r) * rx + Math.cos(r) * rz;
  const width = Math.max(s.size * s.aspect, 0.1);
  if (s.kind === 'front') {
    const along = Math.max(-s.size, Math.min(s.size, px));
    return Math.hypot(px - along, py) / width;
  }
  return Math.hypot(px / Math.max(s.size, 0.1), py / width);
}

/** Boundary polyline in map space (closed). */
export function shapeOutline(s: ShapeLayer, segments = 64): [number, number][] {
  const r = (s.rotation * Math.PI) / 180;
  const width = Math.max(s.size * s.aspect, 0.1);
  const local: [number, number][] = [];
  if (s.kind === 'front') {
    const half = segments / 2;
    for (let i = 0; i <= half; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / half;
      local.push([s.size + Math.cos(a) * width, Math.sin(a) * width]);
    }
    for (let i = 0; i <= half; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / half;
      local.push([-s.size + Math.cos(a) * width, Math.sin(a) * width]);
    }
  } else {
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      local.push([Math.cos(a) * s.size, Math.sin(a) * width]);
    }
  }
  return local.map(([px, py]) => [
    s.x + Math.cos(r) * px - Math.sin(r) * py,
    s.z + Math.sin(r) * px + Math.cos(r) * py,
  ]);
}

/** Map-space positions of the selected shape's handles. */
export function shapeHandles(s: ShapeLayer): { size: [number, number]; aspect: [number, number] } {
  const r = (s.rotation * Math.PI) / 180;
  const width = Math.max(s.size * s.aspect, 0.1);
  const reach = s.kind === 'front' ? s.size + width : s.size;
  return {
    size: [s.x + Math.cos(r) * reach, s.z + Math.sin(r) * reach],
    aspect: [s.x - Math.sin(r) * width, s.z + Math.cos(r) * width],
  };
}

type Listener = () => void;

/** Shape layers plus selection; edits checkpoint into the shared history. */
export class ShapeStore {
  /** What everything shows and renders: the composed layers, or their animated view. */
  shapes: ShapeLayer[] = [];
  selected: string | null = null;
  private listeners = new Set<Listener>();
  /** The composed layers while an animated view is shown (see showAnimated). */
  private base: ShapeLayer[] | null = null;
  /**
   * While an animated view is shown, edits to keyable properties go here (to become
   * keys) instead of changing the composed layers. Returns the changes it took.
   */
  keyEdit: ((id: string, changes: Partial<ShapeLayer>) => Partial<ShapeLayer>) | null = null;
  /** Called when the composed layers change while an animated view is shown. */
  onBaseChange: (() => void) | null = null;

  constructor(private history: History) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** The composed layers (frame 0), whatever is on show. Save and name skies from these. */
  get baseShapes(): ShapeLayer[] {
    return this.base ?? this.shapes;
  }

  get animated(): boolean {
    return this.base !== null;
  }

  /** Shows layers as they are at an animation time; edits are routed to keyEdit. */
  showAnimated(shapes: ShapeLayer[]): void {
    this.base ??= this.shapes;
    this.shapes = shapes;
    this.emit();
  }

  /** Back to the composed layers. */
  showBase(): void {
    if (!this.base) return;
    this.shapes = this.base;
    this.base = null;
    this.emit();
  }

  private baseChanged(): void {
    if (this.base) this.onBaseChange?.();
  }

  get current(): ShapeLayer | undefined {
    return this.shapes.find((s) => s.id === this.selected);
  }

  /** Call once before a user edit (a drag, a slider gesture, a button). */
  checkpoint(): void {
    this.history.push(this.snapshot(JSON.stringify(this.baseShapes)));
  }

  private snapshot(json: string): HistoryEntry {
    return {
      apply: () => {
        const now = JSON.stringify(this.baseShapes);
        this.restore(json);
        return this.snapshot(now);
      },
    };
  }

  private restore(json: string): void {
    if (this.base) {
      this.base = JSON.parse(json);
      this.shapes = JSON.parse(json);
    } else {
      this.shapes = JSON.parse(json);
    }
    if (!this.current) this.selected = null;
    this.emit();
    this.baseChanged();
  }

  // Adding and removing layers, and replacing them all, always act on the composed layers
  // (a layer exists for the whole clip); an animated view on show is rebuilt from them.

  add(shape: ShapeLayer): void {
    if (this.baseShapes.length >= MAX_SHAPES) return;
    this.checkpoint();
    if (this.base) this.base.push({ ...shape });
    this.shapes.push(shape);
    this.selected = shape.id;
    this.emit();
    this.baseChanged();
  }

  remove(id: string): void {
    this.checkpoint();
    if (this.base) this.base = this.base.filter((s) => s.id !== id);
    this.shapes = this.shapes.filter((s) => s.id !== id);
    if (this.selected === id) this.selected = null;
    this.emit();
    this.baseChanged();
  }

  /** Replaces every layer (callers checkpoint first). Keeps the selection if it survives. */
  replaceAll(shapes: ShapeLayer[]): void {
    if (this.base) this.base = shapes.map((s) => ({ ...s }));
    this.shapes = shapes;
    if (!this.current) this.selected = null;
    this.emit();
    this.baseChanged();
  }

  /**
   * Mutates without a checkpoint; callers checkpoint at gesture start. In an animated view,
   * keyable properties become keys (keyEdit) and the rest change the composed layer too.
   */
  patch(id: string, changes: Partial<ShapeLayer>): void {
    const shape = this.shapes.find((s) => s.id === id);
    if (!shape) return;
    if (this.base && this.keyEdit) {
      const keyed = this.keyEdit(id, changes);
      const rest = Object.fromEntries(Object.entries(changes).filter(([k]) => !(k in keyed)));
      const baseShape = this.base.find((s) => s.id === id);
      if (baseShape && Object.keys(rest).length) Object.assign(baseShape, rest);
    }
    Object.assign(shape, changes);
    this.emit();
  }

  select(id: string | null): void {
    this.selected = id;
    this.emit();
  }

  /** Topmost visible shape containing the map point, if any. */
  hit(x: number, z: number, slack = 1): ShapeLayer | undefined {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (s.visible && shapeDistance(s, x, z) <= slack) return s;
    }
    return undefined;
  }
}
