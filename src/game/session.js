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
  // A win is "perfect" when it used no more premoves than the puzzle's minimum
  // (puzzle.number_of_moves, the length of the shortest solution).
  const minimumMoves = Number.isInteger(puzzle.number_of_moves) ? puzzle.number_of_moves : null;
  let perfect = false;

  function previewFen() {
    return `${placementToFen(preview.board)} ${playerColor} - - 0 1`;
  }

  function snapshot() {
    return {
      phase,
      outcome,
      message,
      perfect,
      minimumMoves,
      movesUsed: premoves.length,
      fen: phase === "planning" ? previewFen() : actual.fen(),
      premoves: premoves.map((move) => ({ ...move })),
      lastMove: lastMove ? { ...lastMove } : null,
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
        return finish("defeat", "An opponent move made your next premove illegal.");
      }

      const playerMove = actual.move({
        from: legalMove.from,
        to: legalMove.to,
        ...(legalMove.promotion ? { promotion: legalMove.promotion } : {}),
      });
      await publishMove(playerMove);

      if (actual.isCheckmate()) {
        perfect = minimumMoves !== null && premoves.length <= minimumMoves;
        return finish("victory", "Checkmate! You saw the whole combination.");
      }
      if (actual.isDraw()) {
        return finish("draw", "The position is drawn.");
      }
      if (index === premoves.length - 1) {
        return finish("defeat", "Your premoves ended before checkmate.");
      }

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

      const appliedEngineMove = actual.move({
        from,
        to,
        ...(promotion ? { promotion } : {}),
      });
      await publishMove(appliedEngineMove);

      if (actual.isCheckmate()) {
        return finish("defeat", "The opponent checkmated you before your line was complete.");
      }
      if (actual.isDraw()) {
        return finish("draw", "The position is drawn.");
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
