import { burst, cannons, PALETTES } from "./effects/confetti.js";
import { ARRANGEMENTS, createMusicPlayer, SCENES } from "./effects/music.js";
import { createSoundPlayer, SOUND_NAMES, soundForMove } from "./effects/sound.js";
import { createPremoveOpponent, loadPremoveEngine } from "./engine/premoveOpponent.js";
import {
  annotationColor, annotationLayers, EMPTY_ANNOTATIONS, hasAnnotations, toggleArrow, toggleHighlight,
} from "./game/annotations.js";
import { boardRows, parsePlacement } from "./game/premoveRules.js";
import { createPremoveGame } from "./game/session.js";
import { createProgressStore } from "./game/progress.js";
import { getLevel, getStage, LEVELS, nextLevel, nextStage, STAGES } from "./game/stages.js";
import { renderScene, THEME_CONFETTI } from "./ui/scenery.js";
import "@fontsource/lilita-one/latin-400.css";
import "./style.css";
import "./ui/worlds.css";

const app = document.querySelector("#app");
// Effects and music share one AudioContext; the music ducks under fanfares. In development
// every sound is also logged to window.__soundLog for headless tests.
let music = null;
const sounds = createSoundPlayer({
  onPlay(name, details) {
    if (!details.muted) {
      music?.duck(name);
    }
    if (import.meta.env.DEV) {
      (window.__soundLog ??= []).push({ name, at: Math.round(performance.now()), ...details });
    }
  },
  keepAwake: () => Boolean(music?.isPlaying()),
});
music = createMusicPlayer({ audio: sounds.audio });
if (import.meta.env.DEV) {
  window.__music = music; // for headless tests: state(), isPlaying()
}
const files = "abcdefgh";
const pieceSymbols = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};
const pieceImages = import.meta.glob("./assets/pieces/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});
const pieceNames = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};

const state = {
  screen: "loading",
  engine: null,
  error: null,
  progressStore: null,
  stage: null, // the stage whose level map is open (screen "stage")
  level: null, // the level being played (screen "puzzle"); state.puzzle is level.puzzle
  // What the last win changed, played as animations the next time the map shows it:
  // unlockedLevel/hopFrom (stage map), clearedStage (stage map), unlockedStage (world map).
  fresh: { unlockedLevel: null, hopFrom: null, clearedStage: null, unlockedStage: null },
  transitioning: false,
  musicPreview: null, // development sound board: { world, scene } to audition
  puzzle: null,
  session: null,
  snapshot: null,
  selectedSquare: null,
  promotionRequest: null,
  pendingPieceMove: null,
  pendingCelebration: null,
  revealOutcome: false,
  // right-click arrows and highlights; drawingArrow is where a right-drag started
  annotations: EMPTY_ANNOTATIONS,
  drawingArrow: null,
  interactionError: "",
  progressError: "",
  executionError: "",
};

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function renderPiece(color, type) {
  const image = pieceImages[`./assets/pieces/${color}${type}.png`];
  const content = image
    ? `<img src="${escapeHTML(image)}" alt="" draggable="false" />`
    : pieceSymbols[color][type];
  return `<span class="piece ${color === "w" ? "white-piece" : "black-piece"}" aria-hidden="true">${content}</span>`;
}

function renderHeader() {
  const engineStatus = state.engine ? "ENGINE READY" : "ENGINE SETUP";
  const showStars = state.engine && state.progressStore;
  const stars = showStars ? state.progressStore.perfectedIds().length : 0;
  return `
    <header class="topbar">
      <button class="brand" type="button" data-action="home" aria-label="Go to world map" ${state.engine ? "" : "disabled"}>
        <span class="brand-mark" aria-hidden="true">♞</span>
        <span>PREMOVE</span>
      </button>
      <span class="topbar-status">
        ${showStars ? `<span class="star-counter ${stars ? "has-stars" : ""}" title="Perfect solves" aria-label="${stars} of ${LEVELS.length} levels perfected"><span aria-hidden="true">★</span> ${stars}<small>/${LEVELS.length}</small></span>` : ""}
        ${renderMusicToggle()}
        ${renderSoundToggle()}
        <span class="engine-pill ${state.engine ? "is-ready" : ""}">
          <span class="status-dot"></span>${engineStatus}
        </span>
      </span>
    </header>
  `;
}

