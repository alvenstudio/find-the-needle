/**
 * Find the Needle - the entire soundtrack, synthesised.
 *
 * There is not a single audio file in this game. Every footstep, coin, gust of
 * wind and note of music is built out of oscillators and noise buffers at
 * runtime. That buys us a zero-byte audio budget, no licences to track, and a
 * game that works offline, but it means the sound design lives here, in code,
 * rather than in a DAW.
 *
 * The house style for these patches:
 *
 * - Anything *organic* (hay, grass, dirt, paper, cloth) is short bursts of
 *   noise shaped by band-pass filters. Real contact sounds are broadband - a
 *   boot on grass has no pitch, only a resonance the material imposes on the
 *   impact. A filtered noise burst reproduces that honestly; an oscillator
 *   cannot, which is exactly why 1980s footsteps sounded like beeps.
 * - Anything *metallic or magical* (coins, bells, the needle itself) is FM: one
 *   oscillator modulating another's frequency. Struck metal has inharmonic
 *   partials, and FM with a non-integer ratio produces inharmonic sidebands for
 *   the price of two oscillators. A decaying modulation index gives the bright
 *   "clink" attack that settles into a pure ring, which is what a real strike
 *   does as the high modes damp out first.
 * - Everything is layered. One node is a synth demo; a body layer plus a
 *   texture layer plus a transient is a sound effect.
 *
 * Nothing here imports three.js. Positions are plain `{x, y, z}` objects so the
 * audio system can be tested and reasoned about without a renderer.
 */

/* -------------------------------------------------------------- public API */

export type SoundName =
  | 'dig_soft'
  | 'dig_hard'
  | 'dig_loop'
  | 'straw_collect'
  | 'sell'
  | 'coin'
  | 'purchase'
  | 'denied'
  | 'ui_hover'
  | 'ui_click'
  | 'ui_open'
  | 'ui_close'
  | 'footstep_grass'
  | 'footstep_hay'
  | 'footstep_dirt'
  | 'jump'
  | 'land'
  | 'treasure'
  | 'needle_found'
  | 'detector_ping'
  | 'tier_unlock'
  | 'quest_complete'
  | 'rebirth'
  | 'error'
  | 'tick';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayOptions {
  /** 0..1, multiplied into the category gain. */
  volume?: number;
  /** Pitch/playback multiplier, default 1. */
  rate?: number;
  /** World position; when given the sound is panned and attenuated. */
  position?: Vec3;
  /** Random pitch variation in semitones, applied symmetrically. Default per-sound. */
  detune?: number;
}

export type AmbienceMood = 'noon' | 'golden' | 'overcast' | 'storm' | 'night' | 'dawn';

/* ---------------------------------------------------------------- tuneables */

/**
 * Concurrent one-shot voices. Beyond about two dozen simultaneous patches the
 * mix turns to mush long before the CPU complains, so the cap is a mixing
 * decision as much as a performance one.
 */
const VOICE_LIMIT = 24;

/**
 * All scheduling happens this far in the future. Automation scheduled at
 * exactly `currentTime` is already in the past by the time the audio thread
 * sees it, which makes `setValueCurveAtTime` throw on some implementations and
 * silently clips the attack on others.
 */
const SCHEDULE_LEAD = 0.012;

/** exponentialRamp cannot touch zero; this is our practical silence. */
const FLOOR = 0.0001;

/** Distance at which a positioned sound plays at full level. */
const REF_DISTANCE = 3;
/** How hard level falls off past `REF_DISTANCE`. */
const ROLLOFF = 0.7;
/** Past this, we do not spawn a voice at all. */
const MAX_DISTANCE = 70;

const AMBIENCE_CROSSFADE = 2;

const MUSIC_BPM = 72;
/** Eighth notes. Slow enough to breathe, fine enough to place a melody on. */
const MUSIC_STEP = 60 / MUSIC_BPM / 2;
/** How far ahead `update` schedules music. Must exceed the worst frame time. */
const MUSIC_LOOKAHEAD = 0.4;

/* ------------------------------------------------------------ small helpers */

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function noop(): void {
  /* deliberately empty - used to swallow rejected AudioContext promises */
}

/**
 * Audio randomness is intentionally *not* drawn from the game's seeded `Rng`.
 * Two players replaying the same daily haystack must get the same pile, but
 * they need not get the same footstep pitch, and consuming the world stream for
 * cosmetics would desynchronise it.
 */
let noiseSeed = (Date.now() ^ 0x9e3779b9) >>> 0;

function random(): number {
  noiseSeed = (noiseSeed + 0x6d2b79f5) >>> 0;
  let t = noiseSeed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randRange(min: number, max: number): number {
  return min + random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(randRange(min, max + 1));
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

/* ------------------------------------------------------------- envelopes */

/**
 * Percussive attack/decay on a gain param, in exponential curves.
 *
 * Loudness is perceived roughly logarithmically, so an exponential ramp is what
 * reads as a "natural" decay; a linear fade to zero sounds like someone pulling
 * a fader and cuts off perceptually long before it reaches silence.
 *
 * Returns the time at which the envelope has finished.
 */
function adEnvelope(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
): number {
  const top = Math.max(peak, FLOOR * 2);
  param.setValueAtTime(FLOOR, t0);
  param.exponentialRampToValueAtTime(top, t0 + attack);
  param.exponentialRampToValueAtTime(FLOOR, t0 + attack + decay);
  param.setValueAtTime(0, t0 + attack + decay);
  return t0 + attack + decay;
}

/**
 * Attack / sustain / release, for anything held: pads, chords, the loop rig.
 * The attack is linear because slow swells sound like they stall when ramped
 * exponentially from silence.
 */
function asrEnvelope(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): number {
  const top = Math.max(peak, FLOOR * 2);
  param.setValueAtTime(FLOOR, t0);
  param.linearRampToValueAtTime(top, t0 + attack);
  param.setValueAtTime(top, t0 + attack + hold);
  param.exponentialRampToValueAtTime(FLOOR, t0 + attack + hold + release);
  param.setValueAtTime(0, t0 + attack + hold + release);
  return t0 + attack + hold + release;
}

/* --------------------------------------------------------- amplitude shapes */

/**
 * Pre-baked amplitude contours for `setValueCurveAtTime`.
 *
 * A clean attack/decay pair is fine for a bell but wrong for straw: real
 * rustling is hundreds of individual stalks letting go at slightly different
 * moments, which shows up as a fast, irregular flutter riding on the overall
 * envelope. Baking that flutter into the amplitude curve is far cheaper than
 * modulating a gain with an extra noise source per voice, and it is the single
 * detail that stops a hay scoop sounding like a hi-hat.
 *
 * These are generated once at module load with a local PRNG so the shapes are
 * stable across sessions - the per-hit variation comes from pitch and level.
 */
function buildShape(
  points: number,
  attackFrac: number,
  decayPower: number,
  roughness: number,
  seed: number,
): Float32Array {
  const raw = new Float32Array(points);
  let state = seed >>> 0;
  const nextRaw = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < points; i++) raw[i] = nextRaw();

  // One-pole smoothing in both directions keeps the flutter band-limited, so it
  // reads as texture rather than as a buzz on top of the envelope.
  const smooth = new Float32Array(points);
  let acc = raw[0];
  for (let i = 0; i < points; i++) {
    acc += (raw[i] - acc) * 0.45;
    smooth[i] = acc;
  }
  acc = smooth[points - 1];
  for (let i = points - 1; i >= 0; i--) {
    acc += (smooth[i] - acc) * 0.45;
    smooth[i] = acc;
  }

  const out = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const u = i / (points - 1);
    const body =
      u < attackFrac
        ? u / attackFrac
        : Math.pow(1 - (u - attackFrac) / (1 - attackFrac), decayPower);
    out[i] = body * (1 - roughness + roughness * (0.35 + smooth[i] * 1.3));
  }
  out[0] = 0;
  out[points - 1] = 0;
  return out;
}

/** Dry straw giving way: long ragged tail. */
const SHAPE_RUSTLE = buildShape(96, 0.04, 2.4, 0.55, 0x51ed270b);
/** Compacted hay or gravel underfoot: shorter, coarser, more violent flutter. */
const SHAPE_CRUNCH = buildShape(96, 0.02, 3.1, 0.72, 0x1a2b3c4d);
/** Clean percussive contour, no texture - for tonal layers. */
const SHAPE_SOFT = buildShape(64, 0.06, 2.2, 0, 0x2f6b9e11);
/** Slow rise and fall: whooshes, swells, distant thunder. */
const SHAPE_SWELL = buildShape(96, 0.45, 1.6, 0.22, 0x7c3f01a9);
/** Irregular, very long tail with secondary rumbles. */
const SHAPE_THUNDER = buildShape(128, 0.06, 1.15, 0.62, 0x0badf00d);

/**
 * `setValueCurveAtTime` copies the values array synchronously, so a scratch
 * buffer would be safe by spec - but a 96-float allocation is noise next to the
 * dozen AudioNodes a patch already allocates, and per-call arrays keep this
 * free of shared mutable state.
 */
function scaledCurve(shape: Float32Array, level: number): Float32Array {
  const out = new Float32Array(shape.length);
  for (let i = 0; i < shape.length; i++) out[i] = shape[i] * level;
  return out;
}

/* ------------------------------------------------------------ noise buffers */

type NoiseKind = 'white' | 'pink' | 'brown';

interface NoiseBuffers {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
}

/** Flat spectrum. Transients, ticks, rain, the top end of everything organic. */
function makeWhiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
  return buffer;
}

/**
 * -3 dB/octave, via Paul Kellet's economical filter bank. Pink is what natural
 * broadband sources actually look like, so it is the default for air rush and
 * anything that has to sit under the mix without hissing.
 */
function makePinkNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const white = random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return buffer;
}

/**
 * -6 dB/octave from a leaky integrator. Two decorrelated channels, because the
 * wind bed is the widest thing in the mix and a mono loop collapses the stereo
 * image the moment it fades up. Long enough that the loop point is not a
 * recognisable event.
 */
function makeBrownNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let last = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      last = (last + 0.02 * (random() * 2 - 1)) * 0.998;
      data[i] = last;
      const magnitude = Math.abs(last);
      if (magnitude > peak) peak = magnitude;
    }
    const norm = peak > 0 ? 0.9 / peak : 1;
    for (let i = 0; i < data.length; i++) data[i] *= norm;

    // Taper the seam so the loop wrap is a crossfade rather than a click.
    const fade = Math.min(2048, Math.floor(data.length / 8));
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      data[i] *= k;
      data[data.length - 1 - i] *= k;
    }
  }
  return buffer;
}

/**
 * A room, from first principles: an exponentially decaying burst of noise is a
 * perfectly serviceable impulse response, because that is essentially what a
 * measured one is once the early reflections have passed.
 *
 * Two refinements make it sound like a barn rather than a spring reverb - a
 * short pre-delay of silence so the dry signal reads as "close", and a one-pole
 * low-pass over the tail so the high frequencies die first, as they do in any
 * real space full of straw and timber.
 */
function makeImpulseResponse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const preDelay = Math.floor(ctx.sampleRate * 0.014);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let i = preDelay; i < length; i++) {
      const u = (i - preDelay) / (length - preDelay);
      low += ((random() * 2 - 1) - low) * 0.42;
      data[i] = low * Math.pow(1 - u, decay);
    }
    // A couple of discrete early reflections give the tail somewhere to start.
    for (const [offset, level] of [
      [0.017, 0.55],
      [0.029, 0.38],
      [0.047, 0.24],
    ] as const) {
      const index = preDelay + Math.floor(ctx.sampleRate * offset * (channel === 0 ? 1 : 1.13));
      if (index < length) data[index] += level * (random() * 2 - 1);
    }
  }
  return buffer;
}

