// Background music: one original theme, synthesized live with Web Audio like the sound
// effects (no audio files). Design notes, from research into how classic platformer music works:
//
// * One melody, many arrangements. Super Mario World reuses its main theme across areas with
//   new keys, metres and instruments, so the music feels unified but each place sounds like
//   itself. Here every world plays the same song in its own key, mode, tempo and instruments.
// * Rhythm and bounce. Kondo's overworld music puts a syncopated melody over a steady,
//   bouncing accompaniment. The melody anticipates beats on the "and", over a light swing,
//   an oom-pah bass with walk-ups and an off-beat chop.
// * Balance. Music must not overpower the sound effects: it sits about 10 dB under them,
//   is band-limited, and ducks under fanfares.
// * Vertical layering. Like Yoshi's bongos, layers come and go with what the player is doing
//   while tempo and key stay fixed: the full band on the maps; while planning a puzzle the
//   melody and kick drop out (a quieter, thinking texture); while a line plays out, bongos and
//   kick come back in.
// * Fighting loop fatigue. Loops of one to two minutes wear thin after three to five plays.
//   The form here is about 2.5 minutes; the second pass varies (lead up an octave with a
//   harmony line, fills, counter-melodies), and after two passes the music rests for a while
//   before starting again.
//
// The song is written in scale degrees (0 = tonic, 7 = the octave above), so a world's mode
// recolours the same tune. The scheduler is pure apart from the AudioContext calls, so the
// same code renders into an OfflineAudioContext for testing.

// ---- the song ------------------------------------------------------------------------------

// Melody bars: 8 tokens, one per eighth note. A number is a scale degree, "-" holds the
// previous note, "." is a rest.
const bar = (text) => text.trim().split(/\s+/);

const A_LEAD = [
  "4 . 7 . 6 7 . 4", "- . 5 4 2 - . 0", "3 . 5 . 7 8 . 7", "- . 6 . 4 . 1 2",
  "4 . 7 . 6 7 . 9", "- . 8 7 5 - 4 5", "5 . 3 1 4 - 6 -", "7 . 4 . 7 . . .",
].map(bar);
const A2_LEAD = [
  "4 . 7 . 6 7 . 4", "- . 5 4 2 - . 0", "3 . 5 . 7 8 . 7", "- . 6 . 4 5 6 -",
  "6 . 9 . 8 9 . 6", "- . 7 6 5 - . 2", "3 5 8 - 4 6 8 -", "7 . . 4 7 . . .",
].map(bar);
const B_LEAD = [
  "5 - - 3 5 - 7 -", "8 - - - 7 . 5 .", "4 - - 2 4 - 7 -", "5 - - - . . . .",
  "3 - - 1 3 - 5 -", "8 - - - 7 . 5 .", "6 - - 4 6 - 8 -", "9 - 8 - 6 - 4 -",
].map(bar);
// bell answers in the gaps of B
const B_COUNTER = [
  ". . . . . . . .", ". . . . . . 9 10", ". . . . . . . .", ". . . . 9 8 7 6",
  ". . . . . . . .", ". . . . . . 10 11", ". . . . . . . .", ". . . . . . . .",
].map(bar);
// the breakdown: no melody, just fragments of the A tune on bells over bongos and walking bass
const C_COUNTER = [
  "9 . 7 . . . . .", ". . . . 8 . 6 .", ". . . . . . . .", "8 . 7 . 5 . . .",
  "9 . 7 . . . . .", ". . . . 8 . 9 .", "8 . . . . . . .", ". . . . 4 5 6 -",
].map(bar);
// a second-pass counter-melody over A: sparse bells a sixth above the tune's long notes
const A_COUNTER = [
  ". . . . . . . .", ". . 9 . . . 7 .", ". . . . . . . .", ". . 8 . . . 6 .",
  ". . . . . . . .", ". . 10 . . . 9 .", ". . . . . . . .", ". . . . . . . .",
].map(bar);
const REST = bar(". . . . . . . .");
const INTRO_COUNTER = [REST, REST, REST, bar(". . . . 4 5 6 -")];

