const SHARED_FEN = "8/8/2k5/8/8/8/3Q4/4R2K w - - 0 1";

export const PUZZLES = Object.freeze([
  {
    id: "1",
    title: "The cornered king",
    description: "Plan the forced premove mate in three, allowing for every legal Black reply.",
    fen: SHARED_FEN,
  },
  {
    id: "2",
    title: "A tight net",
    description: "Plan the forced premove mate in three, allowing for every legal Black reply.",
    fen: SHARED_FEN,
  },
  {
    id: "3",
    title: "No escape",
    description: "Plan the forced premove mate in three, allowing for every legal Black reply.",
    fen: SHARED_FEN,
  },
].map((puzzle) => Object.freeze(puzzle)));

export function getPuzzle(id) {
  const puzzle = PUZZLES.find((candidate) => candidate.id === String(id));
  if (!puzzle) {
    throw new RangeError(`Unknown puzzle: ${id}`);
  }
  return puzzle;
}
