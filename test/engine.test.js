import assert from "node:assert/strict";
import test from "node:test";
import { createStockfishEngine, STOCKFISH_TOTAL_BYTES } from "../src/engine/stockfish.js";

test("the selected Stockfish engine assets stay below the 50 MB limit", () => {
  assert.ok(STOCKFISH_TOTAL_BYTES < 50_000_000);
});

test("engine assets are downloaded once and reused on later starts", async (t) => {
  const entries = new Map();
  const fetched = [];
  const workerCommands = [];
  const cache = {
    async match(url) {
      return entries.get(url)?.clone();
    },
    async put(url, response) {
      entries.set(url, new Response(await response.blob(), { headers: response.headers }));
    },
  };
  class FakeWorker extends EventTarget {
    postMessage(command) {
      workerCommands.push(command);
      const reply = command === "uci" ? "uciok" : command === "isready" ? "readyok"
        : command.startsWith("go ") ? "bestmove e2e4" : null;
      if (reply) {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: reply })));
      }
    }

    terminate() {}
  }
  const originals = new Map();
  function setGlobal(name, value) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  });
  setGlobal("document", { baseURI: "https://example.test/app/" });
  setGlobal("caches", { open: async () => cache });
  setGlobal("Worker", FakeWorker);
  setGlobal("fetch", async (url) => {
    fetched.push(url);
    return new Response("asset");
  });

  await createStockfishEngine();
  assert.equal(fetched.length, 3);
  assert.equal(entries.size, 3);

  const engine = await createStockfishEngine();
  assert.equal(workerCommands.filter((command) => command === "uci").length, 2);
  assert.equal(fetched.length, 3);
  assert.equal(await engine.bestMove("test position"), "e2e4");

  entries.delete([...entries.keys()][1]);
  await createStockfishEngine();
  assert.equal(fetched.length, 4);
});
