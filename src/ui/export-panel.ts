// HDRI export: renders the environment at export quality and downloads .exr or .hdr.

import type { Renderer } from '../renderer';
import { encodeOpenEXR, encodeRadianceHDR } from '../hdr-files';

const SIZES = [
  { label: '2K (2048×1024)', width: 2048 },
  { label: '4K (4096×2048)', width: 4096 },
  { label: '1K (1024×512)', width: 1024 },
];
const QUALITIES = [
  { label: 'Clean (8 samples)', samples: 8 },
  { label: 'Draft (2 samples)', samples: 2 },
  { label: 'Final (16 samples)', samples: 16 },
];

export function download(name: string, bytes: Uint8Array | string, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export class ExportPanel {
  constructor(root: HTMLElement, renderer: Renderer, filename: () => string) {
    const pick = <T extends { label: string }>(items: T[]) => {
      const s = document.createElement('select');
      items.forEach((item, i) => s.add(new Option(item.label, String(i))));
      return s;
    };
    const format = document.createElement('select');
    format.add(new Option('OpenEXR (.exr)', 'exr'));
    format.add(new Option('Radiance (.hdr)', 'hdr'));
    const size = pick(SIZES);
    const quality = pick(QUALITIES);
    const button = document.createElement('button');
    button.textContent = 'Export HDRI';
    const progress = document.createElement('progress');
    progress.max = 1;
    progress.value = 0;
    progress.hidden = true;
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Scene-linear lat-long, north at the centre. Rendered fresh at export quality; the view keeps working.';

    button.onclick = async () => {
      button.disabled = true;
      progress.hidden = false;
      progress.value = 0;
      const started = performance.now();
      try {
        const { width } = SIZES[Number(size.value)];
        const { samples } = QUALITIES[Number(quality.value)];
        const image = await renderer.exportLatLong(width, samples, (p) => { progress.value = p; });
        const ext = format.value;
        let detail = '';
        let bytes: Uint8Array;
        if (ext === 'exr') {
          const exr = encodeOpenEXR(image.width, image.height, image.data);
          bytes = exr.bytes;
          detail = exr.pixelType === 'half' ? ' (half float)' : ' (32-bit float: the sun exceeds the half-float range)';
        } else {
          bytes = encodeRadianceHDR(image.width, image.height, image.data);
        }
        download(`${filename()}.${ext}`, bytes, ext === 'exr' ? 'image/x-exr' : 'image/vnd.radiance');
        note.textContent = `Exported ${image.width}×${image.height} ${ext.toUpperCase()}${detail} in ${((performance.now() - started) / 1000).toFixed(1)} s.`;
      } catch (err) {
        note.textContent = `Export failed: ${err instanceof Error ? err.message : err}`;
      } finally {
        button.disabled = false;
        progress.hidden = true;
      }
    };

    for (const el of [format, size, quality]) {
      const row = document.createElement('div');
      row.className = 'row actions';
      row.append(el);
      root.append(row);
    }
    const go = document.createElement('div');
    go.className = 'row actions';
    go.append(button);
    root.append(go, progress, note);
  }
}
