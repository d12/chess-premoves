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

## Chess engine

The app uses the Stockfish 16 single-threaded WebAssembly build and `chess.js` for legal move generation and chess rules. Before starting a game, the app downloads the engine loader, WebAssembly core, and neural network, then stores them in the browser Cache API. The neural network is about 40.1 MB; all downloaded engine files total about 40.7 MB.

On later visits, cached files are reused without downloading them again, but the setup screen remains visible while the browser starts the engine and loads its neural network into memory. Browser storage eviction or clearing site data can require another download.

The engine assets in `public/engine/` are generated from the pinned `stockfish` npm dependency by the `predev` and `prebuild` scripts. The directory is intentionally git-ignored; static deployment builds it before Vite copies it into `dist/engine/`. Stockfish license and author files are included alongside the generated assets.

## Premove-aware opponent (WebAssembly)

Because the player submits every premove before play starts, the opponent knows the whole
plan. `src/engine/premoveOpponent.js` uses the C++ engine from `premove-puzzles/engine`,
compiled to WebAssembly, to search the opponent's replies against that fixed plan:

* if any reply sequence beats the plan (a premove becomes illegal, the premoves run out,
  a draw, or the opponent mates), it plays the one that ends the game soonest;
* if the plan is sound, it plays the defence that survives longest.

Typical puzzles take well under a millisecond per reply. If a plan is too large to search
exactly (100k positions by default, e.g. a long aimless plan against mobile pieces), it
settles for the first refutation it finds; Stockfish is only consulted if even that fails or
the game leaves the submitted plan. `createPremoveOpponent()` exposes the same
`bestMove(fen)` method as the Stockfish engine, so `session.js` is unchanged, and its
`analysis` property returns the verdict and the line (useful for showing why a plan failed).

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

`PREMOVE_FULL_CHECK=1 npm test` runs the cross-check against the chess.js reference on all
fixture puzzles instead of a quarter of them (about a minute). `npm run check:wasm` needs
Python 3.11+ with `pip install chess` and a C++ compiler (it builds the native engine).

## Game logic

`src/game/session.js` is independent of the UI. It validates each queued player move, including rejecting captures of the opponent's king in the preview, applies the opponent's engine reply between queued moves, detects checkmate/draws, and reports a premove invalidated by an opponent move. The test suite exercises this API directly with a scripted engine.