const SPEAKER = '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor"/>';
function renderSoundToggle() {
  const muted = sounds.isMuted();
  const waves = muted
    ? '<path d="M15.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    : '<path d="M15.2 9.2a4 4 0 0 1 0 5.6M17.8 6.6a7.6 7.6 0 0 1 0 10.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  return `<button class="icon-toggle sound-toggle ${muted ? "is-muted" : ""}" type="button" data-action="toggle-sound" aria-pressed="${!muted}" aria-label="Sound effects" title="${muted ? "Sound off" : "Sound on"} (M)">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SPEAKER}${waves}</svg>
  </button>`;
}

const NOTE_ICON = '<path d="M9 17.5V6.5l10-2v11" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.6" cy="17.6" r="2.6" fill="currentColor"/><circle cx="16.6" cy="15.6" r="2.6" fill="currentColor"/>';
function renderMusicToggle() {
  const muted = music.isMuted();
  const slash = muted ? '<path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' : "";
  return `<button class="icon-toggle music-toggle ${muted ? "is-muted" : ""}" type="button" data-action="toggle-music" aria-pressed="${!muted}" aria-label="Music" title="Music ${muted ? "off" : "on"}">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${NOTE_ICON}${slash}</svg>
  </button>`;
}

function toggleMusic() {
  music.start(); // in case this click is the first gesture
  const muted = music.toggleMuted();
  const toggle = app.querySelector(".music-toggle");
  if (toggle) {
    toggle.outerHTML = renderMusicToggle();
  }
  if (muted && sounds.isMuted()) {
    sounds.setMuted(true); // nothing left to play: let the AudioContext sleep
  }
  sounds.play("click");
}

// Which arrangement and layers the music plays: the world being played (on the world map,
// the world you're up to), full band on maps, a thinking texture while planning, bongos
// while a line plays out.
function musicTarget() {
  if (state.screen === "sounds" && state.musicPreview) {
    return state.musicPreview;
  }
  let world = "meadow";
  if ((state.screen === "stage" || state.screen === "puzzle") && state.stage) {
    world = state.stage.theme;
  } else if (state.progressStore) {
    const next = currentLevel();
    world = next ? getStage(next.stageId).theme : STAGES.at(-1).theme;
  }
  let scene = "map";
  if (state.screen === "puzzle" && state.snapshot) {
    const { phase, outcome } = state.snapshot;
    scene = phase === "planning" ? "planning"
      : phase === "playing" ? "playing"
        : outcome === "victory" ? "map" : "planning";
  }
  return { world, scene };
}

// Toggled without a full re-render, so map animations in progress aren't cut short.
function toggleSound() {
  const muted = sounds.toggleMuted();
  const toggle = app.querySelector(".sound-toggle");
  if (toggle) {
    toggle.outerHTML = renderSoundToggle();
  }
  if (!muted) {
    sounds.play("click");
  }
}

function renderLoading() {
  return `
    ${renderHeader()}
    <main class="setup-screen">
      <div class="setup-emblem" aria-hidden="true">♞</div>
      <p class="eyebrow">One moment before the first move</p>
      <h1>Preparing your opponent</h1>
      <p class="setup-copy">The opponent reads your whole premove plan and looks for the defence that beats it.</p>
    </main>
  `;
}

function renderError() {
  const description = state.error?.message ?? "The app could not be initialized.";
  return `
    ${renderHeader()}
    <main class="setup-screen">
      <div class="setup-emblem error-emblem" aria-hidden="true">!</div>
      <p class="eyebrow">Setup needs attention</p>
      <h1>We couldn't start the game</h1>
      <p class="setup-copy">${escapeHTML(description)}</p>
      <button class="primary-button" type="button" data-action="retry-setup">Try again</button>
      <p class="setup-footnote">Check that browser storage is available, then retry.</p>
    </main>
  `;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const LOCK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.5 10.5V7.5a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><rect x="4" y="10" width="16" height="11.5" rx="3.2" fill="currentColor"/><circle cx="12" cy="15.4" r="1.7" fill="var(--lock-hole, #0004)"/></svg>`;

function pieceImage(color, type) {
  return pieceImages[`./assets/pieces/${color}${type}.png`];
}

function stageProgress(stage) {
  const store = state.progressStore;
  const completed = stage.levels.filter((level) => store.isCompleted(level.id)).length;
  const perfected = stage.levels.filter((level) => store.isPerfected(level.id)).length;
  return {
    completed,
    perfected,
    total: stage.levels.length,
    cleared: completed === stage.levels.length,
    unlocked: store.isStageUnlocked(stage.id),
  };
}

/** The first playable level that hasn't been beaten yet: where "continue" goes. */
function currentLevel(levels = LEVELS) {
  return levels.find((level) => state.progressStore.isUnlocked(level.id) && !state.progressStore.isCompleted(level.id)) ?? null;
}

function renderPips(stage, className = "") {
  return `<span class="pips ${className}" aria-hidden="true">${stage.levels.map((level) => {
    const status = state.progressStore.isPerfected(level.id) ? "is-perfect"
      : state.progressStore.isCompleted(level.id) ? "is-complete" : "";
    return `<span class="pip ${status}"></span>`;
  }).join("")}</span>`;
}

function renderLandmark(stage) {
  const image = pieceImage("w", stage.piece);
  return `<span class="landmark" aria-hidden="true">${image
    ? `<img src="${escapeHTML(image)}" alt="" draggable="false" />`
    : `<span class="landmark-glyph">${pieceSymbols.w[stage.piece]}</span>`}</span>`;
}

function renderWorldCard(stage, index) {
  const progress = stageProgress(stage);
  const previous = STAGES[index - 1];
  // A world that the last win just opened is drawn locked, then unlocked by an animation.
  const fresh = progress.unlocked && state.fresh.unlockedStage === stage.id;
  const locked = !progress.unlocked || fresh;
  const allPerfect = progress.perfected === progress.total;
  const current = progress.unlocked && !progress.cleared;
  const status = !progress.unlocked ? `Clear World ${previous?.id} to open`
    : progress.cleared ? (allPerfect ? "Every level perfect" : "World cleared")
      : progress.completed === 0 ? "New world" : `${progress.completed} of ${progress.total} levels`;
  const classes = [
    "world-card",
    locked ? "is-locked" : "",
    current ? "is-current" : "",
    progress.cleared ? "is-cleared" : "",
    progress.cleared && allPerfect ? "is-perfected" : "",
  ].join(" ");
  const clickable = progress.unlocked || import.meta.env.DEV;
  return `
    <li class="world-slot ${progress.unlocked ? "is-open" : ""}" style="--i: ${index}">
      <button
        class="${classes}"
        type="button"
        data-theme="${stage.theme}"
        data-action="open-stage"
        data-stage-id="${stage.id}"
        ${fresh ? 'data-fresh="unlock-world"' : ""}
        ${clickable ? "" : "disabled"}
        aria-label="World ${stage.id}, ${escapeHTML(stage.name)}: ${status}${!progress.unlocked && import.meta.env.DEV ? " (development: click to open)" : ""}"
      >
        <span class="world-scene" style="view-transition-name: world-scene-${stage.id}">
          ${renderScene(stage.theme)}
          ${renderLandmark(stage)}
          <span class="world-lock">${LOCK_ICON}</span>
          ${progress.cleared ? `<span class="world-ribbon">${allPerfect ? "★ Perfect" : "Cleared"}</span>` : ""}
        </span>
        <span class="world-info">
          <span class="world-number">World ${stage.id}</span>
          <span class="world-name">${escapeHTML(stage.name)}</span>
          <span class="world-meta">
            ${renderPips(stage)}
            <span class="world-status">${status}</span>
          </span>
        </span>
      </button>
    </li>
  `;
}

function renderWorldMap() {
  const completedCount = state.progressStore.completedIds().length;
  const perfectedCount = state.progressStore.perfectedIds().length;
  const next = currentLevel();
  const finished = completedCount === LEVELS.length;
  const cards = STAGES.map(renderWorldCard).join("");
  state.fresh.unlockedStage = null; // consumed: the card above carries data-fresh

  return `
    ${renderHeader()}
    <main class="world-screen">
      <section class="world-hero">
        <div class="world-hero-copy">
          <h1>Pick a world</h1>
          <p>Five worlds, five levels each. Clear every level in a world to open the next one.</p>
        </div>
        <div class="world-hero-side">
          <div class="journey" aria-label="${completedCount} of ${LEVELS.length} levels cleared, ${perfectedCount} perfect">
            <span class="journey-count"><strong>${completedCount}</strong>/${LEVELS.length} levels</span>
            <span class="journey-bar" aria-hidden="true"><span style="width: ${(completedCount / LEVELS.length) * 100}%"></span></span>
          </div>
          ${next ? `
            <button class="game-button continue-button" type="button" data-action="open-level" data-level-id="${next.id}" data-theme="${getStage(next.stageId).theme}">
              <span class="continue-label">${completedCount === 0 ? "Start" : "Continue"}</span>
              <span class="continue-level">Level ${next.id}</span>
            </button>
          ` : ""}
          ${finished ? `<p class="journey-done">${perfectedCount === LEVELS.length ? "Every level perfected. Flawless." : `All worlds cleared. ${LEVELS.length - perfectedCount} levels left to perfect.`}</p>` : ""}
        </div>
      </section>
      <ol class="world-row" aria-label="Worlds">${cards}</ol>
      <p class="unlock-note">Solve a level in the fewest possible premoves to perfect it and earn its <span class="perfect-star" aria-hidden="true">★</span></p>
      ${import.meta.env.DEV ? '<p class="unlock-note">Development: locked worlds and levels open when clicked, for this session only. <button class="text-button dev-link" type="button" data-action="sound-board">Open the sound board</button></p>' : ""}
      <footer class="app-footer">Chess rules by chess.js · Opponent searches every reply to your premoves</footer>
    </main>
  `;
}

// Where the five level nodes sit on a stage map, in % of the map: a wide layout and a tall
// one for narrow screens. The trail is drawn through the same points.
const MAP_LAYOUTS = {
  wide: [[9, 72], [29, 47], [50, 71], [71, 46], [89, 66]],
  tall: [[24, 86], [72, 72], [32, 56], [70, 39], [32, 22]],
};

// Development only: every sound effect on one page, for tuning by ear.
const SOUND_GROUPS = [
  ["Planning", ["premove", "undo", "illegal", "submit"]],
  ["Playback", ["move", "capture", "check", "castle", "promote", "mate"]],
  ["Results", ["win", "perfect", "poppers", "defeat", "draw"]],
  ["Menus and maps", ["click", "open", "back", "lock", "pop", "trail", "hop", "flag", "stamp", "unlock-world"]],
];

function renderSoundBoard() {
  const listed = SOUND_GROUPS.flatMap(([, names]) => names);
  const missing = SOUND_NAMES.filter((name) => !listed.includes(name));
  const groups = [...SOUND_GROUPS, ...(missing.length ? [["Other", missing]] : [])];
  return `
    ${renderHeader()}
    <main class="sound-board">
      <button class="back-button" type="button" data-action="home"><span aria-hidden="true">←</span> All worlds</button>
      <h1>Sound board</h1>
      <p class="sound-board-copy">Every effect, synthesized live by <code>src/effects/sound.js</code>. Board sounds also have an opponent variant.${sounds.isMuted() ? " Sound is muted: press M to hear them." : ""}</p>
      <section>
        <h2>Music</h2>
        <p class="sound-board-copy">Each world's arrangement of the theme (<code>src/effects/music.js</code>), and the layers each screen uses. Picking a world restarts the tune.${music.isMuted() ? " Music is off: use the note button above." : ""}</p>
        <div class="sound-board-grid">
          ${Object.keys(ARRANGEMENTS).map((world) => `<button class="secondary-button ${state.musicPreview?.world === world ? "is-current" : ""}" type="button" data-action="music-preview" data-world="${world}">${world}</button>`).join("")}
        </div>
        <div class="sound-board-grid">
          ${Object.keys(SCENES).map((scene) => `<button class="secondary-button ${state.musicPreview?.scene === scene ? "is-current" : ""}" type="button" data-action="music-preview" data-scene="${scene}">${scene}</button>`).join("")}
        </div>
      </section>
      ${groups.map(([title, names]) => `
        <section>
          <h2>${title}</h2>
          <div class="sound-board-grid">
            ${names.map((name) => `<button class="secondary-button" type="button" data-action="play-sound" data-sound="${name}">${name}</button>`).join("")}
            ${title === "Playback" ? names.map((name) => `<button class="secondary-button is-opponent" type="button" data-action="play-sound" data-sound="${name}" data-opponent="true">${name} · opponent</button>`).join("") : ""}
          </div>
        </section>
      `).join("")}
    </main>
  `;
}

function trailSegment(points, index) {
  // Catmull-Rom through the nodes, as one cubic Bézier per segment
  const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  const [p0, p1, p2, p3] = [at(index - 1), at(index), at(index + 1), at(index + 2)];
  const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
  const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
  return `M${p1[0]} ${p1[1]} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
}

function renderTrail(stage, layout, freshIndex) {
  const points = MAP_LAYOUTS[layout];
  const segments = points.slice(0, -1).map((_, index) => {
    const d = trailSegment(points, index);
    const lit = state.progressStore.isCompleted(stage.levels[index].id);
    return `<path class="trail-bed" d="${d}" vector-effect="non-scaling-stroke"/>${lit
      ? `<path class="trail-lit" d="${d}" vector-effect="non-scaling-stroke" ${index === freshIndex ? 'data-fresh="draw"' : ""}/>`
      : `<path class="trail-dots" d="${d}" vector-effect="non-scaling-stroke"/>`}`;
  }).join("");
  return `<svg class="trail trail-${layout}" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">${segments}</svg>`;
}

const mapPosition = (index) => {
  const [x, y] = MAP_LAYOUTS.wide[index];
  const [mx, my] = MAP_LAYOUTS.tall[index];
  return `--x: ${x}; --y: ${y}; --mx: ${mx}; --my: ${my};`;
};

function renderLevelNode(level, index, { freshUnlock }) {
  const store = state.progressStore;
  const unlocked = store.isUnlocked(level.id);
  const completed = store.isCompleted(level.id);
  const perfected = store.isPerfected(level.id);
  const fresh = freshUnlock === level.id;
  const status = !unlocked ? (import.meta.env.DEV ? "locked, click to unlock" : "locked")
    : perfected ? "perfected" : completed ? "completed" : "ready to play";
  const stateClass = !unlocked ? "is-locked" : perfected ? "is-perfect" : completed ? "is-complete" : "is-ready";
  return `
    <li class="map-pin node-pin" style="${mapPosition(index)}">
      <button
        class="level-node ${stateClass}"
        type="button"
        data-action="open-level"
        data-level-id="${level.id}"
        ${fresh ? 'data-fresh="unlock-level"' : ""}
        ${unlocked || import.meta.env.DEV ? "" : "disabled"}
        aria-label="Level ${level.id}, ${status}"
        title="Level ${level.id}${unlocked ? `: ${escapeHTML(level.puzzle.title)}` : ""}"
      >
        <span class="node-face">
          <span class="node-number">${level.number}</span>
          <span class="node-lock">${LOCK_ICON}</span>
        </span>
        ${perfected ? '<span class="node-badge is-star" aria-hidden="true">★</span>'
          : completed ? '<span class="node-badge is-check" aria-hidden="true">✓</span>' : ""}
      </button>
    </li>
  `;
}

function renderStage() {
  const stage = state.stage;
  const progress = stageProgress(stage);
  const freshUnlock = state.fresh.unlockedLevel && getLevel(state.fresh.unlockedLevel).stageId === stage.id
    ? state.fresh.unlockedLevel : null;
  const hopFrom = freshUnlock ? state.fresh.hopFrom : null;
  const freshClear = state.fresh.clearedStage === stage.id;
  if (freshUnlock) {
    state.fresh.unlockedLevel = null;
    state.fresh.hopFrom = null;
  }
  if (freshClear) {
    state.fresh.clearedStage = null;
  }
  const freshIndex = freshUnlock ? stage.levels.findIndex((level) => level.id === freshUnlock) - 1 : -1;
  const next = currentLevel(stage.levels);
  // the stage's piece stands on the level to play next, or on the goal once the stage is clear
  const tokenLevel = next ?? (progress.cleared ? stage.levels.at(-1) : null);
  const tokenIndex = tokenLevel ? stage.levels.indexOf(tokenLevel) : -1;
  const hopIndex = hopFrom ? stage.levels.findIndex((level) => level.id === hopFrom) : -1;
  const tokenImage = pieceImage("w", stage.piece);
  const following = nextStage(stage.id);
  const allPerfect = progress.perfected === progress.total;

  let footer;
  if (!progress.unlocked) {
    footer = `<p class="stage-footer-copy">Clear every level of World ${STAGES[STAGES.indexOf(stage) - 1].id} to open this world.</p>`;
  } else if (progress.cleared) {
    footer = `
      <div class="stage-footer-copy">
        <strong>${allPerfect ? "World perfected" : "World cleared"}</strong>
        <span>${allPerfect ? "Every level solved in the fewest premoves." : `★ ${progress.perfected} of ${progress.total} perfect. Replay a level in fewer premoves to perfect it.`}</span>
      </div>
      <button class="game-button" type="button" data-action="home">${following ? `On to World ${following.id}` : "World map"}</button>
    `;
  } else if (next) {
    footer = `
      <div class="stage-footer-copy">
        <strong>Next up: level ${next.id}</strong>
        <span>${escapeHTML(next.puzzle.title)}</span>
      </div>
      <button class="game-button" type="button" data-action="open-level" data-level-id="${next.id}">Play level ${next.id}</button>
    `;
  } else {
    footer = '<p class="stage-footer-copy">Pick any open level to play.</p>';
  }

  return `
    ${renderHeader()}
    <main class="stage-screen" data-theme="${stage.theme}">
      <div class="stage-heading">
        <button class="back-button" type="button" data-action="home"><span aria-hidden="true">←</span> All worlds</button>
        <div class="stage-title-row">
          <div class="stage-title">
            <p class="world-number">World ${stage.id}</p>
            <h1>${escapeHTML(stage.name)}</h1>
            <p class="stage-tagline">${escapeHTML(stage.tagline)}</p>
          </div>
          <div class="stage-score" aria-label="${progress.completed} of ${progress.total} levels cleared, ${progress.perfected} perfect">
            ${renderPips(stage, "is-large")}
            <span>${progress.completed}/${progress.total} cleared${progress.perfected ? ` · <span class="perfect-count">★ ${progress.perfected}</span>` : ""}</span>
          </div>
        </div>
      </div>
      <section class="stage-map ${progress.unlocked ? "" : "is-locked"}" style="view-transition-name: world-scene-${stage.id}" aria-label="Levels of ${escapeHTML(stage.name)}">
        ${renderScene(stage.theme, { wide: true })}
        ${renderTrail(stage, "wide", freshIndex)}
        ${renderTrail(stage, "tall", freshIndex)}
        <ol class="level-nodes">${stage.levels.map((level, index) => renderLevelNode(level, index, { freshUnlock })).join("")}</ol>
        <span class="map-pin goal-pin" style="${mapPosition(stage.levels.length - 1)}" aria-hidden="true">
          <span class="goal-flag ${progress.cleared ? "is-raised" : ""}" ${freshClear ? 'data-fresh="raise-flag"' : ""}>
            <span class="flag-pole"></span><span class="flag-cloth">★</span>
          </span>
        </span>
        ${tokenIndex >= 0 && tokenImage ? `
          <span class="map-pin token-pin" style="${mapPosition(hopIndex >= 0 ? hopIndex : tokenIndex)}" ${hopIndex >= 0 ? `data-fresh="hop" data-hop-to="${tokenIndex}"` : ""} aria-hidden="true">
            <span class="token"><img src="${escapeHTML(tokenImage)}" alt="" draggable="false" /></span>
          </span>
        ` : ""}
        ${progress.cleared ? `<span class="stage-ribbon ${allPerfect ? "is-perfect" : ""}" ${freshClear ? 'data-fresh="stamp"' : ""}>${allPerfect ? "★ Perfect!" : "World clear!"}</span>` : ""}
      </section>
      <div class="stage-footer">${footer}</div>
    </main>
  `;
}

function renderBoard(fen, premoves, lastMove, selectedSquare, legalTargets) {
  const board = boardRows(fen); // planning previews may not be legal chess positions
  const premoveSquares = new Set(premoves.flatMap((move) => [move.from, move.to]));
  const lastMoveSquares = new Set(lastMove ? [lastMove.from, lastMove.to] : []);
  const legalTargetSquares = new Set(legalTargets);
  const playerColor = state.snapshot.playerColor;
  const squares = [];

  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const piece = board[row][column];
      const square = `${files[column]}${8 - row}`;
      const isLight = (row + column) % 2 === 0;
      const isSelected = selectedSquare === square;
      const isPremove = premoveSquares.has(square);
      const isLastMove = lastMoveSquares.has(square);
      const isLegalTarget = legalTargetSquares.has(square);
      const isMated = state.snapshot.matedKing === square;
      const pieceLabel = piece
        ? `${piece.color === "w" ? "white" : "black"} ${pieceNames[piece.type]}`
        : "empty";
      const canDrag = state.snapshot.phase === "planning"
        && piece?.color === playerColor;
      const rankLabel = column === 0
        ? `<span class="coordinate rank-coordinate">${8 - row}</span>`
        : "";
      const fileLabel = row === 7
        ? `<span class="coordinate file-coordinate">${files[column]}</span>`
        : "";

      squares.push(`
        <button
          class="square ${isLight ? "light-square" : "dark-square"} ${isSelected ? "is-selected" : ""} ${isPremove ? "is-premove" : ""} ${isLastMove ? "is-last-move" : ""} ${isLegalTarget ? "is-legal-target" : ""} ${isMated ? "is-mated" : ""}"
          type="button"
          data-square="${square}"
          aria-label="${square}, ${pieceLabel}${isLegalTarget ? ", legal destination" : ""}${isMated ? ", checkmated" : ""}"
          ${canDrag ? 'draggable="true"' : ""}
        >
          ${piece ? renderPiece(piece.color, piece.type) : ""}
          ${rankLabel}
          ${fileLabel}
        </button>
      `);
    }
  }
  const layers = annotationLayers(state.annotations);
  return `<div class="board" role="group" aria-label="Chessboard">
    <svg class="board-highlights" viewBox="0 0 8 8" aria-hidden="true">${layers.highlights}</svg>
    ${squares.join("")}
    <svg class="board-arrows" viewBox="0 0 8 8" aria-hidden="true">${layers.arrows}</svg>
  </div>`;
}

