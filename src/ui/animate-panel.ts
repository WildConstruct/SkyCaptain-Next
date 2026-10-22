// Animate: the animation recipe (wind, cloud life, time-lapse, ease), keys, a time scrubber
// with live playback, and image-sequence export. At frame 0 every edit changes the composed
// sky. Scrubbed later, slider and shape edits become keys at that time (auto-key), and the
// sliders and shapes show their values at that time. Playback is a preview: the view
// refines progressively, so motion shimmers; the exported sequence renders every frame
// converged.

import {
  DEFAULT_ANIMATION, KEYABLE_SETTINGS, SHAPE_KEYS, frameCount, removeKey, setKey, settingsAt, shapesAt,
  timeInvalidation, type Animation, type KeyableSetting, type ShapeKey,
} from '../animation';
import type { History } from '../history';
import type { Renderer } from '../renderer';
import { folderSink, renderSequence, type FrameSink } from '../sequence';
import type { Settings } from '../settings';
import type { ShapeLayer, ShapeStore } from '../shapes';
import { download } from './export-panel';

const SIZES = [
  { label: '1K (1024×512)', width: 1024 },
  { label: '2K (2048×1024)', width: 2048 },
  { label: '4K (4096×2048)', width: 4096 },
];
const QUALITIES = [
  { label: 'Draft (2 samples)', samples: 2 },
  { label: 'Clean (8 samples)', samples: 8 },
  { label: 'Final (16 samples)', samples: 16 },
];

type NumberKey = 'duration' | 'fps' | 'timeLapse' | 'windSpeed' | 'windHeading' | 'cloudLife';
const FIELDS: { key: NumberKey; label: string; step: number; min: number; max: number; hint: string }[] = [
  { key: 'duration', label: 'Length (s)', step: 0.5, min: 0.5, max: 600, hint: 'Clip length in seconds' },
  { key: 'fps', label: 'Frame rate', step: 1, min: 1, max: 60, hint: 'Frames per second' },
  { key: 'timeLapse', label: 'Time-lapse ×', step: 10, min: 1, max: 10000, hint: 'Scene time per clip second: 120 means a 10 s clip covers 20 minutes of weather' },
  { key: 'windSpeed', label: 'Wind (km/h)', step: 1, min: 0, max: 300, hint: 'How fast the weather drifts. Changed after the start, it is keyed.' },
  { key: 'windHeading', label: 'Wind toward (°)', step: 5, min: -360, max: 360, hint: 'Compass heading the clouds move toward: 0 north, 90 east. Changed after the start, it is keyed.' },
  { key: 'cloudLife', label: 'Cloud life (min)', step: 1, min: 0, max: 600, hint: 'Minutes for clouds to fully change shape; 0 keeps their shapes and only drifts them' },
];

const SETTING_LABELS: Record<string, string> = {
  sunElevation: 'sun elevation', sunAzimuth: 'sun azimuth', sunIntensity: 'sun intensity', haze: 'clarity',
  groundAlbedo: 'ground albedo', coverage: 'coverage', typeBias: 'type', density: 'density', erosion: 'erosion',
  baseWeather: 'background', ambient: 'ambient', forwardG: 'silver lining', powder: 'powder', backG: 'back-scatter g',
  backWeight: 'back-scatter weight', cloudBottom: 'cloud base', cloudThickness: 'cumulus height',
  towerHeight: 'tower height', windSpeed: 'wind speed', windHeading: 'wind heading',
};

/** Whether a setting can be keyed. */
export function isKeyable(name: keyof Settings): name is KeyableSetting {
  return (KEYABLE_SETTINGS as readonly string[]).includes(name);
}

export class AnimatePanel {
  private animation: Animation = { ...DEFAULT_ANIMATION };
  private time = 0;
  private playing = false;
  private exporting = false;
  private cancelled = false;
  private readonly scrub: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly inputs = new Map<NumberKey, HTMLInputElement>();
  private readonly ease: HTMLSelectElement;
  private readonly keyList: HTMLElement;
  private lastKeyEdit = { name: '', at: 0 };

