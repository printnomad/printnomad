"""Empaqueta el plugin de OrcaSlicer como wheel puro (`*-py3-none-any.whl`).

Uso: python orca-plugin/tools/build.py [--install]

La wheel lleva `betterbridge_orca/` (plugin) y una copia del núcleo en
`betterbridge_orca/core/` (los imports del núcleo son relativos). Con
`--install` la copia a `~/Library/Application Support/OrcaSlicer/orca_plugins/betterbridge/`.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import shutil
import subprocess
import tomllib
import zipfile
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent          # orca-plugin/
REPO_ROOT = PLUGIN_ROOT.parent
PLUGIN_DIR = PLUGIN_ROOT / "betterbridge_orca"
CORE_DIR = REPO_ROOT / "core" / "src" / "betterbridge"
DIST = PLUGIN_ROOT / "dist"
UI_DIR = PLUGIN_ROOT / "ui"
PANEL_HTML = UI_DIR / "dist" / "panel.html"
INSTALL_DIR = Path.home() / "Library/Application Support/OrcaSlicer/orca_plugins/betterbridge"


def _record_line(name: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{name},sha256={digest},{len(data)}"


PACKAGE_PATTERNS = ("*.py", "locales/*.json", "data/*.json")


def _package_files(root: Path) -> list[Path]:
    return sorted({f for pattern in PACKAGE_PATTERNS for f in root.rglob(pattern) if "__pycache__" not in f.parts})


def build_ui() -> Path:
    """Compila el panel (Tailwind) con npm; necesita `npm ci` en ui/ la primera vez."""
    if not (UI_DIR / "node_modules").is_dir():
        subprocess.run(["npm", "ci"], cwd=UI_DIR, check=True)
    subprocess.run(["npm", "run", "build"], cwd=UI_DIR, check=True)
    return PANEL_HTML


def build() -> Path:
    version = tomllib.loads((PLUGIN_ROOT / "pyproject.toml").read_text())["project"]["version"]
    files: dict[str, bytes] = {}
    # Código y catálogos de idioma (locales/*.json) del plugin y del núcleo.
    for f in _package_files(PLUGIN_DIR):
        files[f"betterbridge_orca/{f.relative_to(PLUGIN_DIR).as_posix()}"] = f.read_bytes()
    for f in _package_files(CORE_DIR):
        files[f"betterbridge_orca/core/{f.relative_to(CORE_DIR).as_posix()}"] = f.read_bytes()
    files["betterbridge_orca/panel.html"] = build_ui().read_bytes()

    dist_info = f"betterbridge_orca-{version}.dist-info"
    files[f"{dist_info}/METADATA"] = (
        "Metadata-Version: 2.1\n"
        "Name: betterbridge-orca\n"
        f"Version: {version}\n"
        "Summary: Convierte el proyecto abierto a Flashforge Creator 5 Pro\n"
        "Requires-Python: >=3.12\n").encode()
    files[f"{dist_info}/WHEEL"] = (
        b"Wheel-Version: 1.0\nGenerator: betterbridge\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
    files[f"{dist_info}/top_level.txt"] = b"betterbridge_orca\n"
    record = [_record_line(n, d) for n, d in files.items()] + [f"{dist_info}/RECORD,,"]
    files[f"{dist_info}/RECORD"] = ("\n".join(record) + "\n").encode()

    DIST.mkdir(exist_ok=True)
    out = DIST / f"betterbridge_orca-{version}-py3-none-any.whl"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--install", action="store_true", help="copiar a la carpeta de plugins de OrcaSlicer")
    args = ap.parse_args()
    wheel = build()
    print(f"wheel: {wheel}")
    if args.install:
        INSTALL_DIR.mkdir(parents=True, exist_ok=True)
        for old in INSTALL_DIR.glob("*.whl"):
            old.unlink()  # el host exige un solo .whl por carpeta
        # Orca extrae la wheel aquí una vez y no la renueva al cambiar de versión.
        shutil.rmtree(INSTALL_DIR / "__whl_extracted__", ignore_errors=True)
        shutil.copy2(wheel, INSTALL_DIR / wheel.name)
        print(f"instalado en: {INSTALL_DIR}")


if __name__ == "__main__":
    main()
