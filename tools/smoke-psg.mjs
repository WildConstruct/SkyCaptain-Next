// Sky graph smoke test: load the example .psg, reroll, holds (choice, shape slot, sky),
// hand edits to held layers, hand-made shapes, undo. Run with the dev server up.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
await page.goto('http://127.0.0.1:5173/?headless=1&noise=16');
await page.waitForFunction(() => window.skyGraph);

const state = () => page.evaluate(() => ({
  caption: document.querySelector('.caption')?.textContent,
  seed: window.skyGraph.last?.seed,
  picks: Object.fromEntries(Object.entries(window.skyGraph.last?.picks ?? {}).map(([k, v]) => [k, v.optionId])),
  shapes: window.skyShapes.shapes.map((s) => ({ kind: s.kind, slot: s.psgSlot, x: +s.x.toFixed(3), z: +s.z.toFixed(3), size: +s.size.toFixed(3) })),
  sun: window.skyGraph['settings'].sunElevation,
}));

// A hand-made shape that rerolls must never touch.
await page.evaluate(() => {
  const st = window.skyShapes;
  st.add({ id: 'manual', kind: 'clear_hole', x: 5, z: 5, size: 3, aspect: 1, rotation: 0, strength: 1, type: null, seed: 1, visible: true });
});

await page.getByRole('button', { name: 'Example graph' }).click();
await page.waitForFunction(() => document.querySelector('.caption'));
let s0 = await state();
assert.ok(s0.caption && s0.caption.length > 10, `caption: ${s0.caption}`);
assert.ok(s0.shapes.some((s) => s.slot === 0), 'graph shapes present');
assert.ok(s0.shapes.some((s) => s.kind === 'clear_hole' && s.slot === undefined && s.x === 5), 'manual shape kept');
console.log('loaded:', s0.caption, '|', s0.shapes.map((s) => `${s.kind}${s.slot ?? '*'}`).join(' '));

// Rerolls change the sky (over a few tries) and keep the hand-made shape.
const captions = new Set([s0.caption]);
for (let i = 0; i < 6; i++) { await page.keyboard.press('r'); await page.waitForTimeout(50); captions.add((await state()).caption); }
assert.ok(captions.size >= 3, `rerolls vary the sky: ${captions.size} captions`);
assert.ok((await state()).shapes.some((s) => s.x === 5 && s.slot === undefined), 'manual shape survives rerolls');
console.log('rerolls:', captions.size, 'distinct captions');

// Hold the regime, shape slot 0 and the sky; move slot 0 by hand first.
await page.evaluate(() => {
  const g = window.skyGraph, st = window.skyShapes;
  g.lockedChoices.add('regime');
  g.lockSky = true;
  const shape = st.shapes.find((s) => s.psgSlot === 0);
  st.checkpoint();
  st.patch(shape.id, { x: shape.x + 7, z: shape.z - 4 });
  g.lockedSlots.add(0);
});
const held = await state();
const held0 = held.shapes.find((s) => s.slot === 0);
for (let i = 0; i < 5; i++) {
  await page.keyboard.press('r');
  await page.waitForTimeout(50);
  const s = await state();
  assert.equal(s.picks.regime, held.picks.regime, 'regime held');
  assert.ok(Math.abs(s.sun - held.sun) < 1e-6, 'sun held');
  const s0b = s.shapes.find((x) => x.slot === 0);
  assert.ok(s0b && Math.abs(s0b.x - held0.x) < 1e-3 && Math.abs(s0b.z - held0.z) < 1e-3 && Math.abs(s0b.size - held0.size) < 1e-6,
    `held slot 0 keeps its hand-moved position: ${JSON.stringify(s0b)} vs ${JSON.stringify(held0)}`);
}
console.log('holds: regime, sun and hand-moved shape 0 stay put across 5 rerolls');

// Undo walks back the last reroll's shape changes.
const before = await state();
await page.keyboard.press('r');
await page.waitForTimeout(50);
await page.keyboard.press('Control+z');
const undone = await state();
assert.deepEqual(undone.shapes, before.shapes, 'undo restores the previous roll\'s shapes');
console.log('undo ok');

await browser.close();
console.log('smoke-psg: all passed');
