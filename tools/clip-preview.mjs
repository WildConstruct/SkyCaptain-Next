// Renders a camera-view preview clip of an animation: each frame is converged at full GPU
// speed at its animation time (window.skyConverge), then captured. For looking at motion, not for delivery
// (use Export sequence for that). An .mp4 (H.264, needs ffmpeg) plays every frame at the
// animation's frame rate, which is what judging motion needs; a .gif shows a few sampled
// frames (needs python3 with Pillow).
// Usage: node tools/clip-preview.mjs <out.mp4|out.gif> [query string] [frames|all] [animation JSON]
//        [shape layers JSON] [width]
// Frames default to all of them for .mp4 and 12 for .gif.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [out = 'shots/clip.mp4', query = '', framesArg, animJson = '{}', shapesJson = '[]', widthArg = '960'] = process.argv.slice(2);
const mp4 = out.endsWith('.mp4');
const width = Number(widthArg);
const height = Math.round((width * 9) / 16 / 2) * 2;
const dir = join(dirname(out), 'clip-frames');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
// SKY_GPU=1 renders on the machine's GPU through installed Chrome (or SKY_CHROME, a path
// to a Chrome/Chromium binary); SKY_HEADED=1 shows the window, for drivers that will not
// give headless Chrome the GPU. Without SKY_GPU it uses the sandbox's SwiftShader.
const gpu = process.env.SKY_GPU === '1';
const browser = await chromium.launch(gpu
  ? {
    ...(process.env.SKY_CHROME ? { executablePath: process.env.SKY_CHROME } : { channel: 'chrome' }),
    headless: process.env.SKY_HEADED !== '1',
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
      ...(process.platform === 'linux' ? ['--enable-features=Vulkan', '--use-angle=vulkan'] : [])],
  }
  : {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
  });
const page = await browser.newPage({ viewport: { width: Math.max(1280, width), height: Math.max(720, height) } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${process.env.SKY_URL ?? 'http://127.0.0.1:5173/'}?headless=1${query ? `&${query}` : ''}`);
await page.waitForFunction(() => window.skyAnimate);
const adapter = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  return a ? [a.info?.vendor, a.info?.architecture, a.info?.description].filter(Boolean).join(' ') || 'unknown adapter' : 'no WebGPU adapter';
});
console.log(`GPU: ${adapter}`);
if (gpu && /swiftshader|no WebGPU/i.test(adapter)) {
  console.error('SKY_GPU=1 but Chrome has no hardware WebGPU adapter: try SKY_HEADED=1, or SKY_CHROME pointing at a current Chrome.');
  process.exit(1);
}
const { duration, fps } = await page.evaluate(([json, shapes]) => {
  for (const shape of JSON.parse(shapes)) window.skyShapes.add(shape);
  window.skyAnimate.value = { ...window.skyAnimate.value, ...JSON.parse(json) };
  return window.skyAnimate.value;
}, [animJson, shapesJson]);
const all = Math.max(1, Math.round(duration * fps));
const frames = framesArg === undefined || framesArg === 'all' ? (mp4 ? all : 12) : Number(framesArg);
const paths = [];
const started = Date.now();
// Video: raw RGBA frames stream straight into ffmpeg, no PNG round trip.
let ffmpeg = null;
let ffmpegDone = null;
if (mp4) {
  ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`,
    '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  ffmpegDone = new Promise((resolve, reject) => ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
}
let renderSeconds = 0;
for (let i = 0; i < frames; i++) {
  // Every frame at its own time for video; evenly sampled across the clip otherwise.
  const t = mp4 && frames === all ? i / fps : (duration * i) / Math.max(1, frames - 1);
  // Converge at full GPU speed (not paced by the display), then capture.
  const renderStart = Date.now();
  await page.evaluate(async (t) => { window.skyAnimate.seek(t); await window.skyConverge(); }, t);
  renderSeconds += (Date.now() - renderStart) / 1000;
  if (mp4) {
    const b64 = await page.evaluate(async ([w, h]) => {
      const pixels = new Uint8Array(await window.skyCapture(w, h));
      let s = '';
      for (let j = 0; j < pixels.length; j += 0x8000) s += String.fromCharCode.apply(null, pixels.subarray(j, j + 0x8000));
      return btoa(s);
    }, [width, height]);
    if (!ffmpeg.stdin.write(Buffer.from(b64, 'base64'))) await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
  } else {
    const dataUrl = await page.evaluate(async ([w, h]) => {
      const pixels = await window.skyCapture(w, h);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
      return c.toDataURL('image/png');
    }, [width, height]);
    const p = join(dir, `frame-${String(i).padStart(4, '0')}.png`);
    writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64'));
    paths.push(p);
  }
  const each = (Date.now() - started) / 1000 / (i + 1);
  console.log(`frame ${i + 1}/${frames} at ${t.toFixed(2)} s (${each.toFixed(2)} s per frame, ${(renderSeconds / (i + 1)).toFixed(2)} s rendering, ${((frames - i - 1) * each / 60).toFixed(0)} min left)`);
}
await browser.close();
if (mp4) {
  ffmpeg.stdin.end();
  await ffmpegDone;
} else execFileSync('python3', ['-c', `
import sys
from PIL import Image
frames = [Image.open(p).convert('RGB') for p in sys.argv[2:]]
frames[0].save(sys.argv[1], save_all=True, append_images=frames[1:], duration=250, loop=0)
`, out, ...paths]);
console.log(`wrote ${out}`);
