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

## Game logic

`src/game/session.js` is independent of the UI. It validates each queued player move, including rejecting captures of the opponent's king in the preview, applies the opponent's engine reply between queued moves, detects checkmate/draws, and reports a premove invalidated by an opponent move. The test suite exercises this API directly with a scripted engine.
