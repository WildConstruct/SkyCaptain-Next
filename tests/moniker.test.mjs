// skyCaptain's Moniker vocabularies against the adapter, the slider ranges and golden
// names. Run: npm test
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateName, slotToken } from '../vendor/moniker/moniker.js';
import {
  DERIVED_STATE, describeLook, describeSky, lookMonikerState, moodFamily, sceneFamily, skyMonikerState, timeFamily,
} from '../src/moniker/skycaptain.js';
import { DEFAULTS } from '../src/settings.ts';
import { VIBES } from '../src/vibes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const look = read('src/moniker/skycaptain-look.moniker');
const sky = read('src/moniker/skycaptain-sky.moniker');

// Slider ranges (src/main.ts) for every continuous parameter a vocabulary reads.
const RANGES = {
  windKm: [0, Math.hypot(40, 40)], erosion: [0, 1], density: [2, 120], haze: [5, 120],
  sunIntensity: [1, 100], coverage: [0, 1], typeBias: [-1, 1],
};
const FAMILIES = {
  time: ['twilight', 'golden', 'low', 'day', 'high'],
  mood: ['none', 'brooding', 'soft', 'luminous'],
  scene: ['squall', 'storms', 'storm', 'front', 'clearing', 'haze', 'cumulus', 'painted', 'open'],
};

test('the vendored engine is byte-identical to the Lumen reference recorded in SOURCE.md', () => {
  const source = fs.readFileSync(path.join(root, 'vendor/moniker/SOURCE.md'), 'utf8');
  const recorded = /sha256: ([0-9a-f]{64})/.exec(source)[1];
  const actual = createHash('sha256').update(fs.readFileSync(path.join(root, 'vendor/moniker/moniker.js'))).digest('hex');
  assert.equal(actual, recorded);
});

for (const [name, vocab, state] of [
  ['look', look, lookMonikerState(DEFAULTS)],
  ['sky', sky, skyMonikerState(DEFAULTS, [], false)],
]) {
  test(`${name} vocabulary is well formed and reads only what the adapter provides`, () => {
    assert.ok(vocab.id && vocab.version && vocab.locale);
    assert.equal(new Set(vocab.slot_order).size, vocab.slot_order.length);
    assert.deepEqual([...vocab.slot_order].sort(), Object.keys(vocab.slots).sort());
    for (const slot of Object.values(vocab.slots)) {
      assert.ok(Object.hasOwn(state, slot.parameter), `adapter provides ${slot.parameter}`);
      assert.ok(Number.isFinite(slot.weight));
    }
    for (const c of vocab.composites ?? []) {
      for (const [slot, wanted] of Object.entries(c.requires)) {
        const tokens = vocab.slots[slot].mappings.map((m) => m.token);
        for (const w of [wanted].flat()) assert.ok(tokens.includes(w), `composite ${c.token}: ${slot} can fire ${w}`);
      }
    }
  });

  test(`${name} vocabulary covers every value each slot can see`, () => {
    for (const [slotName, slot] of Object.entries(vocab.slots)) {
      const ranged = slot.mappings.filter((m) => Array.isArray(m.range));
      if (ranged.length) {
        const [lo, hi] = RANGES[slot.parameter];
        for (let i = 0; i <= 400; i++) {
          const v = lo + ((hi - lo) * i) / 400;
          const matched = ranged.some((m, j) => v >= m.range[0] && (v < m.range[1] || (j === ranged.length - 1 && v === m.range[1])));
          assert.ok(matched, `${slotName} has a mapping for ${slot.parameter} = ${v}`);
        }
        for (let j = 1; j < ranged.length; j++) assert.equal(ranged[j].range[0], ranged[j - 1].range[1], `${slotName} ranges are contiguous`);
      } else {
        const values = slot.mappings.map((m) => m.value).sort();
        assert.deepEqual(values, [...FAMILIES[slot.parameter]].sort(), `${slotName} maps every ${slot.parameter} family`);
      }
    }
  });
}

