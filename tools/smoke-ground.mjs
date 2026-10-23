// Ground smoke test: the example ground graph turns terrain on and rolls a layout, rerolls
// lay out new ground, terrain travels in the sky .wcx, and it shows on the ground.
// Run with the dev server up.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';

mkdirSync('shots/ground', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) { console.log('[console]', m.text()); process.exitCode = 1; } });
await page.goto(`${process.env.SKY_URL ?? 'http://127.0.0.1:5173/'}?headless=1&noise=32&samples=1&eyeAltitude=2&pitch=-40`);
await page.waitForFunction(() => window.skyGround && window.skyConverge);

// Plain ground first: capture the lower half's mean colour.
const meanBelow = async () => page.evaluate(async () => {
  await window.skyConverge();
  const px = await window.skyCapture(64, 36);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 24; y < 36; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
  return [r / n, g / n, b / n];
});
assert.equal(await page.evaluate(() => window.skyGround.enabled), false, 'terrain starts off');
const plain = await meanBelow();

// 1. The example ground graph turns terrain on with a recipe from its ranges.
await page.getByRole('button', { name: 'Terrain example' }).click();
await page.waitForFunction(() => window.skyGround.enabled);
let state = await page.evaluate(() => ({ recipe: window.skyGround.recipe, caption: window.skyGroundGraph.last.caption, types: Array.from(window.skyGround.map.types.slice(0, 4096)) }));
assert.ok(state.recipe.waterLevel >= 0 && state.recipe.waterLevel <= 0.6, `water level ${state.recipe.waterLevel}`);
assert.ok(state.caption.length > 10, 'the roll has a caption');
console.log('ground graph:', state.caption);

// 2. Reroll lays out new ground.
const before = state.types;
await page.evaluate(() => window.skyGroundGraph.roll(4242));
state = await page.evaluate(() => ({ seed: window.skyGround.recipe.seed, types: Array.from(window.skyGround.map.types.slice(0, 4096)) }));
assert.equal(state.seed, 4242, 'the layout follows the roll seed');
assert.notDeepEqual(state.types, before, 'a reroll changes the layout');

// 3. Terrain shows on the ground.
const terrain = await meanBelow();
const diff = terrain.reduce((s, v, i) => s + Math.abs(v - plain[i]), 0);
assert.ok(diff > 6, `ground looks different with terrain (${plain.map(Math.round)} -> ${terrain.map(Math.round)})`);
console.log(`ground colour ${plain.map(Math.round)} -> ${terrain.map(Math.round)}`);

// 4. Terrain travels in the sky file.
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save sky' }).click()]);
const path = 'shots/ground/sky.wcx';
await download.saveAs(path);
const sky = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(sky.sky.ground.enabled, true);
assert.equal(sky.sky.ground.recipe.seed, 4242);
await page.evaluate(() => { window.skyGround.setEnabled(false); window.skyGround.update({ seed: 1 }); });
await page.locator('input[type=file][accept=".wcx,.json"]').setInputFiles(path);
await page.waitForFunction(() => window.skyGround.enabled && window.skyGround.recipe.seed === 4242);
assert.deepEqual(await page.evaluate(() => Array.from(window.skyGround.map.types.slice(0, 4096))), state.types, 'the same layout comes back');
console.log('terrain round-trips through the sky file');

await browser.close();
console.log('smoke-ground: all passed');