function renderPromotionDialog() {
  if (!state.promotionRequest) {
    return "";
  }
  const playerColor = state.snapshot.playerColor;
  const options = state.promotionRequest.options.map((option) => `
    <button class="promotion-choice" type="button" data-action="choose-promotion" data-promotion="${option.promotion}">
      ${renderPiece(playerColor, option.promotion)}
      <span>${pieceNames[option.promotion]}</span>
    </button>
  `).join("");
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="promotion-modal" role="dialog" aria-modal="true" aria-labelledby="promotion-title">
        <p class="eyebrow">Pawn promotion</p>
        <h2 id="promotion-title">Choose a piece</h2>
        <div class="promotion-options">${options}</div>
        <button class="text-button" type="button" data-action="cancel-promotion">Cancel</button>
      </section>
    </div>
  `;
}

function renderPremoves() {
  if (state.snapshot.premoves.length === 0) {
    return `<p class="empty-line">Your queued moves will appear here.</p>`;
  }
  return `
    <ol class="move-list">
      ${state.snapshot.premoves.map((move, index) => `
        <li><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHTML(move.san)}</strong></li>
      `).join("")}
    </ol>
  `;
}

function renderOutcome() {
  const { phase, outcome, message } = state.snapshot;
  if (phase === "planning") {
    return "";
  }
  if (phase === "playing") {
    return `<div class="run-status" aria-live="polite"><span class="spinner"></span>Playing your line…</div>`;
  }
  if (phase === "error") {
    return `
      <div class="outcome-card is-error" role="alert">
        <p class="eyebrow">Engine error</p>
        <p>${escapeHTML(state.executionError || message)}</p>
        <button class="secondary-button" type="button" data-action="retry-puzzle">Retry level</button>
      </div>
    `;
  }

  const victory = outcome === "victory";
  const draw = outcome === "draw";
  const { perfect, minimumMoves, movesUsed } = state.snapshot;
  if (victory && perfect) {
    return `
    <div class="outcome-card is-perfect ${state.revealOutcome ? "is-revealing" : ""}" role="status">
      <p class="eyebrow">Perfect solve</p>
      <h3><span class="perfect-star" aria-hidden="true">★</span> Perfect!</h3>
      <p>Checkmate in ${plural(minimumMoves, "premove")}, the fewest possible. Flawless vision.</p>
      ${state.progressError ? `<p class="inline-error" role="alert">${escapeHTML(state.progressError)}</p>` : ""}
      <div class="outcome-actions">
        ${renderForwardButton()}
        <button class="secondary-button" type="button" data-action="retry-puzzle">Play again</button>
        <button class="text-button" type="button" data-action="open-stage" data-stage-id="${state.level.stageId}">Level map</button>
      </div>
    </div>
  `;
  }
  const title = victory ? "Checkmate!" : draw ? "Draw" : "Not this time";
  const perfectHint = victory && minimumMoves
    ? `<p class="perfect-hint">You used ${plural(movesUsed, "premove")}; it can be done in ${minimumMoves}. Retry for a perfect <span aria-hidden="true">★</span></p>`
    : "";
  return `
    <div class="outcome-card ${victory ? "is-victory" : draw ? "is-draw" : "is-defeat"} ${victory && state.revealOutcome ? "is-revealing" : ""}" role="status">
      <p class="eyebrow">${victory ? "Beautifully seen" : draw ? "The position is level" : "Keep training"}</p>
      <h3>${title}</h3>
      <p>${escapeHTML(message)}</p>
      ${perfectHint}
      ${state.progressError ? `<p class="inline-error" role="alert">${escapeHTML(state.progressError)}</p>` : ""}
      <div class="outcome-actions">
        <button class="secondary-button" type="button" data-action="retry-puzzle">Retry level</button>
        ${victory ? renderForwardButton() : ""}
        <button class="text-button" type="button" data-action="open-stage" data-stage-id="${state.level.stageId}">Level map</button>
      </div>
    </div>
  `;
}

/** The next level in the same stage, or null on a stage's last level. */
function nextLevelInStage() {
  if (!state.level) {
    return null;
  }
  const next = nextLevel(state.level.id);
  return next?.stageId === state.level.stageId ? next : null;
}

function canOpenNextLevel() {
  const next = nextLevelInStage();
  return Boolean(next) && (import.meta.env.DEV || state.progressStore.isUnlocked(next.id));
}

// After a win: "Next level" inside a stage; after a stage's last level, back to its map,
// where the stage-clear celebration plays.
function renderForwardButton() {
  if (canOpenNextLevel()) {
    return '<button class="primary-button" type="button" data-action="next-level">Next level <span aria-hidden="true">→</span></button>';
  }
  if (!nextLevelInStage() && state.progressStore.isStageCleared(state.level.stageId)) {
    return `<button class="primary-button" type="button" data-action="open-stage" data-stage-id="${state.level.stageId}">Continue <span aria-hidden="true">→</span></button>`;
  }
  return "";
}

function renderPuzzle() {
  const snapshot = state.snapshot;
  const planning = snapshot.phase === "planning";
  const legalTargets = planning && state.selectedSquare
    ? state.session.legalMovesFrom(state.selectedSquare).map((move) => move.to)
    : [];
  const board = renderBoard(
    snapshot.fen,
    planning ? snapshot.premoves : [],
    snapshot.lastMove,
    state.selectedSquare,
    legalTargets,
  );
  const moveCount = snapshot.premoves.length;

  const stage = getStage(state.level.stageId);
  return `
    ${renderHeader()}
    <main class="puzzle-screen" data-theme="${stage.theme}">
      <div class="game-layout">
        <div class="puzzle-heading">
          <button class="back-button" type="button" data-action="open-stage" data-stage-id="${stage.id}" aria-label="Back to ${escapeHTML(stage.name)}" ${snapshot.phase === "playing" ? "disabled" : ""}>
            <span aria-hidden="true">←</span> <span class="back-label">${escapeHTML(stage.name)}</span>
          </button>
          <p class="level-kicker">
            <span class="level-badge">${state.level.id}</span>
            <span class="level-kicker-text">World ${stage.id}, level ${state.level.number} of ${stage.levels.length}</span>
            ${renderPips(stage)}
          </p>
          <h1>${escapeHTML(state.puzzle.title)}</h1>
          <p class="par-line">
            ${state.puzzle.number_of_moves ? `<span class="par-chip">Perfect in ${plural(state.puzzle.number_of_moves, "premove")}</span>` : ""}
            <span class="par-chip is-attempts">${plural(state.progressStore.attemptCount(state.level.id), "attempt")}</span>
            ${state.progressStore.isPerfected(state.level.id) ? '<span class="par-chip is-perfect">★ Perfected</span>' : ""}
          </p>
        </div>

        <section class="board-column" aria-label="Puzzle board">
          <div class="board-frame">
            <div class="board-player-label"><span class="player-dot"></span>You · White</div>
            ${board}
            <div class="board-bottom-label">OPPONENT · BLACK</div>
          </div>
        </section>

        <aside class="control-panel">
          <div class="panel-top">
            <div>
              <p class="eyebrow">${planning ? "Plan your line" : snapshot.phase === "playing" ? "Executing" : "Result"}</p>
              <h2>${planning ? "Your premoves" : snapshot.phase === "playing" ? "Watch it unfold" : "Puzzle complete"}</h2>
            </div>
            <span class="move-count">${moveCount} ${moveCount === 1 ? "move" : "moves"}</span>
          </div>
          ${planning || snapshot.phase === "playing" ? `<p class="panel-copy">${planning
            ? "Queue the moves you think will lead to checkmate. The board previews your pieces as you go."
            : "Your moves and the opponent's replies are being played in order."}</p>` : ""}

          ${state.interactionError ? `<p class="inline-error" role="alert">${escapeHTML(state.interactionError)}</p>` : ""}
          ${state.executionError && snapshot.phase !== "error" ? `<p class="inline-error" role="alert">${escapeHTML(state.executionError)}</p>` : ""}
          ${renderOutcome()}

          <div class="move-list-wrap" role="region" tabindex="0" aria-live="polite" aria-label="Queued premoves">
            ${renderPremoves()}
          </div>

          ${planning ? `
            <div class="planning-actions">
              <button class="primary-button submit-button" type="button" data-action="submit" ${moveCount === 0 ? "disabled" : ""}>
                <span class="submit-label">I'm done premoving</span><span class="submit-short-label" aria-hidden="true">Done</span> <span aria-hidden="true">→</span>
              </button>
              <button class="secondary-button" type="button" data-action="undo" ${moveCount === 0 ? "disabled" : ""}>
                <span class="undo-label">Undo last move</span><span class="undo-short-label" aria-hidden="true">Undo</span>
              </button>
            </div>
          ` : ""}
          ${planning ? '<p class="panel-footnote">Moves that become illegal after the opponent replies will end the attempt.</p>' : ""}
        </aside>
      </div>
      ${renderPromotionDialog()}
    </main>
  `;
}

function animatePieceMove(move, originRect) {
  if (!originRect || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const destination = app.querySelector(`[data-square="${move.to}"] .piece`);
  if (!destination?.animate) {
    return;
  }

  const destinationRect = destination.getBoundingClientRect();
  const offsetX = originRect.left - destinationRect.left;
  const offsetY = originRect.top - destinationRect.top;
  if (Math.abs(offsetX) < 1 && Math.abs(offsetY) < 1) {
    return;
  }

  destination.animate(
    [
      { transform: `translate(${offsetX}px, ${offsetY}px)` },
      { transform: "translate(0, 0)" },
    ],
    {
      duration: 100,
      easing: "cubic-bezier(0.65, 0, 0.35, 1)",
    },
  );
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Checkmate: the mated king wobbles and topples, the board thumps, and confetti bursts from
// the king: red/blue/green/yellow for any win, twice as much in gold with stars for a perfect
// solve (which also gets the gold cannons when its card appears). Runs once, as mate lands.
function celebrateMate({ square, perfect }) {
  navigator.vibrate?.([24, 40, 70]);
  sounds.play(perfect ? "perfect" : "win", { when: 0.22 }); // after the mating move's thud
  if (prefersReducedMotion()) {
    return; // the static red glow and tipped king (CSS) still mark the mate
  }
  const king = app.querySelector(`[data-square="${square}"] .piece`);
  king?.animate?.([
    { transform: "rotate(0deg)" },
    { transform: "rotate(-9deg)", offset: 0.15 },
    { transform: "rotate(8deg)", offset: 0.3 },
    { transform: "rotate(-6deg)", offset: 0.45 },
    { transform: "rotate(4deg)", offset: 0.58 },
    { transform: "rotate(-22deg) translate(-4%, 6%)" },
  ], { duration: 700, delay: 110, easing: "ease-out", fill: "backwards" });
  app.querySelector(".board")?.animate?.([
    { transform: "scale(1)" },
    { transform: "scale(1.018)", offset: 0.35 },
    { transform: "scale(1)" },
  ], { duration: 360, delay: 110, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)" });

  const rect = (king ?? app.querySelector(".board"))?.getBoundingClientRect();
  if (!rect) {
    return;
  }
  const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  setTimeout(() => burst(perfect
    ? { ...origin, count: 160, palette: PALETTES.perfect, shapes: ["star", "rect", "ribbon", "circle"] }
    : { ...origin, count: 80, palette: PALETTES.victory, shapes: ["rect", "ribbon", "circle"] }), 260);
}

function render() {
  const pendingMove = state.pendingPieceMove;
  state.pendingPieceMove = null;
  const previousList = app.querySelector(".move-list-wrap");
  const previousMoveCount = previousList?.querySelectorAll(".move-list li").length ?? 0;
  const previousScroll = previousList && { left: previousList.scrollLeft, top: previousList.scrollTop };
  const sourcePiece = pendingMove && state.screen === "puzzle"
    ? app.querySelector(`[data-square="${pendingMove.from}"] .piece`)
    : null;
  const originRect = sourcePiece?.getBoundingClientRect();

  if (state.screen === "loading") {
    app.innerHTML = renderLoading();
  } else if (state.screen === "error") {
    app.innerHTML = renderError();
  } else if (state.screen === "index") {
    app.innerHTML = renderWorldMap();
  } else if (state.screen === "stage") {
    app.innerHTML = renderStage();
  } else if (state.screen === "puzzle") {
    app.innerHTML = renderPuzzle();
  } else if (state.screen === "sounds" && import.meta.env.DEV) {
    app.innerHTML = renderSoundBoard();
  }

  const moveList = app.querySelector(".move-list-wrap");
  if (moveList && previousScroll) {
    const moveCount = moveList.querySelectorAll(".move-list li").length;
    moveList.scrollTo(moveCount > previousMoveCount
      ? { left: moveList.scrollWidth, top: moveList.scrollHeight }
      : previousScroll);
  }

  if (pendingMove && state.screen === "puzzle") {
    animatePieceMove(pendingMove, originRect);
  }

  const celebration = state.pendingCelebration;
  state.pendingCelebration = null;
  if (celebration && state.screen === "puzzle") {
    celebrateMate(celebration);
  }
  if (state.revealOutcome && state.screen === "puzzle") {
    const { outcome, perfect } = state.snapshot;
    if (outcome === "defeat" || outcome === "draw") {
      sounds.play(outcome); // wins already got their fanfare as mate landed
    }
    // A perfect solve gets a second, golden volley when its result card appears.
    if (outcome === "victory" && perfect && !prefersReducedMotion()) {
      cannons();
      sounds.play("poppers");
    }
  }
  state.revealOutcome = false;
  if (!state.transitioning) {
    playMapEffects();
  }
  music.update(musicTarget());
}

// Screen changes cross-fade, and a world card grows into its level map (View Transitions,
// where supported). Map animations wait until the transition has finished.
function navigate(update) {
  if (!document.startViewTransition || prefersReducedMotion() || state.screen === "loading") {
    update();
    render();
    return;
  }
  const transition = document.startViewTransition(() => {
    state.transitioning = true;
    update();
    render();
  });
  transition.finished.finally(() => {
    state.transitioning = false;
    playMapEffects();
  });
}

// Plays what the last win changed, marked with data-fresh by the map renderers: a level's
// lock breaking, the trail drawing on, the piece hopping to the new level, the goal flag going
// up with a "World clear!" stamp, or a newly opened world on the world map.
function playMapEffects() {
  const freshElements = [...app.querySelectorAll("[data-fresh]")];
  if (freshElements.length === 0) {
    return;
  }
  const reduced = prefersReducedMotion();
  for (const element of freshElements) {
    const effect = element.dataset.fresh;
    delete element.dataset.fresh;
    // Sounds are timed to land with their animation's key moment (see worlds.css keyframes).
    // With reduced motion the animations are skipped, so only the untimed cues play.
    if (effect === "draw") {
      if (!reduced && element.getBoundingClientRect().width > 0) {
        sounds.play("trail", { when: 0.12 }); // the wide and tall trails both carry the flag
      }
      drawTrail(element, reduced);
    } else if (effect === "hop") {
      if (!reduced) {
        sounds.play("hop", { when: 0.26 });
      }
      hopToken(element, Number(element.dataset.hopTo), reduced);
    } else if (effect === "unlock-world") {
      sounds.play("unlock-world");
      element.classList.add("is-unlocking");
      element.classList.remove("is-locked");
      if (!reduced) {
        element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
        setTimeout(() => {
          const lock = element.querySelector(".world-lock")?.getBoundingClientRect();
          if (lock?.width) {
            burst({
              x: lock.left + lock.width / 2,
              y: lock.top + lock.height / 2,
              count: 60,
              power: 0.6,
              palette: THEME_CONFETTI[element.dataset.theme] ?? PALETTES.victory,
              shapes: ["star", "circle", "rect"],
            });
          }
        }, 420);
      }
    } else if (effect === "raise-flag") {
      if (!reduced) {
        sounds.play("flag", { when: 0.2 });
      }
      element.classList.add("is-raised", "is-raising");
    } else if (effect === "stamp") {
      sounds.play("stamp", { when: reduced ? 0 : 0.74 }); // the stamp's impact frame
      element.classList.add("is-stamping");
      if (!reduced) {
        const rect = element.getBoundingClientRect();
        const theme = element.closest("[data-theme]")?.dataset.theme;
        setTimeout(() => burst({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          count: 110,
          palette: THEME_CONFETTI[theme] ?? PALETTES.victory,
          shapes: ["star", "rect", "ribbon", "circle"],
        }), 520);
      }
    } else {
      // a level unlocking: the padlock wiggles and springs off, then the node pops
      if (!reduced) {
        sounds.play("lock");
      }
      sounds.play("pop", { when: reduced ? 0 : 0.6 });
      element.classList.add("is-animating");
    }
  }
}

// The trail's stroke doesn't scale with the stretched map, so its dashes are measured in
// screen pixels: draw it on with a dash as long as the segment is on screen.
function drawTrail(path, reduced) {
  const matrix = path.getScreenCTM();
  if (reduced || !matrix || !path.animate || path.getBoundingClientRect().width === 0) {
    return; // hidden layout (wide vs tall) or reduced motion: just show it
  }
  const total = path.getTotalLength();
  let length = 0;
  let previous = null;
  for (let step = 0; step <= 24; step += 1) {
    const point = path.getPointAtLength((total * step) / 24).matrixTransform(matrix);
    if (previous) {
      length += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    previous = point;
  }
  path.style.strokeDasharray = `${length} ${length}`;
  path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
    duration: 560, delay: 120, easing: "ease-out", fill: "backwards",
  }).finished.then(() => path.style.removeProperty("stroke-dasharray"), () => {});
}

function hopToken(pin, toIndex, reduced) {
  const before = pin.getBoundingClientRect();
  pin.setAttribute("style", mapPosition(toIndex));
  if (reduced || !pin.animate) {
    return;
  }
  const after = pin.getBoundingClientRect();
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  const lift = Math.max(48, Math.abs(dx) * 0.35);
  pin.animate([
    { transform: `translate(${dx}px, ${dy}px)` },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - lift}px)`, offset: 0.5 },
    { transform: "translate(0, 0)", offset: 0.88 },
    { transform: "translate(0, 0) scale(1.12, 0.86)", offset: 0.94 },
    { transform: "translate(0, 0)" },
  ], { duration: 640, delay: 260, easing: "cubic-bezier(0.45, 0, 0.4, 1)", fill: "backwards" });
}

