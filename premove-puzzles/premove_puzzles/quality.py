"""What makes a premove puzzle interesting, and how to keep a varied set.

Interestingness is a weighted sum of features the engine reports (weights live in
config.toml so they can be tuned without touching code). Variety comes from two places:

1. Near-duplicate detection. Mutation-based search finds whole families of puzzles that
   differ by one piece placement but share the same idea. Two puzzles are "the same idea"
   when they have the same material and length and their solutions use mostly the same
   (piece, destination) pairs, compared under board symmetries.
2. A MAP-Elites style archive. Instead of one global top-N list (which would fill up with
   the single best family), puzzles are binned by descriptors (length, material, which
   piece types move, whether the key move is quiet) and each bin keeps only its best few.
   Final selection walks the bins round-robin, best first.
"""
from __future__ import annotations

import collections
import functools
import math
from dataclasses import dataclass, field

import chess

DEFAULT_WEIGHTS = {
    "length": 1.0,            # per move of solution length
    "premove_tax": 2.0,       # per move the premove plan is longer than a normal mate
    "unique_solution": 2.0,   # bonus if exactly one shortest plan exists
    "solutions_log": -0.6,    # times log2(number of shortest plans)
    "unique_key": 0.75,       # bonus if every shortest plan starts with the same move
    "quiet_fraction": 1.5,    # times fraction of non-checking premoves
    "quiet_key": 1.0,         # bonus if the first move gives no check
    "offer": 1.0,             # bonus if a premove leaves a piece en prise (works anyway)
    "width_log": 0.3,         # times log2(max number of positions tracked at once)
    "distinct_movers": 0.4,   # per distinct white piece moved beyond the first
    "mate_variety": 0.3,      # per distinct mating piece type beyond the first
    "economy": -0.3,          # per piece beyond 3 on the board
    "redundant_white": -1.5,  # per white piece whose removal keeps the puzzle intact
    "redundant_black": -0.75, # per black piece that changes nothing
    "black_obstacle": 0.5,    # per black piece whose presence makes the puzzle harder
    "engine_trap": 1.0,       # Stockfish's own mating line fails when played as premoves
}

PIECE_TYPES = "KQRBNP"


@dataclass
class Scored:
    data: dict
    score: float
    breakdown: dict = field(default_factory=dict)

    @property
    def fen(self) -> str:
        return self.data["fen"]


def score(d: dict, w: dict | None = None, min_pieces: int = 0) -> Scored:
    """With min_pieces (generate --min-pieces), a full board is what was asked for: pieces up to
    that count are not penalised for economy, and pieces that take no part cost a quarter as
    much as usual (they are scenery by request)."""
    w = {**DEFAULT_WEIGHTS, **(w or {})}
    if min_pieces:
        w["redundant_white"] *= 0.25
        w["redundant_black"] *= 0.25
    n = d["n"]
    b: dict[str, float] = {}
    b["length"] = w["length"] * n
    b["premove_tax"] = w["premove_tax"] * d.get("premove_tax", 0)
    sols = max(1, d.get("solutions", 1))
    b["unique_solution"] = w["unique_solution"] if sols == 1 else 0.0
    b["solutions_log"] = w["solutions_log"] * math.log2(sols)
    b["unique_key"] = w["unique_key"] if d.get("first_moves") == 1 else 0.0
    b["quiet_fraction"] = w["quiet_fraction"] * d.get("quiet_moves", 0) / n
    steps = d.get("steps", [])
    b["quiet_key"] = w["quiet_key"] if steps and steps[0]["checks"] == 0 else 0.0
    b["offer"] = w["offer"] if d.get("offers", 0) > 0 else 0.0
    b["width_log"] = w["width_log"] * math.log2(max(1, d.get("max_width", 1)))
    b["distinct_movers"] = w["distinct_movers"] * max(0, d.get("distinct_movers", 1) - 1)
    b["mate_variety"] = w["mate_variety"] * max(0, len(d.get("mate_pieces", "")) - 1)
    pieces = len([c for c in d["fen"].split()[0] if c.isalpha()])
    b["economy"] = w["economy"] * max(0, pieces - max(3, min_pieces))
    rem = d.get("removals", [])
    b["redundant_white"] = w["redundant_white"] * sum(r["color"] == "w" and r["result"] == "redundant" for r in rem)
    b["redundant_black"] = w["redundant_black"] * sum(r["color"] == "b" and r["result"] == "redundant" for r in rem)
    b["black_obstacle"] = w["black_obstacle"] * sum(r["color"] == "b" and r["result"] == "obstacle" for r in rem)
    if d.get("engine_trap"):
        b["engine_trap"] = w["engine_trap"]
    b = {k: round(v, 3) for k, v in b.items() if v}
    return Scored(d, round(sum(b.values()), 3), b)


# ------------------------------------------------------------------ symmetry helpers
def _sym_square(sq: int, s: int) -> int:
    f, r = chess.square_file(sq), chess.square_rank(sq)
    if s & 1:
        f = 7 - f
    if s & 2:
        r = 7 - r
    if s & 4:
        f, r = r, f
    return chess.square(f, r)


