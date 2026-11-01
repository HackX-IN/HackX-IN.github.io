/*!
 * Generative lofi engine.
 *
 * Everything you hear is synthesised live with the Web Audio API: no samples, no recordings,
 * so there is nothing to license. Jazzy chords, a sparse melody, a lazy swung beat, tape
 * wobble and vinyl crackle, never repeating exactly.
 *
 * UMD-lite: the pure parts (theory, planning, timing) are unit-tested under Node, the audio
 * parts run in the browser. Build inlines this file into dist/index.html.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Lofi = api;
})(globalThis, function () {
  'use strict';

  /* ------------------------------------------------------------------
     Constants
  ------------------------------------------------------------------ */
  const BPM = 72;
  const SWING = 0.6;                       // 0.5 = straight, 0.66 = triplet feel
  const STEPS_PER_BAR = 8;                 // eighth-note grid, 4/4
  const BEAT_SECONDS = 60 / BPM;
  const BAR_SECONDS = BEAT_SECONDS * 4;
  const LOOKAHEAD_MS = 40;                 // scheduler wake-up interval
  const SCHEDULE_AHEAD_SECONDS = 0.25;     // how far past "now" we schedule audio
  const DEFAULT_VOLUME = 1;
  const MELODY_BAR_PROBABILITY = 0.6;
  const MELODY_STEP_CANDIDATES = [1, 3, 4, 6, 7];

  /**
   * Eight bars, then it loops. Rootless voicings in the middle register (MIDI numbers),
   * a bass root, and a hand-picked melody pool per chord so nothing ever clashes.
   * The last chord (G7b9) resolves "sideways" into Fmaj9, which is what keeps the loop dreamy.
   */
  const PROGRESSION = Object.freeze([
    { name: 'Fmaj9', bass: 41, notes: [53, 57, 60, 64, 67], melody: [72, 76, 79, 81, 84] },
    { name: 'Em7',   bass: 40, notes: [52, 55, 59, 62],     melody: [71, 74, 76, 79, 83] },
    { name: 'Dm9',   bass: 38, notes: [53, 57, 60, 64],     melody: [72, 74, 77, 79, 81] },
    { name: 'G13',   bass: 43, notes: [53, 59, 62, 64],     melody: [71, 74, 76, 77, 79] },
    { name: 'Cmaj9', bass: 48, notes: [52, 55, 59, 62],     melody: [72, 74, 76, 79, 83] },
    { name: 'Am9',   bass: 45, notes: [55, 59, 60, 64],     melody: [72, 76, 79, 81, 83] },
    { name: 'Dm9',   bass: 38, notes: [53, 57, 60, 64],     melody: [72, 74, 77, 79, 81] },
    { name: 'G7b9',  bass: 43, notes: [53, 59, 62, 68],     melody: [71, 74, 77, 80] }
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

  /**
   * Seconds from the start of a bar to a given eighth-note step.
   * Even steps sit on the beat; odd steps are pushed late by the swing amount.
   */
  function stepTime(step, bpm = BPM, swing = SWING) {
    const beat = 60 / bpm;
    const wholeBeats = Math.floor(step / 2);
    const isOffBeat = step % 2 === 1;
    return (wholeBeats + (isOffBeat ? swing : 0)) * beat;
  }

  /** Fisher-Yates on a copy. */
  function shuffled(items, rng) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /**
   * Pick the next melody note from a pool, preferring small leaps from the previous note
   * (singable lines), and gently discouraging an exact repeat.
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
   * { kind: 'chord' | 'bass' | 'kick' | 'snare' | 'hat' | 'melody', step, ... }
   * `melodyState` carries the last melody note across bars so lines flow.
   */
  function planBar(barIndex, rng, melodyState = { last: null }) {
    const chord = PROGRESSION[barIndex % PROGRESSION.length];
    const events = [];
    const add = (kind, step, extra) => events.push(Object.assign({ kind, step }, extra));

    // Keys: full chord on the downbeat, a softer stab on the swung "and" of 2.
    add('chord', 0, { notes: chord.notes, velocity: 0.9, beats: 3.2 });
    if (rng() < 0.6) add('chord', 3, { notes: chord.notes, velocity: 0.5, beats: 1.2 });

    // Bass: root on one, sometimes the fifth later.
    add('bass', 0, { midi: chord.bass, velocity: 0.9, beats: 2.4 });
    if (rng() < 0.55) add('bass', 5, { midi: chord.bass + 7, velocity: 0.6, beats: 1 });

    // Drums: boom-bap. Kick on 1 (+ sometimes the "and" of 2), snare on 2 and 4, lazy hats.
    add('kick', 0, { velocity: 1 });
    if (rng() < 0.65) add('kick', 3, { velocity: 0.75 });
    add('snare', 2, { velocity: 0.85 });
    add('snare', 6, { velocity: 0.9 });
    if (rng() < 0.18) add('snare', 7, { velocity: 0.3 });   // ghost note
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      if (rng() < 0.1) continue;                            // drop a few hats: human feel
      const accent = step % 2 === 0 ? 0.75 : 0.45;
      add('hat', step, { velocity: accent * (0.8 + rng() * 0.4) });
    }

    // Melody: sparse. Most bars leave room to breathe.
    if (rng() < MELODY_BAR_PROBABILITY) {
      const count = rng() < 0.2 ? 3 : rng() < 0.6 ? 2 : 1;
      const steps = shuffled(MELODY_STEP_CANDIDATES, rng).slice(0, count).sort((a, b) => a - b);
      for (const step of steps) {
        const midi = pickMelodyNote(chord.melody, melodyState.last, rng);
        melodyState.last = midi;
        add('melody', step, { midi, velocity: 0.55 + rng() * 0.3, beats: 1.5 + rng() * 1.5 });
      }
    }
    return events;
  }

  /* ------------------------------------------------------------------
     Audio graph (browser / OfflineAudioContext)
  ------------------------------------------------------------------ */

  /** Dark, short-ish stereo reverb tail from filtered noise. */
  function makeImpulse(ctx, seconds, rng) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let smoothed = 0;
      for (let i = 0; i < length; i++) {
        smoothed += ((rng() * 2 - 1) - smoothed) * 0.3;     // one-pole lowpass darkens the tail
        data[i] = smoothed * Math.pow(1 - i / length, 3);
      }
    }
    return buffer;
  }

  /** Quiet hiss with sparse single-sample pops: the vinyl bed. */
  function makeCrackle(ctx, seconds, rng) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (rng() * 2 - 1) * 0.002;
      if (rng() < 0.0005) data[i] += (rng() * 2 - 1) * (0.25 + rng() * 0.6);
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

  function gainNode(ctx, value) {
    const node = ctx.createGain();
    node.gain.value = value;
    return node;
  }

  /** Connect `source` to the main bus and to the effect sends at the given levels. */
  function wireBus(source, destinations) {
    for (const [node, level, ctx] of destinations) {
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
    // Output: instruments -> bus -> warm lowpass -> glue compressor -> master
    const out = gainNode(ctx, 0);
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20; glue.knee.value = 18; glue.ratio.value = 3;
    glue.attack.value = 0.01; glue.release.value = 0.25;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = 5200; tone.Q.value = 0.5;
    const bus = gainNode(ctx, 1);
    bus.connect(tone); tone.connect(glue); glue.connect(out); out.connect(ctx.destination);

    // Reverb (dark, wet)
    const reverbIn = gainNode(ctx, 1);
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 2.8, rng);
    const reverbOut = gainNode(ctx, 0.55);
    reverbIn.connect(reverb); reverb.connect(reverbOut); reverbOut.connect(tone);

    // Echo: dotted-eighth feedback delay that gets darker each repeat
    const echoIn = gainNode(ctx, 1);
    const echo = ctx.createDelay(2);
    echo.delayTime.value = BEAT_SECONDS * 0.75;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass'; echoTone.frequency.value = 1800;
    const echoFeedback = gainNode(ctx, 0.38);
    const echoOut = gainNode(ctx, 0.5);
    echoIn.connect(echo); echo.connect(echoTone); echoTone.connect(echoFeedback);
    echoFeedback.connect(echo); echoTone.connect(echoOut); echoOut.connect(tone);

    // Tape: slow "wow" plus a touch of flutter, expressed in cents, fed to every pitched voice
    const wobble = gainNode(ctx, 1);
    for (const [hz, cents] of [[0.23, 7], [5.3, 1.2]]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = hz;
      lfo.connect(gainNode(ctx, cents)).connect(wobble);
      lfo.start();
    }

    // Keys bus with a gentle suitcase-style tremolo
    const keysBus = gainNode(ctx, 0.88);
    const tremolo = ctx.createOscillator();
    tremolo.frequency.value = 3.4;
    tremolo.connect(gainNode(ctx, 0.1)).connect(keysBus.gain);
    tremolo.start();
    wireBus(keysBus, [[bus, 1, ctx], [reverbIn, 0.45, ctx], [echoIn, 0.2, ctx]]);

    const melodyBus = gainNode(ctx, 1.7);
    wireBus(melodyBus, [[bus, 1, ctx], [reverbIn, 0.6, ctx], [echoIn, 0.5, ctx]]);

    const bassBus = gainNode(ctx, 1);
    wireBus(bassBus, [[bus, 1, ctx]]);

    const drumBus = gainNode(ctx, 0.8);
    wireBus(drumBus, [[bus, 1, ctx], [reverbIn, 0.12, ctx]]);

    // Vinyl bed bypasses the lowpass so it stays bright, and fades with the master
    const crackle = ctx.createBufferSource();
    crackle.buffer = makeCrackle(ctx, 6, rng);
    crackle.loop = true;
    const crackleHighpass = ctx.createBiquadFilter();
    crackleHighpass.type = 'highpass'; crackleHighpass.frequency.value = 900;
    crackle.connect(crackleHighpass); crackleHighpass.connect(gainNode(ctx, 0.07)).connect(out);
    crackle.start();

    return { ctx, out, wobble, keysBus, melodyBus, bassBus, drumBus, noise: makeNoise(ctx, 1, rng) };
  }

  /* ---- voices ---- */

  function connectWobble(graph, oscillator) {
    graph.wobble.connect(oscillator.detune);
    oscillator.onended = () => {
      try { graph.wobble.disconnect(oscillator.detune); } catch (_) { /* already gone */ }
    };
  }

  /** Electric-piano-ish tone: sine + detuned triangle + a short bell-like "tine" an octave up. */
  function playKeys(graph, destination, midi, when, seconds, velocity) {
    const { ctx } = graph;
    const length = Math.max(seconds, 0.6);
    const peak = velocity * 0.08;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.012);
    amp.gain.exponentialRampToValueAtTime(peak * 0.45, when + 0.45);
    amp.gain.exponentialRampToValueAtTime(peak * 0.25, when + length);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + length + 0.9);
    amp.connect(destination);

    const tineAmp = ctx.createGain();
    tineAmp.gain.setValueAtTime(peak * 0.9, when);
    tineAmp.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);
    tineAmp.connect(destination);

    const frequency = midiToFreq(midi);
    const layers = [['sine', 1, 0, amp], ['triangle', 1, 6, amp], ['sine', 2, 0, tineAmp]];
    for (const [type, ratio, cents, target] of layers) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency * ratio;
      osc.detune.value = cents;
      connectWobble(graph, osc);
      osc.connect(target);
      osc.start(when);
      osc.stop(when + length + 1);
    }
  }

  function playBass(graph, midi, when, seconds, velocity) {
    const { ctx } = graph;
    const length = Math.max(seconds, 0.4);
    const peak = velocity * 0.15;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.02);
    amp.gain.exponentialRampToValueAtTime(peak * 0.6, when + 0.3);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + length);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass'; lowpass.frequency.value = 420;
    amp.connect(lowpass); lowpass.connect(graph.bassBus);
    const triangleTrim = gainNode(ctx, 0.35);          // triangle adds a little grit under the sine
    triangleTrim.connect(amp);
    for (const [type, target] of [['sine', amp], ['triangle', triangleTrim]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = midiToFreq(midi);
      connectWobble(graph, osc);
      osc.connect(target);
      osc.start(when);
      osc.stop(when + length + 0.05);
    }
  }

  function playKick(graph, when, velocity) {
    const { ctx } = graph;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.frequency.setValueAtTime(140, when);
    osc.frequency.exponentialRampToValueAtTime(44, when + 0.14);
    amp.gain.setValueAtTime(velocity * 0.8, when);
    amp.gain.exponentialRampToValueAtTime(0.001, when + 0.42);
    osc.connect(amp); amp.connect(graph.drumBus);
    osc.start(when); osc.stop(when + 0.45);
  }

  /** One burst of filtered noise: the building block for snare body and hats. */
  function playNoise(graph, when, { type, frequency, q = 0.7, peak, decay, rng }) {
    const { ctx } = graph;
    const source = ctx.createBufferSource();
    source.buffer = graph.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    source.connect(filter); filter.connect(amp); amp.connect(graph.drumBus);
    source.start(when, rng() * 0.5);
    source.stop(when + decay + 0.05);
  }

  function playSnare(graph, when, velocity, rng) {
    playNoise(graph, when, { type: 'bandpass', frequency: 1700, peak: velocity * 0.5, decay: 0.2, rng });
    const { ctx } = graph;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'triangle'; osc.frequency.value = 185;
    amp.gain.setValueAtTime(velocity * 0.28, when);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
    osc.connect(amp); amp.connect(graph.drumBus);
    osc.start(when); osc.stop(when + 0.1);
  }

  function playHat(graph, when, velocity, rng) {
    playNoise(graph, when, { type: 'highpass', frequency: 4500, peak: velocity * 0.16, decay: 0.05, rng });
  }

  /**
   * Turn one step's worth of planned events into scheduled audio at time `when`.
   * Small random timing/velocity offsets keep it from sounding like a machine.
   */
  function scheduleStep(graph, events, when, rng = Math.random) {
    const now = graph.ctx.currentTime;
    const humanise = (t, spread) => Math.max(now, t + (rng() - 0.5) * spread);
    const loudness = v => Math.min(1, v * (0.85 + rng() * 0.3));

    for (const event of events) {
      const seconds = (event.beats || 0) * BEAT_SECONDS;
      switch (event.kind) {
        case 'chord':
          event.notes.forEach((midi, i) =>
            playKeys(graph, graph.keysBus, midi, humanise(when + i * 0.022, 0.008), seconds, loudness(event.velocity)));
          break;
        case 'melody':
          playKeys(graph, graph.melodyBus, event.midi, humanise(when, 0.02), seconds, loudness(event.velocity));
          break;
        case 'bass':   playBass(graph, event.midi, humanise(when, 0.01), seconds, loudness(event.velocity)); break;
        case 'kick':   playKick(graph, humanise(when, 0.01), event.velocity); break;
        case 'snare':  playSnare(graph, humanise(when, 0.012), loudness(event.velocity), rng); break;
        case 'hat':    playHat(graph, humanise(when, 0.012), event.velocity, rng); break;
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
    let session = null;   // { ctx, graph, scheduler, timer }

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
        const scheduler = createScheduler(graph, rng, ctx.currentTime + 0.15);
        graph.out.gain.setTargetAtTime(volume, ctx.currentTime, 0.9);      // slow fade-in
        const tick = () => scheduler.advanceTo(ctx.currentTime + SCHEDULE_AHEAD_SECONDS);
        tick();
        const onVisibility = () => {                                        // no audio in background tabs
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
      ending.ctx.resume().catch(() => {});                                  // so the fade-out is audible
      ending.graph.out.gain.setTargetAtTime(0, ending.ctx.currentTime, 0.25);
      clearInterval(ending.timer);
      notify(false);
      setTimeout(() => teardown(ending), 1800);
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
    BPM, SWING, STEPS_PER_BAR, BEAT_SECONDS, BAR_SECONDS, PROGRESSION,
    // pure helpers
    midiToFreq, mulberry32, stepTime, pickMelodyNote, planBar,
    // audio
    buildGraph, scheduleStep, createScheduler, createPlayer, isSupported
  };
});
