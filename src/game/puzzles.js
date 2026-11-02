// Puzzle list. The data lives in puzzles.json, which is managed with the puzzle-finder
// tool (`./ppz app list | add | remove`, see puzzle-finder/README.md). Ids are "1".."N"
// and puzzles unlock in that order.
import PUZZLE_DATA from "./puzzles.json" with { type: "json" };

export const PUZZLES = Object.freeze(PUZZLE_DATA.map((puzzle) => Object.freeze({
  ...puzzle,
  solution: Object.freeze([...(puzzle.solution ?? [])]),
  solution_uci: Object.freeze([...(puzzle.solution_uci ?? [])]),
})));

export function getPuzzle(id) {
  const puzzle = PUZZLES.find((candidate) => candidate.id === String(id));
  if (!puzzle) {
    throw new RangeError(`Unknown puzzle: ${id}`);
  }
  return puzzle;
}
