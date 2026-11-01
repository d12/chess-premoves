"""Thin wrappers around the C++ `pmcore` binary."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import queue as queue_mod
from pathlib import Path
from urllib.parse import quote_plus

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
BINARY = ENGINE_DIR / "pmcore"


def chesscom_url(fen: str) -> str:
    return "https://www.chess.com/analysis?fen=" + quote_plus(fen)


TABLES_DIR = Path(os.environ.get("PPZ_TABLES", ROOT / "tables"))


def ensure_binary(name: str = "pmcore") -> Path:
    """Build an engine binary on first use (pmcore, tbgen, or tbgen_cuda)."""
    binary = ENGINE_DIR / name
    deps = [ENGINE_DIR / "src" / f for f in ("pmcore.cpp", "solver.hpp", "tb_core.h", "tb_driver.h",
                                             "tb_probe.h", "tbgen.cpp", "tbgen_cuda.cu")]
    if binary.exists() and all(binary.stat().st_mtime >= d.stat().st_mtime for d in deps if d.exists()):
        return binary
    print(f"building {name} (one time)...", flush=True)
    subprocess.run(["make", "-s", "-C", str(ENGINE_DIR), name], check=True)
    return binary


def table_files(tables_dir: Path = TABLES_DIR) -> list[Path]:
    return sorted(Path(tables_dir).glob("*.tb")) if Path(tables_dir).is_dir() else []


def tables_args(tables_dir: Path = TABLES_DIR) -> list[str]:
    return ["--tables", str(tables_dir)] if table_files(tables_dir) else []


def cuda_gpus() -> list[str]:
    """Names of NVIDIA GPUs visible to the driver (empty if none / no driver)."""
    smi = shutil.which("nvidia-smi")
    if not smi:
        return []
    try:
        out = subprocess.run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [l.strip() for l in out.stdout.splitlines() if l.strip()] if out.returncode == 0 else []


def cuda_buildable() -> bool:
    return (ENGINE_DIR / "tbgen_cuda").exists() or shutil.which(os.environ.get("NVCC", "nvcc")) is not None


def pick_device(requested: str = "auto") -> str:
    if requested == "cpu":
        return "cpu"
    gpus = cuda_gpus()
    if requested.startswith("cuda"):
        if not gpus:
            raise RuntimeError("no NVIDIA GPU visible (nvidia-smi found nothing)")
        if not cuda_buildable():
            raise RuntimeError("nvcc not found; install the CUDA toolkit to build tbgen_cuda")
        return requested
    return "cuda" if gpus and cuda_buildable() else "cpu"


def build_tables(materials: list[str], device: str, cap: int = 15, force: bool = False,
                 tables_dir: Path = TABLES_DIR, threads: int | None = None):
    """Yields one dict per table (built or already cached)."""
    Path(tables_dir).mkdir(parents=True, exist_ok=True)
    if device.startswith("cuda"):
        cmd = [str(ensure_binary("tbgen_cuda"))]
        if ":" in device:
            cmd += ["--device", device.split(":", 1)[1]]
    else:
        cmd = [str(ensure_binary("tbgen"))]
        if threads:
            cmd += ["--threads", str(threads)]
    cmd += ["--material", ",".join(materials), "--dir", str(tables_dir), "--cap", str(cap)]
    if force:
        cmd.append("--force")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
    for line in proc.stdout:
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue
    if proc.wait() != 0:
        raise RuntimeError(f"table builder failed (exit {proc.returncode})")


def find_stockfish(explicit: str | None = None) -> str | None:
    if explicit:
        return explicit
    for cand in (os.environ.get("STOCKFISH"), shutil.which("stockfish"), "/usr/games/stockfish",
                 "/opt/homebrew/bin/stockfish", "/usr/local/bin/stockfish"):
        if cand and Path(cand).exists():
            return cand
    return None


class Solver:
    """Persistent `pmcore serve` process: one JSON reply per request."""

    def __init__(self):
        self.proc = subprocess.Popen([str(ensure_binary()), "serve", *tables_args()], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, bufsize=1)

    def analyze(self, fen: str, max_moves: int = 8, require: str = "", forbid: str = "",
                deep: bool = True, nodes: int = 50_000_000) -> dict:
        self.proc.stdin.write(f"{fen}\t{max_moves}\t{require}\t{forbid}\t{1 if deep else 0}\t{nodes}\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class GeneratorPool:
    """Runs N `pmcore gen` workers with different seeds and merges their output."""

    def __init__(self, workers: int, args: list[str], seed: int):
        self.q: queue_mod.Queue = queue_mod.Queue()
        self.procs = []
        self.stats: dict[int, dict] = {}
        binary = str(ensure_binary())
        for i in range(workers):
            p = subprocess.Popen([binary, "gen", *args, *tables_args(), "--seed", str(seed * 1000 + i)],
                                 stdout=subprocess.PIPE, text=True, bufsize=1)
            self.procs.append(p)
            threading.Thread(target=self._pump, args=(i, p), daemon=True).start()

    def _pump(self, idx: int, p: subprocess.Popen):
        for line in p.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "stats":
                self.stats[idx] = msg
            else:
                self.q.put(msg["data"])
        self.q.put(None)

    def alive(self) -> bool:
        return any(p.poll() is None for p in self.procs)

    def get(self, timeout: float):
        return self.q.get(timeout=timeout)

    def totals(self) -> dict:
        tot: dict[str, float] = {}
        for s in self.stats.values():
            for k, v in s.items():
                if isinstance(v, (int, float)):
                    tot[k] = tot.get(k, 0) + v
        return tot

    def stop(self):
        for p in self.procs:
            if p.poll() is None:
                p.terminate()
        for p in self.procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
