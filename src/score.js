/*!
 * Generative space score.
 *
 * An original, endlessly evolving piece in the spirit of driving cinematic organ music:
 * a brisk 3/4 pulse, a cyclical minor loop, two interlocking staccato sixteenth-note
 * ostinatos that slowly phase against each other (minimalist style), a warm organ pad,
 * a soft clock tick and a rare, soulful lead. Intensity swells and recedes over ~60 s.
 * Everything is synthesised live with the Web Audio API: no samples, no recordings,
 * no borrowed melodies, so there is nothing to license.
 *
 * UMD-lite: the pure parts (theory, planning, timing) are unit-tested under Node, the audio
 * parts run in the browser. The build inlines this file into dist/index.html.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Score = api;
})(globalThis, function () {
  'use strict';

  /* ------------------------------------------------------------------
     Constants
  ------------------------------------------------------------------ */
  const BPM = 95;                              // quarter-note beats per minute
  const STEPS_PER_BEAT = 4;                    // sixteenth-note grid
  const BEATS_PER_BAR = 3;                     // 3/4
  const STEPS_PER_BAR = STEPS_PER_BEAT * BEATS_PER_BAR;
  const BEAT_SECONDS = 60 / BPM;
  const STEP_SECONDS = BEAT_SECONDS / STEPS_PER_BEAT;
  const BAR_SECONDS = BEAT_SECONDS * BEATS_PER_BAR;
  const INTENSITY_CYCLE_BARS = 32;             // one full swell: build for 16 bars, fall for 16
  const LOOKAHEAD_MS = 40;                     // scheduler wake-up interval
  const SCHEDULE_AHEAD_SECONDS = 0.25;         // how far past "now" we schedule audio
  const DEFAULT_VOLUME = 0.7;                  // background level: present, never in the way
  const TICK_STEPS = [0, 4, 8];                // one soft tick per beat
  const OSTINATO_SLOTS_PER_BAR = STEPS_PER_BAR / 2;   // A takes the even steps, B the odd ones

  /**
   * Eight bars, one chord each, looping: Am - F - C - G, then Am - G - F - E.
   * `pad` is an open organ voicing (MIDI numbers, root first), `arp` the six ascending
   * notes the ostinatos draw from, `melody` the lead's pool.
   */
  const PROGRESSION = Object.freeze([
    { name: 'Am', pad: [45, 52, 57, 60, 64], arp: [57, 60, 64, 69, 72, 76], melody: [72, 76, 79, 81] },
    { name: 'F',  pad: [41, 48, 53, 57, 60], arp: [57, 60, 65, 69, 72, 77], melody: [72, 76, 77, 81] },
    { name: 'C',  pad: [48, 55, 60, 64, 67], arp: [60, 64, 67, 72, 76, 79], melody: [72, 74, 76, 79] },
    { name: 'G',  pad: [43, 50, 55, 59, 62], arp: [59, 62, 67, 71, 74, 79], melody: [74, 76, 79, 83] },
    { name: 'Am', pad: [45, 52, 57, 60, 64], arp: [57, 60, 64, 69, 72, 76], melody: [72, 76, 79, 81] },
    { name: 'G',  pad: [43, 50, 55, 59, 62], arp: [59, 62, 67, 71, 74, 79], melody: [74, 76, 79, 83] },
    { name: 'F',  pad: [41, 48, 53, 57, 60], arp: [57, 60, 65, 69, 72, 77], melody: [72, 76, 77, 81] },
    { name: 'E',  pad: [40, 47, 52, 56, 59], arp: [59, 64, 68, 71, 76, 80], melody: [76, 80, 83, 74] }
  ]);

  /** Ostinato A climbs the arp pool in the first half of the loop and falls in the second. */
  const OSTINATO_A_UP = Object.freeze([0, 1, 2, 3, 4, 5]);
  const OSTINATO_A_DOWN = Object.freeze([5, 4, 3, 2, 1, 0]);
  /**
   * Ostinato B repeats every 7 notes but plays 6 per bar, so against the bar it drifts one
   * note every bar and only realigns after 7 bars: slow minimalist phasing, never a hard repeat.
   */
  const OSTINATO_B_PATTERN = Object.freeze([0, 2, 1, 3, 2, 4, 3]);

  /* ------------------------------------------------------------------
     Pure helpers (unit-tested)
  ------------------------------------------------------------------ */

  /** Frequency in Hz for a MIDI note number (A4 = 69 = 440 Hz). */
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** Small, fast, seedable PRNG so tests (and offline renders) are reproducible. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp01 = x => Math.min(1, Math.max(0, x));

  /** Seconds from the start of a bar to a given sixteenth-note step (straight time). */
  function stepTime(step, bpm = BPM) {
    return step * (60 / bpm / STEPS_PER_BEAT);
  }

  /**
   * How "full" the music is at a bar, from 0.3 (sparse) to 1 (climax), as a smooth arc that
   * repeats every INTENSITY_CYCLE_BARS. Layers fade in as it rises and drop out as it falls.
   */
  function intensityAt(barIndex) {
    const phase = ((barIndex % INTENSITY_CYCLE_BARS) + 0.5) / INTENSITY_CYCLE_BARS;
    return 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * phase), 2);
  }

  /**
   * Pick the next melody note from a pool, preferring small leaps from the previous note
   * (singable lines) and gently discouraging an exact repeat.
   */
  function pickMelodyNote(pool, previousNote, rng) {
    if (!Array.isArray(pool) || pool.length === 0) throw new RangeError('melody pool must not be empty');
    if (previousNote == null) return pool[Math.floor(rng() * pool.length)];
    const weights = pool.map(note => {
      const distance = Math.abs(note - previousNote);
      return distance === 0 ? 0.4 : 1 / (1 + distance / 2);
    });
    let roll = rng() * weights.reduce((sum, w) => sum + w, 0);
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /**
   * Decide what happens in one bar. Returns plain event objects, no audio involved:
   * { kind: 'pad' | 'bass' | 'tick' | 'ostA' | 'ostB' | 'melody' | 'hit', step, ... }
   * Only the lead and the big hit use the rng; the ostinatos are fully deterministic so the
   * pulse is relentless. `melodyState` carries the last lead note across bars.
   */
  function planBar(barIndex, rng, melodyState = { last: null }) {
    const chord = PROGRESSION[barIndex % PROGRESSION.length];
    const fallingHalf = barIndex % PROGRESSION.length >= PROGRESSION.length / 2;
    const intensity = intensityAt(barIndex);
    const events = [];
    const add = (kind, step, extra) => events.push(Object.assign({ kind, step }, extra));

    // Foundation: organ chord and bass, one per bar.
    add('pad', 0, { notes: chord.pad, velocity: 0.45 + 0.55 * intensity, bars: 1 });
    add('bass', 0, { midi: chord.pad[0], velocity: 0.6 + 0.4 * intensity, bars: 1 });

    // The clock: one soft tick per beat.
    for (const step of TICK_STEPS) add('tick', step, { velocity: 0.45 + 0.3 * intensity });

    // Ostinato A (even steps): always on, a scale-like run up or down the chord's arp pool.
    const levelA = 0.4 + 0.6 * intensity;
    const runA = fallingHalf ? OSTINATO_A_DOWN : OSTINATO_A_UP;
    for (let slot = 0; slot < OSTINATO_SLOTS_PER_BAR; slot++) {
      add('ostA', slot * 2, { midi: chord.arp[runA[slot]], velocity: levelA * (slot % 3 === 0 ? 1 : 0.62) });
    }

    // Ostinato B (odd steps): joins as the music builds, an octave up, drifting out of phase.
    const levelB = clamp01((intensity - 0.4) / 0.35);
    if (levelB > 0.05) {
      for (let slot = 0; slot < OSTINATO_SLOTS_PER_BAR; slot++) {
        const patternIndex = OSTINATO_B_PATTERN[(barIndex * OSTINATO_SLOTS_PER_BAR + slot) % OSTINATO_B_PATTERN.length];
        add('ostB', slot * 2 + 1, { midi: chord.arp[patternIndex] + 12, velocity: levelB * (slot % 3 === 0 ? 0.9 : 0.58) });
      }
    }

    // Lead: long, soulful notes every other bar near the peak.
    if (intensity > 0.55 && barIndex % 2 === 0 && rng() < 0.7) {
      const steps = rng() < 0.35 ? [0, 8] : [0];
      for (const step of steps) {
        const midi = pickMelodyNote(chord.melody, melodyState.last, rng);
        melodyState.last = midi;
        add('melody', step, { midi, velocity: 0.45 + 0.35 * intensity, bars: 1.3 });
      }
    }

    // A deep boom on the biggest downbeats.
    if (intensity > 0.92 && barIndex % 4 === 0 && rng() < 0.8) add('hit', 0, { velocity: 0.6 + 0.4 * intensity });

    return events;
  }

  /* ------------------------------------------------------------------
     Audio graph (browser / OfflineAudioContext)
  ------------------------------------------------------------------ */

  /** Dark stereo room tail from filtered noise. */
  function makeImpulse(ctx, seconds, rng) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let smoothed = 0;
      for (let i = 0; i < length; i++) {
        smoothed += ((rng() * 2 - 1) - smoothed) * 0.22;        // one-pole lowpass darkens the tail
        data[i] = smoothed * Math.pow(1 - i / length, 2.6);
      }
    }
    return buffer;
  }

  function makeNoise(ctx, seconds, rng) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = rng() * 2 - 1;
    return buffer;
  }

  /** A single-oscillator waveform from harmonic amplitudes (index 0 = fundamental). */
  function makeWave(ctx, harmonics) {
    const real = new Float32Array(harmonics.length + 1);
    const imag = new Float32Array(harmonics.length + 1);
    harmonics.forEach((amplitude, i) => { imag[i + 1] = amplitude; });
    return ctx.createPeriodicWave(real, imag);
  }

  function gainNode(ctx, value) {
    const node = ctx.createGain();
    node.gain.value = value;
    return node;
  }

  /** Connect `source` to each [destination, level] pair (level 1 connects directly). */
  function wireBus(ctx, source, destinations) {
    for (const [node, level] of destinations) {
      if (level === 1) { source.connect(node); continue; }
      const send = gainNode(ctx, level);
      source.connect(send);
      send.connect(node);
    }
  }

  /** An LFO expressed in cents, ready to be fed into oscillator detune params. */
  function makeDetuneLfo(ctx, hz, cents) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = hz;
    const depth = gainNode(ctx, cents);
    lfo.connect(depth);
    lfo.start();
    return depth;
  }

  /**
   * Build the whole signal chain on a context and return handles to it.
   * Master gain starts at 0 so the caller can fade in.
   */
  function buildGraph(ctx, rng = Math.random) {
    // Output: instruments -> bus -> warm tone filter (opens with intensity) -> glue -> master
    const out = gainNode(ctx, 0);
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -26; glue.knee.value = 20; glue.ratio.value = 2.5;
    glue.attack.value = 0.02; glue.release.value = 0.3;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 1800; tone.Q.value = 0.4;
    const bus = gainNode(ctx, 1);
    bus.connect(tone); tone.connect(glue); glue.connect(out); out.connect(ctx.destination);

    // Room reverb
    const reverbIn = gainNode(ctx, 1);
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 4.5, rng);
    const reverbOut = gainNode(ctx, 0.7);
    reverbIn.connect(reverb); reverb.connect(reverbOut); reverbOut.connect(tone);

    // Echo: three sixteenths long, so repeats land between the ostinato notes
    const echoIn = gainNode(ctx, 1);
    const echo = ctx.createDelay(2);
    echo.delayTime.value = STEP_SECONDS * 3;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass'; echoTone.frequency.value = 1600;
    const echoFeedback = gainNode(ctx, 0.36);
    const echoOut = gainNode(ctx, 0.5);
    echoIn.connect(echo); echo.connect(echoTone); echoTone.connect(echoFeedback);
    echoFeedback.connect(echo); echoTone.connect(echoOut); echoOut.connect(tone);

    // Slow tape drift on every pitched voice; a gentle vibrato for the lead
    const wobble = gainNode(ctx, 1);
    makeDetuneLfo(ctx, 0.19, 4).connect(wobble);
    makeDetuneLfo(ctx, 4.7, 0.6).connect(wobble);
    const vibrato = gainNode(ctx, 1);
    makeDetuneLfo(ctx, 5.1, 7).connect(vibrato);

    // Cosmic wind: band-passed noise whose centre drifts slowly
    const wind = ctx.createBufferSource();
    wind.buffer = makeNoise(ctx, 8, rng);
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass'; windFilter.frequency.value = 600; windFilter.Q.value = 2.5;
    const windDrift = ctx.createOscillator();
    windDrift.frequency.value = 0.045;
    windDrift.connect(gainNode(ctx, 350)).connect(windFilter.frequency);
    windDrift.start();
    const windGain = gainNode(ctx, 0.006);
    wind.connect(windFilter); windFilter.connect(windGain); windGain.connect(bus);
    wind.start();

    // Instrument buses: [destination, send level]. The two ostinatos sit left and right.
    const padBus = gainNode(ctx, 1);
    wireBus(ctx, padBus, [[bus, 1], [reverbIn, 0.5], [echoIn, 0.05]]);
    const bassBus = gainNode(ctx, 1);
    wireBus(ctx, bassBus, [[bus, 1]]);
    const ostABus = gainNode(ctx, 1);
    const panA = ctx.createStereoPanner(); panA.pan.value = -0.4;
    ostABus.connect(panA);
    wireBus(ctx, panA, [[bus, 1], [reverbIn, 0.25], [echoIn, 0.3]]);
    const ostBBus = gainNode(ctx, 1);
    const panB = ctx.createStereoPanner(); panB.pan.value = 0.4;
    ostBBus.connect(panB);
    wireBus(ctx, panB, [[bus, 1], [reverbIn, 0.25], [echoIn, 0.3]]);
    const melodyBus = gainNode(ctx, 1);
    wireBus(ctx, melodyBus, [[bus, 1], [reverbIn, 0.65], [echoIn, 0.4]]);
    const tickBus = gainNode(ctx, 1);
    wireBus(ctx, tickBus, [[bus, 1], [reverbIn, 0.1]]);
    const hitBus = gainNode(ctx, 1);
    wireBus(ctx, hitBus, [[bus, 1], [reverbIn, 0.4]]);

    return {
      ctx, out, tone, windGain, wobble, vibrato,
      padBus, bassBus, ostABus, ostBBus, melodyBus, tickBus, hitBus,
      organWave: makeWave(ctx, [1, 0.5, 0.28, 0.18, 0, 0.08]),     // soft diapason registration
      bellWave: makeWave(ctx, [1, 0.3, 0.1]),                        // rounded, never glassy
      noise: makeNoise(ctx, 1, rng)
    };
  }

  /** Per-bar mix automation: the room opens up (a little brighter, a little windier) as intensity rises. */
  function automateBar(graph, intensity, when) {
    graph.tone.frequency.setTargetAtTime(1600 + 2600 * intensity, when, 1.2);
    graph.windGain.gain.setTargetAtTime(0.004 + 0.02 * intensity, when, 1.5);
  }

  /* ---- voices ---- */

  /** Feed modulators (cents) into an oscillator's detune and unhook them when it ends. */
  function attachDetune(oscillator, modulators) {
    for (const modulator of modulators) modulator.connect(oscillator.detune);
    oscillator.onended = () => {
      for (const modulator of modulators) {
        try { modulator.disconnect(oscillator.detune); } catch (_) { /* already gone */ }
      }
    };
  }

  /** Warm organ note: one wave, two oscillators a few cents apart for width. */
  function playPad(graph, midi, when, seconds, velocity) {
    const { ctx } = graph;
    const attack = 0.3, release = 0.9;
    const length = Math.max(seconds, attack + 0.2);
    const peak = velocity * 0.013;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + attack);
    amp.gain.setValueAtTime(peak, when + length);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + length + release);
    amp.connect(graph.padBus);
    for (const cents of [-5, 5]) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(graph.organWave);
      osc.frequency.value = midiToFreq(midi);
      osc.detune.value = cents;
      attachDetune(osc, [graph.wobble]);
      osc.connect(amp);
      osc.start(when);
      osc.stop(when + length + release + 0.1);
    }
  }

  /** Pure sine bass, soft in and out. */
  function playBass(graph, midi, when, seconds, velocity) {
    const { ctx } = graph;
    const attack = 0.08, release = 0.5;
    const length = Math.max(seconds, attack + 0.2);
    const peak = velocity * 0.018;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + attack);
    amp.gain.setValueAtTime(peak, when + length);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + length + release);
    amp.connect(graph.bassBus);
    const osc = ctx.createOscillator();
    osc.frequency.value = midiToFreq(midi);
    osc.connect(amp);
    osc.start(when);
    osc.stop(when + length + release + 0.1);
  }

  /** One staccato ostinato note: a soft, round pluck that is gone before the next one lands. */
  function playOstinato(graph, destination, midi, when, velocity) {
    const { ctx } = graph;
    const decay = 0.16;
    const peak = velocity * 0.25;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    amp.connect(destination);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(graph.bellWave);
    osc.frequency.value = midiToFreq(midi);
    attachDetune(osc, [graph.wobble]);
    osc.connect(amp);
    osc.start(when);
    osc.stop(when + decay + 0.05);
  }

  /** Breathy, slow-attack lead with a touch of vibrato: the "soul". */
  function playLead(graph, midi, when, seconds, velocity) {
    const { ctx } = graph;
    const attack = 0.3, release = 1.6;
    const length = Math.max(seconds, attack + 0.5);
    const peak = velocity * 0.018;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + attack);
    amp.gain.setValueAtTime(peak, when + length);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + length + release);
    amp.connect(graph.melodyBus);
    for (const wave of [graph.organWave, null]) {
      const osc = ctx.createOscillator();
      if (wave) osc.setPeriodicWave(wave);
      osc.frequency.value = midiToFreq(midi);
      attachDetune(osc, [graph.wobble, graph.vibrato]);
      osc.connect(amp);
      osc.start(when);
      osc.stop(when + length + release + 0.1);
    }
  }

  /** The clock tick: one short burst of band-passed noise. */
  function playTick(graph, when, velocity, rng) {
    const { ctx } = graph;
    const decay = 0.04;
    const source = ctx.createBufferSource();
    source.buffer = graph.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 2400; filter.Q.value = 9;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(velocity * 0.2, when + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    source.connect(filter); filter.connect(amp); amp.connect(graph.tickBus);
    source.start(when, rng() * 0.5);
    source.stop(when + decay + 0.05);
  }

  /** Low cinematic boom: a sine falling from 76 Hz to 30 Hz with a long tail. */
  function playHit(graph, when, velocity) {
    const { ctx } = graph;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.frequency.setValueAtTime(76, when);
    osc.frequency.exponentialRampToValueAtTime(30, when + 0.6);
    amp.gain.setValueAtTime(velocity * 0.12, when);
    amp.gain.exponentialRampToValueAtTime(0.001, when + 1.6);
    osc.connect(amp); amp.connect(graph.hitBus);
    osc.start(when); osc.stop(when + 1.7);
  }

  /**
   * Turn one step's worth of planned events into scheduled audio at time `when`.
   * Tiny random timing/velocity offsets keep the pulse alive without loosening it.
   */
  function scheduleStep(graph, events, when, rng = Math.random) {
    const now = graph.ctx.currentTime;
    const humanise = (t, spread) => Math.max(now, t + (rng() - 0.5) * spread);
    const loudness = (v, spread = 0.2) => Math.min(1, v * (1 - spread / 2 + rng() * spread));

    for (const event of events) {
      const seconds = (event.bars || 0) * BAR_SECONDS;
      switch (event.kind) {
        case 'pad':
          event.notes.forEach((midi, i) =>
            playPad(graph, midi, humanise(when + i * 0.03, 0.01), seconds, loudness(event.velocity)));
          break;
        case 'bass':
          playBass(graph, event.midi, when, seconds, event.velocity);
          playBass(graph, event.midi - 12, when, seconds, event.velocity * 0.4);
          break;
        case 'ostA':   playOstinato(graph, graph.ostABus, event.midi, humanise(when, 0.006), loudness(event.velocity, 0.16)); break;
        case 'ostB':   playOstinato(graph, graph.ostBBus, event.midi, humanise(when, 0.006), loudness(event.velocity, 0.16)); break;
        case 'melody': playLead(graph, event.midi, humanise(when, 0.03), seconds, loudness(event.velocity)); break;
        case 'tick':   playTick(graph, humanise(when, 0.004), event.velocity, rng); break;
        case 'hit':    playHit(graph, when, event.velocity); break;
        default: break;
      }
    }
  }

  /**
   * Walks the song forward in time. `advanceTo(limit)` schedules every step that starts
   * before `limit` (seconds on the context clock). The player calls it from a timer with
   * "now + lookahead"; an offline render calls it once with the full duration.
   */
  function createScheduler(graph, rng, startAt) {
    const melodyState = { last: null };
    let bar = 0;
    let step = 0;
    let barStart = startAt;
    let plan = planBar(bar, rng, melodyState);
    return {
      advanceTo(limit) {
        for (;;) {
          const when = barStart + stepTime(step);
          if (when > limit) return;
          if (step === 0) automateBar(graph, intensityAt(bar), when);
          scheduleStep(graph, plan.filter(event => event.step === step), when, rng);
          step += 1;
          if (step === STEPS_PER_BAR) {
            step = 0; bar += 1; barStart += BAR_SECONDS;
            plan = planBar(bar, rng, melodyState);
          }
        }
      }
    };
  }

  /* ------------------------------------------------------------------
     Player: the only thing the page talks to
  ------------------------------------------------------------------ */

  function getAudioContextClass() {
    return typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : undefined;
  }

  function isSupported() {
    return Boolean(getAudioContextClass());
  }

  /**
   * createPlayer({ volume, rng, onChange }) -> { start, stop, toggle, playing, supported }
   * Must be started from a user gesture (browser autoplay policy). Each start builds a fresh
   * AudioContext and each stop closes it, so nothing lingers or leaks between sessions.
   */
  function createPlayer({ volume = DEFAULT_VOLUME, rng = Math.random, onChange = () => {} } = {}) {
    const AudioContextClass = getAudioContextClass();
    let session = null;   // { ctx, graph, scheduler, timer, onVisibility }

    function notify(isPlaying) {
      try { onChange(isPlaying); } catch (_) { /* a UI callback must never break audio */ }
    }

    function teardown(target) {
      if (!target) return;
      clearInterval(target.timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', target.onVisibility);
      target.ctx.close().catch(() => {});
    }

    async function start() {
      if (session) return true;
      if (!AudioContextClass) return false;
      let created = null;
      try {
        const ctx = new AudioContextClass({ latencyHint: 'playback' });
        created = { ctx };
        if (ctx.state === 'suspended') await ctx.resume();
        const graph = buildGraph(ctx, rng);
        const scheduler = createScheduler(graph, rng, ctx.currentTime + 0.2);
        graph.out.gain.setTargetAtTime(volume, ctx.currentTime, 1.2);       // slow fade-in
        const tick = () => scheduler.advanceTo(ctx.currentTime + SCHEDULE_AHEAD_SECONDS);
        tick();
        const onVisibility = () => {                                         // no audio in background tabs
          if (document.hidden) ctx.suspend().catch(() => {}); else ctx.resume().catch(() => {});
        };
        document.addEventListener('visibilitychange', onVisibility);
        session = { ctx, graph, scheduler, timer: setInterval(tick, LOOKAHEAD_MS), onVisibility };
        notify(true);
        return true;
      } catch (error) {
        if (created) created.ctx.close().catch(() => {});
        session = null;
        notify(false);
        return false;
      }
    }

    function stop() {
      const ending = session;
      if (!ending) return;
      session = null;
      ending.ctx.resume().catch(() => {});                                   // so the fade-out is audible
      ending.graph.out.gain.setTargetAtTime(0, ending.ctx.currentTime, 0.4);
      clearInterval(ending.timer);
      notify(false);
      setTimeout(() => teardown(ending), 2800);
    }

    async function toggle() {
      if (session) { stop(); return false; }
      return start();
    }

    return {
      start, stop, toggle,
      get playing() { return session !== null; },
      supported: Boolean(AudioContextClass)
    };
  }

  return {
    // constants
    BPM, STEPS_PER_BEAT, BEATS_PER_BAR, STEPS_PER_BAR, BEAT_SECONDS, BAR_SECONDS, INTENSITY_CYCLE_BARS,
    DEFAULT_VOLUME, PROGRESSION, OSTINATO_A_UP, OSTINATO_A_DOWN, OSTINATO_B_PATTERN, TICK_STEPS,
    // pure helpers
    midiToFreq, mulberry32, stepTime, intensityAt, pickMelodyNote, planBar,
    // audio
    buildGraph, automateBar, scheduleStep, createScheduler, createPlayer, isSupported
  };
});