async function initializeApp() {
  state.screen = "loading";
  state.error = null;
  render();
  try {
    if (!state.progressStore) {
      state.progressStore = createProgressStore(undefined, { allowDevUnlock: import.meta.env.DEV });
    }
    // The premove-aware opponent is bundled WebAssembly; loading takes a few milliseconds.
    state.engine = await loadPremoveEngine();
    state.screen = "index";
    render();
  } catch (error) {
    state.engine = null;
    state.error = error;
    state.screen = "error";
    render();
  }
}

function clearPuzzle() {
  state.level = null;
  state.puzzle = null;
  state.session = null;
  state.snapshot = null;
  state.selectedSquare = null;
  state.promotionRequest = null;
}

function openWorldMap() {
  navigate(() => {
    clearPuzzle();
    state.stage = null;
    state.screen = "index";
  });
}

function openStage(id) {
  const stage = getStage(id);
  if (!state.progressStore.isStageUnlocked(stage.id) && !import.meta.env.DEV) {
    return;
  }
  navigate(() => {
    clearPuzzle();
    state.stage = stage;
    state.screen = "stage";
  });
}

function openLevel(id, { transition = true } = {}) {
  if (import.meta.env.DEV && !state.progressStore.isUnlocked(id)) {
    state.progressStore.unlockForDevelopment(id);
  }
  if (!state.progressStore.isUnlocked(id)) {
    return;
  }
  const level = getLevel(id);
  const show = () => {
    resetLevel(level);
    state.screen = "puzzle";
  };
  if (transition && state.screen !== "puzzle") {
    navigate(show);
  } else {
    show();
    render();
  }
}

