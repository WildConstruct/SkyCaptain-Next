// The sky document: everything needed to reproduce a sky, as one portable JSON file.
// Settings, shape layers, paint (sparse int16 tiles) and the sky graph with its text and
// last roll. Rendered images are never stored; they are derived from this.

import type { PaintLayers, PaintTile } from './paint';
import type { SkyGraph, SkyGraphState } from './psg';
import type { Settings } from './settings';
import type { ShapeLayer } from './shapes';
import type { MonikerBlock } from './moniker/skycaptain';

export const SKY_FORMAT = 'skycaptain.sky';
export const SKY_VERSION = 1;

export interface SkyDocument {
  format: typeof SKY_FORMAT;
  version: typeof SKY_VERSION;
  savedAt: string;
  /** Display name: Moniker's suggestion unless the artist renamed it. */
  name?: string;
  /** Stable identity and the deterministic fallback name (skycaptain-sky.moniker). */
  moniker?: MonikerBlock;
  settings: Settings;
  shapes: ShapeLayer[];
  /** Non-empty 64x64 tiles; data is base64 of little-endian int16 (paint) or float32 (warp). */
  paint: { size: number; tiles: { layer: PaintTile['layer']; tx: number; ty: number; data: string }[] };
  graph: SkyGraphState | null;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function saveSky(
  settings: Settings,
  shapes: ShapeLayer[],
  layers: PaintLayers,
  graph: SkyGraph,
  naming?: { name: string; moniker: MonikerBlock },
): string {
  const doc: SkyDocument = {
    format: SKY_FORMAT,
    version: SKY_VERSION,
    savedAt: new Date().toISOString(),
    ...naming,
    settings: { ...settings },
    shapes: shapes.map((s) => ({ ...s })),
    paint: {
      size: layers.size,
      tiles: layers.exportTiles().map((t) => ({
        layer: t.layer, tx: t.tx, ty: t.ty, data: toBase64(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)),
      })),
    },
    graph: graph.snapshot(),
  };
  return JSON.stringify(doc);
}

export function parseSky(text: string): SkyDocument {
  const doc = JSON.parse(text) as SkyDocument;
  if (doc.format !== SKY_FORMAT) throw new Error('Not a skyCaptain sky file.');
  if (doc.version !== SKY_VERSION) throw new Error(`Unsupported sky file version ${doc.version}.`);
  return doc;
}

export function paintTilesOf(doc: SkyDocument, size: number): PaintTile[] {
  if (doc.paint.size !== size) throw new Error(`Paint is ${doc.paint.size}², this build uses ${size}².`);
  return doc.paint.tiles.map((t) => {
    const bytes = fromBase64(t.data);
    const data = t.layer === 'warp'
      ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      : new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    return { layer: t.layer, tx: t.tx, ty: t.ty, data };
  });
}
