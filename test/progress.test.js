import assert from "node:assert/strict";
import test from "node:test";
import { createProgressStore } from "../src/game/progress.js";

function memoryStorage(initialValue = null) {
  const values = new Map(initialValue === null ? [] : [["chess-premove-progress-v1", initialValue]]);
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("only the first level is unlocked until the previous level is completed", () => {
  const storage = memoryStorage();
  const progress = createProgressStore(storage);

  assert.equal(progress.isUnlocked("1-1"), true);
  assert.equal(progress.isUnlocked("1-2"), false);
  assert.equal(progress.isUnlocked("1-3"), false);
  assert.throws(() => progress.markCompleted("1-3"), /locked level/);
  progress.markCompleted("1-1");
  assert.equal(progress.isCompleted("1-1"), true);
  assert.equal(progress.isUnlocked("1-2"), true);
  assert.equal(progress.isUnlocked("1-3"), false);
  assert.deepEqual(createProgressStore(storage).completedIds(), ["1-1"]);
});

test("development unlocks allow individual levels without completing earlier ones", () => {
  const storage = memoryStorage();
  const progress = createProgressStore(storage, { allowDevUnlock: true });

  assert.throws(() => progress.unlockForDevelopment("unknown"), /Unknown level/);
  progress.unlockForDevelopment("1-3");
  assert.equal(progress.isUnlocked("1-2"), false);
  assert.equal(progress.isUnlocked("1-3"), true);
  progress.markCompleted("1-3", { perfect: true });
  assert.deepEqual(progress.completedIds(), ["1-3"]);
  assert.deepEqual(progress.perfectedIds(), ["1-3"]);

  const reloaded = createProgressStore(storage, { allowDevUnlock: true });
  assert.equal(reloaded.isUnlocked("1-3"), false);
  assert.equal(reloaded.isCompleted("1-3"), true);
  assert.throws(() => createProgressStore(storage).unlockForDevelopment("1-3"), /not enabled/);
  assert.equal(createProgressStore(storage).isUnlocked("1-3"), false);
});

test("invalid saved progress is surfaced instead of silently discarded", () => {
  assert.throws(
    () => createProgressStore(memoryStorage("{invalid")),
    /not valid JSON/,
  );
});

test("perfect wins are remembered separately and imply completion", () => {
  const storage = memoryStorage();
  const progress = createProgressStore(storage);
  progress.markCompleted("1-1");
  assert.equal(progress.isPerfected("1-1"), false);
  progress.markCompleted("1-1", { perfect: true }); // a later perfect replay upgrades it
  assert.equal(progress.isPerfected("1-1"), true);
  progress.markCompleted("1-2", { perfect: true });
  assert.equal(progress.isCompleted("1-2"), true);
  progress.markCompleted("1-2"); // a later non-perfect win does not take it away
  const reloaded = createProgressStore(storage);
  assert.deepEqual(reloaded.perfectedIds().sort(), ["1-1", "1-2"]);
  assert.deepEqual(reloaded.completedIds().sort(), ["1-1", "1-2"]);
});

test("progress saved before perfect solves existed still loads", () => {
  const progress = createProgressStore(memoryStorage(JSON.stringify({ completedIds: ["1-1"] })));
  assert.equal(progress.isCompleted("1-1"), true);
  assert.equal(progress.isPerfected("1-1"), false);
  assert.deepEqual(progress.perfectedIds(), []);
});

test("an invalid perfected list is surfaced", () => {
  assert.throws(
    () => createProgressStore(memoryStorage(JSON.stringify({ completedIds: ["1-1"], perfectedIds: [1] }))),
    /invalid format/,
  );
});

test("attempts are counted per level and saved", () => {
  const storage = memoryStorage();
  const progress = createProgressStore(storage);
  assert.equal(progress.attemptCount("1-1"), 0);
  assert.equal(progress.recordAttempt("1-1"), 1);
  assert.equal(progress.recordAttempt("1-1"), 2);
  assert.equal(progress.recordAttempt("1-2"), 1, "locked levels can't be played, but counting is per id");
  assert.throws(() => progress.recordAttempt("unknown"), /Unknown level/);
  progress.markCompleted("1-1", { perfect: true });

  const reloaded = createProgressStore(storage);
  assert.equal(reloaded.attemptCount("1-1"), 2, "completing a level keeps its attempts");
  assert.equal(reloaded.attemptCount("1-2"), 1);
  assert.equal(reloaded.isPerfected("1-1"), true, "recording attempts keeps completions");
  reloaded.recordAttempt("1-1");
  assert.deepEqual(createProgressStore(storage).completedIds(), ["1-1"]);
  assert.equal(createProgressStore(storage).attemptCount("1-1"), 3);
});

test("progress saved before attempts existed still loads", () => {
  const progress = createProgressStore(memoryStorage(JSON.stringify({ completedIds: ["1-1"], perfectedIds: [] })));
  assert.equal(progress.attemptCount("1-1"), 0);
  assert.throws(
    () => createProgressStore(memoryStorage(JSON.stringify({ completedIds: [], attempts: { "1-1": -1 } }))),
    /invalid format/,
  );
});

test("a stage opens only after every level of the previous stage is completed", () => {
  const progress = createProgressStore(memoryStorage());
  assert.equal(progress.isStageUnlocked("1"), true);
  assert.equal(progress.isStageUnlocked("2"), false);
  assert.equal(progress.isUnlocked("2-1"), false);
  for (const level of ["1-1", "1-2", "1-3", "1-4"]) {
    progress.markCompleted(level);
  }
  assert.equal(progress.isStageCleared("1"), false);
  assert.equal(progress.isStageUnlocked("2"), false, "four of five levels is not enough");
  progress.markCompleted("1-5");
  assert.equal(progress.isStageCleared("1"), true);
  assert.equal(progress.isStageUnlocked("2"), true);
  assert.equal(progress.isUnlocked("2-1"), true);
  assert.equal(progress.isUnlocked("2-2"), false, "levels inside a stage still unlock one by one");
  assert.equal(progress.isStageUnlocked("3"), false);
  assert.equal(progress.isStageUnlocked("nope"), false);
});

test("progress saved by puzzle number before stages existed still loads but counts for nothing", () => {
  const storage = memoryStorage(JSON.stringify({ completedIds: ["1", "2"], perfectedIds: ["1"], attempts: { 1: 4 } }));
  const progress = createProgressStore(storage);
  assert.deepEqual(progress.completedIds(), []);
  assert.deepEqual(progress.perfectedIds(), []);
  assert.equal(progress.isUnlocked("1-2"), false);
  progress.markCompleted("1-1");
  const saved = JSON.parse(storage.getItem("chess-premove-progress-v1"));
  assert.deepEqual(saved.completedIds, ["1", "2", "1-1"], "old entries are kept, not discarded");
  assert.equal(saved.attempts["1"], 4);
});
