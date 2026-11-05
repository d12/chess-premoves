// The game's structure: worlds ("stages"), each with an ordered run of levels. stages.json
// holds each world's display data (name, theme, mascot); its levels are the entries of
// puzzles.json whose ids start with the world's id ("2-1", "2-2", …), in level order. Level
// ids are "<stage>-<level>" ("2-3" is the third level of the second stage); progress is
// keyed by these ids and levels unlock in reading order.
import STAGE_DATA from "./stages.json" with { type: "json" };
import { parseLevelId, PUZZLES } from "./puzzles.js";

export const STAGES = Object.freeze(STAGE_DATA.map((stage) => {
  const levels = PUZZLES
    .filter((puzzle) => String(parseLevelId(puzzle.id)?.world) === stage.id)
    .sort((a, b) => parseLevelId(a.id).level - parseLevelId(b.id).level)
    .map((puzzle) => Object.freeze({
      id: puzzle.id,
      stageId: stage.id,
      number: parseLevelId(puzzle.id).level,
      puzzle,
    }));
  return Object.freeze({
    id: stage.id,
    name: stage.name,
    tagline: stage.tagline,
    theme: stage.theme,
    piece: stage.piece,
    levels: Object.freeze(levels),
  });
}));

/** Every level in play order: 1-1 … 1-5, 2-1 … */
export const LEVELS = Object.freeze(STAGES.flatMap((stage) => stage.levels));

export function getStage(id) {
  const stage = STAGES.find((candidate) => candidate.id === String(id));
  if (!stage) {
    throw new RangeError(`Unknown stage: ${id}`);
  }
  return stage;
}

export function getLevel(id) {
  const level = LEVELS.find((candidate) => candidate.id === String(id));
  if (!level) {
    throw new RangeError(`Unknown level: ${id}`);
  }
  return level;
}

/** The level after `id` in play order (possibly in the next stage), or null after the last. */
export function nextLevel(id) {
  const index = LEVELS.findIndex((level) => level.id === String(id));
  if (index === -1) {
    throw new RangeError(`Unknown level: ${id}`);
  }
  return LEVELS[index + 1] ?? null;
}

/** The stage after `id`, or null after the last. */
export function nextStage(id) {
  const index = STAGES.findIndex((stage) => stage.id === String(id));
  if (index === -1) {
    throw new RangeError(`Unknown stage: ${id}`);
  }
  return STAGES[index + 1] ?? null;
}
