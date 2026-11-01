import { PUZZLES } from "./puzzles.js";

const STORAGE_KEY = "chess-premove-progress-v1";

export function createProgressStore(storage = globalThis.localStorage) {
  if (!storage) {
    throw new Error("Browser storage is not available.");
  }

  const puzzleIds = PUZZLES.map((puzzle) => puzzle.id);
  let completed = new Set();
  let saved;
  try {
    saved = storage.getItem(STORAGE_KEY);
  } catch (error) {
    throw new Error("Unable to read saved puzzle progress.", { cause: error });
  }

  if (saved !== null) {
    let parsed;
    try {
      parsed = JSON.parse(saved);
    } catch (error) {
      throw new Error("Saved puzzle progress is not valid JSON.", { cause: error });
    }
    if (
      !parsed
      || !Array.isArray(parsed.completedIds)
      || parsed.completedIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("Saved puzzle progress has an invalid format.");
    }
    completed = new Set(parsed.completedIds);
  }

  function isCompleted(id) {
    return completed.has(String(id));
  }

  function isUnlocked(id) {
    const index = puzzleIds.indexOf(String(id));
    if (index === -1) {
      return false;
    }
    return puzzleIds.slice(0, index).every((puzzleId) => completed.has(puzzleId));
  }

  function markCompleted(id) {
    const puzzleId = String(id);
    if (!puzzleIds.includes(puzzleId)) {
      throw new RangeError(`Unknown puzzle: ${puzzleId}`);
    }
    if (!isUnlocked(puzzleId)) {
      throw new Error(`Cannot complete locked puzzle ${puzzleId}.`);
    }
    if (completed.has(puzzleId)) {
      return;
    }

    const nextCompleted = new Set(completed);
    nextCompleted.add(puzzleId);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({
        completedIds: [...nextCompleted],
      }));
    } catch (error) {
      throw new Error("Unable to save puzzle progress.", { cause: error });
    }
    completed = nextCompleted;
  }

  function completedIds() {
    return [...completed].filter((id) => puzzleIds.includes(id));
  }

  return Object.freeze({
    isCompleted,
    isUnlocked,
    markCompleted,
    completedIds,
  });
}
