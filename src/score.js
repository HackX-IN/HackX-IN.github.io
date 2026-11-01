/*!
 * Generative space score.
 *
 * An original, endlessly evolving piece in the spirit of cinematic space-organ music:
 * a cathedral-organ pad, a slow rolling arpeggio, a ticking clock, a sub drone and long
 * swells that build and fall over ~75 seconds. Synthesised live with the Web Audio API:
 * no samples, no recordings, no borrowed melodies, so there is nothing to license.
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
  const BPM = 52;                              // pulses per minute; one pulse = a dotted quarter = 3 eighths
  const STEPS_PER_PULSE = 3;
  const PULSES_PER_BAR = 4;
  const STEPS_PER_BAR = STEPS_PER_PULSE * PULSES_PER_BAR;   // 12/8 feel: four rolling groups of three
  const PULSE_SECONDS = 60 / BPM;
  const STEP_SECONDS = PULSE_SECONDS / STEPS_PER_PULSE;
  const BAR_SECONDS = PULSE_SECONDS * PULSES_PER_BAR;
  const BARS_PER_CHORD = 2;
  const INTENSITY_CYCLE_BARS = 16;             // one full swell: rise for 8 bars, fall for 8
  const LOOKAHEAD_MS = 40;                     // scheduler wake-up interval
  const SCHEDULE_AHEAD_SECONDS = 0.25;         // how far past "now" we schedule audio
  const DEFAULT_VOLUME = 1;
  const TICK_STEPS = [0, 3, 6, 9];

  /**
   * Four chords, two bars each. Open voicings low and wide (MIDI numbers), an arpeggio pool
   * (ascending), and a melody pool per chord. Minor-modal, hanging, never quite resolved:
   * Am(add9) -> Fmaj7 -> Dm9 -> Esus4 and round again.
   */
  const PROGRESSION = Object.freeze([
    { name: 'Am(add9)', pad: [45, 52, 57, 60, 64, 71], arp: [64, 69, 71, 72, 76, 81], melody: [76, 81, 83, 84] },
    { name: 'Fmaj7',    pad: [41, 48, 53, 57, 60, 64], arp: [65, 69, 72, 76, 77, 81], melody: [72, 77, 81, 84] },
    { name: 'Dm9',      pad: [38, 45, 50, 53, 57, 64], arp: [62, 65, 69, 72, 76, 77], melody: [74, 76, 77, 81] },
    { name: 'Esus4',    pad: [40, 47, 52, 57, 59, 64], arp: [64, 69, 71, 76, 81, 83], melody: [71, 76, 81, 83] }
  ]);

  /** Indices into a chord's arp pool, one per step. Three-note groups that climb and fall back. */
  const ARP_PATTERNS = Object.freeze([
    [0, 1, 2, 1, 2, 3, 2, 3, 4, 3, 2, 1],
    [0, 2, 1, 2, 3, 2, 1, 3, 2, 4, 3, 2]
  ]);

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

  /** Seconds from the start of a bar to a given step (straight time: no swing here). */
  function stepTime(step, bpm = BPM) {
    return step * (60 / bpm / STEPS_PER_PULSE);
  }

  /**
   * How "full" the music is at a bar, from 0.3 (sparse) to 1 (climax), as a smooth arc that
   * repeats every 16 bars. Layers fade in as it rises and drop out as it falls.
   */
  function intensityAt(barIndex) {
    const phase = ((barIndex % INTENSITY_CYCLE_BARS) + 0.5) / INTENSITY_CYCLE_BARS;
    return 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * phase), 2);
  }

  /**
   * Pick the next melody note from a pool, preferring small leaps from the previous note
   * and gently discouraging an exact repeat.
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
   * { kind: 'drone' | 'pad' | 'tick' | 'arp' | 'melody' | 'hit', step, ... }
   * `melodyState` carries the last melody note across bars so lines flow.
   */
  function planBar(barIndex, rng, melodyState = { last: null }) {
    const chord = PROGRESSION[Math.floor(barIndex / BARS_PER_CHORD) % PROGRESSION.length];
    const barInChord = barIndex % BARS_PER_CHORD;
    const intensity = intensityAt(barIndex);
    const octaveLift = barIndex % INTENSITY_CYCLE_BARS >= INTENSITY_CYCLE_BARS / 2 ? 12 : 0;
    const events = [];
    const add = (kind, step, extra) => events.push(Object.assign({ kind, step }, extra));

    // Foundation: drone and organ chord, held for the whole chord and swelling in.
    if (barInChord === 0) {
      add('drone', 0, { midi: chord.pad[0], velocity: 0.6 + 0.4 * intensity, bars: BARS_PER_CHORD });
      add('pad', 0, { notes: chord.pad, velocity: 0.45 + 0.55 * intensity, bars: BARS_PER_CHORD });
    }

    // The clock: one soft tick per pulse, always there.
    for (const step of TICK_STEPS) add('tick', step, { velocity: 0.5 + 0.3 * intensity });

    // Arpeggio: fades in once the music has built a little.
    const arpLevel = clamp01((intensity - 0.38) / 0.4);
    if (arpLevel > 0.05) {
      ARP_PATTERNS[barInChord].forEach((poolIndex, step) => {
        if (rng() < 0.06) return;                                   // the odd missing note: human
        const accent = step % 3 === 0 ? 1 : 0.62;
        add('arp', step, { midi: chord.arp[poolIndex] + octaveLift, velocity: accent * arpLevel * (0.85 + rng() * 0.3) });
      });
    }

    // Melody: long, rare notes near the peak.
    if (intensity > 0.6 && barInChord === 0 && rng() < 0.7) {
      const steps = rng() < 0.4 ? [0, 6] : [0];
      for (const step of steps) {
        const midi = pickMelodyNote(chord.melody, melodyState.last, rng);
        melodyState.last = midi;
        add('melody', step, { midi, velocity: 0.45 + 0.4 * intensity, bars: 1.2 });
      }
    }

    // A deep boom on the biggest downbeats.
    if (intensity > 0.9 && barInChord === 0 && rng() < 0.8) add('hit', 0, { velocity: 0.6 + 0.4 * intensity });

    return events;
  }

  /* ------------------------------------------------------------------
     Audio graph (browser / OfflineAudioContext)
  ------------------------------------------------------------------ */

  /** Dark, long, stereo "cathedral" tail from filtered noise. */
  function makeImpulse(ctx, seconds, rng) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let smoothed = 0;
      for (let i = 0; i < length; i++) {
        smoothed += ((rng() * 2 - 1) - smoothed) * 0.22;        // one-pole lowpass darkens the tail
        data[i] = smoothed * Math.pow(1 - i / length, 2.4);
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

  /**
   * Build the whole signal chain on a context and return handles to it.
   * Master gain starts at 0 so the caller can fade in.
   */
  function buildGraph(ctx, rng = Math.random) {
    // Output: instruments -> bus -> tone (opens with intensity) -> glue compressor -> master
    const out = gainNode(ctx, 0);
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -22; glue.knee.value = 20; glue.ratio.value = 2.5;
    glue.attack.value = 0.03; glue.release.value = 0.4;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 2600; tone.Q.value = 0.4;
    const bus = gainNode(ctx, 1);
    bus.connect(tone); tone.connect(glue); glue.connect(out); out.connect(ctx.destination);

    // Cathedral reverb
    const reverbIn = gainNode(ctx, 1);
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 6.5, rng);
    const reverbOut = gainNode(ctx, 0.7);
    reverbIn.connect(reverb); reverb.connect(reverbOut); reverbOut.connect(tone);

    // Echo: one pulse long, darker with every repeat
    const echoIn = gainNode(ctx, 1);
    const echo = ctx.createDelay(3);
    echo.delayTime.value = PULSE_SECONDS;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass'; echoTone.frequency.value = 2000;
    const echoFeedback = gainNode(ctx, 0.42);
    const echoOut = gainNode(ctx, 0.5);
    echoIn.connect(echo); echo.connect(echoTone); echoTone.connect(echoFeedback);
    echoFeedback.connect(echo); echoTone.connect(echoOut); echoOut.connect(tone);

    // Slow tape drift in cents, fed to the pitched voices (kept small: organs hate wobble)
    const wobble = gainNode(ctx, 1);
    for (const [hz, cents] of [[0.19, 4], [4.7, 0.6]]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = hz;
      lfo.connect(gainNode(ctx, cents)).connect(wobble);
      lfo.start();
    }

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
    const windGain = gainNode(ctx, 0.01);
    wind.connect(windFilter); windFilter.connect(windGain); windGain.connect(bus);
    wind.start();

    // Instrument buses: [destination, send level]
    const padBus = gainNode(ctx, 1);
    wireBus(ctx, padBus, [[bus, 1], [reverbIn, 0.55], [echoIn, 0.08]]);
    const droneBus = gainNode(ctx, 1);
    wireBus(ctx, droneBus, [[bus, 1]]);
    const arpBus = gainNode(ctx, 1);
    wireBus(ctx, arpBus, [[bus, 1], [reverbIn, 0.5], [echoIn, 0.35]]);
    const melodyBus = gainNode(ctx, 0.9);
    wireBus(ctx, melodyBus, [[bus, 1], [reverbIn, 0.7], [echoIn, 0.5]]);
    const tickBus = gainNode(ctx, 1);
    wireBus(ctx, tickBus, [[bus, 1], [reverbIn, 0.1]]);
    const hitBus = gainNode(ctx, 1);
    wireBus(ctx, hitBus, [[bus, 1], [reverbIn, 0.45]]);

    return {
      ctx, out, tone, windGain, wobble,
      padBus, droneBus, arpBus, melodyBus, tickBus, hitBus,
      organWave: makeWave(ctx, [1, 0.55, 0.32, 0.22, 0, 0.1, 0, 0.06]),   // diapason-like registration
      bellWave: makeWave(ctx, [1, 0.4, 0.18, 0.07]),
      noise: makeNoise(ctx, 1, rng)
    };
  }

  /** Per-bar mix automation: the room opens up (brighter, windier) as intensity rises. */
  function automateBar(graph, intensity, when) {
    graph.tone.frequency.setTargetAtTime(2200 + 4800 * intensity, when, 1.5);
    graph.windGain.gain.setTargetAtTime(0.006 + 0.03 * intensity, when, 2);
  }

  /* ---- voices ---- */

  function connectWobble(graph, oscillator) {
    graph.wobble.connect(oscillator.detune);
    oscillator.onended = () => {
      try { graph.wobble.disconnect(oscillator.detune); } catch (_) { /* already gone */ }
    };
  }

  /** Slowly swelling organ note: one wave, two oscillators, a few cents apart for width. */
  function playPad(graph, midi, when, seconds, velocity) {
    const { ctx } = graph;
    const attack = 1.8, release = 3.2;
    const length = Math.max(seconds, attack + 1);
    const peak = velocity * 0.026;
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
      connectWobble(graph, osc);
      osc.connect(amp);
      osc.start(when);
      osc.stop(when + length + release + 0.1);
    }
  }

  /** Pure sine foundation, very slow in and out. */
  function playDrone(graph, midi, when, seconds, velocity) {
    const { ctx } = graph;
    const attack = 2.4, release = 3.4;
    const length = Math.max(seconds, attack + 1);
    const peak = velocity * 0.04;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + attack);
    amp.gain.setValueAtTime(peak, when + length);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + length + release);
    amp.connect(graph.droneBus);
    const osc = ctx.createOscillator();
    osc.frequency.value = midiToFreq(midi);
    osc.connect(amp);
    osc.start(when);
    osc.stop(when + length + release + 0.1);
  }

  /** Soft, bell-like pluck for the rolling arpeggio. */
  function playArp(graph, midi, when, velocity) {
    const { ctx } = graph;
    const peak = velocity * 0.1;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.015);
    amp.gain.exponentialRampToValueAtTime(peak * 0.3, when + 0.6);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + 2.2);
    amp.connect(graph.arpBus);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(graph.bellWave);
    osc.frequency.value = midiToFreq(midi);
    connectWobble(graph, osc);
    osc.connect(amp);
    osc.start(when);
    osc.stop(when + 2.3);
  }

  /** Breathy, slow-attack lead note. */
  function playLead(graph, midi, when, seconds, velocity) {
    const { ctx } = graph;
    const attack = 0.4, release = 2.4;
    const length = Math.max(seconds, attack + 1);
    const peak = velocity * 0.03;
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
      connectWobble(graph, osc);
      osc.connect(amp);
      osc.start(when);
      osc.stop(when + length + release + 0.1);
    }
  }

  /** One burst of filtered noise into a bus: the clock tick. */
  function playNoise(graph, destination, when, { type, frequency, q = 0.7, peak, decay, rng }) {
    const { ctx } = graph;
    const source = ctx.createBufferSource();
    source.buffer = graph.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    source.connect(filter); filter.connect(amp); amp.connect(destination);
    source.start(when, rng() * 0.5);
    source.stop(when + decay + 0.05);
  }

  function playTick(graph, when, velocity, rng) {
    playNoise(graph, graph.tickBus, when, { type: 'bandpass', frequency: 2600, q: 9, peak: velocity * 0.2, decay: 0.04, rng });
  }

  /** Low cinematic boom: a sine falling from 76 Hz to 30 Hz with a long tail. */
  function playHit(graph, when, velocity) {
    const { ctx } = graph;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.frequency.setValueAtTime(76, when);
    osc.frequency.exponentialRampToValueAtTime(30, when + 0.6);
    amp.gain.setValueAtTime(velocity * 0.36, when);
    amp.gain.exponentialRampToValueAtTime(0.001, when + 1.8);
    osc.connect(amp); amp.connect(graph.hitBus);
    osc.start(when); osc.stop(when + 1.9);
  }

  /**
   * Turn one step's worth of planned events into scheduled audio at time `when`.
   * Small random timing/velocity offsets keep it from sounding like a machine.
   */
  function scheduleStep(graph, events, when, rng = Math.random) {
    const now = graph.ctx.currentTime;
    const humanise = (t, spread) => Math.max(now, t + (rng() - 0.5) * spread);
    const loudness = v => Math.min(1, v * (0.9 + rng() * 0.2));

    for (const event of events) {
      const seconds = (event.bars || 0) * BAR_SECONDS;
      switch (event.kind) {
        case 'pad':
          event.notes.forEach((midi, i) =>
            playPad(graph, midi, humanise(when + i * 0.14, 0.04), seconds, loudness(event.velocity)));   // slow bloom
          break;
        case 'drone':
          playDrone(graph, event.midi, when, seconds, event.velocity);
          playDrone(graph, event.midi - 12, when, seconds, event.velocity * 0.4);
          break;
        case 'arp':    playArp(graph, event.midi, humanise(when, 0.02), loudness(event.velocity)); break;
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
        graph.out.gain.setTargetAtTime(volume, ctx.currentTime, 1.4);       // long, slow fade-in
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
      ending.graph.out.gain.setTargetAtTime(0, ending.ctx.currentTime, 0.5);
      clearInterval(ending.timer);
      notify(false);
      setTimeout(() => teardown(ending), 3200);
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
    BPM, STEPS_PER_BAR, STEPS_PER_PULSE, PULSE_SECONDS, BAR_SECONDS, BARS_PER_CHORD, INTENSITY_CYCLE_BARS,
    PROGRESSION, ARP_PATTERNS, TICK_STEPS,
    // pure helpers
    midiToFreq, mulberry32, stepTime, intensityAt, pickMelodyNote, planBar,
    // audio
    buildGraph, automateBar, scheduleStep, createScheduler, createPlayer, isSupported
  };
});
