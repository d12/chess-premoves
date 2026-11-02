// Premove-aware opponent.
//
// The player submits every premove before play starts, so the opponent knows the whole plan.
// The WebAssembly engine (premove-puzzles/engine, built with `npm run build:wasm`) searches
// the opponent's replies against that fixed plan and picks:
//   * a refutation when one exists (makes a premove illegal, outlasts the premoves, forces a
//     draw, or mates the player), choosing the one that ends the game soonest;
//   * otherwise the defence that survives longest.
// If even the cheaper "first refutation" search hits its limit (only plausible for long,
// aimless plans against several mobile pieces), a simple rule picks the reply.
//
// createPremoveOpponent() returns an object with a bestMove(fen) method, which is what
// session.play() expects from an opponent.
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

/**
 * Last-resort reply without search: prefer a move after which the next premove is illegal,
 * then a capture, then any legal move.
 */
export function ruleOfThumbReply(fen, nextPremove) {
  const board = new Chess(fen);
  const replies = board.moves({ verbose: true });
  if (replies.length === 0) {
    throw new Error("The opponent has no legal move.");
  }
  if (nextPremove) {
    for (const reply of replies) {
      board.move(reply);
      const stillLegal = board.moves({ verbose: true }).some((m) => m.from === nextPremove.slice(0, 2)
        && m.to === nextPremove.slice(2, 4) && (m.promotion ?? "") === (nextPremove[4] ?? ""));
      board.undo();
      if (!stillLegal) {
        return `${reply.from}${reply.to}${reply.promotion ?? ""}`;
      }
    }
  }
  const pick = replies.find((m) => m.captured) ?? replies[0];
  return `${pick.from}${pick.to}${pick.promotion ?? ""}`;
}

function samePosition(fenA, fenB) {
  return fenA.split(" ").slice(0, 2).join(" ") === fenB.split(" ").slice(0, 2).join(" ");
}

/**
 * @param {object} options
 * @param {object} options.engine     result of loadPremoveEngine()
 * @param {string} options.puzzleFen  starting position (player to move)
 * @param {Array}  options.premoves   the submitted premoves ({from,to,promotion} or UCI)
 * @param {object} [options.fallback] optional engine with bestMove(fen), used instead of the
 *                                    built-in rule if the search gives up
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

  async function fallbackMove(fen, options) {
    if (fallback) {
      return fallback.bestMove(fen, options);
    }
    return ruleOfThumbReply(fen, plan[premovesPlayed]);
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
      if (historyMatches(fen)) {
        const result = engine.chooseReply(puzzleFen, plan, history, { nodeLimit });
        move = result.move;
      }
      if (!move) {
        move = await fallbackMove(fen, options);
      }
      history.push(move);
      return move;
    },
  });
}
