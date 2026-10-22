// A whole sky as one portable .wcx file (kind "sky"): every setting as WCX params, plus
// the composition in `sky`: shape layers, paint (sparse int16 tiles) and the sky graph
// with its text and last roll. Rendered images are never stored; they derive from this.
// Older .sky.json files (format "skycaptain.sky", version 1) still open.

import type { PaintLayers, PaintTile } from './paint';
import type { SkyGraph, SkyGraphState } from './psg';
import { DEFAULTS, type Settings } from './settings';
import type { ShapeLayer } from './shapes';
import type { MonikerBlock } from './moniker/skycaptain';
import { header, paramsOf, settingOf, wcxError, type WcxFile } from './wcx';
import { DEFAULT_ANIMATION, parseAnimation, type Animation } from './animation';

const LEGACY_FORMAT = 'skycaptain.sky';

interface Composition {
  shapes: ShapeLayer[];
  /** Non-empty 64x64 tiles; data is base64 of little-endian int16 (paint) or float32 (warp). */
  paint: { size: number; tiles: { layer: PaintTile['layer']; tx: number; ty: number; data: string }[] };
  graph: SkyGraphState | null;
  /** How the sky moves over time (animation.ts). Older files have none: the default. */
  animation?: Animation;
}

export interface SkyFile extends WcxFile {
  kind: 'sky';
  sky: Composition;
}

/** A sky read from disk, whichever file format it came from. */
export interface OpenedSky extends Composition {
  name?: string;
  moniker?: MonikerBlock;
  /** Only the settings the file had; the caller fills the rest from defaults. */
  settings: Partial<Settings>;
  animation: Animation;
}

/** Every setting a sky file carries. Quality is the viewer's machine, not the sky. */
const SKY_KEYS = (Object.keys(DEFAULTS) as (keyof Settings)[]).filter((k) => k !== 'quality');

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
  naming: { name: string; moniker: MonikerBlock },
  animation: Animation = DEFAULT_ANIMATION,
): string {
  const file: SkyFile = {
    ...header('sky', naming.name, 'Skies', naming.moniker),
    params: paramsOf(settings, SKY_KEYS),
    sky: {
      shapes: shapes.map((s) => ({ ...s })),
      paint: {
        size: layers.size,
        tiles: layers.exportTiles().map((t) => ({
          layer: t.layer, tx: t.tx, ty: t.ty, data: toBase64(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)),
        })),
      },
      graph: graph.snapshot(),
      animation,
    },
  };
  return JSON.stringify(file);
}

/** Reads untrusted sky text: a .wcx sky, or a legacy .sky.json. Throws with a readable message. */
export function parseSky(text: string): OpenedSky {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const legacy = raw as { format?: unknown; version?: unknown; name?: string; moniker?: MonikerBlock; settings?: Partial<Settings> } & Composition;
  if (legacy && legacy.format === LEGACY_FORMAT) {
    if (legacy.version !== 1) throw new Error(`Unsupported sky file version ${String(legacy.version)}.`);
    const { quality: _quality, ...settings } = legacy.settings ?? {};
    return { name: legacy.name, moniker: legacy.moniker, settings, shapes: legacy.shapes, paint: legacy.paint, graph: legacy.graph, animation: { ...DEFAULT_ANIMATION } };
  }
  const error = wcxError(raw);
  if (error) throw new Error(`This is ${error}.`);
  const file = raw as Partial<SkyFile>;
  if (file.kind !== 'sky' || !file.sky) throw new Error('This .wcx is a look, not a sky. Use Looks › Import to apply it.');
  const settings: Partial<Settings> = {};
  for (const p of file.params ?? []) {
    const key = settingOf(p);
    if (key && typeof p.value === 'number' && Number.isFinite(p.value)) (settings[key] as number) = p.value;
  }
  return { name: file.name, moniker: file.moniker, settings, ...file.sky, animation: parseAnimation(file.sky.animation) };
}

export function paintTilesOf(doc: OpenedSky, size: number): PaintTile[] {
  if (doc.paint.size !== size) throw new Error(`Paint is ${doc.paint.size}², this build uses ${size}².`);
  return doc.paint.tiles.map((t) => {
    const bytes = fromBase64(t.data);
    const data = t.layer === 'warp'
      ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      : new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    return { layer: t.layer, tx: t.tx, ty: t.ty, data };
  });
}