  constructor(
    root: HTMLElement,
    private renderer: Renderer,
    private settings: Settings,
    private filename: () => string,
    private store: ShapeStore,
    private history: History,
    /** Shows settings in the sliders without changing anything (the values at the current time). */
    private showSettings: (s: Settings) => void,
  ) {
    store.keyEdit = (id, changes) => this.keyShape(id, changes);
    store.onBaseChange = () => this.seek(this.time);
    const fields = document.createElement('div');
    fields.className = 'fields';
    for (const f of FIELDS) {
      const label = document.createElement('label');
      label.textContent = f.label;
      label.title = f.hint;
      const input = numberInput(f.min, f.max, f.step);
      input.title = f.hint;
      input.onchange = () => {
        const v = clampNumber(input, f.min, f.max, this.animation[f.key]);
        // Scrubbed away from frame 0, wind changes are keyed like any other setting.
        if (this.time > 0 && (f.key === 'windSpeed' || f.key === 'windHeading')) {
          this.recordUndo(`wind:${f.key}`);
          this.animation = setKey(this.animation, this.time, { sky: { [f.key]: v } });
          this.sync();
          this.seek(this.time);
        } else {
          this.edit(() => { this.animation[f.key] = v; });
        }
      };
      this.inputs.set(f.key, input);
      fields.append(label, input);
    }
    root.append(fields);

    // Keys: made by editing while scrubbed away from frame 0.
    const easeRow = document.createElement('div');
    easeRow.className = 'fields';
    const easeLabel = document.createElement('label');
    easeLabel.textContent = 'Between keys';
    this.ease = document.createElement('select');
    this.ease.add(new Option('Smooth', 'smooth'));
    this.ease.add(new Option('Linear', 'linear'));
    this.ease.onchange = () => this.edit(() => { this.animation.ease = this.ease.value as Animation['ease']; });
    easeRow.append(easeLabel, this.ease);
    this.keyList = document.createElement('div');
    this.keyList.className = 'keys';
    const keyHint = document.createElement('p');
    keyHint.className = 'hint';
    keyHint.textContent = 'To animate anything, scrub away from the start, then change sliders or move, resize or fade shapes: each change is keyed at that time. The start is always the sky as composed.';
    root.append(easeRow, this.keyList, keyHint);

    // Scrubber and playback.
    const timeRow = document.createElement('div');
    timeRow.className = 'row';
    this.timeLabel = document.createElement('span');
    const play = document.createElement('button');
    play.className = 'play';
    play.textContent = 'Play';
    this.scrub = document.createElement('input');
    this.scrub.type = 'range';
    this.scrub.min = '0';
    this.scrub.step = 'any';
    this.scrub.setAttribute('aria-label', 'Animation time');
    this.scrub.oninput = () => { this.playing = false; play.textContent = 'Play'; this.seek(Number(this.scrub.value)); };
    play.onclick = () => {
      this.playing = !this.playing;
      play.textContent = this.playing ? 'Pause' : 'Play';
      if (this.playing) {
        if (this.time >= this.animation.duration) this.seek(0);
        let last = performance.now();
        const tick = (now: number) => {
          if (!this.playing) return;
          this.seek(this.time + (now - last) / 1000);
          last = now;
          if (this.time >= this.animation.duration) { this.playing = false; play.textContent = 'Play'; return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    };
    const back = document.createElement('button');
    back.textContent = '⏮';
    back.title = 'Back to the start (the sky as composed)';
    back.onclick = () => { this.playing = false; play.textContent = 'Play'; this.seek(0); };
    timeRow.append(this.timeLabel, document.createElement('span'), this.scrub);
    const controls = document.createElement('div');
    controls.className = 'row actions';
    controls.append(back, play);
    root.append(timeRow, controls);

    this.summary = document.createElement('p');
    this.summary.className = 'hint';
    root.append(this.summary);

    // Sequence export.
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
    const exportButton = document.createElement('button');
    exportButton.textContent = 'Export sequence…';
    const cancel = document.createElement('button');
    cancel.textContent = 'Stop';
    cancel.hidden = true;
    cancel.onclick = () => { this.cancelled = true; };
    const progress = document.createElement('progress');
    progress.max = 1;
    progress.hidden = true;
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Lat-long frames like Export HDRI, each rendered fresh and converged. Chrome and Edge write them into a folder you pick; other browsers download each frame.';
    exportButton.onclick = async () => {
      if (this.exporting) return;
      let sink: FrameSink | null = null;
      try {
        sink = await folderSink();
      } catch {
        return; // Folder picker dismissed.
      }
      const viaDownloads = !sink;
      sink ??= async (name, bytes) => download(name, bytes, format.value === 'exr' ? 'image/x-exr' : 'image/vnd.radiance');
      this.playing = false;
      play.textContent = 'Play';
      this.exporting = true;
      this.cancelled = false;
      exportButton.disabled = true;
      cancel.hidden = false;
      progress.hidden = false;
      const started = performance.now();
      try {
        const written = await renderSequence(
          this.renderer, this.animation, this.store.baseShapes,
          { width: SIZES[Number(size.value)].width, samples: QUALITIES[Number(quality.value)].samples, format: format.value as 'exr' | 'hdr', name: this.filename() },
          sink,
          (frame, total, within) => {
            progress.value = (frame + within) / total;
            note.textContent = `Rendering frame ${frame + 1} of ${total}…`;
          },
          () => this.cancelled,
        );
        const secs = (performance.now() - started) / 1000;
        note.textContent = `${this.cancelled ? 'Stopped after' : 'Exported'} ${written} frame${written === 1 ? '' : 's'} in ${secs.toFixed(0)} s (${(secs / Math.max(1, written)).toFixed(1)} s per frame)${viaDownloads ? ' as downloads' : ''}.`;
      } catch (err) {
        note.textContent = `Sequence export failed: ${err instanceof Error ? err.message : err}`;
      } finally {
        this.exporting = false;
        exportButton.disabled = false;
        cancel.hidden = true;
        progress.hidden = true;
        this.seek(this.time);
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
    go.append(exportButton, cancel);
    root.append(go, progress, note);

    this.sync();
  }

  get value(): Animation {
    return structuredClone(this.animation);
  }

  /** Replaces the recipe (opening a sky) and returns to the start. */
  set value(a: Animation) {
    this.animation = structuredClone(a);
    this.playing = false;
    this.sync();
    this.seek(0);
    this.renderer.setTime(null, 'sky');
  }

  /** Clip time on show, seconds. Above 0, edits become keys. */
  get currentTime(): number {
    return this.time;
  }

  /** Shows the sky at clip time t: renderer, shape layers and sliders. t = 0 is the sky as composed. */
  seek(t: number): void {
    this.time = Math.min(Math.max(0, t), this.animation.duration);
    this.scrub.value = String(this.time);
    const a = this.animation;
    const time = this.time;
    this.renderer.setTime(time > 0 ? (s) => settingsAt(s, a, time) : null, timeInvalidation(a));
    if (time > 0) this.store.showAnimated(shapesAt(this.store.baseShapes, a, time));
    else this.store.showBase();
    this.showSettings(time > 0 ? settingsAt(this.settings, a, time) : this.settings);
    this.label();
  }

  /** Keys a setting at the current time (the caller only does this when time > 0). */
  keySetting(name: KeyableSetting, value: number): void {
    this.recordUndo(`setting:${name}`);
    this.animation = setKey(this.animation, this.time, { sky: { [name]: value } });
    this.sync();
    this.seek(this.time);
  }

  /** Shape edits in the animated view: keyable properties become keys at the current time. */
  private keyShape(id: string, changes: Partial<ShapeLayer>): Partial<ShapeLayer> {
    const values: Partial<Record<ShapeKey, number>> = {};
    for (const key of SHAPE_KEYS) {
      const v = changes[key];
      if (typeof v === 'number') values[key] = v;
    }
    if (Object.keys(values).length) {
      this.recordUndo(`shape:${id}`);
      this.animation = setKey(this.animation, this.time, { shape: { id, values } });
      this.sync();
      // The store applies the change to its view itself; renderer and sliders follow on seek.
      queueMicrotask(() => this.renderer.setShapes(this.store.shapes));
    }
    return values;
  }

  /** One undo step per gesture: edits to the same thing within half a second merge. */
  private recordUndo(name: string): void {
    const now = performance.now();
    if (this.lastKeyEdit.name === name && now - this.lastKeyEdit.at < 500) {
      this.lastKeyEdit.at = now;
      return;
    }
    this.lastKeyEdit = { name, at: now };
    const snapshot = (a: Animation) => ({
      apply: () => {
        const current = this.animation;
        this.animation = a;
        this.sync();
        this.seek(this.time);
        return snapshot(current);
      },
    });
    this.history.push(snapshot(structuredClone(this.animation)));
  }

  private edit(change: () => void): void {
    change();
    this.sync();
    this.seek(this.time);
  }

  private sync(): void {
    for (const [key, input] of this.inputs) input.value = String(this.animation[key]);
    this.ease.value = this.animation.ease;
    this.renderKeys();
    this.scrub.max = String(this.animation.duration);
    const a = this.animation;
    const sceneMin = (a.duration * a.timeLapse) / 60;
    const driftKm = (a.windSpeed * sceneMin) / 60;
    this.summary.textContent = `${frameCount(a)} frames · ${formatMinutes(sceneMin)} of weather · clouds drift ${driftKm.toFixed(1)} km${a.cloudLife > 0 ? ` and turn over ${(sceneMin / a.cloudLife).toFixed(1)}×` : ''}.`;
    this.label();
  }

  private renderKeys(): void {
    this.keyList.replaceChildren();
    if (!this.animation.keys.length) return;
    const names = (k: Animation['keys'][number]) => {
      const parts = Object.keys(k.sky).map((n) => SETTING_LABELS[n] ?? n);
      const shapes = Object.keys(k.shapes).length;
      if (shapes) parts.push(`${shapes} shape${shapes === 1 ? '' : 's'}`);
      return parts.join(', ');
    };
    this.animation.keys.forEach((k, i) => {
      const row = document.createElement('div');
      row.className = 'key';
      const go = document.createElement('button');
      go.className = 'key-time';
      go.textContent = `${k.time.toFixed(2)} s`;
      go.title = 'Go to this key';
      go.onclick = () => { this.playing = false; this.seek(k.time); };
      const what = document.createElement('span');
      what.textContent = names(k);
      const del = document.createElement('button');
      del.className = 'icon';
      del.textContent = '×';
      del.title = 'Remove this key';
      del.onclick = () => {
        this.recordUndo(`remove:${i}:${performance.now()}`);
        this.animation = removeKey(this.animation, i);
        this.sync();
        this.seek(this.time);
      };
      row.append(go, what, del);
      this.keyList.append(row);
    });
  }

  private label(): void {
    const sceneMin = (this.time * this.animation.timeLapse) / 60;
    this.timeLabel.textContent = `${this.time.toFixed(1)} s · +${formatMinutes(sceneMin)}`;
  }
}

function numberInput(min: number, max: number, step: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  return input;
}

function clampNumber(input: HTMLInputElement, min: number, max: number, fallback: number): number {
  const v = Number(input.value);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function formatMinutes(min: number): string {
  if (min < 1) return `${Math.round(min * 60)} s`;
  if (min < 120) return `${min.toFixed(min < 10 ? 1 : 0)} min`;
  return `${(min / 60).toFixed(1)} h`;
}
