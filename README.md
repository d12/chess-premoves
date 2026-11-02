# Premove

A browser-based chess vision trainer. The game logic runs locally in the browser; it does not require an application server.

## Development

```sh
npm install
npm run dev
```

Run the backend/game-logic tests and create a static production build with:

```sh
npm test
npm run build
```

The production files are written to `dist/` and can be hosted on GitHub Pages or another static host.

On compact screens, the puzzle board, premove strip, and actions stay visible together. Swipe the premove strip horizontally to review longer lines.

## Chess piece images

To install the Neo piece set, provide the asset server's domain (or its full HTTP(S) origin):

```sh
npm run download:pieces -- https://example.com
```

The script downloads all 12 300x300 PNGs from
`/chess-themes/pieces/neo/300/{color}{piece}.png` into `src/assets/pieces/`.
It checks the PNG headers and dimensions before writing any files. Run it again to replace
the set, then rebuild for production. The board and promotion picker use the images when
available; otherwise they use the original Unicode pieces. Commit the downloaded files if
they should be included in deployments, and confirm the provider's licensing terms.

## Planning premoves

Premoves follow chess.com / lichess rules: while planning, a move is only checked against
how the piece moves (`src/game/premoveRules.js`). Pieces in the way, the opponent king
standing on a square, or a position that would be checkmate if the opponent never moved
do not block a premove, because the opponent moves in between. Each premove's real
legality is checked when it is played; if it is illegal at that moment, the attempt ends.

The planning board shows your pieces after the queued premoves and the opponent's pieces
where they stand now. A premove onto the square of an opponent piece removes that piece from
the preview, except the king, which is only hidden while your piece is on its square.

## Perfect solves

Every level shows its minimum ("Perfect in 4 premoves", from `number_of_moves` in
`src/game/puzzles.json`). Winning with no more premoves than that is a **perfect** solve:
it gets its own result card, and the level turns gold with a star on the index. A plain win
shows how many premoves were used against the minimum. Perfected levels are stored next to
completed ones in the browser (`perfectedIds`); progress saved before this feature still loads.

## Puzzles

Puzzles live in `src/game/puzzles.json` and are numbered 1..N; each unlocks when the one
before it is completed. Manage them with the generator in `puzzle-finder/`:

```sh
cd puzzle-finder
./ppz app list                                   # what the app has
./ppz app add "FEN"                              # append as the next puzzle
./ppz app add "FEN" --number 4                   # replace puzzle 4 (or add it if 4 is next)
./ppz app add "FEN" --number 4 --insert          # insert at 4 and shift the rest up
./ppz app add --from-db 7 --title "Corner squeeze" # puzzle 7 from `ppz db list`
./ppz app remove --number 4                      # remove and renumber
```

`add` solves and verifies the position, stores the shortest solution, and generates a title
and description unless you pass `--title` / `--description`. `npm test` then checks every
puzzle in the file: numbering, that its solution can be entered on the planning board, and
that it beats the opponent in a real game. Completion is stored per puzzle number in the
browser, so replacing or inserting puzzles shifts what players see as completed.

The `puzzle-finder/` directory contains the standalone finder, its native engine and
supporting files. Its `premove_puzzles/` subdirectory is the Python package used by `ppz`;
its import name remains unchanged. See `puzzle-finder/README.md` for setup.

## Premove-aware opponent (WebAssembly)

Because the player submits every premove before play starts, the opponent knows the whole
plan. `src/engine/premoveOpponent.js` uses the C++ engine from `puzzle-finder/engine`,
compiled to WebAssembly, to search the opponent's replies against that fixed plan:

* if any reply sequence beats the plan (a premove becomes illegal, the premoves run out,
  a draw, or the opponent mates), it plays the one that ends the game soonest;
* if the plan is sound, it plays the defence that survives longest.

Typical puzzles take well under a millisecond per reply. If a plan is too large to search
exactly (100k positions by default, e.g. a long aimless plan against mobile pieces), it
settles for the first refutation it finds; if even that search runs out, a simple rule picks
the reply (make the next premove illegal if possible, else capture, else any move). There is
no other engine: nothing is downloaded, and the module is bundled with the app (~300 KB,
about 135 KB gzipped for the whole app). `createPremoveOpponent()` exposes the `bestMove(fen)`
method `session.play()` expects, and its `analysis` property returns the verdict and the
line (useful for showing why a plan failed).

The module is generated, not hand-written. Build it with [Emscripten](https://emscripten.org):

```sh
brew install emscripten        # or the emsdk: https://emscripten.org/docs/getting_started/downloads.html
npm run build:wasm             # writes src/engine/generated/premove-engine.js (~300 KB, wasm embedded)
npm test                       # includes test/premove-opponent.test.js
npm run check:wasm             # optional: WebAssembly vs native engine vs python verifier on fresh puzzles
```

Commit `src/engine/generated/premove-engine.js` so `npm run build` and static deployments
work without Emscripten installed. Without it, the opponent tests are skipped and the app
will not start.

### When to rebuild

Only when the opponent's C++ sources change: `puzzle-finder/engine/src/refute.hpp`,
`refute_api.hpp`, `engine/wasm/premove_wasm.cpp`, `engine/vendor/chess.hpp` or the
`engine/Makefile` flags. Puzzles, JS/CSS and the rest of `ppz` do not need it.
`npm run build:wasm` records a fingerprint of those sources next to the module
(`premove-engine.sources.sha256`), and:

* a **pre-commit hook** (installed by `npm install`, in `.githooks/`) rebuilds the module and
  adds it to the commit when those sources changed (or stops the commit if Emscripten is not
  installed). It also runs the puzzle checks when `src/game/puzzles.json` is committed;
* `npm test` fails if the committed module is older than its sources, which also catches
  commits made with `--no-verify`.

`PREMOVE_FULL_CHECK=1 npm test` runs the cross-check against the chess.js reference on all
fixture puzzles instead of a quarter of them (about a minute). `npm run check:wasm` needs
Python 3.11+ with `pip install chess` and a C++ compiler (it builds the native engine).

## Game logic

`src/game/session.js` is independent of the UI. It validates each queued player move, including rejecting captures of the opponent's king in the preview, applies the opponent's engine reply between queued moves, detects checkmate/draws, and reports a premove invalidated by an opponent move. The test suite exercises this API directly with a scripted engine.
