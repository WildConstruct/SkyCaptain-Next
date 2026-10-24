// Top-down ground layout for painting: one pixel per tile, centred on where the eye stands,
// with the view wedge. North (+z) is up, east (+x) is right. Dragging paints the chosen
// land cover onto tiles (or hands them back to the collapse with Auto); on release the
// layout recollapses around what was painted, and the eye stays put.

import type { GroundStore } from '../ground';
import type { Settings } from '../settings';
import { TERRAIN_GRID, TERRAIN_TYPES } from '../terrain';

/** Pixels per tile on the map canvas. */
const SCALE = 2;

function toSrgb(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}

export class GroundMap {
  /** Type index to paint, or -1 (Auto: the collapse decides). */
  type = TERRAIN_TYPES.indexOf('forest');
  /** Brush radius, tiles. */
  radius = 3;
  /** Viewport width / height, for the view wedge. */
  viewAspect = 16 / 9;
  private ctx: CanvasRenderingContext2D;
  private image = document.createElement('canvas');
  private painting = false;
  private hover: [number, number] | null = null;

  constructor(private canvas: HTMLCanvasElement, private settings: Settings, private store: GroundStore) {
    this.ctx = canvas.getContext('2d')!;
    canvas.width = TERRAIN_GRID * SCALE;
    canvas.height = TERRAIN_GRID * SCALE;
    this.image.width = TERRAIN_GRID;
    this.image.height = TERRAIN_GRID;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.painting = true;
      this.paintAt(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      this.hover = this.canvasPoint(e);
      if (this.painting) this.paintAt(e);
    });
    const end = () => {
      if (!this.painting) return;
      this.painting = false;
      this.store.commitPaint();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { this.hover = null; });
    store.subscribe(() => this.rebuild());
    this.rebuild();
  }

  /** The tile under the eye (terrain space). */
  private eyeTile(): [number, number] {
    const tile = this.store.recipe.tileKm;
    return [Math.floor(this.store.place.x / tile), Math.floor(this.store.place.z / tile)];
  }

  private canvasPoint(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.canvas.width, ((e.clientY - r.top) / r.height) * this.canvas.height];
  }

  /** The tile at a canvas point: the map is centred on the eye's tile. */
  private tileAt(p: [number, number]): [number, number] {
    const [ex, ey] = this.eyeTile();
    const half = (TERRAIN_GRID * SCALE) / 2;
    return [ex + Math.floor((p[0] - half) / SCALE), ey - Math.floor((p[1] - half) / SCALE)];
  }

  private paintAt(e: PointerEvent): void {
    const [tx, ty] = this.tileAt(this.canvasPoint(e));
    this.store.paintTiles(tx, ty, this.radius, this.type);
    this.rebuild();
  }

  /** Redraws the tile image: the layout, with painted tiles shown as painted. */
  rebuild(): void {
    const n = TERRAIN_GRID;
    const ctx = this.image.getContext('2d')!;
    const img = ctx.createImageData(n, n);
    const palette = TERRAIN_TYPES.map((t) => this.store.recipe.palette[t].map((v) => toSrgb(v * 1.6)));
    // Water reads better a little brighter and bluer than its albedo.
    palette[0] = [40, 80, 130];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const painted = this.store.constraints[i];
        const c = palette[painted >= 0 ? painted : this.store.map.types[i]];
        // Row y grows with +z (north); the image draws north up.
        const dst = ((n - 1 - y) * n + x) * 4;
        // Painted tiles are lifted slightly so the strokes stay visible.
        const lift = painted >= 0 ? 28 : 0;
        img.data[dst] = Math.min(255, c[0] + lift);
        img.data[dst + 1] = Math.min(255, c[1] + lift);
        img.data[dst + 2] = Math.min(255, c[2] + lift);
        img.data[dst + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  draw(): void {
    const ctx = this.ctx;
    const n = TERRAIN_GRID;
    const size = n * SCALE;
    const half = size / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0d1219';
    ctx.fillRect(0, 0, size, size);
    // The layout repeats: draw it wrapped so the eye's tile sits at the centre.
    const [ex, ey] = this.eyeTile();
    const ox = half - (((ex % n) + n) % n) * SCALE;
    const oy = half - (n - 1 - (((ey % n) + n) % n)) * SCALE;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) ctx.drawImage(this.image, ox + i * size, oy + j * size, size, size);
    }
    // The view wedge from the eye.
    const yaw = (this.settings.yaw * Math.PI) / 180;
    const spread = Math.atan(Math.tan((this.settings.fov * Math.PI) / 360) * this.viewAspect);
    const reach = size * 0.45;
    const cx = half + SCALE / 2;
    const cy = half + SCALE / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(yaw - spread) * reach, cy - Math.cos(yaw - spread) * reach);
    ctx.lineTo(cx + Math.sin(yaw + spread) * reach, cy - Math.cos(yaw + spread) * reach);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    // The brush.
    if (this.hover) {
      ctx.beginPath();
      ctx.arc(this.hover[0], this.hover[1], Math.max(1, this.radius) * SCALE, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
