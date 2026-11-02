import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const script = new URL("../scripts/download-pieces.mjs", import.meta.url);

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

function png(width = 300, height = 300) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function setup(t, respond) {
  const root = await mkdtemp(join(tmpdir(), "premove-pieces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await copyFile(script, join(root, "scripts", "download-pieces.mjs"));
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    respond(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return {
    root,
    paths,
    origin: `http://127.0.0.1:${server.address().port}`,
    run: (...args) => execFileAsync(process.execPath, [join(root, "scripts", "download-pieces.mjs"), ...args]),
  };
}

test("downloads and installs every piece from the requested origin", async (t) => {
  const image = png();
  const context = await setup(t, (_request, response) => response.end(image));
  await mkdir(join(context.root, "src/assets/pieces"), { recursive: true });
  await writeFile(join(context.root, "src/assets/pieces/wk.png"), "old image");
  const { stdout } = await context.run(context.origin);
  const names = ["wk", "wq", "wp", "wn", "wb", "wr", "bk", "bq", "bp", "bn", "bb", "br"];
  assert.deepEqual(context.paths, names.map((name) => `/chess-themes/pieces/neo/300/${name}.png`));
  assert.deepEqual((await readdir(join(context.root, "src/assets/pieces"))).sort(), names.map((name) => `${name}.png`).sort());
  for (const name of names) {
    assert.deepEqual(await readFile(join(context.root, `src/assets/pieces/${name}.png`)), image);
  }
  assert.match(stdout, /Downloaded 12 pieces/);
});

test("leaves existing images untouched when a download fails", async (t) => {
  const context = await setup(t, (request, response) => {
    if (request.url.endsWith("/br.png")) response.writeHead(404).end();
    else response.end(png());
  });
  const destination = join(context.root, "src/assets/pieces");
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "wk.png"), "original");
  await assert.rejects(context.run(context.origin), (error) => {
    assert.match(error.stderr, /br\.png: HTTP 404/);
    return true;
  });
  assert.deepEqual(await readdir(destination), ["wk.png"]);
  assert.equal(await readFile(join(destination, "wk.png"), "utf8"), "original");
});

test("rejects wrong dimensions and incomplete images before writing", async (t) => {
  let image = png(299, 300);
  const context = await setup(t, (_request, response) => response.end(image));
  await assert.rejects(context.run(context.origin), (error) => {
    assert.match(error.stderr, /not a 300x300 PNG/);
    return true;
  });
  image = png().subarray(0, 33);
  await assert.rejects(context.run(context.origin), (error) => {
    assert.match(error.stderr, /incomplete PNG/);
    return true;
  });
  await assert.rejects(readdir(join(context.root, "src/assets/pieces")), { code: "ENOENT" });
});

test("rejects missing origins and origins with paths", async (t) => {
  const context = await setup(t, (_request, response) => response.end());
  await assert.rejects(context.run(), (error) => {
    assert.match(error.stderr, /Usage:/);
    return true;
  });
  await assert.rejects(context.run(`${context.origin}/path`), (error) => {
    assert.match(error.stderr, /without a path/);
    return true;
  });
  assert.deepEqual(context.paths, []);
});
