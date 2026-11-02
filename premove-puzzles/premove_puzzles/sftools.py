"""Stockfish-based annotations.

The exact solver decides correctness. Stockfish is used for things it is good at:
  * engine_trap: play Stockfish's own mating line as premoves. If that fails, the puzzle
    punishes "just find the mate" thinking and rewards genuinely premove-aware play.
"""
from __future__ import annotations

import logging
import subprocess
import time
from pathlib import Path

import chess
import chess.engine

from .verify import verify_plan


ERROR_LOG = Path("stockfish-errors.log")
# python-chess logs a line for every unexpected engine output; failures are recorded in
# ERROR_LOG instead, so keep the terminal quiet.
logging.getLogger("chess.engine").setLevel(logging.CRITICAL)


class StockfishAnnotator:
    """Adds Stockfish-based features to a candidate. Never fatal: if Stockfish fails on a
    position it is logged to stockfish-errors.log, Stockfish is restarted and the candidate
    simply goes without the annotation. After several failures in a row it gives up for the
    rest of the run."""

    MAX_CONSECUTIVE_FAILURES = 3

    def __init__(self, path: str, nodes: int = 150_000, seconds: float = 3.0):
        self.path = path
        self.nodes = nodes
        self.seconds = seconds
        self.failures = 0
        self.total_failures = 0
        self.disabled = False
        self.engine = None
        self._start()

    def _start(self):
        self.engine = chess.engine.SimpleEngine.popen_uci(self.path, stderr=subprocess.DEVNULL)
        self.engine.configure({"Threads": 1, "Hash": 32})

    def _record_failure(self, fen: str, error: Exception):
        self.failures += 1
        self.total_failures += 1
        with ERROR_LOG.open("a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\tannotate\t{fen}\t{type(error).__name__}: {error}\n")
        self.close()
        if self.failures >= self.MAX_CONSECUTIVE_FAILURES:
            self.disabled = True
            return
        try:
            self._start()
        except Exception as e:  # cannot even restart: stop trying
            self.disabled = True
            with ERROR_LOG.open("a") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\trestart\t-\t{type(e).__name__}: {e}\n")

    def annotate(self, d: dict) -> dict:
        if self.disabled:
            return {}
        board = chess.Board(d["fen"])
        try:
            info = self.engine.analyse(board, chess.engine.Limit(nodes=self.nodes, time=self.seconds),
                                       game=object())
        except (chess.engine.EngineError, chess.engine.EngineTerminatedError, TimeoutError, OSError) as e:
            self._record_failure(d["fen"], e)
            return {}
        self.failures = 0
        mate = info["score"].white().mate() if "score" in info else None
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
        # close() terminates the process right away; quit() would wait up to 10 s for an
        # engine that may be hung or already dead.
        try:
            if self.engine:
                self.engine.close()
        except Exception:
            pass
        self.engine = None
