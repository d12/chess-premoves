import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { Chess } from "chess.js";
import { parsePlacement } from "../src/game/premoveRules.js";
import { createPremoveGame } from "../src/game/session.js";

const MODULE_URL = new URL("../src/engine/generated/premove-engine.js", import.meta.url);
const built = existsSync(MODULE_URL);
const skip = built ? false : "WebAssembly engine not built: run `npm run build:wasm`";
const ALL_FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/premove-plans.json", import.meta.url), "utf8"));
// The chess.js reference is slow; by default check a quarter of the puzzles.
// PREMOVE_FULL_CHECK=1 npm test checks all of them (~1 minute).
const FULL = process.env.PREMOVE_FULL_CHECK === "1";
const FIXTURES = FULL ? ALL_FIXTURES : ALL_FIXTURES.filter((_, i) => i % 4 === 0);

const FLAWED = { fen: "1k6/5B2/8/8/8/8/K4Q2/8 w - - 0 1", plan: ["f2c5", "f7d5", "c5c6", "c6b7"] };
const SOUND = { fen: "1k6/5B2/8/8/8/8/K4Q2/8 w - - 0 1", plan: ["f2c5", "f7e6", "e6c8", "c5c6", "c6b7"] };

let api;
async function load() {
  api ??= await import("../src/engine/premoveOpponent.js");
  return { ...api, engine: await api.loadPremoveEngine() };
}

const asMove = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

// Independent reference written against chess.js and the game's own rules (session.js):
// can the opponent stop `plan` from mating? A single board with move/undo keeps the
// repetition history exactly as the game's Chess instance does.
function referenceRefutable(fen, plan) {
  const board = new Chess(fen);
  function playerTurn(i) {
    const move = board.moves({ verbose: true }).find((m) => m.from === plan[i].slice(0, 2)
      && m.to === plan[i].slice(2, 4) && m.promotion === (plan[i][4] || undefined) && m.captured !== "k");
    if (!move) return true;                       // premove illegal
    board.move(move);
    let refuted;
    if (board.isCheckmate()) refuted = false;
    else if (board.isDraw() || i === plan.length - 1) refuted = true;
    else {
      refuted = false;
      for (const reply of board.moves({ verbose: true })) {
        board.move(reply);
        const r = board.isCheckmate() || board.isDraw() || playerTurn(i + 1);
        board.undo();
        if (r) { refuted = true; break; }
      }
    }
    board.undo();
    return refuted;
  }
  return playerTurn(0);
}

