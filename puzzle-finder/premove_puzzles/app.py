"""The game's puzzle list (src/game/puzzles.json in the app repo).

There is one entry per level, in play order, and each entry's id is its world-level
("3-2" is the second level of world 3). Every world-level always has a puzzle, so the
file's ids are fixed: adding a puzzle at a world-level replaces whatever is there, and
the ids never shift or renumber.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from .quality import canonical_key

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_APP_PUZZLES = Path(os.environ.get("PPZ_APP_PUZZLES", ROOT.parent / "src" / "game" / "puzzles.json"))

NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
                "eleven", "twelve"]
PIECE_NAMES = {"Q": "queen", "R": "rook", "B": "bishop", "N": "knight", "P": "pawn"}


def _side(letters: str) -> str:
    """'QRR' -> 'queen and two rooks'."""
    counts: dict[str, int] = {}
    for ch in letters:
        counts[ch] = counts.get(ch, 0) + 1
    parts = []
    for ch in "QRBNP":
        if ch in counts:
            name = PIECE_NAMES[ch]
            parts.append(name if counts[ch] == 1 else f"{NUMBER_WORDS[counts[ch]]} {name}s")
    if not parts:
        return ""
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def default_title(material: str) -> str:
    """'KQR-KP' -> 'Queen and rook vs king and pawn'."""
    white, black = material.split("-")
    w, b = _side(white[1:]), _side(black[1:])
    title = f"{w or 'king'} vs king" + (f" and {b}" if b else "")
    return title[0].upper() + title[1:]


_LEVEL_ID = re.compile(r"([1-9]\d*)-([1-9]\d*)")


def parse_level(level_id: str) -> tuple[int, int] | None:
    """'3-2' -> (3, 2); None if it isn't a world-level id."""
    m = _LEVEL_ID.fullmatch(str(level_id).strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def default_description(n: int) -> str:
    count = NUMBER_WORDS[n] if n < len(NUMBER_WORDS) else str(n)
    return f"Plan the forced premove mate in {count}, allowing for every legal Black reply."


class AppPuzzles:
    def __init__(self, path: Path = DEFAULT_APP_PUZZLES):
        self.path = Path(path)

    def exists(self) -> bool:
        return self.path.exists()

    def load(self) -> list[dict]:
        if not self.path.exists():
            raise FileNotFoundError(f"{self.path} not found (use --app-puzzles or PPZ_APP_PUZZLES)")
        data = json.loads(self.path.read_text())
        if not isinstance(data, list):
            raise ValueError(f"{self.path} must contain a JSON array")
        self.check_layout(data)
        return data

    def check_layout(self, puzzles: list[dict]):
        """Ids must be world-levels in play order: 1-1, 1-2, …, 2-1, … with no gaps."""
        expected_world, expected_level = 1, 1
        for p in puzzles:
            slot = parse_level(p.get("id", ""))
            if slot is None:
                raise ValueError(f"{self.path}: puzzle id {p.get('id')!r} is not a world-level like '3-2'")
            if slot == (expected_world + 1, 1) and expected_level > 1:
                expected_world, expected_level = slot
            if slot != (expected_world, expected_level):
                raise ValueError(f"{self.path}: expected level {expected_world}-{expected_level} "
                                 f"but found {p['id']}; every world-level needs exactly one puzzle, in order")
            expected_level += 1

    @staticmethod
    def index_of(puzzles: list[dict], level_id: str) -> int | None:
        slot = parse_level(level_id)
        for i, p in enumerate(puzzles):
            if slot is not None and parse_level(p["id"]) == slot:
                return i
        return None

    def save(self, puzzles: list[dict]):
        self.check_layout(puzzles)
        ordered = [{"id": p["id"], **{k: v for k, v in p.items() if k != "id"}} for p in puzzles]
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(ordered, indent=2) + "\n")
        tmp.replace(self.path)

    @staticmethod
    def entry(analysis: dict, title: str | None, description: str | None) -> dict:
        return {
            "id": "",
            "title": title or default_title(analysis["material"]),
            "description": description or default_description(analysis["n"]),
            "fen": analysis["fen"],
            "number_of_moves": analysis["n"],
            "solution": analysis["plan_san"],
            "solution_uci": analysis["plan_uci"],
        }

    def duplicate_of(self, puzzles: list[dict], fen: str, ignore_index: int | None = None) -> str | None:
        """The world-level of another level with this position (or a mirror image), if any."""
        key = canonical_key(fen)
        for i, p in enumerate(puzzles):
            if i != ignore_index and canonical_key(p["fen"]) == key:
                return p["id"]
        return None
