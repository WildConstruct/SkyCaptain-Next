// Top-down weather map: coverage and type from the GPU weather map, shape outlines with
// move / size-and-rotate / aspect handles, the eye, the view wedge and the sun direction.
// With a brush active, dragging paints top-down.
// North (+z) is up, east (+x) is right.

import type { Settings } from '../settings';
import { ShapeLayer, ShapeStore, shapeHandles, shapeOutline } from '../shapes';
import { Stroke, ToolState } from './tools';

type Handle = 'move' | 'size' | 'aspect';

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private image: HTMLCanvasElement = document.createElement('canvas');
  private imageExtent = 0;
  /** Half-width of the visible map, km. */
  radius = 90;
  /** Viewport width / height, for the horizontal extent of the view wedge. */
  viewAspect = 16 / 9;
  private drag: { id: string; handle: Handle; dx: number; dz: number } | null = null;
  private hover: [number, number] | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private settings: Settings,
    private store: ShapeStore,
    private tools: ToolState,
    private stroke: Stroke,
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => { this.drag = null; this.stroke.end(); });
    canvas.addEventListener('pointerleave', () => { this.hover = null; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.radius = Math.max(15, Math.min(this.settings.weatherScale / 2, this.radius * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
  }

  /** Updates the coverage image from a weather-map readback. */
  setWeather(size: number, data: Uint8Array, extent: number): void {
    const step = 4;
    const n = size / step;
    this.image.width = n;
    this.image.height = n;
    const ctx = this.image.getContext('2d')!;
    const img = ctx.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const src = ((y * step) * size + x * step) * 4;
        // Texture row v grows with +z; the minimap draws north up, so flip rows.
        const dst = ((n - 1 - y) * n + x) * 4;
        const cov = data[src] / 255;
        const kind = data[src + 1] / 255;
        const base = [22, 34, 52];
        const cloud = [235 - kind * 20, 238 - kind * 60, 245 - kind * 110];
        for (let c = 0; c < 3; c++) img.data[dst + c] = base[c] + (cloud[c] - base[c]) * cov;
        img.data[dst + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.imageExtent = extent;
  }

  private toCanvas(x: number, z: number): [number, number] {
    const w = this.canvas.width;
    const k = w / (2 * this.radius);
    return [w / 2 + x * k, w / 2 - z * k];
  }

  private toMap(e: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const u = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const v = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    return [u * this.radius, -v * this.radius];
  }

  private handleAt(shape: ShapeLayer, x: number, z: number): Handle | null {
    const tolerance = this.radius * 0.05;
    const h = shapeHandles(shape);
    if (Math.hypot(h.size[0] - x, h.size[1] - z) < tolerance) return 'size';
    if (Math.hypot(h.aspect[0] - x, h.aspect[1] - z) < tolerance) return 'aspect';
    return null;
  }

  private down(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    const [x, z] = this.toMap(e);
    if (this.tools.painting) {
      if (e.button === 0) this.stroke.begin([x, z]);
      return;
    }
    const current = this.store.current;
    const handle = current ? this.handleAt(current, x, z) : null;
    if (current && handle) {
      this.store.checkpoint();
      this.drag = { id: current.id, handle, dx: 0, dz: 0 };
      return;
    }
    const hit = this.store.hit(x, z);
    if (hit) {
      this.store.checkpoint();
      this.store.select(hit.id);
      this.drag = { id: hit.id, handle: 'move', dx: hit.x - x, dz: hit.z - z };
    } else {
      this.store.select(null);
    }
  }

  private move(e: PointerEvent): void {
    const [x, z] = this.toMap(e);
    this.hover = [x, z];
    if (this.tools.painting) {
      this.canvas.style.cursor = 'none';
      if (this.stroke.active) this.stroke.move([x, z]);
      return;
    }
    if (!this.drag) {
      const current = this.store.current;
      this.canvas.style.cursor = current && this.handleAt(current, x, z) ? 'crosshair' : this.store.hit(x, z) ? 'move' : 'default';
      return;
    }
    const shape = this.store.shapes.find((s) => s.id === this.drag!.id);
    if (!shape) return;
    if (this.drag.handle === 'move') {
      this.store.patch(shape.id, { x: x + this.drag.dx, z: z + this.drag.dz });
    } else if (this.drag.handle === 'size') {
      const dx = x - shape.x;
      const dz = z - shape.z;
      const reach = Math.max(0.5, Math.hypot(dx, dz));
      const width = shape.size * shape.aspect;
      const size = shape.kind === 'front' ? Math.max(0.5, reach - width) : reach;
      this.store.patch(shape.id, { size, rotation: (Math.atan2(dz, dx) * 180) / Math.PI });
    } else {
      const width = Math.hypot(x - shape.x, z - shape.z);
      this.store.patch(shape.id, { aspect: Math.max(0.05, Math.min(1.5, width / Math.max(shape.size, 0.1))) });
    }
  }

  draw(): void {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const size = Math.floor(c.clientWidth * dpr);
    if (c.width !== size || c.height !== size) { c.width = size; c.height = size; }
    const ctx = this.ctx;
    const s = this.settings;
    ctx.fillStyle = '#0d1219';
    ctx.fillRect(0, 0, size, size);

    if (this.imageExtent > 0) {
      // The weather map is centred on the eye in map space.
      const [x0, y0] = this.toCanvas(-this.imageExtent / 2, this.imageExtent / 2);
      const [x1, y1] = this.toCanvas(this.imageExtent / 2, -this.imageExtent / 2);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.image, x0, y0, x1 - x0, y1 - y0);
    }

    // Range rings every 25 km around the eye, and the horizon distance of the cloud base.
    // The map moves with drift, so the eye sits at the wind offset in map space.
    const [cx, cy] = this.toCanvas(s.windX, s.windZ);
    const k = size / (2 * this.radius);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = dpr;
    for (let r = 25; r < this.radius * 1.5; r += 25) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    // How far the cloud base is visible: to where sight lines graze it from below, or to
    // the horizon beyond it from above.
    const eye = Math.max(s.eyeAltitude, 0.002);
    const horizon = eye < s.cloudBottom
      ? Math.sqrt(2 * 6360 * (s.cloudBottom - eye))
      : Math.sqrt(2 * 6360 * eye) + Math.sqrt(2 * 6360 * s.cloudBottom);
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    ctx.strokeStyle = 'rgba(255,200,120,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, horizon * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // View wedge from the eye.
    const [ex, ey] = [cx, cy];
    const yaw = (s.yaw * Math.PI) / 180;
    const half = Math.atan(Math.tan((s.fov * Math.PI) / 360) * this.viewAspect);
    ctx.fillStyle = 'rgba(127,178,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.arc(ex, ey, size, -Math.PI / 2 + yaw - half, -Math.PI / 2 + yaw + half);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#7fb2ff';
    ctx.beginPath();
    ctx.arc(ex, ey, 3 * dpr, 0, Math.PI * 2);
    ctx.fill();

    // Sun direction on the rim.
    const az = (s.sunAzimuth * Math.PI) / 180;
    ctx.fillStyle = '#ffd27a';
    ctx.beginPath();
    ctx.arc(size / 2 + Math.sin(az) * size * 0.46, size / 2 - Math.cos(az) * size * 0.46, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();

    for (const shape of this.store.shapes) {
      if (!shape.visible) continue;
      const selected = shape.id === this.store.selected;
      ctx.beginPath();
      shapeOutline(shape).forEach(([x, z], i) => {
        const [px, py] = this.toCanvas(x, z);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.lineWidth = (selected ? 2 : 1) * dpr;
      ctx.strokeStyle = selected ? '#7fb2ff' : 'rgba(255,255,255,0.6)';
      ctx.stroke();
      if (selected) {
        const h = shapeHandles(shape);
        ctx.fillStyle = '#7fb2ff';
        const [sx, sy] = this.toCanvas(h.size[0], h.size[1]);
        ctx.fillRect(sx - 4 * dpr, sy - 4 * dpr, 8 * dpr, 8 * dpr);
        const [ax, ay] = this.toCanvas(h.aspect[0], h.aspect[1]);
        ctx.beginPath();
        ctx.arc(ax, ay, 4 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (this.tools.painting && this.hover) {
      const [hx, hy] = this.toCanvas(this.hover[0], this.hover[1]);
      ctx.beginPath();
      ctx.arc(hx, hy, this.tools.brush.size * k, 0, Math.PI * 2);
      ctx.lineWidth = dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText('N', size / 2 - 3 * dpr, 12 * dpr);
    ctx.fillText(`${Math.round(this.radius * 2)} km`, 6 * dpr, size - 6 * dpr);
  }
}
