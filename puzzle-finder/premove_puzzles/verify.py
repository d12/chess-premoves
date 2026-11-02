"""Independent premove-plan verification using python-chess only.

This module deliberately shares no logic with the C++ engine, so it can be used to
double-check anything the engine claims before a puzzle goes into the database.

Premove semantics (matching chess.com / lichess premoves):
  * a premove is identified by (from square, to square, promotion piece);
  * it is executed if it is legal in the position at that moment, otherwise the
    plan fails (in the UI the premove queue would be cancelled);
  * black may reply with any legal move; the plan must checkmate black in every line;
  * a stalemate in any line is a failure.
"""
from __future__ import annotations

import chess


def _key(move: chess.Move) -> tuple[int, int, int | None]:
    return (move.from_square, move.to_square, move.promotion)


def _find(board: chess.Board, key) -> chess.Move | None:
    for m in board.legal_moves:
        if _key(m) == key:
            return m
    return None


def parse_plan(fen: str, plan: list[str]) -> list[tuple]:
    """Accepts UCI ('e1c1') or SAN ('Rc1'); SAN is resolved along a representative line."""
    keys = []
    board: chess.Board | None = chess.Board(fen)
    for tok in plan:
        try:
            mv = chess.Move.from_uci(tok)
        except ValueError:
            if board is None:
                raise ValueError(f"cannot resolve SAN '{tok}' after the line ended; use UCI")
            mv = board.parse_san(tok)
        keys.append(_key(mv))
        # advance a representative line so later SAN tokens can be parsed
        if board is not None:
            real = _find(board, keys[-1])
            board.push(real) if real else None
            replies = list(board.legal_moves) if real else []
            if replies:
                board.push(replies[-1])
            else:
                board = None
    return keys


def verify_plan(fen: str, plan: list[str]) -> tuple[bool, str]:
    """Return (ok, explanation). Exhaustively checks every black defence."""
    keys = parse_plan(fen, plan)
    belief = {chess.Board(fen).fen(): chess.Board(fen)}
    for i, key in enumerate(keys):
        nxt: dict[str, chess.Board] = {}
        for b in belief.values():
            mv = _find(b, key)
            if mv is None:
                return False, f"move {i + 1} ({plan[i]}) is illegal after {' '.join(_line(b))}"
            c = b.copy(stack=False)
            c.push(mv)
            if c.is_checkmate():
                continue
            if c.is_stalemate():
                return False, f"move {i + 1} ({plan[i]}) stalemates after {' '.join(_line(b))}"
            if i == len(keys) - 1:
                return False, f"black survives the last premove after {' '.join(_line(c))}"
            for r in c.legal_moves:
                d = c.copy(stack=False)
                d.push(r)
                nxt[d.fen()] = d
        belief = nxt
        if not belief:
            return True, f"mate guaranteed by move {i + 1}"
    if belief:
        return False, "plan ends without mate in some line"
    return True, "ok"


def _line(b: chess.Board) -> list[str]:
    return [m.uci() for m in b.move_stack] or ["start"]


def brute_force_min(fen: str, max_n: int) -> int | None:
    """Exhaustive open-loop search, no pruning heuristics. Slow; for testing only."""
    root = chess.Board(fen)

    def solvable(belief: list[chess.Board], r: int) -> bool:
        common = None
        for b in belief:
            ks = {_key(m) for m in b.legal_moves}
            common = ks if common is None else common & ks
            if not common:
                return False
        for key in common:
            nxt = {}
            ok = True
            for b in belief:
                c = b.copy(stack=False)
                c.push(_find(b, key))
                if c.is_checkmate():
                    continue
                if c.is_stalemate() or r == 1:
                    ok = False
                    break
                for rep in c.legal_moves:
                    d = c.copy(stack=False)
                    d.push(rep)
                    nxt[d.fen()] = d
            if not ok:
                continue
            if not nxt or solvable(list(nxt.values()), r - 1):
                return True
        return False

    for n in range(1, max_n + 1):
        if solvable([root], n):
            return n
    return None
