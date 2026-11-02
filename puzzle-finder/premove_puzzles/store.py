"""Review queue and puzzle database.

queue  (default ./review_queue.jsonl): one candidate per line, with full analysis and a
       status of pending / accepted / rejected.
db     (default ./puzzles.json): the accepted puzzles, a JSON array of
       {"fen", "url", "number_of_moves", "solution", ...}. `ppz db export` turns it into
       whatever shape the game needs (json, jsonl, csv, sql).
"""
from __future__ import annotations

import csv
import io
import json
import os
import time
from pathlib import Path

from .engine import chesscom_url
from .quality import canonical_key

DEFAULT_QUEUE = Path(os.environ.get("PPZ_QUEUE", "review_queue.jsonl"))
DEFAULT_DB = Path(os.environ.get("PPZ_DB", "puzzles.json"))


def review_block(d: dict, with_solution: bool = True) -> dict:
    """The block shown to the developer for manual validation.

    `solution` is one shortest premove sequence in SAN, e.g. ["Rc1", "Qb2", "Ra1"].
    """
    block = {"fen": d["fen"], "url": chesscom_url(d["fen"]), "number_of_moves": d["n"]}
    if with_solution:
        block["solution"] = d["plan_san"]
    return block


class Queue:
    def __init__(self, path: Path = DEFAULT_QUEUE):
        self.path = Path(path)

    def load(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(l) for l in self.path.read_text().splitlines() if l.strip()]

    def save(self, items: list[dict]):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text("".join(json.dumps(x) + "\n" for x in items))
        tmp.replace(self.path)

    def append(self, entries: list[dict]):
        with self.path.open("a") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")

    def keys(self) -> set[str]:
        return {x.get("canonical") or canonical_key(x["fen"]) for x in self.load()}


class Database:
    def __init__(self, path: Path = DEFAULT_DB):
        self.path = Path(path)

    def load(self) -> list[dict]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text() or "[]")

    def save(self, items: list[dict]):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(items, indent=2) + "\n")
        tmp.replace(self.path)

    def keys(self) -> set[str]:
        return {canonical_key(x["fen"]) for x in self.load()}

    def add(self, analysis: dict, extra: dict | None = None) -> tuple[bool, str]:
        items = self.load()
        key = canonical_key(analysis["fen"])
        for x in items:
            if canonical_key(x["fen"]) == key:
                same = "" if x["fen"] == analysis["fen"] else " (a mirror image)"
                return False, f"already in database{same}: {x['fen']}"
        entry = {
            **review_block(analysis),
            "solution": analysis["plan_san"],
            "solution_uci": analysis["plan_uci"],
            "material": analysis.get("material"),
            "solutions_count": analysis.get("solutions"),
            "added": time.strftime("%Y-%m-%d"),
        }
        if extra:
            entry.update(extra)
        items.append(entry)
        self.save(items)
        return True, "added"

    def remove(self, fen: str) -> bool:
        items = self.load()
        key = canonical_key(fen)
        keep = [x for x in items if canonical_key(x["fen"]) != key]
        if len(keep) == len(items):
            return False
        self.save(keep)
        return True

    def export(self, fmt: str, fields: list[str], table: str = "puzzles") -> str:
        items = [{k: x.get(k) for k in fields} for x in self.load()]
        if fmt == "json":
            return json.dumps(items, indent=2)
        if fmt == "jsonl":
            return "".join(json.dumps(x) + "\n" for x in items)
        if fmt == "csv":
            buf = io.StringIO()
            wr = csv.DictWriter(buf, fieldnames=fields)
            wr.writeheader()
            for x in items:
                wr.writerow({k: (json.dumps(v) if isinstance(v, list) else v) for k, v in x.items()})
            return buf.getvalue()
        if fmt == "sql":
            def lit(v):
                if v is None:
                    return "NULL"
                if isinstance(v, (int, float)):
                    return str(v)
                if isinstance(v, list):
                    v = json.dumps(v)
                return "'" + str(v).replace("'", "''") + "'"
            cols = ", ".join(fields)
            return "".join(f"INSERT INTO {table} ({cols}) VALUES ({', '.join(lit(x[k]) for k in fields)});\n"
                           for x in items)
        raise ValueError(f"unknown format {fmt}")
