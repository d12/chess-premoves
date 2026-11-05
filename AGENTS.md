# Premove — handoff for agents

Read this before changing anything in **d12/chess-premoves**. It covers what the project is, how it is built, how the owner likes to work, and the traps already found. Facts are as of the View-on-chess.com PR (5 Nov 2026): 5 puzzles laid out as 5 worlds × 5 levels, synthesized sound effects and background music, a full-viewport app layout for every screen size, touch dragging, offline play via a service worker, playback highlighting in the move list, a stats screen, a "View on chess.com" link after a win, and 88 passing tests.

---

## 1. What this is

**Premove** is a browser chess-vision trainer, structured like a video game: **5 worlds ("stages") of 5 levels each**, picked from a world map and then from each world's level map. Each level is a position with White to move. The player queues a whole sequence of **premoves** (chess.com/lichess style) and then submits it. The game then plays the line out against an opponent that **knows the entire plan** and picks the defence that breaks it. The player wins only if the line forces checkmate against every defence. Mate may come before the last premove.

The repo has two products:

| part | where | what |
|---|---|---|
| **The game** | `src/`, `index.html`, `test/` | Static Vite web app (vanilla JS, no framework). Deployed to GitHub Pages: https://d12.github.io/chess-premoves/ |
| **The puzzle finder (`ppz`)** | `puzzle-finder/` | Python CLI plus a C++ engine that discovers, verifies, scores and curates premove puzzles, and writes them into the game (`src/game/puzzles.json`). |

The two share one piece of C++: the **refuter** (`puzzle-finder/engine/src/refute.hpp`). It is compiled to WebAssembly and bundled into the game as the opponent.

The owner, Nathaniel (GitHub `d12`), designs the puzzles and plays the game; the `ppz` tool runs on his MacBook. `design.md` is the original product brief. It is still a good statement of intent, but where it disagrees with this file, this file is current.

---

## 2. How to work with the owner

- **Every change goes in as a pull request against `main`.** Don't push to `main`, and don't send patch files: the owner prefers PRs. One focused change per PR. The owner reviews and merges, usually quickly, so always branch from a freshly pulled `main`. If an earlier PR of yours was already merged, open a follow-up PR rather than pushing to the old branch.
- PR descriptions should say what changed for the player, how it is implemented, and **how you tested it**, with concrete numbers. Mention anything you couldn't verify, such as a real mouse drag in a headless browser.
- **Match chess.com behaviour** whenever a UI question comes up (premove rules, arrows, drag and drop). The owner checks against it.
- He gives short, direct feedback ("too depressing", "should only render on release"). Take the literal request, apply it narrowly, and say in one line how you interpreted anything ambiguous. For example, "# of solutions" turned out to mean "number of attempts".
- If you find an unrelated **production bug** while working, fix it in its **own small PR** and flag it as urgent. Don't bury it in a feature PR. (The `canOpenNextPuzzle` bug, PR #9, was handled this way.)
- He commits directly to `main` himself, sometimes with refactors such as renaming `premove-puzzles/` to `puzzle-finder/`. Always `git pull` first and don't assume paths from older notes.
- **Keep this file current.** If your PR changes something described here (a path, a rule, a decision, test counts), update `AGENTS.md` in the same PR.
- GitHub tooling tip: if `gh pr create` fails because GraphQL is blocked in your environment, the REST API works:
  `gh api repos/d12/chess-premoves/pulls -f title=… -f head=<branch> -f base=main -F body=@body.md`.

---

## 3. Repository map

```
index.html, vite.config.js (base: "./" so it works under /chess-premoves/)
public/manifest.webmanifest, icon-*.png, apple-touch-icon.png   web-app manifest + icons (Add to Home Screen)
src/
  main.js                 UI: rendering, events, playback, celebrations, world/level maps (≈1300 lines)
  style.css               app shell, puzzle-page layout (container queries) and base styles; tokens on :root (--green, --gold, --gutter, --topbar-height …)
  ui/
    worlds.css            world map, level maps (incl. their responsive layouts) and per-world themes ([data-theme] tokens, keyframes)
    scenery.js            flat SVG landscapes per theme (renderScene) + per-theme confetti colours
    stats.css             the stats screen and the top bar's stats button
  game/
    session.js            UI-independent game engine: planning, premove queue, playback (createPremoveGame)
    premoveRules.js       chess.com-style *geometric* premove rules and the planning preview board
    progress.js           localStorage progress: completed, perfected, attempts, wins, first wins (createProgressStore)
    stats.js              what the stats screen shows: rank ladder, counters, worlds, badges (computeStats); seen-badge memory
    links.js              links out of the game: chessComAnalysisUrl(fen), the same URL ppz prints
    puzzles.json          the levels (written by `ppz app`)
    puzzles.js            frozen PUZZLES list + getPuzzle(id)
    stages.json           the world/level layout: which puzzle each level uses (hand-edited)
    stages.js             STAGES, LEVELS, getStage, getLevel, nextLevel, nextStage
    annotations.js        right-click arrows and highlights (pure helpers + SVG)
  engine/
    premoveOpponent.js    loads the WASM refuter; createPremoveOpponent() → { bestMove(fen), analysis }
    generated/premove-engine.js            GENERATED WASM module (Emscripten, SINGLE_FILE). Committed.
    generated/premove-engine.sources.sha256 fingerprint of the C++ it was built from
  effects/confetti.js     dependency-free canvas confetti: burst(), cannons(), PALETTES
  effects/sound.js        synthesized sound effects (Web Audio, no audio files): createSoundPlayer, synthesize, soundForMove
  effects/music.js        synthesized background music: a piece per world (SONGS), layers per screen, createMusicPlayer
  assets/pieces/*.png     Neo piece images (fall back to Unicode glyphs if missing)
test/                     node:test suites (see §7)
scripts/wasm-stamp.mjs    write/check the WASM source fingerprint
scripts/service-worker.mjs  builds dist/sw.js (precache list + version) and the Vite plugin that runs it
src/service-worker.js     the offline worker's source (not bundled; see §5.1)
scripts/download-pieces.mjs
.githooks/pre-commit      rebuild WASM if its C++ changed; check puzzles if puzzles.json is staged
.github/workflows/deploy-pages.yml   test + build on PRs; test + build + deploy on push to main
puzzle-finder/            ppz: see §6 and puzzle-finder/README.md
puzzle-building-guide.md  the owner's step-by-step guide for generating and adding puzzles
design.md                 original product brief
review_queue.jsonl        stray ppz review queue committed at the repo root; see §9
```

