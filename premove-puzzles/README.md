# ppz — premove puzzle finder

Finds chess positions where white can **premove** a fixed sequence of moves that
checkmates black no matter how black replies, scores them for interest, keeps the batch
varied, and moves the ones you approve into a puzzle database.

```
./ppz generate --min-moves 4 --pieces knight --count 10 --minutes 3
./ppz review
./ppz db export --format json > puzzles_for_game.json
```

## Setup

Needs Python 3.11+, a C++17 compiler (`g++` or `clang++`) and, ideally, Stockfish.

**MacBook (Apple Silicon or Intel)**
```
xcode-select --install           # clang + make, if not already there
pip install chess
brew install stockfish           # optional, speeds up material that tables don't cover
./ppz info                       # shows what was detected
./ppz tables build               # one-time: 3-4 piece mate tables on CPU (~1-3 min)
./ppz tables build --five        # optional: 5-piece tables (~1 GB each, several min each on CPU)
```

**Ubuntu with an NVIDIA GPU (e.g. RTX 3090)**
```
sudo apt install build-essential stockfish nvidia-cuda-toolkit   # or NVIDIA's own CUDA toolkit
pip install chess
./ppz info                       # should list the GPU and "table device cuda"
./ppz tables build               # builds on the GPU, including the 5-piece tables
```
For other GPUs set the architecture when building: `make -C engine cuda CUDA_ARCH=89`
(RTX 40xx), `80` (A100); the default `86` is the 3090.

Tables are plain files in `tables/` (or `$PPZ_TABLES`) and are identical whichever device
built them, so you can build on the 3090 box and copy the folder to the Mac.

Or `pip install -e .` to get `ppz` on your PATH. Stockfish is found on PATH, in the usual
install locations, via `$STOCKFISH`, or `--stockfish PATH`.

## Hardware: what runs where

| part | runs on | why |
|---|---|---|
| mate tables (`ppz tables build`) | **NVIDIA GPU** if available, else all CPU cores | uniform "update every position, repeat" work — ideal for a GPU |
| puzzle search (`generate`, `solve`) | CPU, one worker per thread | deep, branchy tree search with caches; GPUs are bad at this |
| Stockfish | CPU | Stockfish has no GPU mode |

The GPU is used where it actually helps: building exact **distance-to-mate tables** for
"white pieces vs lone black king" (KQR-K, KRB-K, KRBN-K, …), which covers most generated
puzzles. With tables, the search's most expensive step — "is there an ordinary mate in ≤ N
from here?" — becomes one memory lookup, both at the root (instant rejection of
non-puzzles, no Stockfish call) and at every node of the premove search.

Measured on this 2-core sandbox, 60 s of generation on lone-king material, Stockfish on in
both runs:

| | without tables | with tables |
|---|---|---|
| positions examined | 3,715 | 8,129 |
| candidates (4–6 moves) | 601 | 1,989 |
| 6-move candidates | 25 | 569 |
| premove tax ≥ 2 | 53 | 317 |

Positions that used to exceed the search budget (mostly the long, interesting ones) now
solve. Material with pawns or black pieces still uses the search + Stockfish path.

Table build cost (cap 15): 3–4 piece tables are 17 MB each and take ~10 s each on 2
CPU cores. 5-piece tables are 1 GB each, ~64x the work: minutes on a laptop CPU, seconds
on a 3090. The CPU and CUDA builders share the same per-position code
(`engine/src/tb_core.h`).

## Commands

| command | what it does |
|---|---|
| `ppz generate` | search for candidates, print them, append them to the review queue |
| `ppz review` | step through the queue (solutions hidden until you press `s`); `a` accepts into the db |
| `ppz solve FEN` | analyse any position: shortest premove plan, ordinary mate length, score |
| `ppz add FEN ...` / `--file f.txt` | verify and add positions straight to the db |
| `ppz db list\|stats\|export\|remove` | manage the db; export as `json`, `jsonl`, `csv` or `sql` |
| `ppz queue list\|clear` | manage the review queue |
| `ppz tables build\|status` | build mate tables on GPU/CPU (`--device`, `--five`) / list them |
| `ppz info` | detected CPU, GPU, CUDA, Stockfish and tables |

### `generate` options

