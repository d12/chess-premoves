// Checks src/game/links.js: links out of the game match the ones ppz prints.
import assert from "node:assert/strict";
import test from "node:test";
import { chessComAnalysisUrl } from "../src/game/links.js";
import { PUZZLES } from "../src/game/puzzles.js";

test("the chess.com URL matches ppz's (Python quote_plus) output", () => {
  // from puzzle-finder/samples/batch_output.txt and puzzle-finder/README.md
  assert.equal(
    chessComAnalysisUrl("8/Q3R3/8/2K5/8/2k5/6p1/8 w - - 0 1"),
    "https://www.chess.com/analysis?fen=8%2FQ3R3%2F8%2F2K5%2F8%2F2k5%2F6p1%2F8+w+-+-+0+1",
  );
  assert.equal(
    chessComAnalysisUrl("8/8/2k5/8/8/8/3Q4/4R2K w - - 0 1"),
    "https://www.chess.com/analysis?fen=8%2F8%2F2k5%2F8%2F8%2F8%2F3Q4%2F4R2K+w+-+-+0+1",
  );
  // castling rights and an en-passant square survive
  assert.equal(
    chessComAnalysisUrl("r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1"),
    "https://www.chess.com/analysis?fen=r3k2r%2F8%2F8%2F3pP3%2F8%2F8%2F8%2FR3K2R+w+KQkq+d6+0+1",
  );
});

test("every level's FEN round-trips through the chess.com URL", () => {
  for (const puzzle of PUZZLES) {
    const url = new URL(chessComAnalysisUrl(puzzle.fen));
    assert.equal(url.origin + url.pathname, "https://www.chess.com/analysis");
    assert.equal(url.searchParams.get("fen"), puzzle.fen, `puzzle ${puzzle.id}`);
  }
});
