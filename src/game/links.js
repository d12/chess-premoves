// Links out of the game.

/**
 * chess.com's analysis board for a position: the same URL `ppz` prints
 * (`chesscom_url` in puzzle-finder/premove_puzzles/engine.py, Python's quote_plus),
 * so "/" becomes %2F and spaces become "+".
 */
export function chessComAnalysisUrl(fen) {
  return "https://www.chess.com/analysis?fen=" + encodeURIComponent(fen).replace(/%20/g, "+");
}
