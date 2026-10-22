// Draws shape outlines and the brush cursor in the sky, and handles direct manipulation:
// with the Shapes tool, drag a shape to move it and drag empty sky to look around; with a
// brush, left-drag paints and right-drag (or Space-drag) looks. Wheel zooms.

import { dirFromMapPoint, mapPointFromDir, project, rayDir } from '../camera';
import type { Settings } from '../settings';
import { ShapeStore, labelFor, shapeOutline } from '../shapes';
import { Stroke, ToolState } from './tools';

export interface SkyOverlayOptions {
  canvas: HTMLCanvasElement;
  settings: Settings;
  store: ShapeStore;
  tools: ToolState;
  stroke: Stroke;
  /** Called for camera changes (yaw, pitch, fov). */
  setView: (key: 'yaw' | 'pitch' | 'fov', value: number) => void;
}

export class SkyOverlay {
  private ctx: CanvasRenderingContext2D;
  private drag:
    | { mode: 'look'; x: number; y: number }
    | { mode: 'move'; id: string; dx: number; dz: number }
    | { mode: 'paint' }
    | null = null;
  private hover: [number, number] | null = null;
  private spaceHeld = false;

  constructor(private o: SkyOverlayOptions) {
    this.ctx = o.canvas.getContext('2d')!;
    const c = o.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', () => this.up());
    c.addEventListener('pointercancel', () => this.up());
    c.addEventListener('pointerleave', () => { this.hover = null; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { this.spaceHeld = true; e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceHeld = false; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      o.setView('fov', Math.max(20, Math.min(120, o.settings.fov * Math.exp(e.deltaY * 0.001))));
    }, { passive: false });
  }

  private aspect(): number {
    return this.o.canvas.clientWidth / Math.max(1, this.o.canvas.clientHeight);
  }

  private mapPointAt(e: PointerEvent): [number, number] | null {
    const rect = this.o.canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    return mapPointFromDir(this.o.settings, rayDir(this.o.settings, this.aspect(), ndcX, ndcY));
  }

  /** Map point in the middle of the view, for placing new shapes where the artist is looking. */
  centerMapPoint(): [number, number] {
    const s = this.o.settings;
    const dir = rayDir(s, this.aspect(), 0, Math.max(0, -Math.tan((s.pitch * Math.PI) / 180) / Math.tan((s.fov * Math.PI) / 360)) + 0.1);
    const p = mapPointFromDir(s, dir);
    if (p) return p;
    const yaw = (s.yaw * Math.PI) / 180;
    return [Math.sin(yaw) * 30 + s.windX, Math.cos(yaw) * 30 + s.windZ];
  }

  private down(e: PointerEvent): void {
    this.o.canvas.setPointerCapture(e.pointerId);
    const p = this.mapPointAt(e);
    if (this.o.tools.painting) {
      if (e.button === 0 && !this.spaceHeld && p) {
        this.o.stroke.begin(p);
        this.drag = { mode: 'paint' };
      } else {
        this.drag = { mode: 'look', x: e.clientX, y: e.clientY };
      }
      return;
    }
    const hit = p ? this.o.store.hit(p[0], p[1]) : undefined;
    if (p && hit) {
      this.o.store.checkpoint();
      this.o.store.select(hit.id);
      this.drag = { mode: 'move', id: hit.id, dx: hit.x - p[0], dz: hit.z - p[1] };
    } else {
      this.drag = { mode: 'look', x: e.clientX, y: e.clientY };
    }
  }

  private move(e: PointerEvent): void {
    const s = this.o.settings;
    this.hover = this.mapPointAt(e);
    if (!this.drag) {
      const p = this.hover;
      this.o.canvas.style.cursor = this.o.tools.painting ? (p ? 'none' : 'grab') : p && this.o.store.hit(p[0], p[1]) ? 'move' : 'grab';
      return;
    }
    if (this.drag.mode === 'paint') {
      if (this.hover) this.o.stroke.move(this.hover);
      return;
    }
    if (this.drag.mode === 'look') {
      const scale = s.fov / this.o.canvas.clientHeight;
      this.o.setView('yaw', s.yaw - (e.clientX - this.drag.x) * scale);
      this.o.setView('pitch', Math.max(-89, Math.min(89, s.pitch + (e.clientY - this.drag.y) * scale)));
      this.drag = { mode: 'look', x: e.clientX, y: e.clientY };
    } else {
      const p = this.mapPointAt(e);
      if (p) this.o.store.patch(this.drag.id, { x: p[0] + this.drag.dx, z: p[1] + this.drag.dz });
    }
  }

  private up(): void {
    if (this.drag?.mode === 'paint') this.o.stroke.end();
    this.drag = null;
  }

  draw(): void {
    const c = this.o.canvas;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.floor(c.clientWidth * dpr);
    const h = Math.floor(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const s = this.o.settings;
    const aspect = w / h;
    const toScreen = (x: number, z: number): [number, number] | null => {
      const dir = dirFromMapPoint(s, x, z);
      if (dir[1] < -0.01) return null;
      const ndc = project(s, aspect, dir);
      return ndc ? [(ndc[0] * 0.5 + 0.5) * w, (0.5 - ndc[1] * 0.5) * h] : null;
    };

    if (this.o.tools.painting && this.hover && !(this.drag?.mode === 'look')) {
      // Brush footprint on the cloud base.
      const [hx, hz] = this.hover;
      const r = this.o.tools.brush.size;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const pt = toScreen(hx + Math.cos(a) * r, hz + Math.sin(a) * r);
        if (!pt) { pen = false; continue; }
        if (pen) ctx.lineTo(pt[0], pt[1]); else ctx.moveTo(pt[0], pt[1]);
        pen = true;
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }

    for (const shape of this.o.store.shapes) {
      if (!shape.visible) continue;
      const selected = shape.id === this.o.store.selected;
      ctx.beginPath();
      let pen = false;
      for (const [x, z] of [...shapeOutline(shape), shapeOutline(shape)[0]]) {
        const pt = toScreen(x, z);
        if (!pt) { pen = false; continue; }
        if (pen) ctx.lineTo(pt[0], pt[1]); else ctx.moveTo(pt[0], pt[1]);
        pen = true;
      }
      ctx.lineWidth = (selected ? 2 : 1.25) * dpr;
      ctx.setLineDash(selected ? [] : [6 * dpr, 5 * dpr]);
      ctx.strokeStyle = selected ? 'rgba(127, 178, 255, 0.95)' : 'rgba(255, 255, 255, 0.55)';
      ctx.stroke();
      const center = toScreen(shape.x, shape.z);
      if (center) {
        ctx.setLineDash([]);
        ctx.fillStyle = selected ? 'rgba(127, 178, 255, 0.95)' : 'rgba(255, 255, 255, 0.7)';
        ctx.beginPath();
        ctx.arc(center[0], center[1], 3.5 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `${11 * dpr}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(labelFor(shape.kind), center[0] + 7 * dpr, center[1] - 6 * dpr);
      }
    }
  }
}
