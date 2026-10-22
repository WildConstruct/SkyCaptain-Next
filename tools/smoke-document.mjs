// Sky document round trip: build a sky (graph roll, hand shape, paint, smudge), Save sky,
// wreck it, Open sky, and compare settings, shapes, caption and the GPU weather map.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';

mkdirSync('shots/doc', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
await page.goto('http://127.0.0.1:5173/?headless=1&noise=16');
await page.waitForFunction(() => window.skyGraph);

const snapshot = () => page.evaluate(async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
  await window.skyRenderer.idle();
  const { data } = await window.skyRenderer.readWeather();
  return {
    weather: Array.from(data),
    settings: { ...window.skyGraph['settings'] },
    shapes: window.skyShapes.shapes.map((s) => ({ ...s })),
    caption: window.skyGraph.last?.caption ?? null,
  };
});

await page.getByRole('button', { name: 'Example graph' }).click();
await page.waitForFunction(() => document.querySelector('.caption'));
await page.evaluate(async () => {
  await window.skyGraph.roll(1234);
  window.skyShapes.add({ id: 'hand', kind: 'clear_hole', x: -12, z: 18, size: 6, aspect: 0.8, rotation: 30, strength: 1, type: null, seed: 5, visible: true });
  const L = window.skyPaint, brush = { size: 6, flow: 0.5, opacity: 0.8, hardness: 0.3, type: 0.9, thin: false };
  L.beginStroke();
  for (let x = -20; x <= 20; x += 1.5) L.dab({ ...brush, tool: 'cloud' }, x, 35);
  L.endStroke();
  L.beginStroke();
  for (let i = 1; i <= 8; i++) L.dab({ ...brush, tool: 'smudge', size: 9, flow: 1 }, 10, 35 + i * 1.5, [0, 1.5]);
  L.endStroke();
});
const before = await snapshot();

const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save sky' }).click()]);
const path = `shots/doc/${download.suggestedFilename()}`;
await download.saveAs(path);
const size = readFileSync(path).length;
console.log(`saved ${download.suggestedFilename()} (${(size / 1024).toFixed(0)} KB)`);

// Wreck the sky.
await page.evaluate(async () => {
  window.skyPaint.clearAll();
  await window.skyGraph.roll(99);
  window.skyShapes.replaceAll([]);
});
const wrecked = await snapshot();
assert.notDeepEqual(wrecked.weather, before.weather, 'sky actually changed before reopening');

await page.locator('input[type=file][accept=".json,application/json"]').setInputFiles(path);
await page.waitForTimeout(300);
const after = await snapshot();
assert.deepEqual(after.settings, before.settings, 'settings restored');
assert.deepEqual(after.shapes, before.shapes, 'shapes restored');
assert.equal(after.caption, before.caption, 'graph caption restored');
let maxDiff = 0, changed = 0;
for (let i = 0; i < before.weather.length; i++) {
  const d = Math.abs(after.weather[i] - before.weather[i]);
  if (d) changed++;
  maxDiff = Math.max(maxDiff, d);
}
// Paint is stored as int16, so allow a 1/255 rounding step in the 8-bit weather map.
assert.ok(maxDiff <= 1, `weather map restored (max diff ${maxDiff}/255, ${changed} values)`);
console.log(`reopened: settings, shapes, caption identical; weather map max diff ${maxDiff}/255 in ${changed} of ${before.weather.length} values`);
await browser.close();
console.log('smoke-document: all passed');
