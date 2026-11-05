// Puzzle list. The data lives in puzzles.json, which is managed with the puzzle-finder
// tool (`./ppz app list | add --level S-L`, see puzzle-finder/README.md). There is one
// entry per level, in play order, and its id is the level's "<world>-<level>" id ("3-2" is
// the second level of world 3), so every level of every world has its own entry.
import PUZZLE_DATA from "./puzzles.json" with { type: "json" };

export const PUZZLES = Object.freeze(PUZZLE_DATA.map((puzzle) => Object.freeze({
  ...puzzle,
  solution: Object.freeze([...(puzzle.solution ?? [])]),
  solution_uci: Object.freeze([...(puzzle.solution_uci ?? [])]),
})));

/** Splits a level id: "3-2" → { world: 3, level: 2 }, or null if it isn't one. */
export function parseLevelId(id) {
  const match = /^([1-9]\d*)-([1-9]\d*)$/.exec(String(id));
  return match ? { world: Number(match[1]), level: Number(match[2]) } : null;
}

export function getPuzzle(id) {
  const puzzle = PUZZLES.find((candidate) => candidate.id === String(id));
  if (!puzzle) {
    throw new RangeError(`Unknown puzzle: ${id}`);
  }
  return puzzle;
}
