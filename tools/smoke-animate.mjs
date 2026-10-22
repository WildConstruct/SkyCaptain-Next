// Animation smoke test: the recipe edits through the Animate panel, travels in the sky
// .wcx, and a short sequence renders with numbered frames that move and that match when
// a frame is re-rendered on its own. Run with the dev server up.
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
assert.match(await page.locator('details:has(summary:text("Animate")) .clip-summary').textContent(), /3 frames · 60 min of weather · clouds drift 20\.0 km and turn over 3\.0×/);
console.log('recipe edits ok');

// 1b. Keys by editing away from frame 0: a storm that moves and grows, and a setting sun.
await page.evaluate(() => {
  window.skyShapes.add({ id: 'storm', kind: 'storm_cell', x: 0, z: 40, size: 6, aspect: 1, rotation: 0, strength: 1, type: null, seed: 3, visible: true });
});
const sunSlider = page.locator('label.row', { hasText: 'Sun elevation' }).locator('input[type=range]');
const slide = (locator, value) => locator.evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
await page.evaluate(() => window.skyAnimate.seek(1));
// The same call the minimap and sky overlay make while dragging a shape.
await page.evaluate(() => window.skyShapes.patch('storm', { x: 20, size: 12 }));
await slide(sunSlider, 4);
let state = await page.evaluate(() => ({
  keys: window.skyAnimate.value.keys,
  base: window.skyShapes.baseShapes.find((s) => s.id === 'storm'),
  shown: window.skyShapes.shapes.find((s) => s.id === 'storm'),
  baseSun: window.skyGraph['settings'].sunElevation,
}));
assert.equal(state.keys.length, 1, 'edits at one time share a key');
assert.deepEqual(state.keys[0].shapes.storm, { x: 20, size: 12 });
assert.equal(state.keys[0].sky.sunElevation, 4);
assert.deepEqual([state.base.x, state.base.size, state.baseSun], [0, 6, 20], 'frame 0 (the composed sky) is untouched');
assert.deepEqual([state.shown.x, state.shown.size], [20, 12], 'the view shows the keyed layer');
// Halfway: smooth easing passes through the midpoint.
await page.evaluate(() => window.skyAnimate.seek(0.5));
state = { shown: await page.evaluate(() => window.skyShapes.shapes.find((s) => s.id === 'storm')), slider: await sunSlider.inputValue() };
assert.deepEqual([state.shown.x, state.shown.size], [10, 9], 'halfway between frame 0 and the key');
assert.equal(Number(state.slider), 12, 'the sun slider shows the value at this time');
await page.evaluate(() => window.skyAnimate.seek(0));
state = await page.evaluate(() => ({ shown: window.skyShapes.shapes.find((s) => s.id === 'storm'), animated: window.skyShapes.animated }));
assert.deepEqual([state.shown.x, state.animated], [0, false], 'back at frame 0, the composed layers');
// Undo removes the last key edit (the sun), keeping the storm's.
await page.evaluate(() => { window.skyAnimate.seek(1); document.activeElement?.blur(); });
await page.keyboard.press('Control+z');
state = await page.evaluate(() => window.skyAnimate.value.keys);
assert.equal(state[0].sky.sunElevation, undefined, 'undo took the sun key back');
assert.deepEqual(state[0].shapes.storm, { x: 20, size: 12 }, 'the storm key stays');
await page.keyboard.press('Control+Shift+z');
assert.equal(await page.evaluate(() => window.skyAnimate.value.keys[0].sky.sunElevation), 4, 'redo restores it');
await page.evaluate(() => window.skyAnimate.seek(0));
console.log('keys: storm moves 0 -> 20 km and grows, sun 20 -> 4 deg; frame 0 untouched; undo and redo');

// 2. The recipe travels in the sky .wcx and comes back on open.
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save sky' }).click()]);
const skyPath = 'shots/animate/sky.wcx';
await download.saveAs(skyPath);
const sky = JSON.parse(readFileSync(skyPath, 'utf8'));
assert.equal(sky.sky.animation.windSpeed, 20, 'animation saved in the sky file');
assert.deepEqual(sky.sky.animation.keys[0].shapes.storm, { x: 20, size: 12 }, 'keys saved in the sky file');
assert.equal(sky.sky.shapes.find((s) => s.id === 'storm').x, 0, 'the file holds the composed layer');
await page.evaluate(() => { window.skyAnimate.value = { ...window.skyAnimate.value, windSpeed: 5 }; });
await page.locator('input[type=file][accept=".wcx,.json"]').setInputFiles(skyPath);
await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => window.skyAnimate.value.windSpeed), 20, 'animation restored on open');
assert.equal(await page.evaluate(() => window.skyAnimate.value.keys.length), 1, 'keys restored on open');
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
// Re-rendering a frame alone must cut into the sequence invisibly. Bit-for-bit equality is
// not the bar: floating point is not bit-exact across GPUs, and even here the ground can
// shift ~0.1% with render history. Decode RGBE and require the radiance to match within a
// fraction of one 8-bit display step everywhere that matters.
const decode = (bytes) => {
  const px = bytes.slice(bytes.length - 512 * 256 * 4);
  const out = new Float32Array(512 * 256 * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    const f = px[i + 3] ? 2 ** (px[i + 3] - 136) : 0;
    out[j] = px[i] * f; out[j + 1] = px[i + 1] * f; out[j + 2] = px[i + 2] * f;
  }
  return out;
};
const [x, y] = [decode(frames[1].bytes), decode(again[0].bytes)];
let sumRel = 0, maxRel = 0, n = 0;
for (let i = 0; i < x.length; i++) {
  if (x[i] < 1e-3) continue;
  const rel = Math.abs(y[i] - x[i]) / x[i];
  sumRel += rel; maxRel = Math.max(maxRel, rel); n++;
}
const meanRel = sumRel / n;
assert.ok(meanRel < 0.005 && maxRel < 0.03, `frame 2 re-renders the same (mean ${(meanRel * 100).toFixed(3)}%, max ${(maxRel * 100).toFixed(2)}%)`);
console.log(`frame 2 re-rendered alone matches: mean ${(meanRel * 100).toFixed(3)}%, max ${(maxRel * 100).toFixed(2)}% (${hash(again[0].bytes) === hashes[1] ? 'bit-identical' : 'not bit-identical'})`);

await browser.close();
console.log('smoke-animate: all passed');
