// Paint smoke test: strokes on the minimap and in the sky change the GPU weather map;
// erase, type, smudge and undo behave. Run with the dev server up: node tools/smoke-paint.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) console.log('[console]', m.text()); });
// No background weather, so every bit of coverage comes from paint.
await page.goto('http://127.0.0.1:5173/?headless=1&noise=16&baseWeather=0&pitch=35&yaw=0');
await page.waitForFunction(() => window.skyPaint);

/** Weather map values (r coverage, g type, b density) at map km positions, after the GPU catches up. */
const weatherAt = (points) => page.evaluate(async (points) => {
  for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
  await window.skyRenderer.idle();
  const { size, data } = await window.skyRenderer.readWeather();
  return points.map(([x, z]) => {
    const u = Math.floor((x / 300 + 0.5) * size);
    const v = Math.floor((z / 300 + 0.5) * size);
    const i = (v * size + u) * 4;
    return { cov: data[i] / 255, type: data[i + 1] / 255, dens: data[i + 2] / 255 };
  });
}, points);

await page.locator('.minimap').scrollIntoViewIfNeeded();
const map = await page.locator('.minimap').boundingBox();
const toPx = (x, z) => [map.x + map.width / 2 + (x / 90) * (map.width / 2), map.y + map.height / 2 - (z / 90) * (map.height / 2)];
async function strokeOnMap(from, to, steps = 12) {
  await page.mouse.move(...toPx(...from));
  await page.mouse.down();
  await page.mouse.move(...toPx(...to), { steps });
  await page.mouse.up();
}

// 1. Cloud brush on the minimap: a west-east stroke at z = 40.
const [before] = await weatherAt([[0, 40]]);
assert.ok(before.cov < 0.01, 'starts clear');
await page.keyboard.press('1');
await page.evaluate(() => window.skyTools.setBrush({ size: 6, flow: 0.6 }));
await strokeOnMap([-30, 40], [30, 40]);
let [onStroke, offStroke] = await weatherAt([[0, 40], [0, 60]]);
assert.ok(onStroke.cov > 0.5, `stroke adds coverage: ${onStroke.cov}`);
assert.ok(offStroke.cov < 0.01, `away from stroke stays clear: ${offStroke.cov}`);
console.log('cloud brush: coverage', onStroke.cov.toFixed(2), 'on stroke,', offStroke.cov.toFixed(2), 'beside it');

// 2. Type brush toward towers over the left half of the stroke.
await page.keyboard.press('3');
await page.evaluate(() => window.skyTools.setBrush({ type: 1, flow: 0.8, size: 8 }));
await strokeOnMap([-30, 40], [-10, 40]);
let [towers, untouched] = await weatherAt([[-20, 40], [20, 40]]);
assert.ok(towers.type > untouched.type + 0.3, `type pushed toward towers: ${towers.type} vs ${untouched.type}`);
console.log('type brush: type', towers.type.toFixed(2), 'painted vs', untouched.type.toFixed(2));

// 3. Smudge: drag the right end of the stroke north by 20 km.
await page.keyboard.press('6');
await page.evaluate(() => window.skyTools.setBrush({ size: 10, flow: 1, hardness: 0.6 }));
await strokeOnMap([20, 40], [20, 60], 20);
// Smudge carries the content with the brush, so it ends up near the end of the drag.
const along = await weatherAt([[20, 40], ...Array.from({ length: 9 }, (_, i) => [20, 50 + i * 2])]);
const vacated = along[0];
const moved = along.slice(1).reduce((a, b) => (b.cov > a.cov ? b : a));
assert.ok(moved.cov > 0.5, `smudge carries coverage north: ${moved.cov}`);
assert.ok(vacated.cov < onStroke.cov - 0.2, `smudge vacates the start: ${vacated.cov}`);
console.log('smudge: coverage moved north', moved.cov.toFixed(2), ', start now', vacated.cov.toFixed(2));

// 4. Undo the smudge and the type stroke; the original stroke remains.
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
let [restored, restoredType] = await weatherAt([[20, 40], [-20, 40]]);
assert.ok(Math.abs(restored.cov - onStroke.cov) < 0.05, `undo restores coverage: ${restored.cov}`);
assert.ok(Math.abs(restoredType.type - untouched.type) < 0.1, `undo restores type: ${restoredType.type}`);
console.log('undo: coverage', restored.cov.toFixed(2), 'type', restoredType.type.toFixed(2));

// 5. Erase in the sky: find the painted band in the view and clear across it.
await page.keyboard.press('2');
await page.evaluate(() => window.skyTools.setBrush({ size: 12, flow: 1 }));
const vp = await page.locator('#overlay').boundingBox();
// Find the screen row where the z = 40 km stroke appears straight ahead.
const screenY = await page.evaluate(async ({ vp }) => {
  const { mapPointFromDir, rayDir } = await import('/src/camera.ts');
  const s = { ...(await import('/src/settings.ts')).DEFAULTS, pitch: 35, yaw: 0 };
  const aspect = vp.width / vp.height;
  for (let py = vp.height - 1; py > 0; py -= 1) {
    const ndcY = 1 - (py / vp.height) * 2;
    const p = mapPointFromDir(s, rayDir(s, aspect, 0, ndcY));
    if (p && p[1] <= 40) return vp.y + py;
  }
  return null;
}, { vp });
assert.ok(screenY, 'stroke is in view');
await page.mouse.move(vp.x + vp.width * 0.4, screenY);
await page.mouse.down();
await page.mouse.move(vp.x + vp.width * 0.6, screenY, { steps: 10 });
await page.mouse.up();
let [erased] = await weatherAt([[0, 40]]);
assert.ok(erased.cov < 0.05, `sky erase clears coverage: ${erased.cov}`);
console.log('sky erase: coverage', erased.cov.toFixed(2));

// 6. Clear all paint, then undo it.
await page.getByRole('button', { name: 'Clear all paint' }).click();
let [cleared] = await weatherAt([[-25, 40]]);
assert.ok(cleared.cov < 0.01, 'clear all removes paint');
await page.keyboard.press('Control+z');
let [back] = await weatherAt([[-25, 40]]);
assert.ok(back.cov > 0.5, `undo clear brings paint back: ${back.cov}`);
console.log('clear all + undo ok');

await browser.close();
console.log('smoke-paint: all passed');
