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

test("only the first puzzle is unlocked until the previous puzzle is completed", () => {
  const storage = memoryStorage();
  const progress = createProgressStore(storage);

  assert.equal(progress.isUnlocked("1"), true);
  assert.equal(progress.isUnlocked("2"), false);
  assert.equal(progress.isUnlocked("3"), false);
  assert.throws(() => progress.markCompleted("3"), /locked puzzle/);
  progress.markCompleted("1");
  assert.equal(progress.isCompleted("1"), true);
  assert.equal(progress.isUnlocked("2"), true);
  assert.equal(progress.isUnlocked("3"), false);
  assert.deepEqual(createProgressStore(storage).completedIds(), ["1"]);
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
  progress.markCompleted("1");
  assert.equal(progress.isPerfected("1"), false);
  progress.markCompleted("1", { perfect: true }); // a later perfect replay upgrades it
  assert.equal(progress.isPerfected("1"), true);
  progress.markCompleted("2", { perfect: true });
  assert.equal(progress.isCompleted("2"), true);
  progress.markCompleted("2"); // a later non-perfect win does not take it away
  const reloaded = createProgressStore(storage);
  assert.deepEqual(reloaded.perfectedIds().sort(), ["1", "2"]);
  assert.deepEqual(reloaded.completedIds().sort(), ["1", "2"]);
});

test("progress saved before perfect solves existed still loads", () => {
  const progress = createProgressStore(memoryStorage(JSON.stringify({ completedIds: ["1"] })));
  assert.equal(progress.isCompleted("1"), true);
  assert.equal(progress.isPerfected("1"), false);
  assert.deepEqual(progress.perfectedIds(), []);
});

test("an invalid perfected list is surfaced", () => {
  assert.throws(
    () => createProgressStore(memoryStorage(JSON.stringify({ completedIds: ["1"], perfectedIds: [1] }))),
    /invalid format/,
  );
});