function resetLevel(level) {
  if (state.fresh.unlockedLevel === level.id) {
    state.fresh.unlockedLevel = null; // played straight away: no unlock animation later
    state.fresh.hopFrom = null;
  }
  state.annotations = EMPTY_ANNOTATIONS;
  state.drawingArrow = null;
  state.pendingPieceMove = null;
  state.pendingCelebration = null;
  state.revealOutcome = false;
  state.level = level;
  state.stage = getStage(level.stageId);
  state.puzzle = level.puzzle;
  state.session = createPremoveGame(state.puzzle);
  state.snapshot = state.session.snapshot();
  state.selectedSquare = null;
  state.promotionRequest = null;
  state.interactionError = "";
  state.progressError = "";
  state.executionError = "";
}

function queueSelectedMove(from, to, promotion) {
  try {
    state.snapshot = state.session.queueMove({ from, to, promotion });
    state.interactionError = "";
    sounds.play("premove");
  } catch (error) {
    state.interactionError = error.message;
    sounds.play("illegal");
  }
  state.selectedSquare = null;
  state.promotionRequest = null;
  render();
}

function attemptMove(from, to) {
  const options = state.session.legalMovesFrom(from).filter((move) => move.to === to);
  if (options.length === 0) {
    state.interactionError = `That move is not legal from ${from}.`;
    sounds.play("illegal");
    state.selectedSquare = null;
    render();
    return;
  }
  if (options.some((move) => move.promotion)) {
    state.promotionRequest = { from, to, options };
    state.interactionError = "";
    render();
    return;
  }
  queueSelectedMove(from, to);
}

