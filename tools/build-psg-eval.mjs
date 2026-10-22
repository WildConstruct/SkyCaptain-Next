// Bundles Prompt Spaghetti's evaluatePsg for the browser: vendor/psg-eval.browser.js.
// Usage: node tools/build-psg-eval.mjs [path to prompt-spaghetti-desktop checkout]
// The source stays in the PSG repo; only the bundle is vendored here, with the PSG commit
// it came from and its own sha256 (mirrors how era-crowd vendors psg-eval.cjs).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const psgRepo = resolve(process.argv[2] ?? process.env.PSG_REPO ?? resolve(root, '../prompt-spaghetti-desktop'));
const entry = resolve(psgRepo, 'packages/core/runtime/evaluatePsg.ts');
const commit = execFileSync('git', ['-C', psgRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const outfile = resolve(root, 'vendor/psg-eval.browser.js');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  // evaluatePsg's only Node import; zod and seedrandom resolve from this repo's node_modules.
  alias: { crypto: resolve(root, 'tools/shims/crypto.js') },
  nodePaths: [resolve(root, 'node_modules')],
  banner: { js: `// Prompt Spaghetti evaluatePsg, browser bundle. Source: WildConstruct/prompt-spaghetti-desktop@${commit}. Built by tools/build-psg-eval.mjs; do not edit.` },
  logLevel: 'warning',
});
const sha = createHash('sha256').update(readFileSync(outfile)).digest('hex');
writeFileSync(`${outfile}.sha256`, `${sha}  psg-eval.browser.js\n`);
console.log(`${sha}  vendor/psg-eval.browser.js (psg ${commit.slice(0, 10)})`);
