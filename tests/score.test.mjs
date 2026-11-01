import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const Score = createRequire(import.meta.url)('../src/score.js');
const {
  BPM, BEATS_PER_BAR, STEPS_PER_BEAT, STEPS_PER_BAR, BEAT_SECONDS, BAR_SECONDS, INTENSITY_CYCLE_BARS,
  PROGRESSION, OSTINATO_A_UP, OSTINATO_A_DOWN, OSTINATO_B_PATTERN, TICK_STEPS,
  midiToFreq, mulberry32, stepTime, intensityAt, pickMelodyNote, planBar
} = Score;

const planOf = (bar, seed = 1) => planBar(bar, mulberry32(seed), { last: null });
const only = (events, kind) => events.filter(e => e.kind === kind);
const kinds = events => new Set(events.map(e => e.kind));
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

/* ---------------- timing ---------------- */

test('feel: brisk 3/4 at 94-96 BPM on a sixteenth-note grid', () => {
  assert.ok(BPM >= 94 && BPM <= 96);
  assert.equal(BEATS_PER_BAR, 3);
  assert.equal(STEPS_PER_BEAT, 4);
  assert.equal(STEPS_PER_BAR, 12);
  assert.ok(Math.abs(BAR_SECONDS - 3 * BEAT_SECONDS) < 1e-12);
});

test('stepTime: straight time, four steps per beat, a bar is exactly three beats', () => {
  assert.equal(stepTime(0), 0);
  assert.ok(Math.abs(stepTime(4) - BEAT_SECONDS) < 1e-12);
  assert.ok(Math.abs(stepTime(STEPS_PER_BAR) - BAR_SECONDS) < 1e-12);
  let previous = -1;
  for (let step = 0; step < STEPS_PER_BAR; step++) {
    const t = stepTime(step);
    assert.ok(t > previous && t < BAR_SECONDS);
    previous = t;
  }
});

/* ---------------- pure helpers ---------------- */

test('midiToFreq: A4 is 440 Hz and octaves double', () => {
  assert.equal(midiToFreq(69), 440);
  assert.ok(Math.abs(midiToFreq(57) - 220) < 1e-9);
  assert.ok(Math.abs(midiToFreq(81) - 880) < 1e-9);
});

test('mulberry32: deterministic, in [0, 1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('intensityAt: stays in [0.3, 1], repeats every cycle, builds to the middle then falls', () => {
  for (let bar = 0; bar < INTENSITY_CYCLE_BARS * 2; bar++) {
    const value = intensityAt(bar);
    assert.ok(value >= 0.3 && value <= 1, `bar ${bar}: ${value}`);
    assert.ok(Math.abs(value - intensityAt(bar + INTENSITY_CYCLE_BARS)) < 1e-12);
  }
  const half = INTENSITY_CYCLE_BARS / 2;
  for (let bar = 0; bar < half - 1; bar++) assert.ok(intensityAt(bar + 1) > intensityAt(bar), `rising at ${bar}`);
  for (let bar = half; bar < INTENSITY_CYCLE_BARS - 1; bar++) assert.ok(intensityAt(bar + 1) < intensityAt(bar), `falling at ${bar}`);
  assert.ok(intensityAt(half) > 0.95);
});

test('pickMelodyNote: always returns a pool member and rejects an empty pool', () => {
  const pool = [72, 76, 79, 81];
  const rng = mulberry32(7);
  for (let i = 0; i < 500; i++) assert.ok(pool.includes(pickMelodyNote(pool, i % 2 ? 70 : null, rng)));
  assert.throws(() => pickMelodyNote([], null, rng), RangeError);
});

test('pickMelodyNote: prefers small leaps over big ones', () => {
  const pool = [60, 62, 64, 72, 84];
  const rng = mulberry32(99);
  const counts = new Map(pool.map(n => [n, 0]));
  for (let i = 0; i < 5000; i++) {
    const note = pickMelodyNote(pool, 62, rng);
    counts.set(note, counts.get(note) + 1);
  }
  assert.ok(counts.get(64) > counts.get(84) * 3);
  assert.ok(counts.get(60) > counts.get(84) * 3);
});

/* ---------------- harmony ---------------- */

test('PROGRESSION: Am F C G then Am G F E, one chord per bar', () => {
  assert.deepEqual(PROGRESSION.map(c => c.name), ['Am', 'F', 'C', 'G', 'Am', 'G', 'F', 'E']);
});

