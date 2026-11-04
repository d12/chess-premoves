// Sound effects, synthesized with the Web Audio API: no audio files, nothing to license or
// download. A player creates its AudioContext lazily on the first sound (browsers only allow
// audio after a user gesture, and every sound here follows one) and remembers mute in
// localStorage. synthesize() is exported separately so sounds can be rendered offline.

const STORAGE_KEY = "chess-premove-sound-v1";

export const SOUND_NAMES = Object.freeze([
  // board
  "premove", "undo", "illegal", "submit",
  "move", "capture", "check", "castle", "promote", "mate",
  // results
  "win", "perfect", "poppers", "defeat", "draw",
  // menus and maps
  "click", "open", "back", "lock", "pop", "trail", "hop", "flag", "stamp", "unlock-world",
]);

/** Which sound a played move makes, from its SAN. */
export function soundForMove(move) {
  const san = move?.san ?? "";
  if (san.includes("#")) return "mate";
  if (san.includes("+")) return "check";
  if (san.includes("=")) return "promote";
  if (san.startsWith("O-O")) return "castle";
  if (san.includes("x")) return "capture";
  return "move";
}

// C major / pentatonic note frequencies used by the musical cues
const NOTE = {
  G3: 196, C4: 261.63, D4: 293.66, E4: 329.63, G4: 392, A4: 440,
  C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, A6: 1760, C7: 2093,
};

let sharedNoise = null;
function noiseBuffer(context) {
  if (sharedNoise?.context === context) {
    return sharedNoise.buffer;
  }
  const length = Math.floor(context.sampleRate * 1);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // Deterministic white noise (repeatable renders). Integer maths via Math.imul: a float LCG
  // loses its low bits and degrades into flat runs, which filters turn into audible clicks.
  let seed = 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[index] = (seed / 2147483648) - 1;
  }
  sharedNoise = { context, buffer };
  return buffer;
}

/**
 * Schedule sound `name` on `context`, into `destination`, starting at time `at` (seconds).
 * `opponent` makes board sounds slightly lower, so Black's replies sound distinct.
 */
