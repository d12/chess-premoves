// Checks src/game/stages.json: the world/level layout the index is built from.
import assert from "node:assert/strict";
import test from "node:test";
import { PUZZLES } from "../src/game/puzzles.js";
import { getLevel, getStage, LEVELS, nextLevel, nextStage, STAGES } from "../src/game/stages.js";

const THEMES = ["meadow", "forest", "desert", "frost", "volcano"]; // styled in style.css

test("there are 5 stages of 5 levels, numbered in order", () => {
  assert.equal(STAGES.length, 5);
  STAGES.forEach((stage, index) => {
    assert.equal(stage.id, String(index + 1));
    assert.equal(stage.levels.length, 5, `stage ${stage.id}`);
    stage.levels.forEach((level, levelIndex) => {
      assert.equal(level.id, `${stage.id}-${levelIndex + 1}`);
      assert.equal(level.stageId, stage.id);
      assert.equal(level.number, levelIndex + 1);
    });
  });
  assert.equal(LEVELS.length, 25);
  assert.equal(new Set(LEVELS.map((level) => level.id)).size, 25, "level ids are unique");
});

test("every stage has display fields and a styled theme", () => {
  for (const stage of STAGES) {
    for (const field of ["name", "tagline"]) {
      assert.ok(typeof stage[field] === "string" && stage[field].length > 0, `stage ${stage.id} ${field}`);
    }
    assert.ok(THEMES.includes(stage.theme), `stage ${stage.id} theme ${stage.theme}`);
    assert.match(stage.piece, /^[pnbrqk]$/, `stage ${stage.id} piece`);
  }
  assert.equal(new Set(STAGES.map((stage) => stage.theme)).size, STAGES.length, "each stage looks different");
});

test("every level points at a real puzzle, and every puzzle is a level", () => {
  for (const level of LEVELS) {
    assert.ok(PUZZLES.includes(level.puzzle), `level ${level.id}`);
    assert.equal(level.puzzle.id, level.id, `level ${level.id} uses the puzzle with its own id`);
  }
  assert.equal(LEVELS.length, PUZZLES.length, "no puzzle belongs to a world that doesn't exist");
});

test("lookups and next-level navigation follow play order", () => {
  assert.equal(getLevel("2-3").puzzle.id, "2-3", "each level uses its own puzzles.json entry");
  assert.equal(getStage(4).name, STAGES[3].name);
  assert.equal(nextLevel("1-4").id, "1-5");
  assert.equal(nextLevel("1-5").id, "2-1", "the last level leads into the next stage");
  assert.equal(nextLevel("5-5"), null);
  assert.equal(nextStage("4").id, "5");
  assert.equal(nextStage("5"), null);
  assert.throws(() => getLevel("6-1"), /Unknown level/);
  assert.throws(() => getStage("0"), /Unknown stage/);
});