test('PROGRESSION: voicings are sorted, rooted, and the arp pool really holds the chord tones', () => {
  const pitchClasses = { Am: [9, 0, 4], F: [5, 9, 0], C: [0, 4, 7], G: [7, 11, 2], E: [4, 8, 11] };
  const patternMax = Math.max(...OSTINATO_A_UP, ...OSTINATO_A_DOWN, ...OSTINATO_B_PATTERN);
  for (const chord of PROGRESSION) {
    const tones = pitchClasses[chord.name];
    assert.deepEqual([...chord.pad].sort((a, b) => a - b), chord.pad, `${chord.name} pad sorted`);
    assert.deepEqual([...chord.arp].sort((a, b) => a - b), chord.arp, `${chord.name} arp ascending`);
    assert.equal(chord.arp.length, 6);
    assert.ok(chord.arp.length > patternMax);
    assert.equal(chord.pad[0] % 12, tones[0], `${chord.name} pad starts on the root`);
    assert.ok(chord.pad.every(n => tones.includes(n % 12)), `${chord.name} pad is only chord tones`);
    assert.ok(chord.arp.every(n => tones.includes(n % 12)), `${chord.name} arp is only chord tones`);
    assert.ok(chord.melody.every(n => n >= 72 && n <= 90), `${chord.name} lead range`);
  }
});

/* ---------------- the pulse ---------------- */

test('ostinato A: six staccato notes per bar on the even steps, deterministic, up then down', () => {
  for (let bar = 0; bar < 16; bar++) {
    const chord = PROGRESSION[bar % 8];
    const a = only(planOf(bar, bar), 'ostA');
    assert.deepEqual(a.map(e => e.step), [0, 2, 4, 6, 8, 10]);
    assert.deepEqual(a, only(planOf(bar, bar + 100), 'ostA'), 'does not depend on the rng');
    const midis = a.map(e => e.midi);
    const run = bar % 8 < 4 ? OSTINATO_A_UP : OSTINATO_A_DOWN;
    assert.deepEqual(midis, run.map(i => chord.arp[i]));
    const sorted = [...midis].sort((x, y) => (bar % 8 < 4 ? x - y : y - x));
    assert.deepEqual(midis, sorted, `bar ${bar} is a monotone run`);
  }
});

test('ostinato B: fills the odd steps so A and B interlock into continuous sixteenths', () => {
  const peak = 8 * 2;                                       // a loud bar of the arc, where B is on
  const events = planOf(peak, 1);
  const a = only(events, 'ostA').map(e => e.step), b = only(events, 'ostB').map(e => e.step);
  assert.deepEqual(b, [1, 3, 5, 7, 9, 11]);
  assert.deepEqual([...a, ...b].sort((x, y) => x - y), range(0, STEPS_PER_BAR));
});

test('ostinato B phases: a 7-note cycle against 6 notes per bar realigns only every 7 bars', () => {
  const contour = bar => only(planOf(bar, 1), 'ostB').map(e => e.midi - 12 - PROGRESSION[bar % 8].arp[0]);
  const indexes = bar => only(planOf(bar, 1), 'ostB').map((e, slot) => OSTINATO_B_PATTERN[(bar * 6 + slot) % 7]);
  assert.equal(OSTINATO_B_PATTERN.length, 7);
  assert.deepEqual(indexes(14), indexes(14));
  for (const bar of [16, 17, 18, 19]) assert.notDeepEqual(indexes(bar), indexes(bar + 1), `bar ${bar} differs from the next`);
  assert.deepEqual(indexes(14), indexes(21), 'identical after 7 bars');
  assert.ok(contour(16).length === 6);
});

test('planBar: pad and bass every bar, the clock ticks every beat, steps stay in the bar', () => {
  for (let bar = 0; bar < 40; bar++) {
    const events = planOf(bar, bar);
    assert.equal(only(events, 'pad').length, 1);
    assert.equal(only(events, 'bass').length, 1);
    assert.deepEqual(only(events, 'tick').map(e => e.step), TICK_STEPS);
    assert.ok(events.every(e => e.step >= 0 && e.step < STEPS_PER_BAR));
    assert.ok(events.every(e => e.velocity > 0));
  }
});

test('planBar: deterministic for a seed, and the chord loop repeats every 8 bars', () => {
  assert.deepEqual(planOf(5, 3), planOf(5, 3));
  const padOf = bar => only(planOf(bar), 'pad')[0].notes;
  assert.deepEqual(padOf(0), padOf(8));
  assert.notDeepEqual(padOf(0), padOf(1));
});

