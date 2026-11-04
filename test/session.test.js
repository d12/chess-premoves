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
    { fen: EXAMPLE.fen, playerColor: "w", check: ["e1", "c1"], king: "c6", replies: ["c6b7"], ending: /ended before checkmate/ },
    // here the last premove (Rc3+) is check, so the king's escape is played out too
    { fen: "4r2k/3q4/8/8/8/2K5/8/8 b - - 0 1", playerColor: "b", check: ["e8", "c8"], king: "c3", replies: ["c3b3", "b3b4"], ending: /way out/ },
  ];
  for (const { fen, playerColor, check, king, replies, ending } of cases) {
    const game = createPremoveGame({ fen }, { playerColor });
    game.queueMove({ from: check[0], to: check[1] });
    assert.ok(game.legalMovesFrom(check[1]).some((move) => move.to === king));
    const queued = game.queueMove({ from: check[1], to: king });
    assert.equal(queued.premoves[1].san, `R${king}`); // not shown as capturing the king
    assert.equal(pieceAt(queued.fen, king).type, "r");

    // the check forces the king away, so the premove is legal when it is played
    const result = await game.play({ async bestMove() { return replies.shift(); } }, { delayMs: 0 });
    assert.equal(new Chess(result.fen).get(king)?.type, "r");
    assert.match(result.message, ending);
    assert.equal(replies.length, 0);
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

test("playback waits startDelayMs on the starting position before the first move", async () => {
  const game = createPremoveGame(EXAMPLE);
  queueAll(game, ["e1c1", "d2b2", "c1a1"]);
  const replies = ["c6b7", "b7a8"];
  const updates = [];
  const started = Date.now();

  await game.play({ async bestMove() { return replies.shift(); } }, {
    delayMs: 0,
    startDelayMs: 200,
    onUpdate(snapshot) { updates.push({ at: Date.now() - started, snapshot }); },
  });

  assert.equal(updates[0].snapshot.phase, "playing");
  assert.equal(updates[0].snapshot.lastMove, null);
  assert.equal(updates[0].snapshot.fen, EXAMPLE.fen);
  const firstMove = updates.find((update) => update.snapshot.lastMove);
  assert.equal(firstMove.snapshot.lastMove.color, "w");
  assert.ok(firstMove.at - updates[0].at >= 190, `first move came after ${firstMove.at - updates[0].at}ms`);
});

test("a negative start delay is rejected", async () => {
  const game = createPremoveGame(EXAMPLE);
  queueAll(game, ["e1c1"]);
  await assert.rejects(game.play({ async bestMove() { return "c6b7"; } }, { startDelayMs: -1 }), /Start delay/);
});

test("snapshots name the mated king's square from the moment of checkmate", async () => {
  const game = createPremoveGame(EXAMPLE);
  queueAll(game, ["e1c1", "d2b2", "c1a1"]);
  assert.equal(game.snapshot().matedKing, null);
  const replies = ["c6b7", "b7a8"];
  const updates = [];
  const result = await game.play({ async bestMove() { return replies.shift(); } }, {
    delayMs: 0,
    onUpdate(snapshot) { updates.push(snapshot); },
  });

  const mateMove = updates.find((snapshot) => snapshot.matedKing);
  assert.equal(mateMove.phase, "playing", "known as soon as the mating move is shown");
  assert.equal(mateMove.lastMove.to, "a1");
  assert.equal(result.matedKing, "a8");
  assert.ok(updates.filter((snapshot) => !snapshot.matedKing).every((snapshot) => snapshot.lastMove?.to !== "a1"));
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

test("a last premove that only gives check lets the opponent play its escape before the defeat", async () => {
  // Rc1+ Kb7, then Qg2+ is check but not mate: the king steps to b8
  const game = createPremoveGame(EXAMPLE);
  queueAll(game, ["e1c1", "d2g2"]);
  const replies = ["c6b7", "b7b8"];
  const updates = [];
  const result = await game.play({ async bestMove() { return replies.shift(); } }, {
    delayMs: 0,
    onUpdate(snapshot) { updates.push(snapshot); },
  });
  assert.equal(replies.length, 0, "the opponent was asked for its escape");
  assert.equal(result.outcome, "defeat");
  assert.match(result.message, /gave check, but not checkmate/);
  assert.deepEqual(result.lastMove, { from: "b7", to: "b8", san: "Kb8", color: "b" });
  // the escape is published as its own update, before the result
  const escape = updates.findIndex((snapshot) => snapshot.lastMove?.to === "b8");
  assert.ok(escape >= 0 && updates[escape].phase === "playing");
  assert.equal(updates.at(-1).phase, "complete");
});

test("a last premove that doesn't give check ends at once, without another opponent move", async () => {
  const game = createPremoveGame(EXAMPLE);
  queueAll(game, ["e1c1", "d2d3"]);
  let calls = 0;
  const result = await game.play({ async bestMove() { calls += 1; return "c6b7"; } }, { delayMs: 0 });
  assert.equal(calls, 1);
  assert.match(result.message, /ended before checkmate/);
});

test("draws are failures with the reason named, never a separate outcome", async () => {
  // Qb6 stalemates the lone king on a8
  const stalemate = createPremoveGame({ fen: "k7/8/2K5/8/8/8/8/1Q6 w - - 0 1" });
  queueAll(stalemate, ["b1b6"]);
  const stalemated = await stalemate.play({ async bestMove() { throw new Error("not asked"); } }, { delayMs: 0 });
  assert.equal(stalemated.outcome, "defeat");
  assert.match(stalemated.message, /^Stalemate: Black has no legal move but isn't in check/);

  // Kxb2 leaves king against king
  const bare = createPremoveGame({ fen: "7k/8/8/8/8/8/1n6/K7 w - - 0 1" });
  queueAll(bare, ["a1b2"]);
  const insufficient = await bare.play({ async bestMove() { throw new Error("not asked"); } }, { delayMs: 0 });
  assert.equal(insufficient.outcome, "defeat");
  assert.match(insufficient.message, /Not enough pieces/);

  // the opponent's reply can draw too: Kxb2 removes White's last piece
  const taken = createPremoveGame({ fen: "8/8/8/8/8/8/1R6/k3K3 w - - 0 1" });
  queueAll(taken, ["e1e2", "e2e3"]);
  const drawn = await taken.play({ async bestMove() { return "a1b2"; } }, { delayMs: 0 });
  assert.equal(drawn.outcome, "defeat");
  assert.match(drawn.message, /Not enough pieces/);
});
