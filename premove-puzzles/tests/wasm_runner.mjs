// Line-oriented driver for the WebAssembly engine, mirroring `pmcore refute`:
//   analyze<TAB>FEN<TAB>premoves[<TAB>nodes]
//   reply<TAB>FEN<TAB>premoves<TAB>history[<TAB>nodes]
// usage: node wasm_runner.mjs [path/to/premove-engine.js]
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";

const modulePath = process.argv[2]
  ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../src/engine/generated/premove-engine.js");
const { default: createModule } = await import(pathToFileURL(modulePath).href);
const m = await createModule();
const analyze = m.cwrap("pm_analyze", "string", ["string", "string", "number"]);
const reply = m.cwrap("pm_reply", "string", ["string", "string", "string", "number"]);

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line) continue;
  const f = line.split("\t");
  let out;
  if (f[0] === "analyze" && f.length >= 3) out = analyze(f[1], f[2], f[3] ? Number(f[3]) : 2e6);
  else if (f[0] === "reply" && f.length >= 4) out = reply(f[1], f[2], f[3], f[4] ? Number(f[4]) : 2e6);
  else out = JSON.stringify({ ok: false, error: "bad request" });
  process.stdout.write(out + "\n");
}