function selectSquare(square) {
  if (state.screen !== "puzzle" || state.snapshot.phase !== "planning" || state.promotionRequest) {
    return;
  }
  state.interactionError = "";

  if (state.selectedSquare) {
    const from = state.selectedSquare;
    const moves = state.session.legalMovesFrom(from);
    if (moves.some((move) => move.to === square)) {
      attemptMove(from, square);
      return;
    }
  }

  const piece = parsePlacement(state.snapshot.fen).get(square);
  if (piece?.color === state.snapshot.playerColor) {
    state.selectedSquare = square;
  } else if (state.selectedSquare) {
    attemptMove(state.selectedSquare, square);
    return;
  } else {
    state.selectedSquare = null;
  }
  render();
}

// Saves a win and notes what it opened up, for the maps to animate next time they show.
function recordWin(level, perfect) {
  const store = state.progressStore;
  const next = nextLevel(level.id);
  const nextWasOpen = next ? store.isUnlocked(next.id) : true;
  const stageWasCleared = store.isStageCleared(level.stageId);
  store.markCompleted(level.id, { perfect });
  if (next && !nextWasOpen && store.isUnlocked(next.id)) {
    if (next.stageId === level.stageId) {
      state.fresh.unlockedLevel = next.id;
      state.fresh.hopFrom = level.id;
    } else {
      state.fresh.unlockedStage = next.stageId;
    }
  }
  if (!stageWasCleared && store.isStageCleared(level.stageId)) {
    state.fresh.clearedStage = level.stageId;
  }
}