// Chords per bar: one root degree, or two (first and second half of the bar).
const SECTIONS = {
  intro: { chords: [[0], [3], [0], [4]], lead: [REST, REST, REST, REST], counter: INTRO_COUNTER, intro: true },
  A: { chords: [[0], [5], [3], [4], [0], [5], [1, 4], [0]], lead: A_LEAD },
  A2: { chords: [[0], [5], [3], [4], [2], [5], [1, 4], [0]], lead: A2_LEAD },
  B: { chords: [[3], [3], [0], [5], [1], [1], [4], [4]], lead: B_LEAD, counter: B_COUNTER, lyrical: true },
  C: { chords: [[5], [5], [3], [3], [5], [5], [1], [4]], lead: null, counter: C_COUNTER, breakdown: true },
  tag: { chords: [[0], [0]], lead: [bar("7 . 4 . 7 . . ."), bar("0 . . . . . . .")], tag: true },
};
// About 62 bars: 2 min 13 s at 112 bpm, longer in the slower worlds.
export const FORM = ["intro", "A", "A2", "B", "A2", "C", "B", "A2", "tag"];
export const REST_BARS = 8; // silence after every second pass

// ---- the five arrangements ------------------------------------------------------------------

const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

// key: MIDI note of the tonic used by the melody; the bass sits two octaves below.
export const ARRANGEMENTS = Object.freeze({
  meadow: { key: 60, mode: "major", tempo: 112, swing: 0.6, lead: "steel", counter: "glock", kit: "full" },
  forest: { key: 62, mode: "major", tempo: 100, swing: 0.62, lead: "flute", counter: "glock", kit: "brush" },
  desert: { key: 63, mode: "mixolydian", tempo: 106, swing: 0.58, lead: "pluck", counter: "glock", kit: "hand" },
  frost: { key: 65, mode: "major", tempo: 96, swing: 0.6, lead: "celesta", counter: "celesta", kit: "brush", octave: 12 },
  volcano: { key: 57, mode: "minor", tempo: 118, swing: 0.56, lead: "square", counter: "glock", kit: "full", octave: 12 },
});

// Layer gains per scene (what the player is doing).
export const SCENES = Object.freeze({
  map: { lead: 1, counter: 1, bass: 1, comp: 1, kick: 1, snare: 1, hat: 1, bongo: 0, pad: 0 },
  planning: { lead: 0, counter: 0.6, bass: 0.7, comp: 0.55, kick: 0, snare: 0, hat: 0.6, bongo: 0, pad: 1 },
  playing: { lead: 0, counter: 0.5, bass: 0.9, comp: 0.75, kick: 0.9, snare: 0, hat: 0.8, bongo: 1, pad: 0.7 },
});
const LAYERS = Object.keys(SCENES.map);

// Overall music level (after the mixer): roughly 10 dB under the effects on the maps.
export const MUSIC_GAIN = 0.34;
// The planning scene also turns the whole band down a little.
const SCENE_LEVEL = { map: 1, planning: 0.72, playing: 0.85 };

// ---- timeline -------------------------------------------------------------------------------

/** Pseudo-random 0..1 from integers, so a given bar always varies the same way. */
function hash(...values) {
  let h = 0x811c9dc5;
  for (const value of values) {
    h = Math.imul(h ^ (value | 0), 0x01000193) >>> 0;
  }
  return (h >>> 8) / 16777216;
}

