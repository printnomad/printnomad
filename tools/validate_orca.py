"""Valida .3mf convertidos laminándolos con el CLI de OrcaSlicer.

Uso: python tools/validate_orca.py salida1.3mf [salida2.3mf ...] [--orca RUTA]

Lamina en una carpeta temporal (no guarda G-code) e informa si Orca rechaza
algún valor del proyecto. El CLI de Orca sale con código 0 aunque falle, así
que el resultado se juzga por los .gcode generados y los mensajes.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_ORCA = "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
# Sin estas opciones el CLI rechaza cualquier proyecto con más de un filamento.
FLAGS = ["--allow-multicolor-oneplate", "--allow-mix-temp", "--allow-newer-file", "--slice", "0"]


def validate(orca: str, path: Path, timeout: int) -> tuple[bool, list[str]]:
    with tempfile.TemporaryDirectory(prefix="pn-orca-") as out:
        try:
            # cwd temporal: el CLI deja un 00000.log en la carpeta actual.
            proc = subprocess.run([orca, *FLAGS, "--outputdir", out, str(path.resolve())],
                                  capture_output=True, text=True, timeout=timeout, cwd=out)
        except subprocess.TimeoutExpired:
            return False, [f"timeout tras {timeout}s"]
        log = (proc.stdout + proc.stderr).splitlines()
        messages = [line.replace(str(path), path.name) for line in log
                    if line.strip() and "run found error" not in line]
        gcodes = list(Path(out).glob("*.gcode"))
        summary = f"{len(gcodes)} placa(s) laminada(s), código {proc.returncode}"
        return bool(gcodes) and proc.returncode == 0, messages + [summary]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--orca", default=DEFAULT_ORCA)
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()
    failed = 0
    for f in args.files:
        ok, messages = validate(args.orca, f, args.timeout)
        failed += not ok
        print(f"{'OK ' if ok else 'FALLA'} {f.name}")
        for m in messages:
            print(f"      {m}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
