// Animate: the animation recipe (wind, cloud life, time-lapse, optional sun move), a time
// scrubber with live playback, and image-sequence export. Playback is a preview: the view
// refines progressively, so motion shimmers; the exported sequence renders every frame
// converged.

import { DEFAULT_ANIMATION, frameCount, movesSun, settingsAt, type Animation } from '../animation';
import type { Renderer } from '../renderer';
import { folderSink, renderSequence, type FrameSink } from '../sequence';
import type { Settings } from '../settings';
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
  { key: 'windSpeed', label: 'Wind (km/h)', step: 1, min: 0, max: 300, hint: 'How fast the weather drifts' },
  { key: 'windHeading', label: 'Wind toward (°)', step: 5, min: -360, max: 360, hint: 'Compass heading the clouds move toward: 0 north, 90 east' },
  { key: 'cloudLife', label: 'Cloud life (min)', step: 1, min: 0, max: 600, hint: 'Minutes for clouds to fully change shape; 0 keeps their shapes and only drifts them' },
];

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
  private readonly sunCheck: HTMLInputElement;
  private readonly sunElevation: HTMLInputElement;
  private readonly sunAzimuth: HTMLInputElement;

  constructor(
    root: HTMLElement,
    private renderer: Renderer,
    private settings: Settings,
    private filename: () => string,
  ) {
    const fields = document.createElement('div');
    fields.className = 'fields';
    for (const f of FIELDS) {
      const label = document.createElement('label');
      label.textContent = f.label;
      label.title = f.hint;
      const input = numberInput(f.min, f.max, f.step);
      input.title = f.hint;
      input.onchange = () => this.edit(() => { this.animation[f.key] = clampNumber(input, f.min, f.max, this.animation[f.key]); });
      this.inputs.set(f.key, input);
      fields.append(label, input);
    }
    root.append(fields);

    // Optional sun move.
    const sunRow = document.createElement('label');
    sunRow.className = 'check';
    this.sunCheck = document.createElement('input');
    this.sunCheck.type = 'checkbox';
    sunRow.append(this.sunCheck, 'Move the sun by the end');
    this.sunElevation = numberInput(-10, 90, 0.5);
    this.sunAzimuth = numberInput(-180, 180, 1);
    const sunFields = document.createElement('div');
    sunFields.className = 'fields';
    const lab = (t: string) => { const l = document.createElement('label'); l.textContent = t; return l; };
    sunFields.append(lab('End elevation (°)'), this.sunElevation, lab('End azimuth (°)'), this.sunAzimuth);
    const applySun = () => this.edit(() => {
      this.animation.sunEnd = this.sunCheck.checked
        ? { elevation: clampNumber(this.sunElevation, -10, 90, this.settings.sunElevation), azimuth: clampNumber(this.sunAzimuth, -180, 180, this.settings.sunAzimuth) }
        : null;
    });
    this.sunCheck.onchange = () => {
      if (this.sunCheck.checked && !this.animation.sunEnd) {
        // Start from the current sun, a few degrees lower: a sensible first sunset.
        this.sunElevation.value = String(Math.max(-2, this.settings.sunElevation - 15));
        this.sunAzimuth.value = String(this.settings.sunAzimuth);
      }
      applySun();
    };
    this.sunElevation.onchange = applySun;
    this.sunAzimuth.onchange = applySun;
    root.append(sunRow, sunFields);

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
          this.renderer, this.animation,
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
    return { ...this.animation, sunEnd: this.animation.sunEnd ? { ...this.animation.sunEnd } : null };
  }

  /** Replaces the recipe (opening a sky) and returns to the start. */
  set value(a: Animation) {
    this.animation = { ...a, sunEnd: a.sunEnd ? { ...a.sunEnd } : null };
    this.playing = false;
    this.time = 0;
    this.sync();
    this.renderer.setTime(null, 'sky');
  }

  /** Shows the sky at clip time t. t = 0 is exactly the sky as composed. */
  seek(t: number): void {
    this.time = Math.min(Math.max(0, t), this.animation.duration);
    this.scrub.value = String(this.time);
    const a = this.animation;
    const time = this.time;
    const invalidation = movesSun(a) ? 'sky' : 'clouds';
    this.renderer.setTime(time > 0 ? (s) => settingsAt(s, a, time) : null, invalidation);
    this.label();
  }

  private edit(change: () => void): void {
    change();
    this.sync();
    this.seek(this.time);
  }

  private sync(): void {
    for (const [key, input] of this.inputs) input.value = String(this.animation[key]);
    this.sunCheck.checked = this.animation.sunEnd !== null;
    this.sunElevation.disabled = this.sunAzimuth.disabled = !this.sunCheck.checked;
    if (this.animation.sunEnd) {
      this.sunElevation.value = String(this.animation.sunEnd.elevation);
      this.sunAzimuth.value = String(this.animation.sunEnd.azimuth);
    }
    this.scrub.max = String(this.animation.duration);
    const a = this.animation;
    const sceneMin = (a.duration * a.timeLapse) / 60;
    const driftKm = (a.windSpeed * sceneMin) / 60;
    this.summary.textContent = `${frameCount(a)} frames · ${formatMinutes(sceneMin)} of weather · clouds drift ${driftKm.toFixed(1)} km${a.cloudLife > 0 ? ` and turn over ${(sceneMin / a.cloudLife).toFixed(1)}×` : ''}.`;
    this.label();
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
