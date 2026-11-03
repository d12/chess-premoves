import { PUZZLES } from "./puzzles.js";

const STORAGE_KEY = "chess-premove-progress-v1";

export function createProgressStore(storage = globalThis.localStorage, { allowDevUnlock = false } = {}) {
  if (!storage) {
    throw new Error("Browser storage is not available.");
  }

  const puzzleIds = PUZZLES.map((puzzle) => puzzle.id);
  let completed = new Set();
  let perfected = new Set(); // solved in the minimum number of premoves
  let attempts = {}; // puzzle id -> times a line was submitted
  const devUnlocked = new Set();
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
    const validIds = (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string");
    const validCounts = (counts) => counts !== null && typeof counts === "object" && !Array.isArray(counts)
      && Object.values(counts).every((count) => Number.isInteger(count) && count >= 0);
    if (
      !parsed
      || !validIds(parsed.completedIds)
      || (parsed.perfectedIds !== undefined && !validIds(parsed.perfectedIds)) // absent in older saves
      || (parsed.attempts !== undefined && !validCounts(parsed.attempts)) // absent in older saves
    ) {
      throw new Error("Saved puzzle progress has an invalid format.");
    }
    completed = new Set(parsed.completedIds);
    perfected = new Set(parsed.perfectedIds ?? []);
    attempts = { ...(parsed.attempts ?? {}) };
  }

  function save(next) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({
        completedIds: [...next.completed],
        perfectedIds: [...next.perfected],
        attempts: next.attempts,
      }));
    } catch (error) {
      throw new Error("Unable to save puzzle progress.", { cause: error });
    }
    ({ completed, perfected, attempts } = next);
  }

  function isCompleted(id) {
    return completed.has(String(id));
  }

  function isUnlocked(id) {
    const index = puzzleIds.indexOf(String(id));
    if (index === -1) {
      return false;
    }
    return devUnlocked.has(String(id))
      || puzzleIds.slice(0, index).every((puzzleId) => completed.has(puzzleId));
  }

  function unlockForDevelopment(id) {
    const puzzleId = String(id);
    if (!allowDevUnlock) {
      throw new Error("Development puzzle unlocking is not enabled.");
    }
    if (!puzzleIds.includes(puzzleId)) {
      throw new RangeError(`Unknown puzzle: ${puzzleId}`);
    }
    devUnlocked.add(puzzleId);
  }

  function isPerfected(id) {
    return perfected.has(String(id));
  }

  /** Record a win; `perfect` if it used the minimum number of premoves. */
  function markCompleted(id, { perfect = false } = {}) {
    const puzzleId = String(id);
    if (!puzzleIds.includes(puzzleId)) {
      throw new RangeError(`Unknown puzzle: ${puzzleId}`);
    }
    if (!isUnlocked(puzzleId)) {
      throw new Error(`Cannot complete locked puzzle ${puzzleId}.`);
    }
    if (completed.has(puzzleId) && (!perfect || perfected.has(puzzleId))) {
      return;
    }

    save({
      completed: new Set(completed).add(puzzleId),
      perfected: perfect ? new Set(perfected).add(puzzleId) : perfected,
      attempts,
    });
  }

  /** How many times a line has been submitted on this puzzle. */
  function attemptCount(id) {
    return attempts[String(id)] ?? 0;
  }

  /** Count a submitted line (an attempt); returns the new total for the puzzle. */
  function recordAttempt(id) {
    const puzzleId = String(id);
    if (!puzzleIds.includes(puzzleId)) {
      throw new RangeError(`Unknown puzzle: ${puzzleId}`);
    }
    save({ completed, perfected, attempts: { ...attempts, [puzzleId]: attemptCount(puzzleId) + 1 } });
    return attempts[puzzleId];
  }

  function completedIds() {
    return [...completed].filter((id) => puzzleIds.includes(id));
  }

  function perfectedIds() {
    return [...perfected].filter((id) => puzzleIds.includes(id));
  }

  return Object.freeze({
    isCompleted,
    isPerfected,
    isUnlocked,
    unlockForDevelopment,
    markCompleted,
    attemptCount,
    recordAttempt,
    completedIds,
    perfectedIds,
  });
}
