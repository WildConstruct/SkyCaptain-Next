// Terrain layout (src/terrain.ts): the collapse is deterministic, obeys the adjacency
// rules, honours painted tiles, follows the recipe, and is fast enough to reroll live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TERRAIN, TERRAIN_TYPES, generateTerrain, parseTerrain, respectsAdjacency } from '../src/terrain.ts';

const share = (map, name) => map.types.filter((t) => t === TERRAIN_TYPES.indexOf(name)).length / map.types.length;

test('the same recipe always lays out the same ground, and it obeys the rules', () => {
  const a = generateTerrain(DEFAULT_TERRAIN);
  const b = generateTerrain(DEFAULT_TERRAIN);
  assert.deepEqual(a.types, b.types);
  assert.ok(respectsAdjacency(a), 'every neighbouring pair may touch');
  const c = generateTerrain({ ...DEFAULT_TERRAIN, seed: 2 });
  assert.notDeepEqual(a.types, c.types, 'another seed, another layout');
  for (const name of TERRAIN_TYPES) assert.ok(share(a, name) > 0, `${name} appears`);
});

test('the water level and weights steer the layout', () => {
  const dry = generateTerrain({ ...DEFAULT_TERRAIN, waterLevel: 0.1 });
  const wet = generateTerrain({ ...DEFAULT_TERRAIN, waterLevel: 0.6 });
  assert.ok(share(wet, 'water') > share(dry, 'water') * 2, `${share(wet, 'water')} vs ${share(dry, 'water')}`);
  const noRock = generateTerrain({ ...DEFAULT_TERRAIN, weights: { ...DEFAULT_TERRAIN.weights, rock: 0 } });
  assert.equal(share(noRock, 'rock'), 0, 'zero weight never appears');
  assert.ok(respectsAdjacency(noRock));
});

test('painted tiles are fixed and the rest grows around them consistently', () => {
  const size = 128;
  const constraints = new Int8Array(size * size).fill(-1);
  // A lake painted in the middle of the map.
  for (let y = 60; y < 70; y++) for (let x = 60; x < 70; x++) constraints[y * size + x] = TERRAIN_TYPES.indexOf('water');
  const map = generateTerrain(DEFAULT_TERRAIN, constraints, size);
  for (let i = 0; i < constraints.length; i++) if (constraints[i] >= 0) assert.equal(map.types[i], constraints[i]);
  assert.ok(respectsAdjacency(map), 'the lake is shored with sand, not dropped into forest');
});

test('a full map collapses quickly enough to reroll live', () => {
  const t0 = performance.now();
  generateTerrain({ ...DEFAULT_TERRAIN, seed: 9 });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});

test('untrusted recipes fall back and clamp', () => {
  assert.deepEqual(parseTerrain(undefined), DEFAULT_TERRAIN);
  const r = parseTerrain({ tileKm: 500, waterLevel: -1, weights: { forest: 'lots', rock: 3 }, palette: { sand: [2, 0.5, 'x'], water: [0.1, 0.2, 2] } });
  assert.equal(r.tileKm, 20);
  assert.equal(r.waterLevel, 0);
  assert.equal(r.weights.forest, DEFAULT_TERRAIN.weights.forest);
  assert.equal(r.weights.rock, 3);
  assert.deepEqual(r.palette.sand, DEFAULT_TERRAIN.palette.sand, 'a bad colour is ignored');
  assert.deepEqual(r.palette.water, [0.1, 0.2, 1], 'a good colour is clamped');
});