/**
 * tanh soft-clip for the dig motor and the error buzz. Hard clipping would add
 * odd harmonics all the way to Nyquist and alias badly; tanh rolls off, and the
 * WaveShaper runs it at 2x oversampling anyway.
 */
function makeSaturationCurve(drive: number): Float32Array<ArrayBuffer> {
  const points = 1024;
  const curve = new Float32Array(points);
  const norm = Math.tanh(drive);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

/* ------------------------------------------------------------------- buses */

type BusName = 'sfx' | 'ui' | 'ambience' | 'music' | 'stinger';

const BUS_NAMES: readonly BusName[] = ['sfx', 'ui', 'ambience', 'music', 'stinger'];

/**
 * The mix graph, built once on unlock.
 *
 *   sfx ---+
 *   ui  ---+
 *   amb ---+--> duck --+
 *   mus ---+           +--> master --> compressor --> destination
 *   stinger -----------+
 *   reverb return -----+
 *
 * `stinger` carries the celebration sounds and deliberately bypasses the duck
 * node, so `play('needle_found')` can flatten the rest of the mix underneath
 * itself without also flattening itself. The reverb return bypasses the duck
 * for the same reason in reverse: tails are already low-level, and pulling them
 * down makes the duck audible as the room briefly vanishing.
 */
interface AudioGraph {
  ctx: AudioContext;
  compressor: DynamicsCompressorNode;
  master: GainNode;
  duck: GainNode;
  buses: Record<BusName, GainNode>;
  /** Gates generative music on and off without touching the user volume. */
  musicFade: GainNode;
  reverb: ConvolverNode;
  /** Wet return, kept only so `dispose` can unwire it explicitly. */
  reverbReturn: GainNode;
  noise: NoiseBuffers;
  /**
   * `WaveShaperNode.curve` insists on a Float32Array over a plain ArrayBuffer
   * rather than the SharedArrayBuffer-permitting default, so the backing store
   * has to be pinned down in the type.
   */
  saturation: Float32Array<ArrayBuffer>;
}

function buildGraph(ctx: AudioContext): AudioGraph {
  const compressor = ctx.createDynamicsCompressor();
  // Gentle bus glue, not a limiter: a 4:1 ratio with a soft knee catches the
  // moment six straws, a footstep and a coin land on the same frame without
  // audibly pumping the wind bed.
  compressor.threshold.value = -14;
  compressor.knee.value = 26;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.22;
  compressor.connect(ctx.destination);

  const master = ctx.createGain();
  master.connect(compressor);

  const duck = ctx.createGain();
  duck.gain.value = 1;
  duck.connect(master);

  const buses = {} as Record<BusName, GainNode>;
  for (const name of BUS_NAMES) {
    const bus = ctx.createGain();
    bus.connect(name === 'stinger' ? master : duck);
    buses[name] = bus;
  }

  const musicFade = ctx.createGain();
  musicFade.gain.value = 0;
  musicFade.connect(buses.music);

  const reverb = ctx.createConvolver();
  reverb.normalize = true;
  reverb.buffer = makeImpulseResponse(ctx, 2.1, 2.6);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.85;
  reverb.connect(reverbReturn);
  reverbReturn.connect(master);

  return {
    ctx,
    compressor,
    master,
    duck,
    buses,
    musicFade,
    reverb,
    reverbReturn,
    noise: {
      white: makeWhiteNoise(ctx, 2),
      pink: makePinkNoise(ctx, 2),
      brown: makeBrownNoise(ctx, 6),
    },
    saturation: makeSaturationCurve(2.6),
  };
}

/* ------------------------------------------------------------------ voices */

/**
 * One playing sound, however many nodes it took to build.
 *
 * The voice owns every node it created so that cleanup is a single loop rather
 * than a web of individual `onended` handlers, each of which would have to know
 * about its neighbours. Sources decrement `pending` as they finish; the last
 * one out turns off the lights.
 */
class Voice {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  pending = 0;
  endTime = 0;
  retired = false;
  /**
   * Stopping, but not yet gone. An evicted voice lives on for the ~25 ms of its
   * fade-out and only disappears when `ended` arrives, so it must stop counting
   * against the budget the moment it is condemned - otherwise a burst of sounds
   * in a single frame condemns the same voice over and over and the active list
   * grows without limit.
   */
  evicting = false;

  constructor(
    readonly out: GainNode,
    /** Post-distance level, used to choose an eviction victim. */
    readonly level: number,
    readonly startedAt: number,
    /** Music, ambience beds and stingers are never stolen by gameplay SFX. */
    readonly protectedVoice: boolean,
  ) {}

  register(node: AudioNode): void {
    this.nodes.push(node);
  }

  /** Adds a source and wires its self-cleanup. */
  addSource(source: AudioScheduledSourceNode): void {
    this.sources.push(source);
    this.nodes.push(source);
    this.pending++;
    source.onended = () => {
      this.pending--;
      if (this.pending <= 0) this.retire();
    };
  }

  /** Fade out and stop early - used when the voice budget is exhausted. */
  evict(now: number): void {
    if (this.retired || this.evicting) return;
    this.evicting = true;
    const gain = this.out.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + 0.02);
    for (const source of this.sources) {
      try {
        source.stop(now + 0.025);
      } catch {
        // Already stopped; its ended handler will retire us.
      }
    }
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
    this.out.disconnect();
  }
}

/**
 * The construction kit handed to every sound recipe.
 *
 * Recipes never touch the AudioContext directly; they ask the patch for nodes,
 * which guarantees that everything they build is registered for cleanup and
 * that every source is started and stopped exactly once.
 */
class Patch {
  constructor(
    private readonly graph: AudioGraph,
    /** Absolute context time at which this sound begins. */
    readonly t0: number,
    private readonly voice: Voice,
    /** Pitch multiplier, detune already folded in. */
    readonly rate: number,
    /**
     * The requested loudness, 0..1. Already applied to the output gain -
     * recipes read it only to make timbral decisions, e.g. a harder landing
     * being brighter as well as louder.
     */
    readonly volume: number,
  ) {}

  /** The node every layer should connect into. */
  get out(): GainNode {
    return this.voice.out;
  }

  osc(type: OscillatorType, freq: number, start: number, end: number): OscillatorNode {
    const osc = this.graph.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = Math.max(0.01, freq);
    this.voice.addSource(osc);
    osc.start(start);
    osc.stop(Math.max(start + 0.005, end));
    this.extend(end);
    return osc;
  }

  /**
   * A window onto one of the shared noise buffers. The start offset is random,
   * so ten footsteps in a row are ten different slices of noise rather than the
   * same 90 ms replayed - without that, repeated hits phase against each other
   * and the ear starts hearing a sample instead of a material.
   */
  noise(kind: NoiseKind, start: number, end: number, playbackRate = 1): AudioBufferSourceNode {
    const buffer = this.graph.noise[kind];
    const source = this.graph.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = clamp(playbackRate, 0.05, 8);
    this.voice.addSource(source);
    source.start(start, random() * buffer.duration);
    source.stop(Math.max(start + 0.005, end));
    this.extend(end);
    return source;
  }

  gain(value = 0): GainNode {
    const node = this.graph.ctx.createGain();
    node.gain.value = value;
    this.voice.register(node);
    return node;
  }

  biquad(type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
    const node = this.graph.ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = clamp(freq, 10, 20000);
    node.Q.value = q;
    this.voice.register(node);
    return node;
  }

  shaper(): WaveShaperNode {
    const node = this.graph.ctx.createWaveShaper();
    node.curve = this.graph.saturation;
    node.oversample = '2x';
    this.voice.register(node);
    return node;
  }

  /** Keeps the voice alive at least until `time`. */
  extend(time: number): void {
    if (time > this.voice.endTime) this.voice.endTime = time;
  }
}

/* ------------------------------------------------- synthesis building blocks */

interface BurstOptions {
  /** Offset from the patch start. */
  at?: number;
  kind?: NoiseKind;
  type?: BiquadFilterType;
  freq: number;
  /** Sweep the filter here by the end of the burst. */
  toFreq?: number;
  q?: number;
  level: number;
  attack?: number;
  decay?: number;
  /** Amplitude contour; replaces the attack/decay envelope when given. */
  shape?: Float32Array;
  playbackRate?: number;
}

/**
 * A band-passed noise burst: the workhorse behind every organic sound here.
 *
 * The filter is the material. Where the band sits decides whether the ear hears
 * grass (bright, ~2 kHz), dirt (mid, ~700 Hz) or a body impact (~120 Hz), and
 * sweeping it downward across the burst reproduces the way a real impact loses
 * its high modes first.
 */
function burst(p: Patch, o: BurstOptions): GainNode {
  const attack = o.attack ?? 0.004;
  const decay = o.decay ?? 0.12;
  const duration = attack + decay;
  const start = p.t0 + (o.at ?? 0);
  const source = p.noise(o.kind ?? 'white', start, start + duration + 0.02, o.playbackRate ?? 1);
  const filter = p.biquad(o.type ?? 'bandpass', o.freq, o.q ?? 1);
  if (o.toFreq !== undefined) {
    filter.frequency.setValueAtTime(clamp(o.freq, 10, 20000), start);
    filter.frequency.exponentialRampToValueAtTime(clamp(o.toFreq, 10, 20000), start + duration);
  }
  const amp = p.gain(0);
  source.connect(filter);
  filter.connect(amp);
  amp.connect(p.out);
  if (o.shape) {
    // No other automation may touch this param inside the curve window, so the
    // gain node initial value of 0 is what holds it silent beforehand.
    amp.gain.setValueCurveAtTime(scaledCurve(o.shape, o.level), start, duration);
  } else {
    adEnvelope(amp.gain, start, o.level, attack, decay);
  }
  p.extend(start + duration);
  return amp;
}

interface ToneOptions {
  at?: number;
  type?: OscillatorType;
  freq: number;
  /** Glide to this frequency over `glide` seconds. */
  toFreq?: number;
  glide?: number;
  level: number;
  attack?: number;
  decay?: number;
  /** Sustain-style envelope instead of a percussive one. */
  hold?: number;
  release?: number;
  detuneCents?: number;
}

/** A single enveloped oscillator. Returns its amp node for further routing. */
function tone(p: Patch, o: ToneOptions): GainNode {
  const start = p.t0 + (o.at ?? 0);
  const attack = o.attack ?? 0.004;
  const amp = p.gain(0);
  let end: number;
  if (o.hold !== undefined || o.release !== undefined) {
    end = asrEnvelope(amp.gain, start, o.level, attack, o.hold ?? 0, o.release ?? 0.3);
  } else {
    end = adEnvelope(amp.gain, start, o.level, attack, o.decay ?? 0.2);
  }
  const osc = p.osc(o.type ?? 'sine', o.freq, start, end + 0.02);
  if (o.detuneCents) osc.detune.value = o.detuneCents;
  if (o.toFreq !== undefined) {
    osc.frequency.setValueAtTime(Math.max(0.01, o.freq), start);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(0.01, o.toFreq),
      start + (o.glide ?? Math.min(0.08, end - start)),
    );
  }
  osc.connect(amp);
  amp.connect(p.out);
  return amp;
}

interface FmOptions {
  at?: number;
  /** Carrier frequency - the pitch you actually hear. */
  carrier: number;
  /** Modulator:carrier frequency ratio. Non-integers give inharmonic metal. */
  ratio: number;
  /** Peak modulation index; how far the modulator swings the carrier. */
  index: number;
  /** Seconds for the index to collapse. Short = bright strike, pure ring. */
  indexDecay?: number;
  level: number;
  attack?: number;
  decay?: number;
  /** Multiply the carrier by this over `dropTime` - the plink of a coin. */
  drop?: number;
  dropTime?: number;
}

