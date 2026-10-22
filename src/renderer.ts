import commonWgsl from './shaders/common.wgsl?raw';
import noiseWgsl from './shaders/noise.wgsl?raw';
import noiseBakeWgsl from './shaders/noise-bake.wgsl?raw';
import weatherWgsl from './shaders/weather.wgsl?raw';
import atmosphereWgsl from './shaders/atmosphere.wgsl?raw';
import cloudsWgsl from './shaders/clouds.wgsl?raw';
import displayWgsl from './shaders/display.wgsl?raw';
import { Invalidation, QUALITY, Settings, packParams } from './settings';

const SKY_FACE = 256;
const WEATHER_SIZE = 512;
const TRANSMITTANCE_SIZE: [number, number] = [256, 64];
const MS_SIZE = 32;

export interface FrameStats {
  frame: number;
  totalFrames: number;
  cloudMs: number | null;
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

  private paramsBuffer: GPUBuffer;
  private viewBuffer: GPUBuffer;
  private repeatSampler: GPUSampler;
  private clampSampler: GPUSampler;

  private shapeTex: GPUTexture;
  private detailTex: GPUTexture;
  private weatherTex: GPUTexture;
  private transmittanceLut: GPUTexture;
  private msLut: GPUTexture;
  private skyCube: GPUTexture;
  private cloudCube!: GPUTexture;
  private accumBuffer!: GPUBuffer;

  private weatherPipeline: GPUComputePipeline;
  private transmittancePipeline: GPUComputePipeline;
  private msPipeline: GPUComputePipeline;
  private skyPipeline: GPUComputePipeline;
  private cloudPipeline: GPUComputePipeline;
  private displayPipeline: GPURenderPipeline;

  private cloudBindGroup!: GPUBindGroup;
  private displayBindGroup!: GPUBindGroup;

