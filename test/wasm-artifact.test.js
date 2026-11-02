// The committed WebAssembly module must match its C++ sources, so a deploy never ships an
// opponent built from older code (this also catches commits made with --no-verify).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { MODULE_FILE, isUpToDate } from "../scripts/wasm-stamp.mjs";

const built = existsSync(new URL(`../${MODULE_FILE}`, import.meta.url));

test("the WebAssembly opponent was built from the current C++ sources",
  { skip: built ? false : "WebAssembly engine not built: run `npm run build:wasm`" }, () => {
    assert.ok(isUpToDate(), "C++ sources changed since the module was built: run `npm run build:wasm` and commit the result");
  });
