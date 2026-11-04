import assert from "node:assert/strict";
import test from "node:test";
import {
  ARRANGEMENTS, barAt, createMusicPlayer, degreeToMidi, DUCKS, FORM, MUSIC_GAIN, passBars, passSeconds, REST_BARS, SCENES, scheduleRange,
} from "../src/effects/music.js";
import { SOUND_NAMES } from "../src/effects/sound.js";

// A fake AudioContext that records scheduled sources per destination layer.
function fakeContext() {
  const log = { starts: [], bad: 0 };
  const param = (value = 0) => ({
    value,
    events: [],
    setValueAtTime(v, t) { if (!Number.isFinite(v) || !Number.isFinite(t)) log.bad += 1; this.events.push(["set", v, t]); this.value = v; },
    linearRampToValueAtTime(v, t) { if (!Number.isFinite(v) || !Number.isFinite(t)) log.bad += 1; this.events.push(["ramp", v, t]); this.value = v; },
    exponentialRampToValueAtTime(v, t) { if (!(v > 0) || !Number.isFinite(t)) log.bad += 1; this.events.push(["exp", v, t]); },
    cancelScheduledValues() {},
  });
  const node = (extra = {}) => ({
    connections: [],
    connect(target) { this.connections.push(target); target.inputs = (target.inputs ?? 0) + 1; return target; },
    disconnect() { this.connections = []; },
    ...extra,
  });
  const source = (extra) => node({
    start(t) { if (!Number.isFinite(t)) log.bad += 1; log.starts.push({ t, node: this }); },
    stop() {},
    ...extra,
  });
  return {
    sampleRate: 8000,
    currentTime: 5,
    state: "running",
    destination: node(),
    createOscillator: () => source({ type: "sine", frequency: param(440), detune: param(0) }),
    createBufferSource: () => source({ buffer: null }),
    createGain: () => node({ gain: param(1) }),
    createBiquadFilter: () => node({ type: "lowpass", frequency: param(350), Q: param(1) }),
    createStereoPanner: () => node({ pan: param(0) }),
    createBuffer: (channels, length) => { const data = new Float32Array(length); return { getChannelData: () => data }; },
    log,
  };
}

// Follow connections downstream to find which layer gain a source ends in.
function layerOf(start, layers) {
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n)) return null;
    seen.add(n);
    for (const [name, gain] of Object.entries(layers)) if (gain === n) return name;
    for (const next of n.connections ?? []) { const found = walk(next); if (found) return found; }
    return null;
  };
  return walk(start.node);
}

test("the song is long enough not to feel loopy, and every bar is well formed", () => {
  const bars = passBars(0);
  assert.equal(FORM[0], "intro");
  assert.ok(bars.length >= 56, `${bars.length} bars`);
  for (const world of Object.keys(ARRANGEMENTS)) {
    const seconds = passSeconds(world);
    assert.ok(seconds >= 120 && seconds <= 170, `${world}: one pass lasts ${seconds.toFixed(0)} s`);
  }
  for (const bar of bars) {
    assert.ok(bar.chords.length === 1 || bar.chords.length === 2);
    for (const line of [bar.lead, bar.counter]) {
      if (!line) continue;
      assert.equal(line.length, 8, `${bar.section}[${bar.index}] has 8 eighths`);
      for (const token of line) {
        assert.ok(token === "." || token === "-" || (Number.isInteger(Number(token)) && Number(token) >= -3 && Number(token) <= 12), `token ${token}`);
      }
    }
  }
  assert.ok(bars.some((bar) => bar.breakdown && bar.lead === null), "a breakdown without the melody");
});

test("the second pass varies the first, and the music rests after two passes", () => {
  const [first, second] = [passBars(0), passBars(1)];
  assert.equal(first.length, second.length);
  assert.ok(second.some((bar) => bar.leadUp) && !first.some((bar) => bar.leadUp), "the last A is lifted an octave");
  assert.ok(second.some((bar) => bar.harmony) && !first.some((bar) => bar.harmony), "a harmony line on the second pass");
  assert.ok(second.filter((bar) => bar.counter).length > first.filter((bar) => bar.counter).length, "more counter-melody");
  const passLength = first.length;
  assert.equal(barAt(0).section, "intro");
  assert.equal(barAt(passLength).pass, 1);
  for (let n = 0; n < REST_BARS; n += 1) {
    assert.equal(barAt(passLength * 2 + n).rest, true);
  }
  assert.equal(barAt(passLength * 2 + REST_BARS).section, "intro", "then it starts again");
  assert.equal(barAt(passLength * 2 + REST_BARS).cycle, 1);
});

