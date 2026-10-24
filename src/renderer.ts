import commonWgsl from './shaders/common.wgsl?raw';
import groundWgsl from './shaders/ground.wgsl?raw';
import oceanWgsl from './shaders/ocean.wgsl?raw';
import { OCEAN_N, OCEAN_SCALES, oceanNoise, packOcean } from './ocean';
import noiseWgsl from './shaders/noise.wgsl?raw';
import noiseBakeWgsl from './shaders/noise-bake.wgsl?raw';
import weatherWgsl from './shaders/weather.wgsl?raw';
import atmosphereWgsl from './shaders/atmosphere.wgsl?raw';
import cloudsWgsl from './shaders/clouds.wgsl?raw';
import downwellingWgsl from './shaders/downwelling.wgsl?raw';
import displayWgsl from './shaders/display.wgsl?raw';
import postWgsl from './shaders/post.wgsl?raw';
import compositeWgsl from './shaders/composite.wgsl?raw';
import exportWgsl from './shaders/export.wgsl?raw';
import { Invalidation, QUALITY, Quality, Settings, packParams } from './settings';
import { SHAPES_BUFFER_SIZE, ShapeLayer, packShapes } from './shapes';
import type { LayerName } from './paint';
import { HEIGHT_GRID, TERRAIN_TYPES, type HeightField, type Standpoint, type TerrainMap, type TerrainRecipe } from './terrain';
import { fromHalf, toHalf } from './half';

const SKY_FACE = 256;
/** 11 vec4f: must match Params in common.wgsl. */
const PARAMS_BYTES = 176;
export const WEATHER_SIZE = 1024;
/** Largest terrain grid the ground texture holds. */
const TERRAIN_TEXTURE_MAX = 256;
/** Ground uniform (ground.wgsl Ground): 6 palette vec4s, info, relief, waves, place and gusts. */
const GROUND_BYTES = 11 * 16;
/** Ocean slope texture mip levels (256 down to 1). */
const OCEAN_MIPS = Math.log2(OCEAN_N) + 1;
/** GPU time per display frame spent on cloud passes, ms (the rest is left for the page). */
const FRAME_BUDGET_MS = 10;
const MAX_PASSES_PER_FRAME = 32;
/** converge() waits for the GPU every this many passes, so the queue stays short. */
const CONVERGE_PASSES_IN_FLIGHT = 8;
const TRANSMITTANCE_SIZE: [number, number] = [256, 64];
const MS_SIZE = 32;

export interface FrameStats {
  frame: number;
  totalFrames: number;
  cloudMs: number | null;
  /** Cloud passes dispatched this display frame. */
  passes: number;
  faceSize: number;
}

export interface NoiseSizes {
  shape: number;
  detail: number;
}

export class Renderer {
  private device: GPUDevice;
  private context: GPUCanvasContext | null;
  private format: GPUTextureFormat;
  private settings: Settings;
  /** The sky as composed; `settings` is this after the animation time is applied. */
  private base: Settings;
  private timeTransform: ((s: Settings) => Settings) | null = null;

  private paramsBuffer: GPUBuffer;
  private viewBuffer: GPUBuffer;
  private repeatSampler: GPUSampler;
  private clampSampler: GPUSampler;

  private shapeTex: GPUTexture;
  private detailTex: GPUTexture;
  private weatherTex: GPUTexture;
  private shapesBuffer: GPUBuffer;
  /** Ground terrain: one texel per tile (type, tile random, elevation) and its uniforms. */
  private terrainTex: GPUTexture;
  private groundBuffer: GPUBuffer;
  /** Ground height (km, half float) over the terrain period. */
  private heightTex: GPUTexture;
  /** Ground height under the eye, km: the eye stands this much higher above sea level. */
  private terrainOrigin = 0;
  /** Wind waves (ocean.wgsl): solved again when the waves or the scene time change. */
  private ocean!: {
    params: GPUBuffer; noise: GPUBuffer; fields: GPUBuffer; slopes: GPUTexture;
    spectrum: GPUComputePipeline; rows: GPUComputePipeline; cols: GPUComputePipeline; pack: GPUComputePipeline; mips: GPUComputePipeline;
    groups: { spectrum: GPUBindGroup; fft: [GPUBindGroup, GPUBindGroup]; pack: GPUBindGroup; mips: GPUBindGroup[] };
  };
  private waves = { windMs: 6, headingDeg: 70, fetchKm: 40 };
  private oceanSampler!: GPUSampler;
  private oceanKey = '';
  private layerTex: Record<LayerName, GPUTexture>;
  private shapes: ShapeLayer[] = [];
  private transmittanceLut: GPUTexture;
  private msLut: GPUTexture;
  private skyCube: GPUTexture;
  private cloudCube!: GPUTexture;
  private accumBuffer!: GPUBuffer;
  /** What the cloud pass saw of the ground per texel (albedo x air, water), for the composite. */
  private groundCube!: GPUTexture;
  private groundAccum!: GPUBuffer;