  private cloudFrame = 0;
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
    const device = await adapter.requestDevice({ requiredFeatures: features });
    device.lost.then((info) => console.error('WebGPU device lost:', info.reason, info.message));
    device.onuncapturederror = (e) => console.error('WebGPU error:', e.error.message);
    return new Renderer(device, present ? canvas : null, settings, noise);
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement | null, settings: Settings, noise: NoiseSizes) {
    this.device = device;
    this.settings = { ...settings };
    this.context = canvas ? (canvas.getContext('webgpu') as GPUCanvasContext) : null;
    this.format = canvas ? navigator.gpu.getPreferredCanvasFormat() : 'rgba8unorm';
    this.context?.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.paramsBuffer = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    this.transmittanceLut = device.createTexture({ size: TRANSMITTANCE_SIZE, format: 'rgba16float', usage: storageSampled });
    this.msLut = device.createTexture({ size: [MS_SIZE, MS_SIZE], format: 'rgba16float', usage: storageSampled });
    this.skyCube = device.createTexture({ size: [SKY_FACE, SKY_FACE, 6], format: 'rgba16float', usage: storageSampled });

    const module = (code: string, label: string) => device.createShaderModule({ label, code: commonWgsl + '\n' + code });
    const noiseModule = module(noiseWgsl + '\n' + noiseBakeWgsl, 'noise bake');
    const weatherModule = module(noiseWgsl + '\n' + weatherWgsl, 'weather');
    const atmosphereModule = module(atmosphereWgsl, 'atmosphere');
    const cloudModule = module(cloudsWgsl, 'clouds');
    const displayModule = module(displayWgsl, 'display');

    const compute = (m: GPUShaderModule, entryPoint: string) =>
      device.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint } });

    this.weatherPipeline = compute(weatherModule, 'generate');
    this.transmittancePipeline = compute(atmosphereModule, 'transmittance');
    this.msPipeline = compute(atmosphereModule, 'multiscatter');
    this.skyPipeline = compute(atmosphereModule, 'sky_cube');
    this.cloudPipeline = compute(cloudModule, 'render');
    this.displayPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: displayModule, entryPoint: 'vs' },
      fragment: { module: displayModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

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

  update(settings: Settings, invalidation: Invalidation): void {
    this.settings = { ...settings };
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
    this.cloudCube = this.device.createTexture({
      size: [face, face, 6], format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.accumBuffer = this.device.createBuffer({ size: 6 * face * face * 8, usage: GPUBufferUsage.STORAGE });
    this.allocatedFace = face;

    this.cloudBindGroup = this.device.createBindGroup({
      layout: this.cloudPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: this.repeatSampler },
        { binding: 2, resource: this.clampSampler },
        { binding: 3, resource: this.shapeTex.createView() },
        { binding: 4, resource: this.detailTex.createView() },
        { binding: 5, resource: this.weatherTex.createView() },
        { binding: 6, resource: this.transmittanceLut.createView() },
        { binding: 7, resource: this.skyCube.createView({ dimension: 'cube' }) },
        { binding: 8, resource: { buffer: this.accumBuffer } },
        { binding: 9, resource: this.cloudCube.createView({ dimension: '2d-array' }) },
      ],
    });
    this.displayBindGroup = this.device.createBindGroup({
      layout: this.displayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.viewBuffer } },
        { binding: 2, resource: this.clampSampler },
        { binding: 3, resource: this.skyCube.createView({ dimension: 'cube' }) },
        { binding: 4, resource: this.cloudCube.createView({ dimension: 'cube' }) },
        { binding: 5, resource: this.transmittanceLut.createView() },
      ],
    });
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

  private runWeather(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass({ label: 'weather' });
    pass.setPipeline(this.weatherPipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.weatherPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: this.weatherTex.createView() },
      ],
    }));
    pass.dispatchWorkgroups(WEATHER_SIZE / 8, WEATHER_SIZE / 8);
    pass.end();
  }

  get converged(): boolean {
    return this.cloudFrame >= 16 * QUALITY[this.settings.quality].samples;
  }

  frame(viewData: Float32Array<ArrayBuffer>): FrameStats {
    const d = this.device;
    const quality = QUALITY[this.settings.quality];
    if (this.pending.size > 0 && [...this.pending].some((p) => p !== 'view')) {
      this.allocateCloudTargets();
      this.cloudFrame = 0;
    }
    const encoder = d.createCommandEncoder();
    d.queue.writeBuffer(this.paramsBuffer, 0, packParams(this.settings, this.cloudFrame));
    d.queue.writeBuffer(this.viewBuffer, 0, viewData);
    if (this.pending.has('sky')) this.runSky(encoder);
    if (this.pending.has('weather')) this.runWeather(encoder);
    this.pending.clear();

    let timed = false;
    const dispatchClouds = !this.converged && this.inFlight < 2;
    if (dispatchClouds) {
      const ts = this.timestamps && !this.timestamps.busy ? this.timestamps : null;
      const pass = encoder.beginComputePass({
        label: 'clouds',
        timestampWrites: ts ? { querySet: ts.query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
      });
      pass.setPipeline(this.cloudPipeline);
      pass.setBindGroup(0, this.cloudBindGroup);
      const groups = Math.ceil(quality.faceSize / 4 / 8);
      pass.dispatchWorkgroups(groups, groups, 6);
      pass.end();
      if (ts) {
        encoder.resolveQuerySet(ts.query, 0, 2, ts.resolve, 0);
        encoder.copyBufferToBuffer(ts.resolve, 0, ts.read, 0, 16);
        timed = true;
      }
      this.cloudFrame++;
    }

    if (this.context) this.drawView(encoder, this.context.getCurrentTexture());
    d.queue.submit([encoder.finish()]);
    if (dispatchClouds) {
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
      faceSize: quality.faceSize,
    };
  }

  private drawView(encoder: GPUCommandEncoder, target: GPUTexture): void {
    const display = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    display.setPipeline(this.displayPipeline);
    display.setBindGroup(0, this.displayBindGroup);
    display.draw(3);
    display.end();
  }

  // Renders the preview view offscreen and returns RGBA8 pixels (display-encoded, preview only).
  async capture(viewData: Float32Array<ArrayBuffer>, width: number, height: number): Promise<Uint8Array> {
    const d = this.device;
    if (this.format !== 'rgba8unorm') throw new Error('capture() requires a renderer created with present = false');
    const target = d.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = d.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    d.queue.writeBuffer(this.viewBuffer, 0, viewData);
    const encoder = d.createCommandEncoder();
    this.drawView(encoder, target);
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

  // Debug: reads one texel as floats. Used by tools/ to inspect scene-linear values.
  async readTexel(name: 'sky' | 'cloud' | 'transmittance' | 'ms' | 'weather' | 'shape', x: number, y: number, layer = 0): Promise<number[]> {
    const tex = { sky: this.skyCube, cloud: this.cloudCube, transmittance: this.transmittanceLut, ms: this.msLut, weather: this.weatherTex, shape: this.shapeTex }[name];
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

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
