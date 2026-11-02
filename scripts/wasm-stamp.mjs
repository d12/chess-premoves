// Fingerprint of the C++ sources the WebAssembly opponent is built from.
//
//   node scripts/wasm-stamp.mjs write   record the fingerprint (run after building the module)
//   node scripts/wasm-stamp.mjs check   exit 1 if the sources changed since the last build
//
// `npm run build:wasm` writes it; the pre-commit hook and test/wasm-artifact.test.js check it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

export const WASM_SOURCES = [
  "premove-puzzles/engine/wasm/premove_wasm.cpp",
  "premove-puzzles/engine/src/refute.hpp",
  "premove-puzzles/engine/src/refute_api.hpp",
  "premove-puzzles/engine/vendor/chess.hpp",
  "premove-puzzles/engine/Makefile", // build flags
];
export const MODULE_FILE = "src/engine/generated/premove-engine.js";
export const STAMP_FILE = "src/engine/generated/premove-engine.sources.sha256";

export function sourcesHash() {
  const hash = createHash("sha256");
  for (const file of WASM_SOURCES) {
    // normalise line endings so a checkout with CRLF conversion gives the same fingerprint
    const text = readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    hash.update(`${file}\0${text}\0`);
  }
  return hash.digest("hex");
}

export function recordedHash() {
  const stamp = path.join(root, STAMP_FILE);
  return existsSync(stamp) ? readFileSync(stamp, "utf8").split(/\s+/)[0] : null;
}

export function isUpToDate() {
  return existsSync(path.join(root, MODULE_FILE)) && recordedHash() === sourcesHash();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "write") {
    writeFileSync(path.join(root, STAMP_FILE),
      `${sourcesHash()}  sha256 of: ${WASM_SOURCES.join(", ")}\n`);
    console.log(`recorded wasm source fingerprint in ${STAMP_FILE}`);
  } else if (command === "check") {
    if (isUpToDate()) {
      console.log("WebAssembly opponent is up to date with its C++ sources");
    } else {
      console.error("WebAssembly opponent is out of date: its C++ sources changed since the last build.\n"
        + "Run `npm run build:wasm` (needs Emscripten: brew install emscripten).");
      process.exit(1);
    }
  } else {
    console.error("usage: node scripts/wasm-stamp.mjs write|check");
    process.exit(2);
  }
}
