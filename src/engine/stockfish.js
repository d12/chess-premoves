const CACHE_NAME = "chess-premove-stockfish-16-single-v1";
const SEARCH_NODE_LIMIT = 96;
const ASSETS = Object.freeze([
  {
    file: "stockfish-nnue-16-single.js",
    size: 25_594,
    label: "Engine loader",
    type: "text/javascript",
  },
  {
    file: "stockfish-nnue-16-single.wasm",
    size: 575_029,
    label: "Engine core",
    type: "application/wasm",
  },
  {
    file: "nn-5af11540bbfe.nnue",
    size: 40_119_326,
    label: "Neural network",
    type: "application/octet-stream",
  },
]);

export const STOCKFISH_TOTAL_BYTES = ASSETS.reduce((total, asset) => total + asset.size, 0);

function reportProgress(onProgress, asset, assetLoaded, totalLoaded) {
  onProgress({
    asset: asset.label,
    assetLoaded,
    assetTotal: asset.size,
    loaded: totalLoaded,
    total: STOCKFISH_TOTAL_BYTES,
    percent: Math.min(100, Math.round((totalLoaded / STOCKFISH_TOTAL_BYTES) * 100)),
  });
}

async function downloadAndCache(cache, url, asset, onProgress, loadedBefore) {
  let response = await cache.match(url);
  let loaded = 0;

  if (response) {
    const blob = await response.blob();
    loaded = blob.size;
    reportProgress(onProgress, asset, loaded, loadedBefore + loaded);
    return blob;
  }

  response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to download ${asset.label} (${response.status}).`);
  }

  if (!response.body) {
    const blob = await response.blob();
    await cache.put(url, new Response(blob, {
      headers: { "content-type": asset.type },
    }));
    loaded = blob.size;
    reportProgress(onProgress, asset, loaded, loadedBefore + loaded);
    return blob;
  }

  const [cacheStream, progressStream] = response.body.tee();
  const cacheWrite = cache.put(url, new Response(cacheStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));
  const reader = progressStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      loaded += value.byteLength;
      reportProgress(onProgress, asset, loaded, loadedBefore + loaded);
    }
  } finally {
    reader.releaseLock();
  }
  await cacheWrite;
  const cached = await cache.match(url);
  if (!cached) {
    throw new Error(`Unable to cache ${asset.label}.`);
  }
  return cached.blob();
}

class StockfishEngine {
  #worker;
  #listeners = new Set();
  #rejectors = new Set();
  #failure = null;
  #searchPending = false;

  constructor(worker) {
    this.#worker = worker;
    worker.addEventListener("message", (event) => {
      const line = String(event.data);
      for (const listener of this.#listeners) {
        listener(line);
      }
    });
    worker.addEventListener("error", (event) => {
      this.#fail(new Error(event.message || "The Stockfish worker failed."));
    });
    worker.addEventListener("messageerror", () => {
      this.#fail(new Error("The Stockfish worker sent an unreadable message."));
    });
  }

  #fail(error) {
    this.#failure = error;
    for (const reject of this.#rejectors) {
      reject(error);
    }
  }

  #send(command) {
    this.#worker.postMessage(command);
  }

  #waitForLine(predicate, timeoutMs, description) {
    if (this.#failure) {
      return Promise.reject(this.#failure);
    }
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timer);
        this.#listeners.delete(onLine);
        this.#rejectors.delete(onFailure);
        callback(value);
      };

      const onLine = (line) => {
        if (!predicate(line)) {
          return;
        }
        finish(resolve, line);
      };
      const onFailure = (error) => finish(reject, error);
      const timer = setTimeout(() => {
        finish(reject, new Error(`Stockfish timed out while ${description}.`));
      }, timeoutMs);

      this.#listeners.add(onLine);
      this.#rejectors.add(onFailure);
    });
  }

  async initialize(networkUrl) {
    const uciReady = this.#waitForLine((line) => line === "uciok", 10_000, "initializing UCI");
    this.#send("uci");
    await uciReady;
    this.#send("setoption name Threads value 1");
    this.#send(`setoption name EvalFile value ${networkUrl}`);
    const ready = this.#waitForLine((line) => line === "readyok", 30_000, "loading its neural network");
    this.#send("isready");
    await ready;
  }

  async bestMove(fen, { timeoutMs = 500 } = {}) {
    if (this.#searchPending) {
      throw new Error("Stockfish is already searching another position.");
    }
    this.#searchPending = true;
    const waitForMove = this.#waitForLine((line) => line.startsWith("bestmove "), timeoutMs + 1_000, "searching for a move");
    try {
      this.#send(`position fen ${fen}`);
      this.#send(`go nodes ${SEARCH_NODE_LIMIT}`);
      const line = await waitForMove;
      const move = line.split(/\s+/)[1];
      if (!move || move === "0000") {
        throw new Error("Stockfish did not find a legal move.");
      }
      return move;
    } catch (error) {
      this.#send("stop");
      throw error;
    } finally {
      this.#searchPending = false;
    }
  }
}

export async function createStockfishEngine({ onProgress = () => {} } = {}) {
  if (!("caches" in globalThis)) {
    throw new Error("This browser does not support persistent engine caching.");
  }
  if (typeof WebAssembly !== "object") {
    throw new Error("This browser does not support WebAssembly.");
  }

  const baseUrl = new URL(import.meta.env?.BASE_URL ?? "/", document.baseURI);
  const cache = await caches.open(CACHE_NAME);
  const blobs = {};
  let loaded = 0;

  for (const asset of ASSETS) {
    const url = new URL(`engine/${asset.file}`, baseUrl).href;
    blobs[asset.file] = await downloadAndCache(
      cache,
      url,
      asset,
      onProgress,
      loaded,
    );
    loaded += blobs[asset.file].size;
  }

  const urls = Object.fromEntries(ASSETS.map((asset) => [
    asset.file,
    URL.createObjectURL(new Blob([blobs[asset.file]], { type: asset.type })),
  ]));
  const scriptUrl = urls["stockfish-nnue-16-single.js"];
  const wasmUrl = urls["stockfish-nnue-16-single.wasm"];
  const networkUrl = urls["nn-5af11540bbfe.nnue"];
  let worker;
  try {
    worker = new Worker(`${scriptUrl}#${encodeURIComponent(wasmUrl)}`);
    const opponent = new StockfishEngine(worker);
    await opponent.initialize(networkUrl);
    return opponent;
  } catch (error) {
    worker?.terminate();
    throw error;
  } finally {
    for (const url of Object.values(urls)) {
      URL.revokeObjectURL(url);
    }
  }
}