async function submitPremoves() {
  sounds.play("submit");
  state.interactionError = "";
  state.executionError = "";
  // every submitted line counts as an attempt; shown on the puzzle page
  try {
    state.progressStore.recordAttempt(state.level.id);
    state.progressError = "";
  } catch (error) {
    state.progressError = error.message;
  }
  try {
    // The opponent knows the whole submitted plan and plays the strongest defence against it.
    const opponent = createPremoveOpponent({
      engine: state.engine,
      puzzleFen: state.puzzle.fen,
      premoves: state.session.snapshot().premoves,
    });
    await state.session.play(opponent, {
      delayMs: 1_000,
      startDelayMs: 500,
      onUpdate(snapshot) {
        const previousMove = state.snapshot?.lastMove;
        const currentMove = snapshot.lastMove;
        if (currentMove && (
          !previousMove
          || previousMove.from !== currentMove.from
          || previousMove.to !== currentMove.to
          || previousMove.color !== currentMove.color
          || previousMove.san !== currentMove.san
        )) {
          state.pendingPieceMove = { from: currentMove.from, to: currentMove.to };
          sounds.play(soundForMove(currentMove), { opponent: currentMove.color !== snapshot.playerColor });
        }
        if (snapshot.matedKing && !state.snapshot?.matedKing) {
          state.pendingCelebration = {
            square: snapshot.matedKing,
            perfect: snapshot.minimumMoves !== null && snapshot.movesUsed <= snapshot.minimumMoves,
          };
        }
        if (snapshot.phase === "complete" && state.snapshot?.phase !== "complete") {
          state.revealOutcome = true;
        }
        state.snapshot = snapshot;
        if (snapshot.phase === "complete" && snapshot.outcome === "victory") {
          try {
            recordWin(state.level, snapshot.perfect);
            state.progressError = "";
          } catch (error) {
            state.progressError = error.message;
          }
        }
        render();
      },
    });
  } catch (error) {
    state.executionError = error.message;
    state.snapshot = state.session.snapshot();
    render();
  }
}

