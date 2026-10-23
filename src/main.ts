import { DEFAULTS, QUALITY, QualityName, Settings, invalidationFor } from './settings';
import { Renderer, WEATHER_SIZE } from './renderer';
import { History } from './history';
import { BRUSH_TOOLS, PaintLayers } from './paint';
import { Stroke, ToolState } from './ui/tools';
import { BrushPanel } from './ui/brush-panel';
import { SkyGraph } from './psg';
import { PsgPanel } from './ui/psg-panel';
import { ExportPanel, download } from './ui/export-panel';
import { AnimatePanel, isKeyable } from './ui/animate-panel';
import { renderSequence, type SequenceOptions } from './sequence';
import { paintTilesOf, parseSky, saveSky } from './document';
import { LooksPanel } from './ui/looks-panel';
import * as presets from './presets';
import skyVocabulary from './moniker/skycaptain-sky.moniker?raw';
import { describeSky, monikerBlock } from './moniker/skycaptain';
import { viewUniforms } from './camera';
import { ShapeKind, ShapeLayer, ShapeStore, createShape } from './shapes';
import { SkyOverlay } from './ui/sky-overlay';
import { Minimap } from './ui/minimap';
import { ShapesPanel } from './ui/shapes-panel';
import { GroundPanel } from './ui/ground-panel';
import { GroundStore } from './ground';
import terrainGraph from '../examples/terrain-biomes.psg?raw';
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
      { key: 'density', label: 'Density', min: 10, max: 1000, step: 1, unit: '/km' },
      { key: 'erosion', label: 'Detail erosion', min: 0, max: 2, step: 0.01 },
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
      { key: 'shapeScale', label: 'Shape scale', min: 1, max: 20, step: 0.1, unit: 'km' },
      { key: 'detailScale', label: 'Detail scale', min: 0.05, max: 2, step: 0.01, unit: 'km' },
      { key: 'weatherScale', label: 'Weather map extent', min: 100, max: 600, step: 10, unit: 'km' },
      { key: 'backG', label: 'Back-scatter g', min: 0, max: 0.9, step: 0.01 },
      { key: 'backWeight', label: 'Back-scatter weight', min: 0, max: 1, step: 0.01 },
      { key: 'msA', label: 'Octave scatter a', min: 0, max: 1, step: 0.01 },
      { key: 'msB', label: 'Octave extinction b', min: 0, max: 1, step: 0.01 },
      { key: 'msC', label: 'Octave eccentricity c', min: 0, max: 1, step: 0.01 },
      { key: 'octaves', label: 'Scattering octaves', min: 1, max: 12, step: 1 },
      { key: 'groundAlbedo', label: 'Ground albedo', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'Eye',
    sliders: [
      { key: 'eyeAltitude', label: 'Elevation', min: 0, max: 20, step: 0.01, unit: 'km' },
    ],
  },
  {
    title: 'View (preview only)',
    sliders: [
      { key: 'ev', label: 'Exposure', min: -8, max: 8, step: 0.05, unit: 'EV' },
      { key: 'fov', label: 'Field of view', min: 20, max: 120, step: 1, unit: '°' },
      { key: 'softness', label: 'Softness', min: 0, max: 3, step: 0.05, unit: 'px' },
      { key: 'grain', label: 'Grain', min: 0, max: 0.08, step: 0.002 },
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
  // Dev overrides for tools/: cube face size and samples of the active quality tier.
  const tier = QUALITY[settings.quality];
  if (query.get('face')) tier.faceSize = Number(query.get('face'));
  if (query.get('samples')) tier.samples = Number(query.get('samples'));
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
  const skyVocab = JSON.parse(skyVocabulary);
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
    skyConverge: () => renderer.converge(),
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

  // Ground terrain: ?terrain=1 turns it on for tools/, with optional terrainSeed,
  // terrainWater, terrainRelief, terrainPatch, terrainTile, terrainHeight, terrainRidges and
  // terrainSnow.
  const ground = new GroundStore();
  ground.subscribe(() => renderer.setTerrain(ground.enabled ? { map: ground.map, recipe: ground.recipe, height: ground.height, place: ground.place } : null));
  if (query.get('terrain') === '1') {
    const num = (key: string) => (query.get(key) === null ? undefined : Number(query.get(key)));
    const changes = Object.fromEntries(Object.entries({
      seed: num('terrainSeed'), waterLevel: num('terrainWater'), relief: num('terrainRelief'),
      patchKm: num('terrainPatch'), tileKm: num('terrainTile'),
      heightKm: num('terrainHeight'), ridges: num('terrainRidges'), snowKm: num('terrainSnow'),
    }).filter(([, v]) => v !== undefined));
    ground.enabled = true;
    ground.update(changes);
  }
  const skyGraph = new SkyGraph(settings, store, set, ground);
  Object.assign(window, { skyGraph });

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

  // Sky documents: settings, shapes, paint and graph in one file.
  const docRow = document.createElement('div');
  docRow.className = 'row actions';
  const saveButton = document.createElement('button');
  saveButton.textContent = 'Save sky';
  const openButton = document.createElement('button');
  openButton.textContent = 'Open…';
  openButton.title = 'Open a sky .wcx (or an older .sky.json). A look .wcx applies just the look.';
  const openInput = document.createElement('input');
  openInput.type = 'file';
  openInput.accept = '.wcx,.json';
  openInput.hidden = true;
  docRow.append(saveButton, openButton, openInput);
  panel.append(docRow);
  // A sky keeps one identity across saves in a session; opening a file adopts its id.
  let skyId: string = crypto.randomUUID();
  saveButton.onclick = () => {
    const description = describeSky(settings, store.baseShapes, layers.hasContent, skyVocab);
    const json = saveSky(settings, store.baseShapes, layers, skyGraph, { name: description.suggestion, moniker: monikerBlock(skyId, description) }, animatePanel.value, ground.snapshot());
    download(`${description.suggestion}.wcx`, json, 'application/json');
  };
  openButton.onclick = () => openInput.click();
  openInput.onchange = async () => {
    const file = openInput.files?.[0];
    openInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const look = lookOnly(text, file.name);
      if (look) {
        presets.remember(look);
        presets.apply(look, set);
        looksPanel.refresh();
        status.textContent = `Applied the look ${look.name}.`;
      } else {
        openSky(text);
      }
    } catch (err) {
      status.textContent = `Could not open ${file.name}: ${err instanceof Error ? err.message : err}`;
    }
  };

  const looksSection = document.createElement('details');
  looksSection.open = true;
  const looksSummary = document.createElement('summary');
  looksSummary.textContent = 'Looks';
  const looksRoot = document.createElement('div');
  looksSection.append(looksSummary, looksRoot);
  panel.append(looksSection);
  const looksPanel = new LooksPanel(looksRoot, settings, set);

  const mapCanvas = document.createElement('canvas');
  mapCanvas.className = 'minimap';
  mapCanvas.title = 'Weather map. Drag shapes, handles resize and rotate, wheel zooms.';
  panel.append(mapCanvas);
  const minimap = new Minimap(mapCanvas, settings, store, tools, stroke);

  /** A look .wcx opened from Open…: returns it so it applies as a look, else null. */
  function lookOnly(text: string, fileName: string): presets.LookPreset | null {
    let kind: unknown;
    try { kind = (JSON.parse(text) as { kind?: unknown }).kind; } catch { return null; }
    if (kind !== 'look') return null;
    const { preset, error } = presets.parse(text, fileName.replace(/\.wcx$/i, ''));
    if (!preset) throw new Error(error ?? 'unreadable look');
    return preset;
  }

  function openSky(text: string): void {
    const doc = parseSky(text);
    if (doc.moniker?.id) skyId = doc.moniker.id;
    const tiles = paintTilesOf(doc, layers.size);
    for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (key === 'quality') continue; // The viewer's machine, not part of the sky.
      set(key, (doc.settings[key] ?? DEFAULTS[key]) as number);
    }
    renderer.update(settings, 'sky');
    renderer.update(settings, 'weather');
    store.selected = null;
    store.replaceAll(doc.shapes);
    layers.importTiles(tiles);
    skyGraph.restore(doc.graph);
    ground.restore(doc.ground);
    animatePanel.value = doc.animation;
    history.clear();
  }
  Object.assign(window, { skyOpen: openSky });

  const exportSection = document.createElement('details');
  const exportSummary = document.createElement('summary');
  exportSummary.textContent = 'Export HDRI';
  const exportRoot = document.createElement('div');
  exportSection.append(exportSummary, exportRoot);
  panel.append(exportSection);
  // Files are named by Moniker from what the sky is: "Hazy Golden-Hour Squall Line".
  const skyName = () => describeSky(settings, store.baseShapes, layers.hasContent, skyVocab).suggestion;
  const fileStem = () => skyName();
  new ExportPanel(exportRoot, renderer, fileStem);

  const animateSection = document.createElement('details');
  const animateSummary = document.createElement('summary');
  animateSummary.textContent = 'Animate';
  const animateRoot = document.createElement('div');
  animateSection.append(animateSummary, animateRoot);
  panel.append(animateSection);
  // Sliders show values at the animation time on show without changing anything.
  const showSettings = (s: Settings) => {
    for (const [key, ui] of inputs) {
      const v = s[key] as number;
      ui.input.value = String(v);
      ui.value.textContent = `${+v.toFixed(3)}${ui.unit}`;
    }
  };
  const animatePanel = new AnimatePanel(animateRoot, renderer, settings, fileStem, store, history, showSettings);
  // tools/smoke-animate.mjs renders sequences through this with an in-memory sink.
  Object.assign(window, {
    skyAnimate: animatePanel,
    skySequence: (options: SequenceOptions, range?: [number, number]) => {
      const frames: { name: string; bytes: Uint8Array }[] = [];
      return renderSequence(renderer, animatePanel.value, store.baseShapes, options, async (name, bytes) => { frames.push({ name, bytes }); }, undefined, undefined, range)
        .then(() => frames);
    },
  });

  const graphSection = document.createElement('details');
  graphSection.open = true;
  const graphSummary = document.createElement('summary');
  graphSummary.textContent = 'Sky graph';
  const graphRoot = document.createElement('div');
  graphSection.append(graphSummary, graphRoot);
  panel.append(graphSection);
  new PsgPanel(graphRoot, skyGraph, store);

  const groundSection = document.createElement('details');
  groundSection.open = true;
  const groundSummary = document.createElement('summary');
  groundSummary.textContent = 'Ground';
  const groundRoot = document.createElement('div');
  groundSection.append(groundSummary, groundRoot);
  new GroundPanel(groundRoot, ground, (bearing) => set('yaw', bearing));
  // ?aimRelief=1 (tools/): face the most prominent relief.
  if (query.get('aimRelief') === '1') {
    const bearing = ground.reliefBearing();
    if (bearing !== null) set('yaw', bearing);
  }
  // A ground graph rolls terrain only (ground.* variables), independently of the sky graph.
  const groundGraph = new SkyGraph(settings, store, set, ground, true);
  const groundGraphRoot = document.createElement('div');
  groundGraphRoot.className = 'subpanel';
  groundRoot.append(groundGraphRoot);
  new PsgPanel(groundGraphRoot, groundGraph, store, {
    example: { name: 'terrain biomes', label: 'Terrain example', title: 'Landscapes × seasons', text: terrainGraph },
    hint: 'A ground graph rolls terrain: landscape, water, geography and palette (ground.* variables).',
  });
  Object.assign(window, { skyGroundGraph: groundGraph });
  Object.assign(window, { skyGround: ground });

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

  panel.append(groundSection);

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
      // Scrubbed away from frame 0, a slider edit becomes a key at that time.
      const edit = (v: number) => {
        if (animatePanel.currentTime > 0 && isKeyable(spec.key)) animatePanel.keySetting(spec.key, v);
        else set(spec.key, v);
      };
      input.oninput = () => edit(Number(input.value));
      input.ondblclick = () => edit(DEFAULTS[spec.key] as number);
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
    } else if (!mod && e.key.toLowerCase() === 'r' && skyGraph.loaded) {
      skyGraph.reroll().catch((err) => console.error(err));
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
    const timing = stats.cloudMs === null ? '' : ` · cloud pass ${stats.cloudMs.toFixed(2)} ms${stats.passes > 1 ? ` ×${stats.passes}` : ''}`;
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