def _symmetries(fen: str) -> range:
    placement = fen.split()[0]
    return range(2) if ("p" in placement or "P" in placement) else range(8)


def canonical_key(fen: str) -> str:
    """Same key for positions that are mirror/rotation images (pawns: file mirror only)."""
    board = chess.Board(fen)
    best = None
    for s in _symmetries(fen):
        cells = ["."] * 64
        for sq, pc in board.piece_map().items():
            cells[_sym_square(sq, s)] = pc.symbol()
        key = "".join(cells)
        if best is None or key < best:
            best = key
    return best


def fingerprint(d: dict) -> set[tuple[str, int]]:
    out = set()
    for uci, st in zip(d["plan_uci"], d["steps"]):
        out.add((st["piece"], chess.parse_square(uci[2:4])))
    return out


@functools.lru_cache(maxsize=50_000)
def _placement(fen: str) -> dict[int, str]:
    return {sq: pc.symbol() for sq, pc in chess.Board(fen).piece_map().items()}


def placement_distance(a: dict, b: dict) -> int:
    """Pieces that would have to move to turn one position into the other (best symmetry)."""
    pa, pb = _placement(a["fen"]), _placement(b["fen"])
    best = len(pa)
    for s in _symmetries(a["fen"]):
        tb = {_sym_square(sq, s): p for sq, p in pb.items()}
        same = sum(1 for sq, p in pa.items() if tb.get(sq) == p)
        best = min(best, len(pa) - same)
    return best


def similarity(a: dict, b: dict) -> float:
    if a["material"] != b["material"]:
        return 0.0
    # same set-up with one piece moved is the same puzzle family, whatever the length
    if sum(c.isalpha() for c in a["material"]) >= 4 and placement_distance(a, b) <= 1:
        return 1.0
    if a["n"] != b["n"]:
        return 0.0
    fa, fb = fingerprint(a), fingerprint(b)
    best = 0.0
    for s in _symmetries(a["fen"]):
        tb = {(p, _sym_square(sq, s)) for p, sq in fb}
        j = len(fa & tb) / len(fa | tb)
        best = max(best, j)
    return best


def descriptor(d: dict) -> tuple:
    steps = d.get("steps", [])
    key_quiet = bool(steps) and steps[0]["checks"] == 0
    return (d["n"], d["material"], d.get("moved_types", ""), key_quiet)


class Archive:
    def __init__(self, per_cell: int = 2, dup_threshold: float = 0.6):
        self.per_cell = per_cell
        self.dup_threshold = dup_threshold
        self.cells: dict[tuple, list[Scored]] = {}
        self.rejected_dupes = 0

    def __len__(self) -> int:
        return sum(len(v) for v in self.cells.values())

    def all(self) -> list[Scored]:
        return [x for v in self.cells.values() for x in v]

    def near_duplicates(self, cand: Scored) -> list[Scored]:
        return [x for x in self.all() if similarity(cand.data, x.data) >= self.dup_threshold]

    def would_admit(self, cand: Scored) -> bool:
        if any(x.score >= cand.score for x in self.near_duplicates(cand)):
            return False
        cell = self.cells.get(descriptor(cand.data), [])
        return len(cell) < self.per_cell or cell[-1].score < cand.score

    def add(self, cand: Scored) -> bool:
        dups = self.near_duplicates(cand)
        if any(x.score >= cand.score for x in dups):
            self.rejected_dupes += 1
            return False
        for x in dups:  # the newcomer is better than every member of its family
            self._remove(x)
            self.rejected_dupes += 1
        key = descriptor(cand.data)
        cell = self.cells.setdefault(key, [])
        cell.append(cand)
        cell.sort(key=lambda x: -x.score)
        if len(cell) > self.per_cell:
            cell.pop()
        return cand in cell

    def _remove(self, x: Scored):
        for k, v in self.cells.items():
            if x in v:
                v.remove(x)
                if not v:
                    del self.cells[k]
                return

    def select(self, count: int, material_penalty: float = 2.0, movers_penalty: float = 1.0,
               length_penalty: float = 0.5) -> list[Scored]:
        """Greedy pick: best score, discounted for repeating material / working pieces / length
        already in the batch, so a batch reads as varied rather than ten takes on one idea."""
        pool = sorted(self.all(), key=lambda x: -x.score)
        out: list[Scored] = []
        mat: collections.Counter = collections.Counter()
        mov: collections.Counter = collections.Counter()
        ln: collections.Counter = collections.Counter()
        while pool and len(out) < count:
            def adjusted(x: Scored) -> float:
                d = x.data
                return (x.score - material_penalty * mat[d["material"]]
                        - movers_penalty * mov[d.get("moved_types", "")] - length_penalty * ln[d["n"]])
            best = max(pool, key=adjusted)
            pool.remove(best)
            out.append(best)
            mat[best.data["material"]] += 1
            mov[best.data.get("moved_types", "")] += 1
            ln[best.data["n"]] += 1
        return out
