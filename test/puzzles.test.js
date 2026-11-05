// Checks every puzzle in src/game/puzzles.json (managed with `ppz app`), so adding a
// puzzle is validated against the real game rules by `npm test`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Chess } from "chess.js";
import { parseLevelId, PUZZLES } from "../src/game/puzzles.js";
import STAGE_DATA from "../src/game/stages.json" with { type: "json" };
import { createPremoveGame } from "../src/game/session.js";

const LEVELS_PER_WORLD = 5;

const built = existsSync(new URL("../src/engine/generated/premove-engine.js", import.meta.url));
const asMove = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

test("every world-level has exactly one puzzle, in play order", () => {
  const expected = STAGE_DATA.flatMap((stage) =>
    Array.from({ length: LEVELS_PER_WORLD }, (_, index) => `${stage.id}-${index + 1}`));
  assert.deepEqual(PUZZLES.map((puzzle) => puzzle.id), expected,
    "puzzles.json must list 1-1 … 1-5, 2-1 … with no gaps, extras or duplicates (use `ppz app add --level S-L`)");
});

test("parseLevelId reads world-level ids and rejects anything else", () => {
  assert.deepEqual(parseLevelId("3-2"), { world: 3, level: 2 });
  assert.deepEqual(parseLevelId("12-10"), { world: 12, level: 10 });
  for (const bad of ["3", "0-1", "1-0", "01-2", "3-2-1", "a-b", "", "3 - 2"]) {
    assert.equal(parseLevelId(bad), null, bad);
  }
});

test("puzzles have the fields the app needs", () => {
  assert.ok(PUZZLES.length > 0);
  PUZZLES.forEach((puzzle) => {
    assert.ok(parseLevelId(puzzle.id), `puzzle id ${puzzle.id} is a world-level id`);
    for (const field of ["title", "description", "fen"]) {
      assert.equal(typeof puzzle[field], "string", `puzzle ${puzzle.id} ${field}`);
      assert.ok(puzzle[field].length > 0, `puzzle ${puzzle.id} ${field}`);
    }
    assert.equal(new Chess(puzzle.fen).turn(), "w", `puzzle ${puzzle.id} must have White to move`);
    assert.equal(puzzle.solution_uci.length, puzzle.number_of_moves, `puzzle ${puzzle.id} solution length`);
    assert.equal(puzzle.solution.length, puzzle.number_of_moves, `puzzle ${puzzle.id} SAN solution length`);
  });
});

test("every stored solution can be entered on the planning board", () => {
  for (const puzzle of PUZZLES) {
    const game = createPremoveGame(puzzle);
    for (const uci of puzzle.solution_uci) {
      assert.doesNotThrow(() => game.queueMove(asMove(uci)), `puzzle ${puzzle.id}: ${uci}`);
    }
  }
});

test("every stored solution is sound and wins against the premove opponent",
  { skip: built ? false : "WebAssembly engine not built: run `npm run build:wasm`" }, async () => {
    const { loadPremoveEngine, createPremoveOpponent } = await import("../src/engine/premoveOpponent.js");
    const engine = await loadPremoveEngine();
    for (const puzzle of PUZZLES) {
      const analysis = engine.analyzePlan(puzzle.fen, puzzle.solution_uci);
      assert.equal(analysis.verdict, "sound", `puzzle ${puzzle.id}: ${JSON.stringify(analysis)}`);
      const game = createPremoveGame(puzzle);
      for (const uci of puzzle.solution_uci) game.queueMove(asMove(uci));
      const opponent = createPremoveOpponent({ engine, puzzleFen: puzzle.fen, premoves: puzzle.solution_uci });
      const result = await game.play(opponent, { delayMs: 0 });
      assert.equal(result.outcome, "victory", `puzzle ${puzzle.id}: ${result.message}`);
    }
  });
