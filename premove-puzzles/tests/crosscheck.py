"""Cross-check the C++ engine against the independent python-chess brute force.

usage: python3 tests/crosscheck.py [count] [max_n]
"""
import json
import multiprocessing as mp
import random
import subprocess
import sys
import time
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from premove_puzzles.verify import brute_force_min, verify_plan  # noqa: E402

MATERIAL = ["QR", "RR", "Q", "QB", "RB", "RN", "QN", "QQ", "RRB", "QR"]
BLACK = ["", "", "", "P", "PP", "N", "B"]


def random_position(rng: random.Random) -> str:
    while True:
        b = chess.Board(None)
        edge = [s for s in chess.SQUARES if chess.square_file(s) in (0, 7) or chess.square_rank(s) in (0, 7)]
        bk = rng.choice(edge if rng.random() < 0.7 else list(chess.SQUARES))
        b.set_piece_at(bk, chess.Piece(chess.KING, chess.BLACK))
        free = [s for s in chess.SQUARES if s != bk]
        wk = rng.choice(free)
        b.set_piece_at(wk, chess.Piece(chess.KING, chess.WHITE))
        for p in rng.choice(MATERIAL):
            s = rng.choice([x for x in chess.SQUARES if b.piece_at(x) is None])
            b.set_piece_at(s, chess.Piece(chess.Piece.from_symbol(p).piece_type, chess.WHITE))
        for p in rng.choice(BLACK):
            sq = [x for x in chess.SQUARES if b.piece_at(x) is None and 1 <= chess.square_rank(x) <= 6]
            b.set_piece_at(rng.choice(sq), chess.Piece(chess.Piece.from_symbol(p).piece_type, chess.BLACK))
        b.turn = chess.WHITE
        if b.is_valid() and not b.is_check():
            return b.fen()


def brute(args):
    fen, max_n = args
    return fen, brute_force_min(fen, max_n)


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    max_n = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    rng = random.Random(12345)
    fens = [random_position(rng) for _ in range(count)]
    eng = subprocess.Popen([str(ROOT / "engine" / "pmcore"), "serve"], stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, text=True)
    t = time.time()
    cpp = {}
    for f in fens:
        eng.stdin.write(f"{f}\t{max_n}\t\t\t0\t\n")
        eng.stdin.flush()
        cpp[f] = json.loads(eng.stdout.readline())
    t_cpp = time.time() - t
    t = time.time()
    with mp.Pool(2) as pool:
        py = dict(pool.map(brute, [(f, max_n) for f in fens]))
    t_py = time.time() - t
    mism = 0
    plans_bad = 0
    dist = {}
    for f in fens:
        r = cpp[f]
        n_cpp = r.get("n") if r.get("ok") else None
        dist[n_cpp] = dist.get(n_cpp, 0) + 1
        if n_cpp != py[f]:
            mism += 1
            print("MISMATCH", f, "cpp", n_cpp, "py", py[f])
        if r.get("ok"):
            ok, why = verify_plan(f, r["plan_uci"])
            if not ok:
                plans_bad += 1
                print("BAD PLAN", f, r["plan_uci"], why)
    print(f"positions={count} max_n={max_n} distribution={dist}")
    print(f"mismatches={mism} invalid_plans={plans_bad}  cpp={t_cpp:.2f}s  python={t_py:.1f}s")
    sys.exit(1 if mism or plans_bad else 0)


if __name__ == "__main__":
    main()
