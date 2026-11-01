import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const Lofi = createRequire(import.meta.url)('../src/lofi.js');
const { midiToFreq, mulberry32, stepTime, pickMelodyNote, planBar, PROGRESSION, STEPS_PER_BAR } = Lofi;

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

test('stepTime: on-beats are straight, off-beats are pushed late by swing, order is monotonic', () => {
  const beat = 60 / 72;
  assert.equal(stepTime(0, 72, 0.6), 0);
  assert.ok(Math.abs(stepTime(2, 72, 0.6) - beat) < 1e-12);
  assert.ok(Math.abs(stepTime(1, 72, 0.5) - beat / 2) < 1e-12);       // straight
  assert.ok(stepTime(1, 72, 0.6) > stepTime(1, 72, 0.5));             // swung later
  let previous = -1;
  for (let step = 0; step < STEPS_PER_BAR; step++) {
    const t = stepTime(step);
    assert.ok(t > previous);
    assert.ok(t < beat * 4);
    previous = t;
  }
});

test('pickMelodyNote: always returns a pool member and rejects an empty pool', () => {
  const pool = [72, 76, 79, 81];
  const rng = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    assert.ok(pool.includes(pickMelodyNote(pool, i % 2 ? 70 : null, rng)));
  }
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

test('PROGRESSION: well-formed voicings, bass below the chord, melody in a singing range', () => {
  assert.equal(PROGRESSION.length, 8);
  for (const chord of PROGRESSION) {
    assert.ok(chord.notes.length >= 4);
    assert.deepEqual([...chord.notes].sort((a, b) => a - b), chord.notes, `${chord.name} voicing sorted`);
    assert.ok(chord.bass < Math.min(...chord.notes), `${chord.name} bass below keys`);
    assert.ok(chord.melody.every(n => n >= 70 && n <= 86), `${chord.name} melody range`);
  }
});

test('planBar: deterministic for a seed, and loops every 8 bars', () => {
  const plan = seed => planBar(3, mulberry32(seed), { last: null });
  assert.deepEqual(plan(5), plan(5));
  const chordAt = bar => planBar(bar, mulberry32(1)).find(e => e.kind === 'chord' && e.step === 0).notes;
  assert.deepEqual(chordAt(0), chordAt(8));
  assert.notDeepEqual(chordAt(0), chordAt(1));
});

test('planBar: the groove is always there (kick on 1, snares on 2 and 4, bass root)', () => {
  for (let seed = 0; seed < 200; seed++) {
    const events = planBar(seed, mulberry32(seed));
    const has = (kind, step) => events.some(e => e.kind === kind && e.step === step);
    assert.ok(has('kick', 0));
    assert.ok(has('snare', 2) && has('snare', 6));
    assert.ok(has('chord', 0) && has('bass', 0));
    assert.ok(events.every(e => e.step >= 0 && e.step < STEPS_PER_BAR));
  }
});

test('planBar: melody is sparse, in-key for the chord, and velocities are sane', () => {
  let barsWithMelody = 0;
  for (let seed = 0; seed < 400; seed++) {
    const barIndex = seed % PROGRESSION.length;
    const melody = planBar(barIndex, mulberry32(seed)).filter(e => e.kind === 'melody');
    assert.ok(melody.length <= 3);
    if (melody.length) barsWithMelody++;
    for (const note of melody) {
      assert.ok(PROGRESSION[barIndex].melody.includes(note.midi));
      assert.ok(note.velocity > 0 && note.velocity <= 1);
    }
  }
  const ratio = barsWithMelody / 400;
  assert.ok(ratio > 0.45 && ratio < 0.75, `melody ratio ${ratio}`);
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
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

class FakeContext {
  constructor() { this.nodes = []; this.sampleRate = 8000; this.currentTime = 0; this.destination = new FakeNode(this); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
}
for (const factory of ['createGain', 'createOscillator', 'createBiquadFilter', 'createDynamicsCompressor', 'createConvolver', 'createDelay', 'createBufferSource']) {
  FakeContext.prototype[factory] = function () { return new FakeNode(this); };
}

test('audio: scheduling 16 bars never throws and every voice is stopped (no node leaks)', () => {
  const rng = mulberry32(2026);
  const ctx = new FakeContext();
  const graph = Lofi.buildGraph(ctx, rng);
  const infrastructure = new Set(ctx.nodes);              // LFOs + crackle live until the context closes

  Lofi.createScheduler(graph, rng, 0).advanceTo(Lofi.BAR_SECONDS * 16);

  const voices = ctx.nodes.filter(node => !infrastructure.has(node) && node.started);
  assert.ok(voices.length > 500, `expected many voices, got ${voices.length}`);
  assert.ok(voices.every(node => node.stopped), 'a started voice was never stopped');
});

test('audio: the scheduler only schedules what falls before the limit', () => {
  const rng = mulberry32(1);
  const ctx = new FakeContext();
  const graph = Lofi.buildGraph(ctx, rng);
  const baseline = ctx.nodes.length;
  const scheduler = Lofi.createScheduler(graph, rng, 0);
  scheduler.advanceTo(-1);
  assert.equal(ctx.nodes.length, baseline);
  scheduler.advanceTo(0.001);                              // just step 0
  const afterFirstStep = ctx.nodes.length;
  assert.ok(afterFirstStep > baseline);
  scheduler.advanceTo(0.001);                              // idempotent
  assert.equal(ctx.nodes.length, afterFirstStep);
});

test('player: reports unsupported (not a crash) when there is no AudioContext', async () => {
  const player = Lofi.createPlayer();
  assert.equal(player.supported, false);
  assert.equal(await player.start(), false);
  assert.equal(await player.toggle(), false);
  assert.equal(player.playing, false);
  assert.equal(Lofi.isSupported(), false);
});