/** The bars of one pass of the song. `pass` 0 or 1 within a cycle; `cycle` counts restarts. */
export function passBars(pass, cycle = 0) {
  const bars = [];
  FORM.forEach((name, sectionIndex) => {
    const section = SECTIONS[name];
    section.chords.forEach((chords, index) => {
      const last = index === section.chords.length - 1;
      bars.push({
        section: name,
        index,
        chords,
        lead: section.lead?.[index] ?? null,
        // the second pass lifts the final A an octave and adds a harmony line
        leadUp: pass === 1 && name === "A2" && sectionIndex === FORM.lastIndexOf("A2"),
        harmony: pass === 1 && (name === "A2" || name === "A"),
        counter: section.counter?.[index] ?? (pass === 1 && name === "A" ? A_COUNTER[index] : null),
        fill: last && !section.tag && (pass === 1 || hash(cycle, sectionIndex, 7) < 0.6),
        intro: Boolean(section.intro),
        lyrical: Boolean(section.lyrical),
        breakdown: Boolean(section.breakdown),
        tag: Boolean(section.tag),
        // the last bar of the tag holds, then the pass ends
        final: Boolean(section.tag) && last,
        variant: hash(cycle, pass, sectionIndex, index),
        pass,
        cycle,
      });
    });
  });
  return bars;
}

/** The bar at position `n` of the endless timeline: pass, pass, rest, pass, pass, rest, … */
export function barAt(n) {
  const passLength = passBars(0).length;
  const cycleLength = passLength * 2 + REST_BARS;
  const cycle = Math.floor(n / cycleLength);
  const offset = n - cycle * cycleLength;
  if (offset >= passLength * 2) {
    return { rest: true, section: "rest", index: offset - passLength * 2, cycle };
  }
  const pass = offset >= passLength ? 1 : 0;
  return passBars(pass, cycle)[offset - pass * passLength];
}

export function passSeconds(world) {
  const { tempo } = ARRANGEMENTS[world];
  return (passBars(0).length * 4 * 60) / tempo;
}

// ---- pitch ----------------------------------------------------------------------------------

const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export function degreeToMidi(arrangement, degree, { root = null } = {}) {
  const scale = MODES[arrangement.mode];
  const octave = Math.floor(degree / 7);
  const step = ((degree % 7) + 7) % 7;
  let semitone = scale[step];
  // minor keys borrow the raised leading tone over the dominant (harmonic minor), so the
  // V chord still pulls home
  if (arrangement.mode === "minor" && step === 6 && root !== null && ((root % 7) + 7) % 7 === 4) {
    semitone = 11;
  }
  return arrangement.key + octave * 12 + semitone;
}

function chordMidis(arrangement, root, shift = 0) {
  return [root, root + 2, root + 4].map((degree) => degreeToMidi(arrangement, degree, { root }) + shift);
}

// ---- instruments ----------------------------------------------------------------------------

function makeNoise(context) {
  const length = Math.floor(context.sampleRate * 0.5);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x2545f491;
  for (let index = 0; index < length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[index] = (seed / 2147483648) - 1;
  }
  return buffer;
}