`npm` scripts: `dev`, `build`, `preview`, `test` (`node --test`), `build:wasm` (needs Emscripten), `check:wasm`, `download:pieces`, and `prepare`, which sets `core.hooksPath=.githooks` on `npm install`.

---

## 4. The game

### 4.1 Game rules as implemented

- **Planning.** Premoves are validated **geometrically only**, as on chess.com/lichess (`premoveRules.js`). Pieces in the way, an opponent piece on the target square, or the black king standing there do not block a premove, because the opponent moves in between. The planning board shows **White's pieces after the queued premoves** and Black's pieces where they stand now. Capturing onto an opponent piece removes it from the preview; the black king is only *hidden* while a white piece stands on its square (`preview.hiddenKing`). The player can click-click or drag, and promotion opens a picker. Undo removes the last premove.
- **Playback** (`session.play`). The board switches to the real position, waits `startDelayMs` (the UI passes **500 ms**), then plays premove, opponent reply, premove, … with `delayMs` (**1000 ms**) after each move. Real legality is checked as each premove comes up.
- **Outcomes.** A level is either solved or not: there is no draw outcome (owner's rule).
  - **victory**: checkmate at any point.
  - **defeat**: a premove became illegal, the premoves ran out without mate, White got mated, or the game was drawn (stalemate, insufficient material, the 50-move rule or threefold repetition, using chess.js rules). Drawn endings say why in the message (`drawnReason`, e.g. "Stalemate: Black has no legal move but isn't in check. Only checkmate solves the level.").
  - **Ending on a check that isn't mate:** if the last premove gives check, the opponent's escape is played out (one more `bestMove`, published like any move) before the defeat card: "Your last premove gave check, but not checkmate: the king had a way out." A last premove that doesn't give check still ends at once.
- **Perfect.** A win using `≤ puzzle.number_of_moves` premoves (the shortest solution length). Perfect wins get their own result card and are stored separately.
- **Attempts.** Each submit counts as one attempt for that puzzle (per player, in localStorage).

### 4.2 `session.js` API (the backend; heavily tested)

```js
const game = createPremoveGame(puzzle /* {id, fen, number_of_moves?} */, { playerColor: "w" });
game.legalMovesFrom("d2")            // geometric targets: [{from,to,promotion?,san}]
game.queueMove({ from, to, promotion })  // throws RangeError on an impossible premove
game.undoPremove()
game.snapshot()
await game.play(engine /* { bestMove(fen) → uci } */, { delayMs, startDelayMs, onUpdate(snapshot) })
```

`snapshot()` fields:
- `phase`: `"planning" | "playing" | "complete" | "error"`
- `outcome`: `"victory" | "defeat" | null`
- `message`
- `perfect`: set on completion
- `minimumMoves`, `movesUsed`
- `premovesPlayed`: how many queued premoves have been played so far (0 while planning); the opponent's replies don't count
- `failedPremove`: index of the premove an opponent reply made illegal, else `null`
- `fen`: the preview FEN while planning, the real FEN afterwards
- `premoves`: `[{from,to,promotion,san}]`
- `lastMove`: `{from,to,san,color}`
- `matedKing`: square of the checkmated king, set **from the mating move onward**, which is what triggers the celebration
- `playerColor`

### 4.3 The opponent (`premoveOpponent.js` + WASM refuter)

The opponent receives the full plan. `chooseReply` searches Black's replies against that fixed plan:

- If any line of defence **refutes** the plan (makes a premove illegal, outlasts it, draws, or mates White), it plays the one that **ends the game soonest**.
- Otherwise it plays the **longest-surviving** defence.

The node limit is 100k. If that is exceeded, it falls back to a first-refutation search, and then to `ruleOfThumbReply` (make the next premove illegal if possible, else capture, else any legal move). Typical replies take well under 1 ms. The refuter mirrors chess.js draw rules, so the browser and the engine agree on outcomes.

There is **no Stockfish in the game**. It was removed because it plays good chess, not anti-plan chess, and its leftover files (`public/engine/`, ~40 MB, GPL) were deleted in Nov 2026.

### 4.4 The WASM build (important)

- `src/engine/generated/premove-engine.js` is **generated and committed**. Deploys and `npm run build` don't need Emscripten.
- Rebuild **only** when the refuter's C++ changes: `puzzle-finder/engine/src/refute.hpp`, `refute_api.hpp`, `engine/wasm/premove_wasm.cpp`, `engine/vendor/chess.hpp` or `engine/Makefile`. Run `npm run build:wasm` (Emscripten: `brew install emscripten`). It also writes the `.sources.sha256` stamp.
- **Guards:**
  - The pre-commit hook rebuilds and stages the module when those sources changed. If `em++` is missing, it blocks the commit.
  - `test/wasm-artifact.test.js` fails if the stamp doesn't match the sources, which also catches `--no-verify`. CI runs `npm test`, so a stale module **blocks the deploy**.
- Emscripten flags that matter: `MODULARIZE`, `EXPORT_ES6`, `SINGLE_FILE` (Node 22 fetch issues), `ENVIRONMENT=web,worker`. Exports: `_pm_version`, `_pm_analyze`, `_pm_reply`, called via `cwrap`.
- `npm run check:wasm` cross-checks WASM, native and the Python verifier on fresh puzzles. It needs Python 3.11+ with `chess` and a C++ compiler.

### 4.5 Persistent state (`progress.js`)

- localStorage key: `chess-premove-progress-v1`.
- Value: `{ completedIds: string[], perfectedIds: string[], attempts: { [id]: int }, wins: { [id]: int }, firstWins: { [id]: int } }`, where the ids are **level ids** (`"2-3"` = world 2, level 3), not puzzle ids, because one puzzle can appear in several levels.
- Saves from before stages hold puzzle numbers (`"1"`…). They still load and those entries are kept on save, but they match no level, so they count for nothing (old progress does not carry over; a tested decision, see `test/progress.test.js`).
- Older saves without `perfectedIds`, `attempts`, `wins` or `firstWins` must keep loading, and they do; preserve this.
- `wins` counts every win of a level; `firstWins` stores **which attempt first solved it** (`attemptCount` at that moment, at least 1). Both start empty for wins made before they existed: those levels report `winCount` 0 and `firstWinAttempt` null, and a later win doesn't invent a first-win attempt for them.
- Corrupt data **throws**; it is never silently discarded. All writes go through one `save()` helper.
- API: `isCompleted`, `isPerfected`, `isUnlocked`, `isStageUnlocked`, `isStageCleared`, `markCompleted(id, {perfect})` (now called on every win, not only the first), `attemptCount`, `recordAttempt`, `winCount`, `firstWinAttempt`, `completedIds`, `perfectedIds`, `unlockForDevelopment`.
- Separately, `chess-premove-badges-seen-v1` (in `stats.js`) lists the earned badges the player has already seen on the stats screen. It's cosmetic: unreadable data just means badges show as new once more.
- Levels unlock in play order (1-1 … 1-5, 2-1 …): a level needs every earlier level completed, so a world opens only once the whole previous world is cleared.
- Progress is keyed by **level slot**, so pointing a level at a different puzzle in `stages.json` keeps that slot's completion for returning players.
- **Dev mode** (`import.meta.env.DEV`, i.e. `npm run dev`): clicking a locked level unlocks it for the current page session only; locked worlds can be opened too.

### 4.6 `puzzles.json` schema

An array, numbered `"1".."N"` with no gaps:

```json
{ "id": "1", "title": "Starting simple", "description": "…",
  "fen": "8/1k6/8/8/8/8/2KQ4/4R3 w - - 0 1", "number_of_moves": 3,
  "solution": ["Qc3","Rb1","Qa1"], "solution_uci": ["d2c3","e1b1","c3a1"] }
```

Edit it with `ppz app …` (§6), not by hand. `test/puzzles.test.js` checks each puzzle: numbering, that the solution can be entered on the planning board, and that it actually beats the refuter.

### 4.6b `stages.json` schema (the world/level layout)

Hand-edited (`ppz` doesn't touch it). An array of worlds in order; each lists the puzzle id used by each of its levels:

```json
{ "id": "2", "name": "Knight's Wood", "tagline": "Paths twist between the pines.",
  "theme": "forest", "piece": "n", "puzzles": ["2","2","2","2","2"] }
```

- For now every world repeats one puzzle (world N = puzzle N ×5) until more puzzles exist; replace entries as puzzles are added.
- `theme` must be one of `meadow`, `forest`, `desert`, `frost`, `volcano` (styled in `ui/worlds.css`, drawn in `ui/scenery.js`). `piece` is the world's mascot (`p n b r q k`): the landmark on its card and the token on its level map.
- `test/stages.test.js` checks 5 worlds × 5 levels, ids `S-L`, display fields, distinct themes and that every puzzle id exists. Change those counts in the test if the structure changes on purpose.

### 4.7 UI architecture (`main.js`)

- **One global `state` object and full re-render.** `render()` replaces `app.innerHTML` from `state` on almost every change. Never hold DOM references across renders. Effects that must run once use **one-shot flags consumed by `render()`**: `pendingPieceMove` (slide animation), `pendingCelebration`, `revealOutcome`.
- Screens: `loading`, `index` (the **world map**), `stage` (a world's **level map**), `puzzle`, `stats` (**Your record**), `error`.
  - **World map:** one illustrated card per world (themed SVG scene, the world's piece as landmark, 5 progress pips, status). Locked worlds are dimmed with the piece as a black silhouette and a padlock; cleared worlds get a "Cleared" / "★ Perfect" corner ribbon. A dotted road links the cards. The hero has a levels-cleared bar and a **Continue · Level S-L** button that jumps straight into the next unbeaten level.
  - **Level map:** the world's panorama with a winding trail through 5 round level nodes (locked padlock / ready with pulse ring / white ✓ completed / gold ★ perfected). The world's piece stands on the next level to play and bobs; a goal flag by level 5 is raised (gold) once the world is cleared, with a "World clear!" / "★ Perfect!" stamp. Footer: "Next up" + Play button, or "On to World N". Escape goes back to the world map. Nodes have a tall layout under 640px.
  - Neither map shows move counts (owner's rule). The puzzle page heading shows a themed `S-L` badge, "World S, level L of 5" and pips, then chips: "Perfect in N premoves", "N attempts" and "★ Perfected" (in the compact heading the kicker text and pips are hidden and the chips become one line of small text). The back button returns to the world's level map. The board's labels follow chess.com: "Opponent · Black" above the board, "You · White" below it.
  - The top bar shows the engine pill only while the engine loads ("LOADING ENGINE") or failed ("ENGINE OFFLINE"); once it's ready it disappears.
- **Stats screen ("Your record")**, opened from the top bar's star counter (a button with a trophy; a red dot means badges earned but not yet seen). Disabled while a line plays. Back (the ← button, Escape, or the system Back) returns to where it was opened: a world's level map if opened from one or from a level, otherwise the world map. Everything comes from `computeStats(progress, STAGES)` in `game/stats.js`:
  - **Rank:** a ladder of the worlds' mascots, Pawn → Knight → Bishop → Rook → Queen (one step per world cleared), then King (every world cleared) and Grandmaster (every level perfect, gold). Shown as a medallion with the current world's scenery and the rank's piece, a ribbon, a bar toward the next rank (that rank's piece as a silhouette) and a hint ("Clear 3 more levels in Knight's Wood to become a Bishop.").
  - **Counters:** levels cleared, stars, attempts, first-try clears, solve rate (wins ÷ attempts; "—" before the first attempt).
  - **Worlds:** each world's five levels as mini nodes (locked / ready / ✓ / ★) with their attempt counts ("1st try", "3 tries").
  - **Badges** (10): First checkmate, Flawless, Sharp eye, Hat trick, Never give up, World conqueror, Spotless, Star collector, Completionist, Grandmaster, with progress bars toward multi-step ones. Badges first seen on this visit get a "New" chip and a shine.
  - No move counts appear (owner's rule).
  - **Layout:** `.stats-screen` is a size container. Three columns (Rank, Worlds, Badges) when it's ≥ 960 × 520; otherwise tabs (Overview / Worlds / Badges, with arrow-key support), with Overview split side by side on landscape phones. It fits without scrolling at every tested size. Opening it plays one intro: the medal pops, the ribbon stamps, the bar fills and the counters count up.
- **System Back button** (`syncHistory`, `goBack`, `popstate` in `main.js`): while inside a world the app keeps exactly one history entry of its own, so Android back / browser Back / iOS swipe go level → level map → world map instead of leaving the game; on the world map there's no entry and Back leaves the page. Coming back up with the in-app buttons pops that entry (`ignoreNextPop`). Back while a line is playing is ignored (the entry is re-pushed); Back with the promotion picker open cancels it. There are still no URLs per screen.
- **Layout: a full-viewport app, not a page** (see §4.7b).
- **Navigation** goes through `navigate(update)`, which wraps the screen change in a View Transition (a world card grows into its level map via `view-transition-name: world-scene-N`). Skipped without browser support or with reduced motion. The transition overlay takes input for ~420 ms.
- **Win → map animations.** `recordWin()` notes what a win opened in `state.fresh` (`unlockedLevel`/`hopFrom`, `clearedStage`, `unlockedStage`). The next render of the relevant map consumes it and marks elements with `data-fresh`; `playMapEffects()` runs after the transition finishes: the new level's lock shakes off and it pops, its trail segment draws on (dash length measured in screen pixels, because the trail uses `vector-effect: non-scaling-stroke`), the piece hops to it; on a world clear the flag rises, the stamp lands and themed confetti fires; on the world map the new world's lock bursts and its colours flood back. Playing the unlocked level straight away (Next level) drops its pending animation.
- **Board DOM.** `.board` is a CSS grid of 64 `<button class="square" data-square="e4">` elements, white at the bottom. It also holds two SVG overlays with `viewBox="0 0 8 8"`: `.board-highlights` (z 1, under the pieces) and `.board-arrows` (z 4, above everything). `.piece` has z-index 2 and coordinates have 3. **Only real squares may carry `data-square`**, because code uses `querySelector('[data-square=…]')` and `closest('[data-square]')`. Overlays use `data-highlight` and `data-from`/`data-to`.
- **Input.**
  - Click-to-move, plus HTML5 drag and drop **for the mouse**. On drag start, the source square gets `is-drag-source` **via `setTimeout(0)`**, so the browser's drag image is captured before the piece is hidden. `dragend` clears it.
  - **Touch and pen drag** (pointer events; the `touchDrag` object in `main.js`), because HTML5 drag and drop doesn't work with fingers. A finger on one of your pieces that travels ≥ 6 px (`DRAG_START_DISTANCE`) lifts it: a `.drag-ghost` (a child of `<body>`, outside the re-rendered `#app`) follows the finger, 1.45× larger and raised 40 % of a square so it shows past the fingertip; the source square gets `is-drag-source` and the square under the finger `is-drag-over`. Selection and legal targets are painted onto the existing squares (`paintSelection`); **nothing re-renders until the drop**, which goes through `attemptMove` (so promotion, illegal-move errors and sounds behave as for clicks). A touch that doesn't move is a tap and falls through to click-to-move; the click after a drag is ignored for 400 ms (`suppressClickUntil`). Dropping back on its own square or off the board puts the piece back, still selected; `pointercancel` does the same. Your pieces' squares have `touch-action: none` while planning so the browser doesn't turn the drag into a pan. `dragstart` is cancelled when the last pointer wasn't a mouse, so a long-press can't start a native drag on top.
  - Dropping a piece back on its own square just keeps it selected.
- **Right-click annotations** (chess.com parity):
  - Right-drag draws an arrow, **committed and drawn only on button release**. Knight jumps draw as an L, long leg first.
  - Right-click and release on the same square toggles a square highlight.
  - Drawing the same thing again removes it.
  - Arrows default to orange and highlights to red. Shift gives green, Alt blue, Ctrl/Cmd red.
  - **Any left mousedown anywhere** clears all annotations (a document-level capture listener).
  - The context menu is suppressed on the board only.
  - Annotations reset when a level is opened or retried.
- **Celebrations** (`celebrateMate`, run when the mating move lands):
  - The mated king's square glows red, the king wobbles and tips over (and stays tipped via CSS), and the board gives a small scale thump. Supported phones vibrate.
  - **Perfect:** 160 gold confetti pieces with stars burst from the king, and gold cannons fire from the bottom corners when the result card appears. The card pops in, the ★ spins in and a shimmer crosses the card.
  - **Non-perfect win:** **80** red/blue/green/yellow pieces, half as many. The owner tried a deliberately sad grey fizzle and rejected it as "too depressing": a win is still a win.
  - `prefers-reduced-motion` turns off confetti and motion, leaving only the static glow and tipped king.
- **Move list during playback** (`premoveStatus`/`renderPremoves`, from `premovesPlayed` and `failedPremove`): the premove just played is lit in the world's accent colour (`is-current`, `aria-current="step"`, a small pop as it lands), earlier ones get a ✓ (`is-played`), later ones are dimmed (`is-upcoming`). At the result the mating move turns gold with a `#` (`is-winning`), a premove that became illegal is red and struck through with ✕ (`is-failed`), and premoves never needed because mate came first are faded (`is-unused`). Each carries a visually hidden status for screen readers. The list scrolls itself (`keepCurrentPremoveVisible`) to keep the current premove in view, in both the horizontal strip and the vertical list.
- Result cards have Retry, a forward button on wins only (**Next level** inside a world; **Continue** after a world's last level, which goes to its level map for the clear celebration) and **Level map**.
- **View on chess.com** (wins only, perfect or not; not on defeats, while planning or during playback): a small pill at the end of the result card's heading row (`.outcome-heading`, `renderChessComLink`), linking to chess.com's analysis board for the level's **starting** FEN. The URL comes from `chessComAnalysisUrl` in `game/links.js` and matches `ppz`'s `chesscom_url` (Python `quote_plus`: `/` → `%2F`, space → `+`). It opens in a new tab (`target="_blank" rel="noopener noreferrer"`) and plays `click`. It sits in the heading row rather than among the buttons so the card doesn't gain a row and the board keeps its size; the pill is 24 px tall with a 34 px tap target (`::after`), and below a 260 px heading (`@container outcome-heading`) it shortens to "chess.com ↗".
- Lilita One (self-hosted via `@fontsource/lilita-one`, OFL) is the display face for world names, node numbers, badges and stamps; body text stays Inter.

### 4.7b Layout and responsiveness

The owner's brief: it should feel and flow like an app, not a website, on every screen; no scrolling except where it's obviously needed.

- **App shell** (`style.css`): `html, body` never scroll (`overflow: hidden`, `overscroll-behavior: none`, so no rubber-banding or pull-to-refresh). `#app` is a `100dvh` flex column with safe-area padding (`viewport-fit=cover`): the top bar, then the screen's `<main>` (`flex: 1; min-height: 0`). No text selection, tap highlight or long-press callouts in `#app`; `touch-action: manipulation` (no double-tap zoom; pinch zoom still works). Hover effects are wrapped in `@media (hover: hover)` so taps don't leave buttons stuck in their hover state; buttons press down on `:active` instead. Tap targets are ≥ 40 px (`.icon-toggle` grows to 40 px under `pointer: coarse`).
- **Every screen is a CSS size container** and lays itself out by its own size, not by viewport breakpoints: `worlds` (`.world-screen`), `stage` (`.stage-screen`), `map` (`.stage-map`), `puzzle` (`.puzzle-screen`) and `board` (`.board-column`). Lengths in `cqw/cqh/cqmin` scale things inside them.
- **Puzzle page.** Default (portrait/narrow) is a column: one-row heading (round ← button, badge, title, chips line), the board as large as fits (`.board-frame` width = `min(100cqw, 100cqh − labels)` of `.board-column`), and the controls at the bottom (move strip + Done/Undo). The controls' grid row reserves `--panel-reserve` (190 px; 150 px when the screen is ≥ 560 px wide, where the result card puts its buttons beside the text), so **the board keeps exactly the same size from planning through playback to the result**. When the screen is wide enough that the board is bigger beside the controls than above them (the `@container puzzle (min-aspect-ratio: 5/4) or …` query, used in both CSS files), the board takes the full height on the left and the heading + a full side panel sit on the right; on short wide screens (phones on their side, ≤ 560 px tall) that side column is compacted. Boards under 440 px tall drop the "Opponent/You" labels. On short portrait phones (≤ 640 px) the played-move strip hides once the result card shows.
- **World map.** Landscape (`min-aspect-ratio: 6/5`, ≥ 560 px wide): five tall cards side by side, stretched to the available height (capped at 1.75× their width). Portrait: a column of wide cards sharing the height; the hero is a grid (title and progress bar on the left, Continue on the right). The strapline and footnotes hide on short screens. The content is vertically centred (`justify-content: safe center`); `.world-screen` scrolls only if five cards truly can't fit (none of the tested sizes in production).
- **Level map.** Heading row (round ← "All worlds" pill on wide screens, title, score), the map filling the remaining height (capped at 46 % of the width on landscape screens) and the footer. The map picks the **wide or tall trail by its own aspect ratio** (`@container map (max-aspect-ratio: 1/1)`), and nodes, token, badges and ribbon scale with it (`--node-size: clamp(44px, 13.5cqmin, 80px)`); the flag shrinks on maps under 300 px tall.
- **Installable:** `manifest.webmanifest` (standalone display) plus apple/mobile web-app meta tags, so Add to Home Screen launches without browser chrome.
- Container queries can't style the container itself: rules that must change with a container's size target its children (e.g. `--panel-min` is set on `.game-layout`, not `.puzzle-screen`).

### 4.8 Sound effects (`effects/sound.js`)

- **Every sound is synthesized** with the Web Audio API (oscillators, filtered noise, envelopes); there are no audio files to license or load. `synthesize(context, destination, name, at, {opponent})` builds one sound; `createSoundPlayer()` wraps a lazily created `AudioContext` (made on the first sound, which always follows a click, so there are no autoplay warnings) and a mute flag stored in localStorage key `chess-premove-sound-v1` (`"on"`/`"off"`).
- **Sounds** (`SOUND_NAMES`): board `premove`, `undo`, `illegal`, `submit`, `move`, `capture`, `check`, `castle`, `promote`, `mate`; results `win`, `perfect`, `poppers` (the perfect-solve cannons), `defeat`; menus/maps `click`, `open`, `back`, `lock`, `pop`, `trail`, `hop`, `flag`, `stamp`, `unlock-world`. Played moves pick theirs from SAN with `soundForMove` (`#` mate, `+` check, `=` promote, `O-O` castle, `x` capture); Black's replies are pitched ~14% lower (`opponent`).
- **Where they fire** (`main.js`): queueing/undoing/rejecting a premove; submit; each played move; the mate fanfare (`win`/`perfect`, 0.22 s after the mating move, in `celebrateMate`); `defeat` when its result card appears (gentle two-note marimba, never a "sad trombone"); `poppers` with the gold cannons; navigation (`open` going deeper, `back` going up, `click` for other buttons); and each map effect in `playMapEffects`, scheduled with `when` to land on its animation's key frame (lock wiggle at 0, node `pop` at 0.6 s, `trail` 0.12 s, `hop` 0.26 s with the landing tap built in, `flag` 0.2 s, `stamp` 0.74 s = the stamp's impact). With reduced motion the animation-synced cues (`lock`, `trail`, `hop`, `flag`) are skipped and the rest play untimed.
- **Mute:** a speaker toggle in the top bar and the **M** key. Toggling updates the button in place (no re-render), so map animations aren't interrupted.
- **Output stage:** a WaveShaper soft-clipper (linear to 0.6, rounded above), *not* a DynamicsCompressor: Chrome's compressor cut every short "thock" transient by ~9 dB even with a −3 dB threshold. Noise comes from a deterministic integer LCG; a float LCG degraded into flat runs that filters turned into clicks.
- **Levels** (offline renders, peak dBFS): board sounds −3 to −6, results −6 to −16 (losses quietest), map cues −4 to −22, UI ticks −14 to −25. Nothing clips; overlapping cues are caught by the soft-clipper.
- **Development:** the world map links to a **sound board** that plays every sound (and the opponent variants). Every play is also logged to `window.__soundLog` (`{name, when, opponent, muted, at}`) for headless tests. Both are dev-only and stripped from production builds.
- To tune a sound, edit its `case` in `synthesize()` and audition it on the sound board.

### 4.9 Background music (`effects/music.js`)

- **A different original piece per world** (`SONGS`), like Mario's overworld / underground / snow / desert / castle themes. The owner asked for each world to be "dramatically different", with Knight's Wood in a minor key ("knighttime") with a new vibe like the underground theme:

  | world | piece | key, metre, tempo | sound |
  |---|---|---|---|
  | meadow | Overworld | C major, swung 4/4, 112 | steel drum, oom-pah tuba, off-beat chop, bongos in the breakdown |
  | forest | Moonlit Gallop | D minor (harmonic V), 6/8, 63 (dotted quarter) | sparse dry plucks with silence (underground idea), hoof clip-clops, crickets, ocarina B section, a chase over i–VII–VI–V |
  | desert | Mirage | E phrygian dominant, 4/4, 96 | drone, darbuka (maqsum), ornamented reed with grace notes, oud answers, finger cymbals, wind |
  | frost | Snowfall Waltz | F lydian, 3/4, 126 | celesta, music-box arpeggios, sleigh bells, triangle, wind |
  | volcano | Throne of Fire | A minor, 4/4, 138 | pounding bass ostinato, organ stabs, square lead with tritones, timpani and toms |

- **Notation:** melodies, counter-melodies and explicit bass lines are bars of tokens, one per slot (an eighth note; `slots` per bar is 8, or 6 in 6/8 and 3/4): a scale degree (`"4"`, `"-2"`, `"4b"`/`"4#"` for chromatic notes), `"-"` holds, `"."` rests. `degreeToMidi(song, token, {root})` applies the key and scale (minor keys raise the 7th over V). Each song has `sections` (chords per bar, lead, counter, optional `bass`, `patterns` overrides, flags like `legato`, `featurePerc`), a `form`, default `patterns` (bass steps, comp style, drum and percussion slots, fill) and per-world `scenes` overrides. `scheduleBar` is generic over all of that.
- **Form:** every piece is intro, A, A′, B, A′, C (a breakdown without melody), B, A′, tag (frost adds a B′ and more A′s, since waltz bars are short): 1:48–2:35 per pass. The second pass varies (the last A′ an octave up, harmony thirds in meadow/frost/volcano, extra counter-melody, fills). After two passes it **rests for 8 bars**, then starts again (`barAt(world, n)`); per-bar variation is seeded, so it's deterministic.
- **Layers follow the screen** (`sceneGains(world, scene)`, vertical layering like Yoshi's bongos): `map` = full band; `planning` = no melody or kick, softer bass and comp, a pad, −3 dB; `playing` = kick back in plus the world's percussion (`perc`: bongos, hooves, darbuka, triangle, timpani; worlds whose percussion is their signature keep it on the map too); `amb` (crickets, wind, rumble) is always on. A won result goes back to `map`, a failed one to `planning`. A layer that turns on comes in at the next bar line. `main.js` picks the target in `musicTarget()` after every `render()`: the world being played; on the world map, the world you're up to.
- **Changing world** starts that world's piece from the top, like entering a Mario level. Changing scene never restarts.
- **Mix:** `MUSIC_GAIN` × each song's `level` puts every world's map music at ≈ −30 to −32 dB RMS (forest's sparse intro a little lower) vs ≈ −21 for a piece move, peaks ≤ −10 dBFS; planning ≈ −35 to −38. Re-measure with offline renders (§7) after changing any voice or pattern. The music bus is band-limited (low-pass 4.8 kHz, high-pass 55 Hz) and **ducks** under fanfares (`DUCKS`: win, perfect, poppers, mate, defeat, flag, stamp, unlock-world), via the sound player's `onPlay`.
- **Plumbing:** effects and music share one AudioContext and soft-clipper (`sounds.audio()` gives `{ context, musicInput }`; `keepAwake` stops an effects mute from suspending the context while music plays). Music starts on the **first pointerdown/keydown** (browsers forbid audio before a gesture), stops while the tab is hidden, and has its own on/off button (the ♫ next to the speaker), remembered in `chess-premove-music-v1`. There's no keyboard shortcut for it (M stays effects only).
- **Scheduling:** a 100 ms interval keeps ≥0.6 s scheduled, a whole bar at a time (`scheduleRange`, also used for offline renders). Each run has its own layer gains, so stopping or switching fades out exactly what was scheduled. About 20 audio sources/s.
- **Development:** the sound board has world and scene buttons to audition every piece and layer; `window.__music` (`state()`, `isPlaying()`) is exposed for headless tests. Both are dev-only. `test/sound.test.js` runs every sound against a fake AudioContext (finite times, everything stops within 2.5 s, everything fades out).

---

## 5. Deploying

`.github/workflows/deploy-pages.yml` runs on every push to `main`: `npm ci`, `npm test`, `npm run build`, then publishes `dist/` to GitHub Pages. PRs run the same build without deploying. The Pages source is set to GitHub Actions. Nothing else is needed: merging to `main` ships. Watch the run with
`gh api "repos/d12/chess-premoves/actions/runs?branch=main&per_page=3"`.

### 5.1 Offline (service worker)

- After every production build, the Vite plugin in `vite.config.js` (`scripts/service-worker.mjs`) writes **`dist/sw.js`**: `src/service-worker.js` with `VERSION` (a hash of every built file's path and contents) and `PRECACHE` (every file in `dist/`, plus `./`) prepended. Dependency-free; no Workbox.
- `main.js` registers `./sw.js` on `load`, **production only** (`import.meta.env.PROD`); the dev server has no worker.
- The worker precaches the whole game on install (~0.5 MB, fetched with `cache: "reload"` so the browser's HTTP cache, max-age 600 on Pages, can't hand it the previous deploy), then serves everything **cache-first**; every navigation in scope gets the cached `index.html`. Non-GET and cross-origin requests are left alone; anything not precached goes to the network.
- **Updates:** any change to the build changes `VERSION`, so the browser installs the new worker in the background on the next visit; it calls `skipWaiting` + `clients.claim`, deletes older `premove-*` caches, and **the launch after that runs the new version**. That's safe because the page loads all its assets at start-up (piece images are inlined in the JS bundle), so an open page never needs a file from the cache being replaced. If the game ever lazy-loads assets, revisit this (keep the old cache until no client uses it).
- Progress lives in localStorage, so it works offline too.

---

## 6. The puzzle finder (`puzzle-finder/`, CLI `./ppz`)

Full docs: `puzzle-finder/README.md` (setup, hardware, every command, algorithm) and `puzzle-building-guide.md` (the owner's workflow). Summary:

- **Setup** (macOS): `python3 -m venv .venv && .venv/bin/python -m pip install -e .`. `./ppz` uses `.venv` automatically. It needs a C++17 compiler; Stockfish is optional. Then build mate tables once with `./ppz tables build`.
- **Workflow:**
  1. `./ppz generate --min-moves 3 --count 15 --minutes 5` finds candidates and queues them for review.
  2. `./ppz review` steps through them (`a` accepts into the shortlist `puzzle-finder/puzzles.json`).
  3. `./ppz app add --from-db N` adds a shortlisted puzzle to the game, or `./ppz app add "FEN"`. Use `--number K` to replace or append, and `--insert` to shift later levels up.
  4. Finally run `npm test`.
  - `./ppz solve "FEN"` analyses any position.
- **Useful generate options:** `--min-moves/--max-moves`, `--min-pieces/--max-pieces` (kings included; adds scenery pawns and minors), `--pieces knight` with `--strict`, `--material KRB-K,KQ-KP`, `--minutes` (a hard deadline), and `--details`.
- **Engine** (`engine/src/`):
  - `solver.hpp`: belief-state search. The set of positions consistent with the premoves so far is expanded over every black reply, with a closed-loop mate-in-≤r prune, a transposition table, iterative deepening and solution counting.
  - `pmcore.cpp`: modes `solve`, `serve`, `gen` and `refute`. The generator does random sampling, mutation (MAP-Elites-style cells), an optional Stockfish pre-screen and a tables shortcut.
  - `tb_*.h`, `tbgen.cpp`, `tbgen_cuda.cu`: distance-to-mate retrograde tables for a lone black king against ≤3 white pieces (pawnless), with a CPU-threads or CUDA builder and mmap probing. Tables are stored in `tables/` or `$PPZ_TABLES`.
  - `refute.hpp`: the opponent shared with the game.
- **Python** (`premove_puzzles/`):
  - `cli.py`: commands
  - `engine.py`: native process pool, deadlines, restarts
  - `quality.py`: scoring and archive; the weights are in `config.toml`
  - `store.py`: shortlist and queue
  - `verify.py`: independent brute-force verifier
  - `app.py`: reads and writes the game's `puzzles.json`
  - `sftools.py`: Stockfish annotator, failure-tolerant; errors are logged to `stockfish-errors.log`
- **Position validity:** generated positions must be reachable. Per side that means ≤16 pieces and ≤8 pawns, and promoted extras (Q>1, R>2, N>2, or >1 bishop per square colour) must be ≤ 8 − pawns. Newer Stockfish versions crash on impossible material.
- **Verification history:**
  - The solver matches the brute-force verifier: 0 mismatches over 420 random positions.
  - Tables on vs off gives 0 mismatches.
  - WASM vs native is byte-identical over 1,179 plans.
  - The cross-checks live in `puzzle-finder/tests/`.

---

## 7. Testing and verification

- `npm test`: 88 tests in 13 files, about 25 s.
  - `session`: rules, playback, `startDelay`, `matedKing`, perfect, draws as defeats, the escape from a final check, `premovesPlayed`/`failedPremove`
  - `premove-opponent`: refuter vs a chess.js reference on fixture plans; set `PREMOVE_FULL_CHECK=1` for all of them
  - `puzzles`: every level is solvable and beats the opponent
  - `progress`: storage, migration, attempts, wins and first-win attempts, stage gating, pre-stage saves
  - `stats`: rank ladder and promotions, counters, first-try and hard-won clears, badges, seen-badge memory
  - `stages`: the 5×5 layout in `stages.json`
  - `sound`: SAN → sound mapping, every sound builds a valid self-ending graph, mute persistence, no-audio fallbacks
  - `music`: every world's piece (length, well-formed bars, a breakdown), the five being distinct (melody, tempo, metre, scale; forest minor, 6/8 and sparser than meadow), second-pass variation and rests, scales, scheduling only into layers that are on, the player's gesture/scene/world/hidden/off behaviour
  - `annotations`
  - `links`: the chess.com URL matches ppz's output, and every level's FEN round-trips through it
  - `wasm-artifact`: stamp freshness
  - `download-pieces`
  - `service-worker`: the precache list and version, and the real worker source run in a `vm` sandbox with fake `caches`/`fetch` (install, activate, cache-first fetch, navigation shell, pass-through)
- **`main.js` has no unit tests.** That is how a `ReferenceError` that froze every win reached production (PR #9). After any UI change, **drive the real page in a headless browser.** What has worked:
  - Start `npx vite --port <p> --strictPort` in the background, then use Puppeteer or Playwright with Chromium.
  - Open worlds with `.world-card[data-stage-id="1"]` and levels with `.level-node[data-level-id="1-1"]` (or `.continue-button`).
  - **Wait for screen transitions** before clicking: `page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))`. Clicks during one are swallowed.
  - Click squares via `button[data-square="e2"]`.
  - Submit with `[data-action="submit"]` and wait for `.outcome-card`.
  - Collect `pageerror` and console errors.
  - Sounds: on the dev server read and clear `window.__soundLog` to assert which sounds fired and their `when`. On a production build, wrap `window.AudioContext` with `evaluateOnNewDocument` to count scheduled nodes. To check the mix, render a sound into an `OfflineAudioContext` with `synthesize()` + `createLimiter()` and measure peak/RMS. Headless Chrome can't be listened to, so ask the owner to audition changes. For music, render bars with `scheduleRange` into an `OfflineAudioContext` (through the same low-pass/high-pass chain), measure levels per scene against the effects, encode MP3s with `ffmpeg` and send them to the owner; on the dev server, `window.__music.state()` gives `{ world, scene, bar, … }`.
  - Take screenshots and look at them.
  - **Stats screen:** seed progress (including `wins`/`firstWins`), open it with `[data-action="stats"]`, wait ~1.5 s for the intro, and check each tab (`.stats-tab[data-tab=…]`, shown when narrower than 960 or shorter than 520) for zero page scroll **and zero scroll inside `.stats-panel`**, with a fresh player (no saved progress), a mid-game one and a Grandmaster. Note: each `.stats-panel` is an inline-size container, so `cqw` inside a panel means the panel's width.
  - **Layout sweep** (after any CSS change): drive every screen (world map, level map, planning, a queued line with a selection, playing, perfect result, defeat, cleared level map) at phone portrait/landscape (280×653 fold, 360×640, 375×667, 390×844, 430×932, 640×360, 667×375, 844×390, 932×430), tablets (768×1024, 1024×768, 1024×1366, 1366×1024) and desktop windows (800×600, 1280×720, 1366×768, 1440×900, 1920×1080, 2560×1080, 1200×560, 520×1000), with `isMobile`/`hasTouch` for phones and tablets. For each, assert `document.scrollingElement.scrollHeight − innerHeight === 0` (and the same horizontally), that no button/heading/board is outside the viewport unless inside a scroller, that buttons are ≥ 32 px, and that the board's width is identical across planning/playing/result. Also check the promotion picker fits (level 5-1: d4–d5–d6–d7–d8), the system Back flow (`page.goBack()`), and resizing mid-level (portrait ↔ landscape). Seed progress with `addInitScript` + `localStorage`.
- **Lines that are known to work** (puzzle N is world N for now; every `solution_uci` in `puzzles.json` is a perfect solve):
  - Puzzle 1 (levels 1-1…1-5): `d2c3 e1b1 c3a1` is the perfect solve.
  - Puzzle 2: `d2c2 c4d4 d4a4` is a non-perfect 3-move win (the minimum is 2).
  - A losing line: puzzle 1 `d2d7`. A line whose 2nd premove becomes illegal: puzzle 1 `c2b1 d2e1`.
  - A full 25-level playthrough of the production build (all perfect) takes about 3 minutes headless.
  - In dev mode you can click any locked level.
- To check a production build, `npm run build`, copy `dist/` to `<root>/chess-premoves/`, serve `<root>` and load `/chess-premoves/`. This mimics the Pages subpath.
- Headless-browser caveats:
  - The browser's native HTML5 drag image can't be observed. Dispatch `DragEvent`s with a `DataTransfer` to test the mouse drag logic, and ask the owner to try a real drag.
  - **Offline:** on the production build, wait for `navigator.serviceWorker.controller`, then `context.setOffline(true)`, reload and play a level. For updates, edit a file in the served `dist/`, rerun `writeServiceWorker(dir)` from `scripts/service-worker.mjs`, reload, and poll `caches.keys()` from Node until only the new `premove-<version>` remains (~3 s), then reload once more. Don't return a Promise from `page.waitForFunction`: Playwright treats it as truthy at once.
  - **Touch drags can be tested for real**: open a CDP session (`context.newCDPSession(page)`) on a context with `hasTouch: true` and send `Input.dispatchTouchEvent` (`touchStart`, a few `touchMove`s, `touchEnd` with empty `touchPoints`). Chrome turns these into `pointerType: "touch"` pointer events, so the whole drag path runs.
  - Confetti timing runs slower when frames are throttled.
  - **Don't run `pkill -f <pattern>`** in the same shell command line that contains the pattern: it kills its own shell (exit code 144) and skips everything after it. This once left work stranded in a `git stash`.

---

## 8. Product decisions already made (don't undo without asking)

- chess.com parity for premove geometry, drag/click input, arrows (drawn on release, cleared by left click) and colours.
- 5 worlds × 5 levels. Levels unlock one at a time, and a world can't be entered until every level of the previous world is completed. Each world has its own theme (meadow, forest, desert, frost, volcano) and mascot piece (pawn → queen).
- World and level map cards show no move counts. The minimum is shown only on the puzzle page.
- Playback waits 500 ms before White's first move and 1000 ms between moves.
- "Perfect" means a win in ≤ the minimum number of premoves. It gets a gold card and a gold index tile with a ★.
- Attempts are counted per player, locally. The site is static, so there are no global stats.
- Celebration tiers: gold plus stars plus cannons for a perfect win; half as much colourful confetti for other wins; never a "sad" win effect.
- No Stockfish in the game. The opponent is the WASM refuter.
- The site must stay fully static (GitHub Pages). There is no backend.
- Sound effects are on by default, synthesized (no audio files), mutable from the top bar or with M. Wins never get a sad sound; losses get a gentle two-note cue.
- Background music is on by default, original (no Mario melodies), synthesized, quieter than the effects, with its own on/off button. Each world has its own piece (owner feedback: "each world dramatically different"; Knight's Wood minor, "like the underground theme").

---

## 9. Loose ends and ideas

- **`review_queue.jsonl`** at the repo root is a committed `ppz` queue file. Only `puzzle-finder/.gitignore` ignores it, so the copy at the root is probably accidental.
- **No UI smoke test in CI.** A minimal Puppeteer or Playwright test that loads the built app and solves level 1 would have caught PR #9's bug.
- Touch devices can't draw arrows or highlights (there's no right click). A long-press-and-drag gesture could stand in for right-drag if it's wanted.
- Possible next features: showing why a plan failed (`opponent.analysis.line`). Stats ideas not done: a time-played counter, streaks (days played), and celebrating a badge the moment it's earned (today it's flagged on the stats button and celebrated on the stats screen). A volume slider (the player has a single output gain) if on/off isn't enough.
- Progress is keyed by level slot (§4.5), not by puzzle. Reordering worlds (rather than swapping puzzles inside a slot) would shift completions.
- The worlds repeat one puzzle each until there are 25 puzzles; `stages.json` is where to place new ones.
- Map ideas not done: URL routing (the system Back button now steps up through the screens, but screens have no URLs, so a reload returns to the world map). Touch-drag on maps is not needed (everything is click/tap).
- Offline updates are silent: a new deploy shows up on the launch after next. A small "New version ready · Restart" toast (listen for `controllerchange`) would make updates visible.
- iOS: Web Audio is silenced by the ringer switch, so sounds won't play with the phone on silent (normal for web games).
