// Renders the view headlessly and saves a PNG once the environment cube converges.
// Usage: node tools/screenshot.mjs <out.png> [query string] [timeout seconds] [--page]
// --page also saves <out>-page.png: the whole UI with the render pasted into the viewport.
// --script=<file.js> runs that file in the page first (e.g. scripted paint strokes).
// Uses offscreen capture (?headless=1) because headless canvas presentation is unreliable;
// software WebGPU (SwiftShader) is slow but fine for judging looks.
import { chromium } from 'playwright-core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => a !== '--page' && !a.startsWith('--script='));
const scriptArg = process.argv.find((a) => a.startsWith('--script='));
const wholePage = process.argv.includes('--page');
const [out = 'shots/view.png', query = '', timeoutS = '600'] = args;
const base = process.env.SKY_URL ?? 'http://127.0.0.1:5173/';
const executablePath = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => p && existsSync(p));
const browser = await chromium.launch({
  executablePath,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('404')) console.log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const started = Date.now();
await page.goto(`${base}?headless=1${query ? `&${query}` : ''}`);
if (scriptArg) {
  await page.waitForFunction(() => window.skyPaint);
  await page.evaluate(readFileSync(scriptArg.slice('--script='.length), 'utf8'));
  // Let the converged flag reset after the edits reach the renderer.
  await page.waitForTimeout(500);
}
try {
  await page.waitForFunction(() => document.body.dataset.converged === 'true', null, { timeout: Number(timeoutS) * 1000, polling: 500 });
} catch {
  console.log('timed out before convergence');
}
console.log('status:', await page.textContent('#status'), `(${((Date.now() - started) / 1000).toFixed(1)} s)`);
const dataUrl = await page.evaluate(async () => {
  const [w, h] = [960, 540];
  const pixels = await window.skyCapture(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
  return c.toDataURL('image/png');
});
writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
if (wholePage) {
  // Headless mode never configures the WebGPU canvas, so paint the capture into it with 2D.
  await page.evaluate(async () => {
    const canvas = document.querySelector('#viewport');
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    const pixels = await window.skyCapture(w, h);
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.screenshot({ path: out.replace(/\.png$/, '-page.png') });
}
await browser.close();
