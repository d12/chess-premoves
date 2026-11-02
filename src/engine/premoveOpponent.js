// Premove-aware opponent.
//
// The player submits every premove before play starts, so the opponent knows the whole plan.
// The WebAssembly engine (premove-puzzles/engine, built with `npm run build:wasm`) searches
// the opponent's replies against that fixed plan and picks:
//   * a refutation when one exists (makes a premove illegal, outlasts the premoves, forces a
//     draw, or mates the player), choosing the one that ends the game soonest;
//   * otherwise the defence that survives longest.
//
// createPremoveOpponent() returns an object with the same bestMove(fen) method as the
// Stockfish engine, so session.play() needs no changes.
import { Chess } from "chess.js";
import createPremoveEngineModule from "./generated/premove-engine.js";

export const DEFAULT_NODE_LIMIT = 100_000;

let enginePromise = null;

function parseResult(text) {
  const result = JSON.parse(text);
  if (!result.ok) {
    throw new Error(`Premove engine: ${result.error}`);
  }
  return result;
}

export function toUci(move) {
  if (typeof move === "string") {
    return move;
  }
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function uciList(moves) {
  return moves.map(toUci).join(" ");
}

/** Loads (once) and returns the WebAssembly premove engine. */
export function loadPremoveEngine() {
  enginePromise ??= createPremoveEngineModule().then((module) => {
    const analyze = module.cwrap("pm_analyze", "string", ["string", "string", "number"]);
    const reply = module.cwrap("pm_reply", "string", ["string", "string", "string", "number"]);
    return Object.freeze({
      version: module.cwrap("pm_version", "string", [])(),
      /**
       * Full analysis of a plan from the puzzle position:
       * { verdict: "sound" | "refuted" | "unknown", end, plies, line: [{uci, san, player}], nodes }
       */
      analyzePlan(fen, premoves, { nodeLimit = DEFAULT_NODE_LIMIT } = {}) {
        return parseResult(analyze(fen, uciList(premoves), nodeLimit));
      },
      /**
       * Opponent reply after `history` (moves played from the puzzle position, ending with a
       * premove): { move, san, refutes, end, plies, nodes }; move is null if the search
       * hit the node limit.
       */
      chooseReply(fen, premoves, history, { nodeLimit = DEFAULT_NODE_LIMIT } = {}) {
        return parseResult(reply(fen, uciList(premoves), uciList(history), nodeLimit));
      },
    });
  });
  return enginePromise;
}

function samePosition(fenA, fenB) {
  return fenA.split(" ").slice(0, 2).join(" ") === fenB.split(" ").slice(0, 2).join(" ");
}

/**
 * @param {object} options
 * @param {object} options.engine     result of loadPremoveEngine()
 * @param {string} options.puzzleFen  starting position (player to move)
 * @param {Array}  options.premoves   the submitted premoves ({from,to,promotion} or UCI)
 * @param {object} [options.fallback] engine with bestMove(fen) used if the search gives up
 *                                    or the game diverges from the expected history
 */
export function createPremoveOpponent({ engine, puzzleFen, premoves, fallback = null, nodeLimit = DEFAULT_NODE_LIMIT }) {
  if (!engine || typeof engine.chooseReply !== "function") {
    throw new TypeError("A loaded premove engine is required.");
  }
  const plan = premoves.map(toUci);
  const history = [];
  let premovesPlayed = 0;
  let analysis = null;

  // Replays our record of the game; if it doesn't match the position we were given, the
  // caller is not driving us in premove order, so we stop trusting the plan.
  function historyMatches(fen) {
    const board = new Chess(puzzleFen);
    for (const uci of history) {
      if (!board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })) {
        return false;
      }
    }
    return samePosition(board.fen(), fen);
  }

  async function fallbackMove(fen, options, reason) {
    if (!fallback) {
      throw new Error(`Premove opponent cannot move: ${reason}`);
    }
    return fallback.bestMove(fen, options);
  }

  return Object.freeze({
    /** Analysis of the whole plan (computed on first use). */
    get analysis() {
      analysis ??= engine.analyzePlan(puzzleFen, plan, { nodeLimit });
      return analysis;
    },

    async bestMove(fen, options = {}) {
      // session.play() asks for a reply right after each premove is played.
      if (premovesPlayed < plan.length) {
        history.push(plan[premovesPlayed]);
        premovesPlayed += 1;
      }
      let move = null;
      let reason = "the game left the submitted plan";
      if (historyMatches(fen)) {
        const result = engine.chooseReply(puzzleFen, plan, history, { nodeLimit });
        move = result.move;
        reason = "search limit reached";
      }
      if (!move) {
        move = await fallbackMove(fen, options, reason);
      }
      history.push(move);
      return move;
    },
  });
}
