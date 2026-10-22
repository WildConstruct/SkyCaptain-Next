// Export smoke test: drives the Export HDRI button (1K, draft) for EXR and HDR, saves the
// downloads, and checks the decoded EXR pixels. Run with the dev server up:
//   node tools/smoke-export.mjs [out dir]   (validate further with tools/check-hdri.py)
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'shots/export';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
await page.goto('http://127.0.0.1:5173/?headless=1&noise=64&sunElevation=30&sunAzimuth=0');
await page.waitForFunction(() => window.skyRenderer);

await page.getByText('Export HDRI', { exact: true }).first().click(); // open the section
const selects = page.locator('details:has(summary:text("Export HDRI")) select');
await selects.nth(1).selectOption({ label: '1K (1024×512)' });
await selects.nth(2).selectOption({ label: 'Draft (2 samples)' });

const files = {};
for (const ext of ['exr', 'hdr']) {
  await selects.nth(0).selectOption(ext);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 900_000 }),
    page.getByRole('button', { name: 'Export HDRI' }).click(),
  ]);
  const path = join(outDir, download.suggestedFilename());
  await download.saveAs(path);
  files[ext] = path;
  console.log(`exported ${download.suggestedFilename()} (${readFileSync(path).length} bytes)`);
}

// Minimal reader for our uncompressed scanline EXR (half or float) for in-test checks.
const buf = readFileSync(files.exr);
assert.equal(buf.readUInt32LE(0), 20000630, 'EXR magic');
const W = 1024, H = 512;
let p = 8;
let pixelType = 1;
while (buf[p] !== 0) {
  let name = '';
  while (buf[p] !== 0) name += String.fromCharCode(buf[p++]);
  p++;
  while (buf[p] !== 0) p++;
  p++;
  const size = buf.readUInt32LE(p);
  if (name === 'channels') pixelType = buf.readInt32LE(p + 4 + 2); // after "B\0"
  p += 4 + size;
}
p += 1 + H * 8;
const bytesPer = pixelType === 2 ? 4 : 2;
const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1; return e === 0 ? s * 2 ** -14 * m / 1024 : e === 31 ? (m ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + m / 1024); };
const px = (x, y) => {
  const base = p + y * (8 + W * 3 * bytesPer) + 8;
  const ch = (c) => (bytesPer === 4 ? buf.readFloatLE(base + (c * W + x) * 4) : half(buf.readUInt16LE(base + (c * W + x) * 2)));
  return { r: ch(2), g: ch(1), b: ch(0) };
};
// Every pixel must be finite: a sun overflowing half float becomes infinity.
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const v = px(x, y);
  assert.ok([v.r, v.g, v.b].every(Number.isFinite), `pixel ${x},${y} not finite: ${JSON.stringify(v)}`);
}
console.log(`exr pixel type: ${pixelType === 2 ? 'float' : 'half'}, all ${W * H} pixels finite`);
const zenith = px(512, 2);
assert.ok(zenith.b > zenith.r, `zenith is blue: ${JSON.stringify(zenith)}`);
// Sun at azimuth 0 (centre column), elevation 30 deg -> row (0.5 - 30/180) * H.
const sunRow = Math.round((0.5 - 30 / 180) * H);
let sunMax = 0;
for (let y = sunRow - 3; y <= sunRow + 3; y++) for (let x = 509; x <= 515; x++) sunMax = Math.max(sunMax, px(x, y).g);
const sky = px(256, sunRow).g;
assert.ok(sunMax > sky * 100, `sun is far brighter than sky: ${sunMax} vs ${sky}`);
const horizon = px(768, H / 2 - 3);
assert.ok(horizon.r / horizon.b > zenith.r / zenith.b, 'horizon is warmer than zenith (atmosphere)');
console.log(`checks: zenith ${zenith.b.toFixed(2)} blue, sun peak ${sunMax.toFixed(0)} vs sky ${sky.toFixed(2)}`);

await browser.close();
console.log('smoke-export: all passed');