// Builds plan variants the way a player would, through the session's planning API.
function queueable(fen, plan) {
  const game = createPremoveGame({ fen });
  try {
    for (const uci of plan) game.queueMove(asMove(uci));
  } catch {
    return null;
  }
  return game.snapshot().premoves.map((m) => `${m.from}${m.to}${m.promotion ?? ""}`);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function variants(fen, solution, random) {
  const out = [solution, solution.slice(0, -1)];
  for (let tries = 0; tries < 6 && out.length < 5; tries += 1) {
    const k = Math.floor(random() * solution.length);
    const game = createPremoveGame({ fen });
    let ok = true;
    for (let i = 0; i < k && ok; i += 1) {
      try { game.queueMove(asMove(solution[i])); } catch { ok = false; }
    }
    if (!ok) continue;
    const preview = parsePlacement(game.snapshot().fen);
    const moves = [...preview.entries()].filter(([, piece]) => piece.color === "w")
      .flatMap(([square]) => game.legalMovesFrom(square));
    const pick = moves[Math.floor(random() * moves.length)];
    const plan = queueable(fen, [...solution.slice(0, k), `${pick.from}${pick.to}${pick.promotion ?? ""}`,
      ...solution.slice(k + 1)]);
    if (plan) out.push(plan);
  }
  if (solution.length > 2) {
    const swapped = queueable(fen, [solution[1], solution[0], ...solution.slice(2)]);
    if (swapped) out.push(swapped);
  }
  return out.filter((p) => p.length > 0);
}

async function playOut(engine, createPremoveOpponent, fen, plan) {
  const game = createPremoveGame({ fen });
  for (const uci of plan) game.queueMove(asMove(uci));
  const opponent = createPremoveOpponent({ engine, puzzleFen: fen, premoves: game.snapshot().premoves });
  return game.play(opponent, { delayMs: 0 });
}

test("finds the hidden defence Kb7 against a near-miss plan", { skip }, async () => {
  const { engine } = await load();
  const result = engine.analyzePlan(FLAWED.fen, FLAWED.plan);
  assert.equal(result.verdict, "refuted");
  assert.equal(result.end, "out_of_premoves");
  assert.deepEqual(result.line.map((m) => m.san), ["Qc5", "Kb7", "Bd5+", "Ka6", "Qc6+", "Ka5", "Qb7"]);
});

test("recognises a sound plan and resists as long as possible", { skip }, async () => {
  const { engine } = await load();
  const result = engine.analyzePlan(SOUND.fen, SOUND.plan);
  assert.equal(result.verdict, "sound");
  assert.equal(result.end, "checkmate");
  assert.equal(result.line.length, 9); // the mate only lands on the final premove
});

test("in a real game the opponent beats the flawed plan and loses to the sound one", { skip }, async () => {
  const { engine, createPremoveOpponent } = await load();
  const lost = await playOut(engine, createPremoveOpponent, FLAWED.fen, FLAWED.plan);
  assert.equal(lost.outcome, "defeat");
  const won = await playOut(engine, createPremoveOpponent, SOUND.fen, SOUND.plan);
  assert.equal(won.outcome, "victory");
});

test("falls back to another engine when the game leaves the submitted plan", { skip }, async () => {
  const { engine, createPremoveOpponent } = await load();
  let asked = 0;
  const fallback = { async bestMove() { asked += 1; return "b8a7"; } };
  const opponent = createPremoveOpponent({ engine, puzzleFen: SOUND.fen, premoves: SOUND.plan, fallback });
  // a position that is not reachable by playing the first premove
  const move = await opponent.bestMove("1k6/5B2/8/8/8/8/K7/2Q5 b - - 1 1");
  assert.equal(move, "b8a7");
  assert.equal(asked, 1);
});

test("every generated solution can be entered on the planning board", () => {
  for (const puzzle of ALL_FIXTURES) {
    assert.ok(queueable(puzzle.fen, puzzle.solution), `${puzzle.fen}: ${puzzle.solution_san.join(" ")}`);
  }
});

test("without a fallback engine, a reply is still chosen when the game leaves the plan", { skip }, async () => {
  const { engine, createPremoveOpponent } = await load();
  const opponent = createPremoveOpponent({ engine, puzzleFen: SOUND.fen, premoves: SOUND.plan });
  const fen = "1k6/5B2/8/8/8/8/K7/2Q5 b - - 1 1"; // not reachable by playing the first premove
  const move = await opponent.bestMove(fen);
  assert.ok(new Chess(fen).moves({ verbose: true }).some((m) => `${m.from}${m.to}` === move));
});

test("the rule-of-thumb reply prefers making the next premove illegal", { skip }, async () => {
  const { ruleOfThumbReply } = await load();
  const fen = "1k6/8/8/1r6/8/8/8/R5K1 b - - 0 1"; // White's next premove is Ra1-a8
  const reply = ruleOfThumbReply(fen, "a1a8");
  const board = new Chess(fen);
  board.move({ from: reply.slice(0, 2), to: reply.slice(2, 4) });
  assert.equal(board.moves({ verbose: true }).some((m) => m.from === "a1" && m.to === "a8"), false,
    `after ${reply}, Ra8 should be illegal`);
});

test("agrees with an independent chess.js reference on generated puzzles and plan variants", { skip }, async (t) => {
  const { engine, createPremoveOpponent } = await load();
  const random = rng(20261101);
  let checked = 0;
  let refuted = 0;
  let played = 0;
  let refTime = 0;
  for (const puzzle of FIXTURES) {
    for (const plan of variants(puzzle.fen, puzzle.solution, random)) {
      const t0 = performance.now();
      const expected = referenceRefutable(puzzle.fen, plan);
      refTime += performance.now() - t0;
      const analysis = engine.analyzePlan(puzzle.fen, plan);
      const label = `${puzzle.fen} [${plan.join(" ")}]`;
      assert.equal(analysis.verdict, expected ? "refuted" : "sound", label);
      checked += 1;
      refuted += expected ? 1 : 0;
      // The planning UI follows premove geometry, so every plan here can be entered.
      assert.ok(queueable(puzzle.fen, plan), `${label}: cannot be entered on the planning board`);
      {
        const result = await playOut(engine, createPremoveOpponent, puzzle.fen, plan);
        assert.equal(result.outcome === "victory", !expected, `${label}: game outcome ${result.outcome}`);
        played += 1;
      }
    }
  }
  t.diagnostic(`reference ${Math.round(refTime)} ms`);
  t.diagnostic(`${checked} plans checked (${refuted} refuted), ${played} played through the session`);
  const minimum = FULL ? 100 : 25;
  assert.ok(checked >= minimum, `only ${checked} plans checked`);
  assert.equal(played, checked);
  assert.ok(refuted > checked / 5 && refuted < checked, `unbalanced sample: ${refuted}/${checked} refuted`);
});

test("the real opponent plays its escape when the plan ends on a check that isn't mate", { skip }, async () => {
  const { createPremoveOpponent, loadPremoveEngine } = await import("../src/engine/premoveOpponent.js");
  const engine = await loadPremoveEngine();
  const fen = "8/1k6/8/8/8/8/2KQ4/4R3 w - - 0 1"; // level 1
  const game = createPremoveGame({ id: "1", fen, number_of_moves: 3 });
  game.queueMove({ from: "e1", to: "b1" }); // Rb1+, but the king has a6, a7, a8 and c6…
  const opponent = createPremoveOpponent({ engine, puzzleFen: fen, premoves: game.snapshot().premoves });
  const result = await game.play(opponent, { delayMs: 0 });
  assert.equal(result.outcome, "defeat");
  assert.equal(result.lastMove.color, "b", "the escape was played");
  assert.equal(new Chess(result.fen).inCheck(), false);
  assert.match(result.message, /gave check, but not checkmate/);
});
