import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


LAUNCHER = Path(__file__).resolve().parents[1] / "ppz"


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "finder with spaces"
        self.root.mkdir()
        shutil.copy(LAUNCHER, self.root / "ppz")
        package = self.root / "premove_puzzles"
        package.mkdir()
        (package / "__init__.py").write_text("")
        (package / "cli.py").write_text(
            "import json, sys\n"
            "def main():\n"
            "    print(json.dumps([sys.prefix, sys.argv[1:]]))\n"
        )

    def run_launcher(self, *args):
        return subprocess.run(
            [sys.executable, str(self.root / "ppz"), *args],
            cwd=self.root.parent,
            capture_output=True,
            text=True,
        )

    def test_prefers_local_venv_and_forwards_arguments(self):
        import json

        subprocess.run(
            [sys.executable, "-m", "venv", "--without-pip", str(self.root / ".venv")],
            check=True,
        )
        result = self.run_launcher("generate", "--pieces", "pawn")
        self.assertEqual(result.returncode, 0, result.stderr)
        prefix, args = json.loads(result.stdout)
        self.assertEqual(os.path.realpath(prefix), os.path.realpath(self.root / ".venv"))
        self.assertEqual(args, ["generate", "--pieces", "pawn"])

    def test_uses_current_python_when_no_venv_exists(self):
        import json

        result = self.run_launcher("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        prefix, args = json.loads(result.stdout)
        self.assertEqual(os.path.realpath(prefix), os.path.realpath(sys.prefix))
        self.assertEqual(args, ["--help"])

    def test_reports_broken_venv(self):
        (self.root / ".venv").mkdir()
        result = self.run_launcher("--help")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("recreate the puzzle-finder virtual environment", result.stderr)


if __name__ == "__main__":
    unittest.main()
