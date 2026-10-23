// Renders a camera-view preview clip of an animation: each frame is converged in the
// viewport at its animation time, then captured. For looking at motion, not for delivery
// (use Export sequence for that). An .mp4 (H.264, needs ffmpeg) plays every frame at the
// animation's frame rate, which is what judging motion needs; a .gif shows a few sampled
// frames (needs python3 with Pillow).
// Usage: node tools/clip-preview.mjs <out.mp4|out.gif> [query string] [frames|all] [animation JSON]
//        [shape layers JSON] [width]
// Frames default to all of them for .mp4 and 12 for .gif.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
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
for (let i = 0; i < frames; i++) {
  // Every frame at its own time for video; evenly sampled across the clip otherwise.
  const t = mp4 && frames === all ? i / fps : (duration * i) / Math.max(1, frames - 1);
  await page.evaluate((t) => window.skyAnimate.seek(t), t);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.body.dataset.converged === 'true', null, { timeout: 1_800_000, polling: 500 });
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
  const each = (Date.now() - started) / 1000 / (i + 1);
  console.log(`frame ${i + 1}/${frames} at ${t.toFixed(2)} s (${each.toFixed(1)} s per frame, ${((frames - i - 1) * each / 60).toFixed(0)} min left)`);
}
await browser.close();
if (mp4) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, 'frame-%04d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
} else execFileSync('python3', ['-c', `
import sys
from PIL import Image
frames = [Image.open(p).convert('RGB') for p in sys.argv[2:]]
frames[0].save(sys.argv[1], save_all=True, append_images=frames[1:], duration=250, loop=0)
`, out, ...paths]);
console.log(`wrote ${out}`);
