// Board annotations, chess.com style: right-click and drag between two squares draws an
// arrow, right-click a single square highlights it. Drawing the same thing again removes it.
// Hold Shift, Ctrl/Cmd or Alt while right-clicking for other colours.
//
// Pure helpers only: state in, new state or SVG markup out (the board is White at the bottom).

const FILES = "abcdefgh";

export const ANNOTATION_COLORS = Object.freeze({
  orange: "#ffaa00",
  red: "#eb6150",
  green: "#9fcf3f",
  blue: "#52b0dc",
});

export const EMPTY_ANNOTATIONS = Object.freeze({ arrows: Object.freeze([]), highlights: Object.freeze([]) });

// Arrows default to orange and highlights to red, as on chess.com; modifiers pick a colour.
export function annotationColor(kind, { shiftKey = false, ctrlKey = false, metaKey = false, altKey = false } = {}) {
  if (shiftKey) return "green";
  if (altKey) return "blue";
  if (ctrlKey || metaKey) return "red";
  return kind === "arrow" ? "orange" : "red";
}

export function hasAnnotations(annotations) {
  return annotations.arrows.length > 0 || annotations.highlights.length > 0;
}

// Same arrow in the same colour: remove it. Same arrow in another colour: recolour it.
export function toggleArrow(annotations, from, to, color) {
  const existing = annotations.arrows.find((arrow) => arrow.from === from && arrow.to === to);
  const others = annotations.arrows.filter((arrow) => arrow !== existing);
  return {
    ...annotations,
    arrows: existing?.color === color ? others : [...others, { from, to, color }],
  };
}

export function toggleHighlight(annotations, square, color) {
  const existing = annotations.highlights.find((highlight) => highlight.square === square);
  const others = annotations.highlights.filter((highlight) => highlight !== existing);
  return {
    ...annotations,
    highlights: existing?.color === color ? others : [...others, { square, color }],
  };
}

// Square centre in board units: (0,0) is a8's top-left corner, each square is 1×1.
export function squareCenter(square) {
  return [FILES.indexOf(square[0]) + 0.5, 8 - Number(square[1]) + 0.5];
}

export function isKnightJump(from, to) {
  const dx = Math.abs(FILES.indexOf(to[0]) - FILES.indexOf(from[0]));
  const dy = Math.abs(Number(to[1]) - Number(from[1]));
  return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
}

const SHAFT_WIDTH = 0.2;
const HEAD_WIDTH = 0.5;
const HEAD_LENGTH = 0.42;

// The arrow's path: a straight line, or an L for a knight jump (long leg first, like chess.com).
// Returns the shaft polyline (ending where the head starts) and the head triangle.
export function arrowGeometry(from, to) {
  const start = squareCenter(from);
  const tip = squareCenter(to);
  const corner = isKnightJump(from, to)
    ? (Math.abs(tip[1] - start[1]) === 2 ? [start[0], tip[1]] : [tip[0], start[1]])
    : null;
  const lastStart = corner ?? start;
  const length = Math.hypot(tip[0] - lastStart[0], tip[1] - lastStart[1]);
  const direction = [(tip[0] - lastStart[0]) / length, (tip[1] - lastStart[1]) / length];
  const normal = [-direction[1], direction[0]];
  const base = [tip[0] - direction[0] * HEAD_LENGTH, tip[1] - direction[1] * HEAD_LENGTH];
  const half = HEAD_WIDTH / 2;
  return {
    shaft: corner ? [start, corner, base] : [start, base],
    head: [
      tip,
      [base[0] + normal[0] * half, base[1] + normal[1] * half],
      [base[0] - normal[0] * half, base[1] - normal[1] * half],
    ],
  };
}

const formatPoints = (points) => points.map(([x, y]) => `${+x.toFixed(4)},${+y.toFixed(4)}`).join(" ");

function arrowSvg({ from, to, color }) {
  const { shaft, head } = arrowGeometry(from, to);
  const fill = ANNOTATION_COLORS[color] ?? ANNOTATION_COLORS.orange;
  // group opacity, so the shaft and head don't darken where they meet
  return `<g class="annotation-arrow" opacity="0.8" data-from="${from}" data-to="${to}">`
    + `<polyline points="${formatPoints(shaft)}" fill="none" stroke="${fill}" stroke-width="${SHAFT_WIDTH}" stroke-linejoin="miter" stroke-linecap="butt"/>`
    + `<polygon points="${formatPoints(head)}" fill="${fill}"/>`
    + "</g>";
}

function highlightSvg({ square, color }) {
  const [x, y] = squareCenter(square);
  const fill = ANNOTATION_COLORS[color] ?? ANNOTATION_COLORS.red;
  return `<rect class="annotation-highlight" data-highlight="${square}" x="${x - 0.5}" y="${y - 0.5}" width="1" height="1" fill="${fill}" opacity="0.8"/>`;
}

// SVG contents for the two layers: highlights sit under the pieces, arrows over them.
// Like chess.com, an arrow only appears once the right button is released.
export function annotationLayers(annotations) {
  return {
    highlights: annotations.highlights.map(highlightSvg).join(""),
    arrows: annotations.arrows.map(arrowSvg).join(""),
  };
}
