// Renders a camera-view preview clip of an animation as a GIF: each frame is converged in
// the viewport at the animation time, then captured. For looking at motion, not for
// delivery (use Export sequence for that).
// Usage: node tools/clip-preview.mjs <out.gif> [query string] [frames] [animation JSON]
// Needs the dev server and python3 with Pillow.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [out = 'shots/clip.gif', query = '', framesArg = '12', animJson = '{}'] = process.argv.slice(2);
const frames = Number(framesArg);
const dir = join(dirname(out), 'clip-frames');
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${process.env.SKY_URL ?? 'http://127.0.0.1:5173/'}?headless=1${query ? `&${query}` : ''}`);
await page.waitForFunction(() => window.skyAnimate);
const duration = await page.evaluate((json) => {
  window.skyAnimate.value = { ...window.skyAnimate.value, ...JSON.parse(json) };
  return window.skyAnimate.value.duration;
}, animJson);
const paths = [];
for (let i = 0; i < frames; i++) {
  const t = (duration * i) / Math.max(1, frames - 1);
  await page.evaluate((t) => window.skyAnimate.seek(t), t);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.body.dataset.converged === 'true', null, { timeout: 1_800_000, polling: 500 });
  const dataUrl = await page.evaluate(async () => {
    const pixels = await window.skyCapture(640, 360);
    const c = document.createElement('canvas');
    c.width = 640; c.height = 360;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), 640, 360), 0, 0);
    return c.toDataURL('image/png');
  });
  const p = join(dir, `frame-${String(i).padStart(3, '0')}.png`);
  writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64'));
  paths.push(p);
  console.log(`frame ${i + 1}/${frames} at ${t.toFixed(2)} s`);
}
await browser.close();
execFileSync('python3', ['-c', `
import sys
from PIL import Image
frames = [Image.open(p).convert('RGB') for p in sys.argv[2:]]
frames[0].save(sys.argv[1], save_all=True, append_images=frames[1:], duration=250, loop=0)
`, out, ...paths]);
console.log(`wrote ${out}`);
