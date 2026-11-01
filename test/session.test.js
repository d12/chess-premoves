import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { PUZZLES } from "../src/game/puzzles.js";
import { createPremoveGame } from "../src/game/session.js";

test("every built-in puzzle uses the shared forced mate-in-three position", () => {
  const fen = "8/8/2k5/8/8/8/3Q4/4R2K w - - 0 1";

  for (const puzzle of PUZZLES) {
    assert.equal(puzzle.fen, fen);
    assert.equal(new Chess(puzzle.fen).turn(), "w");
  }

  const position = new Chess(fen);
  assert.equal(position.move({ from: "e1", to: "c1" }).san, "Rc1+");
  const firstReplies = position.moves({ verbose: true });
  assert.ok(firstReplies.length > 0);

  for (const firstReply of firstReplies) {
    const afterFirstReply = new Chess(position.fen());
    afterFirstReply.move({ from: firstReply.from, to: firstReply.to });
    const queenMove = afterFirstReply.moves({ verbose: true })
      .find((move) => move.from === "d2" && move.to === "b2");
    assert.ok(queenMove, `Qb2 should be legal after ${firstReply.san}`);
    assert.equal(queenMove.san, "Qb2+");
    afterFirstReply.move({ from: queenMove.from, to: queenMove.to });

    for (const secondReply of afterFirstReply.moves({ verbose: true })) {
      const afterSecondReply = new Chess(afterFirstReply.fen());
      afterSecondReply.move({ from: secondReply.from, to: secondReply.to });
      const rookMove = afterSecondReply.moves({ verbose: true })
        .find((move) => move.from === "c1" && move.to === "a1");
      assert.ok(rookMove, `Ra1 should be legal after ${secondReply.san}`);
      assert.equal(rookMove.san, "Ra1#");
      afterSecondReply.move({ from: rookMove.from, to: rookMove.to });
      assert.equal(afterSecondReply.isCheckmate(), true);
    }
  }
});

test("a premove is validated, shown in the preview, and can be undone", () => {
  const game = createPremoveGame(PUZZLES[0]);
  assert.throws(() => game.queueMove({ from: "a1", to: "a2" }), /Illegal premove/);

  const queued = game.queueMove({ from: "e1", to: "c1" });
  assert.equal(queued.premoves[0].san, "Rc1+");
  assert.equal(new Chess(queued.fen).isCheckmate(), false);
  assert.deepEqual(game.undoPremove().premoves, []);
});

test("a premove cannot capture the opponent king after a check", () => {
  const cases = [
    { fen: PUZZLES[0].fen, playerColor: "w", from: "e1", to: "c1", king: "c6", safe: "a1" },
    { fen: "4r2k/3q4/8/8/8/2K5/8/8 b - - 0 1", playerColor: "b", from: "e8", to: "c8", king: "c3", safe: "a8" },
  ];

  for (const { fen, playerColor, from, to, king, safe } of cases) {
    const game = createPremoveGame({ fen }, { playerColor });
    const before = game.queueMove({ from, to });
    const moves = game.legalMovesFrom(to);
    assert.equal(moves.some((move) => move.to === king), false);
    assert.ok(moves.some((move) => move.to === safe));
    assert.throws(() => game.queueMove({ from: to, to: king }), /Illegal premove/);
    assert.deepEqual(game.snapshot(), before);
    assert.equal(new Chess(game.snapshot().fen).get(king).type, "k");
    game.queueMove({ from: to, to: safe });
    assert.deepEqual(game.undoPremove(), before);
  }
});

test("the three-move premove line wins after two legal opponent replies", async () => {
  const game = createPremoveGame(PUZZLES[0]);
  game.queueMove({ from: "e1", to: "c1" });
  game.queueMove({ from: "d2", to: "b2" });
  game.queueMove({ from: "c1", to: "a1" });
  let engineCalls = 0;
  const replies = ["c6b7", "b7a8"];

  const result = await game.play({
    async bestMove() {
      return replies[engineCalls++];
    },
  }, { delayMs: 0 });

  assert.equal(result.phase, "complete");
  assert.equal(result.outcome, "victory");
  assert.equal(engineCalls, 2);
  assert.equal(new Chess(result.fen).isCheckmate(), true);
});

test("promotion choices are explicit and a queued promotion changes the preview", () => {
  const puzzle = {
    id: "promotion",
    fen: "7k/P7/8/8/8/8/8/7K w - - 0 1",
  };
  const game = createPremoveGame(puzzle);
  const promotions = game.legalMovesFrom("a7").filter((move) => move.to === "a8");

  assert.deepEqual(promotions.map((move) => move.promotion).sort(), ["b", "n", "q", "r"]);
  assert.throws(() => game.queueMove({ from: "a7", to: "a8" }), /Illegal premove/);
  const result = game.queueMove({ from: "a7", to: "a8", promotion: "n" });
  assert.equal(new Chess(result.fen).get("a8").type, "n");
});

test("castling is available only when the king can legally castle", () => {
  const openCastle = createPremoveGame({
    id: "castle",
    fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
  });
  assert.deepEqual(
    openCastle.legalMovesFrom("e1").filter((move) => ["c1", "g1"].includes(move.to)).map((move) => move.to).sort(),
    ["c1", "g1"],
  );

  const checkedKing = createPremoveGame({
    id: "castle-in-check",
    fen: "4r2k/8/8/8/8/8/8/R3K2R w KQ - 0 1",
  });
  assert.deepEqual(
    checkedKing.legalMovesFrom("e1").filter((move) => ["c1", "g1"].includes(move.to)),
    [],
  );
});

test("en passant is validated and removes the captured pawn in the preview", () => {
  const game = createPremoveGame({
    id: "en-passant",
    fen: "7k/8/8/3pP3/8/8/8/7K w - d6 0 1",
  });
  assert.ok(game.legalMovesFrom("e5").some((move) => move.to === "d6"));
  const result = game.queueMove({ from: "e5", to: "d6" });
  const preview = new Chess(result.fen);
  assert.equal(preview.get("d6").type, "p");
  assert.equal(preview.get("d5"), undefined);
});

test("an opponent capture can invalidate a later premove", async () => {
  const puzzle = {
    id: "capture",
    fen: "7k/8/8/8/8/8/1r6/R6K w - - 0 1",
  };
  const game = createPremoveGame(puzzle);
  game.queueMove({ from: "a1", to: "a2" });
  game.queueMove({ from: "a2", to: "a3" });

  const result = await game.play({
    async bestMove() {
      return "b2a2";
    },
  }, { delayMs: 0 });

  assert.equal(result.outcome, "defeat");
  assert.match(result.message, /made your next premove illegal/);
  assert.equal(new Chess(result.fen).get("a2").color, "b");
});