/* ---------------- dynamics ---------------- */

test('planBar: it starts quiet (A only, no B, lead or boom) and layers in as intensity rises', () => {
  for (let seed = 0; seed < 50; seed++) {
    const opening = kinds(planOf(0, seed));
    assert.ok(opening.has('ostA'));
    assert.ok(!opening.has('ostB') && !opening.has('melody') && !opening.has('hit'));
  }
  const quiet = only(planOf(0), 'ostA')[0].velocity, loud = only(planOf(INTENSITY_CYCLE_BARS / 2), 'ostA')[0].velocity;
  assert.ok(loud > quiet * 1.4, 'the pulse swells');
});

test('planBar: gating rules hold across many bars and seeds', () => {
  let hits = 0, melodies = 0;
  for (let seed = 0; seed < 400; seed++) {
    const bar = seed % INTENSITY_CYCLE_BARS;
    const events = planOf(bar, seed);
    const intensity = intensityAt(bar);
    const chord = PROGRESSION[bar % PROGRESSION.length];
    for (const e of events) {
      if (e.kind === 'hit') { hits++; assert.ok(intensity > 0.92 && bar % 4 === 0); }
      if (e.kind === 'melody') { melodies++; assert.ok(intensity > 0.55 && bar % 2 === 0); assert.ok(chord.melody.includes(e.midi)); }
      if (e.kind === 'ostB') assert.ok(intensity > 0.4);
    }
  }
  assert.ok(hits > 0 && melodies > 0, 'the loud layers do appear somewhere');
});

/* ---------------- audio code against a fake AudioContext ---------------- */

class FakeParam {
  constructor() { this.value = 0; }
  setValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
}

class FakeNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.started = false;
    this.stopped = false;
    for (const name of ['gain', 'frequency', 'detune', 'Q', 'delayTime', 'threshold', 'knee', 'ratio', 'attack', 'release', 'pan']) {
      this[name] = new FakeParam();
    }
    ctx.nodes.push(this);
  }
  connect(target) { return target; }
  disconnect() {}
  setPeriodicWave() {}
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

class FakeContext {
  constructor() { this.nodes = []; this.sampleRate = 8000; this.currentTime = 0; this.destination = new FakeNode(this); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  createPeriodicWave() { return {}; }
}
for (const factory of ['createGain', 'createOscillator', 'createBiquadFilter', 'createDynamicsCompressor', 'createConvolver', 'createDelay', 'createBufferSource', 'createStereoPanner']) {
  FakeContext.prototype[factory] = function () { return new FakeNode(this); };
}

test('audio: scheduling two full swell cycles never throws and every voice is stopped (no node leaks)', () => {
  const rng = mulberry32(2026);
  const ctx = new FakeContext();
  const graph = Score.buildGraph(ctx, rng);
  const infrastructure = new Set(ctx.nodes);              // LFOs + wind live until the context closes

  Score.createScheduler(graph, rng, 0).advanceTo(BAR_SECONDS * INTENSITY_CYCLE_BARS * 2);

  const voices = ctx.nodes.filter(node => !infrastructure.has(node) && node.started);
  // 64 bars x (10 pad + 2 bass + 3 ticks + 6 ostinato A) alone is 1344, plus B, lead and hits
  assert.ok(voices.length > 1200, `expected many voices, got ${voices.length}`);
  assert.ok(voices.every(node => node.stopped), 'a started voice was never stopped');
});

test('audio: the scheduler only schedules what falls before the limit, and is idempotent', () => {
  const rng = mulberry32(1);
  const ctx = new FakeContext();
  const graph = Score.buildGraph(ctx, rng);
  const baseline = ctx.nodes.length;
  const scheduler = Score.createScheduler(graph, rng, 0);
  scheduler.advanceTo(-1);
  assert.equal(ctx.nodes.length, baseline);
  scheduler.advanceTo(0.001);                              // just step 0: pad, bass, tick, first ostinato note
  const afterFirstStep = ctx.nodes.length;
  assert.ok(afterFirstStep > baseline);
  scheduler.advanceTo(0.001);
  assert.equal(ctx.nodes.length, afterFirstStep);
});

test('player: reports unsupported (not a crash) when there is no AudioContext', async () => {
  const player = Score.createPlayer();
  assert.equal(player.supported, false);
  assert.equal(await player.start(), false);
  assert.equal(await player.toggle(), false);
  assert.equal(player.playing, false);
  assert.equal(Score.isSupported(), false);
});