app.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-action]");
  if (actionElement) {
    const { action } = actionElement.dataset;
    if (action === "home") {
      if (!state.engine || state.snapshot?.phase === "playing") {
        return;
      }
      sounds.play("back");
      openWorldMap();
    } else if (action === "open-stage") {
      if (state.snapshot?.phase === "playing") {
        return;
      }
      sounds.play(state.screen === "index" ? "open" : "back"); // into a world, or back up to it
      openStage(actionElement.dataset.stageId);
    } else if (action === "retry-setup") {
      sounds.play("click");
      void initializeApp();
    } else if (action === "open-level") {
      sounds.play("open");
      openLevel(actionElement.dataset.levelId);
    } else if (action === "toggle-sound") {
      toggleSound();
    } else if (action === "sound-board" && import.meta.env.DEV) {
      sounds.play("open");
      navigate(() => {
        state.screen = "sounds";
      });
    } else if (action === "toggle-music") {
      toggleMusic();
    } else if (action === "music-preview" && import.meta.env.DEV) {
      const current = state.musicPreview ?? musicTarget();
      state.musicPreview = {
        world: actionElement.dataset.world ?? current.world,
        scene: actionElement.dataset.scene ?? current.scene,
      };
      render();
    } else if (action === "play-sound") {
      sounds.play(actionElement.dataset.sound, { opponent: actionElement.dataset.opponent === "true" });
    } else if (action === "submit" && state.snapshot.phase === "planning") {
      void submitPremoves();
    } else if (action === "undo" && state.snapshot.phase === "planning") {
      sounds.play("undo");
      state.snapshot = state.session.undoPremove();
      state.interactionError = "";
      state.selectedSquare = null;
      render();
    } else if (action === "retry-puzzle") {
      sounds.play("click");
      openLevel(state.level.id);
    } else if (action === "next-level") {
      const next = nextLevelInStage();
      if (next) {
        sounds.play("open");
        openLevel(next.id);
      }
    } else if (action === "choose-promotion") {
      const request = state.promotionRequest;
      if (request) {
        queueSelectedMove(request.from, request.to, actionElement.dataset.promotion);
      }
    } else if (action === "cancel-promotion") {
      sounds.play("click");
      state.promotionRequest = null;
      render();
    }
    return;
  }

  const squareElement = event.target.closest("[data-square]");
  if (squareElement) {
    selectSquare(squareElement.dataset.square);
  }
});

app.addEventListener("dragstart", (event) => {
  const squareElement = event.target.closest("[data-square]");
  if (!squareElement || state.snapshot?.phase !== "planning") {
    return;
  }
  const square = squareElement.dataset.square;
  const piece = parsePlacement(state.snapshot.fen).get(square);
  if (piece?.color !== state.snapshot.playerColor) {
    event.preventDefault();
    return;
  }
  state.selectedSquare = square;
  event.dataTransfer?.setData("text/plain", square);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    const pieceElement = squareElement.querySelector(".piece");
    if (pieceElement) {
      const pieceRect = pieceElement.getBoundingClientRect();
      event.dataTransfer.setDragImage(pieceElement, pieceRect.width / 2, pieceRect.height / 2);
    }
  }
  // Hide the piece on its square while it is being dragged, so it doesn't look duplicated.
  // Deferred: the browser takes its picture of the dragged piece after this handler returns.
  setTimeout(() => {
    if (squareElement.isConnected) {
      squareElement.classList.add("is-drag-source");
    }
  }, 0);
});

// A drag dropped off the board, or cancelled with Escape: put the piece back.
app.addEventListener("dragend", () => {
  app.querySelectorAll(".is-drag-source").forEach((element) => element.classList.remove("is-drag-source"));
});

app.addEventListener("dragover", (event) => {
  if (event.target.closest("[data-square]") && state.snapshot?.phase === "planning") {
    event.preventDefault();
  }
});

app.addEventListener("drop", (event) => {
  const squareElement = event.target.closest("[data-square]");
  if (!squareElement || state.snapshot?.phase !== "planning") {
    return;
  }
  event.preventDefault();
  const from = event.dataTransfer?.getData("text/plain") || state.selectedSquare;
  const to = squareElement.dataset.square;
  if (from === to) {
    // put back where it was picked up: leave it selected, no error
    state.interactionError = "";
    render();
  } else if (from) {
    attemptMove(from, to);
  }
});

// ---- Right-click arrows and highlights (chess.com style) ----

// Redraw just the annotation layers, without rebuilding the board.
function updateAnnotationLayers() {
  const layers = annotationLayers(state.annotations);
  const highlights = app.querySelector(".board-highlights");
  const arrows = app.querySelector(".board-arrows");
  if (highlights) highlights.innerHTML = layers.highlights;
  if (arrows) arrows.innerHTML = layers.arrows;
}

function squareAtPoint(clientX, clientY) {
  const board = app.querySelector(".board");
  if (!board) {
    return null;
  }
  const rect = board.getBoundingClientRect();
  const column = Math.floor(((clientX - rect.left) / rect.width) * 8);
  const row = Math.floor(((clientY - rect.top) / rect.height) * 8);
  if (column < 0 || column > 7 || row < 0 || row > 7) {
    return null;
  }
  return `${files[column]}${8 - row}`;
}

app.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".board")) {
    event.preventDefault();
  }
});

// Any left click clears the annotations, like chess.com.
document.addEventListener("mousedown", (event) => {
  if (event.button === 0 && hasAnnotations(state.annotations)) {
    state.annotations = EMPTY_ANNOTATIONS;
    updateAnnotationLayers();
  }
}, true);

app.addEventListener("mousedown", (event) => {
  if (event.button !== 2 || !event.target.closest(".board")) {
    return;
  }
  const from = squareAtPoint(event.clientX, event.clientY);
  if (from) {
    event.preventDefault();
    state.drawingArrow = { from };
  }
});

// Nothing is drawn while dragging; releasing the right button commits the arrow or highlight.

window.addEventListener("mouseup", (event) => {
  const drawing = state.drawingArrow;
  if (event.button !== 2 || !drawing) {
    return;
  }
  state.drawingArrow = null;
  const to = squareAtPoint(event.clientX, event.clientY);
  if (to === drawing.from) {
    state.annotations = toggleHighlight(state.annotations, to, annotationColor("highlight", event));
  } else if (to) {
    state.annotations = toggleArrow(state.annotations, drawing.from, to, annotationColor("arrow", event));
  }
  updateAnnotationLayers();
});

app.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.promotionRequest) {
    state.promotionRequest = null;
    render();
  }
});

// Escape on a level map goes back to the world map, like backing out of a game menu.
// M toggles sound, as in most games.
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (event.key === "Escape" && state.screen === "stage") {
    sounds.play("back");
    openWorldMap();
  } else if ((event.key === "m" || event.key === "M") && state.engine && !event.target.closest?.("input, textarea, select")) {
    toggleSound();
  }
});

// Browsers only allow audio after a user gesture: the first one starts the music.
for (const type of ["pointerdown", "keydown"]) {
  document.addEventListener(type, () => music.start(), { capture: true, once: true });
}
// No music in a background tab; it picks up from the top when the tab is back.
document.addEventListener("visibilitychange", () => music.setHidden(document.hidden));

void initializeApp();
