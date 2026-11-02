import { createPremoveOpponent, loadPremoveEngine } from "./engine/premoveOpponent.js";
import { boardRows, parsePlacement } from "./game/premoveRules.js";
import { createPremoveGame } from "./game/session.js";
import { getPuzzle, PUZZLES } from "./game/puzzles.js";
import { createProgressStore } from "./game/progress.js";
import "./style.css";

const app = document.querySelector("#app");
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
  puzzle: null,
  session: null,
  snapshot: null,
  selectedSquare: null,
  promotionRequest: null,
  pendingPieceMove: null,
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
  return `
    <header class="topbar">
      <button class="brand" type="button" data-action="home" aria-label="Go to puzzle index" ${state.engine ? "" : "disabled"}>
        <span class="brand-mark" aria-hidden="true">♞</span>
        <span>PREMOVE</span>
      </button>
      <span class="engine-pill ${state.engine ? "is-ready" : ""}">
        <span class="status-dot"></span>${engineStatus}
      </span>
    </header>
  `;
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

function renderIndex() {
  const completedCount = state.progressStore.completedIds().length;
  const perfectedCount = state.progressStore.perfectedIds().length;
  const levelCards = PUZZLES.map((puzzle) => {
    const completed = state.progressStore.isCompleted(puzzle.id);
    const perfected = state.progressStore.isPerfected(puzzle.id);
    const unlocked = state.progressStore.isUnlocked(puzzle.id);
    const status = perfected ? "Perfected" : completed ? "Completed" : unlocked ? "Ready to play" : "Locked";
    return `
      <button
        class="level-card ${perfected ? "is-perfect" : completed ? "is-complete" : ""} ${unlocked ? "" : "is-locked"}"
        type="button"
        data-action="open-puzzle"
        data-puzzle-id="${puzzle.id}"
        ${unlocked ? "" : "disabled"}
        aria-label="Level ${puzzle.id}, ${status}"
      >
        <span class="level-number">${puzzle.id}</span>
        <span class="level-mark" aria-hidden="true">${perfected ? "★" : completed ? "✓" : unlocked ? "→" : "•"}</span>
        <span class="level-title">LEVEL ${puzzle.id}</span>
        <span class="level-status">${status}</span>
      </button>
    `;
  }).join("");

  return `
    ${renderHeader()}
    <main class="index-screen">
      <section class="index-hero">
        <p class="eyebrow">Chess vision trainer</p>
        <h1>See the mate<br />before you move.</h1>
        <p class="index-copy">Read the position, queue your line, and trust your vision when the board starts moving.</p>
      </section>
      <section class="levels-section" aria-labelledby="levels-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Your training path</p>
            <h2 id="levels-heading">Puzzle index</h2>
          </div>
          <div class="completion-count">
            <strong>${completedCount}<span> / ${PUZZLES.length}</span></strong>
            <small>completed${perfectedCount ? ` · <span class="perfect-count">★ ${perfectedCount} perfect</span>` : ""}</small>
          </div>
        </div>
        <div class="level-grid">${levelCards}</div>
        <p class="unlock-note">Complete a level to unlock the next one. Solve it in the minimum number of premoves to perfect it <span class="perfect-star" aria-hidden="true">★</span></p>
      </section>
      <footer class="app-footer">Chess rules by chess.js · Opponent searches every reply to your premoves</footer>
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
          class="square ${isLight ? "light-square" : "dark-square"} ${isSelected ? "is-selected" : ""} ${isPremove ? "is-premove" : ""} ${isLastMove ? "is-last-move" : ""} ${isLegalTarget ? "is-legal-target" : ""}"
          type="button"
          data-square="${square}"
          aria-label="${square}, ${pieceLabel}${isLegalTarget ? ", legal destination" : ""}"
          ${canDrag ? 'draggable="true"' : ""}
        >
          ${piece ? renderPiece(piece.color, piece.type) : ""}
          ${rankLabel}
          ${fileLabel}
        </button>
      `);
    }
  }
  return `<div class="board" role="group" aria-label="Chessboard">${squares.join("")}</div>`;
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
    <div class="outcome-card is-perfect" role="status">
      <p class="eyebrow">Perfect solve</p>
      <h3><span class="perfect-star" aria-hidden="true">★</span> Perfect!</h3>
      <p>Checkmate in ${plural(minimumMoves, "premove")}, the fewest possible. Flawless vision.</p>
      ${state.progressError ? `<p class="inline-error" role="alert">${escapeHTML(state.progressError)}</p>` : ""}
      <div class="outcome-actions">
        ${nextPuzzle() ? '<button class="primary-button" type="button" data-action="next-puzzle">Next level <span aria-hidden="true">→</span></button>' : ""}
        <button class="secondary-button" type="button" data-action="retry-puzzle">Play again</button>
        <button class="text-button" type="button" data-action="home">Puzzle index</button>
      </div>
    </div>
  `;
  }
  const title = victory ? "Checkmate!" : draw ? "Draw" : "Not this time";
  const perfectHint = victory && minimumMoves
    ? `<p class="perfect-hint">You used ${plural(movesUsed, "premove")}; it can be done in ${minimumMoves}. Retry for a perfect <span aria-hidden="true">★</span></p>`
    : "";
  return `
    <div class="outcome-card ${victory ? "is-victory" : draw ? "is-draw" : "is-defeat"}" role="status">
      <p class="eyebrow">${victory ? "Beautifully seen" : draw ? "The position is level" : "Keep training"}</p>
      <h3>${title}</h3>
      <p>${escapeHTML(message)}</p>
      ${perfectHint}
      ${state.progressError ? `<p class="inline-error" role="alert">${escapeHTML(state.progressError)}</p>` : ""}
      <div class="outcome-actions">
        <button class="secondary-button" type="button" data-action="retry-puzzle">Retry level</button>
        ${victory && nextPuzzle() ? '<button class="primary-button" type="button" data-action="next-puzzle">Next level <span aria-hidden="true">→</span></button>' : ""}
        <button class="text-button" type="button" data-action="home">Puzzle index</button>
      </div>
    </div>
  `;
}

function nextPuzzle() {
  if (!state.puzzle) {
    return null;
  }
  const index = PUZZLES.findIndex((puzzle) => puzzle.id === state.puzzle.id);
  return PUZZLES[index + 1] ?? null;
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

  return `
    ${renderHeader()}
    <main class="puzzle-screen">
      <div class="game-layout">
        <div class="puzzle-heading">
          <button class="back-button" type="button" data-action="home" ${snapshot.phase === "playing" ? "disabled" : ""}>
            <span aria-hidden="true">←</span> Puzzle index
          </button>
          <p class="eyebrow">Level ${state.puzzle.id} of ${PUZZLES.length}</p>
          <h1>${escapeHTML(state.puzzle.title)}</h1>
          ${state.puzzle.number_of_moves ? `
            <p class="par-line">
              <span class="par-chip">Perfect in ${plural(state.puzzle.number_of_moves, "premove")}</span>
              ${state.progressStore.isPerfected(state.puzzle.id) ? '<span class="par-chip is-perfect">★ Perfected</span>' : ""}
            </p>` : ""}
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
    app.innerHTML = renderIndex();
  } else if (state.screen === "puzzle") {
    app.innerHTML = renderPuzzle();
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
}

