import { Chess } from "chess.js";

const UCI_MOVE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

function playerTurnPosition(chess, playerColor) {
  const fields = chess.fen().split(" ");
  fields[1] = playerColor;
  fields[3] = "-";
  return new Chess(fields.join(" "));
}

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
  let preview = new Chess(puzzle.fen);
  let premoves = [];
  let phase = "planning";
  let outcome = null;
  let message = "";
  let lastMove = null;
  let planningMate = false;

  function snapshot() {
    return {
      phase,
      outcome,
      message,
      fen: phase === "planning" ? preview.fen() : actual.fen(),
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

  function legalMovesFrom(square) {
    assertPlanning();
    if (planningMate) {
      return [];
    }
    return preview.moves({ square, verbose: true }).filter((move) => move.captured !== "k").map((move) => ({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      san: move.san,
    }));
  }

  function queueMove({ from, to, promotion }) {
    assertPlanning();
    if (planningMate) {
      throw new Error("The planned line already ends in checkmate.");
    }

    const move = { from, to, promotion };
    const legalMove = matchingLegalMove(preview, move);
    if (!legalMove) {
      throw new RangeError(`Illegal premove: ${from}${to}${promotion ?? ""}.`);
    }

    const appliedMove = preview.move({
      from: legalMove.from,
      to: legalMove.to,
      ...(legalMove.promotion ? { promotion: legalMove.promotion } : {}),
    });
    premoves.push({
      from: appliedMove.from,
      to: appliedMove.to,
      promotion: appliedMove.promotion,
      san: appliedMove.san,
    });
    planningMate = preview.isCheckmate();
    preview = playerTurnPosition(preview, playerColor);
    return snapshot();
  }

  function rebuildPreview() {
    preview = new Chess(puzzle.fen);
    planningMate = false;

    for (const move of premoves) {
      const legalMove = matchingLegalMove(preview, move);
      if (!legalMove) {
        throw new Error("Unable to rebuild the queued premoves.");
      }
      preview.move({
        from: legalMove.from,
        to: legalMove.to,
        ...(legalMove.promotion ? { promotion: legalMove.promotion } : {}),
      });
      planningMate = preview.isCheckmate();
      preview = playerTurnPosition(preview, playerColor);
    }
  }

  function undoPremove() {
    assertPlanning();
    if (premoves.length === 0) {
      return snapshot();
    }
    premoves = premoves.slice(0, -1);
    rebuildPreview();
    return snapshot();
  }

  async function play(engine, { delayMs = 1000, onUpdate = () => {} } = {}) {
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

    phase = "playing";
    await onUpdate(snapshot());

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
