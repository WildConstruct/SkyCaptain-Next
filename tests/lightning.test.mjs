// Lightning (src/lightning.ts): the strike clock ported from Ethera, and the channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_POINTS, DEFAULT_SHAPE, DEFAULT_TIMING, channel, strikeDuration, strikeState, strokeTimes } from '../src/lightning.ts';

const timing = (o = {}) => ({ ...DEFAULT_TIMING, ...o });

test('a strike is dark before it starts and grows from nothing', () => {
  const p = timing({ strikeAt: 1 });
  assert.equal(strikeState(p, 0.5).active, false);
  assert.equal(strikeState(p, 1).growth, 0);
  const mid = strikeState(p, 1 + p.growTime / 2);
  assert.ok(mid.growth > 0 && mid.growth < 1);
  assert.equal(strikeState(p, 1 + p.growTime).growth, 1);
});

test('return strokes relight the channel, each weaker than the last', () => {
  const p = timing({ restrikes: 2, flicker: 0, growTime: 0.1, fade: 0.3, restrikeGap: 0.5 });
  const [, t1, t2] = strokeTimes(p);
  const peak = (k) => strikeState(p, p.growTime + k + 1e-4).brightness;
  assert.ok(peak(0) > 0.99);
  assert.ok(peak(t1) < peak(0) && peak(t1) > 0.6);
  assert.ok(peak(t2) < peak(t1) && peak(t2) > 0.4);
  assert.ok(strikeState(p, p.growTime + t1 - 0.01).brightness < 0.1, 'faded between strokes');
});

test('the strike ends dark', () => {
  const p = timing();
  const s = strikeState(p, strikeDuration(p) + 0.01);
  assert.equal(s.active, false);
  assert.equal(s.brightness, 0);
});

test('the same time gives the same strike however it is reached', () => {
  const p = timing({ seed: 7 });
  assert.deepEqual(strikeState(p, 0.37), strikeState(p, 0.37));
});

test('the channel runs from start to end, pinned at both ends, and wanders between', () => {
  const start = [0, 1.5, 0], end = [0.4, 0, 0.2];
  const [main] = channel(start, end, 3, DEFAULT_SHAPE, 1);
  assert.equal(main.points.length, CHANNEL_POINTS + 1);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  assert.ok(d(main.points[0], start) < 1e-9);
  assert.ok(d(main.points.at(-1), end) < 1e-9);
  const mid = main.points[CHANNEL_POINTS / 2];
  const straight = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
  assert.ok(d(mid, straight) > 0.005, 'the middle wanders off the straight line');
});

test('growth: a half-grown leader stops halfway and has fewer branches', () => {
  const start = [0, 1.5, 0], end = [0, 0, 0];
  const half = channel(start, end, 3, DEFAULT_SHAPE, 0.5);
  const full = channel(start, end, 3, DEFAULT_SHAPE, 1);
  assert.ok(half[0].points.at(-1)[1] > 0.5, 'the tip is still up in the air');
  assert.ok(half.length <= full.length);
  assert.ok(full.length > 1, 'a grown bolt has branches');
  assert.equal(channel(start, end, 3, DEFAULT_SHAPE, 0).length, 0);
});

test('a different seed is a different path', () => {
  const a = channel([0, 1.5, 0], [0, 0, 0], 1, DEFAULT_SHAPE, 1)[0].points[20];
  const b = channel([0, 1.5, 0], [0, 0, 0], 2, DEFAULT_SHAPE, 1)[0].points[20];
  assert.notDeepEqual(a, b);
});