async function initializeApp() {
  state.screen = "loading";
  state.error = null;
  render();
  try {
    if (!state.progressStore) {
      state.progressStore = createProgressStore();
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

function openPuzzle(id) {
  if (!state.progressStore.isUnlocked(id)) {
    return;
  }
  state.pendingPieceMove = null;
  state.puzzle = getPuzzle(id);
  state.session = createPremoveGame(state.puzzle);
  state.snapshot = state.session.snapshot();
  state.selectedSquare = null;
  state.promotionRequest = null;
  state.interactionError = "";
  state.progressError = "";
  state.executionError = "";
  state.screen = "puzzle";
  render();
}

function queueSelectedMove(from, to, promotion) {
  try {
    state.snapshot = state.session.queueMove({ from, to, promotion });
    state.interactionError = "";
  } catch (error) {
    state.interactionError = error.message;
  }
  state.selectedSquare = null;
  state.promotionRequest = null;
  render();
}

function attemptMove(from, to) {
  const options = state.session.legalMovesFrom(from).filter((move) => move.to === to);
  if (options.length === 0) {
    state.interactionError = `That move is not legal from ${from}.`;
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

async function submitPremoves() {
  state.interactionError = "";
  state.executionError = "";
  try {
    // The opponent knows the whole submitted plan and plays the strongest defence against it.
    const opponent = createPremoveOpponent({
      engine: state.engine,
      puzzleFen: state.puzzle.fen,
      premoves: state.session.snapshot().premoves,
    });
    await state.session.play(opponent, {
      delayMs: 1_000,
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
        }
        state.snapshot = snapshot;
        if (snapshot.phase === "complete" && snapshot.outcome === "victory") {
          try {
            state.progressStore.markCompleted(state.puzzle.id, { perfect: snapshot.perfect });
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
      state.screen = "index";
      state.puzzle = null;
      state.session = null;
      state.snapshot = null;
      state.selectedSquare = null;
      state.promotionRequest = null;
      render();
    } else if (action === "retry-setup") {
      void initializeApp();
    } else if (action === "open-puzzle") {
      openPuzzle(actionElement.dataset.puzzleId);
    } else if (action === "submit" && state.snapshot.phase === "planning") {
      void submitPremoves();
    } else if (action === "undo" && state.snapshot.phase === "planning") {
      state.snapshot = state.session.undoPremove();
      state.interactionError = "";
      state.selectedSquare = null;
      render();
    } else if (action === "retry-puzzle") {
      openPuzzle(state.puzzle.id);
    } else if (action === "next-puzzle") {
      const next = nextPuzzle();
      if (next && state.progressStore.isUnlocked(next.id)) {
        openPuzzle(next.id);
      }
    } else if (action === "choose-promotion") {
      const request = state.promotionRequest;
      if (request) {
        queueSelectedMove(request.from, request.to, actionElement.dataset.promotion);
      }
    } else if (action === "cancel-promotion") {
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
  if (from) {
    attemptMove(from, squareElement.dataset.square);
  }
});

app.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.promotionRequest) {
    state.promotionRequest = null;
    render();
  }
});

void initializeApp();
