// Animation time model (src/animation.ts): frame 0 is the composed sky, motion follows the
// recipe, and untrusted recipes are clamped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ANIMATION, frameCount, frameTime, parseAnimation, settingsAt } from '../src/animation.ts';
import { DEFAULTS } from '../src/settings.ts';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('frame 0 is exactly the sky as composed', () => {
  assert.deepEqual(settingsAt(DEFAULTS, DEFAULT_ANIMATION, 0), DEFAULTS);
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

test('clouds turn over once per cloud life', () => {
  const a = { ...DEFAULT_ANIMATION, timeLapse: 60, cloudLife: 30 };
  // 30 s at 60x = 30 scene minutes = one cloud life = one shape period of scroll.
  close(settingsAt(DEFAULTS, a, 30).evolve, DEFAULTS.shapeScale, 1e-9);
});

test('the sun takes the short way round and lands on its end values', () => {
  const base = { ...DEFAULTS, sunElevation: 20, sunAzimuth: 170 };
  const a = { ...DEFAULT_ANIMATION, duration: 10, sunEnd: { elevation: 0, azimuth: -170 } };
  const mid = settingsAt(base, a, 5);
  close(mid.sunElevation, 10);
  close(Math.abs(mid.sunAzimuth), 180, 1e-9); // through 180, not through 0
  const end = settingsAt(base, a, 10);
  close(end.sunElevation, 0);
  close(end.sunAzimuth, -170, 1e-9);
  // Past the end the sun stays put.
  close(settingsAt(base, a, 20).sunElevation, 0);
});

test('frames are numbered from the clip length and rate', () => {
  assert.equal(frameCount({ ...DEFAULT_ANIMATION, duration: 10, fps: 24 }), 240);
  close(frameTime({ ...DEFAULT_ANIMATION, fps: 24 }, 48), 2);
});

test('untrusted recipes fall back and clamp', () => {
  assert.deepEqual(parseAnimation(undefined), DEFAULT_ANIMATION);
  const a = parseAnimation({ duration: -5, fps: 'fast', windSpeed: 1e9, sunEnd: { elevation: 200, azimuth: 'x' } });
  assert.equal(a.duration, 0.1);
  assert.equal(a.fps, DEFAULT_ANIMATION.fps);
  assert.equal(a.windSpeed, 400);
  assert.deepEqual(a.sunEnd, { elevation: 90, azimuth: 0 });
});