/**
 * Two-operator FM, the reason coins and bells here sound struck rather than
 * beeped.
 *
 * A modulator at a non-integer ratio scatters sidebands at frequencies that are
 * not multiples of the carrier, which is precisely what a vibrating metal disc
 * does. Decaying the modulation index much faster than the amplitude reproduces
 * the physics of the strike: the high inharmonic modes shed energy first,
 * leaving a near-sine ring behind.
 */
function fmTone(p: Patch, o: FmOptions): GainNode {
  const start = p.t0 + (o.at ?? 0);
  const attack = o.attack ?? 0.002;
  const decay = o.decay ?? 0.4;
  const amp = p.gain(0);
  const end = adEnvelope(amp.gain, start, o.level, attack, decay);

  const carrier = p.osc('sine', o.carrier, start, end + 0.02);
  const modulator = p.osc('sine', o.carrier * o.ratio, start, end + 0.02);
  const modDepth = p.gain(0);

  // The index is expressed in carrier-widths so a bell keeps its character when
  // the same patch is transposed.
  const peak = o.index * o.carrier;
  const indexDecay = o.indexDecay ?? Math.min(decay * 0.35, 0.25);
  modDepth.gain.setValueAtTime(peak, start);
  modDepth.gain.exponentialRampToValueAtTime(Math.max(peak * 0.02, 1), start + indexDecay);

  modulator.connect(modDepth);
  modDepth.connect(carrier.frequency);
  carrier.connect(amp);
  amp.connect(p.out);

  if (o.drop !== undefined) {
    const dropTime = o.dropTime ?? 0.05;
    carrier.frequency.setValueAtTime(o.carrier, start);
    carrier.frequency.exponentialRampToValueAtTime(
      Math.max(0.01, o.carrier * o.drop),
      start + dropTime,
    );
  }
  return amp;
}

/**
 * Modal wood: two high-Q band-passed noise bursts at fixed ratios.
 *
 * A struck wooden handle rings at a handful of sharp resonances for a few tens
 * of milliseconds. Exciting a very resonant filter with noise is the cheapest
 * honest model of that - the noise is the strike, the filter is the timber.
 */
function woodKnock(p: Patch, at: number, freq: number, level: number): void {
  burst(p, { at, freq, q: 14, level, attack: 0.001, decay: 0.1, kind: 'white' });
  burst(p, { at, freq: freq * 1.87, q: 11, level: level * 0.5, attack: 0.001, decay: 0.07 });
  burst(p, { at, freq: freq * 0.6, q: 6, level: level * 0.7, attack: 0.001, decay: 0.13 });
}

/* ---------------------------------------------------------- sound recipes */

interface SoundSpec {
  bus: BusName;
  /** Base level before the caller volume. Hand-balanced against each other. */
  gain: number;
  /** Default symmetric pitch jitter in semitones. */
  detune: number;
  /** How much of this voice is fed to the shared convolver. */
  reverb: number;
  /** Nominal length, used for voice bookkeeping before the patch is built. */
  tail: number;
  build(p: Patch): void;
}

/**
 * The whole sound palette.
 *
 * Levels here are the mix. Resist the urge to "fix" a sound by turning it up in
 * the caller - if a coin is drowning out a footstep, the coin gain belongs in
 * this table where it can be compared against everything else.
 */
