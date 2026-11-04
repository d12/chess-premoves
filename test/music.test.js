import assert from "node:assert/strict";
import test from "node:test";
import {
  barAt, barSeconds, createMusicPlayer, degreeToMidi, DUCKS, MUSIC_GAIN, parseToken, passBars, passSeconds, REST_BARS, sceneGains, SCENES, scheduleRange, SONGS,
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

const WORLDS = Object.keys(SONGS);

test("each world's piece is long enough not to feel loopy, and every bar is well formed", () => {
  assert.deepEqual(WORLDS, ["meadow", "forest", "desert", "frost", "volcano"]);
  for (const world of WORLDS) {
    const song = SONGS[world];
    const bars = passBars(world, 0);
    assert.equal(song.form[0], "intro", world);
    const seconds = passSeconds(world);
    assert.ok(seconds >= 100 && seconds <= 170, `${world}: one pass lasts ${seconds.toFixed(0)} s`);
    for (const bar of bars) {
      assert.ok(bar.chords.length === 1 || bar.chords.length === 2, `${world} ${bar.section}`);
      for (const line of [bar.lead, bar.counter, bar.bassLine]) {
        if (!line) continue;
        assert.equal(line.length, song.slots, `${world} ${bar.section}[${bar.index}] has ${song.slots} slots`);
        for (const token of line) {
          assert.ok(token === "." || token === "-" || parseToken(token), `${world}: token ${token}`);
        }
      }
    }
    assert.ok(bars.some((bar) => bar.lead === null), `${world}: a breakdown without the melody`);
  }
});

test("every world is its own piece: tune, metre, scale and tempo", () => {
  const firstPhrase = (world) => SONGS[world].sections.A.lead.flat().join(" ");
  assert.equal(new Set(WORLDS.map(firstPhrase)).size, WORLDS.length, "five different melodies");
  assert.equal(new Set(WORLDS.map((world) => SONGS[world].title)).size, WORLDS.length);
  assert.equal(new Set(WORLDS.map((world) => SONGS[world].tempo)).size, WORLDS.length, "five tempos");
  assert.ok(new Set(WORLDS.map((world) => `${SONGS[world].beats}/${SONGS[world].slots}`)).size >= 3, "at least three metres");
  assert.ok(new Set(WORLDS.map((world) => SONGS[world].scale)).size >= 4, "at least four scales");

  // Knight's Wood is night: a minor key, a 6/8 gallop, and sparse like an underground theme
  const forest = SONGS.forest;
  assert.equal(forest.scale, "minor");
  assert.equal(forest.slots, 6);
  assert.equal(forest.beats, 2);
  const rests = (world) => {
    const tokens = SONGS[world].sections.A.lead.flat();
    return tokens.filter((token) => token === ".").length / tokens.length;
  };
  assert.ok(rests("forest") > rests("meadow") + 0.15, `forest A rests ${rests("forest").toFixed(2)} vs meadow ${rests("meadow").toFixed(2)}`);
  assert.equal(SONGS.frost.beats, 3, "a waltz");
  assert.equal(SONGS.desert.scale, "phrygianDominant");
});

test("the second pass varies the first, and the music rests after two passes", () => {
  for (const world of WORLDS) {
    const [first, second] = [passBars(world, 0), passBars(world, 1)];
    assert.equal(first.length, second.length);
    assert.ok(second.some((bar) => bar.leadUp) && !first.some((bar) => bar.leadUp), `${world}: the last A is lifted an octave`);
    const passLength = first.length;
    assert.equal(barAt(world, 0).section, "intro");
    assert.equal(barAt(world, passLength).pass, 1);
    for (let n = 0; n < REST_BARS; n += 1) {
      assert.equal(barAt(world, passLength * 2 + n).rest, true);
    }
    assert.equal(barAt(world, passLength * 2 + REST_BARS).section, "intro", `${world}: then it starts again`);
    assert.equal(barAt(world, passLength * 2 + REST_BARS).cycle, 1);
  }
  assert.ok(passBars("meadow", 1).some((bar) => bar.harmony), "a harmony line on the second pass");
});

test("degrees map to notes in each world's key and scale", () => {
  const meadow = SONGS.meadow;
  assert.equal(degreeToMidi(meadow, 0), 60);
  assert.equal(degreeToMidi(meadow, 7), 72);
  assert.equal(degreeToMidi(meadow, "6"), 71);
  assert.equal(degreeToMidi(meadow, "4b"), 66, "accidentals");
  assert.equal(degreeToMidi(SONGS.desert, 1) - SONGS.desert.key, 1, "phrygian dominant: a flat second…");
  assert.equal(degreeToMidi(SONGS.desert, 2) - SONGS.desert.key, 4, "…and a major third");
  assert.equal(degreeToMidi(SONGS.frost, 3) - SONGS.frost.key, 6, "lydian: a sharp fourth");
  const forest = SONGS.forest;
  assert.equal(degreeToMidi(forest, 2) - forest.key, 3, "minor third");
  assert.equal(degreeToMidi(forest, 6) - forest.key, 10, "natural seventh over most chords");
  assert.equal(degreeToMidi(forest, 6, { root: 4 }) - forest.key, 11, "raised leading tone over the dominant");
  for (const world of WORLDS) {
    for (const scene of ["map", "planning", "playing"]) {
      assert.deepEqual(Object.keys(sceneGains(world, scene)).sort(), Object.keys(SCENES.map).sort());
    }
  }
  assert.ok(sceneGains("forest", "map").perc > 0 && sceneGains("meadow", "map").perc === 0, "signature percussion per world");
  for (const name of Object.keys(DUCKS)) {
    assert.ok(SOUND_NAMES.includes(name), `ducks under a real sound: ${name}`);
  }
});

test("scheduling fills the window with bars, only into layers that are on", () => {
  for (const world of WORLDS) {
    const context = fakeContext();
    const layers = Object.fromEntries(Object.keys(SCENES.map).map((name) => [name, context.createGain()]));
    const length = barSeconds(world);
    for (const scene of ["map", "planning"]) {
      context.log.starts.length = 0;
      const gains = sceneGains(world, scene);
      const result = scheduleRange({
        context,
        destinationFor: (name) => layers[name],
        world,
        fromBar: 4, // the first A
        startTime: 1,
        untilTime: 1 + length * 3,
        layerOn: (name) => gains[name] > 0,
      });
      assert.equal(result.nextBar, 7);
      assert.ok(Math.abs(result.nextTime - (1 + length * 3)) < 1e-9);
      assert.equal(context.log.bad, 0, `${world}: every time and value is finite`);
      assert.ok(context.log.starts.length > 20, `${world} ${scene}: ${context.log.starts.length} notes`);
      assert.ok(context.log.starts.every((start) => start.t >= 1 && start.t < 1 + length * 3 + 0.01));
      // vibrato LFOs modulate another oscillator's pitch rather than feeding a layer
      const used = new Set(context.log.starts.map((start) => layerOf(start, layers)).filter(Boolean));
      for (const name of used) {
        assert.ok(gains[name] > 0, `${world} ${scene}: no notes for the muted ${name} layer`);
      }
      if (scene === "map") {
        assert.ok(used.has("lead") && used.has("bass"), `${world}: the band plays on the map`);
      } else {
        assert.ok(used.has("pad") && !used.has("lead") && !used.has("kick"), `${world}: planning drops the melody and kick`);
      }
    }
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
