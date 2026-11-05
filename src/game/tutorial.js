// The tutorial: a guided ladder mate that every new player plays once before the worlds open.
//
// Two rooks walk the black king up the board, one rank at a time: one rook gives check, the
// other guards the rank behind it, and they leapfrog until the king runs out of board. The
// point is the game's one idea: you don't need to know where the king will go, only that
// every way out still runs into mate. The line is sound against the premove opponent and no
// shorter mate exists (both checked in test/tutorial.test.js).
//
// Pure data and a tiny store, no DOM: main.js renders it.

export const TUTORIAL_STORAGE_KEY = "chess-premove-tutorial-v1";

export const TUTORIAL_PUZZLE = Object.freeze({
  id: "tutorial",
  title: "The ladder mate",
  description: "A guided ladder mate with two rooks.",
  fen: "8/8/8/6k1/R7/1R6/8/7K w - - 0 1",
  number_of_moves: 4,
  solution: Object.freeze(["Rb5+", "Ra6+", "Rb7+", "Ra8#"]),
  solution_uci: Object.freeze(["b3b5", "a4a6", "b5b7", "a6a8"]),
});

// The level the puzzle screen plays. World 1's id gives it the meadow theme and music.
export const TUTORIAL_LEVEL = Object.freeze({
  id: "tutorial",
  stageId: "1",
  number: 0,
  puzzle: TUTORIAL_PUZZLE,
});

export const TUTORIAL_INTRO = Object.freeze({
  eyebrow: "Tutorial",
  title: "Welcome to Premove!",
  paragraphs: Object.freeze([
    "You don't take turns here. You queue up all your moves first, then watch them play out.",
    "The catch: your opponent sees the whole plan and will wriggle through any gap. Your job is to find premoves that force checkmate no matter what it does.",
  ]),
  button: "Let's go",
});

// What the coach says while planning, one entry per premove queued so far; the last entry is
// for when the whole line is queued and only the submit button is left.
const PLANNING_COACH = Object.freeze([
  {
    title: "Climb the ladder",
    text: "Two rooks can herd a king to the edge, one row at a time. Slide this rook up: check! The other guards the row below.",
  },
  {
    title: "Leapfrog",
    text: "Notice the king hasn't budged? You don't know where he'll run, and you don't need to: every escape is up. Leapfrog!",
  },
  {
    title: "Keep climbing",
    text: "Same trick, one rung higher. One rook gives check, the other holds the line.",
  },
  {
    title: "Last rung",
    text: "He's run out of ladder. Finish it.",
  },
  {
    title: "Lock it in",
    text: "Four premoves, and checkmate whatever he does. Hit Done and watch it play out.",
  },
]);

export const PLAYING_COACH = Object.freeze({
  title: "No take-backs",
  text: "Your opponent read your whole plan and is hunting for a gap. Good luck to it.",
});

export const COMPLETE_CARD = Object.freeze({
  eyebrow: "Tutorial complete",
  title: "You've got it!",
  text: "That's the whole game: premoves that force mate, whatever the opponent tries. World 1 awaits.",
});

export const WRONG_MOVE_MESSAGE = "Not that one! Follow the arrow.";
export const PLAN_COMPLETE_MESSAGE = "That's the whole plan. Hit Done!";

// Everything the coach can say, while planning or playing, including the nudges that replace
// its title. The coach is sized for the longest of each, so its height never changes.
export const COACH_TITLES = Object.freeze([
  ...PLANNING_COACH.map((coach) => coach.title), PLAYING_COACH.title, WRONG_MOVE_MESSAGE, PLAN_COMPLETE_MESSAGE,
]);
export const COACH_TEXTS = Object.freeze([...PLANNING_COACH.map((coach) => coach.text), PLAYING_COACH.text]);

const asUci = (move) => `${move.from}${move.to}${move.promotion ?? ""}`;

/**
 * Where the player is in the guided line: the premove to make next ({ from, to }, or null once
 * the line is complete) and what the coach says about it. `premoves` is the queued list.
 */
export function tutorialStep(premoves) {
  const count = Math.min(premoves.length, TUTORIAL_PUZZLE.solution_uci.length);
  const uci = TUTORIAL_PUZZLE.solution_uci[premoves.length] ?? null;
  return {
    index: count,
    next: uci ? { from: uci.slice(0, 2), to: uci.slice(2, 4) } : null,
    coach: PLANNING_COACH[count],
  };
}

/** Whether `move` is the one the tutorial asks for after `premoves`. */
export function isTutorialMove(premoves, move) {
  const queued = premoves.map(asUci);
  const onTrack = queued.every((uci, index) => uci === TUTORIAL_PUZZLE.solution_uci[index]);
  return onTrack && TUTORIAL_PUZZLE.solution_uci[queued.length] === asUci(move);
}

/**
 * Remembers whether the tutorial has been finished. Players who already won a level before
 * the tutorial existed count as done: they know the game. If storage can't be written, the
 * tutorial still counts as done for this visit, so a broken storage can't lock the game.
 */
export function createTutorialStore(storage = globalThis.localStorage, { progress } = {}) {
  let done = false;
  try {
    done = storage?.getItem(TUTORIAL_STORAGE_KEY) === "done";
  } catch {
    done = false; // unreadable: show the tutorial again, it's harmless
  }

  function isDone() {
    return done || (progress?.completedIds().length ?? 0) > 0;
  }

  function markDone() {
    done = true;
    try {
      storage?.setItem(TUTORIAL_STORAGE_KEY, "done");
    } catch (error) {
      throw new Error("Unable to save tutorial progress.", { cause: error });
    }
  }

  return Object.freeze({ isDone, markDone });
}
