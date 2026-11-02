"""ppz - premove puzzle tooling.

  ppz generate   find candidate puzzles and put them in the review queue
  ppz solve      analyse any FEN
  ppz review     step through the queue: accept into the database / reject
  ppz add        add FENs straight to the database (verified first)
  ppz db         list / stats / export / remove
  ppz queue      list / clear the review queue
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import queue as queue_mod
import re
import sys
import time
import tomllib
import webbrowser
from pathlib import Path

from .engine import (TABLES_DIR, GeneratorPool, Solver, build_tables, chesscom_url, cuda_buildable, cuda_gpus,
                     ensure_binary, find_stockfish, pick_device, table_files)
from .app import DEFAULT_APP_PUZZLES, AppPuzzles
from .quality import DEFAULT_WEIGHTS, Archive, Scored, canonical_key, score
from .store import DEFAULT_DB, DEFAULT_QUEUE, Database, Queue, review_block
from .verify import verify_plan

ROOT = Path(__file__).resolve().parent.parent
PIECE_NAMES = {"queen": "Q", "rook": "R", "bishop": "B", "knight": "N", "pawn": "P", "king": "K",
               "q": "Q", "r": "R", "b": "B", "n": "N", "p": "P", "k": "K"}

DEFAULT_MATERIAL = ["KQR-K", "KRR-K", "KRB-K", "KRN-K", "KQB-K", "KQN-K", "KRBN-K:0.6", "KQ-KP", "KQ-KPP",
                    "KR-KP", "KRB-KP", "KQR-KP", "KQN-KP:0.6", "KRP-K:0.6", "KQP-K:0.6", "KBBN-K:0.4",
                    "KQQ-K:0.3"]


def load_config(path: str | None) -> dict:
    p = Path(path) if path else (Path("config.toml") if Path("config.toml").exists() else ROOT / "config.toml")
    if p.exists():
        with p.open("rb") as f:
            return tomllib.load(f)
    return {}


def parse_pieces(text: str | None) -> str:
    if not text:
        return ""
    out = ""
    for tok in text.replace(",", " ").split():
        t = tok.lower()
        if t in PIECE_NAMES:
            out += PIECE_NAMES[t]
        elif all(c in "qrbnpk" for c in t):
            out += t.upper()
        else:
            sys.exit(f"unknown piece '{tok}' (use Q R B N P K or names like knight)")
    return "".join(sorted(set(out), key="KQRBNP".index))


def err(*a):
    print(*a, file=sys.stderr, flush=True)


def pretty(obj) -> str:
    """Indented JSON, but with move lists kept on one line: "solution": ["Rc1", "Qb2", "Ra1"]."""
    text = json.dumps(obj, indent=2)
    return re.sub(r'\[\s+((?:"[^"]*",?\s*)+)\]',
                  lambda m: "[" + ", ".join(re.findall(r'"[^"]*"', m.group(1))) + "]", text)


def describe(d: dict, sc: Scored | None = None, reveal: bool = True, solution_line: bool = True) -> str:
    lines = []
    tax = d.get("premove_tax", 0)
    head = f"{d['material']}  ·  {d['n']} premoves"
    head += f"  (ordinary mate: {d['closed']})" if tax else "  (same as ordinary mate)"
    sols = d.get("solutions", 0)
    head += f"  ·  {sols}{'+' if d.get('solutions_capped') else ''} shortest solution{'s' if sols != 1 else ''}"
    if sc:
        head = f"score {sc.score:>5.1f}  ·  " + head
    lines.append(head)
    if reveal:
        if solution_line:  # skipped when the JSON block above already shows the solution
            plan = "  ".join(f"{i + 1}.{m}" for i, m in enumerate(d["plan_san"]))
            lines.append(f"solution: {plan}")
        widths = "→".join(str(s["belief"]) for s in d["steps"])
        lines.append(f"positions tracked per move: {widths}   moved: {d['moved_types']}   mate by: {d['mate_pieces']}")
    else:
        lines.append("solution: (hidden; press s)")
    if sc and sc.breakdown:
        top = sorted(sc.breakdown.items(), key=lambda kv: -abs(kv[1]))[:6]
        lines.append("score: " + ", ".join(f"{k} {v:+.1f}" for k, v in top))
    rem = d.get("removals", [])
    red = [f"{r['piece'] if r['color'] == 'w' else r['piece'].lower()}{r['square']}" for r in rem
           if r["result"] == "redundant"]
    if red:
        lines.append(f"note: removable without changing the puzzle: {', '.join(red)}")
    return "\n".join(lines)


# ---------------------------------------------------------------- generate
def cmd_generate(a):
    cfg = load_config(a.config)
    gcfg, acfg = cfg.get("generate", {}), cfg.get("archive", {})
    weights = {**DEFAULT_WEIGHTS, **cfg.get("weights", {})}
    min_n = a.min_moves
    max_n = a.max_moves or max(gcfg.get("max_moves", 6), min_n)
    if max_n < min_n:
        max_n = min_n
    if max_n > 10:
        err("warning: lengths above ~8 get expensive quickly")
    pieces = parse_pieces(a.pieces)
    material = a.material.split(",") if a.material else gcfg.get("material", DEFAULT_MATERIAL)
    workers = a.workers or gcfg.get("workers", 0) or os.cpu_count() or 1
    sf_path = None if a.no_stockfish else find_stockfish(a.stockfish)
    if not a.no_stockfish and not sf_path:
        err("note: Stockfish not found; running without it (slower). Use --stockfish PATH.")

    ensure_binary()
    gen_args = ["--min", str(min_n), "--max", str(max_n), "--seconds", str(a.minutes * 60),
                "--specs", ",".join(material), "--stats-every", "3"]
    if pieces:
        gen_args += ["--strict" if a.strict else "--require", pieces]
    if sf_path:
        gen_args += ["--stockfish", sf_path]
    seed = a.seed if a.seed is not None else int(time.time()) % 100000

    seen = set() if a.allow_known else (Queue(a.queue).keys() | Database(a.db).keys())
    archive = Archive(per_cell=a.per_cell or acfg.get("per_cell", 2),
                      dup_threshold=acfg.get("dup_threshold", 0.6))
    annot = None
    if sf_path:
        from .sftools import StockfishAnnotator
        annot = StockfishAnnotator(sf_path)

    err(f"searching {a.minutes:g} min · {workers} workers · moves {min_n}-{max_n}"
        + (f" · pieces {pieces}{' (every solution)' if a.strict else ''}" if pieces else "")
        + (" · stockfish on" if sf_path else "")
        + (f" · {len(table_files())} mate tables" if table_files() else ""))
    if not table_files():
        err("tip: `ppz tables build` (one-time, a few minutes) makes generation several times faster")
    pool = GeneratorPool(workers, gen_args, seed)
    t0, last = time.time(), 0.0
    received = known = 0
    finished = 0
    try:
        while finished < workers:
            try:
                d = pool.get(timeout=0.5)
            except queue_mod.Empty:
                d = False
            if d is None:
                finished += 1
            elif d:
                received += 1
                key = canonical_key(d["fen"])
                if key in seen:
                    known += 1
                else:
                    seen.add(key)
                    d["canonical"] = key
                    sc = score(d, weights)
                    if archive.would_admit(sc):
                        if annot:
                            d.update(annot.annotate(d))
                            sc = score(d, weights)
                        archive.add(sc)
            if time.time() - last > 2 and sys.stderr.isatty():
                last = time.time()
                st = pool.totals()
                sys.stderr.write(f"\r  {time.time() - t0:5.0f}s  positions {int(st.get('sampled', 0)):>7}  "
                                 f"candidates {received:>5}  kept {len(archive):>4} in {len(archive.cells):>3} kinds  "
                                 f"near-dupes {archive.rejected_dupes:>4}  ")
                sys.stderr.flush()
    except KeyboardInterrupt:
        err("\nstopping early...")
    finally:
        pool.stop()
        if annot:
            annot.close()
    if sys.stderr.isatty():
        err("")
    st = pool.totals()
    err(f"positions examined {int(st.get('sampled', 0))}, candidates {received}, "
        f"kept {len(archive)} across {len(archive.cells)} kinds, near-duplicates merged {archive.rejected_dupes}"
        + (f", already known {known}" if known else ""))

    picked = []
    for sc in archive.select(a.count + 20):
        if len(picked) == a.count:
            break
        ok, why = verify_plan(sc.fen, sc.data["plan_uci"])
        if not ok:  # should never happen; independent check of the engine
            err(f"verification failed, dropping {sc.fen}: {why}")
            continue
        picked.append(sc)
    out, entries = [], []
    for sc in picked:
        entries.append({"status": "pending", "score": sc.score, "breakdown": sc.breakdown,
                        "canonical": sc.data.get("canonical"), "created": time.strftime("%Y-%m-%d %H:%M"),
                        **review_block(sc.data), "analysis": sc.data})
        out.append(review_block(sc.data))
    if not a.dry_run:
        Queue(a.queue).append(entries)
    if a.details:
        for e, sc in zip(entries, picked):
            print(pretty(review_block(sc.data)))
            print(describe(sc.data, sc, solution_line=False))
            print()
    else:
        print(pretty(out))
    if not out:
        err("no puzzles found; try more --minutes, a lower --min-moves, or other --material")
    elif not a.dry_run:
        err(f"{len(out)} added to {a.queue} — run `ppz review` to accept them into {a.db}")


# ---------------------------------------------------------------- solve
def cmd_solve(a):
    with Solver() as s:
        d = s.analyze(a.fen, a.max_moves, require=parse_pieces(a.pieces), deep=True)
    if a.json:
        print(json.dumps(d, indent=2))
        return
    if not d.get("ok"):
        if d.get("error"):
            sys.exit(f"invalid position: {d['error']}")
        if d.get("aborted"):
            sys.exit("search budget exhausted; try a smaller --max-moves")
        print(f"no premove mate within {a.max_moves} moves"
              + (f" (ordinary mate in {d['closed']})" if d.get("closed") else ""))
        sys.exit(1)
    print(pretty(review_block(d)))
    print(describe(d, score(d), solution_line=False))
    ok, why = verify_plan(d["fen"], d["plan_uci"])
    print(f"independent verification: {'OK' if ok else 'FAILED'} ({why})")


# ---------------------------------------------------------------- review
def cmd_review(a):
    q, db = Queue(a.queue), Database(a.db)
    items = q.load()
    pending = sorted([x for x in items if x.get("status") == "pending"], key=lambda x: -x.get("score", 0))
    if not pending:
        print("review queue is empty — run `ppz generate` first")
        return
    print(f"{len(pending)} puzzles to review. Solutions are hidden so you can try them first.\n")
    for i, it in enumerate(pending):
        d = it["analysis"]
        sc = Scored(d, it.get("score", 0), it.get("breakdown", {}))
        reveal = a.show_solutions
        while True:
            print(f"── [{i + 1}/{len(pending)}] " + "─" * 50)
            print(pretty(review_block(d, with_solution=reveal)))
            print(describe(d, sc, reveal=reveal, solution_line=False))
            try:
                c = input("[a]ccept [r]eject [s]olution [o]pen [v]erify [n]ext [q]uit > ").strip().lower()
            except EOFError:
                c = "q"
            if c == "s":
                reveal = True
            elif c == "o":
                webbrowser.open(chesscom_url(d["fen"]))
            elif c == "v":
                ok, why = verify_plan(d["fen"], d["plan_uci"])
                print(f"independent verification: {'OK' if ok else 'FAILED'} ({why})\n")
            elif c == "a":
                ok, why = verify_plan(d["fen"], d["plan_uci"])
                if not ok:
                    print(f"refusing: verification failed ({why})")
                    continue
                added, msg = db.add(d, {"score": it.get("score")})
                print(("✓ " if added else "• ") + msg + "\n")
                it["status"] = "accepted"
                break
            elif c == "r":
                it["status"] = "rejected"
                print()
                break
            elif c in ("n", ""):
                print()
                break
            elif c == "q":
                q.save(items)
                return
        q.save(items)
    print("review done.")


# ---------------------------------------------------------------- add
def cmd_add(a):
    fens = list(a.fen)
    if a.file:
        fens += [l.strip() for l in Path(a.file).read_text().splitlines() if l.strip() and not l.startswith("#")]
    if not fens:
        sys.exit("give FENs or --file")
    db = Database(a.db)
    bad = 0
    with Solver() as s:
        for fen in fens:
            d = s.analyze(fen, a.max_moves, deep=False)
            if not d.get("ok"):
                bad += 1
                why = d.get("error") or ("budget exhausted" if d.get("aborted") else f"no premove mate within {a.max_moves}")
                print(f"✗ {fen}: {why}")
                continue
            ok, why = verify_plan(fen, d["plan_uci"])
            if not ok:
                bad += 1
                print(f"✗ {fen}: verification failed ({why})")
                continue
            added, msg = db.add(d)
            print(f"{'✓' if added else '•'} {fen}  [{d['n']} moves: {' '.join(d['plan_san'])}]  {msg}")
    sys.exit(1 if bad else 0)


# ---------------------------------------------------------------- db / queue
def cmd_db(a):
    db = Database(a.db)
    items = db.load()
    if a.action == "list":
        for i, x in enumerate(items, 1):
            print(f"{i:>3}.  {x['number_of_moves']}  {x['fen']:<45}  {' '.join(x.get('solution', []))}")
        err(f"{len(items)} puzzles in {db.path}")
    elif a.action == "stats":
        print(f"{len(items)} puzzles in {db.path}")
        for title, key in (("by length", "number_of_moves"), ("by material", "material")):
            c = collections.Counter(x.get(key) for x in items)
            print(f"{title}: " + ", ".join(f"{k}: {v}" for k, v in sorted(c.items(), key=lambda kv: str(kv[0]))))
    elif a.action == "export":
        text = db.export(a.format, a.fields.split(","), a.table)
        if a.out:
            Path(a.out).write_text(text)
            err(f"wrote {len(items)} puzzles to {a.out}")
        else:
            sys.stdout.write(text if text.endswith("\n") else text + "\n")
    elif a.action == "remove":
        if not a.fen:
            sys.exit("give the FEN to remove")
        print("removed" if db.remove(a.fen) else "not found")


def cmd_queue(a):
    q = Queue(a.queue)
    items = q.load()
    if a.action == "list":
        for x in items:
            print(f"{x.get('status', '?'):<9} {x.get('score', 0):>5.1f}  {x['number_of_moves']}  {x['fen']}")
        c = collections.Counter(x.get("status") for x in items)
        err(", ".join(f"{k}: {v}" for k, v in c.items()) or "queue is empty")
    elif a.action == "clear":
        keep = [] if a.all else [x for x in items if x.get("status") == "pending"]
        q.save(keep)
        print(f"removed {len(items) - len(keep)} entries")


# ---------------------------------------------------------------- tables / info
def table_materials(cfg: dict, five: bool) -> list[str]:
    """Lone-king, pawnless materials the generator uses, plus 4-piece basics."""
    base = {"KQ-K", "KR-K", "KQR-K", "KRR-K", "KRB-K", "KRN-K", "KQB-K", "KQN-K", "KQQ-K", "KBN-K", "KBB-K"}
    for spec in cfg.get("generate", {}).get("material", DEFAULT_MATERIAL):
        spec = spec.split(":")[0].upper().replace("V", "-")
        if "-" not in spec:
            continue
        w, b = spec.split("-", 1)
        if b != "K" or "P" in w or not 2 <= len(w) <= 4:
            continue
        if len(w) == 4 and not five:
            continue
        base.add(w + "-K")
    return sorted(base, key=lambda m: (len(m), m))


def cmd_tables(a):
    cfg = load_config(a.config)
    if a.action == "status":
        files = table_files()
        print(f"tables in {TABLES_DIR}: {len(files)}")
        for f in files:
            print(f"  {f.stem:<8} {f.stat().st_size / 1e6:>8.1f} MB")
        wanted = table_materials(cfg, five=True)
        have = {f.stem for f in files}
        missing = [m for m in wanted if m not in have]
        if missing:
            print("not built yet: " + ", ".join(missing)
                  + "\n(5-piece tables are ~1 GB each; build them with `ppz tables build --five`)")
        return
    try:
        device = pick_device(a.device)
    except RuntimeError as e:
        sys.exit(str(e))
    if a.action == "selftest":
        return tables_selftest(device)
    five = a.five or (device.startswith("cuda") and not a.no_five)
    mats = a.material.split(",") if a.material else table_materials(cfg, five)
    big = [m for m in mats if len(m.split("-")[0]) == 4]
    label = device if device != "cuda" else f"cuda ({(cuda_gpus() or ['GPU'])[0]})"
    err(f"building {len(mats)} tables on {label} into {TABLES_DIR} (cap {a.cap})")
    if big:
        err(f"  5-piece: {', '.join(big)} — ~1 GB on disk and ~2 GB memory each"
            + ("" if device.startswith("cuda") else "; on CPU expect several minutes each"))
    t0 = time.time()
    try:
        for r in build_tables(mats, device, cap=a.cap, force=a.force, threads=a.threads):
            extra = f"{r['seconds']:6.1f}s" if r["status"] == "built" else "cached"
            print(f"  {r['material']:<8} {extra:>8}   longest mate {r['max_dtm']:>2}"
                  f"   {r['bytes'] / 1e6:>8.1f} MB   [{r['backend']}]", flush=True)
    except RuntimeError as e:
        sys.exit(str(e))
    err(f"done in {time.time() - t0:.0f}s. `ppz generate` and `ppz solve` use them automatically.")


def tables_selftest(device: str):
    """Build the same tables on the chosen device and on the CPU; they must match byte for byte."""
    import filecmp
    import tempfile
    if not device.startswith("cuda"):
        sys.exit("selftest compares the GPU build against the CPU build; no GPU selected/detected")
    mats = ["KQR-K", "KRB-K"]
    with tempfile.TemporaryDirectory() as tmp:
        gdir, cdir = Path(tmp) / "gpu", Path(tmp) / "cpu"
        times = {}
        for label, dev, d in (("gpu", device, gdir), ("cpu", "cpu", cdir)):
            t0 = time.time()
            for _ in build_tables(mats, dev, tables_dir=d):
                pass
            times[label] = time.time() - t0
        names = sorted(f.name for f in gdir.glob("*.tb"))
        bad = [n for n in names if not filecmp.cmp(gdir / n, cdir / n, shallow=False)]
        print(f"compared {len(names)} tables ({', '.join(n[:-3] for n in names)}): "
              f"{'all identical' if not bad else 'MISMATCH in ' + ', '.join(bad)}")
        print(f"gpu {times['gpu']:.1f}s vs cpu {times['cpu']:.1f}s")
        sys.exit(1 if bad or not names else 0)


def cmd_info(a):
    import platform
    print(f"platform     {platform.system()} {platform.machine()}, {os.cpu_count()} CPU threads")
    gpus = cuda_gpus()
    print(f"nvidia gpu   {', '.join(gpus) if gpus else 'none detected'}")
    print(f"cuda build   {'available' if cuda_buildable() else 'nvcc not found'}")
    print(f"table device {pick_device('auto')}  (override with `ppz tables build --device cpu|cuda[:N]`)")
    sf = find_stockfish(None)
    print(f"stockfish    {sf or 'not found (optional; brew/apt install stockfish)'}")
    files = table_files()
    print(f"mate tables  {len(files)} in {TABLES_DIR}" + ("" if files else "  — run `ppz tables build`"))
    print("search       CPU, one worker per thread (the tree search does not benefit from a GPU)")


# ---------------------------------------------------------------- app (the game's puzzle list)
def _confirm(question: str, assume_yes: bool) -> bool:
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        sys.exit(f"{question} — rerun with --yes to confirm non-interactively")
    return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")


def _show_app_puzzle(p: dict) -> str:
    return f"{p['id']:>3}. {p['number_of_moves']} moves  {p['title']:<36}  {p['fen']}"


def cmd_app(a):
    app = AppPuzzles(a.app_puzzles)
    try:
        puzzles = app.load()
    except (FileNotFoundError, ValueError) as e:
        sys.exit(str(e))

    if a.action == "list":
        for p in puzzles:
            print(_show_app_puzzle(p) + (f"\n       {' '.join(p.get('solution', []))}" if a.solutions else ""))
        err(f"{len(puzzles)} puzzles in {app.path}")
        return

    if a.action == "remove":
        if a.number is None or not 1 <= a.number <= len(puzzles):
            sys.exit(f"give a puzzle number between 1 and {len(puzzles)} with --number")
        old = puzzles[a.number - 1]
        print(_show_app_puzzle(old))
        if not _confirm(f"Remove puzzle {a.number} and renumber the {len(puzzles) - a.number} after it?", a.yes):
            sys.exit("cancelled")
        del puzzles[a.number - 1]
        app.save(puzzles)
        print(f"removed; the app now has {len(puzzles)} puzzles")
        return

    # add
    fen = a.fen
    if a.from_db is not None:
        items = Database(a.db).load()
        if not 1 <= a.from_db <= len(items):
            sys.exit(f"--from-db must be between 1 and {len(items)} (see `ppz db list`)")
        fen = items[a.from_db - 1]["fen"]
    if not fen:
        sys.exit("give a FEN, or --from-db K to take puzzle K from `ppz db list`")
    number = a.number if a.number is not None else len(puzzles) + 1
    if not 1 <= number <= len(puzzles) + 1:
        sys.exit(f"puzzles are numbered 1..{len(puzzles)} and unlock in order; "
                 f"use a number up to {len(puzzles) + 1} (the next free one)")
    replacing = number <= len(puzzles) and not a.insert

    with Solver() as s:
        d = s.analyze(fen, a.max_moves, deep=False)
    if not d.get("ok"):
        why = d.get("error") or ("search budget exhausted" if d.get("aborted") else f"no premove mate within {a.max_moves}")
        sys.exit(f"not a valid puzzle: {why}")
    if fen.split()[1] != "w":
        sys.exit("the game expects White to move")
    ok, why = verify_plan(fen, d["plan_uci"])
    if not ok:
        sys.exit(f"independent verification failed: {why}")
    dup = app.duplicate_of(puzzles, fen, ignore_index=number - 1 if replacing else None)
    if dup and not a.allow_duplicate:
        sys.exit(f"this position (or a mirror image) is already puzzle {dup}; use --allow-duplicate to add it anyway")

    entry = app.entry(d, a.title, a.description)
    print(f"{'replace' if replacing else 'insert' if number <= len(puzzles) else 'add'} puzzle {number}: "
          f"{entry['title']} — {d['n']} moves: {' '.join(d['plan_san'])}")
    if replacing:
        print(f"  currently: {_show_app_puzzle(puzzles[number - 1])}")
        if not _confirm(f"Replace puzzle {number}?", a.yes):
            sys.exit("cancelled")
        puzzles[number - 1] = entry
    elif number <= len(puzzles):
        if not _confirm(f"Insert as puzzle {number} and shift {len(puzzles) - number + 1} puzzles up by one?", a.yes):
            sys.exit("cancelled")
        puzzles.insert(number - 1, entry)
    else:
        puzzles.append(entry)
    app.save(puzzles)
    print(f"saved {app.path} ({len(puzzles)} puzzles). Run `npm test` in the app to check every puzzle "
          f"plays correctly in the game.")


# ---------------------------------------------------------------- main
def main(argv=None):
    p = argparse.ArgumentParser(prog="ppz", description="Premove chess puzzle tooling")
    p.add_argument("--queue", default=str(DEFAULT_QUEUE), help="review queue file (default %(default)s)")
    p.add_argument("--db", default=str(DEFAULT_DB), help="puzzle database file (default %(default)s)")
    p.add_argument("--config", help="config.toml with weights and defaults")
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", aliases=["gen"], help="find candidate puzzles")
    g.add_argument("--min-moves", type=int, default=3, help="minimum premoves needed (default 3)")
    g.add_argument("--max-moves", type=int, help="maximum premoves (default from config, 6)")
    g.add_argument("--pieces", help="piece types that must move in a shortest solution, e.g. 'N,B' or 'knight'")
    g.add_argument("--strict", action="store_true", help="--pieces must move in EVERY shortest solution")
    g.add_argument("--material", help="comma list like KQR-K,KRB-KP (white-black, optional :weight)")
    g.add_argument("--count", type=int, default=10, help="puzzles to output (default 10)")
    g.add_argument("--minutes", type=float, default=2, help="search time (default 2)")
    g.add_argument("--workers", type=int, help="parallel workers (default: CPU count)")
    g.add_argument("--per-cell", type=int, help="max puzzles of the same kind (default 2)")
    g.add_argument("--stockfish", help="path to Stockfish (auto-detected)")
    g.add_argument("--no-stockfish", action="store_true")
    g.add_argument("--seed", type=int)
    g.add_argument("--details", action="store_true", help="also print solutions and scores")
    g.add_argument("--dry-run", action="store_true", help="don't write to the review queue")
    g.add_argument("--allow-known", action="store_true", help="don't skip puzzles already queued or in the db")
    g.set_defaults(func=cmd_generate)

    s = sub.add_parser("solve", help="analyse a FEN")
    s.add_argument("fen")
    s.add_argument("--max-moves", type=int, default=8)
    s.add_argument("--pieces", help="require these piece types to move")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_solve)

    r = sub.add_parser("review", help="accept/reject queued candidates")
    r.add_argument("--show-solutions", action="store_true")
    r.set_defaults(func=cmd_review)

    ad = sub.add_parser("add", help="verify FENs and add them to the database")
    ad.add_argument("fen", nargs="*")
    ad.add_argument("--file", help="text file with one FEN per line")
    ad.add_argument("--max-moves", type=int, default=10)
    ad.set_defaults(func=cmd_add)

    d = sub.add_parser("db", help="list / stats / export / remove")
    d.add_argument("action", choices=["list", "stats", "export", "remove"])
    d.add_argument("fen", nargs="?")
    d.add_argument("--format", default="json", choices=["json", "jsonl", "csv", "sql"])
    d.add_argument("--fields", default="fen,url,number_of_moves")
    d.add_argument("--table", default="puzzles", help="table name for --format sql")
    d.add_argument("--out")
    d.set_defaults(func=cmd_db)

    qq = sub.add_parser("queue", help="list / clear the review queue")
    qq.add_argument("action", choices=["list", "clear"])
    qq.add_argument("--all", action="store_true", help="with clear: also drop pending entries")
    qq.set_defaults(func=cmd_queue)

    t = sub.add_parser("tables", help="build / inspect distance-to-mate tables (CPU or NVIDIA GPU)")
    t.add_argument("action", choices=["build", "status", "selftest"])
    t.add_argument("--device", default="auto", help="auto (default), cpu, cuda or cuda:N")
    t.add_argument("--five", action="store_true", help="include 5-piece tables (default on GPU)")
    t.add_argument("--no-five", action="store_true", help="skip 5-piece tables even on GPU")
    t.add_argument("--material", help="explicit list, e.g. KQR-K,KRBN-K")
    t.add_argument("--cap", type=int, default=15, help="longest mate stored (default 15; >= --max-moves)")
    t.add_argument("--threads", type=int, help="CPU threads (default: all)")
    t.add_argument("--force", action="store_true", help="rebuild even if present")
    t.set_defaults(func=cmd_tables)

    i = sub.add_parser("info", help="show detected hardware, Stockfish and tables")
    i.set_defaults(func=cmd_info)

    ap = sub.add_parser("app", help="manage the game's puzzle list (src/game/puzzles.json)")
    ap.add_argument("action", choices=["list", "add", "remove"])
    ap.add_argument("fen", nargs="?", help="with add: the position (or use --db)")
    ap.add_argument("--number", "-n", type=int,
                    help="puzzle number: replaces it if it exists, appends if it is the next one (default: append)")
    ap.add_argument("--insert", action="store_true", help="with add: insert at --number and shift later puzzles")
    ap.add_argument("--from-db", type=int, metavar="K", help="with add: take puzzle K from `ppz db list`")
    ap.add_argument("--title", help="default: generated from the material, e.g. 'Rook and bishop vs king'")
    ap.add_argument("--description", help="default: 'Plan the forced premove mate in N, ...'")
    ap.add_argument("--solutions", action="store_true", help="with list: show solutions")
    ap.add_argument("--allow-duplicate", action="store_true")
    ap.add_argument("--max-moves", type=int, default=10)
    ap.add_argument("--yes", "-y", action="store_true", help="don't ask before replacing/inserting/removing")
    ap.add_argument("--app-puzzles", default=str(DEFAULT_APP_PUZZLES), help="path to the app's puzzles.json")
    ap.set_defaults(func=cmd_app)

    a = p.parse_args(argv)
    a.func(a)


if __name__ == "__main__":
    main()
