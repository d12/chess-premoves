import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { precacheManifest, renderServiceWorker, writeServiceWorker } from "../scripts/service-worker.mjs";

function fakeBuild(files) {
  const dir = mkdtempSync(join(tmpdir(), "premove-sw-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("the precache list is every built file (relative to the worker) plus the start URL", () => {
  const dir = fakeBuild({
    "index.html": "<html>",
    "assets/index-abc.js": "js",
    "assets/index-abc.css": "css",
    "icon-192.png": "png",
    "sw.js": "old worker",
    ".DS_Store": "junk",
    "assets/index-abc.js.map": "map",
  });
  try {
    const { urls, version } = precacheManifest(dir);
    assert.deepEqual(urls, ["./", "./assets/index-abc.css", "./assets/index-abc.js", "./icon-192.png", "./index.html"]);
    assert.match(version, /^[0-9a-f]{12}$/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("the version changes with any file's contents, and only then", () => {
  const dir = fakeBuild({ "index.html": "<html>", "assets/a.js": "one" });
  try {
    const first = precacheManifest(dir).version;
    assert.equal(precacheManifest(dir).version, first);
    writeFileSync(join(dir, "sw.js"), "the worker itself doesn't count");
    assert.equal(precacheManifest(dir).version, first);
    writeFileSync(join(dir, "assets/a.js"), "two");
    assert.notEqual(precacheManifest(dir).version, first);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("writeServiceWorker writes sw.js with the version and file list filled in", () => {
  const dir = fakeBuild({ "index.html": "<html>" });
  try {
    const manifest = writeServiceWorker(dir);
    const source = renderServiceWorker(manifest);
    assert.match(source, new RegExp(`^const VERSION = "${manifest.version}";`));
    assert.ok(source.includes('"./index.html"'));
    assert.ok(source.includes('addEventListener("fetch"'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// Runs the real worker source against fake service-worker globals.
function loadWorker({ version = "v2", urls = ["./", "./index.html", "./assets/app.js"], existingCaches = {} } = {}) {
  const scope = "https://example.test/chess-premoves/";
  const stores = new Map(Object.entries(existingCaches).map(([name, entries]) => [name, new Map(Object.entries(entries))]));
  const listeners = {};
  const network = [];
  const response = (body) => ({ body });
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async addAll(list) {
          for (const request of list) {
            assert.equal(request.cache, "reload", "precache bypasses the HTTP cache");
            store.set(new URL(request.url, scope).href, response(`cached ${request.url}`));
          }
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request, { cacheName, ignoreSearch } = {}) {
      const url = new URL(typeof request === "string" ? request : request.url);
      if (ignoreSearch) url.search = "";
      return stores.get(cacheName)?.get(url.href);
    },
  };
  const self = {
    registration: { scope },
    location: new URL(`${scope}sw.js`),
    clients: { claimed: false, async claim() { this.claimed = true; } },
    skipped: false,
    skipWaiting() { this.skipped = true; },
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  class Request {
    constructor(url, { cache } = {}) {
      this.url = url;
      this.cache = cache;
    }
  }
  const context = vm.createContext({
    self, caches, URL, Promise, console, Request,
    fetch: async (request) => { network.push(typeof request === "string" ? request : request.url); return response("network"); },
  });
  vm.runInContext(renderServiceWorker({ version, urls }), context);
  const dispatch = async (type, event = {}) => {
    let pending = null;
    let responded = null;
    listeners[type]({ ...event, waitUntil(promise) { pending = promise; }, respondWith(promise) { responded = promise; } });
    await pending;
    return responded ? await responded : undefined;
  };
  return { stores, self, network, dispatch, scope };
}

test("install precaches everything and takes over at once", async () => {
  const worker = loadWorker();
  await worker.dispatch("install");
  assert.deepEqual([...worker.stores.get("premove-v2").keys()], [
    "https://example.test/chess-premoves/",
    "https://example.test/chess-premoves/index.html",
    "https://example.test/chess-premoves/assets/app.js",
  ]);
  assert.equal(worker.self.skipped, true);
});

test("activate drops older game caches, keeps unrelated ones, and claims open pages", async () => {
  const worker = loadWorker({ existingCaches: { "premove-v1": {}, "someone-else": {} } });
  await worker.dispatch("install");
  await worker.dispatch("activate");
  assert.deepEqual([...worker.stores.keys()].sort(), ["premove-v2", "someone-else"]);
  assert.equal(worker.self.clients.claimed, true);
});

test("requests are served from the cache, offline included", async () => {
  const worker = loadWorker();
  await worker.dispatch("install");
  const asset = await worker.dispatch("fetch", { request: { method: "GET", mode: "no-cors", url: `${worker.scope}assets/app.js?v=1` } });
  assert.equal(asset.body, "cached ./assets/app.js");
  // any navigation in the app gets the cached page
  const page = await worker.dispatch("fetch", { request: { method: "GET", mode: "navigate", url: `${worker.scope}?from=homescreen` } });
  assert.equal(page.body, "cached ./index.html");
  assert.deepEqual(worker.network, []);
});

test("anything not precached goes to the network; other origins and non-GETs are left alone", async () => {
  const worker = loadWorker();
  await worker.dispatch("install");
  const missing = await worker.dispatch("fetch", { request: { method: "GET", mode: "cors", url: `${worker.scope}not-there.json` } });
  assert.equal(missing.body, "network");
  assert.equal(await worker.dispatch("fetch", { request: { method: "GET", mode: "cors", url: "https://fonts.example/x.woff2" } }), undefined);
  assert.equal(await worker.dispatch("fetch", { request: { method: "POST", mode: "cors", url: `${worker.scope}index.html` } }), undefined);
});