  private weatherPipeline: GPUComputePipeline;
  private transmittancePipeline: GPUComputePipeline;
  private msPipeline: GPUComputePipeline;
  private skyPipeline: GPUComputePipeline;
  private cloudPipeline: GPUComputePipeline;
  private referencePipeline: GPUComputePipeline;
  private displayPipeline: GPURenderPipeline;
  /** The camera (post.wgsl): mip downsampling of the exposed scene, then lens, glow and film. */
  /** The scene pass adding a weighted share into the target: shutter sub-frames for clips. */
  private sceneAccumPipeline: GPURenderPipeline;
  private downPipeline: GPURenderPipeline;
  private postPipeline: GPURenderPipeline;
  private postSampler: GPUSampler;
  /** Scene targets per output size (the canvas and a capture size can alternate). */
  private postTargets = new Map<string, PostTarget>();
  private exportPipeline: GPUComputePipeline;
  private downwellingPipeline: GPUComputePipeline;
  private shadowPipeline: GPUComputePipeline;
  /** Cloud shadows on the ground around the eye (clouds.wgsl ground_shadow). */
  private shadowTex: GPUTexture;
  /** Downwelling irradiance onto the ground, integrated from the view's cubes (16 bytes). */
  private downwellingBuffer: GPUBuffer;
  private downwellingBindGroup!: GPUBindGroup;
  /** While an export runs, the interactive view stops refining clouds. */
  private exporting = false;
  /** converge() is running: the display loop draws but does not dispatch clouds. */
  private converging = false;

  private cloudBindGroup!: GPUBindGroup;
  private referenceBindGroup!: GPUBindGroup;
  private displayBindGroup!: GPUBindGroup;
  private sceneAccumBindGroup!: GPUBindGroup;

  private cloudFrame = 0;
  /** Increments whenever the weather map is regenerated (for minimap refreshes). */
  weatherVersion = 0;
  private pending = new Set<Invalidation>(['sky', 'weather', 'clouds']);
  private allocatedFace = 0;

  private timestamps: { query: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer; busy: boolean } | null = null;
  private lastCloudMs: number | null = null;
  // Cloud frames submitted but not finished. Capped so the CPU never queues seconds of GPU work.
  private inFlight = 0;