| option | meaning |
|---|---|
| `--min-moves N` | minimum premoves needed (the puzzle's `number_of_moves`) |
| `--max-moves N` | upper bound searched (default 6; 7–8 works but each extra move costs a lot more) |
| `--pieces N,B` | these piece types must move in a shortest solution (`Q R B N P K` or names) |
| `--strict` | …and in **every** shortest solution (no way around using them) |
| `--material KQR-K,KRB-KP` | material to sample, white-black; `:weight` sets frequency |
| `--count`, `--minutes` | batch size and search time |
| `--details` | also print solutions and score breakdowns |
| `--workers` | parallel workers (default: one per core) |

Each puzzle is printed as a review block:

```json
{
  "fen": "8/8/2k5/8/8/8/3Q4/4R2K w - - 0 1",
  "url": "https://www.chess.com/analysis?fen=8%2F8%2F2k5%2F8%2F8%2F8%2F3Q4%2F4R2K+w+-+-+0+1",
  "number_of_moves": 3,
  "solution": ["Rc1", "Qb2", "Ra1"]
}
```

`solution` is one shortest premove sequence (when several exist, the analysis says how
many). The queue entry also stores the full analysis and score breakdown, which
`ppz review` shows; there the solution stays hidden until you press `s`. `ppz db export`
keeps its default fields (`fen,url,number_of_moves`); add `solution` with
`--fields fen,url,number_of_moves,solution`.

Files: `review_queue.jsonl` and `puzzles.json` in the current directory by default
(override with `--queue` / `--db` or `PPZ_QUEUE` / `PPZ_DB`).

## Browser opponent (WebAssembly)

`engine/src/refute.hpp` finds the opponent's best defence against a known premove list
(the game's opponent; see the top-level README). It uses only the move generator, so it
builds natively and to WebAssembly from the same source:

```
make -C engine wasm                       # needs em++ (Emscripten); output: ../src/engine/generated/
printf 'analyze\t<FEN>\t<uci premoves>\n' | engine/pmcore refute     # native, same JSON API
python3 tests/wasm_check.py               # WebAssembly == native == python verifier on fresh puzzles
```

Its outcome rules mirror the game exactly (chess.js draw rules: stalemate, insufficient
material, 50 moves, threefold repetition). Repetition is tracked only when the plan returns
a white piece set-up to an earlier one, which is the only way it can occur.

## Rules the solver implements

* White moves first; a premove is `(from, to, promotion)`, exactly like a UI premove.
* Every premove must be legal when its turn comes, in every line black can choose.
  Captures of a premoved piece, blocks, and checks that the premove doesn't answer all
  break a plan.
* Black must be checkmated in every line. Mate may come before the last premove; any
  stalemate is a failure. `number_of_moves` is the length of the shortest working plan.

## How it works

### 1. Solving: search over belief states (`engine/src/solver.hpp`)

A premove plan is *open-loop*: white can't react to black. So instead of a game tree the
solver searches over **beliefs** — the set of positions black could have steered into:

* a white move is a candidate only if it's legal in **every** position of the belief;
* after it, mated positions drop out, any stalemate kills the move, and the rest expand by
  every black reply into the next belief (deduplicated by hash);
* the plan works when the belief is empty. Iterative deepening gives the shortest length.

For lone-king puzzles the belief is just "where can the king be" — rarely more than a
dozen positions — so this is cheap.

**The key prune.** Any premove plan is also an ordinary forced mate. So every position in
a belief with `r` moves left must have a normal mate in ≤ `r`. That is checked with a
cached AND/OR mate prover (with refutation and history ordering) and kills almost every bad
branch immediately. Failed beliefs are cached too. Shortest-plan counting reuses the same
machinery with memoisation.

### 2. Finding candidates (`engine/src/pmcore.cpp`, `gen` mode)

* **Structured sampling.** Material is drawn from a weighted list. The black king is
  biased to edges and corners; minor pieces and the white king are placed near it; black
  pawns often sit beside their own king (self-blocks make mating nets possible).
* **Local search.** Most puzzles are found by mutating previously found ones (step a
  piece, relocate one, swap a piece type, add/remove a black pawn). Neighbours of puzzles
  are often puzzles. Positions slightly too short are kept as stepping stones, and parents
  are picked half uniformly by kind (diversity) and half by a length tournament (pushes
  toward longer puzzles).
* **Symmetry dedup.** Positions are canonicalised under board symmetries (all 8 without
  pawns, left-right mirror with pawns) so mirror images are never solved twice.
* **Hybrid Stockfish screen.** Proving "no mate within N" is the expensive part. Measured on
  this machine: real puzzles take a median of ~4k solver nodes (p90 ~60k) while rejects
  take ~120k (p90 ~700k). Stockfish at a few thousand nodes spots short mates in ~3 ms but
  misses 40–60% of real premove puzzles. So:
  * Stockfish sees a short mate → exact solve with the full budget;
  * Stockfish sees nothing → exact solve with a small budget (20k nodes) anyway.
  In a 60 s benchmark the hybrid found as many candidates as a hard Stockfish filter but
  ~55% more with 5+ moves, and over half of everything it found were puzzles Stockfish
  had missed. A hard filter would have thrown those away — and they skew toward the less
  obvious ones.

### 3. What makes a puzzle interesting (`premove_puzzles/quality.py`, weights in `config.toml`)

| feature | why |
|---|---|
| length | more moves to plan blind |
| **premove tax** = premove length − ordinary mate length | the heart of the game: when the normal mate doesn't survive being premoved, the solver must think differently |
| unique solution / unique first move | composition standard; fewer accidental solves |
| quiet moves, quiet first move | checks are forcing and obvious; quiet moves are not |
| offers | a premove leaves a piece en prise but the plan works anyway |
| belief width | how many black possibilities the plan must cover at once |
| distinct movers, mating-piece variety | the whole army does something |
| economy, redundant pieces | each piece is re-tested by removing it; a white piece that isn't needed (or black piece that changes nothing) is clutter; a black piece whose removal makes it easier is a real defender and scores up |
| engine trap | Stockfish's own mating line, premoved, fails |

### 4. Variety

* **Near-duplicates merged**: same material and either the same set-up with one piece
  moved, or solutions sharing most (piece, destination) pairs under symmetry. Mutation
  finds whole families; only the best member survives.
* **MAP-Elites archive**: candidates are binned by (length, material, piece types moved,
  quiet/checking first move); each bin keeps its best two. The final batch is picked
  greedily by score with penalties for repeating material, working pieces or length.

## Correctness

* `tests/crosscheck.py` compares the engine against an independent, unpruned python-chess
  brute force (`premove_puzzles/verify.py`): 420 random positions at depth 2–3, 0
  mismatches in shortest length; solution counts also match.
* `tests/tbcheck.cpp` checks the tables against the search-based mate prover (600
  positions) and full premove solutions/counts with tables on vs off (200): 0 mismatches.
  Longest mates also match published tablebase statistics (KQ-K 10, KR-K 16, KBN-K 33,
  KBB-K 19, KQQ-K 4, KRR-K 7, KQB-K 8, KQN-K 9).
* Every generated plan is re-verified by the python verifier before it reaches the queue,
  and again when you accept it. ~2,600 generated plans (3–6 moves) verified, 0 failures.

## Connecting to the game

`puzzles.json` is a plain array. `ppz db export --format json|jsonl|csv|sql --fields ...`
reshapes it; adapt `store.py` (`Database.add` / `export`) if the game's store is
something else.

## Notes and limits

* Puzzles where black has mobile pieces (rooks, queens) make beliefs explode; the search
  aborts cleanly above 50k positions per belief. Pawns and minor pieces are fine.
* Generated positions have no castling rights or en-passant square.
* Lengths above ~7 are expensive; the default range is 3–6. Tables are built to a cap of
  15 moves; keep `--cap` ≥ `--max-moves` (positions beyond the cap fall back to search).
* Apple GPUs (Metal) are not used: tables are a one-time cost and the Mac's CPU cores
  build the 3-4 piece set in a couple of minutes. The CUDA builder was compile-checked for
  sm_86 but developed without a GPU; it shares all per-position logic with the tested CPU
  builder, and `ppz tables build --device cpu` is always available as a fallback.
* The engine uses the MIT-licensed [chess-library](https://github.com/Disservin/chess-library)
  (`engine/vendor`).
