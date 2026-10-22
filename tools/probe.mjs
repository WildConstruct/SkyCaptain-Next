// Prints raw texel values from each stage once the page converges. Usage: node tools/probe.mjs [query]
import { chromium } from 'playwright-core';
const query = `headless=1&${process.argv[2] ?? ""}`;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text()); });
await page.goto(`http://127.0.0.1:5173/?${query}`);
await page.waitForFunction(() => document.body.dataset.converged === 'true', null, { timeout: 600000 });
const result = await page.evaluate(async () => {
  const r = window.skyRenderer;
  const out = {};
  out.transmittance = [await r.readTexel('transmittance', 128, 0), await r.readTexel('transmittance', 250, 10)];
  out.ms = [await r.readTexel('ms', 16, 0), await r.readTexel('ms', 30, 16)];
  out.skyZenith = await r.readTexel('sky', 128, 128, 2);
  out.skyHorizon = await r.readTexel('sky', 128, 120, 4);
  out.skyGround = await r.readTexel('sky', 128, 128, 3);
  out.weather = [await r.readTexel('weather', 10, 10), await r.readTexel('weather', 300, 200)];
  out.shape = await r.readTexel('shape', 5, 5, 5);
  out.cloud = [];
  for (const [x, y, f] of [[256, 256, 2], [100, 100, 2], [256, 200, 4], [256, 250, 4]]) out.cloud.push(await r.readTexel('cloud', x, y, f));
  return out;
});
console.log(JSON.stringify(result, (k, v) => (typeof v === 'number' ? +v.toPrecision(4) : v), 1).replace(/\n\s+(?=[-\d\]])/g, ' '));
await browser.close();
