import { DEFAULTS, QUALITY, QualityName, Settings, invalidationFor } from './settings';
import { Renderer } from './renderer';
import './style.css';

interface SliderSpec {
  key: keyof Settings;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

const GROUPS: { title: string; expert?: boolean; sliders: SliderSpec[] }[] = [
  {
    title: 'Sun & sky',
    sliders: [
      { key: 'sunElevation', label: 'Sun elevation', min: -4, max: 90, step: 0.1, unit: '°' },
      { key: 'sunAzimuth', label: 'Sun azimuth', min: -180, max: 180, step: 0.5, unit: '°' },
      { key: 'sunIntensity', label: 'Sun intensity', min: 1, max: 100, step: 0.5 },
      { key: 'haze', label: 'Clarity', min: 5, max: 120, step: 1, unit: 'km' },
    ],
  },
  {
    title: 'Clouds',
    sliders: [
      { key: 'coverage', label: 'Coverage', min: 0, max: 1, step: 0.005 },
      { key: 'typeBias', label: 'Type (stratus ↔ towers)', min: -1, max: 1, step: 0.01 },
      { key: 'density', label: 'Density', min: 2, max: 120, step: 0.5 },
      { key: 'erosion', label: 'Detail erosion', min: 0, max: 1, step: 0.01 },
      { key: 'windX', label: 'Drift X', min: -40, max: 40, step: 0.05, unit: 'km' },
      { key: 'windZ', label: 'Drift Z', min: -40, max: 40, step: 0.05, unit: 'km' },
    ],
  },
  {
    title: 'Light',
    sliders: [
      { key: 'ambient', label: 'Ambient', min: 0, max: 3, step: 0.01 },
      { key: 'forwardG', label: 'Silver lining', min: 0, max: 0.95, step: 0.01 },
      { key: 'powder', label: 'Dark edges (powder)', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'Expert',
    expert: true,
    sliders: [
      { key: 'cloudBottom', label: 'Cloud base', min: 0.3, max: 6, step: 0.05, unit: 'km' },
      { key: 'cloudThickness', label: 'Layer thickness', min: 0.5, max: 10, step: 0.05, unit: 'km' },
      { key: 'shapeScale', label: 'Shape scale', min: 2, max: 40, step: 0.1, unit: 'km' },
      { key: 'detailScale', label: 'Detail scale', min: 0.2, max: 6, step: 0.05, unit: 'km' },
      { key: 'weatherScale', label: 'Weather map size', min: 10, max: 200, step: 1, unit: 'km' },
      { key: 'backG', label: 'Back-scatter g', min: 0, max: 0.9, step: 0.01 },
      { key: 'backWeight', label: 'Back-scatter weight', min: 0, max: 1, step: 0.01 },
      { key: 'msA', label: 'Octave scatter a', min: 0, max: 1, step: 0.01 },
      { key: 'msB', label: 'Octave extinction b', min: 0, max: 1, step: 0.01 },
      { key: 'msC', label: 'Octave eccentricity c', min: 0, max: 1, step: 0.01 },
      { key: 'octaves', label: 'Scattering octaves', min: 1, max: 4, step: 1 },
      { key: 'groundAlbedo', label: 'Ground albedo', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'View (preview only)',
    sliders: [
      { key: 'ev', label: 'Exposure', min: -8, max: 8, step: 0.05, unit: 'EV' },
      { key: 'fov', label: 'Field of view', min: 20, max: 120, step: 1, unit: '°' },
    ],
  },
];

function readUrlOverrides(base: Settings): Settings {
  const s = { ...base };
  const query = new URLSearchParams(location.search);
  for (const key of Object.keys(base) as (keyof Settings)[]) {
    const v = query.get(key);
    if (v === null) continue;
    if (key === 'quality') s.quality = v as QualityName;
    else (s[key] as number) = Number(v);
  }
  return s;
}

export function viewUniforms(s: Settings, aspect: number): Float32Array<ArrayBuffer> {
  const yaw = (s.yaw * Math.PI) / 180;
  const pitch = (s.pitch * Math.PI) / 180;
  const f = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const r = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  const tanHalf = Math.tan((s.fov * Math.PI) / 360);
  return new Float32Array([...r, tanHalf * aspect, ...u, tanHalf, ...f, s.ev]);
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
  const panel = document.querySelector<HTMLElement>('#controls')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const settings = readUrlOverrides(DEFAULTS);
  const query = new URLSearchParams(location.search);
  const noiseSize = Number(query.get('noise') ?? 128);

  let renderer: Renderer;
  try {
    const present = query.get('headless') === null;
    renderer = await Renderer.create(canvas, settings, { shape: noiseSize, detail: Math.max(16, noiseSize / 4) }, present);
  } catch (err) {
    status.textContent = String(err);
    status.classList.add('error');
    return;
  }

  // Debug/automation hooks for tools/: raw texel reads and offscreen captures.
  Object.assign(window, {
    skyRenderer: renderer,
    skyCapture: (w: number, h: number) => renderer.capture(viewUniforms(settings, w / h), w, h),
  });

  const inputs = new Map<keyof Settings, { input: HTMLInputElement; value: HTMLElement; unit: string }>();
  const set = (key: keyof Settings, value: number) => {
    (settings[key] as number) = value;
    const ui = inputs.get(key);
    if (ui) {
      ui.input.value = String(value);
      ui.value.textContent = `${+value.toFixed(3)}${ui.unit}`;
    }
    renderer.update(settings, invalidationFor(key));
  };

  const header = document.createElement('div');
  header.className = 'row actions';
  const quality = document.createElement('select');
  for (const [name, q] of Object.entries(QUALITY)) quality.add(new Option(q.label, name, false, name === settings.quality));
  quality.onchange = () => {
    settings.quality = quality.value as QualityName;
    renderer.update(settings, 'clouds');
  };
  const reroll = document.createElement('button');
  reroll.textContent = 'New weather';
  reroll.onclick = () => set('seed', settings.seed + 1);
  header.append(quality, reroll);
  panel.append(header);

  for (const group of GROUPS) {
    const details = document.createElement('details');
    details.open = !group.expert;
    const summary = document.createElement('summary');
    summary.textContent = group.title;
    details.append(summary);
    for (const spec of group.sliders) {
      const row = document.createElement('label');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = spec.label;
      const value = document.createElement('span');
      value.className = 'value';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(settings[spec.key]);
      input.oninput = () => set(spec.key, Number(input.value));
      input.ondblclick = () => set(spec.key, DEFAULTS[spec.key] as number);
      row.append(name, value, input);
      details.append(row);
      inputs.set(spec.key, { input, value, unit: spec.unit ?? '' });
      value.textContent = `${settings[spec.key]}${spec.unit ?? ''}`;
    }
    panel.append(details);
  }

  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const scale = settings.fov / canvas.clientHeight;
    set('yaw', settings.yaw - (e.clientX - drag.x) * scale);
    set('pitch', Math.max(-89, Math.min(89, settings.pitch + (e.clientY - drag.y) * scale)));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    set('fov', Math.max(20, Math.min(120, settings.fov * Math.exp(e.deltaY * 0.001))));
  }, { passive: false });

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const adapter = renderer.adapterInfo;
  const loop = () => {
    const stats = renderer.frame(viewUniforms(settings, canvas.width / canvas.height));
    const progress = stats.frame >= stats.totalFrames ? 'converged' : `refining ${stats.frame}/${stats.totalFrames}`;
    const timing = stats.cloudMs === null ? '' : ` · cloud pass ${stats.cloudMs.toFixed(2)} ms`;
    status.textContent = `${progress}${timing} · ${stats.faceSize}² cube · ${adapter}`;
    document.body.dataset.converged = String(stats.frame >= stats.totalFrames);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();
