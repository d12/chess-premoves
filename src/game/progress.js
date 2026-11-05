import { LEVELS, STAGES } from "./stages.js";

// Progress is keyed by level id ("2-3"), not by puzzle, because a puzzle can appear in more
// than one level. Saves from before stages existed hold puzzle numbers ("1"…); those entries
// still load and are kept on save, but they match no level, so they don't count.
const STORAGE_KEY = "chess-premove-progress-v1";

export function createProgressStore(storage = globalThis.localStorage, { allowDevUnlock = false } = {}) {
  if (!storage) {
    throw new Error("Browser storage is not available.");
  }

  const levelIds = LEVELS.map((level) => level.id);
  let completed = new Set();
  let perfected = new Set(); // solved in the minimum number of premoves
  let attempts = {}; // level id -> times a line was submitted
  let wins = {}; // level id -> times it was solved (absent in older saves)
  let firstWins = {}; // level id -> the attempt that first solved it (absent in older saves)
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
      || (parsed.wins !== undefined && !validCounts(parsed.wins)) // absent in older saves
      || (parsed.firstWins !== undefined && !validCounts(parsed.firstWins)) // absent in older saves
    ) {
      throw new Error("Saved puzzle progress has an invalid format.");
    }
    completed = new Set(parsed.completedIds);
    perfected = new Set(parsed.perfectedIds ?? []);
    attempts = { ...(parsed.attempts ?? {}) };
    wins = { ...(parsed.wins ?? {}) };
    firstWins = { ...(parsed.firstWins ?? {}) };
  }

  function save(changes) {
    const next = { completed, perfected, attempts, wins, firstWins, ...changes };
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({
        completedIds: [...next.completed],
        perfectedIds: [...next.perfected],
        attempts: next.attempts,
        wins: next.wins,
        firstWins: next.firstWins,
      }));
    } catch (error) {
      throw new Error("Unable to save puzzle progress.", { cause: error });
    }
    ({ completed, perfected, attempts, wins, firstWins } = next);
  }

  function isCompleted(id) {
    return completed.has(String(id));
  }

  function isUnlocked(id) {
    const index = levelIds.indexOf(String(id));
    if (index === -1) {
      return false;
    }
    return devUnlocked.has(String(id))
      || levelIds.slice(0, index).every((levelId) => completed.has(levelId));
  }

  function unlockForDevelopment(id) {
    const levelId = String(id);
    if (!allowDevUnlock) {
      throw new Error("Development level unlocking is not enabled.");
    }
    if (!levelIds.includes(levelId)) {
      throw new RangeError(`Unknown level: ${levelId}`);
    }
    devUnlocked.add(levelId);
  }

  function isPerfected(id) {
    return perfected.has(String(id));
  }

  /**
   * Record a win; `perfect` if it used the minimum number of premoves. Every win is counted,
   * and the first one remembers which attempt it came on (for the stats screen).
   */
  function markCompleted(id, { perfect = false } = {}) {
    const levelId = String(id);
    if (!levelIds.includes(levelId)) {
      throw new RangeError(`Unknown level: ${levelId}`);
    }
    if (!isUnlocked(levelId)) {
      throw new Error(`Cannot complete locked level ${levelId}.`);
    }
    const firstWin = !completed.has(levelId);
    save({
      completed: firstWin ? new Set(completed).add(levelId) : completed,
      perfected: perfect && !perfected.has(levelId) ? new Set(perfected).add(levelId) : perfected,
      wins: { ...wins, [levelId]: winCount(levelId) + 1 },
      firstWins: firstWin ? { ...firstWins, [levelId]: Math.max(1, attemptCount(levelId)) } : firstWins,
    });
  }

  /** How many times the level has been solved (wins from before this was saved aren't known). */
  function winCount(id) {
    return wins[String(id)] ?? 0;
  }

  /** The attempt that first solved the level, or null if unsolved or solved before this was saved. */
  function firstWinAttempt(id) {
    return firstWins[String(id)] ?? null;
  }

  /** How many times a line has been submitted on this puzzle. */
  function attemptCount(id) {
    return attempts[String(id)] ?? 0;
  }

  /** Count a submitted line (an attempt); returns the new total for the puzzle. */
  function recordAttempt(id) {
    const levelId = String(id);
    if (!levelIds.includes(levelId)) {
      throw new RangeError(`Unknown level: ${levelId}`);
    }
    save({ attempts: { ...attempts, [levelId]: attemptCount(levelId) + 1 } });
    return attempts[levelId];
  }

  /** A stage opens once every level of the stage before it is completed. */
  function isStageUnlocked(stageId) {
    const stage = STAGES.find((candidate) => candidate.id === String(stageId));
    if (!stage) {
      return false;
    }
    return stage.levels.some((level) => isUnlocked(level.id));
  }

  function isStageCleared(stageId) {
    const stage = STAGES.find((candidate) => candidate.id === String(stageId));
    return Boolean(stage) && stage.levels.every((level) => completed.has(level.id));
  }

  function completedIds() {
    return [...completed].filter((id) => levelIds.includes(id));
  }

  function perfectedIds() {
    return [...perfected].filter((id) => levelIds.includes(id));
  }

  return Object.freeze({
    isCompleted,
    isPerfected,
    isUnlocked,
    isStageUnlocked,
    isStageCleared,
    unlockForDevelopment,
    markCompleted,
    attemptCount,
    recordAttempt,
    winCount,
    firstWinAttempt,
    completedIds,
    perfectedIds,
  });
}