export function synthesize(context, destination, name, at, { opponent = false } = {}) {
  const noise = noiseBuffer(context);

  function envelope(param, t, peak, attack, decay) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function tone({ freq, to, glide, type = "sine", t = 0, attack = 0.004, decay = 0.2, gain = 0.3, lowpass, pan }) {
    const start = at + t;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(freq, start);
    if (to) {
      oscillator.frequency.exponentialRampToValueAtTime(to, start + (glide ?? attack + decay));
    }
    const amp = context.createGain();
    envelope(amp.gain, start, gain, attack, decay);
    let node = oscillator;
    if (lowpass) {
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(lowpass, start);
      node = node.connect(filter);
    }
    node.connect(amp);
    connectOut(amp, pan);
    oscillator.start(start);
    oscillator.stop(start + attack + decay + 0.05);
  }

  function hiss({ t = 0, attack = 0.002, decay = 0.05, gain = 0.3, filter = "bandpass", freq = 2000, to, Q = 1, pan }) {
    const start = at + t;
    const source = context.createBufferSource();
    source.buffer = noise;
    const shaper = context.createBiquadFilter();
    shaper.type = filter;
    shaper.frequency.setValueAtTime(freq, start);
    if (to) {
      shaper.frequency.exponentialRampToValueAtTime(to, start + attack + decay);
    }
    shaper.Q.value = Q;
    const amp = context.createGain();
    envelope(amp.gain, start, gain, attack, decay);
    source.connect(shaper).connect(amp);
    connectOut(amp, pan);
    source.start(start, (t * 7.3) % 0.5);
    source.stop(start + attack + decay + 0.05);
  }

  function connectOut(node, pan) {
    if (pan && context.createStereoPanner) {
      const panner = context.createStereoPanner();
      panner.pan.value = pan;
      node.connect(panner).connect(destination);
    } else {
      node.connect(destination);
    }
  }

  // A felt-bottomed piece landing on a wooden board.
  function thock(t = 0, { pitch = 1, gain = 1 } = {}) {
    hiss({ t, decay: 0.045, gain: 0.5 * gain, freq: 1500 * pitch, Q: 1.4 });
    tone({ t, freq: 230 * pitch, to: 105 * pitch, attack: 0.002, decay: 0.08, gain: 0.5 * gain });
    tone({ t, freq: 1150 * pitch, to: 700 * pitch, type: "triangle", attack: 0.001, decay: 0.02, gain: 0.12 * gain });
  }

  // Mallet on wood: a pure fundamental with a fast-decaying 4th harmonic.
  function marimba(freq, t = 0, gain = 0.25, decay = 0.45) {
    tone({ t, freq, attack: 0.003, decay, gain });
    tone({ t, freq: freq * 4, attack: 0.002, decay: 0.06, gain: gain * 0.35 });
  }

  // Small bell: inharmonic partials that ring at different lengths.
  function bell(freq, t = 0, gain = 0.12, decay = 0.8, pan) {
    [[1, 1, 1], [2.76, 0.45, 0.55], [5.4, 0.22, 0.3], [8.93, 0.1, 0.18]].forEach(([ratio, level, length]) => {
      tone({ t, freq: freq * ratio, attack: 0.002, decay: decay * length, gain: gain * level, pan });
    });
  }

  function clink(t, freq = 2600) {
    tone({ t, freq, attack: 0.001, decay: 0.06, gain: 0.11 });
    tone({ t, freq: freq * 1.47, attack: 0.001, decay: 0.04, gain: 0.06 });
    hiss({ t, decay: 0.014, gain: 0.12, filter: "highpass", freq: 5000 });
  }

  function sparkles(t, count, spread, gain = 0.035) {
    const notes = [NOTE.C6, NOTE.E6, NOTE.G6, NOTE.A6, NOTE.C7, NOTE.D6];
    for (let index = 0; index < count; index += 1) {
      const pan = ((index * 0.618) % 1) * 1.4 - 0.7;
      bell(notes[(index * 5) % notes.length], t + (spread * index) / count, gain, 0.5, pan);
    }
  }

  const pitch = opponent ? 0.86 : 1;
  switch (name) {
    // ---- board ----
    case "premove": // queued, not played: a light tick
      hiss({ decay: 0.03, gain: 0.45, freq: 2800, Q: 1.6 });
      tone({ freq: 1500, attack: 0.001, decay: 0.04, gain: 0.1, type: "triangle" });
      break;
    case "undo":
      tone({ freq: 950, to: 560, attack: 0.002, decay: 0.08, gain: 0.16, type: "triangle" });
      hiss({ decay: 0.025, gain: 0.25, freq: 2400, Q: 1.6 });
      break;
    case "illegal": // a soft wooden "nope"
      tone({ freq: 175, attack: 0.003, decay: 0.08, gain: 0.16, type: "triangle", lowpass: 900 });
      tone({ t: 0.09, freq: 140, attack: 0.003, decay: 0.1, gain: 0.14, type: "triangle", lowpass: 900 });
      break;
    case "submit": // "go": the line is locked in
      marimba(NOTE.G4, 0, 0.16, 0.25);
      marimba(NOTE.C5, 0.07, 0.18, 0.35);
      break;
    case "move":
      thock(0, { pitch });
      break;
    case "capture": // a sharper snap, then the landing
      hiss({ decay: 0.03, gain: 0.32, filter: "highpass", freq: 2800 });
      thock(0.012, { pitch: pitch * 1.18, gain: 1.15 });
      tone({ t: 0.012, freq: 320 * pitch, to: 160 * pitch, attack: 0.001, decay: 0.05, gain: 0.25, type: "triangle" });
      break;
    case "check":
      thock(0, { pitch });
      bell(NOTE.E6 * pitch, 0.03, 0.09, 0.5);
      bell(NOTE.A6 * pitch, 0.1, 0.07, 0.6);
      break;
    case "castle":
      thock(0, { pitch });
      thock(0.1, { pitch: pitch * 0.9, gain: 0.9 });
      break;
    case "promote":
      thock(0, { pitch });
      tone({ t: 0.04, freq: 600, to: 1600, glide: 0.22, attack: 0.02, decay: 0.24, gain: 0.06 });
      bell(NOTE.G6, 0.2, 0.08, 0.7);
      break;
    case "mate": // the final blow lands heavy
      thock(0, { pitch: 0.82, gain: 1.3 });
      tone({ freq: 95, to: 42, attack: 0.003, decay: 0.4, gain: 0.5 });
      break;

    // ---- results ----
    case "win":
      [NOTE.C5, NOTE.E5, NOTE.G5].forEach((note, index) => marimba(note, index * 0.085, 0.24));
      marimba(NOTE.C6, 0.27, 0.26, 0.7);
      bell(NOTE.C6, 0.27, 0.09, 1.1);
      break;
    case "perfect":
      [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((note, index) => marimba(note, index * 0.075, 0.28));
      marimba(NOTE.E6, 0.3, 0.28, 0.8);
      [NOTE.C5, NOTE.E5, NOTE.G5].forEach((note) => tone({ t: 0.3, freq: note, attack: 0.06, decay: 1.4, gain: 0.05 }));
      bell(NOTE.G6, 0.32, 0.1, 1.3);
      sparkles(0.42, 9, 0.9);
      break;
    case "poppers": // the perfect-solve cannons, left and right
      [[-0.75, 0], [0.75, 0.11]].forEach(([pan, t]) => {
        hiss({ t, decay: 0.12, gain: 0.4, filter: "lowpass", freq: 4000, to: 500, pan });
        tone({ t, freq: 140, to: 60, attack: 0.002, decay: 0.12, gain: 0.35, pan });
      });
      break;
    case "defeat": // gentle, not sad: two soft notes stepping down
      marimba(NOTE.G4, 0, 0.17, 0.4);
      marimba(NOTE.D4, 0.15, 0.15, 0.55);
      break;
    case "draw":
      marimba(NOTE.E5, 0, 0.15, 0.35);
      marimba(NOTE.E5, 0.15, 0.13, 0.45);
      break;

    // ---- menus and maps ----
    case "click":
      hiss({ decay: 0.018, gain: 0.32, freq: 2600, Q: 2 });
      tone({ freq: 1900, attack: 0.001, decay: 0.025, gain: 0.08 });
      break;
    case "open": // going deeper: a soft upward swish
      hiss({ attack: 0.03, decay: 0.24, gain: 0.16, freq: 450, to: 2600, Q: 0.9 });
      tone({ t: 0.02, freq: NOTE.G5, attack: 0.004, decay: 0.12, gain: 0.07 });
      break;
    case "back":
      hiss({ attack: 0.03, decay: 0.22, gain: 0.15, freq: 2400, to: 500, Q: 0.9 });
      break;
    case "lock": // padlock wiggles (matches the 0.14 s-0.49 s shake), then springs open
      [0.16, 0.24, 0.32, 0.4].forEach((t, index) => clink(t, index % 2 ? 2350 : 2750));
      hiss({ t: 0.5, decay: 0.04, gain: 0.2, filter: "highpass", freq: 3500 });
      tone({ t: 0.5, freq: 900, to: 420, attack: 0.001, decay: 0.06, gain: 0.12, type: "triangle" });
      break;
    case "pop": // the level node bursts into colour
      tone({ freq: 280, to: 950, glide: 0.07, attack: 0.004, decay: 0.12, gain: 0.3 });
      tone({ t: 0.05, freq: 1300, attack: 0.002, decay: 0.12, gain: 0.08 });
      break;
    case "trail": // the path draws itself in
      hiss({ attack: 0.05, decay: 0.45, gain: 0.14, freq: 700, to: 3500, Q: 2 });
      [NOTE.C5, NOTE.D5, NOTE.E5, NOTE.G5, NOTE.A5].forEach((note, index) => {
        tone({ t: 0.12 + index * 0.09, freq: note * 2, attack: 0.003, decay: 0.16, gain: 0.1 });
      });
      break;
    case "hop": // the mascot jumps along the trail and lands
      tone({ freq: 240, to: 640, glide: 0.16, attack: 0.006, decay: 0.18, gain: 0.13 });
      tone({ freq: 480, to: 1280, glide: 0.16, attack: 0.006, decay: 0.12, gain: 0.03, type: "triangle" });
      thock(0.56, { pitch: 1.25, gain: 0.7 });
      break;
    case "flag": // little fanfare as the goal flag runs up
      [NOTE.G4, NOTE.C5, NOTE.E5].forEach((note, index) => {
        tone({ t: index * 0.11, freq: note, type: "sawtooth", lowpass: 2200, attack: 0.01, decay: 0.14, gain: 0.2 });
      });
      tone({ t: 0.33, freq: NOTE.G5, type: "sawtooth", lowpass: 2600, attack: 0.012, decay: 0.6, gain: 0.21 });
      tone({ t: 0.33, freq: NOTE.C5, type: "sawtooth", lowpass: 1800, attack: 0.012, decay: 0.6, gain: 0.13 });
      break;
    case "stamp": // "World clear!" slams onto the map
      tone({ freq: 130, to: 48, attack: 0.002, decay: 0.28, gain: 0.55 });
      hiss({ decay: 0.22, gain: 0.3, filter: "lowpass", freq: 1400 });
      hiss({ decay: 0.06, gain: 0.22, filter: "highpass", freq: 4500 });
      bell(NOTE.C6, 0.04, 0.06, 0.9);
      break;
    case "unlock-world": // a big lock bursts, then a harp run as the colour floods back
      [0, 0.08, 0.16].forEach((t, index) => clink(t, index % 2 ? 2100 : 2500));
      hiss({ t: 0.36, decay: 0.08, gain: 0.25, filter: "highpass", freq: 2500 });
      tone({ t: 0.36, freq: 700, to: 260, attack: 0.001, decay: 0.1, gain: 0.18, type: "triangle" });
      [NOTE.C5, NOTE.D5, NOTE.E5, NOTE.G5, NOTE.A5, NOTE.C6, NOTE.D6, NOTE.E6].forEach((note, index) => {
        tone({ t: 0.42 + index * 0.045, freq: note, attack: 0.003, decay: 0.5, gain: 0.07 });
      });
      bell(NOTE.G6, 0.8, 0.07, 1);
      break;
    default:
      throw new RangeError(`Unknown sound: ${name}`);
  }
}

export const OUTPUT_GAIN = 0.8;

/**
 * A safety soft-clipper: exactly linear up to 0.6, then rounds peaks off towards ±0.9, so
 * stacked sounds (mate + fanfare + cannons) never hard-clip. Unlike a DynamicsCompressor it
 * has no attack or lookahead, which in Chrome squashed every piece "thock" by ~9 dB.
 */
export function createLimiter(context) {
  const shaper = context.createWaveShaper();
  const size = 2048;
  const curve = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const x = (index / (size - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    curve[index] = magnitude <= 0.6 ? x : Math.sign(x) * (0.6 + 0.4 * Math.tanh((magnitude - 0.6) / 0.4));
  }
  shaper.curve = curve;
  shaper.oversample = "2x";
  return shaper;
}

function defaultContext() {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return AudioContextClass ? new AudioContextClass({ latencyHint: "interactive" }) : null;
}

/**
 * `onPlay(name, details)` is called for every requested sound (also while muted).
 * `keepAwake()` returning true stops a mute from suspending the shared AudioContext, which
 * the background music (music.js) also plays through.
 */
export function createSoundPlayer({
  storage = globalThis.localStorage, createContext = defaultContext, onPlay, keepAwake = () => false,
} = {}) {
  let muted = false;
  try {
    muted = storage?.getItem(STORAGE_KEY) === "off";
  } catch {
    // storage unavailable: default to sound on, without remembering
  }
  let context = null;
  let output = null;
  let musicInput = null;
  let failed = false;

  function ensureContext() {
    if (context || failed) {
      return context;
    }
    try {
      context = createContext();
    } catch {
      context = null;
    }
    if (!context) {
      failed = true;
      return null;
    }
    // effects and music share one soft-clipper, so the two together can't clip either
    const limiter = createLimiter(context);
    limiter.connect(context.destination);
    output = context.createGain();
    output.gain.value = OUTPUT_GAIN;
    output.connect(limiter);
    musicInput = context.createGain();
    musicInput.connect(limiter);
    return context;
  }

  /** The shared AudioContext and the input the music plays into, or null without Web Audio. */
  function audio() {
    if (!ensureContext()) {
      return null;
    }
    if (context.state === "suspended") {
      context.resume?.().catch?.(() => {});
    }
    return { context, musicInput };
  }

  /** Play a sound now, or `when` seconds from now. Returns whether it was scheduled. */
  function play(name, { when = 0, opponent = false } = {}) {
    if (!SOUND_NAMES.includes(name)) {
      throw new RangeError(`Unknown sound: ${name}`); // a typo is a bug, even while muted
    }
    onPlay?.(name, { when, opponent, muted });
    if (muted || !ensureContext()) {
      return false;
    }
    if (context.state === "suspended") {
      context.resume?.().catch?.(() => {});
    }
    try {
      synthesize(context, output, name, context.currentTime + 0.005 + when, { opponent });
      return true;
    } catch (error) {
      if (error instanceof RangeError) {
        throw error; // a typo in a sound name is a bug
      }
      return false; // audio hiccups never break the game
    }
  }

  function setMuted(value) {
    muted = Boolean(value);
    try {
      storage?.setItem(STORAGE_KEY, muted ? "off" : "on");
    } catch {
      // not remembered, but still applies to this session
    }
    if (muted && context?.state === "running" && !keepAwake()) {
      context.suspend?.().catch?.(() => {});
    } else if (!muted && context?.state === "suspended") {
      context.resume?.().catch?.(() => {});
    }
    return muted;
  }

  return Object.freeze({
    play,
    isMuted: () => muted,
    audio,
    setMuted,
    toggleMuted: () => setMuted(!muted),
  });
}