test("each world recolours the same tune with its own key and mode", () => {
  const keys = new Set(Object.values(ARRANGEMENTS).map((a) => `${a.key}/${a.mode}/${a.lead}`));
  assert.equal(keys.size, Object.keys(ARRANGEMENTS).length, "every world sounds different");
  const meadow = ARRANGEMENTS.meadow;
  assert.equal(degreeToMidi(meadow, 0), 60);
  assert.equal(degreeToMidi(meadow, 7), 72);
  assert.equal(degreeToMidi(meadow, 6), 71);
  assert.equal(degreeToMidi(ARRANGEMENTS.desert, 6) - ARRANGEMENTS.desert.key, 10, "mixolydian has a flat seventh");
  const volcano = ARRANGEMENTS.volcano;
  assert.equal(degreeToMidi(volcano, 2) - volcano.key, 3, "minor third");
  assert.equal(degreeToMidi(volcano, 6) - volcano.key, 10, "natural seventh over most chords");
  assert.equal(degreeToMidi(volcano, 6, { root: 4 }) - volcano.key, 11, "raised leading tone over the dominant");
  for (const scene of Object.values(SCENES)) {
    assert.deepEqual(Object.keys(scene).sort(), Object.keys(SCENES.map).sort());
  }
  for (const name of Object.keys(DUCKS)) {
    assert.ok(SOUND_NAMES.includes(name), `ducks under a real sound: ${name}`);
  }
});

test("scheduling fills the window with bars, only into layers that are on", () => {
  for (const world of Object.keys(ARRANGEMENTS)) {
    const context = fakeContext();
    const layers = Object.fromEntries(Object.keys(SCENES.map).map((name) => [name, context.createGain()]));
    const barSeconds = 240 / ARRANGEMENTS[world].tempo;
    const result = scheduleRange({
      context,
      destinationFor: (name) => layers[name],
      world,
      fromBar: 4, // the first A
      startTime: 1,
      untilTime: 1 + barSeconds * 3,
      layerOn: (name) => SCENES.planning[name] > 0,
    });
    assert.equal(result.nextBar, 7);
    assert.ok(Math.abs(result.nextTime - (1 + barSeconds * 3)) < 1e-9);
    assert.equal(context.log.bad, 0, `${world}: every time and value is finite`);
    const used = new Set(context.log.starts.map((start) => layerOf(start, layers)));
    assert.ok(context.log.starts.length > 30, `${world}: ${context.log.starts.length} notes`);
    assert.ok(context.log.starts.every((start) => start.t >= 1 && start.t < 1 + barSeconds * 3 + 0.01));
    for (const name of used) {
      assert.ok(SCENES.planning[name] > 0, `${world}: no notes for the muted ${name} layer`);
    }
    assert.ok(used.has("pad") && used.has("bass") && !used.has("lead") && !used.has("kick"));
  }
});

function fakeTimers() {
  const timers = { intervals: new Map(), timeouts: [], next: 1 };
  return {
    setInterval(fn) { const id = timers.next++; timers.intervals.set(id, fn); return id; },
    clearInterval(id) { timers.intervals.delete(id); },
    setTimeout(fn) { timers.timeouts.push(fn); return timers.next++; },
    tickAll() { for (const fn of timers.intervals.values()) fn(); },
    get running() { return timers.intervals.size; },
  };
}

function memoryStorage() {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), values };
}

test("the player waits for a gesture, follows scenes and worlds, ducks, and remembers off", () => {
  const context = fakeContext();
  const musicInput = context.createGain();
  const timers = fakeTimers();
  const storage = memoryStorage();
  let asked = 0;
  const player = createMusicPlayer({ audio: () => { asked += 1; return { context, musicInput }; }, storage, timers });
  assert.equal(player.isPlaying(), false);
  player.update({ world: "forest", scene: "map" });
  assert.equal(asked, 0, "no audio before a user gesture");

  player.start();
  assert.equal(player.isPlaying(), true);
  assert.equal(timers.running, 1);
  assert.ok(context.log.starts.length > 0, "the first bars are scheduled at once");
  assert.equal(player.state().world, "forest");

  // scene change: no restart, layers ramp
  const before = player.state().bar;
  player.update({ scene: "planning" });
  assert.equal(player.state().scene, "planning");
  assert.equal(player.state().bar, before, "a scene change keeps the song going");

  // world change: restart from the top of the new arrangement
  context.currentTime += 3;
  timers.tickAll();
  player.update({ world: "volcano" });
  assert.equal(player.state().world, "volcano");
  assert.ok(player.state().bar <= 2, "a new world starts its tune from the top");
  assert.equal(timers.running, 1, "the old run's timer is gone");

  player.duck("win");
  player.duck("move"); // not a fanfare: ignored

  player.setHidden(true);
  assert.equal(player.isPlaying(), false);
  player.setHidden(false);
  assert.equal(player.isPlaying(), true);

  assert.equal(player.toggleMuted(), true);
  assert.equal(player.isPlaying(), false);
  assert.equal(timers.running, 0);
  assert.equal(storage.values.get("chess-premove-music-v1"), "off");
  const reloaded = createMusicPlayer({ audio: () => ({ context, musicInput }), storage, timers });
  assert.equal(reloaded.isMuted(), true, "off survives a reload");
  reloaded.start();
  assert.equal(reloaded.isPlaying(), false, "and stays off");
  assert.ok(MUSIC_GAIN > 0 && MUSIC_GAIN < 0.5);
});

test("no Web Audio means no music and no errors", () => {
  const timers = fakeTimers();
  const player = createMusicPlayer({ audio: () => null, storage: null, timers });
  player.start();
  player.update({ world: "desert", scene: "playing" });
  player.duck("win");
  assert.equal(player.isPlaying(), false);
  assert.equal(timers.running, 0);
});
