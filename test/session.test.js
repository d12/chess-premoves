import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { parsePlacement } from "../src/game/premoveRules.js";
import { createPremoveGame } from "../src/game/session.js";

const EXAMPLE = { id: "example", fen: "8/8/2k5/8/8/8/3Q4/4R2K w - - 0 1" };
const pieceAt = (fen, square) => parsePlacement(fen).get(square);
const queueAll = (game, moves) => moves.forEach((uci) => game.queueMove({
  from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4],
}));

test("the example line Rc1, Qb2, Ra1 stays legal against every opponent reply", () => {
  const position = new Chess(EXAMPLE.fen);
  assert.equal(position.move({ from: "e1", to: "c1" }).san, "Rc1+");
  const firstReplies = position.moves({ verbose: true });
  assert.ok(firstReplies.length > 0);

  for (const firstReply of firstReplies) {
    const afterFirstReply = new Chess(position.fen());
    afterFirstReply.move({ from: firstReply.from, to: firstReply.to });
    const queenMove = afterFirstReply.moves({ verbose: true })
      .find((move) => move.from === "d2" && move.to === "b2");
    assert.ok(queenMove, `Qb2 should be legal after ${firstReply.san}`);
    afterFirstReply.move({ from: queenMove.from, to: queenMove.to });

    for (const secondReply of afterFirstReply.moves({ verbose: true })) {
      const afterSecondReply = new Chess(afterFirstReply.fen());
      afterSecondReply.move({ from: secondReply.from, to: secondReply.to });
      const rookMove = afterSecondReply.moves({ verbose: true })
        .find((move) => move.from === "c1" && move.to === "a1");
      assert.ok(rookMove, `Ra1 should be legal after ${secondReply.san}`);
      afterSecondReply.move({ from: rookMove.from, to: rookMove.to });
      assert.equal(afterSecondReply.isCheckmate(), true);
    }
  }
});

test("a premove is checked against piece geometry, shown in the preview, and can be undone", () => {
  const game = createPremoveGame(EXAMPLE);
  assert.throws(() => game.queueMove({ from: "a1", to: "a2" }), /Illegal premove/); // no piece
  assert.throws(() => game.queueMove({ from: "e1", to: "d2" }), /Illegal premove/); // rooks move straight
  assert.throws(() => game.queueMove({ from: "c6", to: "c5" }), /Illegal premove/); // opponent's piece

  const queued = game.queueMove({ from: "e1", to: "c1" });
  assert.equal(queued.premoves[0].san, "Rc1"); // no check sign: the opponent moves in between
  assert.equal(pieceAt(queued.fen, "c1").type, "r");
  assert.equal(pieceAt(queued.fen, "e1"), undefined);
  assert.deepEqual(game.undoPremove().premoves, []);
});

test("premoves ignore pieces in the way, like chess.com and lichess", () => {
  // Ra3-a1 passes a2, where the opponent king stands now but cannot stay (Ra3 is check)
  const game = createPremoveGame({ fen: "8/7B/8/8/1K6/2R5/k7/8 w - - 0 1" });
  assert.doesNotThrow(() => queueAll(game, ["c3a3", "h7d3", "b4c3", "a3a1"]));
  assert.deepEqual(game.snapshot().premoves.map((move) => move.san), ["Ra3", "Bd3", "Kc3", "Ra1"]);
});

test("planning continues past a preview that only looks like checkmate", async () => {
  // In the preview the opponent king never moves, so Qa3 "mates" it; in the game it has moved.
  const game = createPremoveGame({ fen: "8/8/8/8/4Q3/kp6/3K4/8 w - - 0 1" });
  assert.doesNotThrow(() => queueAll(game, ["d2c3", "e4a8", "a8a3"]));
  assert.equal(pieceAt(game.snapshot().fen, "a3").type, "q"); // the queen hides the king's square
  const done = game.queueMove({ from: "a3", to: "b2" });
  assert.equal(done.premoves.length, 4);
  assert.deepEqual(pieceAt(done.fen, "a3"), { type: "k", color: "b" }); // and the king is shown again
  assert.equal(game.undoPremove().premoves.length, 3);
  assert.equal(pieceAt(game.snapshot().fen, "a3").type, "q");
});

test("a premove may target the square the opponent king stands on now", async () => {
  const cases = [
    { fen: EXAMPLE.fen, playerColor: "w", check: ["e1", "c1"], king: "c6", reply: "c6b7" },
    { fen: "4r2k/3q4/8/8/8/2K5/8/8 b - - 0 1", playerColor: "b", check: ["e8", "c8"], king: "c3", reply: "c3b3" },
  ];
  for (const { fen, playerColor, check, king, reply } of cases) {
    const game = createPremoveGame({ fen }, { playerColor });
    game.queueMove({ from: check[0], to: check[1] });
    assert.ok(game.legalMovesFrom(check[1]).some((move) => move.to === king));
    const queued = game.queueMove({ from: check[1], to: king });
    assert.equal(queued.premoves[1].san, `R${king}`); // not shown as capturing the king
    assert.equal(pieceAt(queued.fen, king).type, "r");

    // the check forces the king away, so the premove is legal when it is played
    const result = await game.play({ async bestMove() { return reply; } }, { delayMs: 0 });
    assert.equal(new Chess(result.fen).get(king)?.type, "r");
    assert.match(result.message, /ended before checkmate/);
  }
});

