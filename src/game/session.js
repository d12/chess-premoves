import { Chess } from "chess.js";

import {
  applyPremove,
  initialCastling,
  parsePlacement,
  placementToFen,
  premoveSan,
  premoveTargets,
} from "./premoveRules.js";

const UCI_MOVE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

// Strict legality, used when a premove is actually played.
function matchingLegalMove(chess, move) {
  return chess.moves({ verbose: true }).find((candidate) => (
    candidate.from === move.from
    && candidate.to === move.to
    && candidate.promotion === move.promotion
    && candidate.captured !== "k"
  ));
}

// Only checkmate solves a level, so a drawn position is a failure. Name the reason so the
// player can see why the line didn't work, without calling the result a "draw".
function drawnReason(chess) {
  if (chess.isStalemate()) {
    const side = chess.turn() === "w" ? "White" : "Black";
    return `Stalemate: ${side} has no legal move but isn't in check. Only checkmate solves the level.`;
  }
  if (chess.isInsufficientMaterial()) {
    return "Not enough pieces are left on the board to give checkmate.";
  }
  if (chess.isThreefoldRepetition()) {
    return "The same position came up three times, so the game was drawn before checkmate.";
  }
  return "Fifty moves passed without a capture or pawn move, so the game was drawn before checkmate.";
}

function pause(durationMs) {
  return durationMs > 0
    ? new Promise((resolve) => setTimeout(resolve, durationMs))
    : Promise.resolve();
}