const SOUNDS: Record<SoundName, SoundSpec> = {
  /**
   * Hands into hay. Three layers: a dull low compression thump as the hand
   * displaces the pile, the broadband rustle of the straw itself (band-pass
   * sweeping down as the motion slows), and a short trailing rustle for the
   * hand coming back out. The rustle contour carries the flutter that makes it
   * read as thousands of stalks rather than one whoosh.
   */
  dig_soft: {
    bus: 'sfx',
    gain: 0.55,
    detune: 2.5,
    reverb: 0.1,
    tail: 0.5,
    build(p) {
      burst(p, {
        kind: 'brown',
        type: 'lowpass',
        freq: 270 * p.rate,
        q: 0.8,
        level: 0.55,
        attack: 0.006,
        decay: 0.17,
      });
      burst(p, {
        type: 'bandpass',
        freq: 2500 * p.rate,
        toFreq: 780 * p.rate,
        q: 0.85,
        level: 0.5,
        shape: SHAPE_RUSTLE,
        attack: 0.006,
        decay: 0.3,
      });
      burst(p, {
        at: 0.07,
        type: 'highpass',
        freq: 3100 * p.rate,
        q: 0.5,
        level: 0.14,
        shape: SHAPE_RUSTLE,
        attack: 0.01,
        decay: 0.22,
      });
    },
  },

  /**
   * Pitchfork or rake. Same rustle family as `dig_soft` but with a real impact
   * in front of it: a modal wooden knock for the handle, a short pitched thump
   * for the shaft, and a faint high FM ping for the steel tines.
   */
  dig_hard: {
    bus: 'sfx',
    gain: 0.62,
    detune: 2,
    reverb: 0.14,
    tail: 0.6,
    build(p) {
      woodKnock(p, 0, 195 * p.rate, 0.45);
      tone(p, {
        type: 'triangle',
        freq: 155 * p.rate,
        toFreq: 92 * p.rate,
        glide: 0.05,
        level: 0.3,
        attack: 0.002,
        decay: 0.1,
      });
      burst(p, {
        type: 'bandpass',
        freq: 1500 * p.rate,
        toFreq: 520 * p.rate,
        q: 0.9,
        level: 0.42,
        shape: SHAPE_CRUNCH,
        attack: 0.003,
        decay: 0.26,
      });
      fmTone(p, {
        at: 0.004,
        carrier: 3200 * p.rate,
        ratio: 2.74,
        index: 1.4,
        level: 0.05,
        decay: 0.12,
      });
    },
  },

  /**
   * A single "poke" of the continuous-tool texture, for callers that want one
   * hit. The held version - what the blower and vacuum actually use - lives in
   * `setLoop`, which keeps its oscillators running instead of respawning them.
   */
  dig_loop: {
    bus: 'sfx',
    gain: 0.4,
    detune: 1,
    reverb: 0.08,
    tail: 0.45,
    build(p) {
      const motor = tone(p, {
        type: 'sawtooth',
        freq: 78 * p.rate,
        level: 0.3,
        attack: 0.02,
        hold: 0.14,
        release: 0.12,
      });
      const lp = p.biquad('lowpass', 520 * p.rate, 4);
      motor.disconnect();
      motor.connect(lp);
      lp.connect(p.out);
      burst(p, {
        kind: 'pink',
        type: 'bandpass',
        freq: 1500 * p.rate,
        q: 0.7,
        level: 0.3,
        shape: SHAPE_SWELL,
        attack: 0.03,
        decay: 0.3,
      });
    },
  },

  /**
   * Straws whipping into the backpack. A handful of tiny high band-passed ticks
   * scattered over ~100 ms with rising pitch reads as several light objects
   * arriving, where a single burst reads as one. The papery swish underneath
   * glues them together.
   */
  straw_collect: {
    bus: 'sfx',
    gain: 0.42,
    detune: 3,
    reverb: 0.12,
    tail: 0.3,
    build(p) {
      const count = randInt(3, 5);
      for (let i = 0; i < count; i++) {
        burst(p, {
          at: i * randRange(0.018, 0.032),
          freq: (3000 + i * 700) * p.rate * randRange(0.9, 1.15),
          q: 2.4,
          level: 0.22,
          attack: 0.001,
          decay: 0.035,
        });
      }
      burst(p, {
        type: 'highpass',
        freq: 1700 * p.rate,
        q: 0.5,
        level: 0.16,
        shape: SHAPE_RUSTLE,
        attack: 0.008,
        decay: 0.15,
      });
    },
  },

  /**
   * Hay in, money out. A rising band-passed whoosh delivers the load, then the
   * register answers: a wooden drawer clack, a low body thump, and two FM bells
   * a beat apart. Real tills ring twice, and the second, quieter, slightly
   * detuned strike is most of why this reads as a cash register.
   */
  sell: {
    bus: 'sfx',
    gain: 0.6,
    detune: 0.8,
    reverb: 0.28,
    tail: 1.3,
    build(p) {
      burst(p, {
        kind: 'pink',
        type: 'bandpass',
        freq: 360 * p.rate,
        toFreq: 2700 * p.rate,
        q: 0.9,
        level: 0.4,
        shape: SHAPE_SWELL,
        attack: 0.02,
        decay: 0.24,
      });
      woodKnock(p, 0.2, 240, 0.28);
      tone(p, { at: 0.2, freq: 138, level: 0.28, attack: 0.002, decay: 0.13 });
      fmTone(p, {
        at: 0.22,
        carrier: 2050 * p.rate,
        ratio: 1.51,
        index: 2.6,
        indexDecay: 0.05,
        level: 0.3,
        decay: 0.55,
      });
      fmTone(p, {
        at: 0.22,
        carrier: 3080 * p.rate,
        ratio: 1.51,
        index: 1.8,
        indexDecay: 0.04,
        level: 0.14,
        decay: 0.4,
      });
      fmTone(p, {
        at: 0.31,
        carrier: 2035 * p.rate,
        ratio: 1.49,
        index: 2.2,
        indexDecay: 0.05,
        level: 0.2,
        decay: 0.7,
      });
    },
  },

  /**
   * A coin. Two detuned sine partials a fifth-and-a-bit apart, each dropping
   * ~7% in pitch over the first 35 ms, which is the tiny downward chirp a small
   * disc makes as it settles. The FM component supplies the metallic edge; the
   * noise tick is the contact itself.
   */
  coin: {
    bus: 'sfx',
    gain: 0.4,
    detune: 0.7,
    reverb: 0.2,
    tail: 0.7,
    build(p) {
      fmTone(p, {
        carrier: 1760 * p.rate,
        ratio: 3.71,
        index: 1.9,
        indexDecay: 0.025,
        level: 0.26,
        decay: 0.34,
        drop: 0.93,
        dropTime: 0.035,
      });
      tone(p, {
        freq: 2644 * p.rate,
        toFreq: 2470 * p.rate,
        glide: 0.035,
        level: 0.13,
        attack: 0.002,
        decay: 0.28,
        detuneCents: 9,
      });
      burst(p, { freq: 5200 * p.rate, q: 1.6, level: 0.1, attack: 0.001, decay: 0.03 });
    },
  },

  /** Upgrade bought: a bright three-note lift with a shimmer on the landing. */
  purchase: {
    bus: 'sfx',
    gain: 0.45,
    detune: 0,
    reverb: 0.3,
    tail: 1.1,
    build(p) {
      const steps = [660, 880, 1320];
      for (let i = 0; i < steps.length; i++) {
        const at = i * 0.075;
        tone(p, {
          at,
          type: 'triangle',
          freq: steps[i] * p.rate,
          level: 0.22,
          attack: 0.004,
          decay: 0.2 + i * 0.14,
        });
        tone(p, {
          at,
          freq: steps[i] * 2 * p.rate,
          level: 0.07,
          attack: 0.003,
          decay: 0.12 + i * 0.08,
        });
      }
      fmTone(p, {
        at: 0.15,
        carrier: 2640 * p.rate,
        ratio: 2.01,
        index: 1.2,
        indexDecay: 0.08,
        level: 0.1,
        decay: 0.6,
      });
      burst(p, {
        at: 0.14,
        freq: 6000,
        q: 2,
        level: 0.05,
        shape: SHAPE_SWELL,
        attack: 0.02,
        decay: 0.3,
      });
    },
  },

  /**
   * Cannot afford it. Deliberately dull - a low square through a tight low-pass
   * so it lands as a soft "no" rather than an alarm. Two blips, because one
   * short blip is ambiguous and three is nagging.
   */
  denied: {
    bus: 'ui',
    gain: 0.4,
    detune: 0,
    reverb: 0.05,
    tail: 0.3,
    build(p) {
      for (const [at, freq] of [
        [0, 178],
        [0.105, 149],
      ] as const) {
        const amp = tone(p, {
          at,
          type: 'square',
          freq: freq * p.rate,
          level: 0.22,
          attack: 0.006,
          decay: 0.075,
        });
        const lp = p.biquad('lowpass', 720, 1.1);
        amp.disconnect();
        amp.connect(lp);
        lp.connect(p.out);
        burst(p, { at, type: 'lowpass', freq: 420, level: 0.1, attack: 0.003, decay: 0.05 });
      }
    },
  },

  /** Barely there. Hover fires constantly, so it must never draw attention. */
  ui_hover: {
    bus: 'ui',
    gain: 0.22,
    detune: 0.6,
    reverb: 0.04,
    tail: 0.12,
    build(p) {
      tone(p, { freq: 1520 * p.rate, level: 0.18, attack: 0.002, decay: 0.038 });
      burst(p, { freq: 4200 * p.rate, q: 2, level: 0.05, attack: 0.001, decay: 0.018 });
    },
  },

  ui_click: {
    bus: 'ui',
    gain: 0.32,
    detune: 0.4,
    reverb: 0.05,
    tail: 0.18,
    build(p) {
      tone(p, { freq: 880 * p.rate, level: 0.24, attack: 0.001, decay: 0.055 });
      tone(p, { freq: 1760 * p.rate, level: 0.1, attack: 0.001, decay: 0.032 });
      burst(p, { freq: 3000 * p.rate, q: 1.4, level: 0.16, attack: 0.0008, decay: 0.02 });
    },
  },

  /** Panel opens: everything moves upward - filter sweep and pitch glide alike. */
  ui_open: {
    bus: 'ui',
    gain: 0.34,
    detune: 0,
    reverb: 0.12,
    tail: 0.45,
    build(p) {
      burst(p, {
        kind: 'pink',
        freq: 520 * p.rate,
        toFreq: 2700 * p.rate,
        q: 1.1,
        level: 0.26,
        shape: SHAPE_SWELL,
        attack: 0.02,
        decay: 0.16,
      });
      tone(p, {
        type: 'triangle',
        freq: 420 * p.rate,
        toFreq: 690 * p.rate,
        glide: 0.13,
        level: 0.13,
        attack: 0.012,
        decay: 0.2,
      });
    },
  },

  ui_close: {
    bus: 'ui',
    gain: 0.32,
    detune: 0,
    reverb: 0.1,
    tail: 0.4,
    build(p) {
      burst(p, {
        kind: 'pink',
        freq: 2500 * p.rate,
        toFreq: 480 * p.rate,
        q: 1.1,
        level: 0.24,
        shape: SHAPE_SWELL,
        attack: 0.015,
        decay: 0.15,
      });
      tone(p, {
        type: 'triangle',
        freq: 690 * p.rate,
        toFreq: 390 * p.rate,
        glide: 0.11,
        level: 0.12,
        attack: 0.01,
        decay: 0.17,
      });
    },
  },

  /**
   * Grass. A bright band centred around 1.9 kHz sweeping down, with a small
   * low-passed thud for the boot itself. No oscillator anywhere: a footstep has
   * no pitch, and the moment you give it one it stops being a footstep.
   */
  footstep_grass: {
    bus: 'sfx',
    gain: 0.34,
    detune: 3,
    reverb: 0.08,
    tail: 0.25,
    build(p) {
      burst(p, {
        freq: 1950 * p.rate,
        toFreq: 900 * p.rate,
        q: 1.1,
        level: 0.5,
        shape: SHAPE_RUSTLE,
        attack: 0.003,
        decay: 0.11,
      });
      burst(p, { type: 'lowpass', freq: 135, level: 0.3, attack: 0.003, decay: 0.07 });
    },
  },

  /**
   * On the pile itself. Softer and crunchier than grass: the low body is
   * bigger (deep hay swallows the impact), the bright layer is coarser and runs
   * longer, and a couple of stray ticks fire late as loose straw settles.
   */
  footstep_hay: {
    bus: 'sfx',
    gain: 0.36,
    detune: 3,
    reverb: 0.08,
    tail: 0.35,
    build(p) {
      burst(p, {
        freq: 2600 * p.rate,
        toFreq: 1150 * p.rate,
        q: 0.8,
        level: 0.45,
        shape: SHAPE_CRUNCH,
        attack: 0.004,
        decay: 0.17,
      });
      burst(p, {
        kind: 'brown',
        type: 'lowpass',
        freq: 215,
        q: 0.7,
        level: 0.42,
        attack: 0.005,
        decay: 0.12,
      });
      for (let i = 0; i < 2; i++) {
        burst(p, {
          at: randRange(0.05, 0.16),
          freq: randRange(2600, 5200) * p.rate,
          q: 3,
          level: 0.07,
          attack: 0.001,
          decay: 0.025,
        });
      }
    },
  },

  /** Dry packed earth: mid-heavy, short, with a little grit on top. */
  footstep_dirt: {
    bus: 'sfx',
    gain: 0.34,
    detune: 3,
    reverb: 0.06,
    tail: 0.25,
    build(p) {
      burst(p, {
        freq: 720 * p.rate,
        toFreq: 380 * p.rate,
        q: 0.8,
        level: 0.45,
        shape: SHAPE_SOFT,
        attack: 0.002,
        decay: 0.09,
      });
      burst(p, { type: 'lowpass', freq: 98, level: 0.45, attack: 0.003, decay: 0.09 });
      burst(p, {
        at: 0.012,
        freq: 3100 * p.rate,
        q: 2.2,
        level: 0.07,
        attack: 0.001,
        decay: 0.03,
      });
    },
  },

  /** Push-off: an upward air sweep plus the rustle of clothing. */
  jump: {
    bus: 'sfx',
    gain: 0.34,
    detune: 2,
    reverb: 0.08,
    tail: 0.35,
    build(p) {
      burst(p, {
        kind: 'pink',
        freq: 330 * p.rate,
        toFreq: 1150 * p.rate,
        q: 0.9,
        level: 0.3,
        shape: SHAPE_SWELL,
        attack: 0.015,
        decay: 0.13,
      });
      tone(p, {
        type: 'triangle',
        freq: 215 * p.rate,
        toFreq: 330 * p.rate,
        glide: 0.1,
        level: 0.1,
        attack: 0.008,
        decay: 0.12,
      });
      burst(p, {
        at: 0.02,
        type: 'highpass',
        freq: 2600,
        level: 0.08,
        shape: SHAPE_RUSTLE,
        attack: 0.005,
        decay: 0.12,
      });
    },
  },

  /**
   * Landing, scaled by impact. Volume does double duty here: it sets the level
   * as usual, but the recipe also reads it to open the crunch layer filter, so
   * a heavy landing is brighter and grittier as well as louder - which is what
   * separates a stumble from a drop off the top of the stack.
   */
  land: {
    bus: 'sfx',
    gain: 0.5,
    detune: 1.5,
    reverb: 0.12,
    tail: 0.5,
    build(p) {
      burst(p, {
        kind: 'brown',
        type: 'lowpass',
        freq: 95,
        q: 0.9,
        level: 0.6,
        attack: 0.004,
        decay: 0.17,
      });
      tone(p, { freq: 74, toFreq: 52, glide: 0.09, level: 0.22, attack: 0.003, decay: 0.14 });
      burst(p, {
        freq: lerp(700, 2700, p.volume) * p.rate,
        toFreq: lerp(420, 900, p.volume),
        q: 0.9,
        level: 0.14 + 0.28 * p.volume,
        shape: SHAPE_CRUNCH,
        attack: 0.003,
        decay: 0.14,
      });
    },
  },

  /**
   * A buried oddity comes up. Warm rather than bright: an FM core at a near-
   * octave ratio (2.01 - just off, which beats slowly and sounds enchanted
   * instead of merely tuned), a slow four-note rise, and a high shimmer band.
   */
  treasure: {
    bus: 'sfx',
    gain: 0.5,
    detune: 0,
    reverb: 0.5,
    tail: 2.2,
    build(p) {
      fmTone(p, {
        carrier: 523 * p.rate,
        ratio: 2.01,
        index: 3.4,
        indexDecay: 0.35,
        level: 0.22,
        attack: 0.01,
        decay: 1.2,
      });
      const ladder = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < ladder.length; i++) {
        tone(p, {
          at: 0.09 * i,
          freq: ladder[i] * p.rate,
          level: 0.12,
          attack: 0.012,
          decay: 0.85 + i * 0.12,
        });
      }
      tone(p, {
        type: 'triangle',
        freq: 130.8 * p.rate,
        level: 0.11,
        attack: 0.06,
        hold: 0.25,
        release: 0.9,
      });
      burst(p, {
        at: 0.04,
        freq: 5200,
        q: 3,
        level: 0.05,
        shape: SHAPE_SWELL,
        attack: 0.15,
        decay: 0.7,
      });
    },
  },

  /**
   * The moment the whole game is named after, so it gets two movements.
   *
   * First a rising sparkle: fourteen short FM pings climbing a pentatonic
   * ladder on an accelerating schedule (t proportional to i^1.35), under a
   * band-passed noise sweep from 400 Hz to 5 kHz. Acceleration is what makes a
   * rise feel like it is *going* somewhere; evenly spaced pings sound like a
   * scale exercise.
   *
   * Then, at 0.85 s, the payoff: an A major add9 stack played on detuned saw
   * and triangle pairs through a filter that opens on the attack and slowly
   * closes over the release, plus bell partials on the root and fifth and a
   * soft low drum. Routed to the stinger bus so the automatic duck clears the
   * rest of the mix underneath it without touching this.
   */
  needle_found: {
    bus: 'stinger',
    gain: 0.55,
    detune: 0,
    reverb: 0.6,
    tail: 4,
    build(p) {
      const ladder = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96, 98, 100, 103];
      for (let i = 0; i < ladder.length; i++) {
        fmTone(p, {
          at: 0.85 * Math.pow(i / (ladder.length - 1), 1.35),
          carrier: midiToFreq(ladder[i]),
          ratio: 3.01,
          index: 1.6,
          indexDecay: 0.03,
          level: 0.07 + 0.05 * (i / ladder.length),
          decay: 0.3,
        });
      }
      burst(p, {
        kind: 'pink',
        freq: 400,
        toFreq: 5200,
        q: 1.2,
        level: 0.16,
        shape: SHAPE_SWELL,
        attack: 0.4,
        decay: 0.45,
      });

      const chord = [55, 59, 62, 66, 69, 74, 78];
      for (let i = 0; i < chord.length; i++) {
        const freq = midiToFreq(chord[i]);
        const amp = p.gain(0);
        const end = asrEnvelope(amp.gain, p.t0 + 0.85, 0.1, 0.02, 0.55, 2.3);
        const filter = p.biquad('lowpass', 400, 1.4);
        filter.frequency.setValueAtTime(500, p.t0 + 0.85);
        filter.frequency.exponentialRampToValueAtTime(3600, p.t0 + 1.05);
        filter.frequency.exponentialRampToValueAtTime(700, end);
        for (const [type, cents, level] of [
          ['sawtooth', -7, 0.55],
          ['sawtooth', 7, 0.55],
          ['triangle', 0, 1],
        ] as const) {
          const osc = p.osc(type, freq, p.t0 + 0.85, end + 0.02);
          osc.detune.value = cents;
          const trim = p.gain(level);
          osc.connect(trim);
          trim.connect(filter);
        }
        filter.connect(amp);
        amp.connect(p.out);
      }
      fmTone(p, {
        at: 0.85,
        carrier: midiToFreq(81),
        ratio: 2.005,
        index: 2.2,
        indexDecay: 0.12,
        level: 0.12,
        decay: 2.2,
      });
      fmTone(p, {
        at: 0.87,
        carrier: midiToFreq(88),
        ratio: 3.02,
        index: 1.4,
        indexDecay: 0.08,
        level: 0.07,
        decay: 1.8,
      });
      burst(p, {
        at: 0.85,
        kind: 'brown',
        type: 'lowpass',
        freq: 90,
        level: 0.35,
        attack: 0.005,
        decay: 0.5,
      });
    },
  },

  /**
   * Metal detector. `rate` is the proximity mapping - the caller raises it as
   * the player closes on the target and controls how often this fires, since
   * repeat rate carries proximity information at least as well as pitch does.
   * The small upward glide inside each blip is what makes it read as a "ping"
   * rather than a beep.
   */
  detector_ping: {
    bus: 'sfx',
    gain: 0.3,
    detune: 0,
    reverb: 0.15,
    tail: 0.3,
    build(p) {
      tone(p, {
        freq: 780 * p.rate,
        toFreq: 830 * p.rate,
        glide: 0.05,
        level: 0.28,
        attack: 0.004,
        decay: 0.13,
      });
      tone(p, { freq: 1560 * p.rate, level: 0.07, attack: 0.003, decay: 0.07 });
      burst(p, { freq: 2400 * p.rate, q: 2.5, level: 0.05, attack: 0.001, decay: 0.02 });
    },
  },

  /** New tier: a stacked-fifths climb with a bell on top and a low root under it. */
  tier_unlock: {
    bus: 'stinger',
    gain: 0.5,
    detune: 0,
    reverb: 0.45,
    tail: 2.4,
    build(p) {
      const notes = [392, 523.25, 659.25, 783.99];
      for (let i = 0; i < notes.length; i++) {
        fmTone(p, {
          at: i * 0.095,
          carrier: notes[i],
          ratio: 2.002,
          index: 1.5,
          indexDecay: 0.06,
          level: 0.16,
          decay: 0.6 + i * 0.3,
        });
      }
      tone(p, {
        type: 'triangle',
        freq: 98,
        level: 0.16,
        attack: 0.02,
        hold: 0.3,
        release: 1.1,
      });
      burst(p, {
        kind: 'pink',
        freq: 1400,
        toFreq: 4200,
        q: 1,
        level: 0.1,
        shape: SHAPE_SWELL,
        attack: 0.2,
        decay: 0.4,
      });
    },
  },

  /** Quest done: a compact major triad resolving up, with a warm tail. */
  quest_complete: {
    bus: 'stinger',
    gain: 0.45,
    detune: 0,
    reverb: 0.4,
    tail: 2,
    build(p) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i++) {
        const last = i === notes.length - 1;
        tone(p, {
          at: i * 0.085,
          type: 'triangle',
          freq: notes[i],
          level: 0.16,
          attack: 0.006,
          hold: last ? 0.35 : 0.05,
          release: last ? 1.2 : 0.35,
        });
        tone(p, { at: i * 0.085, freq: notes[i] * 2, level: 0.04, attack: 0.005, decay: 0.3 });
      }
      tone(p, { freq: 130.81, type: 'triangle', level: 0.12, attack: 0.03, hold: 0.4, release: 1 });
    },
  },

  /**
   * Rebirth: a gong. FM at ratio 1.41 (near the square root of two, deliberately
   * irrational-sounding) with a very high starting index gives the dense
   * inharmonic clang of struck bronze, and a slow index collapse over more than
   * a second lets it bloom the way a real gong does rather than simply decaying.
   * A sub sine and an open fifth carry the ceremony.
   */
  rebirth: {
    bus: 'stinger',
    gain: 0.6,
    detune: 0,
    reverb: 0.7,
    tail: 5,
    build(p) {
      fmTone(p, {
        carrier: 82.41,
        ratio: 1.41,
        index: 8.5,
        indexDecay: 1.3,
        level: 0.3,
        attack: 0.015,
        decay: 3.6,
      });
      fmTone(p, {
        at: 0.06,
        carrier: 123.47,
        ratio: 1.87,
        index: 5,
        indexDecay: 0.9,
        level: 0.15,
        attack: 0.02,
        decay: 3,
      });
      tone(p, { freq: 41.2, level: 0.26, attack: 0.06, hold: 0.6, release: 2.6 });
      burst(p, {
        kind: 'brown',
        freq: 320,
        toFreq: 900,
        q: 0.8,
        level: 0.12,
        shape: SHAPE_SWELL,
        attack: 0.6,
        decay: 1.4,
      });
      fmTone(p, {
        at: 1.1,
        carrier: 987.77,
        ratio: 2.41,
        index: 1.2,
        indexDecay: 0.4,
        level: 0.05,
        attack: 0.4,
        decay: 2,
      });
    },
  },

  /**
   * Something went wrong. Harsher than `denied`: a square through a resonant
   * band-pass and a soft-clipper, falling twice. The saturation is what makes
   * it read as a fault rather than a note.
   */
  error: {
    bus: 'ui',
    gain: 0.35,
    detune: 0,
    reverb: 0.06,
    tail: 0.35,
    build(p) {
      for (const [at, from, to] of [
        [0, 330, 250],
        [0.115, 250, 190],
      ] as const) {
        const amp = tone(p, {
          at,
          type: 'square',
          freq: from,
          toFreq: to,
          glide: 0.07,
          level: 0.2,
          attack: 0.003,
          decay: 0.095,
        });
        const drive = p.gain(2.4);
        const shaper = p.shaper();
        const band = p.biquad('bandpass', 900, 2.6);
        amp.disconnect();
        amp.connect(drive);
        drive.connect(shaper);
        shaper.connect(band);
        band.connect(p.out);
      }
      burst(p, { freq: 1300, q: 1.5, level: 0.08, attack: 0.002, decay: 0.05 });
    },
  },

  /** Countdown tick. Tiny, dry, and out of the way of everything else. */
  tick: {
    bus: 'ui',
    gain: 0.28,
    detune: 0,
    reverb: 0.02,
    tail: 0.1,
    build(p) {
      tone(p, { freq: 1180 * p.rate, level: 0.24, attack: 0.001, decay: 0.028 });
      burst(p, { freq: 4000 * p.rate, q: 2, level: 0.06, attack: 0.0008, decay: 0.014 });
    },
  },
};

