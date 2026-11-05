// Background music: a different original piece for each world, synthesized live with Web Audio
// like the sound effects (no audio files). Design notes, from research into how classic
// platformer music works:
//
// * Every area sounds like a place. Mario games give each kind of area its own piece: the
//   bright overworld, the sparse, staccato, minor underground theme, the swaying snow waltzes,
//   the exotic desert themes and the pounding castle music. Each world here gets its own tune,
//   metre, scale, tempo, instruments and rhythm section:
//     1 Pawn Meadows     "Overworld": C major, swung 4/4, steel drum over oom-pah and off-beat chop
//     2 Knight's Wood    "Moonlit Gallop": D minor, 6/8, sparse dry plucks with lots of silence (the
//                        underground idea), hoof clip-clops, crickets, an ocarina middle section
//                        and a chase over a descending minor bass
//     3 Bishop's Dunes   "Mirage": E phrygian dominant, a drone, darbuka rhythm, an ornamented reed
//                        lead with oud answers
//     4 Rook's Frostpeak "Snowfall Waltz": F lydian 3/4, celesta, music box, sleigh bells, wind
//     5 Queen's Crater   "Throne of Fire": A minor, a pounding bass ostinato, organ stabs, a tritone,
//                        timpani: castle music
// * Rhythm and bounce. Kondo's music puts a syncopated melody over a steady accompaniment that
//   matches how the game moves, and it must not overpower the sound effects: the music sits
//   about 10 dB under them, is band-limited, and ducks under fanfares.
// * Vertical layering. Like Yoshi's bongos, layers come and go with what the player is doing
//   while the piece keeps going: the full band on the maps. A level is where the player spends
//   their time, so the tune keeps playing there too: while planning, the whole piece goes on a
//   little softer and behind a low-pass filter (the "muffled" music games use behind a menu),
//   with the backbeat and pad eased back, so it keeps you company without pulling focus; when
//   the line plays out, the filter opens and the full band and the world's percussion come in:
//   the payoff.
// * Fighting loop fatigue. Each piece runs about 1:45 to 2:35; the second pass varies (the
//   last A lifted an octave, a harmony line, fills), and after two passes the music rests
//   before starting again.
//
// Melodies are written in scale degrees (0 = tonic, 7 = the octave above), with "#"/"b" for
// chromatic notes. The scheduler is pure apart from the AudioContext calls, so the same code
// renders into an OfflineAudioContext for testing.

// ---- notation -------------------------------------------------------------------------------

/** A bar of tokens, one per slot (an eighth note): a degree ("4", "-2", "4b"), "-" holds, "." rests. */
const bar = (text) => text.trim().split(/\s+/);
const bars = (...texts) => texts.map(bar);
const rests = (count, slots) => Array.from({ length: count }, () => Array(slots).fill("."));

export const SCALES = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
});

