import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(new URL("../src/assets/pieces/", import.meta.url));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function parseOrigin(input) {
  if (!input) throw new Error("Usage: npm run download:pieces -- <domain or HTTP(S) origin>");
  const url = new URL(input.includes("://") ? input : `https://${input}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Provide an HTTP(S) domain or origin without a path, credentials, query, or fragment.");
  }
  return url.origin;
}

function validatePng(data, name) {
  if (data.length < 33 || !data.subarray(0, 8).equals(pngSignature)
      || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR"
      || data.readUInt32BE(16) !== 300 || data.readUInt32BE(20) !== 300) {
    throw new Error(`${name} is not a 300x300 PNG.`);
  }
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > data.length) break;
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT" && length > 0) hasImageData = true;
    if (type === "IEND" && length === 0 && end === data.length && hasImageData) return;
    offset = end;
  }
  throw new Error(`${name} is an incomplete PNG.`);
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("Usage: npm run download:pieces -- <domain or HTTP(S) origin>");
  }
  const origin = parseOrigin(process.argv[2]);
  const assets = [];
  for (const color of ["w", "b"]) {
    for (const piece of ["k", "q", "p", "n", "b", "r"]) {
      const name = `${color}${piece}.png`;
      const url = `${origin}/chess-themes/pieces/neo/300/${name}`;
      let response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      } catch (error) {
        throw new Error(`Failed to download ${url}: ${error.message}`, { cause: error });
      }
      if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      validatePng(data, name);
      assets.push({ name, data });
    }
  }
  await mkdir(destination, { recursive: true });
  for (const { name, data } of assets) {
    await writeFile(new URL(`../src/assets/pieces/${name}`, import.meta.url), data);
  }
  console.log(`Downloaded ${assets.length} pieces to ${destination}`);
}

main().catch((error) => {
  console.error(`Could not install pieces: ${error.message}`);
  process.exitCode = 1;
});
