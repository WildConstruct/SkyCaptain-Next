// Looks smoke test: Moniker-suggested names in Save look, .wcx download contents, saved
// looks surviving a reload, applying factory and saved looks, .wcx import, and Moniker
// names on sky files. Run with the dev server up.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('shots/looks', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
await page.goto('http://127.0.0.1:5173/?headless=1&noise=16');
await page.waitForFunction(() => window.skyGraph);
const setting = (k) => page.evaluate((k) => window.skyGraph['settings'][k], k);

// Factory look applies its settings.
await page.locator('.looks button', { hasText: 'Golden hour' }).click();
assert.equal(await setting('sunElevation'), 6);

// Save look offers Moniker's name; ↻ follows changes to the look.
await page.getByRole('button', { name: 'Save look…' }).click();
const nameInput = page.locator('.save-look input[type=text]');
assert.equal(await nameInput.inputValue(), 'Golden-Hour Sky');
await page.evaluate(() => { const s = window.skyGraph['settings']; s.haze = 15; s.density = 55; s.ambient = 0.6; });
await page.locator('.save-look button[title^="Suggest"]').click();
const suggested = await nameInput.inputValue();
// Three tokens at most (two adjectives and the noun): Hazy fires but is trimmed.
assert.equal(suggested, 'Brooding Golden-Hour Sky');
console.log('suggested:', suggested);
const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.save-look button', { hasText: 'Save' }).click()]);
assert.equal(download.suggestedFilename(), `${suggested}.wcx`);
const wcxPath = `shots/looks/${download.suggestedFilename()}`;
await download.saveAs(wcxPath);
const wcx = JSON.parse(readFileSync(wcxPath, 'utf8'));
assert.equal(wcx._format, 'wcx');
assert.equal(wcx._plugin, 'skycaptain');
assert.equal(wcx.kind, 'look');
assert.equal(wcx.moniker.vocabulary, 'skycaptain-look@1.0');
assert.equal(wcx.moniker.fallback, 'Brooding Golden-Hour Sky');
assert.ok(wcx.moniker.tokens.includes('Hazy'), 'trimmed tokens are still recorded');
assert.ok(wcx.params.some((p) => p.id === 'haze' && p.value === 15));
assert.ok(!wcx.params.some((p) => ['ev', 'yaw', 'seed'].includes(p.id)), 'view and composition are not part of a look');
console.log('wcx:', wcx.name, wcx.moniker.tokens.join(' / '));

// The saved look is a chip, survives reload, and re-applies.
await page.reload();
await page.waitForFunction(() => window.skyGraph);
const chip = page.locator('.looks .chip.user button', { hasText: suggested });
await chip.waitFor();
await page.locator('.looks button', { hasText: 'Bright midday' }).click();
assert.equal(await setting('haze'), 70);
await chip.click();
assert.equal(await setting('haze'), 15);
assert.equal(await setting('density'), 55);
console.log('saved look persists across reload and re-applies');

// A second save of the same look gets a distinct suggestion.
await page.getByRole('button', { name: 'Save look…' }).click();
const second = await nameInput.inputValue();
assert.notEqual(second, suggested);
await page.locator('.save-look button', { hasText: 'Cancel' }).click();
console.log('second suggestion:', second);

// Import a .wcx under a new name.
wcx.name = 'Imported Storm Light';
writeFileSync('shots/looks/imported.wcx', JSON.stringify(wcx));
await page.locator('input[type=file][accept=".wcx"]').setInputFiles('shots/looks/imported.wcx');
await page.locator('.looks button', { hasText: 'Imported Storm Light' }).waitFor();
// A Lumen preset is refused with a clear message.
writeFileSync('shots/looks/lumen.wcx', JSON.stringify({ _format: 'wcx', _plugin: 'lumen', params: [] }));
await page.locator('input[type=file][accept=".wcx"]').setInputFiles('shots/looks/lumen.wcx');
await page.getByText('lumen preset, not a skyCaptain look').waitFor();
console.log('import ok; foreign preset refused');

// Sky files are named by Moniker from the composed weather.
await page.evaluate(() => {
  const st = window.skyShapes;
  st.add({ id: 'f', kind: 'front', x: 0, z: 30, size: 40, aspect: 0.2, rotation: 0, strength: 1, type: null, seed: 1, visible: true });
  st.add({ id: 's', kind: 'storm_cell', x: 0, z: 30, size: 6, aspect: 1, rotation: 0, strength: 1, type: null, seed: 2, visible: true });
});
const [skyDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save sky' }).click()]);
assert.equal(skyDownload.suggestedFilename(), 'Brooding Golden-Hour Squall Line.sky.json');
await skyDownload.saveAs('shots/looks/sky.sky.json');
const doc = JSON.parse(readFileSync('shots/looks/sky.sky.json', 'utf8'));
assert.equal(doc.name, skyDownload.suggestedFilename().replace('.sky.json', ''));
assert.equal(doc.moniker.vocabulary, 'skycaptain-sky@1.0');
console.log('sky file:', skyDownload.suggestedFilename());

await browser.close();
console.log('smoke-looks: all passed');