export function parseToken(token) {
  const match = /^(-?\d+)([#b]?)$/.exec(String(token));
  if (!match) return null;
  return { degree: Number(match[1]), shift: match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0 };
}

/** MIDI note of a degree token in a song's key and scale. `root` is the chord's root degree. */
export function degreeToMidi(song, token, { root = null } = {}) {
  const { degree, shift } = typeof token === "number" ? { degree: token, shift: 0 } : parseToken(token);
  const scale = SCALES[song.scale];
  const octave = Math.floor(degree / 7);
  const step = ((degree % 7) + 7) % 7;
  let semitone = scale[step];
  // minor keys borrow the raised leading tone over the dominant (harmonic minor), so V pulls home
  if (song.raiseLeadingTone && step === 6 && root !== null && ((root % 7) + 7) % 7 === 4) {
    semitone += 1;
  }
  return song.key + octave * 12 + semitone + shift;
}

function chordMidis(song, root, shift = 0) {
  return [root, root + 2, root + 4].map((degree) => degreeToMidi(song, degree, { root }) + shift);
}

// ---- the songs ------------------------------------------------------------------------------

// Layers (gain nodes the scenes fade): lead and counter melodies, bass, comp (chords), drums,
// perc (the world's signature percussion), pad (a soft bed under planning), amb (ambience: crickets, wind…).
const LAYERS = ["lead", "counter", "bass", "comp", "kick", "snare", "hat", "perc", "pad", "amb"];
const DEFAULT_SCENES = {
  map: { lead: 1, counter: 1, bass: 1, comp: 1, kick: 1, snare: 1, hat: 1, perc: 0, pad: 0, amb: 1 },
  planning: { lead: 0.7, counter: 0.5, bass: 0.85, comp: 0.7, kick: 0.6, snare: 0.35, hat: 0.5, perc: 0, pad: 0.3, amb: 1 },
  playing: { lead: 1, counter: 0.9, bass: 1, comp: 0.9, kick: 1, snare: 1, hat: 1, perc: 1, pad: 0, amb: 1 },
};
export const SCENES = Object.freeze(DEFAULT_SCENES);

const ALL8 = [0, 1, 2, 3, 4, 5, 6, 7];

// 1 · Pawn Meadows: the overworld theme
const MEADOW = {
  title: "Overworld",
  key: 60, scale: "major", tempo: 112, beats: 4, slots: 8, swing: 0.6, strong: [0, 4], level: 1,
  voices: { lead: "steel", counter: "glock", bass: "tuba", pad: "warm" },
  harmony: true,
  patterns: {
    bass: [[0, 0, 0, 0.9, 1], [2, 4, 0, 0.9, 0.8], [4, 0, 12, 0.9, 0.8], [6, 4, 0, 0.9, 0.8]],
    bassTwo: [[0, 0, 0, 0.9, 1], [2, 4, 0, 0.9, 0.8], [4, 0, 0, 0.9, 0.8], [6, 4, 0, 0.9, 0.8]],
    walkUp: { slot: 7, offset: 5 },
    comp: { style: "chop", slots: [1, 3, 5, 7] },
    drums: {
      kick: [[0, 1], [4, 0.8]],
      snare: [[2, 0.9], [6, 1]],
      hat: ALL8.map((slot) => [slot, slot % 2 ? 1 : 0.55]),
      perc: [[1, 0.9, "hi"], [2, 0.7, "lo"], [3, 0.9, "hi"], [5, 0.9, "hi"], [6, 0.7, "lo"], [7, 0.9, "hi"]],
    },
    extraKick: 7,
    fill: { drum: "snare", slots: [2, 4, 5, 6, 7] },
  },
  sections: {
    intro: { chords: [[0], [3], [0], [4]], lead: rests(4, 8), counter: [...rests(3, 8), bar(". . . . 4 5 6 -")], intro: true },
    A: {
      chords: [[0], [5], [3], [4], [0], [5], [1, 4], [0]],
      lead: bars("4 . 7 . 6 7 . 4", "- . 5 4 2 - . 0", "3 . 5 . 7 8 . 7", "- . 6 . 4 . 1 2",
        "4 . 7 . 6 7 . 9", "- . 8 7 5 - 4 5", "5 . 3 1 4 - 6 -", "7 . 4 . 7 . . ."),
      counter2: bars(". . . . . . . .", ". . 9 . . . 7 .", ". . . . . . . .", ". . 8 . . . 6 .",
        ". . . . . . . .", ". . 10 . . . 9 .", ". . . . . . . .", ". . . . . . . ."),
    },
    A2: {
      chords: [[0], [5], [3], [4], [2], [5], [1, 4], [0]],
      lead: bars("4 . 7 . 6 7 . 4", "- . 5 4 2 - . 0", "3 . 5 . 7 8 . 7", "- . 6 . 4 5 6 -",
        "6 . 9 . 8 9 . 6", "- . 7 6 5 - . 2", "3 5 8 - 4 6 8 -", "7 . . 4 7 . . ."),
    },
    B: {
      chords: [[3], [3], [0], [5], [1], [1], [4], [4]],
      lead: bars("5 - - 3 5 - 7 -", "8 - - - 7 . 5 .", "4 - - 2 4 - 7 -", "5 - - - . . . .",
        "3 - - 1 3 - 5 -", "8 - - - 7 . 5 .", "6 - - 4 6 - 8 -", "9 - 8 - 6 - 4 -"),
      counter: bars(". . . . . . . .", ". . . . . . 9 10", ". . . . . . . .", ". . . . 9 8 7 6",
        ". . . . . . . .", ". . . . . . 10 11", ". . . . . . . .", ". . . . . . . ."),
      legato: true,
      patterns: { comp: { style: "strum", slots: [0, 4] } },
    },
    C: { // breakdown: no melody, bell fragments over bongos and a walking bass
      chords: [[5], [5], [3], [3], [5], [5], [1], [4]],
      lead: null,
      counter: bars("9 . 7 . . . . .", ". . . . 8 . 6 .", ". . . . . . . .", "8 . 7 . 5 . . .",
        "9 . 7 . . . . .", ". . . . 8 . 9 .", "8 . . . . . . .", ". . . . 4 5 6 -"),
      featurePerc: true,
      patterns: {
        bass: [[0, 0, 0, 1.6, 0.9], [2, 2, 0, 1.6, 0.9], [4, 4, 0, 1.6, 0.9], [6, 5, 0, 1.6, 0.9]],
        walkUp: null,
        drums: { kick: [[0, 1], [3, 0.8], [4, 0.8]] },
      },
    },
    tag: { chords: [[0], [0]], lead: bars("7 . 4 . 7 . . .", "0 . . . . . . ."), tag: true },
  },
  form: ["intro", "A", "A2", "B", "A2", "C", "B", "A2", "tag"],
};

// 2 · Knight's Wood: nighttime, in a minor key; sparse and dry like an underground theme,
// galloping in 6/8
const FOREST = {
  title: "Moonlit Gallop",
  key: 62, scale: "minor", raiseLeadingTone: true, tempo: 63, beats: 2, slots: 6, swing: 0.5, strong: [0, 3], level: 1.75,
  voices: { lead: "pizz", counter: "celesta", bass: "pizzbass", pad: "dark", arp: "oud" },
  snare: "brush",
  harmony: false,
  ambience: "crickets",
  scenes: { map: { perc: 1 }, planning: { perc: 0.35 }, playing: { perc: 1 } },
  patterns: {
    bass: [[0, 0, 0, 0.7, 1], [3, 4, 0, 0.7, 0.75]],
    comp: { style: "tick", slots: [2, 5] },
    drums: {
      kick: [[0, 0.35]], // a quiet heartbeat
      snare: [[3, 0.45]],
      hat: [],
      perc: [[0, 0.8, "hi"], [2, 0.65, "lo"], [3, 0.9, "hi"], [5, 0.65, "lo"]], // hooves: a trot
    },
    fill: { drum: "perc", slots: [3, 4, 5], variant: "lo" },
  },
  sections: {
    intro: { chords: [[0], [0], [5], [4]], lead: rests(4, 6), counter: [...rests(3, 6), bar(". . . 7 6 4")], intro: true },
    A: {
      chords: [[0], [0], [5], [4], [0], [3], [4], [0]],
      // short calls with silence after them, like an underground theme
      lead: bars("0 . 2 3 . 4", ". . . 3 2 .", "5 . 4 2 . 0", ". . . . . 1",
        "7 . 6 4 . 2", ". . . 3 . .", "6 . 4 . 1 .", "0 . . . . ."),
    },
    A2: {
      chords: [[0], [0], [5], [4], [3], [3], [4], [0]],
      lead: bars("0 . 2 3 . 4", ". . . 3 2 .", "5 . 4 2 . 0", "4 . 6 . 8 .",
        "3 . 5 7 . 10", ". . . 9 . 7", "8 . 6 . 4 6", "7 . . . . ."),
    },
    B: { // an ocarina sings over held chords
      chords: [[5], [6], [0], [0], [3], [4], [5], [4]],
      lead: bars("7 - - 5 - -", "6 - - 8 - -", "7 - - - 9 -", "8 - 7 - - .",
        "10 - - 9 - -", "8 - - 6 - -", "7 - - 5 - 2", "4 - - - . ."),
      counter: bars(". . . . . .", ". . . . 14 .", ". . . . . .", ". . . 11 . 9",
        ". . . . . .", ". . . . 13 .", ". . . . . .", ". . . . . ."),
      leadVoice: "ocarina",
      legato: true,
      patterns: { comp: { style: "strum", slots: [0] }, drums: { perc: [[0, 0.8, "hi"], [3, 0.7, "hi"]] } },
    },
    C: { // the chase: a gallop over a descending minor bass (i, VII, VI, V)
      chords: [[0], [6], [5], [4], [0], [6], [5], [4]],
      lead: null,
      counter: bars("7 . 9 10 . 11", ". . . . . .", "12 . 11 9 . 7", ". . . . . .",
        "7 . 9 10 . 11", ". . . . . .", "12 . 11 9 . 8", "6 . . . . ."),
      bass: bars("0 . . 0 . 0", "-1 . . -1 . -1", "-2 . . -2 . -2", "-3 . . -3 . -3",
        "0 . . 0 . 0", "-1 . . -1 . -1", "-2 . . -2 . -2", "-3 . . -3 . -3"),
      featurePerc: true,
      patterns: {
        comp: { style: "arp", slots: [0, 1, 2, 3, 4, 5] },
        drums: {
          kick: [[0, 0.6], [3, 0.5]],
          perc: [[0, 1, "hi"], [1, 0.6, "lo"], [2, 0.75, "lo"], [3, 1, "hi"], [4, 0.6, "lo"], [5, 0.75, "lo"]],
        },
      },
    },
    tag: { chords: [[4], [0]], lead: bars("4 . 6 . 8 .", "7 . . . . ."), tag: true },
  },
  form: ["intro", "A", "A2", "B", "A2", "C", "B", "A2", "tag"],
};

// 3 · Bishop's Dunes: a snake-charmer scale over a drone and a darbuka
const DESERT = {
  title: "Mirage",
  key: 64, scale: "phrygianDominant", tempo: 96, beats: 4, slots: 8, swing: 0.5, strong: [0, 4], level: 1.75,
  voices: { lead: "reed", counter: "oud", bass: "drone", pad: "warm" },
  hat: "tamb",
  harmony: false,
  ornament: true,
  counterOctave: 0,
  ambience: "wind",
  scenes: { map: { perc: 1 }, planning: { perc: 0.45 }, playing: { perc: 1 } },
  patterns: {
    bass: [[0, 0, 0, 1, 1], [3, 0, 0, 0.8, 0.6], [4, 0, 0, 1, 0.85]],
    drone: true,
    comp: { style: "none" },
    drums: {
      kick: [[0, 0.6]],
      snare: [],
      hat: [[2, 0.5], [6, 0.6]],
      // maqsum: dum tek . tek dum . tek .
      perc: [[0, 1, "dum"], [1, 0.65, "tek"], [3, 0.8, "tek"], [4, 1, "dum"], [6, 0.8, "tek"], [0, 0.6, "zill", 4]],
    },
    fill: { drum: "perc", slots: [4, 5, 6, 7], variant: "tek" },
  },
  sections: {
    intro: {
      chords: [[0], [0], [1], [0]],
      lead: rests(4, 8),
      counter: bars("0 . . 1 0 . . .", ". . . . . . . .", "1 . . 3 1 . . .", ". . . . 2 1 0 ."),
      intro: true,
    },
    A: {
      chords: [[0], [0], [1], [0], [3], [1], [0], [0]],
      lead: bars("0 . 1 0 2 . 3 2", "4 - - . 2 3 2 1", "3 - 1 . 5 - 3 .", "2 1 0 - - - . .",
        "5 . 4 5 7 - 5 .", "8 - 7 . 5 . 3 .", "4 . 3 4 2 . 1 2", "0 - - - . . . ."),
    },
    A2: {
      chords: [[0], [0], [1], [0], [3], [6], [1], [0]],
      lead: bars("0 . 1 0 2 . 3 2", "4 - - . 2 3 2 1", "3 - 1 . 5 - 3 .", "2 1 0 - - - . .",
        "7 . 5 3 5 - 7 .", "6 - 8 - 10 - 8 .", "8 - 7 . 5 - 3 .", "2 . 1 0 . . . ."),
    },
    B: { // the reed wails up high; the oud answers
      chords: [[3], [3], [0], [0], [6], [6], [1], [0]],
      lead: bars("7 - - - 5 - 7 -", "5 - - - 3 - - .", "4 - - - 2 - 4 -", "2 - - - . . . .",
        "6 - - - 8 - 6 -", "10 - 8 - 6 - - .", "8 - - - 5 - 3 -", "7 - - - - - . ."),
      counter: bars(". . . . . . . .", ". . . . . . 3 2", ". . . . . . . .", ". . . . 2 1 0 .",
        ". . . . . . . .", ". . . . . . 8 6", ". . . . . . . .", ". . . . . . . ."),
      legato: true,
    },
    C: { // sandstorm: drone, a busy darbuka and an oud ostinato
      chords: [[0], [0], [1], [1], [0], [0], [1], [0]],
      lead: null,
      counter: bars("0 1 2 1 0 . 1 .", "0 1 2 1 0 . 2 .", "1 2 3 2 1 . 3 .", "1 2 3 2 1 . 2 .",
        "0 1 2 1 0 . 1 .", "0 1 2 4 2 . 1 .", "1 2 3 2 1 . 3 .", "2 1 0 . . . . ."),
      featurePerc: true,
      patterns: {
        drums: {
          perc: [[0, 1, "dum"], [1, 0.6, "tek"], [2, 0.7, "tek"], [3, 0.9, "tek"], [4, 1, "dum"], [5, 0.6, "tek"], [6, 0.9, "dum"], [7, 0.7, "tek"]],
        },
      },
    },
    tag: { chords: [[1], [0]], lead: bars("3 . 2 1 2 . 1 2", "0 . . . . . . ."), tag: true },
  },
  form: ["intro", "A", "A2", "B", "A2", "C", "B", "A2", "tag"],
};

// 4 · Rook's Frostpeak: a snowfall waltz
const FROST = {
  title: "Snowfall Waltz",
  key: 65, scale: "lydian", tempo: 126, beats: 3, slots: 6, swing: 0.5, strong: [0], level: 1.85,
  voices: { lead: "celesta", counter: "musicbox", bass: "softbass", pad: "air", arp: "musicbox" },
  hat: "sleigh",
  harmony: true,
  ambience: "wind",
  scenes: { map: { perc: 1 }, planning: { perc: 0.5 }, playing: { perc: 1 } },
  patterns: {
    bass: [[0, 0, 0, 2, 1]],
    comp: { style: "waltz", slots: [2, 4] },
    arp: { slots: [1, 3, 5] },
    drums: {
      kick: [[0, 0.3]],
      snare: [],
      hat: [[0, 0.6], [2, 0.8], [4, 0.8], [5, 0.4]], // sleigh bells
      perc: [[0, 0.8, "tri", 2]],
    },
    fill: { drum: "hat", slots: [3, 4, 5] },
  },
  sections: {
    intro: { chords: [[0], [1], [0], [1]], lead: rests(4, 6), intro: true },
    A: {
      chords: [[0], [1], [5], [4], [0], [1], [4], [0]],
      lead: bars("4 - - 2 4 7", "8 - - 10 - 8", "9 - - 7 - 5", "6 - - - 4 -",
        "4 - - 2 4 7", "10 - - 8 - 10", "11 - 9 - 8 6", "7 - - - - -"),
    },
    A2: {
      chords: [[0], [1], [5], [4], [0], [1], [4], [0]],
      lead: bars("4 - - 2 4 7", "8 - - 10 - 8", "9 - - 7 - 5", "6 - - - 4 -",
        "4 - - 2 4 9", "8 - 10 - 12 -", "11 - - 9 - 6", "7 - - - . ."),
    },
    B: {
      chords: [[5], [2], [1], [4], [5], [2], [1], [4]],
      lead: bars("12 - - 9 - -", "11 - - 9 - -", "10 - - 8 - -", "8 - - - 6 -",
        "12 - 13 12 9 -", "11 - 12 11 9 -", "10 - 12 10 8 -", "11 - - - . ."),
      legato: true,
    },
    B2: {
      chords: [[5], [2], [1], [4], [5], [2], [4], [0]],
      lead: bars("12 - - 9 - -", "11 - - 9 - -", "10 - - 8 - -", "8 - - - 6 -",
        "12 - 13 12 9 -", "11 - 12 11 9 -", "11 - 9 - 8 6", "7 - - - - -"),
      legato: true,
    },
    C: { // a music box alone in the snow
      chords: [[0], [0], [1], [1], [5], [5], [4], [4]],
      lead: null,
      patterns: { arp: { slots: [0, 1, 2, 3, 4, 5] }, comp: { style: "none" } },
    },
    tag: {
      chords: [[0], [1], [4], [0]],
      lead: bars("7 - - 9 - 11", "10 - - 8 - -", "6 - - 8 - 11", "7 - - - - -"),
      tag: true,
    },
  },
  form: ["intro", "A", "A2", "B", "B2", "A2", "C", "B", "B2", "A2", "tag"],
};

// 5 · Queen's Crater: the castle
const VOLCANO = {
  title: "Throne of Fire",
  key: 57, scale: "minor", raiseLeadingTone: true, tempo: 138, beats: 4, slots: 8, swing: 0.5, strong: [0, 4], level: 0.9,
  voices: { lead: "square", counter: "glock", bass: "heavy", pad: "organ" },
  leadOctave: 12,
  harmony: true,
  ambience: "rumble",
  scenes: { map: { perc: 1 }, planning: { perc: 0.3 }, playing: { perc: 1 } },
  patterns: {
    // a pounding ostinato: root, root, octave, root, root, octave, seventh, octave
    bass: [0, 1, 2, 3, 4, 5, 6, 7].map((slot) => [slot, [0, 0, 7, 0, 0, 7, 6, 7][slot], 0, 0.8, slot % 2 ? 0.75 : 1]),
    comp: { style: "stab", slots: [3, 7] },
    drums: {
      kick: [[0, 1], [2, 0.85], [4, 1], [6, 0.85]],
      snare: [[2, 1], [6, 1]],
      hat: [[1, 0.7], [3, 0.7], [5, 0.7], [7, 0.7]],
      perc: [[0, 1, "timp", 2]],
    },
    fill: { drum: "perc", slots: [4, 5, 6, 7], variant: "tom" },
  },
  sections: {
    intro: { chords: [[0], [0], [0], [4]], lead: [...rests(3, 8), bar(". . . . 4 - 6 -")], intro: true },
    A: {
      chords: [[0], [0], [5], [4], [0], [0], [3], [4]],
      lead: bars("0 - - 2 4 - 3 2", "0 - - - 4b - - -", "5 - - 7 9 - 7 -", "6 - 4 - 1 - - -",
        "7 - - 9 11 - 10 9", "7 - - - 11b - - -", "10 - 9 - 7 - 5 -", "6 - - - . . . ."),
    },
    A2: {
      chords: [[0], [0], [5], [4], [0], [0], [3, 4], [0]],
      lead: bars("0 - - 2 4 - 3 2", "0 - - - 4b - - -", "5 - - 7 9 - 7 -", "6 - 4 - 1 - - -",
        "7 - - 9 11 - 10 9", "7 - - - 11b - - -", "10 - 9 - 8 - 6 -", "7 - - - . . . ."),
    },
    B: { // defiant, in the relative major
      chords: [[5], [6], [0], [0], [5], [6], [4], [4]],
      lead: bars("9 - - 10 9 - 7 -", "8 - - 10 8 - 6 -", "7 - - - 4 - - -", "2 - 3 - 4 - 6 -",
        "9 - - 10 12 - 10 -", "13 - 12 - 10 - 8 -", "11 - - - 13 - - -", "11 - - - . . . ."),
    },
    C: { // eruption: alarm bells over toms
      chords: [[0], [5], [0], [5], [3], [3], [4], [4]],
      lead: null,
      counter: bars("14 . . . 14 . . .", ". . 12 . . . 11 .", "14 . . . 14 . . .", ". . 12 . . . 13 .",
        "10 . . . 10 . . .", ". . 12 . . . 10 .", "11 . . . 11 . . .", "13 . 11 . 8 . 6 ."),
      featurePerc: true,
      patterns: { drums: { perc: [[0, 1, "tom"], [3, 0.9, "tom"], [6, 0.9, "tom"], [7, 0.7, "tom"]] } },
    },
    tag: { chords: [[0], [0]], lead: bars("7 . 4 . 0 . 4b .", "0 . . . . . . ."), tag: true },
  },
  form: ["intro", "A", "A2", "B", "A2", "C", "B", "A2", "tag"],
};

export const SONGS = Object.freeze({ meadow: MEADOW, forest: FOREST, desert: DESERT, frost: FROST, volcano: VOLCANO });
export const REST_BARS = 8; // silence after every second pass

/** Layer gains for a world's piece in a scene ("map" | "planning" | "playing"). */
export function sceneGains(world, scene) {
  return { ...DEFAULT_SCENES[scene], ...(SONGS[world]?.scenes?.[scene] ?? {}) };
}

// Overall music level (after the mixer): roughly 10 dB under the effects on the maps.
export const MUSIC_GAIN = 0.34;
// Each scene's overall level and tone (the music bus's low-pass cutoff, Hz). Planning is a
// little quieter and muffled; playing is as loud and bright as the map (its extra percussion
// is offset by a slightly lower level).
const SCENE_MIX = Object.freeze({
  map: { level: 1, tone: 4800 },
  planning: { level: 0.82, tone: 2600 },
  playing: { level: 0.92, tone: 4800 },
});
export const sceneLevel = (scene) => SCENE_MIX[scene].level;
export const sceneTone = (scene) => SCENE_MIX[scene].tone;

// ---- timeline -------------------------------------------------------------------------------

/** Pseudo-random 0..1 from integers, so a given bar always varies the same way. */
function hash(...values) {
  let h = 0x811c9dc5;
  for (const value of values) {
    h = Math.imul(h ^ (value | 0), 0x01000193) >>> 0;
  }
  return (h >>> 8) / 16777216;
}

const passCache = new Map();

/** The bars of one pass of a world's piece. `pass` 0 or 1 within a cycle; `cycle` counts restarts. */
export function passBars(world, pass = 0, cycle = 0) {
  const cacheKey = `${world}/${pass}/${cycle}`;
  if (passCache.has(cacheKey)) return passCache.get(cacheKey);
  const song = SONGS[world];
  const lastA = song.form.lastIndexOf("A2");
  const result = [];
  song.form.forEach((name, sectionIndex) => {
    const section = song.sections[name];
    section.chords.forEach((chords, index) => {
      const last = index === section.chords.length - 1;
      result.push({
        world,
        section: name,
        index,
        chords,
        lead: section.lead?.[index] ?? null,
        leadVoice: section.leadVoice ?? null,
        // the second pass lifts the final A an octave and adds a harmony line
        leadUp: pass === 1 && sectionIndex === lastA,
        harmony: pass === 1 && song.harmony && (name === "A" || name === "A2"),
        counter: section.counter?.[index] ?? (pass === 1 ? section.counter2?.[index] ?? null : null),
        bassLine: section.bass?.[index] ?? null,
        patterns: section.patterns ?? null,
        fill: last && !section.tag && (pass === 1 || hash(cycle, sectionIndex, 7) < 0.6),
        intro: Boolean(section.intro),
        legato: Boolean(section.legato),
        featurePerc: Boolean(section.featurePerc),
        tag: Boolean(section.tag),
        final: Boolean(section.tag) && last,
        variant: hash(cycle, pass, sectionIndex, index),
        pass,
        cycle,
      });
    });
  });
  passCache.set(cacheKey, result);
  return result;
}

/** The bar at position `n` of a world's endless timeline: pass, pass, rest, pass, pass, rest, … */
export function barAt(world, n) {
  const passLength = passBars(world, 0).length;
  const cycleLength = passLength * 2 + REST_BARS;
  const cycle = Math.floor(n / cycleLength);
  const offset = n - cycle * cycleLength;
  if (offset >= passLength * 2) {
    return { world, rest: true, section: "rest", index: offset - passLength * 2, cycle };
  }
  const pass = offset >= passLength ? 1 : 0;
  return passBars(world, pass, cycle)[offset - pass * passLength];
}

export const barSeconds = (world) => (SONGS[world].beats * 60) / SONGS[world].tempo;
export const passSeconds = (world) => passBars(world, 0).length * barSeconds(world);

// ---- instruments ----------------------------------------------------------------------------

const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

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

  function out(node, layer, pan) {
    if (pan && context.createStereoPanner) {
      const panner = context.createStereoPanner();
      panner.pan.value = pan;
      node.connect(panner).connect(destinationFor(layer));
    } else {
      node.connect(destinationFor(layer));
    }
  }

  function osc(layer, {
    t, hz, type = "sine", peak, attack = 0.005, hold = 0, release = 0.2, to, glide, from, lowpass, bandpass, Q = 1, pan, detune = 0, vibrato,
  }) {
    const o = context.createOscillator();
    o.type = type;
    if (from) { // a grace note: start on a neighbour, land on the note
      o.frequency.setValueAtTime(from, t);
      o.frequency.setValueAtTime(hz, t + 0.055);
    } else {
      o.frequency.setValueAtTime(hz, t);
    }
    if (to) {
      o.frequency.exponentialRampToValueAtTime(to, t + (glide ?? attack + release));
    }
    if (detune) {
      o.detune.setValueAtTime(detune, t);
    }
    const g = context.createGain();
    const end = env(g.gain, t, peak, attack, hold, release);
    let node = o;
    if (vibrato) {
      const lfo = context.createOscillator();
      lfo.frequency.setValueAtTime(vibrato.rate, t);
      const depth = context.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(hz * vibrato.depth, t + Math.min(0.25, (end - t) * 0.5));
      lfo.connect(depth).connect(o.frequency);
      lfo.start(t);
      lfo.stop(end + 0.02);
    }
    if (lowpass) {
      const f = context.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(lowpass, t);
      node = node.connect(f);
    }
    if (bandpass) {
      const f = context.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.setValueAtTime(bandpass, t);
      f.Q.value = Q;
      node = node.connect(f);
    }
    node.connect(g);
    out(g, layer, pan);
    o.start(t);
    o.stop(end + 0.02);
  }

  function hiss(layer, { t, peak, attack = 0.001, hold = 0, release = 0.03, filter = "highpass", freq = 7000, to, Q = 0.7, pan }) {
    const s = context.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    const f = context.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (to) {
      f.frequency.exponentialRampToValueAtTime(to, t + attack + hold + release);
    }
    f.Q.value = Q;
    const g = context.createGain();
    const end = env(g.gain, t, peak, attack, hold, release);
    s.connect(f).connect(g);
    out(g, layer, pan);
    s.start(t, (t * 3.7) % 0.4);
    s.stop(end + 0.02);
  }

  function sweptSaw(layer, t, hz, { peak, open, close, sweep, release, pan }) {
    const o = context.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(hz, t);
    const f = context.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(open, t);
    f.frequency.exponentialRampToValueAtTime(close, t + sweep);
    const g = context.createGain();
    const end = env(g.gain, t, peak, 0.002, 0, release);
    o.connect(f).connect(g);
    out(g, layer, pan);
    o.start(t);
    o.stop(end + 0.02);
  }

  // Melodic voices: (layer, t, midi, seconds, velocity, { pan, grace })
  const melodic = {
    steel(layer, t, midi, dur, v) { // steel drum: bright partials, quick bloom, slight pitch drop
      const hz = midiToHz(midi);
      osc(layer, { t, hz: hz * 1.01, to: hz, glide: 0.04, peak: 0.16 * v, attack: 0.004, release: 0.18 + dur * 0.5 });
      osc(layer, { t, hz: hz * 2, peak: 0.07 * v, attack: 0.003, release: 0.12 + dur * 0.3 });
      osc(layer, { t, hz: hz * 3.01, peak: 0.025 * v, attack: 0.002, release: 0.06 });
    },
    pizz(layer, t, midi, dur, v) { // dry, plucked, a little hollow: the underground feel
      const hz = midiToHz(midi);
      osc(layer, { t, hz, type: "triangle", peak: 0.17 * v, attack: 0.002, release: 0.1 + Math.min(dur, 0.4) * 0.25 });
      osc(layer, { t, hz: hz * 2, peak: 0.05 * v, attack: 0.001, release: 0.04 });
      hiss(layer, { t, peak: 0.03 * v, release: 0.015, filter: "bandpass", freq: Math.min(hz * 5, 6000), Q: 3 });
    },
    ocarina(layer, t, midi, dur, v) {
      const hz = midiToHz(midi);
      osc(layer, { t, hz, peak: 0.13 * v, attack: 0.06, hold: Math.max(0, dur - 0.12), release: 0.18, vibrato: { rate: 5, depth: 0.007 } });
      osc(layer, { t, hz: hz * 3, peak: 0.008 * v, attack: 0.08, hold: Math.max(0, dur - 0.15), release: 0.12 });
      hiss(layer, { t, peak: 0.02 * v, attack: 0.03, release: 0.1, filter: "bandpass", freq: hz * 2, Q: 1.5 });
    },
    reed(layer, t, midi, dur, v, { grace } = {}) { // nasal snake-charmer reed with a grace note
      const hz = midiToHz(midi);
      osc(layer, {
        t, hz, from: grace ? midiToHz(grace) : null, type: "sawtooth", peak: 0.12 * v, attack: 0.015, hold: Math.max(0, dur - 0.06), release: 0.08,
        bandpass: 1300, Q: 1.1, vibrato: dur > 0.3 ? { rate: 6, depth: 0.012 } : null,
      });
      osc(layer, { t, hz: hz * 0.5, type: "square", peak: 0.012 * v, attack: 0.02, hold: Math.max(0, dur - 0.06), release: 0.06, lowpass: 900 });
    },
    oud(layer, t, midi, dur, v, { pan } = {}) {
      sweptSaw(layer, t, midiToHz(midi), { peak: 0.1 * v, open: midiToHz(midi) * 6, close: midiToHz(midi) * 1.1, sweep: 0.12, release: 0.2 + dur * 0.3, pan });
    },
    flute(layer, t, midi, dur, v) {
      const hz = midiToHz(midi);
      osc(layer, { t, hz, peak: 0.13 * v, attack: 0.03, hold: Math.max(0, dur - 0.08), release: 0.12 });
      hiss(layer, { t, peak: 0.03 * v, release: 0.05, filter: "bandpass", freq: hz * 3, Q: 2 });
    },
    celesta(layer, t, midi, dur, v, { pan } = {}) {
      const hz = midiToHz(midi);
      osc(layer, { t, hz, peak: 0.12 * v, attack: 0.002, release: 0.5 + dur * 0.5, pan });
      osc(layer, { t, hz: hz * 4, peak: 0.03 * v, attack: 0.001, release: 0.12, pan });
      osc(layer, { t, hz: hz * 2.76, peak: 0.02 * v, attack: 0.001, release: 0.2, pan });
    },
    musicbox(layer, t, midi, dur, v, { pan } = {}) {
      const hz = midiToHz(midi);
      osc(layer, { t, hz, peak: 0.06 * v, attack: 0.001, release: 0.6, pan });
      osc(layer, { t, hz: hz * 3, peak: 0.012 * v, attack: 0.001, release: 0.15, pan });
    },
    square(layer, t, midi, dur, v) { // a soft NES-style pulse lead
      const hz = midiToHz(midi);
      osc(layer, { t, hz, type: "square", peak: 0.05 * v, attack: 0.004, hold: Math.max(0, dur * 0.8 - 0.02), release: 0.06, lowpass: 2600 });
      osc(layer, { t, hz: hz * 0.5, type: "triangle", peak: 0.05 * v, attack: 0.004, hold: Math.max(0, dur * 0.7), release: 0.05 });
    },
    glock(layer, t, midi, dur, v, { pan } = {}) {
      const hz = midiToHz(midi);
      osc(layer, { t, hz, peak: 0.07 * v, attack: 0.001, release: 0.45, pan });
      osc(layer, { t, hz: hz * 2.76, peak: 0.018 * v, attack: 0.001, release: 0.15, pan });
    },
  };

  const bassVoices = {
    tuba(t, midi, dur, v) { // the oom-pah bass
      const hz = midiToHz(midi);
      osc("bass", { t, hz, type: "triangle", peak: 0.2 * v, attack: 0.012, hold: Math.max(0, dur * 0.55), release: 0.08 });
      osc("bass", { t, hz, type: "square", peak: 0.035 * v, attack: 0.015, hold: Math.max(0, dur * 0.45), release: 0.06, lowpass: 700 });
    },
    pizzbass(t, midi, dur, v) { // plucked upright bass, short
      const hz = midiToHz(midi);
      osc("bass", { t, hz, type: "triangle", peak: 0.27 * v, attack: 0.004, release: 0.3 });
      osc("bass", { t, hz: hz * 2, peak: 0.05 * v, attack: 0.002, release: 0.06 });
    },
    softbass(t, midi, dur, v) {
      const hz = midiToHz(midi);
      osc("bass", { t, hz, peak: 0.22 * v, attack: 0.008, release: 0.35 + dur * 0.3 });
      osc("bass", { t, hz: hz * 2, type: "triangle", peak: 0.03 * v, attack: 0.005, release: 0.12 });
    },
    drone(t, midi, dur, v) { // the plucked root on top of the drone
      sweptSaw("bass", t, midiToHz(midi), { peak: 0.12 * v, open: midiToHz(midi) * 5, close: midiToHz(midi) * 1.2, sweep: 0.15, release: 0.3 });
    },
    heavy(t, midi, dur, v) { // castle ostinato: punchy, gritty
      const hz = midiToHz(midi);
      osc("bass", { t, hz, type: "sawtooth", peak: 0.1 * v, attack: 0.003, hold: dur * 0.4, release: 0.06, lowpass: 650 });
      osc("bass", { t, hz, type: "triangle", peak: 0.14 * v, attack: 0.003, hold: dur * 0.4, release: 0.06 });
    },
  };

  return {
    melodic,
    bass: bassVoices,
    drone(t, midis, dur) { // a held tonic and fifth under a whole bar
      midis.forEach((midi, i) => {
        const hz = midiToHz(midi);
        osc("bass", { t, hz, type: "sawtooth", peak: 0.035, attack: dur * 0.2, hold: dur * 0.6, release: dur * 0.3, lowpass: 520, detune: i ? 4 : -4 });
      });
    },
    comp(style, t, midis, dur, v) {
      if (style === "chop") { // off-beat chord stab
        midis.forEach((midi, i) => osc("comp", { t, hz: midiToHz(midi), type: "square", peak: 0.022 * v, attack: 0.002, release: 0.07, lowpass: 1900, pan: (i - 1) * 0.35 }));
      } else if (style === "strum") { // a held, softer chord
        midis.forEach((midi, i) => osc("comp", { t: t + i * 0.012, hz: midiToHz(midi), type: "triangle", peak: 0.04 * v, attack: 0.01, hold: dur * 0.5, release: dur * 0.4, pan: (i - 1) * 0.4 }));
      } else if (style === "tick") { // a soft, dry off-beat
        midis.forEach((midi, i) => osc("comp", { t, hz: midiToHz(midi), type: "triangle", peak: 0.06 * v, attack: 0.002, release: 0.09, pan: (i - 1) * 0.3 }));
      } else if (style === "waltz") { // pah-pah
        midis.forEach((midi, i) => osc("comp", { t, hz: midiToHz(midi), type: "triangle", peak: 0.034 * v, attack: 0.004, release: 0.18, pan: (i - 1) * 0.35 }));
      } else if (style === "stab") { // organ hits
        midis.forEach((midi, i) => {
          osc("comp", { t, hz: midiToHz(midi), type: "sawtooth", peak: 0.022 * v, attack: 0.003, hold: 0.06, release: 0.1, lowpass: 1500, detune: -5, pan: (i - 1) * 0.3 });
          osc("comp", { t, hz: midiToHz(midi), type: "square", peak: 0.016 * v, attack: 0.003, hold: 0.06, release: 0.1, lowpass: 1500, detune: 5, pan: (1 - i) * 0.3 });
        });
      }
    },
    pad(kind, t, midis, dur) {
      const settings = {
        warm: { type: "triangle", lowpass: 1300, peak: 0.03, shift: 0 },
        dark: { type: "triangle", lowpass: 650, peak: 0.02, shift: -12 },
        air: { type: "sine", lowpass: 3000, peak: 0.026, shift: 12 },
        organ: { type: "square", lowpass: 800, peak: 0.016, shift: 0 },
      }[kind] ?? { type: "triangle", lowpass: 1300, peak: 0.03, shift: 0 };
      midis.forEach((midi) => {
        const hz = midiToHz(midi + settings.shift);
        for (const detune of [-6, 6]) {
          osc("pad", { t, hz, type: settings.type, peak: settings.peak, attack: dur * 0.3, hold: dur * 0.4, release: dur * 0.45, lowpass: settings.lowpass, detune });
        }
      });
    },
    kick(t, v) {
      osc("kick", { t, hz: 130, to: 44, glide: 0.12, peak: 0.32 * v, attack: 0.002, release: 0.16 });
    },
    snare(kind, t, v, layer = "snare") {
      if (kind === "brush") {
        hiss(layer, { t, peak: 0.12 * v, attack: 0.01, release: 0.16, filter: "bandpass", freq: 3000, Q: 0.6 });
      } else {
        hiss(layer, { t, peak: 0.1 * v, release: 0.09, filter: "bandpass", freq: 1900, Q: 0.8 });
        osc(layer, { t, hz: 240, to: 170, glide: 0.06, type: "triangle", peak: 0.06 * v, attack: 0.001, release: 0.06 });
      }
    },
    hat(kind, t, v, layer = "hat") {
      if (kind === "sleigh") { // jingles: a bright shake plus two tiny bells
        hiss(layer, { t, peak: 0.06 * v, attack: 0.004, release: 0.09, filter: "bandpass", freq: 7000, Q: 2, pan: 0.3 });
        osc(layer, { t, hz: 3520, peak: 0.016 * v, attack: 0.001, release: 0.09, pan: 0.3 });
        osc(layer, { t: t + 0.015, hz: 4186, peak: 0.012 * v, attack: 0.001, release: 0.08, pan: -0.2 });
      } else if (kind === "tamb") {
        hiss(layer, { t, peak: 0.08 * v, attack: 0.002, release: 0.08, filter: "bandpass", freq: 6500, Q: 1.5, pan: 0.25 });
      } else {
        hiss(layer, { t, peak: 0.04 * v, release: 0.025, freq: 8000, pan: 0.25 });
      }
    },
    perc(kind, t, v, layer = "perc") {
      switch (kind) {
        case "hi": case "lo": // bongos
          osc(layer, { t, hz: kind === "hi" ? 420 : 300, to: kind === "hi" ? 336 : 240, glide: 0.05, peak: 0.12 * v, attack: 0.001, release: 0.09, pan: kind === "hi" ? 0.3 : -0.3 });
          break;
        case "hoofHi": case "hoofLo": // woodblock hooves
          osc(layer, { t, hz: kind === "hoofHi" ? 1150 : 820, to: kind === "hoofHi" ? 900 : 650, glide: 0.03, type: "triangle", peak: 0.14 * v, attack: 0.001, release: 0.05, pan: kind === "hoofHi" ? 0.2 : -0.2 });
          hiss(layer, { t, peak: 0.05 * v, release: 0.014, filter: "bandpass", freq: 2500, Q: 2 });
          break;
        case "dum":
          osc(layer, { t, hz: 120, to: 70, glide: 0.12, peak: 0.2 * v, attack: 0.002, release: 0.22 });
          break;
        case "tek":
          hiss(layer, { t, peak: 0.07 * v, release: 0.035, filter: "bandpass", freq: 3200, Q: 1.4, pan: 0.15 });
          osc(layer, { t, hz: 640, to: 520, glide: 0.03, type: "triangle", peak: 0.04 * v, attack: 0.001, release: 0.03 });
          break;
        case "zill": // finger cymbals
          osc(layer, { t, hz: 2637, peak: 0.03 * v, attack: 0.001, release: 0.9, pan: -0.3 });
          osc(layer, { t, hz: 2637 * 2.32, peak: 0.012 * v, attack: 0.001, release: 0.5, pan: -0.3 });
          break;
        case "tri":
          osc(layer, { t, hz: 2093, peak: 0.03 * v, attack: 0.001, release: 1.2, pan: 0.35 });
          osc(layer, { t, hz: 2093 * 2.76, peak: 0.01 * v, attack: 0.001, release: 0.7, pan: 0.35 });
          break;
        case "timp":
          osc(layer, { t, hz: 98, to: 82, glide: 0.5, peak: 0.22 * v, attack: 0.004, release: 0.7 });
          hiss(layer, { t, peak: 0.04 * v, release: 0.08, filter: "lowpass", freq: 900 });
          break;
        case "tom":
          osc(layer, { t, hz: 180, to: 110, glide: 0.15, peak: 0.2 * v, attack: 0.002, release: 0.22 });
          break;
        default:
          throw new RangeError(`Unknown percussion: ${kind}`);
      }
    },
    ambience(kind, t, barLength, variant) {
      if (kind === "crickets") { // two or three quick chirps somewhere in the bar
        const count = variant > 0.5 ? 3 : 2;
        const at = t + barLength * (0.15 + variant * 0.6);
        for (let i = 0; i < count; i += 1) {
          osc("amb", { t: at + i * 0.07, hz: 4700, peak: 0.02, attack: 0.008, release: 0.035, pan: variant * 1.2 - 0.6 });
        }
      } else if (kind === "wind") { // a slow, breathy swell
        hiss("amb", { t, peak: 0.035, attack: barLength * 0.5, hold: 0, release: barLength * 0.9, filter: "bandpass", freq: 500 + variant * 600, to: 900 + variant * 900, Q: 2.5, pan: variant - 0.5 });
      } else if (kind === "rumble") { // lava far below
        hiss("amb", { t, peak: 0.03, attack: barLength * 0.4, release: barLength * 0.7, filter: "lowpass", freq: 140, Q: 0.8 });
      }
    },
  };
}

// ---- scheduling one bar ---------------------------------------------------------------------

function scheduleBar(voices, song, info, start, length, layerOn) {
  if (info.rest) {
    return;
  }
  const slots = song.slots;
  const slotLength = length / slots;
  const swingShift = (song.swing - 0.5) * 2 * slotLength;
  const slotTime = (slot) => start + slot * slotLength + (slot % 2 ? swingShift : 0);
  const half = slots / 2;
  const chordAt = (slot) => (info.chords.length === 2 && slot >= half ? info.chords[1] : info.chords[0]);
  const patterns = { ...song.patterns, ...(info.patterns ?? {}) };
  const drums = { ...song.patterns.drums, ...(info.patterns?.drums ?? {}) };
  const v = info.intro ? 0.85 : 1;

  // melodies: lead (second pass: an octave lift and a harmony line a third below) and counter
  const line = (tokens, layer, voiceName, octave, pan) => {
    tokens.forEach((token, slot) => {
      if (token === "." || token === "-") {
        return;
      }
      let held = 1;
      while (tokens[slot + held] === "-") {
        held += 1;
      }
      const root = chordAt(slot);
      const midi = degreeToMidi(song, token, { root }) + octave;
      const staccato = held === 1 && !info.legato;
      const dur = staccato ? slotLength * 0.6 : slotLength * held * 0.92;
      const accent = slot % 2 === 1 && song.swing > 0.5 ? 1.08 : 1; // pushed off-beats bounce
      // ornament: long notes get a quick grace note from the scale step above
      const parsed = parseToken(token);
      const grace = song.ornament && held >= 2 ? degreeToMidi(song, parsed.degree + 1, { root }) + octave : null;
      voices.melodic[voiceName](layer, slotTime(slot), midi, dur, v * accent, { pan, grace });
      if (layer === "lead" && info.harmony) {
        const third = degreeToMidi(song, parsed.degree - 2, { root }) + parsed.shift + octave;
        voices.melodic[voiceName](layer, slotTime(slot), third, dur, v * 0.45, { pan });
      }
    });
  };
  const leadOctave = (song.leadOctave ?? 0) + (info.leadUp ? 12 : 0);
  if (info.lead && layerOn("lead")) {
    line(info.lead, "lead", info.leadVoice ?? song.voices.lead, leadOctave);
  }
  if (layerOn("counter")) {
    if (info.counter) {
      line(info.counter, "counter", song.voices.counter, song.counterOctave ?? 12, -0.3);
    } else if (patterns.arp) { // a music-box/oud arpeggio of the chord between melody notes
      patterns.arp.slots.forEach((slot, i) => {
        const midis = chordMidis(song, chordAt(slot), 12);
        voices.melodic[song.voices.arp](
          "counter", slotTime(slot), midis[(i + Math.floor(info.variant * 3)) % 3] + (i >= 3 ? 12 : 0), slotLength, 0.9, { pan: 0.25 * (i % 2 ? 1 : -1) },
        );
      });
    }
  }

  // bass: an explicit line, or the song's pattern over each chord
  if (layerOn("bass")) {
    const bassVoice = voices.bass[song.voices.bass];
    const bassMidi = (degree, root) => degreeToMidi(song, degree, { root }) - 24;
    if (patterns.drone) {
      voices.drone(start, [song.key - 24, degreeToMidi(song, 4) - 24], length);
    }
    if (info.final) {
      bassVoice(slotTime(0), bassMidi(info.chords[0], info.chords[0]), slotLength * 3, 1);
    } else if (info.bassLine) {
      info.bassLine.forEach((token, slot) => {
        if (token !== "." && token !== "-") {
          bassVoice(slotTime(slot), degreeToMidi(song, token, { root: chordAt(slot) }) - 24, slotLength * 0.9, slot === 0 ? 1 : 0.8);
        }
      });
    } else {
      const steps = info.chords.length === 2 && patterns.bassTwo ? patterns.bassTwo : patterns.bass;
      steps.forEach(([slot, offset, octave, held, velocity]) => {
        const root = chordAt(slot);
        bassVoice(slotTime(slot), bassMidi(root + offset, root) + octave, slotLength * held, velocity);
      });
      if (patterns.walkUp && info.chords.length === 1 && info.variant > 0.45) { // a walk-up into the next bar
        bassVoice(slotTime(patterns.walkUp.slot), bassMidi(info.chords[0] + patterns.walkUp.offset, info.chords[0]), slotLength * 0.6, 0.7);
      }
    }
  }

  // chords
  if (layerOn("comp") && !info.final && patterns.comp?.style !== "none") {
    if (patterns.comp.style === "arp") { // gallop arpeggio on the oud/pluck
      patterns.comp.slots.forEach((slot, i) => {
        const midis = chordMidis(song, chordAt(slot), -12);
        voices.melodic[song.voices.arp ?? "oud"]("comp", slotTime(slot), midis[[0, 1, 2, 1, 0, 2][i % 6]], slotLength * 0.8, slot % 3 === 0 ? 0.9 : 0.6);
      });
    } else {
      const held = patterns.comp.style === "strum" ? length / patterns.comp.slots.length : slotLength;
      patterns.comp.slots.forEach((slot, i) => {
        voices.comp(patterns.comp.style, slotTime(slot), chordMidis(song, chordAt(slot)), held, i % 2 ? 1 : 0.85);
      });
    }
  }
  if (layerOn("pad")) {
    const chords = info.chords.length === 2 ? info.chords : [info.chords[0]];
    chords.forEach((root, i) => voices.pad(song.voices.pad, start + i * (length / chords.length), chordMidis(song, root, -12), length / chords.length));
  }
  if (song.ambience && layerOn("amb")) {
    voices.ambience(song.ambience, start, length, info.variant);
  }

  // drums. Featured percussion (the breakdowns) rides the snare layer, so it's heard on the maps.
  const percLayer = info.featurePerc ? "snare" : "perc";
  const playPerc = (slot, velocity, kind) => voices.perc(PERC_KINDS[song.voices.perc ?? song.world]?.[kind] ?? kind, slotTime(slot), velocity, percLayer);
  if (info.final) {
    if (layerOn("kick")) voices.kick(slotTime(0), 1);
    if (layerOn(percLayer)) playPerc(0, 1, drums.perc?.[0]?.[2] ?? "hi");
    return;
  }
  if (layerOn("kick") && !info.intro) {
    (drums.kick ?? []).forEach(([slot, velocity]) => voices.kick(slotTime(slot), velocity));
    if (patterns.extraKick !== undefined && info.variant > 0.7) voices.kick(slotTime(patterns.extraKick), 0.6);
  }
  const snareKind = song.snare ?? "snare";
  const fill = info.fill ? patterns.fill : null;
  if (layerOn("snare")) {
    if (fill?.drum === "snare") {
      fill.slots.forEach((slot, i) => voices.snare(snareKind, slotTime(slot), 0.6 + i * 0.1));
    } else if (!info.intro || info.index >= 2) {
      (drums.snare ?? []).forEach(([slot, velocity]) => voices.snare(snareKind, slotTime(slot), velocity));
    }
  }
  if (layerOn("hat")) {
    (drums.hat ?? []).forEach(([slot, velocity]) => voices.hat(song.hat ?? "hat", slotTime(slot), velocity));
    if (fill?.drum === "hat") fill.slots.forEach((slot, i) => voices.hat(song.hat ?? "hat", slotTime(slot) + slotLength / 2, 0.6 + i * 0.1));
  }
  if (layerOn(percLayer)) {
    (drums.perc ?? []).forEach(([slot, velocity, kind, every]) => {
      if (!every || info.index % every === 0) playPerc(slot, velocity, kind);
    });
    if (fill?.drum === "perc") fill.slots.forEach((slot, i) => playPerc(slot, 0.6 + i * 0.12, fill.variant));
  }
}

// Each world's percussion names map onto the instruments in createVoices().perc.
const PERC_KINDS = {
  forest: { hi: "hoofHi", lo: "hoofLo" },
};

/**
 * Schedule bars `fromBar`… of a world's piece into `destinationFor(layer)` from `startTime` until
 * `untilTime` (whole bars). Used by the live player and by offline renders.
 */
export function scheduleRange({ context, destinationFor, world, fromBar, startTime, untilTime, layerOn, voices }) {
  const song = { ...SONGS[world], world };
  const length = barSeconds(world);
  const useVoices = voices ?? createVoices(context, destinationFor);
  // bar times by multiplication (repeated addition drifts and can sneak in an extra bar)
  let n = fromBar;
  const timeOf = (bar) => startTime + (bar - fromBar) * length;
  while (timeOf(n) < untilTime - 1e-9) {
    scheduleBar(useVoices, song, barAt(world, n), timeOf(n), length, (layer) => layerOn(layer, n));
    n += 1;
  }
  return { nextBar: n, nextTime: timeOf(n), voices: useVoices };
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
    lowpass.frequency.value = sceneTone(scene);
    const highpass = context.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 55;
    bus.connect(duck).connect(lowpass).connect(highpass).connect(musicInput);
    graph = { context, bus, duck, lowpass };
    return graph;
  }

  const audible = () => enabled && started && !hidden;
  const level = () => (audible() ? MUSIC_GAIN * sceneLevel(scene) * (SONGS[world]?.level ?? 1) : 0);

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
      layerOn: (layer) => sceneGains(run.world, scene)[layer] > 0,
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
      layers[layer].gain.value = sceneGains(world, scene)[layer];
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
    ramp(graph.lowpass.frequency, context.currentTime, sceneTone(scene), 0.3);
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
            ramp(run.layers[layer].gain, now, sceneGains(run.world, scene)[layer], 0.35);
          }
          ramp(graph.bus.gain, now, level(), 0.5);
          ramp(graph.lowpass.frequency, now, sceneTone(scene), 0.5);
        }
      }
      if (SONGS[nextWorld] && nextWorld !== world) {
        world = nextWorld;
        if (run) startRun(); // a new world starts its own tune from the top, like entering a level
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