test("the three-move premove line wins after two legal opponent replies", async () => {
  const game = createPremoveGame(EXAMPLE);
  queueAll(game, ["e1c1", "d2b2", "c1a1"]);
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
  const game = createPremoveGame({ id: "promotion", fen: "7k/P7/8/8/8/8/8/7K w - - 0 1" });
  const promotions = game.legalMovesFrom("a7").filter((move) => move.to === "a8");

  assert.deepEqual(promotions.map((move) => move.promotion).sort(), ["b", "n", "q", "r"]);
  assert.throws(() => game.queueMove({ from: "a7", to: "a8" }), /needs a promotion piece/);
  const result = game.queueMove({ from: "a7", to: "a8", promotion: "n" });
  assert.equal(pieceAt(result.fen, "a8").type, "n");
  assert.equal(result.premoves[0].san, "a8=N");
});

test("castling premoves follow castling rights; legality is checked when played", async () => {
  const openCastle = createPremoveGame({ id: "castle", fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1" });
  assert.deepEqual(
    openCastle.legalMovesFrom("e1").filter((move) => ["c1", "g1"].includes(move.to)).map((move) => move.to).sort(),
    ["c1", "g1"],
  );
  const castled = openCastle.queueMove({ from: "e1", to: "g1" });
  assert.equal(castled.premoves[0].san, "O-O");
  assert.equal(pieceAt(castled.fen, "f1").type, "r");

  const noRights = createPremoveGame({ id: "no-rights", fen: "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1" });
  assert.deepEqual(noRights.legalMovesFrom("e1").filter((move) => ["c1", "g1"].includes(move.to)), []);

  const rookMoved = createPremoveGame({ id: "rook-moved", fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1" });
  rookMoved.queueMove({ from: "h1", to: "h2" });
  assert.deepEqual(rookMoved.legalMovesFrom("e1").map((move) => move.to).filter((to) => to === "g1"), []);

  // castling out of check can be premoved (the check may be gone by then) but fails if it is not
  const checkedKing = createPremoveGame({ id: "castle-in-check", fen: "4r2k/8/8/8/8/8/8/R3K2R w KQ - 0 1" });
  checkedKing.queueMove({ from: "e1", to: "g1" });
  const result = await checkedKing.play({ async bestMove() { return "h8g8"; } }, { delayMs: 0 });
  assert.equal(result.outcome, "defeat");
  assert.match(result.message, /premove illegal/);
});

test("a diagonal pawn premove is allowed and plays as en passant when available", async () => {
  const game = createPremoveGame({ id: "en-passant", fen: "7k/8/8/3pP3/8/8/8/7K w - d6 0 1" });
  assert.ok(game.legalMovesFrom("e5").some((move) => move.to === "d6"));
  const queued = game.queueMove({ from: "e5", to: "d6" });
  assert.equal(queued.premoves[0].san, "exd6");
  assert.equal(pieceAt(queued.fen, "d6").type, "p");

  const result = await game.play({ async bestMove() { return "h8g8"; } }, { delayMs: 0 });
  const board = new Chess(result.fen);
  assert.equal(board.get("d6").type, "p");
  assert.equal(board.get("d5"), undefined);
});

test("an opponent capture can invalidate a later premove", async () => {
  const game = createPremoveGame({ id: "capture", fen: "7k/8/8/8/8/8/1r6/R6K w - - 0 1" });
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

test("a win is perfect only when it uses no more premoves than the puzzle's minimum", async () => {
  const replies = () => {
    const moves = ["c6b7", "b7a8"];
    let i = 0;
    return { async bestMove() { return moves[i++]; } };
  };
  const line = ["e1c1", "d2b2", "c1a1"];

  const atMinimum = createPremoveGame({ ...EXAMPLE, number_of_moves: 3 });
  queueAll(atMinimum, line);
  const perfect = await atMinimum.play(replies(), { delayMs: 0 });
  assert.equal(perfect.outcome, "victory");
  assert.equal(perfect.perfect, true);
  assert.equal(perfect.minimumMoves, 3);
  assert.equal(perfect.movesUsed, 3);

  // same win, but this puzzle claims it can be done in 2: not perfect
  const aboveMinimum = createPremoveGame({ ...EXAMPLE, number_of_moves: 2 });
  queueAll(aboveMinimum, line);
  const plain = await aboveMinimum.play(replies(), { delayMs: 0 });
  assert.equal(plain.outcome, "victory");
  assert.equal(plain.perfect, false);

  // puzzles without a known minimum are never "perfect"
  const unknown = createPremoveGame(EXAMPLE);
  queueAll(unknown, line);
  const result = await unknown.play(replies(), { delayMs: 0 });
  assert.equal(result.perfect, false);
  assert.equal(result.minimumMoves, null);
});

test("a defeat is never perfect", async () => {
  const game = createPremoveGame({ ...EXAMPLE, number_of_moves: 3 });
  queueAll(game, ["e1c1", "d2b2", "c1b1"]);
  const replies = ["c6b5", "b5a4"];
  let i = 0;
  const result = await game.play({ async bestMove() { return replies[i++]; } }, { delayMs: 0 });
  assert.equal(result.outcome, "defeat");
  assert.equal(result.perfect, false);
});
