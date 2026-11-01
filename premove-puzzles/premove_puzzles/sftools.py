"""Stockfish-based annotations.

The exact solver decides correctness. Stockfish is used for things it is good at:
  * engine_trap: play Stockfish's own mating line as premoves. If that fails, the puzzle
    punishes "just find the mate" thinking and rewards genuinely premove-aware play.
"""
from __future__ import annotations

import chess
import chess.engine

from .verify import verify_plan


class StockfishAnnotator:
    def __init__(self, path: str, nodes: int = 150_000):
        self.engine = chess.engine.SimpleEngine.popen_uci(path)
        self.engine.configure({"Threads": 1, "Hash": 32})
        self.nodes = nodes

    def annotate(self, d: dict) -> dict:
        board = chess.Board(d["fen"])
        info = self.engine.analyse(board, chess.engine.Limit(nodes=self.nodes), game=object())
        mate = info["score"].white().mate()
        pv = info.get("pv", [])
        out = {"sf_mate": mate}
        if mate is None or mate <= 0 or not pv:
            return out  # Stockfish did not see the mate; no meaningful trap test
        line = [m.uci() for m in pv[0::2]]
        ok, _ = verify_plan(d["fen"], line)
        out["sf_line"] = line
        out["engine_trap"] = not ok
        return out

    def close(self):
        try:
            self.engine.quit()
        except Exception:
            pass
