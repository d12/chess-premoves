// What the stats screen shows, computed from the progress store: the player's rank, the
// counters, each world's levels and the badges. Pure (no DOM); see test/stats.test.js.
// No move counts appear here: the minimum is only shown on the puzzle page (owner's rule).

const PIECE_NAMES = { p: "Pawn", n: "Knight", b: "Bishop", r: "Rook", q: "Queen", k: "King" };

/**
 * The rank ladder: one step per world, each named after that world's mascot piece (Pawn in
 * world 1, Knight in world 2 …), then King once every world is cleared, and Grandmaster for
 * perfecting all of them.
 */
export function rankLadder(stages) {
  return [
    ...stages.map((stage) => ({ piece: stage.piece, name: PIECE_NAMES[stage.piece] ?? stage.piece, stage })),
    { piece: "k", name: "King", stage: null },
    { piece: "k", name: "Grandmaster", stage: null, gold: true },
  ];
}

// Each badge: what it's for, how far along the player is, and the goal.
const BADGES = [
  { id: "first-mate", icon: "mate", name: "First checkmate", goal: 1, measure: (s) => s.cleared, how: "Clear a level." },
  { id: "flawless", icon: "star", name: "Flawless", goal: 1, measure: (s) => s.stars, how: "Perfect a level." },
  { id: "sharp-eye", icon: "eye", name: "Sharp eye", goal: 1, measure: (s) => s.firstTryClears, how: "Clear a level on your first attempt." },
  { id: "hat-trick", icon: "hat", name: "Hat trick", goal: 3, measure: (s) => s.firstTryClears, how: "Clear three levels on the first attempt." },
  { id: "never-give-up", icon: "flame", name: "Never give up", goal: 5, measure: (s) => s.mostAttemptsToClear, how: "Clear a level that took five or more attempts." },
  { id: "world-conqueror", icon: "flag", name: "World conqueror", goal: 1, measure: (s) => s.worldsCleared, how: "Clear every level in a world." },
  { id: "spotless", icon: "gem", name: "Spotless", goal: 1, measure: (s) => s.worldsPerfected, how: "Perfect every level in a world." },
  { id: "star-collector", icon: "stars", name: "Star collector", goal: 10, measure: (s) => s.stars, how: "Earn ten stars." },
  { id: "completionist", icon: "trophy", name: "Completionist", goal: (s) => s.totalLevels, measure: (s) => s.cleared, how: "Clear every level." },
  { id: "grandmaster", icon: "crown", name: "Grandmaster", goal: (s) => s.totalLevels, measure: (s) => s.stars, how: "Perfect every level." },
];

export const BADGE_IDS = BADGES.map((badge) => badge.id);

export function computeStats(progress, stages) {
  const levels = stages.flatMap((stage) => stage.levels);
  const cleared = levels.filter((level) => progress.isCompleted(level.id)).length;
  const stars = levels.filter((level) => progress.isPerfected(level.id)).length;
  const attempts = levels.reduce((sum, level) => sum + progress.attemptCount(level.id), 0);
  // wins from before they were counted: a cleared level was won at least once
  const wins = levels.reduce((sum, level) => sum + Math.max(progress.winCount(level.id), progress.isCompleted(level.id) ? 1 : 0), 0);
  const firstWins = levels.map((level) => progress.firstWinAttempt(level.id)).filter((attempt) => attempt !== null);

  const worlds = stages.map((stage) => {
    const stageLevels = stage.levels.map((level) => ({
      id: level.id,
      number: level.number,
      unlocked: progress.isUnlocked(level.id),
      completed: progress.isCompleted(level.id),
      perfected: progress.isPerfected(level.id),
      attempts: progress.attemptCount(level.id),
      firstTry: progress.firstWinAttempt(level.id) === 1,
    }));
    const done = stageLevels.filter((level) => level.completed).length;
    const perfect = stageLevels.filter((level) => level.perfected).length;
    return {
      stage,
      unlocked: progress.isStageUnlocked(stage.id),
      cleared: done === stageLevels.length,
      perfected: perfect === stageLevels.length,
      completed: done,
      stars: perfect,
      levels: stageLevels,
    };
  });

  const summary = {
    totalLevels: levels.length,
    cleared,
    stars,
    attempts,
    wins,
    // share of submitted lines that solved their level; null before the first attempt
    winRate: attempts > 0 ? Math.min(1, wins / attempts) : null,
    firstTryClears: firstWins.filter((attempt) => attempt === 1).length,
    mostAttemptsToClear: firstWins.length ? Math.max(...firstWins) : 0,
    worldsCleared: worlds.filter((world) => world.cleared).length,
    worldsPerfected: worlds.filter((world) => world.perfected).length,
  };

  // Rank: one step per world cleared; Grandmaster when every level is perfect.
  const ladder = rankLadder(stages);
  const step = summary.stars === levels.length ? ladder.length - 1 : summary.worldsCleared;
  const rank = ladder[step];
  const next = ladder[step + 1] ?? null;
  let toNext = null;
  if (next && rank.stage) {
    const world = worlds[step];
    toNext = { done: world.completed, goal: world.levels.length, world: rank.stage };
  } else if (next) {
    toNext = { done: summary.stars, goal: levels.length, world: null };
  }

  const badges = BADGES.map((badge) => {
    const goal = typeof badge.goal === "function" ? badge.goal(summary) : badge.goal;
    const value = badge.measure(summary);
    return {
      id: badge.id,
      icon: badge.icon,
      name: badge.name,
      how: badge.how,
      goal,
      progress: Math.min(value, goal),
      earned: value >= goal,
    };
  });

  return { ...summary, rank: { ...rank, step, ladder, next, toNext }, worlds, badges };
}

// Which earned badges the player has already seen on the stats screen, so new ones can be
// flagged. Cosmetic: unreadable data just means everything earned shows as new once.
const SEEN_KEY = "chess-premove-badges-seen-v1";

export function loadSeenBadges(storage = globalThis.localStorage) {
  try {
    const ids = JSON.parse(storage?.getItem(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveSeenBadges(ids, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SEEN_KEY, JSON.stringify([...ids]));
  } catch {
    // storage full or blocked: badges just show as new again next time
  }
}
