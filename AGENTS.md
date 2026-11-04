# Premove — handoff for agents

Read this before changing anything in **d12/chess-premoves**. It covers what the project is, how it is built, how the owner likes to work, and the traps already found. Facts are as of the stages/world-map PR (3 Nov 2026): 5 puzzles laid out as 5 worlds × 5 levels, and 52 passing tests.

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
src/
  main.js                 UI: rendering, events, playback, celebrations, world/level maps (≈1300 lines)
  style.css               base styles; CSS tokens on :root (--green, --gold, --red …)
  ui/
    worlds.css            world map, level maps and per-world themes ([data-theme] tokens, keyframes)
    scenery.js            flat SVG landscapes per theme (renderScene) + per-theme confetti colours
  game/
    session.js            UI-independent game engine: planning, premove queue, playback (createPremoveGame)
    premoveRules.js       chess.com-style *geometric* premove rules and the planning preview board
    progress.js           localStorage progress: completed, perfected, attempts (createProgressStore)
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
  assets/pieces/*.png     Neo piece images (fall back to Unicode glyphs if missing)
test/                     node:test suites (see §7)
scripts/wasm-stamp.mjs    write/check the WASM source fingerprint
scripts/download-pieces.mjs
.githooks/pre-commit      rebuild WASM if its C++ changed; check puzzles if puzzles.json is staged
.github/workflows/deploy-pages.yml   test + build on PRs; test + build + deploy on push to main
puzzle-finder/            ppz: see §6 and puzzle-finder/README.md
puzzle-building-guide.md  the owner's step-by-step guide for generating and adding puzzles
design.md                 original product brief
public/engine/            LEFTOVER Stockfish files (~40 MB), unused; see §9
review_queue.jsonl        stray ppz review queue committed at the repo root; see §9
```

`npm` scripts: `dev`, `build`, `preview`, `test` (`node --test`), `build:wasm` (needs Emscripten), `check:wasm`, `download:pieces`, and `prepare`, which sets `core.hooksPath=.githooks` on `npm install`.

---

## 4. The game

### 4.1 Game rules as implemented

- **Planning.** Premoves are validated **geometrically only**, as on chess.com/lichess (`premoveRules.js`). Pieces in the way, an opponent piece on the target square, or the black king standing there do not block a premove, because the opponent moves in between. The planning board shows **White's pieces after the queued premoves** and Black's pieces where they stand now. Capturing onto an opponent piece removes it from the preview; the black king is only *hidden* while a white piece stands on its square (`preview.hiddenKing`). The player can click-click or drag, and promotion opens a picker. Undo removes the last premove.
- **Playback** (`session.play`). The board switches to the real position, waits `startDelayMs` (the UI passes **500 ms**), then plays premove, opponent reply, premove, … with `delayMs` (**1000 ms**) after each move. Real legality is checked as each premove comes up.
- **Outcomes.**
  - **victory**: checkmate at any point.
  - **defeat**: a premove became illegal, the premoves ran out without mate, or White got mated.
  - **draw**: stalemate, insufficient material, the 50-move rule or threefold repetition, using chess.js rules.
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
- `outcome`: `"victory" | "defeat" | "draw" | null`
- `message`
- `perfect`: set on completion
- `minimumMoves`, `movesUsed`
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

There is **no Stockfish in the game**. It was removed because it plays good chess, not anti-plan chess.

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
- Value: `{ completedIds: string[], perfectedIds: string[], attempts: { [id]: int } }`, where the ids are **level ids** (`"2-3"` = world 2, level 3), not puzzle ids, because one puzzle can appear in several levels.
- Saves from before stages hold puzzle numbers (`"1"`…). They still load and those entries are kept on save, but they match no level, so they count for nothing (old progress does not carry over; a tested decision, see `test/progress.test.js`).
- Older saves without `perfectedIds` or `attempts` must keep loading, and they do; preserve this.
- Corrupt data **throws**; it is never silently discarded. All writes go through one `save()` helper.
- API: `isCompleted`, `isPerfected`, `isUnlocked`, `isStageUnlocked`, `isStageCleared`, `markCompleted(id, {perfect})`, `attemptCount`, `recordAttempt`, `completedIds`, `perfectedIds`, `unlockForDevelopment`.
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
- Screens: `loading`, `index` (the **world map**), `stage` (a world's **level map**), `puzzle`, `error`.
  - **World map:** one illustrated card per world (themed SVG scene, the world's piece as landmark, 5 progress pips, status). Locked worlds are dimmed with the piece as a black silhouette and a padlock; cleared worlds get a "Cleared" / "★ Perfect" corner ribbon. A dotted road links the cards. The hero has a levels-cleared bar and a **Continue · Level S-L** button that jumps straight into the next unbeaten level.
  - **Level map:** the world's panorama with a winding trail through 5 round level nodes (locked padlock / ready with pulse ring / white ✓ completed / gold ★ perfected). The world's piece stands on the next level to play and bobs; a goal flag by level 5 is raised (gold) once the world is cleared, with a "World clear!" / "★ Perfect!" stamp. Footer: "Next up" + Play button, or "On to World N". Escape goes back to the world map. Nodes have a tall layout under 640px.
  - Neither map shows move counts (owner's rule). The puzzle page heading shows a themed `S-L` badge, "World S, level L of 5" and pips, then chips: "Perfect in N premoves", "N attempts" and "★ Perfected". The back button returns to the world's level map.
- **Navigation** goes through `navigate(update)`, which wraps the screen change in a View Transition (a world card grows into its level map via `view-transition-name: world-scene-N`). Skipped without browser support or with reduced motion. The transition overlay takes input for ~420 ms.
- **Win → map animations.** `recordWin()` notes what a win opened in `state.fresh` (`unlockedLevel`/`hopFrom`, `clearedStage`, `unlockedStage`). The next render of the relevant map consumes it and marks elements with `data-fresh`; `playMapEffects()` runs after the transition finishes: the new level's lock shakes off and it pops, its trail segment draws on (dash length measured in screen pixels, because the trail uses `vector-effect: non-scaling-stroke`), the piece hops to it; on a world clear the flag rises, the stamp lands and themed confetti fires; on the world map the new world's lock bursts and its colours flood back. Playing the unlocked level straight away (Next level) drops its pending animation.
- **Board DOM.** `.board` is a CSS grid of 64 `<button class="square" data-square="e4">` elements, white at the bottom. It also holds two SVG overlays with `viewBox="0 0 8 8"`: `.board-highlights` (z 1, under the pieces) and `.board-arrows` (z 4, above everything). `.piece` has z-index 2 and coordinates have 3. **Only real squares may carry `data-square`**, because code uses `querySelector('[data-square=…]')` and `closest('[data-square]')`. Overlays use `data-highlight` and `data-from`/`data-to`.
- **Input.**
  - Click-to-move, plus HTML5 drag and drop. On drag start, the source square gets `is-drag-source` **via `setTimeout(0)`**, so the browser's drag image is captured before the piece is hidden. `dragend` clears it.
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
- Result cards have Retry, a forward button on wins only (**Next level** inside a world; **Continue** after a world's last level, which goes to its level map for the clear celebration) and **Level map**.
- Lilita One (self-hosted via `@fontsource/lilita-one`, OFL) is the display face for world names, node numbers, badges and stamps; body text stays Inter.

---

## 5. Deploying

`.github/workflows/deploy-pages.yml` runs on every push to `main`: `npm ci`, `npm test`, `npm run build`, then publishes `dist/` to GitHub Pages. PRs run the same build without deploying. The Pages source is set to GitHub Actions. Nothing else is needed: merging to `main` ships. Watch the run with
`gh api "repos/d12/chess-premoves/actions/runs?branch=main&per_page=3"`.

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

- `npm test`: 52 tests in 8 files, about 25 s.
  - `session`: rules, playback, `startDelay`, `matedKing`, perfect
  - `premove-opponent`: refuter vs a chess.js reference on fixture plans; set `PREMOVE_FULL_CHECK=1` for all of them
  - `puzzles`: every level is solvable and beats the opponent
  - `progress`: storage, migration, attempts, stage gating, pre-stage saves
  - `stages`: the 5×5 layout in `stages.json`
  - `annotations`
  - `wasm-artifact`: stamp freshness
  - `download-pieces`
- **`main.js` has no unit tests.** That is how a `ReferenceError` that froze every win reached production (PR #9). After any UI change, **drive the real page in a headless browser.** What has worked:
  - Start `npx vite --port <p> --strictPort` in the background, then use Puppeteer or Playwright with Chromium.
  - Open worlds with `.world-card[data-stage-id="1"]` and levels with `.level-node[data-level-id="1-1"]` (or `.continue-button`).
  - **Wait for screen transitions** before clicking: `page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))`. Clicks during one are swallowed.
  - Click squares via `button[data-square="e2"]`.
  - Submit with `[data-action="submit"]` and wait for `.outcome-card`.
  - Collect `pageerror` and console errors.
  - Take screenshots and look at them.
- **Lines that are known to work** (puzzle N is world N for now; every `solution_uci` in `puzzles.json` is a perfect solve):
  - Puzzle 1 (levels 1-1…1-5): `d2c3 e1b1 c3a1` is the perfect solve.
  - Puzzle 2: `d2c2 c4d4 d4a4` is a non-perfect 3-move win (the minimum is 2).
  - A losing line: puzzle 1 `d2d7`.
  - A full 25-level playthrough of the production build (all perfect) takes about 3 minutes headless.
  - In dev mode you can click any locked level.
- To check a production build, `npm run build`, copy `dist/` to `<root>/chess-premoves/`, serve `<root>` and load `/chess-premoves/`. This mimics the Pages subpath.
- Headless-browser caveats:
  - The browser's native HTML5 drag image can't be observed. Dispatch `DragEvent`s with a `DataTransfer` to test the drag logic, and ask the owner to try a real drag.
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

---

## 9. Loose ends and ideas

- **`public/engine/`** holds about 40 MB of unused Stockfish files (GPL-licensed) that Vite copies into every deploy. Deleting the folder would shrink the site to about 300 KB. This was offered to the owner but not yet done.
- **`review_queue.jsonl`** at the repo root is a committed `ppz` queue file. Only `puzzle-finder/.gitignore` ignores it, so the copy at the root is probably accidental.
- **No UI smoke test in CI.** A minimal Puppeteer or Playwright test that loads the built app and solves level 1 would have caught PR #9's bug.
- Touch devices can't drag (HTML5 drag and drop) or draw arrows (no right click). Click-to-move works. A pointer-events drag implementation would fix both.
- Possible next features: sound effects (a win chime was offered), showing why a plan failed (`opponent.analysis.line`), and a stats view (attempts, perfects).
- Progress is keyed by level slot (§4.5), not by puzzle. Reordering worlds (rather than swapping puzzles inside a slot) would shift completions.
- The worlds repeat one puzzle each until there are 25 puzzles; `stages.json` is where to place new ones.
- Map ideas not done: sound effects for unlocks and stamps, URL routing (browser Back currently leaves the app), touch-drag on maps is not needed (everything is click/tap).