export function createPremoveGame(puzzle, { playerColor = "w" } = {}) {
  if (playerColor !== "w" && playerColor !== "b") {
    throw new RangeError("Player color must be 'w' or 'b'.");
  }

  const initialPosition = new Chess(puzzle.fen);
  if (initialPosition.turn() !== playerColor) {
    throw new Error("The puzzle position must be set to the player's turn.");
  }

  let actual = new Chess(puzzle.fen);
  // Planning preview: the player's pieces after the queued premoves; the opponent's pieces
  // stay where they are, since we cannot know how they will move. Premoves are checked
  // against piece geometry only (like chess.com / lichess); legality is checked on play.
  const startPreview = () => ({
    board: parsePlacement(puzzle.fen),
    castling: initialCastling(puzzle.fen),
    hiddenKing: null,
  });
  let preview = startPreview();
  let premoves = [];
  let phase = "planning";
  let outcome = null;
  let message = "";
  let lastMove = null;
  // Playback progress through the queued line: how many premoves have been played, and
  // which one (index) turned out illegal, if that's how the line ended.
  let premovesPlayed = 0;
  let failedPremove = null;
  // A win is "perfect" when it used no more premoves than the puzzle's minimum
  // (puzzle.number_of_moves, the length of the shortest solution).
  const minimumMoves = Number.isInteger(puzzle.number_of_moves) ? puzzle.number_of_moves : null;
  let perfect = false;

  function previewFen() {
    return `${placementToFen(preview.board)} ${playerColor} - - 0 1`;
  }

  // Square of the checkmated king once the real game reaches mate, else null.
  function matedKingSquare() {
    if (phase === "planning" || !actual.isCheckmate()) {
      return null;
    }
    const color = actual.turn();
    for (const row of actual.board()) {
      for (const piece of row) {
        if (piece && piece.type === "k" && piece.color === color) {
          return piece.square;
        }
      }
    }
    return null;
  }

  function snapshot() {
    return {
      phase,
      outcome,
      message,
      perfect,
      minimumMoves,
      movesUsed: premoves.length,
      premovesPlayed,
      failedPremove,
      fen: phase === "planning" ? previewFen() : actual.fen(),
      premoves: premoves.map((move) => ({ ...move })),
      lastMove: lastMove ? { ...lastMove } : null,
      matedKing: matedKingSquare(),
      playerColor,
    };
  }

  function assertPlanning() {
    if (phase !== "planning") {
      throw new Error("Premoves can only be changed while planning.");
    }
  }

  function targetsFrom(square) {
    return premoveTargets(preview.board, square, playerColor, preview.castling);
  }

  function legalMovesFrom(square) {
    assertPlanning();
    return targetsFrom(square).map((move) => ({
      ...move,
      san: premoveSan(preview.board, move, playerColor, preview.castling),
    }));
  }

  function queueMove({ from, to, promotion }) {
    assertPlanning();
    const options = targetsFrom(from).filter((move) => move.to === to);
    if (options.length === 0) {
      throw new RangeError(`Illegal premove: ${from}${to}.`);
    }
    const move = options.find((option) => option.promotion === (promotion || undefined));
    if (!move) {
      throw new RangeError(options[0].promotion
        ? `Illegal premove: ${from}${to} needs a promotion piece.`
        : `Illegal premove: ${from}${to}${promotion ?? ""}.`);
    }
    premoves.push({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      san: premoveSan(preview.board, move, playerColor, preview.castling),
    });
    preview = applyPremove(preview, move, playerColor);
    return snapshot();
  }

  function undoPremove() {
    assertPlanning();
    if (premoves.length === 0) {
      return snapshot();
    }
    premoves = premoves.slice(0, -1);
    preview = startPreview();
    for (const move of premoves) {
      preview = applyPremove(preview, move, playerColor);
    }
    return snapshot();
  }

  // delayMs: pause after each move. startDelayMs: pause after the board switches to the
  // starting position and before White's first move, so the player sees playback begin.
  async function play(engine, { delayMs = 1000, startDelayMs = 0, onUpdate = () => {} } = {}) {
    assertPlanning();
    if (premoves.length === 0) {
      throw new Error("Queue at least one premove before starting.");
    }
    if (!engine || typeof engine.bestMove !== "function") {
      throw new TypeError("An opponent engine with a bestMove method is required.");
    }
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("Move delay must be a non-negative number.");
    }
    if (!Number.isFinite(startDelayMs) || startDelayMs < 0) {
      throw new RangeError("Start delay must be a non-negative number.");
    }

    phase = "playing";
    await onUpdate(snapshot());
    await pause(startDelayMs);

    const publishMove = async (move) => {
      lastMove = {
        from: move.from,
        to: move.to,
        san: move.san,
        color: move.color,
      };
      await onUpdate(snapshot());
      await pause(delayMs);
    };

    // Ask the opponent for its reply, check it, play it and publish it.
    const playOpponentMove = async () => {
      let uci;
      try {
        uci = await engine.bestMove(actual.fen(), { timeoutMs: 500 });
      } catch (error) {
        phase = "error";
        message = `The opponent engine could not respond: ${error.message}`;
        await onUpdate(snapshot());
        throw error;
      }

      const engineMove = typeof uci === "string" ? UCI_MOVE.exec(uci) : null;
      if (!engineMove) {
        phase = "error";
        message = `The opponent engine returned an invalid move: ${uci}`;
        await onUpdate(snapshot());
        throw new Error(message);
      }

      const [, from, to, promotion] = engineMove;
      const legalEngineMove = matchingLegalMove(actual, { from, to, promotion });
      if (!legalEngineMove) {
        phase = "error";
        message = `The opponent engine returned an illegal move: ${uci}`;
        await onUpdate(snapshot());
        throw new Error(message);
      }

      await publishMove(actual.move({
        from,
        to,
        ...(promotion ? { promotion } : {}),
      }));
    };

    const finish = async (result, reason) => {
      phase = "complete";
      outcome = result;
      message = reason;
      await onUpdate(snapshot());
      return snapshot();
    };

    for (let index = 0; index < premoves.length; index += 1) {
      const premove = premoves[index];
      const legalMove = matchingLegalMove(actual, premove);
      if (!legalMove) {
        failedPremove = index;
        return finish("defeat", "An opponent move made your next premove illegal.");
      }

      const playerMove = actual.move({
        from: legalMove.from,
        to: legalMove.to,
        ...(legalMove.promotion ? { promotion: legalMove.promotion } : {}),
      });
      premovesPlayed = index + 1;
      await publishMove(playerMove);

      if (actual.isCheckmate()) {
        perfect = minimumMoves !== null && premoves.length <= minimumMoves;
        return finish("victory", "Checkmate! You saw the whole combination.");
      }
      if (actual.isDraw()) {
        return finish("defeat", drawnReason(actual));
      }
      if (index === premoves.length - 1) {
        if (actual.inCheck()) {
          // The last premove gave check but not mate: show the escape before the verdict,
          // so it's clear the king had a way out.
          await playOpponentMove();
          if (actual.isCheckmate()) {
            return finish("defeat", "The opponent escaped your check and checkmated you.");
          }
          if (actual.isDraw()) {
            return finish("defeat", drawnReason(actual));
          }
          return finish("defeat", "Your last premove gave check, but not checkmate: the king had a way out.");
        }
        return finish("defeat", "Your premoves ended before checkmate.");
      }

      await playOpponentMove();
      if (actual.isCheckmate()) {
        return finish("defeat", "The opponent checkmated you before your line was complete.");
      }
      if (actual.isDraw()) {
        return finish("defeat", drawnReason(actual));
      }
    }

    return finish("defeat", "Your premoves ended before checkmate.");
  }

  return Object.freeze({
    snapshot,
    legalMovesFrom,
    queueMove,
    undoPremove,
    play,
  });
}
