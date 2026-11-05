import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Chess } from "chess.js";
import { createProgressStore } from "../src/game/progress.js";
import { createPremoveGame } from "../src/game/session.js";
import {
  createTutorialStore, isTutorialMove, TUTORIAL_PUZZLE, TUTORIAL_STORAGE_KEY, tutorialStep,
} from "../src/game/tutorial.js";

const built = existsSync(new URL("../src/engine/generated/premove-engine.js", import.meta.url));
const asMove = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) });

function memoryStorage(values = {}) {
  const map = new Map(Object.entries(values));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    values: map,
  };
}

test("the tutorial position is legal, White to move, and its SAN matches its UCI", () => {
  const chess = new Chess(TUTORIAL_PUZZLE.fen);
  assert.equal(chess.turn(), "w");
  assert.equal(TUTORIAL_PUZZLE.solution_uci.length, TUTORIAL_PUZZLE.number_of_moves);
  const game = createPremoveGame(TUTORIAL_PUZZLE);
  for (const uci of TUTORIAL_PUZZLE.solution_uci) {
    game.queueMove(asMove(uci));
  }
  assert.deepEqual(game.snapshot().premoves.map((move) => move.san), ["Rb5", "Ra6", "Rb7", "Ra8"]);
});

test("the guided steps follow the solution and end with nothing left to play", () => {
  const premoves = [];
  TUTORIAL_PUZZLE.solution_uci.forEach((uci, index) => {
    const step = tutorialStep(premoves);
    assert.equal(step.index, index);
    assert.deepEqual(step.next, asMove(uci));
    assert.ok(step.coach.title && step.coach.text, `coach copy for step ${index}`);
    assert.equal(isTutorialMove(premoves, asMove(uci)), true);
    assert.equal(isTutorialMove(premoves, { from: "h1", to: "g1" }), false);
    premoves.push(asMove(uci));
  });
  const last = tutorialStep(premoves);
  assert.equal(last.next, null);
  assert.ok(last.coach.title, "a coach line for the submit step");
  assert.equal(isTutorialMove(premoves, { from: "a8", to: "a1" }), false);
  assert.equal(isTutorialMove([{ from: "h1", to: "g1" }], asMove("b3b5")), false, "off the line");
});

test("the ladder mate beats the premove opponent, and nothing shorter does",
  { skip: built ? false : "WebAssembly engine not built: run `npm run build:wasm`" }, async () => {
    const { loadPremoveEngine, createPremoveOpponent } = await import("../src/engine/premoveOpponent.js");
    const engine = await loadPremoveEngine();
    const { fen, solution_uci: line } = TUTORIAL_PUZZLE;
    assert.equal(engine.analyzePlan(fen, line).verdict, "sound");
    const game = createPremoveGame(TUTORIAL_PUZZLE);
    line.forEach((uci) => game.queueMove(asMove(uci)));
    const result = await game.play(createPremoveOpponent({ engine, puzzleFen: fen, premoves: line }), { delayMs: 0 });
    assert.equal(result.outcome, "victory");
    assert.equal(result.perfect, true);

    // every plan of one or two premoves fails (three were checked offline: 31,502 plans, none sound)
    const squares = [..."abcdefgh"].flatMap((file) => [1, 2, 3, 4, 5, 6, 7, 8].map((rank) => `${file}${rank}`));
    const plans = (prefix) => {
      const preview = createPremoveGame(TUTORIAL_PUZZLE);
      prefix.forEach((uci) => preview.queueMove(asMove(uci)));
      return squares.flatMap((square) => preview.legalMovesFrom(square)).map((move) => [...prefix, move.from + move.to]);
    };
    for (const first of plans([])) {
      assert.notEqual(engine.analyzePlan(fen, first).verdict, "sound", first.join(" "));
      for (const second of plans(first)) {
        assert.notEqual(engine.analyzePlan(fen, second).verdict, "sound", second.join(" "));
      }
    }
  });

test("the tutorial store remembers completion, and old winners skip it", () => {
  const storage = memoryStorage();
  const fresh = createTutorialStore(storage, { progress: createProgressStore(memoryStorage()) });
  assert.equal(fresh.isDone(), false);
  fresh.markDone();
  assert.equal(fresh.isDone(), true);
  assert.equal(storage.values.get(TUTORIAL_STORAGE_KEY), "done");
  assert.equal(createTutorialStore(storage).isDone(), true, "remembered on reload");

  const veteran = createProgressStore(memoryStorage({ "chess-premove-progress-v1": JSON.stringify({ completedIds: ["1-1"] }) }));
  assert.equal(createTutorialStore(memoryStorage(), { progress: veteran }).isDone(), true);
  const preStages = createProgressStore(memoryStorage({ "chess-premove-progress-v1": JSON.stringify({ completedIds: ["1"] }) }));
  assert.equal(createTutorialStore(memoryStorage(), { progress: preStages }).isDone(), false,
    "pre-stage saves count for nothing, as elsewhere");
  assert.equal(createTutorialStore(memoryStorage({ [TUTORIAL_STORAGE_KEY]: "nonsense" })).isDone(), false);
});

test("broken storage never locks the game", () => {
  const unreadable = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  const store = createTutorialStore(unreadable);
  assert.equal(store.isDone(), false);
  assert.throws(() => store.markDone(), /Unable to save tutorial progress/);
  assert.equal(store.isDone(), true, "done for this visit even though it couldn't be saved");
});
