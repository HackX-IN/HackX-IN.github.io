import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const Pull = createRequire(import.meta.url)('../src/pull.js');
const { pullDistance, pullProgress, releaseAction, COMPLETE_AT, TAP_PX, MIN_THROW_PX, MAX_THROW_PX } = Pull;

/* The handle sits ~100px above the bottom of a phone screen once the page is scrolled to the end
   (measured: 103px on a 390x664 viewport, 132px on 360x640). Every phone must be able to finish
   the gesture inside that room. */
const WORST_REAL_ROOM_PX = 100;
const PHONE_HEIGHTS = [568, 640, 664, 740, 800, 844, 932];

test('pullDistance: scales with the viewport but stays within the min and max throw', () => {
  assert.equal(pullDistance(0), MIN_THROW_PX);
  assert.equal(pullDistance(100), MIN_THROW_PX);
  assert.equal(pullDistance(5000), MAX_THROW_PX);
  assert.ok(pullDistance(700) > pullDistance(600));
  for (const height of [300, 568, 844, 1200]) {
    const distance = pullDistance(height);
    assert.ok(distance >= MIN_THROW_PX && distance <= MAX_THROW_PX);
  }
});

test('pullDistance: bad input falls back safely instead of returning NaN', () => {
  for (const bad of [NaN, undefined, null, Infinity, -50]) {
    const distance = pullDistance(bad);
    assert.ok(Number.isFinite(distance) && distance >= MIN_THROW_PX && distance <= MAX_THROW_PX, String(bad));
  }
});

test('regression: on every phone height, finishing needs less travel than the room below the handle', () => {
  for (const height of PHONE_HEIGHTS) {
    const needed = pullDistance(height) * COMPLETE_AT;
    assert.ok(needed < WORST_REAL_ROOM_PX, `${height}px tall needs ${needed.toFixed(0)}px`);
  }
});

test('pullProgress: any direction counts equally (up, down, sideways)', () => {
  const down = pullProgress(0, 80, 800), up = pullProgress(0, -80, 800);
  const side = pullProgress(80, 0, 800), diagonal = pullProgress(-48, 64, 800);
  assert.equal(down.progress, up.progress);
  assert.equal(down.progress, side.progress);
  assert.ok(Math.abs(diagonal.distance - 80) < 1e-9, 'diagonal uses straight-line distance');
  assert.ok(down.progress > 0 && down.progress < 1);
});

test('pullProgress: progress is clamped to 0..1 and the visual offset is signed and capped', () => {
  assert.equal(pullProgress(0, 0, 800).progress, 0);
  assert.equal(pullProgress(0, 5000, 800).progress, 1);
  assert.equal(pullProgress(0, 100, 800).offset, 30);
  assert.equal(pullProgress(0, -100, 800).offset, -30);
  assert.equal(pullProgress(0, 5000, 800).offset, 48);
  assert.equal(pullProgress(0, -5000, 800).offset, -48);
  assert.equal(pullProgress(300, 0, 800).offset, 0, 'a sideways pull does not move the end vertically');
});

test('pullProgress: non-finite pointer values never poison the state', () => {
  const result = pullProgress(NaN, undefined, 800);
  assert.equal(result.distance, 0);
  assert.equal(result.progress, 0);
  assert.equal(result.offset, 0);
});

test('releaseAction: a tap finishes it', () => {
  assert.equal(releaseAction({ moved: 0, progress: 0, elapsedMs: 80 }), 'complete');
  assert.equal(releaseAction({ moved: TAP_PX - 1, progress: 0.05, elapsedMs: 300 }), 'complete');
});

test('releaseAction: a pull past the threshold finishes, a slow short pull springs back', () => {
  assert.equal(releaseAction({ moved: 90, progress: COMPLETE_AT, elapsedMs: 2000 }), 'complete');
  assert.equal(releaseAction({ moved: 90, progress: COMPLETE_AT - 0.01, elapsedMs: 2000 }), 'spring');
  assert.equal(releaseAction({ moved: 30, progress: 0.3, elapsedMs: 900 }), 'spring');
});

test('releaseAction: a quick flick finishes it, a slow drag of the same length does not', () => {
  assert.equal(releaseAction({ moved: 50, progress: 0.45, elapsedMs: 80 }), 'complete');
  assert.equal(releaseAction({ moved: 50, progress: 0.45, elapsedMs: 600 }), 'spring');
  assert.equal(releaseAction({ moved: 20, progress: 0.2, elapsedMs: 10 }), 'spring', 'too little travel to be a flick');
  // Regression: a 55px swipe that took ~150ms (measured under CPU jitter) must still count as a flick.
  assert.equal(releaseAction({ moved: 55, progress: 0.52, elapsedMs: 150 }), 'complete');
  assert.equal(releaseAction({ moved: 55, progress: 0.52, elapsedMs: 400 }), 'spring', 'a deliberate drag is not a flick');
});

test('releaseAction: zero or missing elapsed time cannot divide by zero', () => {
  assert.equal(releaseAction({ moved: 50, progress: 0.4, elapsedMs: 0 }), 'complete');
  assert.equal(releaseAction({ moved: 20, progress: 0.2, elapsedMs: NaN }), 'spring');
  assert.equal(releaseAction({}), 'complete');           // nothing moved: treated as a tap
});