/** Sounds that clear space for themselves the instant they start. */
const AUTO_DUCK: Partial<Record<SoundName, { seconds: number; amount: number }>> = {
  needle_found: { seconds: 2.6, amount: 0.22 },
  rebirth: { seconds: 2.2, amount: 0.35 },
};

/* --------------------------------------------------------------- ambience */

/**
 * A mood is a target for four continuous layers plus three event rates.
 *
 * The continuous layers cross-fade on AudioParam ramps, which are sample
 * accurate and free; the event rates (chirps per second and so on) are blended
 * on the JS side in `update`, because you cannot ramp a decision.
 */
interface MoodSpec {
  /** Filtered brown noise - the bed everything else sits on. */
  wind: number;
  windFreq: number;
  windQ: number;
  /** High-passed white noise: leaves, grit, the top of the air. */
  hiss: number;
  rain: number;
  /** Events per second. */
  birds: number;
  crickets: number;
  thunder: number;
}

const MOODS: Record<AmbienceMood, MoodSpec> = {
  noon: { wind: 0.16, windFreq: 430, windQ: 0.9, hiss: 0.03, rain: 0, birds: 0.3, crickets: 0, thunder: 0 },
  golden: { wind: 0.13, windFreq: 340, windQ: 0.95, hiss: 0.022, rain: 0, birds: 0.22, crickets: 0.06, thunder: 0 },
  overcast: { wind: 0.24, windFreq: 260, windQ: 0.7, hiss: 0.05, rain: 0.025, birds: 0.08, crickets: 0, thunder: 0.004 },
  storm: { wind: 0.42, windFreq: 195, windQ: 0.55, hiss: 0.11, rain: 0.3, birds: 0, crickets: 0, thunder: 0.085 },
  night: { wind: 0.1, windFreq: 175, windQ: 1.15, hiss: 0.012, rain: 0, birds: 0, crickets: 0.85, thunder: 0 },
  dawn: { wind: 0.12, windFreq: 300, windQ: 1, hiss: 0.02, rain: 0, birds: 0.45, crickets: 0.14, thunder: 0 },
};

/** The persistent, always-running half of the ambience. */
interface AmbienceRig {
  windGain: GainNode;
  windFilter: BiquadFilterNode;
  hissGain: GainNode;
  rainGain: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

/* ------------------------------------------------------------------ music */

/**
 * Four chords, sixteen eighth-notes each, looping. Warm and rootless enough
 * that the melody can wander without ever clashing: an A minor 9 falling to an
 * F major 9, a C 6/9 and an E minor 7. Nothing resolves hard, which is what
 * keeps a bed like this from demanding attention every eight bars.
 */
const MUSIC_CHORDS: readonly (readonly number[])[] = [
  [45, 52, 55, 60, 64],
  [41, 48, 52, 57, 60],
  [48, 55, 57, 62, 64],
  [40, 52, 55, 59, 62],
];

/**
 * A minor pentatonic. Every note in it is consonant against all four chords,
 * which is precisely why generative music reaches for pentatonics - there is no
 * wrong note to avoid, so the scheduler can pick freely and never sound broken.
 */
const MUSIC_SCALE: readonly number[] = [57, 60, 62, 64, 67, 69, 72, 74];

const MUSIC_STEPS_PER_CHORD = 16;
const MUSIC_LOOP_STEPS = MUSIC_STEPS_PER_CHORD * MUSIC_CHORDS.length;

/* ------------------------------------------------------------- held loops */

/** The parameter envelope for a continuous tool, mapped from intensity 0..1. */
interface LoopSpec {
  motorLow: number;
  motorHigh: number;
  motorGainLow: number;
  motorGainHigh: number;
  airLow: number;
  airHigh: number;
  airGainLow: number;
  airGainHigh: number;
}

const LOOP_SPECS: Record<'dig_loop', LoopSpec> = {
  dig_loop: {
    motorLow: 62,
    motorHigh: 98,
    motorGainLow: 0.16,
    motorGainHigh: 0.34,
    airLow: 900,
    airHigh: 2600,
    airGainLow: 0.14,
    airGainHigh: 0.4,
  },
};

/** The running nodes of a held loop, kept so intensity can be ramped live. */
interface LoopRig {
  out: GainNode;
  motorA: OscillatorNode;
  motorB: OscillatorNode;
  motorGain: GainNode;
  motorFilter: BiquadFilterNode;
  airFilter: BiquadFilterNode;
  airGain: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

/* ------------------------------------------------------- context detection */

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function findAudioContext(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.AudioContext !== 'undefined') return window.AudioContext;
  const legacy = window as Window & { webkitAudioContext?: AudioContextCtor };
  return legacy.webkitAudioContext ?? null;
}

/** Where a voice sits in the stereo field: a world position, or a raw pan. */
interface Spatial {
  position?: Vec3;
  pan?: number;
}

/* ------------------------------------------------------------------ system */

/**
 * The game's single audio system.
 *
 * Construct it whenever you like - it allocates nothing and touches no browser
 * audio API until `unlock()` is called from a real user gesture. Every method
 * is safe to call before then; they simply do nothing.
 */
export class AudioSystem {
  private graph: AudioGraph | null = null;
  private bootPromise: Promise<void> | null = null;
  private unsupported = false;

