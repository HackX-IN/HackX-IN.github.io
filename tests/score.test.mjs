import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const Score = createRequire(import.meta.url)('../src/score.js');
const {
  midiToFreq, mulberry32, stepTime, intensityAt, pickMelodyNote, planBar,
  PROGRESSION, ARP_PATTERNS, TICK_STEPS, STEPS_PER_BAR, BARS_PER_CHORD, INTENSITY_CYCLE_BARS, BAR_SECONDS, PULSE_SECONDS
} = Score;

const planOf = (bar, seed = 1) => planBar(bar, mulberry32(seed), { last: null });
const kinds = events => new Set(events.map(e => e.kind));

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

test('stepTime: straight time, three steps per pulse, a bar is exactly four pulses', () => {
  assert.equal(stepTime(0), 0);
  assert.ok(Math.abs(stepTime(3) - PULSE_SECONDS) < 1e-12);
  assert.ok(Math.abs(stepTime(STEPS_PER_BAR) - BAR_SECONDS) < 1e-12);
  let previous = -1;
  for (let step = 0; step < STEPS_PER_BAR; step++) {
    const t = stepTime(step);
    assert.ok(t > previous);
    assert.ok(t < BAR_SECONDS);
    previous = t;
  }
});

test('intensityAt: stays in [0.3, 1], repeats every cycle, builds to the middle then falls', () => {
  for (let bar = 0; bar < INTENSITY_CYCLE_BARS * 3; bar++) {
    const value = intensityAt(bar);
    assert.ok(value >= 0.3 && value <= 1, `bar ${bar}: ${value}`);
    assert.ok(Math.abs(value - intensityAt(bar + INTENSITY_CYCLE_BARS)) < 1e-12);
  }
  const half = INTENSITY_CYCLE_BARS / 2;
  for (let bar = 0; bar < half - 1; bar++) assert.ok(intensityAt(bar + 1) > intensityAt(bar), `rising at ${bar}`);
  for (let bar = half; bar < INTENSITY_CYCLE_BARS - 1; bar++) assert.ok(intensityAt(bar + 1) < intensityAt(bar), `falling at ${bar}`);
  assert.ok(intensityAt(half - 1) > 0.95 || intensityAt(half) > 0.95);
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

/* ---------------- song data ---------------- */

test('PROGRESSION: four chords with sorted open voicings, ascending arp pools, sane ranges', () => {
  assert.equal(PROGRESSION.length, 4);
  const maxIndex = Math.max(...ARP_PATTERNS.flat());
  for (const chord of PROGRESSION) {
    assert.deepEqual([...chord.pad].sort((a, b) => a - b), chord.pad, `${chord.name} pad sorted`);
    assert.deepEqual([...chord.arp].sort((a, b) => a - b), chord.arp, `${chord.name} arp ascending`);
    assert.ok(chord.arp.length > maxIndex, `${chord.name} arp pool covers the pattern`);
    assert.ok(chord.pad[0] >= 36 && chord.pad[0] <= 48, `${chord.name} root is low`);
    assert.ok(chord.pad[0] < chord.arp[0], `${chord.name} arp sits above the root`);
    assert.ok(chord.melody.every(n => n >= 70 && n <= 90), `${chord.name} melody range`);
  }
  for (const pattern of ARP_PATTERNS) assert.equal(pattern.length, STEPS_PER_BAR);
});

/* ---------------- planning ---------------- */

test('planBar: deterministic for a seed; the chord loop repeats every 8 bars', () => {
  assert.deepEqual(planOf(5, 3), planOf(5, 3));
  const padOf = bar => planOf(bar).find(e => e.kind === 'pad').notes;
  assert.deepEqual(padOf(0), padOf(8));
  assert.notDeepEqual(padOf(0), padOf(2));
  assert.throws(() => padOf(1), TypeError);           // bar 1 is the second bar of chord 0: no new pad
});

test('planBar: foundation lands once per chord, the clock ticks every pulse, steps stay in the bar', () => {
  for (let bar = 0; bar < 32; bar++) {
    const events = planOf(bar, bar);
    const firstBarOfChord = bar % BARS_PER_CHORD === 0;
    assert.equal(events.some(e => e.kind === 'pad'), firstBarOfChord);
    assert.equal(events.some(e => e.kind === 'drone'), firstBarOfChord);
    const tickSteps = events.filter(e => e.kind === 'tick').map(e => e.step);
    assert.deepEqual(tickSteps, TICK_STEPS);
    assert.ok(events.every(e => e.step >= 0 && e.step < STEPS_PER_BAR));
    assert.ok(events.every(e => e.velocity > 0));
  }
});

test('planBar: it starts quiet (no arpeggio, melody or boom) and layers in as intensity rises', () => {
  for (let seed = 0; seed < 50; seed++) {
    const opening = kinds(planOf(0, seed));
    assert.ok(!opening.has('arp') && !opening.has('melody') && !opening.has('hit'));
    assert.ok(planOf(INTENSITY_CYCLE_BARS / 2, seed).some(e => e.kind === 'arp'));
  }
});

test('planBar: gating rules hold across many bars and seeds', () => {
  let hits = 0, melodies = 0;
  for (let seed = 0; seed < 300; seed++) {
    const bar = seed % 32;
    const events = planOf(bar, seed);
    const intensity = intensityAt(bar);
    const chord = PROGRESSION[Math.floor(bar / BARS_PER_CHORD) % PROGRESSION.length];
    const lifted = bar % INTENSITY_CYCLE_BARS >= INTENSITY_CYCLE_BARS / 2;
    for (const e of events) {
      if (e.kind === 'hit') { hits++; assert.ok(intensity > 0.9); }
      if (e.kind === 'melody') { melodies++; assert.ok(intensity > 0.6); assert.ok(chord.melody.includes(e.midi)); }
      if (e.kind === 'arp') assert.ok(chord.arp.map(n => n + (lifted ? 12 : 0)).includes(e.midi), `arp note ${e.midi}`);
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
    for (const name of ['gain', 'frequency', 'detune', 'Q', 'delayTime', 'threshold', 'knee', 'ratio', 'attack', 'release']) {
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
for (const factory of ['createGain', 'createOscillator', 'createBiquadFilter', 'createDynamicsCompressor', 'createConvolver', 'createDelay', 'createBufferSource']) {
  FakeContext.prototype[factory] = function () { return new FakeNode(this); };
}

test('audio: scheduling two full swell cycles never throws and every voice is stopped (no node leaks)', () => {
  const rng = mulberry32(2026);
  const ctx = new FakeContext();
  const graph = Score.buildGraph(ctx, rng);
  const infrastructure = new Set(ctx.nodes);              // LFOs + wind live until the context closes

  Score.createScheduler(graph, rng, 0).advanceTo(BAR_SECONDS * INTENSITY_CYCLE_BARS * 2);

  const voices = ctx.nodes.filter(node => !infrastructure.has(node) && node.started);
  assert.ok(voices.length > 500, `expected many voices, got ${voices.length}`);
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
  scheduler.advanceTo(0.001);                              // just step 0: drone, pad, tick
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
