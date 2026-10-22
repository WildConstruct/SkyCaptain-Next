// Animation smoke test: the recipe edits through the Animate panel, travels in the sky
// .wcx, and a short sequence renders with numbered frames that move and that come out
// identical when re-rendered. Run with the dev server up.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';

mkdirSync('shots/animate', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
await page.goto('http://127.0.0.1:5173/?headless=1&noise=32&sunElevation=20');
await page.waitForFunction(() => window.skyAnimate);

// 1. Edit the recipe in the panel: a 1 s clip at 3 fps, fast wind, quick cloud life.
await page.getByText('Animate', { exact: true }).first().click();
const field = (label) => page.locator('.fields label', { hasText: label }).locator('xpath=following-sibling::input[1]');
for (const [label, value] of [['Length (s)', '1'], ['Frame rate', '3'], ['Time-lapse ×', '3600'], ['Wind (km/h)', '20'], ['Wind toward (°)', '90'], ['Cloud life (min)', '20']]) {
  await field(label).fill(value);
  await field(label).dispatchEvent('change');
}
const recipe = await page.evaluate(() => window.skyAnimate.value);
assert.deepEqual(
  [recipe.duration, recipe.fps, recipe.timeLapse, recipe.windSpeed, recipe.windHeading, recipe.cloudLife],
  [1, 3, 3600, 20, 90, 20],
);
assert.match(await page.locator('details:has(summary:text("Animate")) .hint').first().textContent(), /3 frames · 60 min of weather · clouds drift 20\.0 km and turn over 3\.0×/);
console.log('recipe edits ok');

// 2. The recipe travels in the sky .wcx and comes back on open.
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save sky' }).click()]);
const skyPath = 'shots/animate/sky.wcx';
await download.saveAs(skyPath);
const sky = JSON.parse(readFileSync(skyPath, 'utf8'));
assert.equal(sky.sky.animation.windSpeed, 20, 'animation saved in the sky file');
await page.evaluate(() => { window.skyAnimate.value = { ...window.skyAnimate.value, windSpeed: 5 }; });
await page.locator('input[type=file][accept=".wcx,.json"]').setInputFiles(skyPath);
await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => window.skyAnimate.value.windSpeed), 20, 'animation restored on open');
console.log('animation round-trips through the sky file');

// 3. A 3-frame sequence: numbered, moving, deterministic.
const hash = (bytes) => createHash('sha256').update(Buffer.from(Object.values(bytes))).digest('hex').slice(0, 12);
const options = { width: 512, samples: 1, format: 'hdr', name: 'Test Sky' };
const frames = await page.evaluate(async (options) => {
  const out = await window.skySequence(options);
  return out.map((f) => ({ name: f.name, bytes: Array.from(f.bytes) }));
}, options);
assert.deepEqual(frames.map((f) => f.name), ['Test Sky.0001.hdr', 'Test Sky.0002.hdr', 'Test Sky.0003.hdr']);
const hashes = frames.map((f) => hash(f.bytes));
assert.equal(new Set(hashes).size, 3, `every frame differs: ${hashes}`);
// Mean absolute difference of the RGBE mantissas between the first and last frame: the
// sky has really moved, not just changed noise.
const body = (f) => f.bytes.slice(f.bytes.length - 512 * 256 * 4);
const [a, c] = [body(frames[0]), body(frames[2])];
let diff = 0;
for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - c[i]) + Math.abs(a[i + 1] - c[i + 1]) + Math.abs(a[i + 2] - c[i + 2]);
diff /= (a.length / 4) * 3;
assert.ok(diff > 0.5, `first and last frames differ visibly (mean ${diff.toFixed(2)})`);
console.log('sequence:', frames.map((f) => f.name).join(', '), `mean change ${diff.toFixed(2)}`);

const again = await page.evaluate(async (options) => {
  const out = await window.skySequence(options, [1, 1]);
  return out.map((f) => ({ name: f.name, bytes: Array.from(f.bytes) }));
}, options);
assert.equal(again[0].name, 'Test Sky.0002.hdr');
assert.equal(hash(again[0].bytes), hashes[1], 'frame 2 re-renders identically on its own');
console.log('frame 2 re-rendered alone matches');

await browser.close();
console.log('smoke-animate: all passed');
