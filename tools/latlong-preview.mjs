// Exports the full 360° x 180° environment (the same lat-long the Export HDRI button
// writes) and saves a tone-mapped PNG of it, to see a whole sky at once.
// Usage: node tools/latlong-preview.mjs <out.png> [query string] [1K|2K]
// Needs the dev server and python3 with numpy and Pillow.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [out = 'shots/latlong.png', query = '', size = '1K'] = process.argv.slice(2);
const base = process.env.SKY_URL ?? 'http://127.0.0.1:5173/';
mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}?headless=1${query ? `&${query}` : ''}`);
await page.waitForFunction(() => window.skyRenderer);
await page.getByText('Export HDRI', { exact: true }).first().click();
const selects = page.locator('details:has(summary:text("Export HDRI")) select');
await selects.nth(0).selectOption('hdr');
await selects.nth(1).selectOption({ label: size === '2K' ? '2K (2048×1024)' : '1K (1024×512)' });
await selects.nth(2).selectOption({ label: 'Draft (2 samples)' });
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 3_600_000 }),
  page.getByRole('button', { name: 'Export HDRI' }).click(),
]);
const hdr = join(dirname(out), 'latlong-preview.hdr');
await download.saveAs(hdr);
await browser.close();

// The viewport's preview transform (display.wgsl): EV 0, ACES fit, sRGB. Viewing only.
execFileSync('python3', ['-c', `
import sys, numpy as np
from PIL import Image, ImageDraw
raw = open(sys.argv[1], 'rb').read()
head, _, body = raw.partition(b'\\n-Y ')
dims, _, data = body.partition(b'\\n')
h, w = int(dims.split()[0]), int(dims.split()[2])
rgbe = np.frombuffer(data[: h * w * 4], np.uint8).reshape(h, w, 4).astype(np.float32)
img = rgbe[..., :3] * np.where(rgbe[..., 3:] > 0, np.ldexp(1.0, rgbe[..., 3:].astype(np.int32) - 136), 0)
x = img  # EV 0, as the viewport
x = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)
x = np.clip(x, 0, 1)
x = np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)
out = Image.fromarray((x * 255).astype(np.uint8))
d = ImageDraw.Draw(out)
# Compass: north at the centre, east to its right (u = 0.5 faces +Z).
for label, u in (('S', 0.0), ('W', 0.25), ('N', 0.5), ('E', 0.75)):
    px = int(u * w)
    d.line([(px, h // 2 - 6), (px, h // 2 + 6)], fill=(255, 255, 255))
    d.text((px + 3, h // 2 - 18), label, fill=(255, 255, 255))
out.save(sys.argv[2])
`, hdr, out]);
console.log(`wrote ${out}`);
