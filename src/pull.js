/*!
 * Pull-to-untangle gesture maths.
 *
 * Pure functions, so the feel of the gesture can be unit-tested. UMD-lite: the build inlines
 * this file into dist/index.html; tests load it under Node.
 *
 * Why it looks like this: the handle sits near the bottom of the page, so on a phone there is
 * often less than ~100px of screen below the finger. The gesture therefore
 *   - counts movement in ANY direction (pull up or sideways when there is no room below),
 *   - needs a short throw that scales with the viewport height, and
 *   - lets a quick flick finish the job.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Pull = api;
})(globalThis, function () {
  'use strict';

  const THROW_VIEWPORT_RATIO = 0.16;   // pull distance as a share of the viewport height...
  const MIN_THROW_PX = 80;             // ...but never shorter than this
  const MAX_THROW_PX = 130;            // ...or longer than this
  const COMPLETE_AT = 0.7;             // release past 70% finishes the untangle
  const TAP_PX = 6;                    // movement under this is a tap, which also finishes it
  const FLICK_MIN_PX = 36;             // a flick needs at least this much travel...
  const FLICK_PX_PER_MS = 0.3;         // ...at this average speed (a 55px swipe within ~180ms)
  const VISUAL_PULL_RATIO = 0.3;       // the thread's end follows the finger at 30%
  const VISUAL_PULL_MAX_PX = 48;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

  /** Distance (px) that counts as a full pull for a viewport of the given height. */
  function pullDistance(viewportHeight) {
    return clamp(finiteOr(viewportHeight, 0) * THROW_VIEWPORT_RATIO, MIN_THROW_PX, MAX_THROW_PX);
  }

  /**
   * Turn a finger offset from where the drag started into gesture state:
   *   distance: straight-line travel in any direction
   *   progress: 0..1 share of a full pull
   *   offset:   signed vertical px the thread's end should visually follow (up is negative)
   */
  function pullProgress(dx, dy, viewportHeight) {
    const safeDx = finiteOr(dx, 0), safeDy = finiteOr(dy, 0);
    const distance = Math.hypot(safeDx, safeDy);
    return {
      distance,
      progress: clamp(distance / pullDistance(viewportHeight), 0, 1),
      offset: clamp(safeDy * VISUAL_PULL_RATIO, -VISUAL_PULL_MAX_PX, VISUAL_PULL_MAX_PX)
    };
  }

  /**
   * What to do when the finger lifts: finish ('complete') or snap back ('spring').
   * A tap, a pull past the threshold, or a quick flick all finish it.
   */
  function releaseAction({ moved, progress, elapsedMs }) {
    const travel = finiteOr(moved, 0);
    const speed = travel / Math.max(1, finiteOr(elapsedMs, 1));
    const isTap = travel < TAP_PX;
    const isFlick = travel >= FLICK_MIN_PX && speed > FLICK_PX_PER_MS;
    return isTap || finiteOr(progress, 0) >= COMPLETE_AT || isFlick ? 'complete' : 'spring';
  }

  return { pullDistance, pullProgress, releaseAction, COMPLETE_AT, TAP_PX, MIN_THROW_PX, MAX_THROW_PX };
});