function createVoices(context, destinationFor) {
  const noise = makeNoise(context);

  function env(param, t, peak, attack, hold, release) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    if (hold > 0) {
      param.setValueAtTime(peak, t + attack + hold);
    }
    param.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return t + attack + hold + release;
  }

  function osc(layer, { t, hz, type = "sine", peak, attack = 0.005, hold = 0, release = 0.2, to, glide, lowpass, pan, detune = 0 }) {
    const o = context.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, t);
    if (to) {
      o.frequency.exponentialRampToValueAtTime(to, t + (glide ?? attack + release));
    }
    if (detune) {
      o.detune.setValueAtTime(detune, t);
    }
    const g = context.createGain();
    const end = env(g.gain, t, peak, attack, hold, release);
    let node = o;
    if (lowpass) {
      const f = context.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(lowpass, t);
      node = node.connect(f);
    }
    node.connect(g);
    if (pan && context.createStereoPanner) {
      const p = context.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(destinationFor(layer));
    } else {
      g.connect(destinationFor(layer));
    }
    o.start(t);
    o.stop(end + 0.02);
  }

  function hiss(layer, { t, peak, attack = 0.001, release = 0.03, filter = "highpass", freq = 7000, Q = 0.7, pan }) {
    const s = context.createBufferSource();
    s.buffer = noise;
    const f = context.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    f.Q.value = Q;
    const g = context.createGain();
    const end = env(g.gain, t, peak, attack, 0, release);
    s.connect(f).connect(g);
    if (pan && context.createStereoPanner) {
      const p = context.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(destinationFor(layer));
    } else {
      g.connect(destinationFor(layer));
    }
    s.start(t, (t * 3.7) % 0.4);
    s.stop(end + 0.02);
  }

  // Melodic voices: (layer, t, midi, seconds, velocity)
  const melodic = {
    steel(layer, t, midi, dur, v) { // steel drum: bright partials, quick bloom, slight pitch drop
      const hz = midiToHz(midi);
      osc(layer, { t, hz: hz * 1.01, to: hz, glide: 0.04, peak: 0.16 * v, attack: 0.004, release: 0.18 + dur * 0.5 });
      osc(layer, { t, hz: hz * 2, peak: 0.07 * v, attack: 0.003, release: 0.12 + dur * 0.3 });
      osc(layer, { t, hz: hz * 3.01, peak: 0.025 * v, attack: 0.002, release: 0.06 });
    },
    flute(layer, t, midi, dur, v) {
      const hz = midiToHz(midi);
      osc(layer, { t, hz, peak: 0.13 * v, attack: 0.03, hold: Math.max(0, dur - 0.08), release: 0.12 });
      osc(layer, { t, hz: hz * 2, type: "triangle", peak: 0.018 * v, attack: 0.04, hold: Math.max(0, dur - 0.1), release: 0.1 });
      hiss(layer, { t, peak: 0.03 * v, release: 0.05, filter: "bandpass", freq: hz * 3, Q: 2 });
    },
    pluck(layer, t, midi, dur, v) { // banjo-ish: bright saw, filter snapping shut
      const hz = midiToHz(midi);
      const o = context.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(hz, t);
      const f = context.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(hz * 8, t);
      f.frequency.exponentialRampToValueAtTime(hz * 1.2, t + 0.18);
      const g = context.createGain();
      const end = env(g.gain, t, 0.12 * v, 0.002, 0, 0.22 + dur * 0.4);
      o.connect(f).connect(g).connect(destinationFor(layer));
      o.start(t);
      o.stop(end + 0.02);
    },
    celesta(layer, t, midi, dur, v) {
      const hz = midiToHz(midi);
      osc(layer, { t, hz, peak: 0.12 * v, attack: 0.002, release: 0.5 + dur * 0.5 });
      osc(layer, { t, hz: hz * 4, peak: 0.03 * v, attack: 0.001, release: 0.12 });
      osc(layer, { t, hz: hz * 2.76, peak: 0.02 * v, attack: 0.001, release: 0.2 });
    },
    square(layer, t, midi, dur, v) { // a soft NES-style pulse lead
      const hz = midiToHz(midi);
      osc(layer, { t, hz, type: "square", peak: 0.05 * v, attack: 0.004, hold: Math.max(0, dur * 0.7 - 0.02), release: 0.06, lowpass: 2600 });
      osc(layer, { t, hz: hz * 0.5, type: "triangle", peak: 0.05 * v, attack: 0.004, hold: Math.max(0, dur * 0.6), release: 0.05 });
    },
    glock(layer, t, midi, dur, v, pan) {
      const hz = midiToHz(midi);
      osc(layer, { t, hz, peak: 0.07 * v, attack: 0.001, release: 0.45, pan });
      osc(layer, { t, hz: hz * 2.76, peak: 0.018 * v, attack: 0.001, release: 0.15, pan });
    },
  };

  return {
    melodic,
    tuba(t, midi, dur, v) { // the oom-pah bass
      const hz = midiToHz(midi);
      osc("bass", { t, hz, type: "triangle", peak: 0.2 * v, attack: 0.012, hold: Math.max(0, dur * 0.55), release: 0.08 });
      osc("bass", { t, hz, type: "square", peak: 0.035 * v, attack: 0.015, hold: Math.max(0, dur * 0.45), release: 0.06, lowpass: 700 });
    },
    chop(t, midis, v) { // off-beat chord stab
      midis.forEach((midi, i) => osc("comp", {
        t, hz: midiToHz(midi), type: "square", peak: 0.022 * v, attack: 0.002, release: 0.07, lowpass: 1900, pan: (i - 1) * 0.35,
      }));
    },
    strum(t, midis, dur, v) { // lyrical sections: a held, softer chord
      midis.forEach((midi, i) => osc("comp", {
        t: t + i * 0.012, hz: midiToHz(midi), type: "triangle", peak: 0.04 * v, attack: 0.01, hold: dur * 0.5, release: dur * 0.4, pan: (i - 1) * 0.4,
      }));
    },
    pad(t, midis, dur, v) {
      midis.forEach((midi) => {
        const hz = midiToHz(midi);
        osc("pad", { t, hz, type: "triangle", peak: 0.03 * v, attack: dur * 0.3, hold: dur * 0.4, release: dur * 0.45, lowpass: 1300, detune: -6 });
        osc("pad", { t, hz, type: "triangle", peak: 0.03 * v, attack: dur * 0.3, hold: dur * 0.4, release: dur * 0.45, lowpass: 1300, detune: 6 });
      });
    },
    kick(t, v) {
      osc("kick", { t, hz: 130, to: 44, glide: 0.12, peak: 0.32 * v, attack: 0.002, release: 0.16 });
    },
    snare(t, v, kit) {
      if (kit === "brush") {
        hiss("snare", { t, peak: 0.07 * v, attack: 0.01, release: 0.14, filter: "bandpass", freq: 3000, Q: 0.6 });
        return;
      }
      if (kit === "hand") { // a clap
        [0, 0.012, 0.024].forEach((d) => hiss("snare", { t: t + d, peak: 0.07 * v, release: 0.05, filter: "bandpass", freq: 1400, Q: 1.2 }));
        return;
      }
      hiss("snare", { t, peak: 0.1 * v, release: 0.09, filter: "bandpass", freq: 1900, Q: 0.8 });
      osc("snare", { t, hz: 240, to: 170, glide: 0.06, type: "triangle", peak: 0.06 * v, attack: 0.001, release: 0.06 });
    },
    hat(t, v, kit) {
      hiss("hat", { t, peak: (kit === "brush" ? 0.03 : 0.04) * v, release: kit === "hand" ? 0.05 : 0.025, freq: kit === "hand" ? 5000 : 8000, pan: 0.25 });
    },
    bongo(t, high, v) {
      const hz = high ? 420 : 300;
      osc("bongo", { t, hz, to: hz * 0.8, glide: 0.05, peak: 0.12 * v, attack: 0.001, release: 0.09, pan: high ? 0.3 : -0.3 });
    },
  };
}

