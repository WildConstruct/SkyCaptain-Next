// Image-sequence export: every frame of an animation rendered fresh at export quality
// (fully converged, so no shimmer) and written as numbered lat-long files.

import { frameCount, frameTime, movesSun, settingsAt, type Animation } from './animation';
import { encodeOpenEXR, encodeRadianceHDR } from './hdr-files';
import type { Renderer } from './renderer';

export interface SequenceOptions {
  width: number;
  samples: number;
  format: 'exr' | 'hdr';
  /** File stem; frames are <name>.0001.exr and so on. */
  name: string;
}

/** Receives each finished frame. Resolves when the bytes are safely written. */
export type FrameSink = (fileName: string, bytes: Uint8Array) => Promise<void>;

export function frameName(name: string, index: number, ext: string): string {
  return `${name}.${String(index + 1).padStart(4, '0')}.${ext}`;
}

/**
 * Renders frames [first, last] (inclusive, 0-based) through the sink. Leaves the renderer
 * showing the sky as composed. `cancel()` returning true stops after the current frame.
 */
export async function renderSequence(
  renderer: Renderer,
  animation: Animation,
  options: SequenceOptions,
  sink: FrameSink,
  onProgress?: (frame: number, total: number, withinFrame: number) => void,
  cancel?: () => boolean,
  range?: [number, number],
): Promise<number> {
  const total = frameCount(animation);
  const [first, last] = range ?? [0, total - 1];
  const invalidation = movesSun(animation) ? 'sky' : 'clouds';
  let written = 0;
  try {
    for (let i = first; i <= last && i < total; i++) {
      if (cancel?.()) break;
      const t = frameTime(animation, i);
      renderer.setTime((s) => settingsAt(s, animation, t), invalidation);
      const image = await renderer.exportLatLong(options.width, options.samples, (p) => onProgress?.(i, total, p));
      const bytes = options.format === 'exr'
        ? encodeOpenEXR(image.width, image.height, image.data).bytes
        : encodeRadianceHDR(image.width, image.height, image.data);
      await sink(frameName(options.name, i, options.format), bytes);
      written++;
    }
  } finally {
    renderer.setTime(null, invalidation);
  }
  return written;
}

interface DirectoryHandle {
  getFileHandle(name: string, options: { create: boolean }): Promise<{
    createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>;
  }>;
}

/**
 * Asks for a folder and writes frames into it (Chromium browsers). Returns null where the
 * browser has no folder access (Safari, Firefox); the caller falls back to downloads.
 */
export async function folderSink(): Promise<FrameSink | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<DirectoryHandle> }).showDirectoryPicker;
  if (!picker) return null;
  const dir = await picker({ mode: 'readwrite', id: 'skycaptain-sequence' });
  return async (fileName, bytes) => {
    const file = await dir.getFileHandle(fileName, { create: true });
    const out = await file.createWritable();
    await out.write(bytes as BlobPart);
    await out.close();
  };
}
