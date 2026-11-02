"""The game's puzzle list (src/game/puzzles.json in the app repo).

Puzzles are numbered 1..N and unlock in order, so numbers are always kept contiguous:
adding at an existing number replaces that puzzle (or shifts the rest with insert=True),
adding at N+1 appends, and removing renumbers everything after it.
"""
from __future__ import annotations

import json
import os
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
        return data

    def save(self, puzzles: list[dict]):
        for i, p in enumerate(puzzles):  # keep ids contiguous: "1".."N"
            p["id"] = str(i + 1)
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

    def duplicate_of(self, puzzles: list[dict], fen: str, ignore_index: int | None = None) -> int | None:
        key = canonical_key(fen)
        for i, p in enumerate(puzzles):
            if i != ignore_index and canonical_key(p["fen"]) == key:
                return i + 1
        return None