// ---- scheduling one bar ---------------------------------------------------------------------

function scheduleBar(voices, arrangement, info, start, barSeconds, layerOn) {
  if (info.rest) {
    return;
  }
  const eighth = barSeconds / 8;
  const swingShift = (arrangement.swing - 0.5) * 2 * eighth;
  const slotTime = (slot) => start + slot * eighth + (slot % 2 ? swingShift : 0);
  const chordAt = (slot) => (info.chords.length === 2 && slot >= 4 ? info.chords[1] : info.chords[0]);
  const kit = arrangement.kit;
  const shift = arrangement.octave ?? 0;
  const v = info.intro ? 0.85 : 1;

  // melody lines: lead (with second-pass octave lift and harmony a third below) and counter
  const line = (tokens, layer, voiceName, { octave = 0, pan } = {}) => {
    tokens.forEach((token, slot) => {
      if (token === "." || token === "-") {
        return;
      }
      let length = 1;
      while (tokens[slot + length] === "-") {
        length += 1;
      }
      const degree = Number(token);
      const root = chordAt(slot);
      const midi = degreeToMidi(arrangement, degree, { root }) + octave;
      const staccato = length === 1 && !info.lyrical;
      const dur = staccato ? eighth * 0.6 : eighth * length * 0.92;
      const accent = slot % 2 === 1 ? 1.08 : 1; // pushed off-beats bounce
      voices.melodic[voiceName](layer, slotTime(slot), midi, dur, v * accent, pan);
      if (layer === "lead" && info.harmony && voiceName !== "flute") {
        const third = degreeToMidi(arrangement, degree - 2, { root }) + octave;
        voices.melodic[voiceName](layer, slotTime(slot), third, dur, v * 0.45, pan);
      }
    });
  };
  if (info.lead && layerOn("lead")) {
    line(info.lead, "lead", arrangement.lead, { octave: shift + (info.leadUp ? 12 : 0) });
  }
  if (info.counter && layerOn("counter")) {
    line(info.counter, "counter", arrangement.counter, { octave: 12, pan: -0.3 });
  }

  // bass: oom-pah roots and fifths with a walk-up into the next bar; walking quarters in C
  if (layerOn("bass")) {
    // offset: scale steps above the chord root; +12 lifts the note an octave
    const bassNote = (root, offset, octave = 0) => degreeToMidi(arrangement, root + offset, { root }) - 24 + octave;
    if (info.breakdown) { // walking quarters: root, third, fifth, sixth
      [[0, 0], [2, 2], [4, 4], [6, 5]].forEach(([slot, offset]) => voices.tuba(slotTime(slot), bassNote(chordAt(slot), offset), eighth * 1.6, 0.9));
    } else if (info.final) {
      voices.tuba(slotTime(0), bassNote(info.chords[0], 0), eighth * 3, 1);
    } else {
      const two = info.chords.length === 2;
      // oom-pah: root, fifth, root (an octave up), fifth; two-chord bars restart on beat 3
      const pattern = two
        ? [[0, 0, 0], [2, 4, 0], [4, 0, 0], [6, 4, 0]]
        : [[0, 0, 0], [2, 4, 0], [4, 0, 12], [6, 4, 0]];
      pattern.forEach(([slot, offset, octave]) => {
        voices.tuba(slotTime(slot), bassNote(chordAt(slot), offset, octave), eighth * 0.9, slot === 0 ? 1 : 0.8);
      });
      if (info.variant > 0.45 && !two) { // a walk-up on the "and" of 4
        voices.tuba(slotTime(7), bassNote(info.chords[0], 5), eighth * 0.6, 0.7);
      }
    }
  }

  // comp: off-beat chops; held strums in the lyrical B; a pad underneath for thinking
  if (layerOn("comp")) {
    if (info.lyrical) {
      voices.strum(slotTime(0), chordMidis(arrangement, chordAt(0)), barSeconds * 0.5, 1);
      voices.strum(slotTime(4), chordMidis(arrangement, chordAt(4)), barSeconds * 0.5, 0.8);
    } else if (!info.final) {
      [1, 3, 5, 7].forEach((slot) => voices.chop(slotTime(slot), chordMidis(arrangement, chordAt(slot)), slot === 3 || slot === 7 ? 1 : 0.8));
    }
  }
  if (layerOn("pad")) {
    const chords = info.chords.length === 2 ? info.chords : [info.chords[0]];
    chords.forEach((root, i) => voices.pad(start + i * (barSeconds / chords.length), chordMidis(arrangement, root, -12), barSeconds / chords.length, 1));
  }

  // drums
  if (info.final) {
    if (layerOn("kick")) voices.kick(slotTime(0), 1);
    if (layerOn("snare")) voices.snare(slotTime(0), 1, kit);
    return;
  }
  const fillHalf = info.fill;
  if (layerOn("kick") && !info.intro) {
    const kicks = info.breakdown ? [0, 3, 4] : [0, 4];
    kicks.forEach((slot) => voices.kick(slotTime(slot), slot === 0 ? 1 : 0.8));
    if (info.variant > 0.7) voices.kick(slotTime(7), 0.6);
  }
  if (layerOn("snare")) {
    if (fillHalf) {
      [4, 5, 6, 7].forEach((slot, i) => voices.snare(slotTime(slot), 0.6 + i * 0.12, kit));
      voices.snare(slotTime(2), 0.9, kit);
    } else if (!info.intro || info.index >= 2) {
      voices.snare(slotTime(2), 0.9, kit);
      voices.snare(slotTime(6), 1, kit);
    }
  }
  if (layerOn("hat")) {
    for (let slot = 0; slot < 8; slot += 1) {
      voices.hat(slotTime(slot), slot % 2 ? 1 : 0.55, kit);
    }
  }
  if (layerOn("bongo") || (info.breakdown && layerOn("hat") && layerOn("snare"))) {
    const pattern = info.variant > 0.5 ? [[1, true], [3, false], [4, true], [5, true], [7, false]] : [[1, true], [2, false], [3, true], [5, true], [6, false], [7, true]];
    pattern.forEach(([slot, high]) => voices.bongo(slotTime(slot), high, slot % 2 ? 0.9 : 0.7));
  }
}

