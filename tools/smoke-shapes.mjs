// Interaction smoke test for shape layers: add, move and resize on the minimap, move in the
// sky, undo/redo, delete. Run with the dev server up: node tools/smoke-shapes.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
await page.goto('http://127.0.0.1:5173/?headless=1&noise=16&pitch=30&yaw=0');
await page.waitForFunction(() => window.skyShapes);
const shapes = () => page.evaluate(() => window.skyShapes.shapes.map((s) => ({ ...s })));

// Add a storm cell where we're looking: it lands north of the eye.
await page.getByRole('button', { name: '+ Storm cell' }).click();
let [storm] = await shapes();
assert.equal(storm.kind, 'storm_cell');
assert.ok(storm.z > 0 && Math.abs(storm.x) < 1, `placed ahead: ${storm.x}, ${storm.z}`);
console.log('add: storm at', storm.x.toFixed(1), storm.z.toFixed(1));

// Minimap geometry: radius 90 km mapped onto the canvas.
await page.locator('.minimap').scrollIntoViewIfNeeded();
const map = await page.locator('.minimap').boundingBox();
const toPx = (x, z) => [map.x + map.width / 2 + (x / 90) * (map.width / 2), map.y + map.height / 2 - (z / 90) * (map.height / 2)];

// Drag the shape 20 km east on the minimap.
let [px, py] = toPx(storm.x, storm.z);
await page.mouse.move(px, py);
await page.mouse.down();
await page.mouse.move(...toPx(storm.x + 20, storm.z), { steps: 5 });
await page.mouse.up();
let [moved] = await shapes();
assert.ok(Math.abs(moved.x - (storm.x + 20)) < 1.5, `moved east: ${moved.x}`);
console.log('minimap move: x', storm.x.toFixed(1), '->', moved.x.toFixed(1));

// Drag the size handle (east of centre at rotation 0) north-east: grows and rotates 45 deg.
[px, py] = toPx(moved.x + moved.size, moved.z);
await page.mouse.move(px, py);
await page.mouse.down();
await page.mouse.move(...toPx(moved.x + 10, moved.z + 10), { steps: 5 });
await page.mouse.up();
let [resized] = await shapes();
assert.ok(Math.abs(resized.size - Math.hypot(10, 10)) < 1.5, `size ${resized.size}`);
assert.ok(Math.abs(resized.rotation - 45) < 5, `rotation ${resized.rotation}`);
console.log('size handle: size', resized.size.toFixed(1), 'rotation', resized.rotation.toFixed(1));

// Drag it in the sky. First bring it in front of the camera (one more undo step).
const centre = await page.evaluate(() => {
  const st = window.skyShapes;
  st.checkpoint();
  st.patch(st.current.id, { x: 0, z: 25 });
  return { x: 0, z: 25 };
});
const vp = await page.locator('#overlay').boundingBox();
// Find the screen position of the shape centre by scanning for a hit (simple and robust).
const hitPoint = await page.evaluate(async ({ vp }) => {
  const el = document.querySelector('#overlay');
  for (let y = 0.2; y < 0.95; y += 0.02) {
    for (let x = 0.05; x < 0.95; x += 0.02) {
      const ev = { clientX: vp.x + vp.width * x, clientY: vp.y + vp.height * y };
      // Mirror SkyOverlay.mapPointAt via a synthetic hover: cursor becomes 'move' over shapes.
      el.dispatchEvent(new PointerEvent('pointermove', ev));
      if (el.style.cursor === 'move') return ev;
    }
  }
  return null;
}, { vp });
assert.ok(hitPoint, 'shape is visible and hoverable in the sky');
await page.mouse.move(hitPoint.clientX, hitPoint.clientY);
await page.mouse.down();
await page.mouse.move(hitPoint.clientX - 120, hitPoint.clientY, { steps: 6 });
await page.mouse.up();
let [skyMoved] = await shapes();
assert.ok(skyMoved.x < centre.x - 1, `moved west in sky: ${centre.x} -> ${skyMoved.x}`);
console.log('sky drag: x', centre.x.toFixed(1), '->', skyMoved.x.toFixed(1));

// Undo four times walks back sky move, reposition, resize, minimap move; redo re-applies one.
for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
let [undone] = await shapes();
assert.ok(Math.abs(undone.x - storm.x) < 1e-6 && Math.abs(undone.size - storm.size) < 1e-6, 'undo restores original');
await page.keyboard.press('Control+Shift+z');
let [redone] = await shapes();
assert.ok(Math.abs(redone.x - moved.x) < 1e-6, 'redo re-applies the move');
console.log('undo/redo ok');

// Select via the layer list and delete with the keyboard.
await page.locator('.layers li').first().click();
await page.keyboard.press('Delete');
assert.equal((await shapes()).length, 0);
console.log('delete ok');

// The weather map must reflect shapes: add a clear hole over a full-coverage background
// and check the minimap readback shows near-zero coverage at its centre.
await page.evaluate(() => {
  const st = window.skyShapes;
  st.add({ ...st.shapes[0], id: 'hole', kind: 'clear_hole', x: 0, z: 30, size: 15, aspect: 1, rotation: 0, strength: 1, type: null, seed: 1, visible: true });
});
const coverage = await page.evaluate(async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
  const { size, data } = await window.skyRenderer.readWeather();
  const at = (x, z) => {
    const u = Math.floor((x / 300 + 0.5) * size);
    const v = Math.floor((z / 300 + 0.5) * size);
    return data[(v * size + u) * 4] / 255;
  };
  let outside = 0;
  for (let i = 0; i < 64; i++) outside = Math.max(outside, at(-100 + i * 3, -60));
  return { inside: at(0, 30), outsideMax: outside };
});
assert.ok(coverage.inside < 0.02, `clear hole empties coverage: ${coverage.inside}`);
assert.ok(coverage.outsideMax > 0.3, `background has coverage elsewhere: ${coverage.outsideMax}`);
console.log('weather map: hole coverage', coverage.inside.toFixed(3), 'background max', coverage.outsideMax.toFixed(2));

await browser.close();
console.log('smoke-shapes: all passed');