  // present = false skips canvas presentation entirely (headless capture via capture()).
  static async create(canvas: HTMLCanvasElement, settings: Settings, noise: NoiseSizes, present = true): Promise<Renderer> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const features: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    // Default limits suffice: the largest buffer (Ultra accumulation) is 48 MiB.
    // Large cube faces need big accumulation buffers (6 x 2048^2 x 8 bytes is 192 MB, past
    // WebGPU's 128 MB default): ask for what the adapter really allows.
    const requiredLimits = {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    };
    const device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits });
    device.lost.then((info) => console.error('WebGPU device lost:', info.reason, info.message));
    device.onuncapturederror = (e) => console.error('WebGPU error:', e.error.message);
    return new Renderer(device, present ? canvas : null, settings, noise);
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement | null, settings: Settings, noise: NoiseSizes) {
    this.device = device;
    this.base = { ...settings };
    this.settings = { ...settings };
    this.context = canvas ? (canvas.getContext('webgpu') as GPUCanvasContext) : null;
    this.format = canvas ? navigator.gpu.getPreferredCanvasFormat() : 'rgba8unorm';
    this.context?.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.paramsBuffer = device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewBuffer = device.createBuffer({ size: VIEW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.repeatSampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat',
    });
    this.clampSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const storageSampled = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.shapeTex = device.createTexture({
      size: [noise.shape, noise.shape, noise.shape], dimension: '3d', format: 'rgba8unorm', usage: storageSampled,
    });
    this.detailTex = device.createTexture({
      size: [noise.detail, noise.detail, noise.detail], dimension: '3d', format: 'rgba8unorm', usage: storageSampled,
    });
    this.weatherTex = device.createTexture({ size: [WEATHER_SIZE, WEATHER_SIZE], format: 'rgba8unorm', usage: storageSampled });
    this.shapesBuffer = device.createBuffer({ size: SHAPES_BUFFER_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.terrainTex = device.createTexture({ size: [TERRAIN_TEXTURE_MAX, TERRAIN_TEXTURE_MAX], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.groundBuffer = device.createBuffer({ size: GROUND_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.heightTex = device.createTexture({ size: [HEIGHT_GRID, HEIGHT_GRID], format: 'r16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.setTerrain(null);
    const layer = () => device.createTexture({
      size: [WEATHER_SIZE, WEATHER_SIZE], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.layerTex = { paint: layer(), warp: layer() };
    this.transmittanceLut = device.createTexture({ size: TRANSMITTANCE_SIZE, format: 'rgba16float', usage: storageSampled });
    this.msLut = device.createTexture({ size: [MS_SIZE, MS_SIZE], format: 'rgba16float', usage: storageSampled });
    this.skyCube = device.createTexture({ size: [SKY_FACE, SKY_FACE, 6], format: 'rgba16float', usage: storageSampled });

    const module = (code: string, label: string) => device.createShaderModule({ label, code: commonWgsl + '\n' + code });
    const noiseModule = module(noiseWgsl + '\n' + noiseBakeWgsl, 'noise bake');
    const weatherModule = module(noiseWgsl + '\n' + weatherWgsl, 'weather');
    const atmosphereModule = module(atmosphereWgsl, 'atmosphere');
    const cloudModule = module(groundWgsl + '\n' + cloudsWgsl, 'clouds');
    const displayModule = module(groundWgsl + '\n' + compositeWgsl + '\n' + displayWgsl, 'display');

    const compute = (m: GPUShaderModule, entryPoint: string) =>
      device.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint } });

    this.weatherPipeline = compute(weatherModule, 'generate');
    this.transmittancePipeline = compute(atmosphereModule, 'transmittance');
    this.msPipeline = compute(atmosphereModule, 'multiscatter');
    this.skyPipeline = compute(atmosphereModule, 'sky_cube');
    this.cloudPipeline = compute(cloudModule, 'render');
    this.referencePipeline = compute(cloudModule, 'render_reference');
    this.exportPipeline = compute(module(groundWgsl + '\n' + compositeWgsl + '\n' + exportWgsl, 'export'), 'composite');
    this.downwellingPipeline = compute(module(downwellingWgsl, 'downwelling'), 'integrate');
    this.shadowPipeline = compute(cloudModule, 'ground_shadow');
    this.createOcean(module(oceanWgsl, 'ocean'), compute);
    this.shadowTex = device.createTexture({ size: [512, 512], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    this.downwellingBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.displayPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: displayModule, entryPoint: 'vs' },
      fragment: { module: displayModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    const add: GPUBlendComponent = { operation: 'add', srcFactor: 'constant', dstFactor: 'one' };
    this.sceneAccumPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: displayModule, entryPoint: 'vs' },
      fragment: { module: displayModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT, blend: { color: add, alpha: add } }] },
      primitive: { topology: 'triangle-list' },
    });
    const postModule = module(postWgsl, 'post');
    this.downPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: postModule, entryPoint: 'vs' },
      fragment: { module: postModule, entryPoint: 'fs_down', targets: [{ format: SCENE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.postPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: postModule, entryPoint: 'vs' },
      fragment: { module: postModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.postSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

    this.bakeNoise(noiseModule);
    this.allocateCloudTargets();

    if (device.features.has('timestamp-query')) {
      this.timestamps = {
        query: device.createQuerySet({ type: 'timestamp', count: 2 }),
        resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false,
      };
    }
  }

  get adapterInfo(): string {
    const info = (this.device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo;
    return info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') : 'unknown adapter';
  }

  /** Uploads a rectangle of a paint layer (RGBA half floats) and regenerates the weather map. */
  uploadLayer(name: LayerName, x: number, y: number, w: number, h: number, data: Uint16Array): void {
    this.device.queue.writeTexture(
      { texture: this.layerTex[name], origin: [x, y] },
      data as Uint16Array<ArrayBuffer>,
      { bytesPerRow: w * 8, rowsPerImage: h },
      [w, h],
    );
    this.pending.add('weather');
  }

  /**
   * Shows a terrain layout on the ground, or plain ground (the albedo slider) for null.
   * Changing the ground re-renders the cube: the cloud pass shades the ground's sun light.
   */
  setTerrain(terrain: { map: TerrainMap; recipe: TerrainRecipe; height?: HeightField; place?: Standpoint } | null): void {
    const data = new Float32Array(GROUND_BYTES / 4);
    this.terrainOrigin = 0;
    if (terrain) {
      const { map, recipe, height } = terrain;
      const place = terrain.place ?? { x: 0, z: 0, bearing: 0 };
      data.set([place.x, place.z, 0, 0], 36);
      if (height && recipe.heightKm > 0) {
        const halves = new Uint16Array(height.heights.length);
        for (let i = 0; i < halves.length; i++) halves[i] = toHalf(height.heights[i]);
        this.device.queue.writeTexture({ texture: this.heightTex }, halves, { bytesPerRow: height.size * 2 }, [height.size, height.size]);
        // The eye stands on the ground as the GPU reads it: half floats resolve heights of a
        // few km only to ~2 m, so an eye placed on the exact height could sit inside it.
        // Bilinear at the standpoint, wrapping, as the shader's linear filter reads it.
        const n = height.size;
        const period = recipe.tileKm * map.size;
        const fx = ((((place.x / period) % 1) + 1) % 1) * n - 0.5;
        const fz = ((((place.z / period) % 1) + 1) % 1) * n - 0.5;
        const x0 = Math.floor(fx), z0 = Math.floor(fz);
        const h = (x: number, z: number) => fromHalf(halves[(((z % n) + n) % n) * n + (((x % n) + n) % n)]);
        const ax = fx - x0, az = fz - z0;
        this.terrainOrigin = (h(x0, z0) * (1 - ax) + h(x0 + 1, z0) * ax) * (1 - az) + (h(x0, z0 + 1) * (1 - ax) + h(x0 + 1, z0 + 1) * ax) * az;
        data.set([recipe.heightKm, this.terrainOrigin, recipe.snowKm, 0], 28);
      }
      const texels = new Uint8Array(map.size * map.size * 4);
      for (let i = 0; i < map.types.length; i++) {
        texels[i * 4] = map.types[i];
        // A stable random per tile (field parcels, furrow directions).
        texels[i * 4 + 1] = (Math.imul(i ^ (recipe.seed * 2654435761), 2246822519) >>> 24) & 255;
        texels[i * 4 + 2] = Math.round(map.elevation[i] * 255);
        texels[i * 4 + 3] = 255;
      }
      this.device.queue.writeTexture({ texture: this.terrainTex }, texels, { bytesPerRow: map.size * 4 }, [map.size, map.size]);
      TERRAIN_TYPES.forEach((t, i) => data.set(recipe.palette[t], i * 4));
      this.waves = { windMs: recipe.waveWindMs, headingDeg: recipe.waveHeadingDeg, fetchKm: recipe.waveFetchKm };
      data.set([...OCEAN_SCALES, recipe.waveWindMs], 32);
      // Gusts: the wind's direction over the water (x east, z north); the drift is written
      // with the waves, as it follows the scene time.
      const heading = (recipe.waveHeadingDeg * Math.PI) / 180;
      data.set([Math.sin(heading), Math.cos(heading), this.gustDrift(), 0], 40);
      data.set([1, recipe.tileKm, map.size, recipe.seed % 100000], 24);
    }
    this.device.queue.writeBuffer(this.groundBuffer, 0, data);
    // The eye moves with the ground under it, so the sky is recomputed from there too.
    this.pending.add('sky');
  }

  private createOcean(m: GPUShaderModule, compute: (m: GPUShaderModule, entry: string) => GPUComputePipeline): void {
    const d = this.device;
    // Trilinear and anisotropic: nearest mip selection showed as square blocks where the
    // level changes, and grazing water needs detail kept across the view, not along it.
    this.oceanSampler = d.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8,
      addressModeU: 'repeat', addressModeV: 'repeat',
    });
    const n = OCEAN_N;
    const params = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const noise = d.createBuffer({ size: 3 * n * n * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(noise, 0, oceanNoise());
    const fields = d.createBuffer({ size: 9 * n * n * 8, usage: GPUBufferUsage.STORAGE });
    const slopes = d.createTexture({
      size: [n, n, 3], format: 'rgba16float', mipLevelCount: OCEAN_MIPS,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const spectrum = compute(m, 'spectrum');
    const rows = compute(m, 'fft_rows');
    const cols = compute(m, 'fft_cols');
    const pack = compute(m, 'pack');
    const mips = compute(m, 'mips');
    const level = (l: number) => slopes.createView({ dimension: '2d-array', baseMipLevel: l, mipLevelCount: 1 });
    this.ocean = {
      params, noise, fields, slopes, spectrum, rows, cols, pack, mips,
      groups: {
        spectrum: d.createBindGroup({ layout: spectrum.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: noise } }, { binding: 2, resource: { buffer: fields } },
        ] }),
        fft: [rows, cols].map((p) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 2, resource: { buffer: fields } }] })) as [GPUBindGroup, GPUBindGroup],
        pack: d.createBindGroup({ layout: pack.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: params } }, { binding: 2, resource: { buffer: fields } }, { binding: 3, resource: level(0) },
        ] }),
        mips: Array.from({ length: OCEAN_MIPS - 1 }, (_, l) => d.createBindGroup({ layout: mips.getBindGroupLayout(0), entries: [
          { binding: 4, resource: level(l) }, { binding: 5, resource: level(l + 1) },
        ] })),
      },
    };
  }

  /** How far gusts on the water have travelled downwind, km: they run with the wind. */
  private gustDrift(time = this.settings.sceneTime): number {
    return (this.waves.windMs * time) / 1000;
  }

  /** Solves the waves for the scene time (or another time) when they or the time changed. */
  private runOcean(encoder: GPUCommandEncoder, time = this.settings.sceneTime): void {
    const key = JSON.stringify([this.waves, time]);
    if (key === this.oceanKey) return;
    this.oceanKey = key;
    const o = this.ocean;
    const n = OCEAN_N;
    this.device.queue.writeBuffer(o.params, 0, packOcean(this.waves, time));
    this.device.queue.writeBuffer(this.groundBuffer, 42 * 4, new Float32Array([this.gustDrift(time)]));
    const pass = encoder.beginComputePass({ label: 'ocean' });
    pass.setPipeline(o.spectrum);
    pass.setBindGroup(0, o.groups.spectrum);
    pass.dispatchWorkgroups(n / 8, n / 8, 3);
    pass.setPipeline(o.rows);
    pass.setBindGroup(0, o.groups.fft[0]);
    pass.dispatchWorkgroups(n, 9);
    pass.setPipeline(o.cols);
    pass.setBindGroup(0, o.groups.fft[1]);
    pass.dispatchWorkgroups(n, 9);
    pass.setPipeline(o.pack);
    pass.setBindGroup(0, o.groups.pack);
    pass.dispatchWorkgroups(n / 8, n / 8, 3);
    pass.setPipeline(o.mips);
    for (let l = 1; l < OCEAN_MIPS; l++) {
      pass.setBindGroup(0, o.groups.mips[l - 1]);
      const size = n >> l;
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 3);
    }
    pass.end();
  }

  private oceanView(): GPUTextureView {
    return this.ocean.slopes.createView({ dimension: '2d-array' });
  }

  /** Shader parameters, with the eye standing on the ground under it (params.anim.y). */
  private pack(frame: number, quality?: Quality): Float32Array<ArrayBuffer> {
    const data = packParams(this.settings, frame, quality);
    data[41] += this.terrainOrigin;
    return data;
  }

  setShapes(shapes: ShapeLayer[]): void {
    this.shapes = shapes.map((s) => ({ ...s }));
    this.pending.add('weather');
  }

  /**
   * Shows the sky at an animation time: `transform` maps the composed settings to the
   * settings at that time (animation.ts settingsAt), or null for the sky as composed. Edits
   * keep arriving through update() and stay under the same time.
   */
  setTime(transform: ((s: Settings) => Settings) | null, invalidation: Invalidation): void {
    this.timeTransform = transform;
    this.settings = transform ? transform(this.base) : { ...this.base };
    this.pending.add(invalidation);
  }

  update(settings: Settings, invalidation: Invalidation): void {
    this.base = { ...settings };
    this.settings = this.timeTransform ? this.timeTransform(this.base) : { ...this.base };
    this.pending.add(invalidation);
  }

  private bakeNoise(noiseModule: GPUShaderModule): void {
    const d = this.device;
    const encoder = d.createCommandEncoder({ label: 'noise bake' });
    for (const [entryPoint, tex, binding] of [
      ['bake_shape', this.shapeTex, 0],
      ['bake_detail', this.detailTex, 1],
    ] as const) {
      const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module: noiseModule, entryPoint } });
      const group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding, resource: tex.createView() }],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      const n = Math.ceil(tex.width / 4);
      pass.dispatchWorkgroups(n, n, n);
      pass.end();
    }
    d.queue.submit([encoder.finish()]);
  }

  private allocateCloudTargets(): void {
    const face = QUALITY[this.settings.quality].faceSize;
    if (face === this.allocatedFace) return;
    this.cloudCube?.destroy();
    this.accumBuffer?.destroy();
    this.groundCube?.destroy();
    this.groundAccum?.destroy();
    this.cloudCube = this.createCube(face);
    this.groundCube = this.createCube(face);
    this.accumBuffer = this.device.createBuffer({ size: 6 * face * face * 8, usage: GPUBufferUsage.STORAGE });
    this.groundAccum = this.device.createBuffer({ size: 6 * face * face * 8, usage: GPUBufferUsage.STORAGE });
    this.allocatedFace = face;

    this.cloudBindGroup = this.cloudBindGroupFor(this.paramsBuffer, this.accumBuffer, this.cloudCube, this.groundAccum, this.groundCube);
    this.downwellingBindGroup = this.downwellingBindGroupFor(this.cloudCube, this.downwellingBuffer);
    this.referenceBindGroup = this.cloudBindGroupFor(this.paramsBuffer, this.accumBuffer, this.cloudCube, this.groundAccum, this.groundCube, this.referencePipeline);
    const displayGroup = (pipeline: GPURenderPipeline) => this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.viewBuffer } },
        { binding: 2, resource: this.clampSampler },
        { binding: 3, resource: this.skyCube.createView({ dimension: 'cube' }) },
        { binding: 4, resource: this.cloudCube.createView({ dimension: 'cube' }) },
        { binding: 5, resource: this.transmittanceLut.createView() },
        { binding: 6, resource: { buffer: this.downwellingBuffer } },
        { binding: 8, resource: { buffer: this.groundBuffer } },
        { binding: 9, resource: this.groundCube.createView({ dimension: 'cube' }) },
        { binding: 10, resource: this.oceanView() },
        { binding: 11, resource: this.oceanSampler },
        { binding: 12, resource: this.shadowTex.createView() },
      ],
    });
    this.displayBindGroup = displayGroup(this.displayPipeline);
    this.sceneAccumBindGroup = displayGroup(this.sceneAccumPipeline);
  }

  private createCube(face: number): GPUTexture {
    return this.device.createTexture({
      size: [face, face, 6], format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
  }

  private cloudBindGroupFor(
    params: GPUBuffer, accum: GPUBuffer, cube: GPUTexture, groundAccum: GPUBuffer, groundCube: GPUTexture, pipeline = this.cloudPipeline,
  ): GPUBindGroup {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: this.repeatSampler },
        { binding: 2, resource: this.clampSampler },
        { binding: 3, resource: this.shapeTex.createView() },
        { binding: 4, resource: this.detailTex.createView() },
        { binding: 5, resource: this.weatherTex.createView() },
        { binding: 6, resource: this.transmittanceLut.createView() },
        { binding: 7, resource: this.skyCube.createView({ dimension: 'cube' }) },
        { binding: 8, resource: { buffer: accum } },
        { binding: 9, resource: cube.createView({ dimension: '2d-array' }) },
        { binding: 12, resource: this.shadowTex.createView() },
        { binding: 14, resource: this.terrainTex.createView() },
        { binding: 15, resource: { buffer: this.groundBuffer } },
        { binding: 16, resource: this.heightTex.createView() },
        { binding: 17, resource: { buffer: groundAccum } },
        { binding: 18, resource: groundCube.createView({ dimension: '2d-array' }) },
        { binding: 19, resource: this.oceanView() },
        { binding: 20, resource: this.oceanSampler },
      ],
    });
  }

  private downwellingBindGroupFor(cube: GPUTexture, buffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.downwellingPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.clampSampler },
        { binding: 1, resource: this.skyCube.createView({ dimension: 'cube' }) },
        { binding: 2, resource: cube.createView({ dimension: 'cube' }) },
        { binding: 3, resource: { buffer } },
      ],
    });
  }

  /** Integrates the ground's downwelling light from a cloud cube (one workgroup). */
  private integrateDownwelling(encoder: GPUCommandEncoder, group: GPUBindGroup): void {
    const pass = encoder.beginComputePass({ label: 'downwelling' });
    pass.setPipeline(this.downwellingPipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  /**
   * Renders the environment at export quality into a lat-long float image (RGBA32F,
   * row-major, top row = zenith). Uses its own cloud cube (face = width / 4), Ultra steps
   * and full convergence; the interactive view keeps its own cube untouched.
   */
  async exportLatLong(width: number, samples: number, onProgress?: (done: number) => void): Promise<{ width: number; height: number; data: Float32Array }> {
    const d = this.device;
    const height = width / 2;
    const face = Math.min(2048, Math.max(256, Math.round(width / 4 / 4) * 4));
    const quality: Quality = { label: 'export', faceSize: face, viewSteps: 500, lightSteps: 6, samples };
    this.exporting = true;
    const params = d.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const accum = d.createBuffer({ size: 6 * face * face * 8, usage: GPUBufferUsage.STORAGE });
    const groundAccum = d.createBuffer({ size: 6 * face * face * 8, usage: GPUBufferUsage.STORAGE });
    const groundCube = this.createCube(face);
    const cube = d.createTexture({
      size: [face, face, 6], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const out = d.createTexture({ size: [width, height], format: 'rgba32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const bytesPerRow = width * 16;
    const readback = d.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const downwelling = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    try {
      // Apply any pending sky or weather edits first.
      const prep = d.createCommandEncoder();
      d.queue.writeBuffer(this.paramsBuffer, 0, this.pack(this.cloudFrame));
      this.flushPending(prep);
      d.queue.submit([prep.finish()]);

      const bindGroup = this.cloudBindGroupFor(params, accum, cube, groundAccum, groundCube);
      const downwellingGroup = this.downwellingBindGroupFor(cube, downwelling);
      const groups = Math.ceil(face / 4 / 8);
      const total = 16 * samples;
      for (let frame = 0; frame < total; frame++) {
        d.queue.writeBuffer(params, 0, this.pack(frame, quality));
        const encoder = d.createCommandEncoder({ label: 'export clouds' });
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.cloudPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(groups, groups, 6);
        pass.end();
        d.queue.submit([encoder.finish()]);
        // One frame in flight: keeps the browser responsive and each submission short.
        await d.queue.onSubmittedWorkDone();
        onProgress?.((frame + 1) / total);
      }

      const encoder = d.createCommandEncoder({ label: 'export composite' });
      // The ground's sky and cloud light, from the finished export cube only.
      this.integrateDownwelling(encoder, downwellingGroup);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.exportPipeline);
      pass.setBindGroup(0, d.createBindGroup({
        layout: this.exportPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: this.clampSampler },
          { binding: 2, resource: this.skyCube.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: cube.createView({ dimension: '2d-array' }) },
          { binding: 4, resource: this.transmittanceLut.createView() },
          { binding: 5, resource: out.createView() },
          { binding: 6, resource: { buffer: downwelling } },
          { binding: 8, resource: { buffer: this.groundBuffer } },
          { binding: 9, resource: groundCube.createView({ dimension: '2d-array' }) },
          { binding: 10, resource: this.oceanView() },
          { binding: 11, resource: this.oceanSampler },
          { binding: 12, resource: this.shadowTex.createView() },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      encoder.copyTextureToBuffer({ texture: out }, { buffer: readback, bytesPerRow }, [width, height]);
      d.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(readback.getMappedRange().slice(0));
      return { width, height, data };
    } finally {
      readback.destroy();
      downwelling.destroy();
      out.destroy();
      cube.destroy();
      accum.destroy();
      groundCube.destroy();
      groundAccum.destroy();
      params.destroy();
      this.exporting = false;
    }
  }

  private flushPending(encoder: GPUCommandEncoder): void {
    this.runOcean(encoder);
    if (this.pending.has('sky')) this.runSky(encoder);
    if (this.pending.has('weather')) {
      this.device.queue.writeBuffer(this.shapesBuffer, 0, packShapes(this.shapes, this.settings.baseWeather));
      this.runWeather(encoder);
      this.weatherVersion++;
    }
    const anyCloudChange = [...this.pending].some((p) => p !== 'view');
    if (anyCloudChange) this.runGroundShadow(encoder);
    this.pending.clear();
    if (anyCloudChange) this.cloudFrame = 0;
  }

  private runSky(encoder: GPUCommandEncoder): void {
    const d = this.device;
    const pass = encoder.beginComputePass({ label: 'atmosphere' });
    const run = (pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[], x: number, y: number, z = 1) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      pass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8), z);
    };
    const params = { binding: 0, resource: { buffer: this.paramsBuffer } };
    const sampler = { binding: 1, resource: this.clampSampler };
    run(this.transmittancePipeline, [params, { binding: 4, resource: this.transmittanceLut.createView() }], ...TRANSMITTANCE_SIZE);
    run(this.msPipeline, [
      params, sampler,
      { binding: 2, resource: this.transmittanceLut.createView() },
      { binding: 4, resource: this.msLut.createView() },
    ], MS_SIZE, MS_SIZE);
    run(this.skyPipeline, [
      params, sampler,
      { binding: 2, resource: this.transmittanceLut.createView() },
      { binding: 3, resource: this.msLut.createView() },
      { binding: 5, resource: this.skyCube.createView({ dimension: '2d-array' }) },
    ], SKY_FACE, SKY_FACE, 6);
    pass.end();
  }

  private runGroundShadow(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass({ label: 'ground shadow' });
    pass.setPipeline(this.shadowPipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.shadowPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: this.repeatSampler },
        { binding: 3, resource: this.shapeTex.createView() },
        { binding: 4, resource: this.detailTex.createView() },
        { binding: 5, resource: this.weatherTex.createView() },
        { binding: 11, resource: this.shadowTex.createView() },
        { binding: 15, resource: { buffer: this.groundBuffer } },
        { binding: 16, resource: this.heightTex.createView() },
      ],
    }));
    pass.dispatchWorkgroups(512 / 8, 512 / 8);
    pass.end();
  }

  private runWeather(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass({ label: 'weather' });
    pass.setPipeline(this.weatherPipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.weatherPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: this.weatherTex.createView() },
        { binding: 2, resource: { buffer: this.shapesBuffer } },
        { binding: 3, resource: this.layerTex.paint.createView() },
        { binding: 4, resource: this.layerTex.warp.createView() },
        { binding: 5, resource: this.clampSampler },
      ],
    }));
    pass.dispatchWorkgroups(WEATHER_SIZE / 8, WEATHER_SIZE / 8);
    pass.end();
  }

  get converged(): boolean {
    return this.cloudFrame >= 16 * QUALITY[this.settings.quality].samples;
  }

  /** Records one progressive cloud pass at the current cloudFrame (params must already hold it). */
  private encodeCloudPass(encoder: GPUCommandEncoder, timed: boolean): void {
    const quality = QUALITY[this.settings.quality];
    const ts = timed ? this.timestamps : null;
    const pass = encoder.beginComputePass({
      label: 'clouds',
      timestampWrites: ts ? { querySet: ts.query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
    });
    const reference = this.settings.quality === 'reference';
    pass.setPipeline(reference ? this.referencePipeline : this.cloudPipeline);
    pass.setBindGroup(0, reference ? this.referenceBindGroup : this.cloudBindGroup);
    const groups = Math.ceil(quality.faceSize / 4 / 8);
    pass.dispatchWorkgroups(groups, groups, 6);
    pass.end();
    if (ts) {
      encoder.resolveQuerySet(ts.query, 0, 2, ts.resolve, 0);
      encoder.copyBufferToBuffer(ts.resolve, 0, ts.read, 0, 16);
    }
  }

  /** Applies pending edits: the sky, weather and ground shadow, and restarts convergence. */
  private prepare(encoder: GPUCommandEncoder): void {
    if (this.pending.size > 0 && [...this.pending].some((p) => p !== 'view')) {
      this.allocateCloudTargets();
      this.cloudFrame = 0;
    }
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.pack(this.cloudFrame));
    this.flushPending(encoder);
  }

  /**
   * Cloud passes to run this display frame: as many as fit in FRAME_BUDGET_MS of measured
   * GPU time, so a fast GPU converges in a few frames while an M1 still gets one or two and
   * stays interactive. Without timestamp queries there is no measurement: one pass.
   */
  private passesThisFrame(): number {
    if (this.lastCloudMs === null || this.lastCloudMs <= 0) return 1;
    return Math.max(1, Math.min(MAX_PASSES_PER_FRAME, Math.floor(FRAME_BUDGET_MS / this.lastCloudMs)));
  }

  frame(viewData: Float32Array<ArrayBuffer>): FrameStats {
    const d = this.device;
    const quality = QUALITY[this.settings.quality];
    let encoder = d.createCommandEncoder();
    d.queue.writeBuffer(this.viewBuffer, 0, viewData);
    this.prepare(encoder);

    let timed = false;
    let dispatched = 0;
    if (!this.exporting && !this.converging && this.inFlight < 2) {
      const passes = this.passesThisFrame();
      while (dispatched < passes && !this.converged) {
        if (dispatched > 0) {
          // Each pass reads its own frame index from params: submit the previous pass before
          // writing the next one's.
          d.queue.submit([encoder.finish()]);
          encoder = d.createCommandEncoder();
          d.queue.writeBuffer(this.paramsBuffer, 0, this.pack(this.cloudFrame));
        }
        const time = dispatched === 0 && !!this.timestamps && !this.timestamps.busy;
        this.encodeCloudPass(encoder, time);
        timed ||= time;
        this.cloudFrame++;
        dispatched++;
      }
      if (dispatched > 0) this.integrateDownwelling(encoder, this.downwellingBindGroup);
    }

    if (this.context) this.drawView(encoder, this.context.getCurrentTexture());
    d.queue.submit([encoder.finish()]);
    if (dispatched > 0) {
      this.inFlight++;
      d.queue.onSubmittedWorkDone().then(() => { this.inFlight--; });
    }

    if (timed && this.timestamps) {
      const ts = this.timestamps;
      ts.busy = true;
      ts.read.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(ts.read.getMappedRange());
        this.lastCloudMs = Number(t[1] - t[0]) / 1e6;
        ts.read.unmap();
        ts.busy = false;
      }).catch(() => { ts.busy = false; });
    }

    return {
      frame: this.cloudFrame,
      totalFrames: 16 * quality.samples,
      cloudMs: this.lastCloudMs,
      passes: dispatched,
      faceSize: quality.faceSize,
    };
  }

  /**
   * Runs cloud passes back to back until the view cube is converged, not paced by the
   * display: for capturing clips. Keeps a few passes in flight so the GPU never idles.
   */
  async converge(): Promise<void> {
    const d = this.device;
    this.converging = true;
    try {
      const prep = d.createCommandEncoder();
      this.prepare(prep);
      d.queue.submit([prep.finish()]);
      while (!this.converged) {
        d.queue.writeBuffer(this.paramsBuffer, 0, this.pack(this.cloudFrame));
        const encoder = d.createCommandEncoder();
        this.encodeCloudPass(encoder, false);
        this.cloudFrame++;
        if (this.converged) this.integrateDownwelling(encoder, this.downwellingBindGroup);
        d.queue.submit([encoder.finish()]);
        if (this.cloudFrame % CONVERGE_PASSES_IN_FLIGHT === 0) await d.queue.onSubmittedWorkDone();
      }
      await d.queue.onSubmittedWorkDone();
    } finally {
      this.converging = false;
    }
  }

  private drawView(encoder: GPUCommandEncoder, target: GPUTexture, sceneDone = false): void {
    const post = this.postTarget(target.width, target.height);
    if (!sceneDone) fullscreenPass(encoder, post.levels[0], this.displayPipeline, this.displayBindGroup);
    for (let i = 1; i < post.levels.length; i++) fullscreenPass(encoder, post.levels[i], this.downPipeline, post.down[i - 1]);
    fullscreenPass(encoder, target.createView(), this.postPipeline, post.group);
  }

  /**
   * The exposed scene averaged over a shutter: the waves solved and the scene drawn at
   * evenly spaced times across `seconds` centred on the scene time, each submitted on its
   * own (the ocean's parameters are written per sub-frame). Clouds hold still within a
   * frame; moving water and its glints streak as on film.
   */
  private drawShutter(target: GPUTexture, shutter: Shutter): void {
    const d = this.device;
    const post = this.postTarget(target.width, target.height);
    const n = Math.max(1, Math.round(shutter.samples));
    for (let i = 0; i < n; i++) {
      const encoder = d.createCommandEncoder();
      this.runOcean(encoder, this.settings.sceneTime + ((i + 0.5) / n - 0.5) * shutter.seconds);
      fullscreenPass(encoder, post.levels[0], this.sceneAccumPipeline, this.sceneAccumBindGroup, i === 0, 1 / n);
      d.queue.submit([encoder.finish()]);
    }
  }

  /** The exposed scene at an output size, with its mip chain and the camera's bind groups. */
  private postTarget(width: number, height: number): PostTarget {
    const key = `${width}x${height}`;
    const cached = this.postTargets.get(key);
    if (cached) return cached;
    if (this.postTargets.size >= 2) {
      for (const t of this.postTargets.values()) t.texture.destroy();
      this.postTargets.clear();
    }
    const count = Math.max(1, Math.min(POST_LEVELS, Math.floor(Math.log2(Math.max(1, Math.min(width, height)))) - 1));
    const texture = this.device.createTexture({
      size: [width, height], format: SCENE_FORMAT, mipLevelCount: count,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const levels = Array.from({ length: count }, (_, i) => texture.createView({ baseMipLevel: i, mipLevelCount: 1 }));
    const down = levels.slice(0, -1).map((source) => this.device.createBindGroup({
      layout: this.downPipeline.getBindGroupLayout(0),
      entries: [{ binding: 1, resource: source }, { binding: 2, resource: this.postSampler }],
    }));
    const group = this.device.createBindGroup({
      layout: this.postPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.viewBuffer } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: this.postSampler },
      ],
    });
    const target = { texture, levels, down, group };
    this.postTargets.set(key, target);
    return target;
  }

  // Renders the preview view offscreen and returns RGBA8 pixels (display-encoded, preview only).
  async capture(viewData: Float32Array<ArrayBuffer>, width: number, height: number, shutter?: Shutter): Promise<Uint8Array> {
    const d = this.device;
    if (this.format !== 'rgba8unorm') throw new Error('capture() requires a renderer created with present = false');
    const target = d.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = d.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    d.queue.writeBuffer(this.viewBuffer, 0, viewData);
    const blur = !!shutter && shutter.samples > 1 && shutter.seconds > 0;
    if (blur) this.drawShutter(target, shutter);
    const encoder = d.createCommandEncoder();
    // Back to the waves at the scene time.
    if (blur) this.runOcean(encoder);
    this.drawView(encoder, target, blur);
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [width, height]);
    d.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    buffer.destroy();
    target.destroy();
    return out;
  }

  /** Reads the weather map back (RGBA8, row-major, WEATHER_SIZE square) for the minimap. */
  /** Reads the ground cloud-shadow map back (sun transmittance, 512 square over 12 km). Tools only. */
  async readGroundShadow(): Promise<{ size: number; data: Float32Array }> {
    const d = this.device;
    const size = 512;
    const bytesPerRow = size * 8;
    const buffer = d.createBuffer({ size: bytesPerRow * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = d.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: this.shadowTex }, { buffer, bytesPerRow }, [size, size]);
    d.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const half = new Uint16Array(buffer.getMappedRange());
    const data = new Float32Array(size * size);
    for (let i = 0; i < data.length; i++) {
      const h = half[i * 4];
      const e = (h >> 10) & 31, m = h & 1023;
      data[i] = e === 0 ? (m / 1024) * 2 ** -14 : 2 ** (e - 15) * (1 + m / 1024);
    }
    buffer.destroy();
    return { size, data };
  }

  async readWeather(): Promise<{ size: number; data: Uint8Array }> {
    const d = this.device;
    const bytesPerRow = WEATHER_SIZE * 4;
    const buffer = d.createBuffer({ size: bytesPerRow * WEATHER_SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = d.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: this.weatherTex }, { buffer, bytesPerRow }, [WEATHER_SIZE, WEATHER_SIZE]);
    d.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.destroy();
    return { size: WEATHER_SIZE, data };
  }

  // Debug: reads one texel as floats. Used by tools/ to inspect scene-linear values.
  async readTexel(name: 'sky' | 'cloud' | 'transmittance' | 'ms' | 'weather' | 'shape' | 'detail' | 'ground' | 'ocean', x: number, y: number, layer = 0): Promise<number[]> {
    const tex = { sky: this.skyCube, cloud: this.cloudCube, transmittance: this.transmittanceLut, ms: this.msLut, weather: this.weatherTex, shape: this.shapeTex, detail: this.detailTex, ground: this.groundCube, ocean: this.ocean.slopes }[name];
    const half = tex.format === 'rgba16float';
    const buffer = this.device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: tex, origin: [x, y, layer] }, { buffer, bytesPerRow: 256 }, [1, 1, 1]);
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const out = half ? [...new Uint16Array(buffer.getMappedRange(), 0, 4)].map(halfToFloat) : [...new Uint8Array(buffer.getMappedRange(), 0, 4)].map((v) => v / 255);
    buffer.destroy();
    return out;
  }

  async idle(): Promise<void> {
    await this.device.queue.onSubmittedWorkDone();
  }
}

/** The exposed scene before the camera: scene-linear, so highlights keep their energy for bokeh and glow. */
const SCENE_FORMAT: GPUTextureFormat = 'rgba16float';
/** Mip levels of the scene for the camera's blurs (level 6 is 1/64 size). */
const POST_LEVELS = 7;
/** View uniform (display.wgsl / post.wgsl View): six vec4s. */
const VIEW_BYTES = 96;

/** A film shutter for captures: open for `seconds`, sampled at `samples` times. */
export interface Shutter {
  seconds: number;
  samples: number;
}

/** One fullscreen triangle into view; `clear` false keeps what is there (blended passes). */
function fullscreenPass(encoder: GPUCommandEncoder, view: GPUTextureView, pipeline: GPURenderPipeline, group: GPUBindGroup, clear = true, blend?: number): void {
  const p = encoder.beginRenderPass({
    colorAttachments: [{ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  p.setPipeline(pipeline);
  p.setBindGroup(0, group);
  if (blend !== undefined) p.setBlendConstant([blend, blend, blend, blend]);
  p.draw(3);
  p.end();
}

interface PostTarget {
  texture: GPUTexture;
  levels: GPUTextureView[];
  down: GPUBindGroup[];
  group: GPUBindGroup;
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
