import assert from "node:assert/strict";
import test from "node:test";
import { createProgressStore } from "../src/game/progress.js";
import { STAGES, LEVELS } from "../src/game/stages.js";
import { BADGE_IDS, computeStats, loadSeenBadges, rankLadder, saveSeenBadges } from "../src/game/stats.js";

function memoryStorage(saved) {
  const values = new Map(saved ? [["chess-premove-progress-v1", JSON.stringify(saved)]] : []);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

const store = (saved) => createProgressStore(memoryStorage(saved));
const earned = (stats) => stats.badges.filter((badge) => badge.earned).map((badge) => badge.id);

test("a new player is a Pawn with nothing earned", () => {
  const stats = computeStats(store(), STAGES);
  assert.equal(stats.rank.name, "Pawn");
  assert.equal(stats.rank.next.name, "Knight");
  assert.deepEqual(stats.rank.toNext, { done: 0, goal: 5, world: STAGES[0] });
  assert.equal(stats.cleared, 0);
  assert.equal(stats.winRate, null, "no win rate before the first attempt");
  assert.deepEqual(earned(stats), []);
  assert.equal(stats.badges.length, 10);
  assert.equal(stats.worlds[0].unlocked, true);
  assert.equal(stats.worlds[1].unlocked, false);
});

test("the rank ladder follows the worlds' mascots, then King and Grandmaster", () => {
  assert.deepEqual(rankLadder(STAGES).map((rank) => rank.name), ["Pawn", "Knight", "Bishop", "Rook", "Queen", "King", "Grandmaster"]);
});

test("clearing worlds promotes the player and counts toward the next rank", () => {
  const ids = LEVELS.slice(0, 7).map((level) => level.id); // world 1 and two levels of world 2
  const stats = computeStats(store({ completedIds: ids, perfectedIds: ["1-1", "1-2"], attempts: Object.fromEntries(ids.map((id) => [id, 2])) }), STAGES);
  assert.equal(stats.rank.name, "Knight");
  assert.deepEqual(stats.rank.toNext, { done: 2, goal: 5, world: STAGES[1] });
  assert.equal(stats.cleared, 7);
  assert.equal(stats.stars, 2);
  assert.equal(stats.attempts, 14);
  assert.equal(stats.wins, 7, "old wins count once per cleared level");
  assert.equal(stats.winRate, 0.5);
  assert.equal(stats.worldsCleared, 1);
  assert.deepEqual(earned(stats), ["first-mate", "flawless", "world-conqueror"]);
});

test("every world cleared makes a King; every level perfect makes a Grandmaster", () => {
  const all = LEVELS.map((level) => level.id);
  const king = computeStats(store({ completedIds: all, perfectedIds: all.slice(0, 20) }), STAGES);
  assert.equal(king.rank.name, "King");
  assert.equal(king.rank.next.name, "Grandmaster");
  assert.deepEqual(king.rank.toNext, { done: 20, goal: 25, world: null });
  const grandmaster = computeStats(store({ completedIds: all, perfectedIds: all }), STAGES);
  assert.equal(grandmaster.rank.name, "Grandmaster");
  assert.equal(grandmaster.rank.gold, true);
  assert.equal(grandmaster.rank.next, null);
  assert.equal(grandmaster.rank.toNext, null);
  assert.ok(earned(grandmaster).includes("grandmaster"));
  assert.ok(earned(grandmaster).includes("completionist"));
  assert.ok(earned(grandmaster).includes("spotless"));
});

test("first-try clears and hard-won clears come from the recorded first wins", () => {
  const progress = store();
  const play = (id, attempts) => {
    for (let i = 0; i < attempts; i += 1) progress.recordAttempt(id);
    progress.markCompleted(id);
  };
  play("1-1", 1);
  play("1-2", 1);
  play("1-3", 6);
  const stats = computeStats(progress, STAGES);
  assert.equal(stats.firstTryClears, 2);
  assert.equal(stats.mostAttemptsToClear, 6);
  assert.deepEqual(earned(stats), ["first-mate", "sharp-eye", "never-give-up"]);
  const hatTrick = stats.badges.find((badge) => badge.id === "hat-trick");
  assert.deepEqual([hatTrick.progress, hatTrick.goal, hatTrick.earned], [2, 3, false]);
  assert.equal(stats.worlds[0].levels[0].firstTry, true);
  assert.equal(stats.worlds[0].levels[2].firstTry, false);
  assert.equal(stats.worlds[0].levels[2].attempts, 6);
});

test("badges never report more progress than their goal", () => {
  const all = LEVELS.map((level) => level.id);
  const stats = computeStats(store({ completedIds: all, perfectedIds: all }), STAGES);
  for (const badge of stats.badges) {
    assert.ok(badge.progress <= badge.goal, badge.id);
  }
});

test("seen badges are remembered, and unreadable data is treated as none seen", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.deepEqual([...loadSeenBadges(storage)], []);
  saveSeenBadges(new Set(BADGE_IDS.slice(0, 2)), storage);
  assert.deepEqual([...loadSeenBadges(storage)], BADGE_IDS.slice(0, 2));
  values.set("chess-premove-badges-seen-v1", "{nope");
  assert.deepEqual([...loadSeenBadges(storage)], []);
  assert.deepEqual([...loadSeenBadges(null)], []);
});
