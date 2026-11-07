import { burst, cannons, PALETTES } from "./effects/confetti.js";
import { createMusicPlayer, SCENES, SONGS } from "./effects/music.js";
import { createSoundPlayer, SOUND_NAMES, soundForMove } from "./effects/sound.js";
import { createPremoveOpponent, loadPremoveEngine } from "./engine/premoveOpponent.js";
import {
  annotationColor, annotationLayers, arrowGeometry, EMPTY_ANNOTATIONS, hasAnnotations, squareCenter, toggleArrow,
  toggleHighlight,
} from "./game/annotations.js";
import { chessComAnalysisUrl } from "./game/links.js";
import { boardRows, parsePlacement } from "./game/premoveRules.js";
import { createPremoveGame } from "./game/session.js";
import { createProgressStore } from "./game/progress.js";
import { getLevel, getStage, LEVELS, nextLevel, nextStage, STAGES } from "./game/stages.js";
import { computeStats, loadSeenBadges, saveSeenBadges } from "./game/stats.js";
import {
  COACH_TEXTS, COACH_TITLES, COMPLETE_CARD, createTutorialStore, isTutorialMove, PLAN_COMPLETE_MESSAGE, PLAYING_COACH,
  TUTORIAL_INTRO, TUTORIAL_LEVEL, tutorialStep, WRONG_MOVE_MESSAGE,
} from "./game/tutorial.js";
import { renderScene, THEME_CONFETTI } from "./ui/scenery.js";
import "@fontsource/lilita-one/latin-400.css";
import "./style.css";
import "./ui/worlds.css";
import "./ui/stats.css";
import "./ui/panel.css";
import "./ui/coach.css";
import "./ui/tutorial.css";

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
  tutorialStore: null, // whether the tutorial is done (it must be, before the worlds open)
  tutorial: false, // the puzzle screen is playing the tutorial (state.level is TUTORIAL_LEVEL)
  coachPanelHeight: null, // px the planning panel needs when it has a coach (see fitCoachPanel)
  tutorialIntro: false, // the tutorial's welcome card is showing over the board
  stage: null, // the stage whose level map is open (screen "stage")
  level: null, // the level being played (screen "puzzle"); state.puzzle is level.puzzle
  // What the last win changed, played as animations the next time the map shows it:
  // unlockedLevel/hopFrom (stage map), clearedStage (stage map), unlockedStage (world map).
  fresh: { unlockedLevel: null, hopFrom: null, clearedStage: null, unlockedStage: null },
  transitioning: false,
  musicPreview: null, // development sound board: { world, scene } to audition
  // stats screen: which tab (narrow screens), where Back returns to (a stage id, or null for
  // the world map), the one-shot intro flag, and the badges that are new this visit
  trayCount: 0, // premoves shown in the tray last render, so a newly queued one can pop in
  statsTab: "overview",
  statsReturn: null,
  statsIntro: false,
  statsNewBadges: new Set(),
  seenBadges: null, // ids of earned badges already shown on the stats screen (lazy)
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
  // the engine's status only shows while it loads (or failed): once it's ready, it just is
  const engineStatus = state.screen === "error" ? "ENGINE OFFLINE" : "LOADING ENGINE";
  const showStars = state.engine && state.progressStore;
  const stars = showStars ? state.progressStore.perfectedIds().length : 0;
  return `
    <header class="topbar">
      <button class="brand" type="button" data-action="home" aria-label="Go to world map" ${state.engine ? "" : "disabled"}>
        <span class="brand-mark" aria-hidden="true">♞</span>
        <span>PREMOVE</span>
      </button>
      <span class="topbar-status">
        ${showStars ? renderStatsButton(stars) : ""}
        ${renderMusicToggle()}
        ${renderSoundToggle()}
        ${state.engine ? "" : `<span class="engine-pill"><span class="status-dot"></span>${engineStatus}</span>`}
      </span>
    </header>
  `;
}

// The star counter doubles as the way into the stats screen; a dot flags badges not yet seen.
// The back buttons' arrow. An SVG rather than "←": no loaded font has that glyph, so phones
// drew it from a system font, small and sitting on the baseline instead of centred.
const BACK_ICON = '<svg class="back-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 12H5.5M11.5 5.5 5 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TROPHY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 4h10v5a5 5 0 0 1-10 0z" fill="currentColor"/><path d="M7 6H4.5v1.5A3.5 3.5 0 0 0 8 11M17 6h2.5v1.5A3.5 3.5 0 0 1 16 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10.5 14h3l.5 3.5h-4zM8 18h8v2.5H8z" fill="currentColor"/></svg>';
function renderStatsButton(stars) {
  const unseen = unseenBadgeCount();
  const playing = state.snapshot?.phase === "playing";
  return `<button class="star-counter ${stars ? "has-stars" : ""} ${unseen ? "has-new" : ""} ${state.screen === "stats" ? "is-current" : ""}" type="button" data-action="stats" ${playing ? "disabled" : ""}
    title="Your stats" aria-label="Your stats: ${stars} of ${LEVELS.length} levels perfected${unseen ? `, ${plural(unseen, "new badge")}` : ""}">
    <span class="star-counter-trophy">${TROPHY_ICON}</span><span aria-hidden="true">★</span> ${stars}<small>/${LEVELS.length}</small>
  </button>`;
}

function seenBadges() {
  state.seenBadges ??= loadSeenBadges();
  return state.seenBadges;
}

