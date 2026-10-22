// Animation time model (src/animation.ts): frame 0 is the composed sky, keys move settings
// and shapes, wind drift integrates keyed wind, and untrusted recipes are cleaned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ANIMATION, driftAt, frameCount, frameTime, parseAnimation, removeKey, setKey, settingsAt, shapesAt, timeInvalidation,
} from '../src/animation.ts';
import { DEFAULTS } from '../src/settings.ts';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const linear = { ...DEFAULT_ANIMATION, ease: 'linear' };

test('frame 0 is exactly the sky as composed', () => {
  assert.deepEqual(settingsAt(DEFAULTS, DEFAULT_ANIMATION, 0), DEFAULTS);
  const keyed = setKey(DEFAULT_ANIMATION, 5, { sky: { sunElevation: 2 } });
  assert.deepEqual(settingsAt(DEFAULTS, keyed, 0), DEFAULTS);
});

test('wind carries the weather toward its heading at the time-lapsed speed', () => {
  // 36 km/h for 10 s at 360x = 1 scene hour = 36 km toward the east.
  const a = { ...DEFAULT_ANIMATION, windSpeed: 36, windHeading: 90, timeLapse: 360, cloudLife: 0 };
  const s = settingsAt(DEFAULTS, a, 10);
  // Content moves east, so the sampling offset moves west.
  close(s.windX, DEFAULTS.windX - 36, 1e-6);
  close(s.windZ, DEFAULTS.windZ, 1e-6);
  assert.equal(s.evolve, 0, 'cloud life 0 freezes shapes');
});

test('keyed wind drifts by its integral', () => {
  // Speed falls linearly from 36 to 0 km/h over one scene hour: 18 km in all.
  const a = setKey({ ...linear, windSpeed: 36, windHeading: 0, timeLapse: 360 }, 10, { sky: { windSpeed: 0 } });
  const [dx, dz] = driftAt(a, 10);
  close(dx, 0, 1e-6);
  close(dz, 18, 1e-6);
  // A heading key turns the drift: due east after the turn.
  const turn = setKey({ ...linear, windSpeed: 36, windHeading: 0, timeLapse: 360 }, 1e-6, { sky: { windHeading: 90 } });
  const [ex, ez] = driftAt(turn, 10);
  // The heading jumps within the first microsecond; the fixed grid sees it one sample late.
  close(ex, 36, 0.1);
  close(ez, 0, 0.1);
});

test('clouds turn over once per cloud life', () => {
  const a = { ...DEFAULT_ANIMATION, timeLapse: 60, cloudLife: 30 };
  // 30 s at 60x = 30 scene minutes = one cloud life = one shape period of scroll.
  close(settingsAt(DEFAULTS, a, 30).evolve, DEFAULTS.shapeScale, 1e-9);
});

test('keys ease between values, take the short way round angles, and hold after the last', () => {
  const base = { ...DEFAULTS, sunElevation: 20, sunAzimuth: 170 };
  const a = setKey({ ...DEFAULT_ANIMATION, duration: 10 }, 10, { sky: { sunElevation: 0, sunAzimuth: -170 } });
  const mid = settingsAt(base, a, 5);
  close(mid.sunElevation, 10);
  close(Math.abs(mid.sunAzimuth), 180, 1e-9); // through 180, not through 0
  close(settingsAt(base, a, 10).sunAzimuth, -170, 1e-9);
  // Smooth easing is slow near the keys, linear is not.
  close(settingsAt(base, a, 1).sunElevation, 20 - 20 * 0.028, 1e-9); // smoothstep(0.1) = 0.028
  close(settingsAt(base, { ...a, ease: 'linear' }, 1).sunElevation, 18);
  // Two keys: each property moves between the keys that set it.
  const two = setKey(setKey(linear, 4, { sky: { coverage: 0.5 } }), 8, { sky: { coverage: 0.1, density: 400 } });
  const c = DEFAULTS.coverage;
  close(settingsAt(DEFAULTS, two, 2).coverage, c + (0.5 - c) / 2);
  close(settingsAt(DEFAULTS, two, 6).coverage, 0.3);
  close(settingsAt(DEFAULTS, two, 9).coverage, 0.1);
  close(settingsAt(DEFAULTS, two, 4).density, DEFAULTS.density + (400 - DEFAULTS.density) / 2);
});

test('shape layers move, grow and fade between keys', () => {
  const storm = { id: 's1', kind: 'storm_cell', x: 0, z: 40, size: 6, aspect: 1, rotation: 170, strength: 1, type: null, seed: 1, visible: true };
  const other = { ...storm, id: 's2', x: -30 };
  const a = setKey(linear, 10, { shape: { id: 's1', values: { x: 20, size: 12, strength: 0.5, rotation: -170 } } });
  const [s1, s2] = shapesAt([storm, other], a, 5);
  close(s1.x, 10);
  close(s1.size, 9);
  close(s1.strength, 0.75);
  close(Math.abs(s1.rotation), 180, 1e-9);
  assert.deepEqual(s2, other, 'unkeyed layers are untouched');
  assert.equal(storm.x, 0, 'the composed layers are never changed');
  assert.equal(timeInvalidation(a), 'weather');
  assert.equal(timeInvalidation(setKey(linear, 1, { sky: { sunElevation: 3 } })), 'sky');
  assert.equal(timeInvalidation(linear), 'clouds');
});

test('setting a key near an existing one merges into it; keys can be removed', () => {
  let a = setKey({ ...DEFAULT_ANIMATION, fps: 24 }, 5, { sky: { coverage: 0.4 } });
  a = setKey(a, 5 + 0.01, { shape: { id: 's1', values: { x: 3 } } });
  assert.equal(a.keys.length, 1);
  assert.deepEqual(a.keys[0].sky, { coverage: 0.4 });
  assert.deepEqual(a.keys[0].shapes, { s1: { x: 3 } });
  a = setKey(a, 2, { sky: { haze: 50 } });
  assert.deepEqual(a.keys.map((k) => k.time), [2, 5], 'kept sorted');
  assert.deepEqual(removeKey(a, 0).keys.map((k) => k.time), [5]);
});

test('frames are numbered from the clip length and rate', () => {
  assert.equal(frameCount({ ...DEFAULT_ANIMATION, duration: 10, fps: 24 }), 240);
  close(frameTime({ ...DEFAULT_ANIMATION, fps: 24 }, 48), 2);
});

test('untrusted recipes fall back and clamp; older sun moves become a key', () => {
  assert.deepEqual(parseAnimation(undefined), DEFAULT_ANIMATION);
  const a = parseAnimation({ duration: -5, fps: 'fast', windSpeed: 1e9, ease: 'bouncy' });
  assert.equal(a.duration, 0.1);
  assert.equal(a.fps, DEFAULT_ANIMATION.fps);
  assert.equal(a.windSpeed, 400);
  assert.equal(a.ease, 'smooth');
  const legacy = parseAnimation({ duration: 8, sunEnd: { elevation: 200, azimuth: 'x' } });
  assert.deepEqual(legacy.keys, [{ time: 8, sky: { sunElevation: 90, sunAzimuth: 0 }, shapes: {} }]);
  const keys = parseAnimation({ keys: [
    { time: 0, sky: { coverage: 1 } },
    { time: 3, sky: { coverage: 0.5, ev: 4, windSpeed: 10 }, shapes: { s1: { x: 2, kind: 'front', size: 'big' } } },
  ] }).keys;
  assert.deepEqual(keys, [{ time: 3, sky: { coverage: 0.5, windSpeed: 10 }, shapes: { s1: { x: 2 } } }], 'frame-0 keys and unknown fields are dropped');
});