/**
 * Schedule bars `fromBar`… into `destinationFor(layer)` starting at `startTime`, until
 * `untilTime`. Used by the live player and by offline renders. Returns { nextBar, nextTime }.
 */
export function scheduleRange({ context, destinationFor, world, fromBar, startTime, untilTime, layerOn, voices }) {
  const arrangement = ARRANGEMENTS[world];
  const barSeconds = (4 * 60) / arrangement.tempo;
  const useVoices = voices ?? createVoices(context, destinationFor);
  let n = fromBar;
  let t = startTime;
  while (t < untilTime) {
    scheduleBar(useVoices, arrangement, barAt(n), t, barSeconds, (layer) => layerOn(layer, n));
    n += 1;
    t += barSeconds;
  }
  return { nextBar: n, nextTime: t, voices: useVoices };
}

// ---- the live player -------------------------------------------------------------------------

const STORAGE_KEY = "chess-premove-music-v1";
// fanfares the music ducks under: [gain while ducked, seconds held before recovering]
export const DUCKS = Object.freeze({
  mate: [0.4, 0.3], win: [0.25, 0.9], perfect: [0.2, 1.5], poppers: [0.3, 0.3], defeat: [0.45, 0.5],
  flag: [0.35, 0.7], stamp: [0.3, 0.5], "unlock-world": [0.3, 1.3],
});
const LOOKAHEAD = 0.6; // seconds of music kept scheduled ahead (whole bars at a time)