  private readonly voices: Voice[] = [];

  private masterVolume = 0.9;
  private sfxVolume = 1;
  private musicLevel = 0.5;

  private readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly listenerRight: Vec3 = { x: 1, y: 0, z: 0 };

  private ambience: AmbienceRig | null = null;
  private moodFrom: MoodSpec = MOODS.noon;
  private moodTo: MoodSpec = MOODS.noon;
  private moodBlend = 1;
  private currentMood: AmbienceMood = 'noon';
  private birdTimer = 4;
  private cricketTimer = 2;
  private thunderTimer = 12;

  private musicEnabled = false;
  private musicStep = 0;
  private musicNextStep = 0;
  private lastMelodyNote = -1;

  private loop: LoopRig | null = null;
  private loopActive = false;
  private loopIntensity = 1;

  /**
   * Boots the AudioContext. Must be called from inside a user gesture handler -
   * a context created outside one starts suspended and, on some browsers, can
   * never be resumed.
   *
   * Safe to call repeatedly; the first call wins and later ones await it.
   */
  async unlock(): Promise<void> {
    if (this.unsupported) return;
    if (!this.bootPromise) this.bootPromise = this.boot();
    return this.bootPromise;
  }

  private async boot(): Promise<void> {
    try {
      const Ctor = findAudioContext();
      if (!Ctor) {
        this.unsupported = true;
        return;
      }
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const graph = buildGraph(ctx);
      this.graph = graph;
      this.applyVolumes();
      this.buildAmbience(graph);
      this.applyMood(graph, 0);
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      // A blocked or unavailable context is not an error worth crashing a game
      // over; the whole system degrades to silence.
      this.graph = null;
      this.bootPromise = null;
      this.unsupported = true;
    }
  }

  get ready(): boolean {
    return this.graph !== null && this.graph.ctx.state === 'running';
  }

  /* ------------------------------------------------------------- mixing */

  /**
   * Three public knobs drive five buses. `ui`, `ambience` and `stinger` ride
   * along with `sfx` at fixed relative trims, which is what players expect from
   * a "sound effects" slider - and keeps the internal balance in one place
   * rather than scattered across the callers.
   */
  private applyVolumes(): void {
    const g = this.graph;
    if (!g) return;
    g.master.gain.value = this.masterVolume;
    g.buses.sfx.gain.value = this.sfxVolume;
    g.buses.ui.gain.value = this.sfxVolume * 0.85;
    g.buses.stinger.gain.value = this.sfxVolume;
    g.buses.ambience.gain.value = this.sfxVolume * 0.6;
    g.buses.music.gain.value = this.musicLevel;
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp(v, 0, 1);
    this.applyVolumes();
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = clamp(v, 0, 1);
    this.applyVolumes();
  }

  setMusicVolume(v: number): void {
    this.musicLevel = clamp(v, 0, 1);
    this.applyVolumes();
  }

  /**
   * Pulls everything except the stinger bus and the reverb tail down to
   * `amount`, holds, then releases over 600 ms.
   *
   * @param seconds How long to hold the mix down.
   * @param amount The level to duck *to*, 0..1. 0.25 means everything else
   *   drops to a quarter of its volume.
   */
  duck(seconds: number, amount = 0.3): void {
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    const hold = Math.max(0.05, seconds);
    const target = clamp(amount, 0, 1);
    const gain = g.duck.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(target, now + 0.08);
    gain.setValueAtTime(target, now + hold);
    gain.linearRampToValueAtTime(1, now + hold + 0.6);
  }

  /* ------------------------------------------------------------ listener */

  /**
   * Feed this the camera every frame. `forward` and `up` need not be
   * normalised; only the direction of their cross product matters.
   */
  setListener(position: Vec3, forward: Vec3, up: Vec3): void {
    this.listenerPos.x = position.x;
    this.listenerPos.y = position.y;
    this.listenerPos.z = position.z;

    const rx = forward.y * up.z - forward.z * up.y;
    const ry = forward.z * up.x - forward.x * up.z;
    const rz = forward.x * up.y - forward.y * up.x;
    const length = Math.hypot(rx, ry, rz);
    if (length > 1e-6) {
      this.listenerRight.x = rx / length;
      this.listenerRight.y = ry / length;
      this.listenerRight.z = rz / length;
    }
  }

  /* -------------------------------------------------------------- voices */

  /**
   * Positional audio is hand-rolled - a distance gain, a `StereoPannerNode` and
   * an optional low-pass - rather than a `PannerNode`.
   *
   * Every sound this game positions is a one-shot that never moves after it
   * starts, so the panner's per-block listener maths and distance model are
   * work we would pay for on every voice, every render quantum, for a result we
   * compute once at spawn for about a dozen floating-point operations. HRTF was
   * never on the table at this voice count, and once you drop to equalpower a
   * `PannerNode` is doing little a `StereoPanner` cannot. The one thing we gain
   * by doing it ourselves is air absorption: distant sounds get a low-pass,
   * which does more for perceived distance than level alone.
   */
  private spawn(
    g: AudioGraph,
    bus: BusName,
    level: number,
    spatial: Spatial | undefined,
    reverbAmount: number,
    protect: boolean,
  ): Voice | null {
    let distanceGain = 1;
    let pan = 0;
    let cutoff = 0;

    if (spatial && spatial.position) {
      const dx = spatial.position.x - this.listenerPos.x;
      const dy = spatial.position.y - this.listenerPos.y;
      const dz = spatial.position.z - this.listenerPos.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > MAX_DISTANCE) return null;

      distanceGain =
        REF_DISTANCE / (REF_DISTANCE + ROLLOFF * Math.max(0, distance - REF_DISTANCE));
      if (level * distanceGain < 0.0015) return null;

      if (distance > 1e-3) {
        const dot = (dx * this.listenerRight.x + dy * this.listenerRight.y + dz * this.listenerRight.z) / distance;
        // Scale the pan in over the first couple of metres. A sound right on
        // top of the player should not snap hard left because it happens to be
        // 10 cm off-axis.
        pan = clamp(dot * Math.min(1, distance / 2.5), -1, 1);
      }
      if (distance > 8) cutoff = clamp(20000 * Math.exp(-distance / 42), 900, 20000);
    } else if (spatial && spatial.pan !== undefined) {
      pan = clamp(spatial.pan, -1, 1);
    }

    const now = g.ctx.currentTime;
    if (!this.reserve(now, protect)) return null;

    const out = g.ctx.createGain();
    out.gain.value = level * distanceGain;
    const voice = new Voice(out, level * distanceGain, now, protect);

    let node: AudioNode = out;
    if (cutoff > 0 && cutoff < 19000) {
      const air = g.ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = cutoff;
      air.Q.value = 0.7;
      voice.register(air);
      node.connect(air);
      node = air;
    }
    if (pan !== 0) {
      const panner = g.ctx.createStereoPanner();
      panner.pan.value = pan;
      voice.register(panner);
      node.connect(panner);
      node = panner;
    }
    node.connect(bus === 'music' ? g.musicFade : g.buses[bus]);

    if (reverbAmount > 0) {
      // Tapped pre-pan: the send is mono anyway, and one gain node is cheaper
      // than duplicating the panner into the wet path.
      const send = g.ctx.createGain();
      send.gain.value = reverbAmount;
      voice.register(send);
      out.connect(send);
      send.connect(g.reverb);
    }

    this.voices.push(voice);
    return voice;
  }

  /**
   * Makes room for one more voice. Over budget, the quietest unprotected voice
   * dies first, with the oldest breaking ties - quiet voices are the ones
   * nobody will miss, and among equals the one that has already been heard
   * longest has delivered most of its information.
   */
  private reserve(now: number, protect: boolean): boolean {
    this.compact();

    let active = 0;
    for (const voice of this.voices) {
      if (!voice.evicting) active++;
    }
    if (active < VOICE_LIMIT) return true;

    // Fading-out voices still own their nodes for another few milliseconds. A
    // pathological frame could otherwise condemn dozens of them at once, so
    // there is a hard ceiling on the total including the dying.
    if (this.voices.length >= VOICE_LIMIT * 2 && !protect) return false;

    let victim: Voice | null = null;
    for (const voice of this.voices) {
      if (voice.protectedVoice || voice.evicting) continue;
      if (!victim || voice.level < victim.level ||
        (voice.level === victim.level && voice.startedAt < victim.startedAt)) {
        victim = voice;
      }
    }
    if (!victim) {
      // Everything alive is music, ambience or a stinger. Let a protected voice
      // through anyway rather than dropping a note out of the middle of a chord.
      return protect;
    }
    victim.evict(now);
    return true;
  }