test('families cover their inputs', () => {
  assert.deepEqual([-3, 2, 15, 40, 70].map(timeFamily), ['twilight', 'golden', 'low', 'day', 'high']);
  assert.equal(moodFamily(60, 0.6, 0.3, 0.8), 'brooding');
  assert.equal(moodFamily(20, 1.4, 0.1, 0.7), 'soft');
  assert.equal(moodFamily(30, 0.9, 0.3, 0.9), 'luminous');
  assert.equal(moodFamily(30, 1, 0.25, 0.8), 'none');
  assert.ok(DERIVED_STATE.every((k) => k in lookMonikerState(DEFAULTS) || k in skyMonikerState(DEFAULTS, [], false)));
});

test('an untouched sky is simply a Sky', () => {
  assert.equal(describeLook(DEFAULTS, look).suggestion, 'Sky');
  assert.equal(describeSky(DEFAULTS, [], false, sky).suggestion, 'Sky');
});

test('factory looks get their reviewed names', () => {
  const names = Object.fromEntries(VIBES.map((v) => [v.name, describeLook({ ...DEFAULTS, ...v.settings }, look).fallback]));
  assert.deepEqual(names, {
    'Bright midday': 'Crisp Midday Sky',
    'Golden hour': 'Golden-Hour Sky',
    'Last light': 'Luminous Golden-Hour Sky',
    'Hazy summer': 'Soft Milky Sky',
    Brooding: 'Brooding Low-Sun Sky',
    'Overcast softbox': 'Layered Overcast',
  });
});

test('recognisable looks get their own noun', () => {
  const name = (s) => describeLook({ ...DEFAULTS, ...s }, look).fallback;
  assert.equal(name({ sunElevation: -2, coverage: 0.2 }), 'Afterglow');
  assert.equal(name({ typeBias: 0.7, density: 60 }), 'Thunderheads');
  assert.equal(name({ haze: 8, coverage: 0.2 }), 'Haze');
  assert.equal(name({ coverage: 0.85, ambient: 0.6, density: 50 }), 'Brooding Dense Overcast');
  assert.equal(name({ sunElevation: 70, haze: 90, coverage: 0.2 }), 'Clear Midday Sky');
});

test('whole skies are named for the weather composed in them', () => {
  const shape = (kind, extra = {}) => ({ kind, strength: 1, visible: true, ...extra });
  const scene = (shapes, paint = false) => describeSky({ ...DEFAULTS, sunElevation: 5, haze: 18 }, shapes, paint, sky).fallback;
  assert.equal(scene([shape('front'), shape('storm_cell')]), 'Hazy Golden-Hour Squall Line');
  assert.equal(scene([shape('storm_cell'), shape('storm_cell')]), 'Hazy Golden-Hour Thunderstorms');
  assert.equal(scene([shape('storm_cell'), shape('cumulus_field')]), 'Hazy Golden-Hour Thunderstorm');
  assert.equal(scene([shape('front')]), 'Hazy Golden-Hour Weather Front');
  assert.equal(scene([shape('clear_hole')]), 'Hazy Golden-Hour Clearing');
  assert.equal(scene([shape('cumulus_field')]), 'Hazy Golden-Hour Cumulus');
  assert.equal(scene([], true), 'Hazy Golden-Hour Cloudscape');
  // Hidden or faint layers do not decide the scene.
  assert.equal(sceneFamily([shape('storm_cell', { visible: false }), shape('cumulus_field', { strength: 0.1 })], false), 'open');
});

test('a Save suggestion is unique among existing names; the fallback ignores them', () => {
  const s = { ...DEFAULTS, sunElevation: 5 };
  const first = describeLook(s, look, []);
  const second = describeLook(s, look, [first.suggestion]);
  assert.notEqual(second.suggestion, first.suggestion);
  assert.equal(second.fallback, first.fallback);
  const third = describeLook(s, look, [first.suggestion, second.suggestion]);
  assert.ok(![first.suggestion, second.suggestion].includes(third.suggestion));
});

test('naming is deterministic and reads only through the vendored engine', () => {
  for (let i = 0; i < 50; i++) {
    const s = { ...DEFAULTS, sunElevation: -4 + i * 1.9, haze: 5 + i * 2.3, coverage: (i * 37 % 100) / 100, density: 2 + i * 2.3 };
    assert.equal(describeLook(s, look).fallback, generateName(lookMonikerState(s), look));
  }
  assert.equal(slotToken(look.slots.cover, 1), 'Overcast');
});
