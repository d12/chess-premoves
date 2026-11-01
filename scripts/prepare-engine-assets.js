import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "node_modules/stockfish");
const sourceAssets = path.join(source, "src");
const destination = path.join(root, "public/engine");

await mkdir(destination, { recursive: true });

for (const file of [
  "stockfish-nnue-16-single.js",
  "stockfish-nnue-16-single.wasm",
  "nn-5af11540bbfe.nnue",
]) {
  await copyFile(path.join(sourceAssets, file), path.join(destination, file));
}

for (const file of ["Copying.txt", "AUTHORS"]) {
  await copyFile(path.join(source, file), path.join(destination, file));
}
