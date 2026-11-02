import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationColor, annotationLayers, arrowGeometry, EMPTY_ANNOTATIONS, hasAnnotations,
  isKnightJump, squareCenter, toggleArrow, toggleHighlight,
} from "../src/game/annotations.js";

test("arrows default to orange, highlights to red, modifiers pick other colours", () => {
  assert.equal(annotationColor("arrow"), "orange");
  assert.equal(annotationColor("highlight"), "red");
  assert.equal(annotationColor("arrow", { shiftKey: true }), "green");
  assert.equal(annotationColor("arrow", { altKey: true }), "blue");
  assert.equal(annotationColor("highlight", { ctrlKey: true }), "red");
  assert.equal(annotationColor("arrow", { metaKey: true }), "red");
});

test("drawing the same arrow twice removes it; another colour recolours it", () => {
  let annotations = toggleArrow(EMPTY_ANNOTATIONS, "e2", "e4", "orange");
  assert.deepEqual(annotations.arrows, [{ from: "e2", to: "e4", color: "orange" }]);
  assert.ok(hasAnnotations(annotations));
  annotations = toggleArrow(annotations, "e2", "e4", "green");
  assert.deepEqual(annotations.arrows, [{ from: "e2", to: "e4", color: "green" }]);
  annotations = toggleArrow(annotations, "e4", "e2", "green");
  assert.equal(annotations.arrows.length, 2, "the reverse arrow is a different arrow");
  annotations = toggleArrow(annotations, "e2", "e4", "green");
  assert.deepEqual(annotations.arrows, [{ from: "e4", to: "e2", color: "green" }]);
  assert.equal(EMPTY_ANNOTATIONS.arrows.length, 0, "state is never mutated");
});

test("highlights toggle the same way", () => {
  let annotations = toggleHighlight(EMPTY_ANNOTATIONS, "d5", "red");
  annotations = toggleHighlight(annotations, "a1", "blue");
  assert.equal(annotations.highlights.length, 2);
  annotations = toggleHighlight(annotations, "d5", "red");
  assert.deepEqual(annotations.highlights, [{ square: "a1", color: "blue" }]);
  assert.equal(hasAnnotations(toggleHighlight(annotations, "a1", "blue")), false);
});

test("square centres put a8 top-left and h1 bottom-right", () => {
  assert.deepEqual(squareCenter("a8"), [0.5, 0.5]);
  assert.deepEqual(squareCenter("h1"), [7.5, 7.5]);
  assert.deepEqual(squareCenter("e4"), [4.5, 4.5]);
});

test("straight arrows run centre to centre with the head at the target", () => {
  const { shaft, head } = arrowGeometry("e2", "e4");
  assert.equal(shaft.length, 2);
  assert.deepEqual(shaft[0], squareCenter("e2"));
  assert.deepEqual(head[0], squareCenter("e4"));
  assert.ok(Math.abs(shaft[1][1] - (4.5 + 0.42)) < 1e-9, "the shaft stops where the head begins");
});

test("knight arrows bend into an L, long leg first", () => {
  assert.equal(isKnightJump("g1", "f3"), true);
  assert.equal(isKnightJump("b1", "d2"), true);
  assert.equal(isKnightJump("a1", "c3"), false);
  const tall = arrowGeometry("g1", "f3");
  assert.equal(tall.shaft.length, 3);
  assert.deepEqual(tall.shaft[1], [6.5, 5.5], "up two from g1 first, then across to f3");
  const wide = arrowGeometry("b1", "d2");
  assert.deepEqual(wide.shaft[1], [3.5, 7.5], "across two from b1 first, then up to d2");
  assert.deepEqual(wide.head[0], squareCenter("d2"));
});

test("layers render highlights and arrows, plus the arrow being dragged", () => {
  const annotations = toggleHighlight(toggleArrow(EMPTY_ANNOTATIONS, "e2", "e4", "orange"), "d5", "red");
  const layers = annotationLayers(annotations, { from: "g1", to: "f3", color: "green" });
  assert.equal((layers.highlights.match(/<rect /g) ?? []).length, 1);
  assert.equal((layers.arrows.match(/<g /g) ?? []).length, 2);
  assert.match(layers.arrows, /#9fcf3f/);
  assert.equal(annotationLayers(annotations, { from: "g1", to: "g1", color: "green" }).arrows.match(/<g /g).length, 1,
    "no preview arrow while the pointer is still on the starting square");
  assert.doesNotMatch(layers.highlights, /data-square/, "must not be mistaken for a board square");
});