function unseenBadgeCount() {
  if (!state.progressStore) {
    return 0;
  }
  const seen = seenBadges();
  return computeStats(state.progressStore, STAGES).badges.filter((badge) => badge.earned && !seen.has(badge.id)).length;
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

// Which piece and layers the music plays: the world being played (on the world map, the
// world you're up to), full band on maps, a thinking texture while planning, extra
// percussion while a line plays out.
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

/** Every world stays shut until the tutorial is done (players with earlier wins skip it). */
function tutorialDone() {
  return state.tutorialStore?.isDone() ?? true;
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
    unlocked: store.isStageUnlocked(stage.id) && tutorialDone(),
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
  const status = !progress.unlocked ? (previous ? `Clear World ${previous.id} to open` : "Finish the tutorial to open")
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

// Before the tutorial: the hero's one button is the tutorial, and every world is locked.
function renderTutorialButton() {
  return `
    <button class="game-button continue-button tutorial-button" type="button" data-action="open-tutorial" data-theme="meadow">
      <span class="continue-label">Start here</span>
      <span class="continue-level">Tutorial</span>
    </button>
  `;
}

function renderWorldMap() {
  const completedCount = state.progressStore.completedIds().length;
  const perfectedCount = state.progressStore.perfectedIds().length;
  const needsTutorial = !tutorialDone();
  const next = needsTutorial ? null : currentLevel();
  const finished = completedCount === LEVELS.length;
  const cards = STAGES.map(renderWorldCard).join("");
  state.fresh.unlockedStage = null; // consumed: the card above carries data-fresh

  return `
    ${renderHeader()}
    <main class="world-screen scroll-area">
      <section class="world-hero">
        <div class="world-hero-copy">
          <h1>Pick a world</h1>
          <p>${needsTutorial
            ? "Five worlds, five levels each. First, a one-minute tutorial to show you the trick."
            : "Five worlds, five levels each. Clear every level in a world to open the next one."}</p>
        </div>
        <div class="world-hero-side">
          <div class="journey" aria-label="${completedCount} of ${LEVELS.length} levels cleared, ${perfectedCount} perfect">
            <span class="journey-count"><strong>${completedCount}</strong>/${LEVELS.length} levels</span>
            <span class="journey-bar" aria-hidden="true"><span style="width: ${(completedCount / LEVELS.length) * 100}%"></span></span>
          </div>
          ${needsTutorial ? renderTutorialButton() : ""}
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
      <p class="unlock-note">Solve a level in the fewest possible premoves to perfect it and earn its <span class="perfect-star" aria-hidden="true">★</span>${needsTutorial ? "" : ' · <button class="text-button replay-tutorial" type="button" data-action="open-tutorial">Replay the tutorial</button>'}</p>
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
  ["Results", ["win", "perfect", "poppers", "defeat"]],
  ["Menus and maps", ["click", "open", "back", "lock", "pop", "trail", "hop", "flag", "stamp", "unlock-world"]],
];

function renderSoundBoard() {
  const listed = SOUND_GROUPS.flatMap(([, names]) => names);
  const missing = SOUND_NAMES.filter((name) => !listed.includes(name));
  const groups = [...SOUND_GROUPS, ...(missing.length ? [["Other", missing]] : [])];
  return `
    ${renderHeader()}
    <main class="sound-board scroll-area">
      <button class="back-button" type="button" data-action="home">${BACK_ICON} All worlds</button>
      <h1>Sound board</h1>
      <p class="sound-board-copy">Every effect, synthesized live by <code>src/effects/sound.js</code>. Board sounds also have an opponent variant.${sounds.isMuted() ? " Sound is muted: press M to hear them." : ""}</p>
      <section>
        <h2>Music</h2>
        <p class="sound-board-copy">Each world's own piece (<code>src/effects/music.js</code>), and the layers each screen uses. Picking a world restarts its tune.${music.isMuted() ? " Music is off: use the note button above." : ""}</p>
        <div class="sound-board-grid">
          ${Object.entries(SONGS).map(([world, song]) => `<button class="secondary-button ${state.musicPreview?.world === world ? "is-current" : ""}" type="button" data-action="music-preview" data-world="${world}">${world} · ${song.title}</button>`).join("")}
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
  // A world the last win cleared is drawn as it was (flag down, no stamp) and playMapEffects
  // raises the flag and lands the stamp once the screen transition has finished.
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
        <button class="back-button round-back" type="button" data-action="home" aria-label="All worlds">${BACK_ICON}<span class="back-label">All worlds</span></button>
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
      <section class="stage-map ${progress.unlocked ? "" : "is-locked"}" style="view-transition-name: world-scene-${stage.id}" aria-label="Levels of ${escapeHTML(stage.name)}">
        ${renderScene(stage.theme, { wide: true })}
        ${renderTrail(stage, "wide", freshIndex)}
        ${renderTrail(stage, "tall", freshIndex)}
        <ol class="level-nodes">${stage.levels.map((level, index) => renderLevelNode(level, index, { freshUnlock })).join("")}</ol>
        <span class="map-pin goal-pin" style="${mapPosition(stage.levels.length - 1)}" aria-hidden="true">
          <span class="goal-flag ${progress.cleared && !freshClear ? "is-raised" : ""}" ${freshClear ? 'data-fresh="raise-flag"' : ""}>
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

// ---- Stats screen ----
// The player's rank (a chess piece promoted world by world, drawn as a medallion with the
// current world's scenery), counters, every world's levels and the badges. Three columns
// when they fit; otherwise tabs, like a game menu. No move counts (owner's rule).
const BADGE_ICONS = {
  mate: '<text x="12" y="18" text-anchor="middle" font-size="17" font-family="Lilita One, Arial Rounded MT Bold, sans-serif" fill="currentColor">#</text>',
  star: '<path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z" fill="currentColor"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="currentColor"/><circle cx="12" cy="12" r="3.6" fill="var(--badge-face, #fff)"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/>',
  hat: '<path d="M6 9l1.2 2.4 2.6.4-1.9 1.8.5 2.6L6 14.9l-2.4 1.3.5-2.6-1.9-1.8 2.6-.4zM18 9l1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4zM12 3.5l1.4 2.9 3.1.5-2.3 2.2.6 3.1L12 10.7l-2.8 1.5.6-3.1-2.3-2.2 3.1-.5z" fill="currentColor"/>',
  flame: '<path d="M12 2.5c1 3.5 5.5 5.6 5.5 10.6A5.5 5.5 0 0 1 12 18.6a5.5 5.5 0 0 1-5.5-5.5c0-2.6 1.4-4.2 2.6-5.6.2 2 1 3 2 3.4-.4-2.8.4-5.6.9-8.4z" fill="currentColor"/><path d="M12 21.5a3 3 0 0 1-3-3c0-1.7 1.6-2.8 3-4.6 1.4 1.8 3 2.9 3 4.6a3 3 0 0 1-3 3z" fill="var(--badge-face, #fff)" opacity=".75"/>',
  flag: '<path d="M6 3v18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M7.2 4.2h11l-2.6 4 2.6 4h-11z" fill="currentColor"/>',
  gem: '<path d="M7 4h10l4 5-9 11L3 9z" fill="currentColor"/><path d="M3 9h18M9 4l-1.5 5L12 20l4.5-11L15 4" fill="none" stroke="var(--badge-face, #fff)" stroke-width="1.2" opacity=".6"/>',
  stars: '<path d="M8.5 7l1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/><path d="M17 3l1.2 2.4 2.6.4-1.9 1.8.5 2.6L17 8.9l-2.4 1.3.5-2.6-1.9-1.8 2.6-.4z" fill="currentColor"/>',
  trophy: '<path d="M7 3.5h10v5.5a5 5 0 0 1-10 0z" fill="currentColor"/><path d="M7 5.5H4v1.8a3.6 3.6 0 0 0 3.6 3.6M17 5.5h3v1.8a3.6 3.6 0 0 1-3.6 3.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.4 13.8h3.2l.6 3.7h-4.4zM7.5 18h9v3h-9z" fill="currentColor"/>',
  crown: '<path d="M3.5 8l4.2 3.6L12 5l4.3 6.6L20.5 8l-1.8 10H5.3z" fill="currentColor"/><path d="M5.3 19.8h13.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
};

const STAT_ICONS = {
  levels: '<path d="M5 20V5.5l7-2 7 2V20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M9 20v-5h6v5" fill="currentColor"/>',
  stars: BADGE_ICONS.star,
  attempts: '<path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M14.5 3.5h5v5z" fill="currentColor"/>',
  first: BADGE_ICONS.eye,
  rate: '<path d="M4 20h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M6 17v-4M10.7 17V9M15.3 17v-6M20 17V5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
};

const svgIcon = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;

function renderRankHint(rank) {
  if (!rank.next) {
    return "Every level perfect. The top rank is yours.";
  }
  const left = rank.toNext.goal - rank.toNext.done;
  return rank.toNext.world
    ? `Clear ${left === 1 ? "1 more level" : `${left} more levels`} in ${escapeHTML(rank.toNext.world.name)} to become a ${rank.next.name}.`
    : `Perfect ${left === 1 ? "1 more level" : `${left} more levels`} to become a ${rank.next.name}.`;
}

function renderStatsOverview(stats) {
  const { rank } = stats;
  const theme = (rank.stage ?? STAGES.at(-1)).theme;
  const pieceSrc = pieceImage("w", rank.piece);
  const nextSrc = rank.next ? pieceImage("w", rank.next.piece) : null;
  const fill = rank.toNext ? rank.toNext.done / rank.toNext.goal : 1;
  const counters = [
    ["levels", "Levels cleared", stats.cleared, `/${stats.totalLevels}`],
    ["stars", "Stars", stats.stars, `/${stats.totalLevels}`],
    ["attempts", "Attempts", stats.attempts, ""],
    ["first", "First-try clears", stats.firstTryClears, ""],
    ["rate", "Solve rate", stats.winRate === null ? null : Math.round(stats.winRate * 100), "%"],
  ];
  return `
    <h2 class="stats-panel-title stats-rank-title">Rank <span>${rank.step + 1} of ${rank.ladder.length}</span></h2>
    <div class="rank-card" data-theme="${theme}">
      <div class="rank-crest ${rank.gold ? "is-gold" : ""}">
        <span class="crest-medal">
          <span class="crest-scene">${renderScene(theme)}</span>
          ${pieceSrc ? `<img class="crest-piece" src="${escapeHTML(pieceSrc)}" alt="" draggable="false" />` : `<span class="crest-piece crest-glyph">${pieceSymbols.w[rank.piece]}</span>`}
        </span>
        <h2 class="rank-ribbon"><span class="visually-hidden">Your rank: </span>${rank.name}</h2>
      </div>
      <div class="rank-progress" role="progressbar" aria-label="Progress to the next rank" aria-valuemin="0" aria-valuemax="${rank.toNext?.goal ?? 1}" aria-valuenow="${rank.toNext?.done ?? 1}">
        <span class="rank-track"><span class="rank-fill" style="--fill: ${fill}"></span></span>
        ${nextSrc ? `<img class="rank-next" src="${escapeHTML(nextSrc)}" alt="" title="Next rank: ${rank.next.name}" draggable="false" />` : ""}
      </div>
      <p class="rank-hint">${renderRankHint(rank)}</p>
    </div>
    <ul class="stat-counters">
      ${counters.map(([icon, label, value, suffix]) => `
        <li class="stat-counter is-${icon}">
          <span class="stat-icon">${svgIcon(STAT_ICONS[icon])}</span>
          <span class="stat-label">${label}</span>
          <span class="stat-value">${value === null ? "—" : `<strong data-count="${value}">${value}</strong>${suffix ? `<small>${suffix}</small>` : ""}`}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderStatsWorlds(stats) {
  return `
    <h2 class="stats-panel-title">Worlds <span>${stats.worldsCleared} of ${stats.worlds.length} cleared</span></h2>
    <ol class="world-records">
      ${stats.worlds.map(({ stage, unlocked, cleared, perfected, completed, stars, levels }) => {
        const mascot = pieceImage("w", stage.piece);
        return `
          <li class="world-record ${unlocked ? "" : "is-locked"} ${cleared ? "is-cleared" : ""} ${perfected ? "is-perfected" : ""}" data-theme="${stage.theme}">
            <span class="record-mascot">${mascot ? `<img src="${escapeHTML(mascot)}" alt="" draggable="false" />` : pieceSymbols.w[stage.piece]}</span>
            <span class="record-title">
              <span class="record-name">${escapeHTML(stage.name)}</span>
              <span class="record-score">${unlocked ? `${completed}/${levels.length} cleared${stars ? ` <span class="perfect-count">★ ${stars}</span>` : ""}` : "Locked"}</span>
            </span>
            <ol class="record-levels" aria-label="Levels of ${escapeHTML(stage.name)}">
              ${levels.map((level) => {
                const status = level.perfected ? "is-perfect" : level.completed ? "is-complete" : level.unlocked ? "is-ready" : "is-locked";
                const face = level.perfected ? "★" : level.completed ? "✓" : level.unlocked ? level.number : LOCK_ICON;
                const label = `Level ${level.id}: ${level.perfected ? "perfected" : level.completed ? "cleared" : level.unlocked ? "not cleared yet" : "locked"}, ${plural(level.attempts, "attempt")}${level.firstTry ? ", cleared first try" : ""}`;
                return `
                  <li class="record-level" title="${label}">
                    <span class="record-node ${status}" aria-hidden="true">${face}</span>
                    <span class="record-tries ${level.firstTry ? "is-first-try" : ""}" aria-hidden="true">${level.attempts ? (level.firstTry ? "1st try" : `${level.attempts} ${level.attempts === 1 ? "try" : "tries"}`) : "–"}</span>
                    <span class="visually-hidden">${label}</span>
                  </li>
                `;
              }).join("")}
            </ol>
          </li>
        `;
      }).join("")}
    </ol>
  `;
}

function renderStatsBadges(stats) {
  const earnedCount = stats.badges.filter((badge) => badge.earned).length;
  return `
    <h2 class="stats-panel-title">Badges <span>${earnedCount} of ${stats.badges.length}</span></h2>
    <ul class="badge-grid">
      ${stats.badges.map((badge) => {
        const fresh = badge.earned && state.statsNewBadges.has(badge.id);
        return `
          <li class="badge ${badge.earned ? "is-earned" : "is-locked"} ${fresh ? "is-new" : ""}" data-badge="${badge.id}">
            <span class="badge-medal">${svgIcon(BADGE_ICONS[badge.icon])}</span>
            <span class="badge-text">
              <strong class="badge-name">${badge.name}${fresh ? ' <span class="badge-new">New</span>' : ""}</strong>
              <span class="badge-how">${badge.how}</span>
              ${!badge.earned && badge.goal > 1 ? `<span class="badge-progress" aria-label="${badge.progress} of ${badge.goal}"><span style="--fill: ${badge.progress / badge.goal}"></span><em>${badge.progress}/${badge.goal}</em></span>` : ""}
            </span>
            <span class="visually-hidden">${badge.earned ? "Earned" : "Not earned yet"}</span>
          </li>
        `;
      }).join("")}
    </ul>
  `;
}

function renderStats() {
  const stats = computeStats(state.progressStore, STAGES);
  const panels = [
    ["overview", "Overview", renderStatsOverview(stats)],
    ["worlds", "Worlds", renderStatsWorlds(stats)],
    ["badges", "Badges", renderStatsBadges(stats)],
  ];
  const intro = state.statsIntro;
  return `
    ${renderHeader()}
    <main class="stats-screen ${intro ? "is-intro" : ""}">
      <div class="stats-heading">
        <button class="back-button round-back" type="button" data-action="stats-back" aria-label="Back">${BACK_ICON}<span class="back-label">Back</span></button>
        <h1>Your record</h1>
        <div class="stats-tabs" role="tablist" aria-label="Stats">
          ${panels.map(([id, label]) => `
            <button class="stats-tab ${state.statsTab === id ? "is-active" : ""}" type="button" role="tab" id="stats-tab-${id}" aria-controls="stats-panel-${id}" aria-selected="${state.statsTab === id}" tabindex="${state.statsTab === id ? 0 : -1}" data-action="stats-tab" data-tab="${id}">
              ${label}${id === "badges" && state.statsNewBadges.size ? '<span class="tab-dot" aria-label="new"></span>' : ""}
            </button>
          `).join("")}
        </div>
      </div>
      <div class="stats-body">
        ${panels.map(([id, label, html]) => `
          <section class="stats-panel stats-${id} scroll-area ${state.statsTab === id ? "is-active" : ""}" id="stats-panel-${id}" role="tabpanel" aria-labelledby="stats-tab-${id}" aria-label="${label}">
            ${html}
          </section>
        `).join("")}
      </div>
    </main>
  `;
}

// Opening the stats screen: the medal pops, the ribbon stamps, the counters count up and the
// rank bar fills, once. Badges earned since the last visit are marked new for this visit.
function openStats() {
  if (!state.progressStore || state.snapshot?.phase === "playing") {
    return;
  }
  const returnTo = state.screen === "stage" || state.screen === "puzzle" ? state.stage?.id ?? null : null;
  const seen = seenBadges();
  const earned = computeStats(state.progressStore, STAGES).badges.filter((badge) => badge.earned).map((badge) => badge.id);
  navigate(() => {
    clearPuzzle();
    state.statsReturn = returnTo;
    state.statsTab = "overview";
    state.statsIntro = true;
    state.statsNewBadges = new Set(earned.filter((id) => !seen.has(id)));
    state.seenBadges = new Set([...seen, ...earned]);
    saveSeenBadges(state.seenBadges);
    state.screen = "stats";
  });
}

function leaveStats() {
  if (state.statsReturn) {
    openStage(state.statsReturn);
  } else {
    openWorldMap();
  }
}

function countUpStats() {
  for (const element of app.querySelectorAll(".stats-screen [data-count]")) {
    const target = Number(element.dataset.count);
    if (!target || prefersReducedMotion()) {
      continue;
    }
    const started = performance.now();
    const duration = 750;
    const tick = (now) => {
      const t = Math.min(1, (now - started) / duration);
      element.textContent = String(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1 && element.isConnected) {
        requestAnimationFrame(tick);
      }
    };
    element.textContent = "0";
    requestAnimationFrame(tick);
  }
}

// The tutorial's "move this one here" arrow, in its own layer so right-click annotations
// (which replace their layers' contents) can't wipe it.
function renderTutorialHint(hint) {
  if (!hint) {
    return "";
  }
  const { shaft, head } = arrowGeometry(hint.from, hint.to);
  const points = (list) => list.map(([x, y]) => `${+x.toFixed(4)},${+y.toFixed(4)}`).join(" ");
  const [fromX, fromY] = squareCenter(hint.from);
  const [toX, toY] = squareCenter(hint.to);
  return `<svg class="board-hint" viewBox="0 0 8 8" aria-hidden="true">
    <rect class="hint-target" x="${toX - 0.5}" y="${toY - 0.5}" width="1" height="1" rx="0.06"/>
    <circle class="hint-source" cx="${fromX}" cy="${fromY}" r="0.46"/>
    <g class="hint-arrow">
      <polyline points="${points(shaft)}" fill="none" stroke-width="0.2" stroke-linejoin="miter"/>
      <polygon points="${points(head)}"/>
    </g>
  </svg>`;
}

function renderBoard(fen, premoves, lastMove, selectedSquare, legalTargets, hint = null) {
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
    ${renderTutorialHint(hint)}
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

// Where each queued premove stands once the line is played: done, the one just played
// (or the mating move), still to come, the one that became illegal, or never needed
// because mate came first.
function premoveStatus(index) {
  const { phase, outcome, premovesPlayed, failedPremove } = state.snapshot;
  if (phase === "planning") {
    return "";
  }
  if (index === failedPremove) {
    return "is-failed";
  }
  if (index === premovesPlayed - 1) {
    return phase === "complete" && outcome === "victory" ? "is-current is-winning" : "is-current";
  }
  if (index < premovesPlayed) {
    return "is-played";
  }
  return phase === "playing" ? "is-upcoming" : "is-unused";
}

const PREMOVE_STATUS_LABELS = {
  "is-played": "played",
  "is-current": "playing now",
  "is-current is-winning": "checkmate",
  "is-upcoming": "to come",
  "is-failed": "became illegal",
  "is-unused": "not needed",
};

// The premove tray: the queued line as a row of chunky tiles (the piece that moves over the
// square it goes to), like a combo or inventory bar. The puzzle's perfect count sets how
// many slots there are: empty slots carry a faint star and the next one to fill pulses.
// Going past perfect just adds tiles. Tapping the last tile undoes it.
function premovePiece(move) {
  if (move.san.startsWith("O-O")) {
    return "k";
  }
  const letter = move.san[0];
  return "KQRBN".includes(letter) ? letter.toLowerCase() : "p";
}

// Pieces show just their destination (the image says which piece moved); castling and
// pawn moves show their SAN, so a pawn capture keeps the file it came from (hxg8=R, not g8=R).
function premoveLabel(move) {
  if (move.san.startsWith("O-O") || premovePiece(move) === "p") {
    return move.san.replace(/[+#]/g, "");
  }
  return move.to;
}

function renderTrayTile(move, index, { par, last, planning, playerColor, fresh }) {
  const status = premoveStatus(index);
  const label = PREMOVE_STATUS_LABELS[status];
  const image = pieceImage(playerColor, premovePiece(move));
  const inPar = par !== null && index < par;
  const face = `
    <span class="tile-step" aria-hidden="true">${index + 1}</span>
    <span class="tile-piece" aria-hidden="true">${image ? `<img src="${escapeHTML(image)}" alt="" draggable="false" />` : pieceSymbols[playerColor][premovePiece(move)]}</span>
    <span class="tile-square" aria-hidden="true">${escapeHTML(premoveLabel(move))}</span>
    <span class="visually-hidden">${escapeHTML(move.san)}${label ? `, ${label}` : ""}</span>
  `;
  const classes = `tray-tile ${status} ${inPar ? "is-par" : ""} ${fresh && !prefersReducedMotion() ? "is-new" : ""}`;
  return `<li class="tray-slot" ${status.startsWith("is-current") ? 'aria-current="step"' : ""}>${planning && last
    ? `<button class="${classes} is-last" type="button" data-action="undo" title="Undo ${escapeHTML(move.san)}">${face}<span class="tile-undo" aria-hidden="true">×</span><span class="visually-hidden">, tap to undo</span></button>`
    : `<span class="${classes}">${face}</span>`}</li>`;
}

function renderPremoves() {
  const { premoves, phase, minimumMoves, playerColor } = state.snapshot;
  const planning = phase === "planning";
  const par = minimumMoves;
  const added = planning && premoves.length > state.trayCount;
  state.trayCount = premoves.length;
  const tiles = premoves.map((move, index) => renderTrayTile(move, index, {
    par, planning, playerColor, last: index === premoves.length - 1, fresh: added && index === premoves.length - 1,
  }));
  // while planning, the rest of the perfect line shows as empty slots to fill
  const empty = planning && par !== null ? Math.max(0, par - premoves.length) : 0;
  const slots = Array.from({ length: empty }, (_, offset) => `
    <li class="tray-slot" aria-hidden="true"><span class="tray-tile is-empty is-par ${offset === 0 ? "is-next" : ""}"><span class="tile-star">★</span></span></li>
  `);
  if (planning && par === null && premoves.length === 0) {
    slots.push('<li class="tray-slot" aria-hidden="true"><span class="tray-tile is-empty is-next"></span></li>');
  }
  return `<ol class="premove-tray" aria-label="Your premoves">${tiles.join("")}${slots.join("")}</ol>`;
}

// The count against the perfect line, top right of the panel: "2/3 ★", grey once over.
function renderParMeter() {
  const { premoves, minimumMoves } = state.snapshot;
  const count = premoves.length;
  if (minimumMoves === null) {
    return `<span class="par-meter">${plural(count, "premove")}</span>`;
  }
  const over = count > minimumMoves;
  return `<span class="par-meter ${over ? "is-over" : count === minimumMoves ? "is-full" : ""}" title="${over ? "More premoves than a perfect solve needs" : `Perfect is ${minimumMoves}`}">
    <span aria-hidden="true">${count}<small>/${minimumMoves}</small> <span class="par-star">★</span></span>
    <span class="visually-hidden">${plural(count, "premove")} queued; a perfect solve takes ${minimumMoves}</span>
  </span>`;
}

// Scrolls the move list (a horizontal strip or a vertical list) to keep the premove being
// played in view, without moving anything else on the page.
function keepCurrentPremoveVisible(list) {
  const current = list?.querySelector(".tray-slot[aria-current]");
  if (!current) {
    return false;
  }
  const listRect = list.getBoundingClientRect();
  const rect = current.getBoundingClientRect();
  const left = list.scrollLeft + rect.left - listRect.left - (list.clientWidth - rect.width) / 2;
  const top = list.scrollTop + rect.top - listRect.top - (list.clientHeight - rect.height) / 2;
  list.scrollTo({ left: Math.max(0, left), top: Math.max(0, top) });
  return true;
}

function renderOutcome() {
  const { phase, outcome, message } = state.snapshot;
  if (phase === "planning") {
    return "";
  }
  if (phase === "playing") {
    return ""; // the panel's title row says it's playing
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

  const victory = outcome === "victory"; // otherwise a defeat: only checkmate solves a level
  if (state.tutorial) {
    return renderTutorialOutcome(victory);
  }
  const { perfect, minimumMoves, movesUsed } = state.snapshot;
  if (victory && perfect) {
    return `
    <div class="outcome-card is-perfect ${state.revealOutcome ? "is-revealing" : ""}" role="status">
      <p class="eyebrow">Perfect solve</p>
      <div class="outcome-heading">
        <h3><span class="perfect-star" aria-hidden="true">★</span> Perfect!</h3>
        ${renderChessComLink()}
      </div>
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
  const title = victory ? "Checkmate!" : "Not this time";
  const perfectHint = victory && minimumMoves
    ? `<p class="perfect-hint">You used ${plural(movesUsed, "premove")}; it can be done in ${minimumMoves}. Retry for a perfect <span aria-hidden="true">★</span></p>`
    : "";
  return `
    <div class="outcome-card ${victory ? "is-victory" : "is-defeat"} ${victory && state.revealOutcome ? "is-revealing" : ""}" role="status">
      <p class="eyebrow">${victory ? "Beautifully seen" : "Keep training"}</p>
      <div class="outcome-heading">
        <h3>${title}</h3>
        ${victory ? renderChessComLink() : ""}
      </div>
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

// After a win, beside the result's heading: the level's starting position on chess.com's
// analysis board (the same URL ppz prints), in a new tab so the game stays where it is.
function renderChessComLink() {
  const href = escapeHTML(chessComAnalysisUrl(state.puzzle.fen));
  return `<a class="chesscom-link" href="${href}" target="_blank" rel="noopener noreferrer" data-action="view-on-chesscom" aria-label="View on chess.com (opens in a new tab)"><span class="chesscom-link-verb">View on </span>chess.com <span class="external-icon" aria-hidden="true">↗</span></a>`;
}

// The tutorial's result: always a mate (only the guided line can be queued), but a defeat
// still gets a way to try again rather than a dead end.
function renderTutorialOutcome(victory) {
  const error = state.progressError ? `<p class="inline-error" role="alert">${escapeHTML(state.progressError)}</p>` : "";
  if (!victory) {
    return `
      <div class="outcome-card is-defeat" role="status">
        <p class="eyebrow">Tutorial</p>
        <h3>Not this time</h3>
        <p>${escapeHTML(state.snapshot.message)}</p>
        ${error}
        <div class="outcome-actions">
          <button class="primary-button" type="button" data-action="retry-puzzle">Try again</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="outcome-card is-perfect is-tutorial-complete ${state.revealOutcome ? "is-revealing" : ""}" role="status">
      <p class="eyebrow">${escapeHTML(COMPLETE_CARD.eyebrow)}</p>
      <h3><span class="perfect-star" aria-hidden="true">★</span> ${escapeHTML(COMPLETE_CARD.title)}</h3>
      <p>${escapeHTML(COMPLETE_CARD.text)}</p>
      ${error}
      <div class="outcome-actions">
        <button class="primary-button" type="button" data-action="finish-tutorial">To the worlds <span aria-hidden="true">→</span></button>
        <button class="secondary-button" type="button" data-action="retry-puzzle">Play again</button>
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
  const step = state.tutorial ? tutorialStep(snapshot.premoves) : null;
  const board = renderBoard(
    snapshot.fen,
    planning ? snapshot.premoves : [],
    snapshot.lastMove,
    state.selectedSquare,
    legalTargets,
    planning && !state.tutorialIntro ? step?.next : null,
  );
  const moveCount = snapshot.premoves.length;

  const stage = getStage(state.level.stageId);
  const coach = state.tutorial
    ? (snapshot.phase === "complete" || snapshot.phase === "error" ? null : planning ? step.coach : PLAYING_COACH)
    : (planning ? levelCoach(stage) : null);
  return `
    ${renderHeader()}
    <main class="puzzle-screen ${state.tutorial ? "is-tutorial" : ""} ${hasCoach() ? "has-coach" : ""}" data-theme="${stage.theme}">
      <div class="game-layout" ${hasCoach() && state.coachPanelHeight ? `style="--coach-panel: ${state.coachPanelHeight}px"` : ""}>
        ${state.tutorial ? renderTutorialHeading() : `<div class="puzzle-heading">
          <button class="back-button" type="button" data-action="open-stage" data-stage-id="${stage.id}" aria-label="Back to ${escapeHTML(stage.name)}" ${snapshot.phase === "playing" ? "disabled" : ""}>
            ${BACK_ICON} <span class="back-label">${escapeHTML(stage.name)}</span>
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
        </div>`}

        <section class="board-column" aria-label="Puzzle board">
          <div class="board-frame">
            <div class="board-label is-opponent">Opponent · Black</div>
            ${board}
            <div class="board-label is-player"><span class="player-dot"></span>You · White</div>
          </div>
        </section>

        <aside class="control-panel is-${snapshot.phase} ${coach ? "has-coach" : ""}">
          ${coach ? renderCoach(coach, state.interactionError) : ""}
          ${snapshot.phase === "planning" || snapshot.phase === "playing" ? `
            <div class="panel-top">
              ${planning
                ? "<h2>Your premoves</h2>"
                : '<h2 class="run-status" aria-live="polite"><span class="spinner" aria-hidden="true"></span>Playing your line…</h2>'}
              ${renderParMeter()}
            </div>
          ` : ""}
          ${planning && moveCount === 0 && !coach ? '<p class="panel-hint">Move your pieces on the board to queue premoves.</p>' : ""}
          ${state.interactionError && !coach ? `<p class="inline-error" role="alert">${escapeHTML(state.interactionError)}</p>` : ""}
          ${state.executionError && snapshot.phase !== "error" ? `<p class="inline-error" role="alert">${escapeHTML(state.executionError)}</p>` : ""}
          ${coach && snapshot.phase === "playing" ? "" : renderOutcome()}

          <div class="tray-wrap" role="region" aria-live="polite" aria-label="Queued premoves">
            ${renderPremoves()}
          </div>

          ${planning ? `
            <div class="planning-actions">
              <button class="secondary-button undo-button" type="button" data-action="undo" aria-label="Undo last premove" title="Undo last premove" ${moveCount === 0 ? "disabled" : ""}>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 7H4.5V2.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.8 7a8 8 0 1 1-1.3 6.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
              </button>
              <button class="primary-button submit-button ${step && !step.next ? "is-beckoning" : ""}" type="button" data-action="submit" ${moveCount === 0 || (step && step.next) ? "disabled" : ""}>
                <span class="submit-label">I'm done premoving</span><span class="submit-short-label" aria-hidden="true">Done</span>
                <svg class="submit-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>
              </button>
            </div>
          ` : ""}
        </aside>
      </div>
      ${renderPromotionDialog()}
      ${state.tutorialIntro ? renderTutorialIntro() : ""}
    </main>
  `;
}

function renderTutorialHeading() {
  return `
    <div class="puzzle-heading">
      <button class="back-button" type="button" data-action="home" aria-label="Back to the world map" ${state.snapshot.phase === "playing" ? "disabled" : ""}>
        ${BACK_ICON} <span class="back-label">All worlds</span>
      </button>
      <p class="level-kicker">
        <span class="level-badge tutorial-badge" aria-hidden="true">?</span>
        <span class="level-kicker-text">Tutorial</span>
      </p>
      <h1>${escapeHTML(state.puzzle.title)}</h1>
      <p class="par-line"><span class="par-chip">Tutorial</span><span class="par-chip is-attempts">About a minute</span></p>
    </div>
  `;
}

// Each world's mascot narrates its levels (the tutorial's pawn is World 1's).
const NARRATORS = { p: "Pawn", n: "Knight", b: "Bishop", r: "Rook", q: "Queen", k: "King" };
// The longest nudge a level shows, so the bubble keeps room for it (see renderCoach).
const LEVEL_NUDGE_SIZER = "That move is not legal from e2.";

/** Whether the puzzle screen has a coach while planning: the tutorial, or a level with a message. */
function hasCoach() {
  return state.screen === "puzzle" && (state.tutorial || Boolean(state.puzzle?.description?.trim()));
}

/** A level's coach: the world's mascot saying the level's description. */
function levelCoach(stage) {
  const text = state.puzzle.description?.trim();
  if (!text) {
    return null;
  }
  const narrator = NARRATORS[stage.piece] ?? "Coach";
  return { title: narrator, text, piece: stage.piece, titles: [narrator, LEVEL_NUDGE_SIZER], texts: [], live: false };
}

// The coach: a piece in a round frame with a speech bubble at the top of the panel. The
// tutorial's pawn says what to do next; on a level, the world's mascot says the level's
// message. A nudge (a move that isn't allowed) takes the title's place. Invisible copies of
// every title and text the coach can show sit under the real ones (.coach-sizer), so the
// bubble keeps one height: the panel keeps its size and the board doesn't jump.
function renderCoach({ title, text, piece = "p", titles = COACH_TITLES, texts = COACH_TEXTS, live = true }, nudge = "") {
  const image = pieceImage("w", piece);
  const sizers = (lines, className) => lines
    .map((line) => `<p class="${className} coach-sizer" aria-hidden="true">${escapeHTML(line)}</p>`).join("");
  return `
    <div class="coach" ${live ? 'role="status" aria-live="polite"' : ""}>
      <span class="coach-avatar" aria-hidden="true">${image ? `<img src="${escapeHTML(image)}" alt="" draggable="false" />` : pieceSymbols.w[piece]}</span>
      <div class="coach-bubble">
        <div class="coach-stack">
          <p class="coach-title ${nudge ? "is-nudge" : ""}" ${nudge ? 'role="alert"' : ""}>${escapeHTML(nudge || title)}</p>
          ${sizers(titles, "coach-title")}
        </div>
        <div class="coach-stack">
          <p class="coach-text">${escapeHTML(text)}</p>
          ${sizers(texts, "coach-text")}
        </div>
      </div>
    </div>
  `;
}

// With a coach, the panel is taller than without one, and on portrait screens the board gets
// whatever height the panel's row leaves. So that row reserves exactly what the planning panel
// needs (--coach-panel, read by ui/coach.css): the coach never changes height, and the
// playback and result panels are smaller, so the board keeps one size from planning to the
// result. Measured after each planning render and on resize; the panel is aligned to the end
// of its row, so its height is its content's.
function fitCoachPanel() {
  if (!hasCoach() || state.snapshot?.phase !== "planning") {
    return;
  }
  const panel = app.querySelector(".control-panel");
  const layout = app.querySelector(".game-layout");
  if (!panel || !layout) {
    return;
  }
  const height = Math.ceil(panel.getBoundingClientRect().height);
  if (height > 0 && height !== state.coachPanelHeight) {
    state.coachPanelHeight = height;
    layout.style.setProperty("--coach-panel", `${height}px`);
  }
}

function renderTutorialIntro() {
  const image = pieceImage("w", "p");
  return `
    <div class="modal-backdrop tutorial-backdrop" role="presentation">
      <section class="tutorial-intro" role="dialog" aria-modal="true" aria-labelledby="tutorial-intro-title" data-theme="meadow">
        <div class="tutorial-intro-scene" aria-hidden="true">
          ${renderScene("meadow")}
          <span class="tutorial-intro-mascot">${image ? `<img src="${escapeHTML(image)}" alt="" draggable="false" />` : pieceSymbols.w.p}</span>
        </div>
        <div class="tutorial-intro-body">
          <p class="eyebrow">${escapeHTML(TUTORIAL_INTRO.eyebrow)}</p>
          <h2 id="tutorial-intro-title">${escapeHTML(TUTORIAL_INTRO.title)}</h2>
          ${TUTORIAL_INTRO.paragraphs.map((text) => `<p>${escapeHTML(text)}</p>`).join("")}
          <button class="game-button tutorial-start" type="button" data-action="tutorial-start" autofocus>${escapeHTML(TUTORIAL_INTRO.button)} <span aria-hidden="true">→</span></button>
        </div>
      </section>
    </div>
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
  const previousList = app.querySelector(".tray-wrap");
  const previousMoveCount = previousList?.querySelectorAll(".tray-tile:not(.is-empty)").length ?? 0;
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
  } else if (state.screen === "stats") {
    app.innerHTML = renderStats();
  } else if (state.screen === "sounds" && import.meta.env.DEV) {
    app.innerHTML = renderSoundBoard();
  }
  fitCoachPanel();
  if (state.tutorialIntro && state.screen === "puzzle") {
    app.querySelector(".tutorial-start")?.focus({ preventScroll: true }); // a dialog takes focus
  }
  if (state.screen === "stats" && state.statsIntro) {
    state.statsIntro = false;
    countUpStats();
  }

  const moveList = app.querySelector(".tray-wrap");
  if (keepCurrentPremoveVisible(moveList)) {
    // during playback the list follows the move being played
  } else if (moveList && previousScroll) {
    const moveCount = moveList.querySelectorAll(".tray-tile:not(.is-empty)").length;
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
    if (outcome === "defeat") {
      sounds.play("defeat"); // wins already got their fanfare as mate landed
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
  if (touchDrag.dragging) {
    // re-rendered mid-drag: keep the lifted piece's square marked
    app.querySelector(`[data-square="${touchDrag.from}"]`)?.classList.add("is-drag-source");
    const over = touchDrag.over;
    touchDrag.over = null;
    markDragOver(over);
  }
  music.update(musicTarget());
  syncHistory();
}

// ---- The system Back button ----
// While you're inside a world the app keeps one history entry of its own, so Back (Android's
// back button or gesture, the browser's Back, a swipe on iOS) steps up through the screens
// like an app's back button (level → level map → world map) instead of leaving the game.
// On the world map there is no entry left, so Back leaves the page as usual.
let historyEntry = false;
let ignoreNextPop = false;

function syncHistory() {
  if (!window.history?.pushState) {
    return;
  }
  const inside = state.screen === "stage" || state.screen === "puzzle" || state.screen === "sounds" || state.screen === "stats";
  if (inside && !historyEntry) {
    history.pushState({ premove: "in-game" }, "");
    historyEntry = true;
  } else if (state.screen === "index" && historyEntry) {
    // came back up with the in-app buttons: drop the entry so Back now leaves the page
    historyEntry = false;
    ignoreNextPop = true;
    history.back();
  }
}

function goBack() {
  if (state.screen === "puzzle") {
    if (state.promotionRequest) {
      state.promotionRequest = null;
      render();
    } else if (state.snapshot?.phase === "playing") {
      syncHistory(); // can't leave mid-line: put the entry back
    } else if (state.tutorial) {
      sounds.play("back");
      openWorldMap();
    } else {
      sounds.play("back");
      openStage(state.level.stageId);
    }
  } else if (state.screen === "stats") {
    sounds.play("back");
    leaveStats();
  } else if (state.screen === "stage" || state.screen === "sounds") {
    sounds.play("back");
    openWorldMap();
  }
}

// Rotating or resizing changes how the coach wraps, so the panel is re-fitted.
window.addEventListener("resize", fitCoachPanel);

window.addEventListener("popstate", () => {
  if (ignoreNextPop) {
    ignoreNextPop = false;
    return;
  }
  if (historyEntry) {
    historyEntry = false;
    goBack();
  }
});

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
      unlockWorldCard(element, reduced);
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

// A world card goes from locked (grey scene, black silhouette) to open. Animating `filter` to
// get there repaints the scene and the piece every frame (the piece's drop-shadow stops Chrome
// from compositing it at all, and drags its bob onto the main thread too), so it stuttered. Instead
// the locked look stays behind as static "veils" (a grey copy of the scene, a black copy of
// the piece) over the now-colourful originals, and only their opacity animates, which runs
// on the compositor. Each veil removes itself when it has faded.
function unlockWorldCard(card, reduced) {
  if (!reduced) {
    const scene = card.querySelector(".scene");
    const piece = card.querySelector(".landmark img, .landmark-glyph");
    for (const [original, kind] of [[scene, "scene"], [piece, "piece"]]) {
      if (!original) continue;
      const veil = original.cloneNode(true);
      veil.classList.add("unlock-veil", `unlock-veil-${kind}`);
      veil.setAttribute("aria-hidden", "true");
      veil.addEventListener("animationend", () => veil.remove(), { once: true });
      original.after(veil);
    }
  }
  // The shadow, border and colours change with the class; let them switch in one paint
  // rather than run the card's hover transition (a repaint per frame for box-shadow).
  card.style.transition = "none";
  card.classList.add("is-unlocking");
  card.classList.remove("is-locked");
  void getComputedStyle(card).boxShadow; // apply the new style before transitions come back
  card.style.removeProperty("transition");
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
    state.tutorialStore ??= createTutorialStore(undefined, { progress: state.progressStore });
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
  state.tutorial = false;
  state.tutorialIntro = false;
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
  if (!(state.progressStore.isStageUnlocked(stage.id) && tutorialDone()) && !import.meta.env.DEV) {
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
  if (!state.progressStore.isUnlocked(id) || (!tutorialDone() && !import.meta.env.DEV)) {
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

// The tutorial plays on the puzzle screen with a coach in the panel. It opens with a welcome
// card the first time; "Play again" skips straight to the board.
function openTutorial({ intro = true } = {}) {
  const show = () => {
    resetLevel(TUTORIAL_LEVEL);
    state.tutorial = true;
    state.tutorialIntro = intro;
    state.screen = "puzzle";
  };
  if (state.screen !== "puzzle") {
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
  state.trayCount = 0;
  state.pendingPieceMove = null;
  state.pendingCelebration = null;
  state.revealOutcome = false;
  state.tutorial = false;
  state.tutorialIntro = false;
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
  // the tutorial only takes the move its arrow points at
  if (state.tutorial && !isTutorialMove(state.snapshot.premoves, { from, to })) {
    state.interactionError = tutorialStep(state.snapshot.premoves).next ? WRONG_MOVE_MESSAGE : PLAN_COMPLETE_MESSAGE;
    sounds.play("illegal");
    state.selectedSquare = null;
    render();
    return;
  }
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
  if (state.screen !== "puzzle" || state.snapshot.phase !== "planning" || state.promotionRequest || state.tutorialIntro) {
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

// The tutorial's mate opens the worlds; the first time, World 1's card unlocks with a burst
// when the world map shows next.
function finishTutorial() {
  const firstTime = !state.tutorialStore.isDone();
  if (firstTime) {
    state.fresh.unlockedStage = "1";
  }
  state.tutorialStore.markDone();
}

async function submitPremoves() {
  sounds.play("submit");
  state.interactionError = "";
  state.executionError = "";
  // every submitted line counts as an attempt; shown on the puzzle page (not the tutorial)
  try {
    if (!state.tutorial) {
      state.progressStore.recordAttempt(state.level.id);
    }
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
            if (state.tutorial) {
              finishTutorial();
            } else {
              recordWin(state.level, snapshot.perfect);
            }
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
    } else if (action === "stats") {
      if (state.screen !== "stats") {
        sounds.play("open");
        openStats();
      }
    } else if (action === "stats-back") {
      sounds.play("back");
      leaveStats();
    } else if (action === "stats-tab") {
      if (state.statsTab !== actionElement.dataset.tab) {
        sounds.play("click");
        state.statsTab = actionElement.dataset.tab;
        render();
        app.querySelector(`#stats-tab-${state.statsTab}`)?.focus();
      }
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
      if (state.tutorial) {
        openTutorial({ intro: false });
      } else {
        openLevel(state.level.id);
      }
    } else if (action === "open-tutorial") {
      sounds.play("open");
      openTutorial();
    } else if (action === "tutorial-start") {
      sounds.play("click");
      state.tutorialIntro = false;
      render();
    } else if (action === "finish-tutorial") {
      sounds.play("open");
      openWorldMap();
    } else if (action === "view-on-chesscom") {
      sounds.play("click"); // the link opens chess.com in a new tab by itself
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
  if (squareElement && performance.now() > touchDrag.suppressClickUntil) {
    selectSquare(squareElement.dataset.square);
  }
});

app.addEventListener("dragstart", (event) => {
  const squareElement = event.target.closest("[data-square]");
  if (!squareElement || state.snapshot?.phase !== "planning") {
    return;
  }
  if (touchDrag.pointerId !== null || touchDrag.lastPointerType !== "mouse") {
    event.preventDefault(); // a finger or pen: the pointer drag below handles it
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

// ---- Dragging pieces by touch (and pen) ----
// HTML5 drag and drop (above) only works with a mouse, so fingers and pens get their own
// drag built on pointer events, like chess.com's mobile board: touch a piece and slide it,
// it lifts (a little larger, so it shows past your finger), the square under your finger is
// outlined, and letting go queues the move. A touch that doesn't move is still a tap and
// goes through tap-to-move. Nothing re-renders mid-drag: the selection and its legal
// targets are painted onto the existing squares, and the drop goes through attemptMove.
const DRAG_START_DISTANCE = 6; // px of travel before a touch counts as a drag, not a tap
const touchDrag = {
  pointerId: null, // the finger/pen holding a piece (pressed on one of yours)
  lastPointerType: "mouse",
  from: null,
  startX: 0,
  startY: 0,
  dragging: false, // past the threshold: the piece is lifted
  ghost: null, // the floating piece, a child of <body> so renders can't touch it
  over: null, // the square under the finger
  suppressClickUntil: 0,
};

function paintSelection(square) {
  const targets = new Set(state.session.legalMovesFrom(square).map((move) => move.to));
  for (const element of app.querySelectorAll(".board [data-square]")) {
    const name = element.dataset.square;
    element.classList.toggle("is-selected", name === square);
    element.classList.toggle("is-legal-target", targets.has(name));
  }
}

function markDragOver(square) {
  if (touchDrag.over === square) {
    return;
  }
  app.querySelector(".square.is-drag-over")?.classList.remove("is-drag-over");
  touchDrag.over = square;
  if (square) {
    app.querySelector(`[data-square="${square}"]`)?.classList.add("is-drag-over");
  }
}

function moveGhost(clientX, clientY) {
  const ghost = touchDrag.ghost;
  if (ghost) {
    ghost.style.transform = `translate3d(${clientX - ghost.offsetWidth / 2}px, ${clientY - ghost.offsetHeight / 2}px, 0)`;
  }
}

function liftPiece(clientX, clientY) {
  const squareElement = app.querySelector(`[data-square="${touchDrag.from}"]`);
  const pieceElement = squareElement?.querySelector(".piece");
  if (!pieceElement) {
    return false;
  }
  touchDrag.dragging = true;
  state.selectedSquare = touchDrag.from;
  state.interactionError = "";
  app.querySelector(".inline-error")?.remove();
  paintSelection(touchDrag.from);
  const size = squareElement.getBoundingClientRect().width;
  const ghost = document.createElement("div");
  ghost.className = `drag-ghost ${touchDrag.lastPointerType === "touch" ? "is-touch" : ""}`;
  ghost.style.width = `${size}px`;
  ghost.style.height = `${size}px`;
  ghost.append(pieceElement.cloneNode(true));
  document.body.append(ghost);
  touchDrag.ghost = ghost;
  squareElement.classList.add("is-drag-source");
  moveGhost(clientX, clientY);
  markDragOver(squareAtPoint(clientX, clientY));
  return true;
}

function endTouchDrag() {
  touchDrag.ghost?.remove();
  touchDrag.ghost = null;
  markDragOver(null);
  app.querySelectorAll(".is-drag-source").forEach((element) => element.classList.remove("is-drag-source"));
  touchDrag.pointerId = null;
  touchDrag.from = null;
  touchDrag.dragging = false;
}

app.addEventListener("pointerdown", (event) => {
  touchDrag.lastPointerType = event.pointerType;
  if (event.pointerType === "mouse" || touchDrag.pointerId !== null || !event.isPrimary) {
    return;
  }
  const squareElement = event.target.closest(".board [data-square]");
  if (!squareElement || state.screen !== "puzzle" || state.snapshot?.phase !== "planning" || state.promotionRequest) {
    return;
  }
  const square = squareElement.dataset.square;
  if (parsePlacement(state.snapshot.fen).get(square)?.color !== state.snapshot.playerColor) {
    return; // not your piece: an ordinary tap (e.g. a destination for tap-to-move)
  }
  touchDrag.pointerId = event.pointerId;
  touchDrag.from = square;
  touchDrag.startX = event.clientX;
  touchDrag.startY = event.clientY;
});

window.addEventListener("pointermove", (event) => {
  if (event.pointerId !== touchDrag.pointerId) {
    return;
  }
  if (!touchDrag.dragging) {
    const travel = Math.hypot(event.clientX - touchDrag.startX, event.clientY - touchDrag.startY);
    if (travel < DRAG_START_DISTANCE || !liftPiece(event.clientX, event.clientY)) {
      return;
    }
  }
  moveGhost(event.clientX, event.clientY);
  markDragOver(squareAtPoint(event.clientX, event.clientY));
});

window.addEventListener("pointerup", (event) => {
  if (event.pointerId !== touchDrag.pointerId) {
    return;
  }
  const { from, dragging } = touchDrag;
  const to = dragging ? squareAtPoint(event.clientX, event.clientY) : null;
  endTouchDrag();
  if (!dragging) {
    return; // a tap: the click that follows does tap-to-move
  }
  touchDrag.suppressClickUntil = performance.now() + 400;
  if (to && to !== from && state.snapshot?.phase === "planning" && !state.promotionRequest) {
    attemptMove(from, to);
  } else {
    // dropped back on its square or off the board: the piece goes home, still selected
    render();
  }
});

window.addEventListener("pointercancel", (event) => {
  if (event.pointerId === touchDrag.pointerId) {
    const dragging = touchDrag.dragging;
    endTouchDrag();
    if (dragging) {
      render();
    }
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
  if (event.key === "Escape" && state.tutorialIntro && state.screen === "puzzle") {
    sounds.play("click"); // Escape closes the welcome card, like a dialog
    state.tutorialIntro = false;
    render();
  } else if (event.key === "Escape" && state.screen === "stage") {
    sounds.play("back");
    openWorldMap();
  } else if (event.key === "Escape" && state.screen === "stats") {
    sounds.play("back");
    leaveStats();
  } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.target.closest?.(".stats-tab")) {
    // arrow keys move between the stats tabs, as in any tab list
    const tabs = [...app.querySelectorAll(".stats-tab")];
    const next = tabs[(tabs.indexOf(event.target.closest(".stats-tab")) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next?.click();
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

// Offline support: the production build ships a service worker that precaches the game
// (see src/service-worker.js). Not in development, where Vite serves files live.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Offline support is unavailable:", error);
    });
  });
}

void initializeApp();
