"""Validate the WebAssembly opponent against the native engine and the Python verifier.

Generates fresh puzzles, derives plan variants (the solution, truncated, one move swapped
for another legal premove, two moves exchanged), then checks for every case that:
  1. the WebAssembly build returns byte-identical JSON to the native build
     (both `analyze` and every `reply` along the principal line);
  2. the verdict (sound / refuted) agrees with premove_puzzles/verify.py, an independent
     python-chess implementation;
  3. a "refuted" principal line really defeats the plan, and a "sound" one ends in mate.

usage (from premove-puzzles/):  python3 tests/wasm_check.py [--seconds 20] [--module PATH]
needs: make (native pmcore), node, and the built module (npm run build:wasm at repo root).
"""
from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from premove_puzzles.engine import ensure_binary  # noqa: E402
from premove_puzzles.verify import verify_plan  # noqa: E402

DEFAULT_MODULE = ROOT.parent / "src" / "engine" / "generated" / "premove-engine.js"
MATERIAL = "KQR-K,KRR-K,KRB-K,KRN-K,KQB-K,KQN-K,KQ-KP,KQ-KPP,KR-KP,KRB-KP,KQN-KP,KRP-K,KQP-K"


class LineProc:
    def __init__(self, cmd: list[str]):
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def ask(self, line: str) -> str:
        self.p.stdin.write(line + "\n")
        self.p.stdin.flush()
        return self.p.stdout.readline().rstrip("\n")

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def generate_puzzles(seconds: float, seed: int) -> list[dict]:
    out = subprocess.run([str(ensure_binary()), "gen", "--min", "3", "--max", "6", "--seconds", str(seconds),
                          "--seed", str(seed), "--specs", MATERIAL, "--stats-every", "1000"],
                         capture_output=True, text=True, check=True).stdout
    return [json.loads(l)["data"] for l in out.splitlines() if '"puzzle"' in l]


def variants(fen: str, plan: list[str], rnd: random.Random) -> list[list[str]]:
    out = [plan, plan[:-1]]
    for _ in range(3):  # replace one premove with another legal move (on a representative line)
        k = rnd.randrange(len(plan))
        b = chess.Board(fen)
        ok = True
        for u in plan[:k]:
            mv = chess.Move.from_uci(u)
            if mv not in b.legal_moves:
                ok = False
                break
            b.push(mv)
            replies = list(b.legal_moves)
            if not replies:
                ok = False
                break
            b.push(rnd.choice(replies))
        if ok and not b.is_game_over():
            alt = rnd.choice(list(b.legal_moves)).uci()
            out.append(plan[:k] + [alt] + plan[k + 1:])
    if len(plan) > 2:
        out.append([plan[1], plan[0], *plan[2:]])
    return [v for v in out if v]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=20, help="time spent generating fresh puzzles")
    ap.add_argument("--module", default=str(DEFAULT_MODULE))
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    if not Path(a.module).exists():
        sys.exit(f"{a.module} not found; run `npm run build:wasm` at the repo root first")

    puzzles = generate_puzzles(a.seconds, a.seed)
    native = LineProc([str(ensure_binary()), "refute"])
    wasm = LineProc(["node", str(Path(__file__).with_name("wasm_runner.mjs")), a.module])
    rnd = random.Random(a.seed)
    stats = {"cases": 0, "refuted": 0, "replies": 0, "json_mismatch": 0, "verdict_mismatch": 0, "line_bad": 0}

    for pz in puzzles:
        for plan in variants(pz["fen"], pz["plan_uci"], rnd):
            req = f"analyze\t{pz['fen']}\t{' '.join(plan)}"
            n_out, w_out = native.ask(req), wasm.ask(req)
            stats["cases"] += 1
            if n_out != w_out:
                stats["json_mismatch"] += 1
                print("JSON MISMATCH", req, "\n native:", n_out, "\n   wasm:", w_out)
                continue
            r = json.loads(n_out)
            if not r.get("ok"):
                continue  # e.g. a variant whose first move is illegal in the start position
            if r["verdict"] == "unknown":
                continue
            refuted = r["verdict"] == "refuted"
            stats["refuted"] += refuted
            ok, why = verify_plan(pz["fen"], plan)
            if ok == refuted:
                stats["verdict_mismatch"] += 1
                print("VERDICT MISMATCH", pz["fen"], plan, r["verdict"], "verify:", why)
            # replay the principal line; ask for each opponent reply on both builds
            board = chess.Board(pz["fen"])
            history: list[str] = []
            for mv in r["line"]:
                if not mv["player"]:
                    rq = f"reply\t{pz['fen']}\t{' '.join(plan)}\t{' '.join(history)}"
                    n_rep, w_rep = native.ask(rq), wasm.ask(rq)
                    stats["replies"] += 1
                    if n_rep != w_rep:
                        stats["json_mismatch"] += 1
                        print("REPLY MISMATCH", rq, n_rep, w_rep)
                    elif json.loads(n_rep).get("move") != mv["uci"]:
                        stats["line_bad"] += 1
                        print("REPLY != LINE", rq, n_rep, mv)
                board.push_uci(mv["uci"])
                history.append(mv["uci"])
            mated = board.is_checkmate() and board.turn == chess.BLACK
            if mated == refuted:
                stats["line_bad"] += 1
                print("LINE OUTCOME WRONG", pz["fen"], plan, r)
    native.close()
    wasm.close()
    print(f"puzzles {len(puzzles)}  " + "  ".join(f"{k} {v}" for k, v in stats.items()))
    bad = stats["json_mismatch"] + stats["verdict_mismatch"] + stats["line_bad"]
    print("OK: WebAssembly matches native and the independent verifier" if not bad else f"FAILED ({bad} problems)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