function ramp(param, now, value, seconds) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + seconds);
}

/**
 * `audio()` returns { context, musicInput } (the sound player's) or null without Web Audio.
 * Music starts on start(), which must run inside a user gesture, and its on/off choice is
 * remembered in localStorage. Scheduling uses an interval timer (`timers`, for tests).
 */
export function createMusicPlayer({ audio, storage = globalThis.localStorage, timers = globalThis } = {}) {
  let enabled = true;
  try {
    enabled = storage?.getItem(STORAGE_KEY) !== "off";
  } catch {
    // storage unavailable: default on
  }
  let started = false; // a user gesture has happened
  let hidden = false;
  let world = "meadow";
  let scene = "map";
  let graph = null; // { context, bus, duck }
  let run = null; // { world, layers, voices, nextBar, nextTime, timer }

  function ensureGraph() {
    if (graph) {
      return graph;
    }
    const io = audio?.();
    if (!io) {
      return null;
    }
    const { context, musicInput } = io;
    const bus = context.createGain();
    bus.gain.value = 0;
    const duck = context.createGain();
    // band-limit the music so effects' attacks and the pieces' "thock" stay in front
    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 4800;
    const highpass = context.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 55;
    bus.connect(duck).connect(lowpass).connect(highpass).connect(musicInput);
    graph = { context, bus, duck };
    return graph;
  }

  const audible = () => enabled && started && !hidden;
  const level = () => (audible() ? MUSIC_GAIN * SCENE_LEVEL[scene] : 0);

  function tick() {
    if (!run) return;
    const until = graph.context.currentTime + LOOKAHEAD;
    if (run.nextTime >= until) return;
    const { layers } = run;
    const next = scheduleRange({
      context: graph.context,
      destinationFor: (layer) => layers[layer],
      world: run.world,
      fromBar: run.nextBar,
      startTime: run.nextTime,
      untilTime: until,
      // layers that are off don't get notes; one turned on comes in at the next bar line
      layerOn: (layer) => SCENES[scene][layer] > 0,
      voices: run.voices,
    });
    run.nextBar = next.nextBar;
    run.nextTime = next.nextTime;
  }

  // Each run gets its own layer gains, so stopping one fades out exactly its scheduled notes.
  function startRun() {
    stopRun();
    if (!audible() || !ensureGraph()) return;
    const { context, bus } = graph;
    const layers = {};
    for (const layer of LAYERS) {
      layers[layer] = context.createGain();
      layers[layer].gain.value = SCENES[scene][layer];
      layers[layer].connect(bus);
    }
    run = {
      world,
      layers,
      voices: createVoices(context, (layer) => layers[layer]),
      nextBar: 0,
      nextTime: context.currentTime + 0.12,
      timer: timers.setInterval(tick, 100),
    };
    ramp(bus.gain, context.currentTime, level(), 0.3);
    tick();
  }

  function stopRun(fade = 0.5) {
    if (!run) return;
    timers.clearInterval(run.timer);
    const { layers } = run;
    const now = graph.context.currentTime;
    for (const layer of LAYERS) {
      ramp(layers[layer].gain, now, 0, fade);
    }
    timers.setTimeout(() => LAYERS.forEach((layer) => layers[layer].disconnect()), (fade + LOOKAHEAD + 2.5) * 1000);
    run = null;
  }

  function setMuted(value) {
    enabled = !value;
    try {
      storage?.setItem(STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      // not remembered, but applies to this session
    }
    if (audible()) startRun();
    else stopRun(0.4);
    return !enabled;
  }

  return Object.freeze({
    /** Call inside a user gesture: allows audio and starts the music if it's on. */
    start() {
      if (started) return;
      started = true;
      startRun();
    },
    /** Which world's arrangement to play, and the scene: "map" | "planning" | "playing". */
    update({ world: nextWorld = world, scene: nextScene = scene } = {}) {
      if (SCENES[nextScene] && nextScene !== scene) {
        scene = nextScene;
        if (run) {
          const now = graph.context.currentTime;
          for (const layer of LAYERS) {
            ramp(run.layers[layer].gain, now, SCENES[scene][layer], 0.35);
          }
          ramp(graph.bus.gain, now, level(), 0.5);
        }
      }
      if (ARRANGEMENTS[nextWorld] && nextWorld !== world) {
        world = nextWorld;
        if (run) startRun(); // a new world starts its tune from the top, like entering a level
      }
    },
    /** Dip the music under a fanfare (see DUCKS). */
    duck(soundName) {
      const spec = DUCKS[soundName];
      if (!spec || !run) return;
      const [depth, hold] = spec;
      const gain = graph.duck.gain;
      const now = graph.context.currentTime;
      ramp(gain, now, depth, 0.06);
      gain.setValueAtTime(depth, now + 0.06 + hold);
      gain.linearRampToValueAtTime(1, now + 0.06 + hold + 0.9);
    },
    /** Pause while the tab is hidden; resume (from the top) when it's back. */
    setHidden(value) {
      hidden = Boolean(value);
      if (audible()) startRun();
      else stopRun(0.1);
    },
    isMuted: () => !enabled,
    isPlaying: () => Boolean(run),
    setMuted,
    toggleMuted: () => setMuted(enabled),
    state: () => ({ world, scene, enabled, started, hidden, bar: run?.nextBar ?? null }),
  });
}
