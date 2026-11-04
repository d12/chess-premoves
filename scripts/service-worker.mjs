// Builds dist/sw.js: src/service-worker.js with the list of files to precache and a version
// derived from their contents, so every deploy that changes anything gets a new worker.
// Used by the Vite plugin in vite.config.js; dependency-free.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_FILE = "sw.js";
const TEMPLATE = fileURLToPath(new URL("../src/service-worker.js", import.meta.url));

function listFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Every file in the build, as URLs relative to the worker ("./assets/…"), plus "./". */
export function precacheManifest(outDir) {
  const files = listFiles(outDir)
    .map((path) => relative(outDir, path).split(sep).join("/"))
    .filter((path) => path !== WORKER_FILE && !path.startsWith(".") && !path.endsWith(".map"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0").update(readFileSync(join(outDir, file))).update("\0");
  }
  return {
    version: hash.digest("hex").slice(0, 12),
    urls: ["./", ...files.map((file) => `./${file}`)],
  };
}

/** The worker's source with VERSION and PRECACHE filled in. */
export function renderServiceWorker({ version, urls }, template = readFileSync(TEMPLATE, "utf8")) {
  return `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(urls, null, 2)};\n\n${template}`;
}

export function writeServiceWorker(outDir) {
  const manifest = precacheManifest(outDir);
  writeFileSync(join(outDir, WORKER_FILE), renderServiceWorker(manifest));
  return manifest;
}

/** Vite plugin: writes dist/sw.js after every production build. */
export function serviceWorkerPlugin() {
  let outDir = null;
  return {
    name: "premove-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const { version, urls } = writeServiceWorker(outDir);
      this.info?.(`service worker ${version}: ${urls.length} files precached`);
    },
  };
}