  private compact(): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].retired) this.voices.splice(i, 1);
    }
  }

  play(name: SoundName, options: PlayOptions = {}): void {
    const g = this.graph;
    if (!g) return;

    const spec = SOUNDS[name];
    const requested = clamp(options.volume ?? 1, 0, 1);
    if (requested <= 0) return;

    const semitones = Math.abs(options.detune ?? spec.detune);
    const jitter = semitones > 0 ? Math.pow(2, randRange(-semitones, semitones) / 12) : 1;
    const rate = Math.max(0.05, (options.rate ?? 1) * jitter);

    const voice = this.spawn(
      g,
      spec.bus,
      spec.gain * requested,
      options.position ? { position: options.position } : undefined,
      spec.reverb,
      spec.bus === 'stinger',
    );
    if (!voice) return;

    const t0 = g.ctx.currentTime + SCHEDULE_LEAD;
    voice.endTime = t0 + spec.tail;
    try {
      spec.build(new Patch(g, t0, voice, rate, requested));
    } catch {
      // A patch that throws mid-build has half a graph wired up; tear it down
      // rather than leaving orphaned oscillators running forever.
      voice.retire();
      return;
    }
    if (voice.pending === 0) {
      voice.retire();
      return;
    }

    const auto = AUTO_DUCK[name];
    if (auto) this.duck(auto.seconds, auto.amount);
  }

  /* --------------------------------------------------------- held loops */

  /**
   * Start or stop a continuous tool. Idempotent: calling it with `true` while
   * already running just updates the intensity.
   *
   * Unlike one-shots this keeps its oscillators alive between calls, because a
   * motor that is respawned every frame is a motor with a click in it.
   *
   * @param intensity 0..1, blends the motor pitch, its filter, and how much air
   *   is rushing past - a throttle, not a volume.
   */
  setLoop(name: 'dig_loop', active: boolean, intensity = 1): void {
    const g = this.graph;
    if (!g) return;
    const spec = LOOP_SPECS[name];
    this.loopIntensity = clamp(intensity, 0, 1);
    const now = g.ctx.currentTime;

    if (active) {
      // Idempotence matters here: this is called every frame while a tool is
      // held, and re-ramping the fade-in on each of those calls would keep
      // restarting the attack and leave the loop permanently quiet.
      const alreadyRunning = this.loopActive && this.loop !== null;
      if (!this.loop) this.loop = this.buildLoop(g, spec);
      this.loopActive = true;
      if (!alreadyRunning) {
        const gain = this.loop.out.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(1, now + 0.12);
      }
      this.applyLoopIntensity(g, this.loop, spec, 0.12);
      return;
    }

    this.loopActive = false;
    const rig = this.loop;
    if (!rig) return;
    this.loop = null;

    const gain = rig.out.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + 0.14);
    let pending = rig.sources.length;
    for (const source of rig.sources) {
      source.onended = () => {
        pending--;
        if (pending > 0) return;
        for (const node of rig.nodes) node.disconnect();
        rig.out.disconnect();
      };
      try {
        source.stop(now + 0.16);
      } catch {
        // Already scheduled to stop.
      }
    }
  }

  /**
   * Motor plus air, the two halves of every powered tool.
   *
   * The motor is two detuned sawtooths (the second slightly sharp of an octave,
   * so they beat instead of locking) through a resonant low-pass and a
   * soft-clipper - saturation is what turns a buzzing saw into something with
   * load on it. A 7.3 Hz vibrato on both keeps it from sounding like a held
   * synth note. The air is pink noise through a band-pass that a slow LFO
   * surges up and down, which reads as suction pulling unevenly.
   */
  private buildLoop(g: AudioGraph, spec: LoopSpec): LoopRig {
    const ctx = g.ctx;
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    const now = ctx.currentTime + SCHEDULE_LEAD;

    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(g.buses.sfx);

    const motorFilter = ctx.createBiquadFilter();
    motorFilter.type = 'lowpass';
    motorFilter.frequency.value = spec.motorLow * 7;
    motorFilter.Q.value = 4;
    const shaper = ctx.createWaveShaper();
    shaper.curve = g.saturation;
    shaper.oversample = '2x';
    const motorGain = ctx.createGain();
    motorGain.gain.value = spec.motorGainLow;

    const motorA = ctx.createOscillator();
    motorA.type = 'sawtooth';
    motorA.frequency.value = spec.motorLow;
    const motorB = ctx.createOscillator();
    motorB.type = 'sawtooth';
    motorB.frequency.value = spec.motorLow * 2.01;
    const motorBTrim = ctx.createGain();
    motorBTrim.gain.value = 0.45;

    const wobble = ctx.createOscillator();
    wobble.type = 'sine';
    wobble.frequency.value = 7.3;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 2.6;
    wobble.connect(wobbleDepth);
    wobbleDepth.connect(motorA.frequency);
    wobbleDepth.connect(motorB.frequency);

    motorA.connect(motorFilter);
    motorB.connect(motorBTrim);
    motorBTrim.connect(motorFilter);
    motorFilter.connect(shaper);
    shaper.connect(motorGain);
    motorGain.connect(out);

    const air = ctx.createBufferSource();
    air.buffer = g.noise.pink;
    air.loop = true;
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = spec.airLow;
    airFilter.Q.value = 0.7;
    const airBody = ctx.createBiquadFilter();
    airBody.type = 'highpass';
    airBody.frequency.value = 300;
    const airGain = ctx.createGain();
    airGain.gain.value = spec.airGainLow;

    const surge = ctx.createOscillator();
    surge.type = 'sine';
    surge.frequency.value = 0.9;
    const surgeDepth = ctx.createGain();
    surgeDepth.gain.value = 200;
    surge.connect(surgeDepth);
    surgeDepth.connect(airFilter.frequency);

    air.connect(airFilter);
    airFilter.connect(airBody);
    airBody.connect(airGain);
    airGain.connect(out);

    nodes.push(motorFilter, shaper, motorGain, motorBTrim, wobbleDepth, airFilter, airBody, airGain, surgeDepth);
    sources.push(motorA, motorB, wobble, air, surge);
    for (const source of sources) {
      nodes.push(source);
      source.start(now);
    }

    return { out, motorA, motorB, motorGain, motorFilter, airFilter, airGain, sources, nodes };
  }

  private applyLoopIntensity(g: AudioGraph, rig: LoopRig, spec: LoopSpec, time: number): void {
    const now = g.ctx.currentTime;
    const at = now + time;
    const k = this.loopIntensity;
    const motorFreq = lerp(spec.motorLow, spec.motorHigh, k);
    rig.motorA.frequency.linearRampToValueAtTime(motorFreq, at);
    rig.motorB.frequency.linearRampToValueAtTime(motorFreq * 2.01, at);
    rig.motorFilter.frequency.linearRampToValueAtTime(motorFreq * lerp(5, 9, k), at);
    rig.motorGain.gain.linearRampToValueAtTime(lerp(spec.motorGainLow, spec.motorGainHigh, k), at);
    rig.airFilter.frequency.linearRampToValueAtTime(lerp(spec.airLow, spec.airHigh, k), at);
    rig.airGain.gain.linearRampToValueAtTime(lerp(spec.airGainLow, spec.airGainHigh, k), at);
  }

  /* ---------------------------------------------------------- ambience */

  /**
   * The three continuous layers, started once and left running for the life of
   * the context. They cost three buffer sources and a handful of filters, and
   * keeping them alive means a mood change is a gain ramp rather than a
   * rebuild - you cannot cross-fade into a source that does not exist yet.
   */
  private buildAmbience(g: AudioGraph): void {
    const ctx = g.ctx;
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    const start = ctx.currentTime + SCHEDULE_LEAD;
    const bus = g.buses.ambience;

    const windSource = ctx.createBufferSource();
    windSource.buffer = g.noise.brown;
    windSource.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = MOODS.noon.windFreq;
    windFilter.Q.value = MOODS.noon.windQ;
    // Gusts: a very slow LFO riding a 0.75 baseline, so the modulation swings
    // between roughly half and full without ever crossing zero and inverting.
    const gust = ctx.createGain();
    gust.gain.value = 0.75;
    const gustLfo = ctx.createOscillator();
    gustLfo.type = 'sine';
    gustLfo.frequency.value = 0.037;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 0.25;
    gustLfo.connect(gustDepth);
    gustDepth.connect(gust.gain);
    // A second, independent LFO wandering the band-pass centre keeps the wind
    // from ever settling into a recognisable steady hiss.
    const sweepLfo = ctx.createOscillator();
    sweepLfo.type = 'sine';
    sweepLfo.frequency.value = 0.061;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 150;
    sweepLfo.connect(sweepDepth);
    sweepDepth.connect(windFilter.frequency);
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSource.connect(windFilter);
    windFilter.connect(gust);
    gust.connect(windGain);
    windGain.connect(bus);

    const hissSource = ctx.createBufferSource();
    hissSource.buffer = g.noise.white;
    hissSource.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'highpass';
    hissFilter.frequency.value = 2400;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;
    hissSource.connect(hissFilter);
    hissFilter.connect(hissGain);
    hissGain.connect(bus);

    const rainSource = ctx.createBufferSource();
    rainSource.buffer = g.noise.white;
    rainSource.loop = true;
    rainSource.playbackRate.value = 0.85;
    const rainLow = ctx.createBiquadFilter();
    rainLow.type = 'lowpass';
    rainLow.frequency.value = 6500;
    const rainHigh = ctx.createBiquadFilter();
    rainHigh.type = 'highpass';
    rainHigh.frequency.value = 800;
    const rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    rainSource.connect(rainLow);
    rainLow.connect(rainHigh);
    rainHigh.connect(rainGain);
    rainGain.connect(bus);

    nodes.push(windFilter, gust, gustDepth, sweepDepth, windGain, hissFilter, hissGain, rainLow, rainHigh, rainGain);
    sources.push(windSource, gustLfo, sweepLfo, hissSource, rainSource);
    for (const source of sources) {
      nodes.push(source);
      source.start(start);
    }

    this.ambience = { windGain, windFilter, hissGain, rainGain, sources, nodes };
  }

  private applyMood(g: AudioGraph, fade: number): void {
    const rig = this.ambience;
    if (!rig) return;
    const now = g.ctx.currentTime;
    const at = now + Math.max(0.01, fade);
    const target = this.moodTo;
    for (const [param, value] of [
      [rig.windGain.gain, target.wind],
      [rig.hissGain.gain, target.hiss],
      [rig.rainGain.gain, target.rain],
      [rig.windFilter.frequency, target.windFreq],
      [rig.windFilter.Q, target.windQ],
    ] as const) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(value, at);
    }
  }

  /** Cross-fades to a new mood over about two seconds. */
  setAmbience(mood: AmbienceMood): void {
    if (mood === this.currentMood) return;
    this.currentMood = mood;
    // Snapshot where the blend actually is, so a mood change part-way through
    // another one continues from the current sound rather than snapping back.
    const t = this.moodBlend;
    this.moodFrom = {
      wind: lerp(this.moodFrom.wind, this.moodTo.wind, t),
      windFreq: lerp(this.moodFrom.windFreq, this.moodTo.windFreq, t),
      windQ: lerp(this.moodFrom.windQ, this.moodTo.windQ, t),
      hiss: lerp(this.moodFrom.hiss, this.moodTo.hiss, t),
      rain: lerp(this.moodFrom.rain, this.moodTo.rain, t),
      birds: lerp(this.moodFrom.birds, this.moodTo.birds, t),
      crickets: lerp(this.moodFrom.crickets, this.moodTo.crickets, t),
      thunder: lerp(this.moodFrom.thunder, this.moodTo.thunder, t),
    };
    this.moodTo = MOODS[mood];
    this.moodBlend = 0;
    if (this.graph) this.applyMood(this.graph, AMBIENCE_CROSSFADE);
  }

  private advanceAmbience(g: AudioGraph, dt: number): void {
    if (this.moodBlend < 1) {
      this.moodBlend = Math.min(1, this.moodBlend + dt / AMBIENCE_CROSSFADE);
    }
    const t = this.moodBlend;
    const birds = lerp(this.moodFrom.birds, this.moodTo.birds, t);
    const crickets = lerp(this.moodFrom.crickets, this.moodTo.crickets, t);
    const thunder = lerp(this.moodFrom.thunder, this.moodTo.thunder, t);

    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      if (birds > 0.001) {
        this.birdChirp(g);
        this.birdTimer = randRange(0.5, 2.6) / birds;
      } else {
        this.birdTimer = 2;
      }
    }

    this.cricketTimer -= dt;
    if (this.cricketTimer <= 0) {
      if (crickets > 0.001) {
        this.cricket(g);
        this.cricketTimer = randRange(0.15, 1.1) / crickets;
      } else {
        this.cricketTimer = 2;
      }
    }

    this.thunderTimer -= dt;
    if (this.thunderTimer <= 0) {
      if (thunder > 0.0001) {
        this.thunder(g);
        this.thunderTimer = randRange(0.6, 2.4) / thunder;
      } else {
        this.thunderTimer = 6;
      }
    }
  }

  /**
   * A songbird phrase. Birdsong is almost entirely frequency modulation: the
   * pitch sweep inside each note carries the identity, and the note itself is
   * over in 60 ms. Two to four of them in a row makes a phrase; a single one
   * sounds like a smoke alarm.
   */
  private birdChirp(g: AudioGraph): void {
    const voice = this.spawn(g, 'ambience', randRange(0.1, 0.2), { pan: randRange(-0.85, 0.85) }, 0.4, false);
    if (!voice) return;
    const t0 = g.ctx.currentTime + SCHEDULE_LEAD;
    voice.endTime = t0 + 1;
    const p = new Patch(g, t0, voice, 1, 1);
    const base = pick([2300, 2700, 3100, 3500, 4100]);
    const notes = randInt(2, 4);
    const rising = random() < 0.6;
    for (let i = 0; i < notes; i++) {
      const freq = base * randRange(0.88, 1.18);
      const target = freq * (rising ? randRange(1.18, 1.55) : randRange(0.62, 0.85));
      tone(p, {
        at: i * randRange(0.055, 0.13),
        freq,
        toFreq: target,
        glide: 0.035,
        level: 0.5,
        attack: 0.004,
        decay: randRange(0.05, 0.095),
      });
    }
    if (voice.pending === 0) voice.retire();
  }

  /**
   * A cricket is not a tone but a rapidly pulsed one - the wing stroke chops a
   * resonance around 4.5 kHz into a burst of five or six pulses. Reproducing
   * the chop is the whole trick; a plain enveloped sine at the same frequency
   * sounds like a test tone.
   */
  private cricket(g: AudioGraph): void {
    const voice = this.spawn(g, 'ambience', randRange(0.05, 0.1), { pan: randRange(-0.9, 0.9) }, 0.25, false);
    if (!voice) return;
    const t0 = g.ctx.currentTime + SCHEDULE_LEAD;
    const duration = randRange(0.22, 0.34);
    voice.endTime = t0 + duration + 0.2;
    const p = new Patch(g, t0, voice, 1, 1);
    const freq = randRange(4200, 5000);
    const amp = p.gain(0);
    amp.gain.setValueCurveAtTime(chirrCurve(randInt(4, 6), 0.9), t0, duration);
    const band = p.biquad('bandpass', freq, 6);
    const osc = p.osc('sine', freq, t0, t0 + duration + 0.02);
    const harmonic = p.osc('sine', freq * 2, t0, t0 + duration + 0.02);
    const harmonicTrim = p.gain(0.25);
    osc.connect(band);
    harmonic.connect(harmonicTrim);
    harmonicTrim.connect(band);
    band.connect(amp);
    amp.connect(p.out);
  }

  /**
   * Distant thunder. Brown noise through a low-pass that closes as it rolls
   * away, on a long ragged contour - real thunder is many claps smeared by the
   * distance they travelled, which is why the irregular shape matters more than
   * the spectrum. Close strikes get a band-passed crack on the front.
   */
  private thunder(g: AudioGraph): void {
    const near = random() < 0.3;
    const voice = this.spawn(g, 'ambience', near ? 0.85 : 0.5, { pan: randRange(-0.6, 0.6) }, 0.6, false);
    if (!voice) return;
    const t0 = g.ctx.currentTime + SCHEDULE_LEAD;
    const duration = randRange(3.2, 5.2);
    voice.endTime = t0 + duration + 0.5;
    const p = new Patch(g, t0, voice, 1, 1);

    const source = p.noise('brown', t0, t0 + duration + 0.05);
    const low = p.biquad('lowpass', near ? 320 : 190, 1.6);
    low.frequency.setValueAtTime(near ? 320 : 190, t0);
    low.frequency.exponentialRampToValueAtTime(70, t0 + duration);
    const amp = p.gain(0);
    amp.gain.setValueCurveAtTime(scaledCurve(SHAPE_THUNDER, 0.9), t0, duration);
    source.connect(low);
    low.connect(amp);
    amp.connect(p.out);

    if (near) {
      burst(p, { kind: 'white', freq: 900, toFreq: 300, q: 0.6, level: 0.3, attack: 0.004, decay: 0.45 });
    }
  }

  /* -------------------------------------------------------------- music */

  /**
   * Start or stop the generative bed. Fades in over two seconds so it never
   * announces itself, and out over one and a half; notes already scheduled are
   * allowed to ring out rather than being cut.
   */
  setMusic(enabled: boolean): void {
    this.musicEnabled = enabled;
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    const gain = g.musicFade.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(enabled ? 1 : 0, now + (enabled ? 2 : 1.5));
    if (enabled && this.musicNextStep < now) this.musicNextStep = now + 0.15;
  }

  /**
   * Lookahead scheduling, driven from `update` rather than a timer.
   *
   * `setInterval` is the wrong tool: its callbacks drift, they are throttled to
   * once a second in background tabs, and they are quantised to whole
   * milliseconds. Instead each frame we schedule every step that falls inside
   * the next 400 ms, at exact AudioContext times. The audio thread then plays
   * them with sample accuracy no matter how badly the frame rate stutters.
   */
  private scheduleMusic(g: AudioGraph, now: number): void {
    if (this.musicNextStep < now) this.musicNextStep = now + 0.05;
    while (this.musicNextStep < now + MUSIC_LOOKAHEAD) {
      this.musicStepAt(g, this.musicStep, this.musicNextStep);
      this.musicStep++;
      this.musicNextStep += MUSIC_STEP;
    }
  }

  private musicStepAt(g: AudioGraph, step: number, when: number): void {
    const inLoop = step % MUSIC_LOOP_STEPS;
    const chordIndex = Math.floor(inLoop / MUSIC_STEPS_PER_CHORD);
    const chord = MUSIC_CHORDS[chordIndex];
    const stepInChord = inLoop % MUSIC_STEPS_PER_CHORD;
    const phrase = Math.floor(step / MUSIC_LOOP_STEPS);

    if (stepInChord === 0) {
      this.musicPad(g, chord, when);
      this.musicBass(g, chord[0], when);
    }

    // Every fourth trip round the progression the melody nearly stops. A bed
    // that plays continuously stops being background within ten minutes; the
    // silences are what make it liveable for an hour.
    const breathing = phrase % 4 === 3;
    const onBeat = stepInChord % 2 === 0;
    let restChance = onBeat ? 0.34 : 0.62;
    if (breathing) restChance = 0.9;
    if (random() < restChance) return;

    const scale = MUSIC_SCALE;
    let index = randInt(0, scale.length - 1);
    // Never let the same degree repeat immediately; step off it instead. This
    // one rule does more for the illusion of melody than any amount of extra
    // randomness.
    if (index === this.lastMelodyNote) {
      index = (index + (random() < 0.5 ? 1 : scale.length - 1)) % scale.length;
    }
    this.lastMelodyNote = index;

    const roll = random();
    const octave = roll < 0.1 ? -12 : roll > 0.88 ? 12 : 0;
    const velocity = clamp(randRange(0.3, 0.65) * (stepInChord % 4 === 0 ? 1.15 : 0.85), 0.1, 1);
    this.musicNote(g, scale[index] + octave, when, velocity);
  }

  /** One arpeggio note: sine body, detuned triangle for edge, long release. */
  private musicNote(g: AudioGraph, midi: number, when: number, velocity: number): void {
    const voice = this.spawn(g, 'music', 0.16 * velocity, { pan: randRange(-0.35, 0.35) }, 0.45, true);
    if (!voice) return;
    voice.endTime = when + 2;
    const p = new Patch(g, when, voice, 1, velocity);
    const freq = midiToFreq(midi);
    const amp = p.gain(0);
    const end = asrEnvelope(amp.gain, when, 0.6, 0.012, 0.1, 1.3);
    const filter = p.biquad('lowpass', lerp(1400, 3000, velocity), 0.8);
    const body = p.osc('sine', freq, when, end + 0.02);
    const edge = p.osc('triangle', freq, when, end + 0.02);
    edge.detune.value = -6;
    const edgeTrim = p.gain(0.35);
    body.connect(filter);
    edge.connect(edgeTrim);
    edgeTrim.connect(filter);
    filter.connect(amp);
    amp.connect(p.out);
    voice.endTime = end + 0.1;
  }

  /**
   * The pad. Four chord tones, each a triangle and a sawtooth six cents apart -
   * the detuning is the entire reason this sounds warm rather than like an
   * organ. The low-pass opens slightly over the first two seconds and closes
   * again on the release, which is what a real swell does.
   */
  private musicPad(g: AudioGraph, chord: readonly number[], when: number): void {
    const voice = this.spawn(g, 'music', 0.1, undefined, 0.55, true);
    if (!voice) return;
    const p = new Patch(g, when, voice, 1, 1);
    const span = MUSIC_STEP * MUSIC_STEPS_PER_CHORD;
    const amp = p.gain(0);
    const end = asrEnvelope(amp.gain, when, 0.5, 1.6, Math.max(0.2, span - 2.4), 2.4);
    const filter = p.biquad('lowpass', 620, 0.9);
    filter.frequency.setValueAtTime(620, when);
    filter.frequency.linearRampToValueAtTime(1150, when + 2.2);
    filter.frequency.linearRampToValueAtTime(620, end);
    for (let i = 0; i < Math.min(4, chord.length); i++) {
      const freq = midiToFreq(chord[i]);
      for (const [type, cents, trim] of [
        ['triangle', -6, 1],
        ['sawtooth', 6, 0.22],
      ] as const) {
        const osc = p.osc(type, freq, when, end + 0.02);
        osc.detune.value = cents;
        const gainNode = p.gain(trim);
        osc.connect(gainNode);
        gainNode.connect(filter);
      }
    }
    filter.connect(amp);
    amp.connect(p.out);
    voice.endTime = end + 0.1;
  }

  /** Root note, plus a sub an octave down for weight the pad cannot reach. */
  private musicBass(g: AudioGraph, midi: number, when: number): void {
    const voice = this.spawn(g, 'music', 0.18, undefined, 0.2, true);
    if (!voice) return;
    const p = new Patch(g, when, voice, 1, 1);
    tone(p, { freq: midiToFreq(midi), level: 0.5, attack: 0.05, hold: 0.7, release: 1.4 });
    tone(p, { freq: midiToFreq(midi - 12), level: 0.32, attack: 0.08, hold: 0.6, release: 1.2 });
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Call once per frame. Drives ambience event timing, music scheduling, and
   * the safety sweep that retires any voice whose `ended` never arrived.
   */
  update(dt: number): void {
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    const step = clamp(dt, 0, 0.25);

    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i];
      if (!voice.retired && voice.endTime > 0 && now > voice.endTime + 1.5) voice.retire();
      if (voice.retired) this.voices.splice(i, 1);
    }

    this.advanceAmbience(g, step);
    if (this.musicEnabled) this.scheduleMusic(g, now);
  }

  /** Tab hidden. Freezes the context; scheduled automation resumes untouched. */
  suspend(): void {
    const g = this.graph;
    if (!g || g.ctx.state === 'closed') return;
    g.ctx.suspend().catch(noop);
  }

  resume(): void {
    const g = this.graph;
    if (!g || g.ctx.state === 'closed') return;
    g.ctx.resume().catch(noop);
    // currentTime froze while suspended, so the music scheduler would otherwise
    // believe it is minutes behind and flood the graph catching up.
    this.musicNextStep = g.ctx.currentTime + 0.15;
  }

  /** Releases everything. The system is inert afterwards, not reusable. */
  dispose(): void {
    const g = this.graph;
    this.setLoop('dig_loop', false);
    this.musicEnabled = false;
    for (const voice of [...this.voices]) voice.retire();
    this.voices.length = 0;

    const rig = this.ambience;
    if (rig && g) {
      for (const source of rig.sources) {
        try {
          source.stop(g.ctx.currentTime);
        } catch {
          // Never started, or already stopped.
        }
      }
      for (const node of rig.nodes) node.disconnect();
    }
    this.ambience = null;

    if (g) {
      for (const name of BUS_NAMES) g.buses[name].disconnect();
      g.musicFade.disconnect();
      g.reverb.disconnect();
      g.reverbReturn.disconnect();
      g.duck.disconnect();
      g.master.disconnect();
      g.compressor.disconnect();
      g.ctx.close().catch(noop);
    }
    this.graph = null;
    this.bootPromise = null;
  }
}

/**
 * The amplitude contour of a cricket stridulation: `pulses` sharp bursts spread
 * evenly across the note, each with a fast attack and a slightly slower fall.
 * Built on demand because the pulse count varies per insect, and a few dozen
 * floats a second is nothing next to the nodes the voice already allocates.
 */
function chirrCurve(pulses: number, level: number): Float32Array {
  const points = 128;
  const out = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const u = i / (points - 1);
    const phase = (u * pulses) % 1;
    const pulse = phase < 0.25 ? phase / 0.25 : Math.pow(1 - (phase - 0.25) / 0.75, 1.8);
    // A gentle overall envelope stops the first and last pulses clicking.
    const body = Math.sin(Math.PI * u);
    out[i] = pulse * body * level;
  }
  out[0] = 0;
  out[points - 1] = 0;
  return out;
}
