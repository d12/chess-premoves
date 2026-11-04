import assert from "node:assert/strict";
import test from "node:test";
import { createSoundPlayer, SOUND_NAMES, soundForMove, synthesize } from "../src/effects/sound.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

// A minimal stand-in for AudioContext that records what gets scheduled and checks the graph.
function fakeContext() {
  const log = { starts: [], nodes: 0, maxEnd: 0, rampToZero: 0 };
  const param = (value = 0) => ({
    value,
    setValueAtTime(v, t) { assert.ok(Number.isFinite(v) && t >= 0); this.value = v; },
    exponentialRampToValueAtTime(v, t) {
      assert.ok(v > 0, "exponential ramps need a positive target");
      assert.ok(Number.isFinite(t) && t >= 0);
      if (v <= 0.001) log.rampToZero += 1;
    },
    linearRampToValueAtTime() {},
  });
  const node = (extra = {}) => {
    log.nodes += 1;
    return {
      connect(target) {
        assert.ok(target && typeof target === "object", "connected to a node");
        return target;
      },
      ...extra,
    };
  };
  const source = (extra) => node({
    start(t) { assert.ok(t >= 0); log.starts.push(t); },
    stop(t) { log.maxEnd = Math.max(log.maxEnd, t); },
    ...extra,
  });
  const context = {
    sampleRate: 8000,
    currentTime: 10,
    state: "running",
    destination: node(),
    createOscillator: () => source({ type: "sine", frequency: param(440) }),
    createBufferSource: () => source({ buffer: null }),
    createGain: () => node({ gain: param(1) }),
    createBiquadFilter: () => node({ type: "lowpass", frequency: param(350), Q: param(1) }),
    createStereoPanner: () => node({ pan: param(0) }),
    createWaveShaper: () => node({ curve: null, oversample: "none" }),
    createBuffer: (channels, length) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    },
    resume: async () => {},
    suspend: async () => {},
    log,
  };
  return context;
}

test("moves map to sounds by their SAN", () => {
  assert.equal(soundForMove({ san: "Qc3" }), "move");
  assert.equal(soundForMove({ san: "Qxc1" }), "capture");
  assert.equal(soundForMove({ san: "Rb1+" }), "check");
  assert.equal(soundForMove({ san: "Rxb1+" }), "check", "a capturing check sounds like a check");
  assert.equal(soundForMove({ san: "Qa1#" }), "mate");
  assert.equal(soundForMove({ san: "O-O" }), "castle");
  assert.equal(soundForMove({ san: "O-O-O" }), "castle");
  assert.equal(soundForMove({ san: "e8=Q" }), "promote");
  assert.equal(soundForMove({ san: "exd8=Q+" }), "check");
  assert.equal(soundForMove(null), "move");
});

test("every sound builds a valid, finite, self-ending graph", () => {
  for (const name of SOUND_NAMES) {
    for (const opponent of [false, true]) {
      const context = fakeContext();
      synthesize(context, context.destination, name, 1, { opponent });
      assert.ok(context.log.starts.length > 0, `${name} starts something`);
      assert.ok(context.log.starts.every((t) => t >= 1), `${name} never starts in the past`);
      assert.ok(context.log.maxEnd > 1 && context.log.maxEnd < 1 + 2.5, `${name} stops within 2.5 s (${context.log.maxEnd - 1})`);
      assert.ok(context.log.rampToZero > 0, `${name} fades out`);
    }
  }
  assert.throws(() => synthesize(fakeContext(), {}, "kazoo", 0), /Unknown sound/);
});

test("the player schedules sounds, remembers mute, and stays silent while muted", () => {
  const storage = memoryStorage();
  let created = 0;
  const context = fakeContext();
  const player = createSoundPlayer({ storage, createContext: () => { created += 1; return context; } });
  assert.equal(created, 0, "no AudioContext until the first sound");
  assert.equal(player.isMuted(), false);
  assert.equal(player.play("move"), true);
  assert.ok(context.log.starts.every((t) => t >= context.currentTime));
  assert.equal(player.play("win", { when: 0.25 }), true);
  assert.ok(Math.min(...context.log.starts.slice(-3)) >= context.currentTime + 0.25);
  assert.equal(created, 1, "the context is reused");

  assert.equal(player.toggleMuted(), true);
  const before = context.log.starts.length;
  assert.equal(player.play("move"), false);
  assert.equal(context.log.starts.length, before);
  assert.equal(storage.values.get("chess-premove-sound-v1"), "off");
  assert.equal(createSoundPlayer({ storage, createContext: fakeContext }).isMuted(), true, "mute survives a reload");
  player.setMuted(false);
  assert.equal(createSoundPlayer({ storage, createContext: fakeContext }).isMuted(), false);
  assert.throws(() => player.play("kazoo"), /Unknown sound/, "a misspelt sound name is a bug");
  player.setMuted(true);
  assert.throws(() => player.play("kazoo"), /Unknown sound/, "even while muted");
  const heard = [];
  const logged = createSoundPlayer({ storage: memoryStorage(), createContext: fakeContext, onPlay: (name, details) => heard.push([name, details]) });
  logged.play("hop", { when: 0.26 });
  assert.deepEqual(heard, [["hop", { when: 0.26, opponent: false, muted: false }]]);
});

test("no Web Audio or broken storage never breaks the game", () => {
  const player = createSoundPlayer({ storage: null, createContext: () => null });
  assert.equal(player.play("move"), false);
  assert.equal(player.play("move"), false);
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  const quiet = createSoundPlayer({ storage: throwing, createContext: () => { throw new Error("no audio"); } });
  assert.equal(quiet.isMuted(), false);
  assert.equal(quiet.play("click"), false);
  assert.equal(quiet.setMuted(true), true, "mute still applies for the session");
});
