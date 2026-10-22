import { DEFAULTS, QUALITY, QualityName, Settings, invalidationFor } from './settings';
import { Renderer, WEATHER_SIZE } from './renderer';
import { History } from './history';
import { BRUSH_TOOLS, PaintLayers } from './paint';
import { Stroke, ToolState } from './ui/tools';
import { BrushPanel } from './ui/brush-panel';
import { viewUniforms } from './camera';
import { ShapeKind, ShapeLayer, ShapeStore, createShape } from './shapes';
import { SkyOverlay } from './ui/sky-overlay';
import { Minimap } from './ui/minimap';
import { ShapesPanel } from './ui/shapes-panel';
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
      { key: 'baseWeather', label: 'Background weather', min: 0, max: 1, step: 0.01 },
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
      { key: 'cloudThickness', label: 'Cumulus height', min: 0.5, max: 6, step: 0.05, unit: 'km' },
      { key: 'towerHeight', label: 'Max tower height', min: 2, max: 14, step: 0.1, unit: 'km' },
      { key: 'shapeScale', label: 'Shape scale', min: 2, max: 40, step: 0.1, unit: 'km' },
      { key: 'detailScale', label: 'Detail scale', min: 0.2, max: 6, step: 0.05, unit: 'km' },
      { key: 'weatherScale', label: 'Weather map extent', min: 100, max: 600, step: 10, unit: 'km' },
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

function readUrlOverrides(base: Settings, query: URLSearchParams): Settings {
  const s = { ...base };
  for (const key of Object.keys(base) as (keyof Settings)[]) {
    const v = query.get(key);
    if (v === null) continue;
    if (key === 'quality') s.quality = v as QualityName;
    else (s[key] as number) = Number(v);
  }
  return s;
}

/** `?shapes=[{"kind":"storm_cell","x":10,"z":30,...}]` seeds the layer stack (used by tools/). */
function readUrlShapes(query: URLSearchParams): ShapeLayer[] {
  const raw = query.get('shapes');
  if (!raw) return [];
  const items = JSON.parse(raw) as (Partial<ShapeLayer> & { kind: ShapeKind })[];
  return items.map((item, i) => ({ ...createShape(item.kind, 0, 0, i + 1), ...item }));
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
  const overlayCanvas = document.querySelector<HTMLCanvasElement>('#overlay')!;
  const panel = document.querySelector<HTMLElement>('#controls')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const query = new URLSearchParams(location.search);
  const settings = readUrlOverrides(DEFAULTS, query);
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

  const history = new History();
  const store = new ShapeStore(history);
  const layers = new PaintLayers(WEATHER_SIZE, history);
  layers.extent = settings.weatherScale;
  const tools = new ToolState();
  const stroke = new Stroke(layers, tools);
  store.shapes = readUrlShapes(query);
  renderer.setShapes(store.shapes);
  store.subscribe(() => renderer.setShapes(store.shapes));

  // Debug/automation hooks for tools/: raw texel reads, offscreen captures, the shape store.
  Object.assign(window, {
    skyRenderer: renderer,
    skyShapes: store,
    skyPaint: layers,
    skyTools: tools,
    skyHistory: history,
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

  const overlay = new SkyOverlay({ canvas: overlayCanvas, settings, store, tools, stroke, setView: set });

  const header = document.createElement('div');
  header.className = 'row actions';
  const quality = document.createElement('select');
  for (const [name, q] of Object.entries(QUALITY)) quality.add(new Option(q.label, name, false, name === settings.quality));
  quality.onchange = () => {
    settings.quality = quality.value as QualityName;
    renderer.update(settings, 'clouds');
  };
  const reroll = document.createElement('button');
  reroll.textContent = 'New background weather';
  reroll.onclick = () => set('seed', settings.seed + 1);
  header.append(quality, reroll);
  panel.append(header);

  const mapCanvas = document.createElement('canvas');
  mapCanvas.className = 'minimap';
  mapCanvas.title = 'Weather map. Drag shapes, handles resize and rotate, wheel zooms.';
  panel.append(mapCanvas);
  const minimap = new Minimap(mapCanvas, settings, store, tools, stroke);

  const toolsSection = document.createElement('details');
  toolsSection.open = true;
  const toolsSummary = document.createElement('summary');
  toolsSummary.textContent = 'Tools';
  const toolsRoot = document.createElement('div');
  toolsSection.append(toolsSummary, toolsRoot);
  panel.append(toolsSection);
  new BrushPanel(toolsRoot, tools, layers);

  const shapesSection = document.createElement('details');
  shapesSection.open = true;
  const shapesSummary = document.createElement('summary');
  shapesSummary.textContent = 'Shapes';
  const shapesRoot = document.createElement('div');
  shapesSection.append(shapesSummary, shapesRoot);
  panel.append(shapesSection);
  new ShapesPanel(shapesRoot, store, (kind) => {
    const [x, z] = overlay.centerMapPoint();
    store.add(createShape(kind, x, z, Math.floor(Math.random() * 10000)));
  });

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

  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range';
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) history.redo(); else history.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      history.redo();
    } else if (!mod && e.key.toLowerCase() === 'v') {
      tools.setMode('shapes');
    } else if (!mod && /^[1-6]$/.test(e.key)) {
      tools.setMode(BRUSH_TOOLS[Number(e.key) - 1].tool);
    } else if (!mod && (e.key === '[' || e.key === ']')) {
      const size = tools.brush.size * (e.key === ']' ? 1.2 : 1 / 1.2);
      tools.setBrush({ size: Math.max(0.5, Math.min(40, size)) });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.selected && !tools.painting) {
      e.preventDefault();
      store.remove(store.selected);
    }
  });

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // Minimap coverage refreshes after the weather map changes, one readback at a time.
  let shownWeather = -1;
  let reading = false;
  const refreshMinimap = () => {
    if (reading || renderer.weatherVersion === shownWeather) return;
    reading = true;
    const version = renderer.weatherVersion;
    renderer.readWeather().then(({ size, data }) => {
      minimap.setWeather(size, data, settings.weatherScale);
      shownWeather = version;
    }).finally(() => { reading = false; });
  };

  const adapter = renderer.adapterInfo;
  const loop = () => {
    layers.extent = settings.weatherScale;
    layers.flush((name, x, y, w, h, data) => renderer.uploadLayer(name, x, y, w, h, data));
    const stats = renderer.frame(viewUniforms(settings, canvas.width / canvas.height));
    const progress = stats.frame >= stats.totalFrames ? 'converged' : `refining ${stats.frame}/${stats.totalFrames}`;
    const timing = stats.cloudMs === null ? '' : ` · cloud pass ${stats.cloudMs.toFixed(2)} ms`;
    status.textContent = `${progress}${timing} · ${stats.faceSize}² cube · ${adapter}`;
    document.body.dataset.converged = String(stats.frame >= stats.totalFrames);
    refreshMinimap();
    minimap.viewAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    minimap.draw();
    overlay.draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();
