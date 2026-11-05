# Puzzle building guide

How to find new premove puzzles and put them in the game. Run all `ppz` commands from the
`puzzle-finder/` folder.

## One-time setup

```sh
cd puzzle-finder
python3 -m venv .venv && source .venv/bin/activate && pip install chess
brew install stockfish          # optional, makes generation faster
./ppz tables build              # 1–2 minutes; makes generation several times faster
./ppz info                      # check what was detected
```

In every new Terminal window, run `source .venv/bin/activate` again first.

## Two files called `puzzles.json`

| file | what it is | written by |
|---|---|---|
| `puzzle-finder/puzzles.json` | your **shortlist** of puzzles you accepted in review | `ppz review`, `ppz add` |
| `src/game/puzzles.json` | the **game's** levels, one per world-level (`1-1` … `5-5`) | `ppz app` only |

Nothing reaches the game until you run `ppz app add`.

---

## Route A: generate, review, add

### 1. Generate candidates

```sh
./ppz generate --min-moves 3 --count 15 --minutes 5
```

| option | what it does |
|---|---|
| `--min-moves N` / `--max-moves N` | length range (default max 6). The batch is spread evenly over the range |
| `--min-moves 2 --max-moves 3` | easy puzzles only |
| `--min-pieces N` / `--max-pieces N` | total pieces on the board, kings included. Extra pawns and minor pieces are added as scenery |
| `--pieces knight` | a knight must move in a shortest solution (`Q R B N P K` or names, comma-separated) |
| `--strict` | ...and in **every** shortest solution |
| `--material KRB-K,KQ-KP` | only these piece sets (white-black) |
| `--count N` | how many puzzles to output |
| `--minutes N` | search time (a hard limit) |
| `--details` | also print each solution and why it scored well |

Candidates are printed and added to the review queue (`review_queue.jsonl`). Puzzles you
have already queued or accepted are never generated again.

### 2. Review

```sh
./ppz review
```

Each puzzle is shown with its solution hidden so you can try it first.

| key | action |
|---|---|
| `o` | open on chess.com |
| `s` | show the solution |
| `v` | re-verify the solution against every defence |
| `a` | accept into your shortlist |
| `r` | reject |
| `n` | skip for now |
| `q` | quit (resume later) |

Use `./ppz review --show-solutions` to see solutions straight away.

### 3. Add shortlisted puzzles to the game

```sh
./ppz db list                                       # numbered shortlist
./ppz app add --from-db 3 --level 2-1               # shortlist #3 becomes world 2, level 1
./ppz app add --from-db 5 --level 3-2 --yes         # ...without the "replace?" question
./ppz app add --from-db 7 --level 5-5 --title "Corner squeeze"
```

---

## Route B: add a position by FEN

Got a position from somewhere else? The game needs **White to move**. On chess.com's
analysis board you can set up a position and copy its FEN.

```sh
./ppz solve "8/8/2k5/8/8/8/3Q4/4R2K w - - 0 1"      # check it first: length, solution, score
./ppz app add "8/8/2k5/8/8/8/3Q4/4R2K w - - 0 1" --level 3-2   # make it world 3, level 2
```

`solve` tells you whether there is a premove mate, how many moves it needs, and the
solution. If there is none within 8 moves (try `--max-moves 10`), it isn't a puzzle.

To keep a position in your shortlist without adding it to the game yet:
`./ppz add "FEN"`.

---

## Managing the game's levels

```sh
./ppz app list                              # all 25 levels; "(same as 1-1)" marks a repeat
./ppz app list --solutions                  # ...with solutions
./ppz app add "FEN" --level 4-3             # put a puzzle in world 4, level 3 (asks first)
```

- There are 5 worlds × 5 levels, and every world-level always has exactly one puzzle, with
  its world-level (`4-3`) as its id. `add --level` replaces whatever is at that level, so
  levels never shift or renumber, and there is no `remove`.
- To fill the game with different puzzles, run `ppz app list` and replace the levels marked
  "(same as …)".
- `add` solves and verifies the position, stores the shortest solution, and generates a
  title (e.g. "Rook and bishop vs king") and description unless you pass `--title` /
  `--description`.
- It refuses a position that is already at another level, including mirror images
  (`--allow-duplicate` overrides).
- `--yes` skips the confirmation prompt (needed when not running interactively).
- Players' progress is saved by world-level, so replacing a level's puzzle keeps it
  completed for returning players.

## Check, play, ship

```sh
cd ..
npm test              # checks every level: all 25 world-levels present, the solution can be entered, it beats the opponent
npm run dev           # play it yourself in the browser
git add src/game/puzzles.json && git commit -m "Add puzzles" && git push
```

## Troubleshooting

| symptom | what to do |
|---|---|
| few or no candidates | more `--minutes`, a lower `--min-moves`, or a different `--material` |
| "Stockfish failed N time(s)" | the run carried on without it; the positions are in `stockfish-errors.log` |
| generation is slow | run `./ppz tables build`; positions with pawns (including `--min-pieces`) can't use the tables and are slower |
| `app add` says "not a valid puzzle" | there is no forced premove mate within `--max-moves` (default 10), or it's Black to move |
| `npm test` fails on a level | its message names the level (e.g. `3-2`); replace it with `ppz app add ... --level 3-2` |
