// Checks vendor/psg-eval.browser.js against a Node build of the same PSG source (with real
// crypto): identical output, variables, picks and graphSha256 across library graphs and seeds.
// Usage: node tools/check-psg-bundle.mjs [path to prompt-spaghetti-desktop checkout]
import { build } from 'esbuild';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const psgRepo = resolve(process.argv[2] ?? process.env.PSG_REPO ?? resolve(root, '../prompt-spaghetti-desktop'));
const reference = join(tmpdir(), `psg-eval-node-${process.pid}.mjs`);
await build({
  entryPoints: [resolve(psgRepo, 'packages/core/runtime/evaluatePsg.ts')],
  outfile: reference, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning',
  nodePaths: [resolve(root, 'node_modules')],
});
const node = await import(pathToFileURL(reference).href);
const browser = await import(pathToFileURL(resolve(root, 'vendor/psg-eval.browser.js')).href);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.psg')) files.push(p);
  }
};
walk(resolve(psgRepo, 'assets/library'));
walk(resolve(root, 'examples'));
let compared = 0;
for (const file of files.slice(0, 60).concat(files.filter((f) => f.startsWith(resolve(root, 'examples'))))) {
  const text = readFileSync(file, 'utf8');
  for (const seed of [0, 1, 42, 'storm']) {
    const a = await node.evaluatePsg(text, { seed });
    const b = await browser.evaluatePsg(text, { seed });
    assert.deepEqual(b, a, `${file} seed ${seed}`);
    compared++;
  }
}
console.log(`psg bundle parity: ${compared} evaluations identical (${compared / 4} graphs x 4 seeds)`);
