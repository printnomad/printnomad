"""Laminadores conocidos y dónde guardan sus perfiles (datos en data/slicers.json).

El conocimiento de cada laminador es dato, no código: rutas de perfiles de sistema y
de usuario por sistema operativo, esquema de URL, repositorio de perfiles y
particularidades ("quirks"). Solo se registran rutas verificadas.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .profiles import ProfileError, ProfileLibrary

DATA_FILE = Path(__file__).parent / "data" / "slicers.json"
PLATFORMS = {"darwin": "macos", "win32": "windows"}  # el resto: "linux"


def platform_key() -> str:
    return PLATFORMS.get(sys.platform, "linux")


@dataclass
class Slicer:
    key: str
    name: str
    url_scheme: str | None = None
    profile_repo: dict = field(default_factory=dict)
    quirks: dict = field(default_factory=dict)
    app: Path | None = None
    system_roots: list[Path] = field(default_factory=list)
    user_root: Path | None = None

    @property
    def installed(self) -> bool:
        return bool((self.app and self.app.exists()) or any(r.is_dir() for r in self.system_roots))

    def user_dirs(self) -> list[Path]:
        """Una carpeta por cuenta (`user/<id>/`) con machine/process/filament."""
        if not self.user_root or not self.user_root.is_dir():
            return []
        return sorted(d for d in self.user_root.iterdir() if d.is_dir())

    def library(self, include_user: bool = True) -> ProfileLibrary:
        roots = [r for r in self.system_roots if r.is_dir()]
        return ProfileLibrary.from_roots(roots, self.user_dirs() if include_user else [])

    def quirk(self, name: str, default=None):
        value = self.quirks.get(name)
        return default if value is None else value


def _expand(path: str, app: Path | None) -> Path:
    if "{app}" in path:
        if app is None:
            raise ValueError(f"'{{app}}' en una ruta sin 'app': {path}")
        path = path.replace("{app}", str(app))
    return Path(path).expanduser()


def registry(data_file: Path = DATA_FILE, platform: str | None = None) -> dict[str, Slicer]:
    """Laminadores con rutas para la plataforma (los demás se omiten)."""
    platform = platform or platform_key()
    data = json.loads(Path(data_file).read_text(encoding="utf-8"))
    out: dict[str, Slicer] = {}
    for key, spec in data.items():
        if key.startswith("_") or platform not in spec:
            continue
        paths = spec[platform]
        app = Path(paths["app"]).expanduser() if paths.get("app") else None
        out[key] = Slicer(
            key=key,
            name=spec["name"],
            url_scheme=spec.get("url_scheme"),
            profile_repo=spec.get("profile_repo", {}),
            quirks={k: v for k, v in spec.get("quirks", {}).items() if not k.startswith("_")},
            app=app,
            system_roots=[_expand(p, app) for p in paths.get("system", [])],
            user_root=_expand(paths["user"], app) if paths.get("user") else None,
        )
    return out


def installed_slicers(data_file: Path = DATA_FILE) -> list[Slicer]:
    return [s for s in registry(data_file).values() if s.installed]


def source_slicer(kind: str, data_file: Path = DATA_FILE) -> str | None:
    """Slicer whose system presets projects of `kind` start from (e.g. "bambu" → "bambustudio")."""
    data = json.loads(Path(data_file).read_text(encoding="utf-8"))
    return next((key for key, spec in data.items()
                 if not key.startswith("_") and kind in spec.get("source_of", ())), None)


def source_library(kind: str, data_file: Path = DATA_FILE) -> ProfileLibrary | None:
    """System presets of the installed source slicer, or None (not installed or unreadable)."""
    key = source_slicer(kind, data_file)
    slicer = registry(data_file).get(key) if key else None
    if slicer is None or not slicer.installed:
        return None
    try:
        return slicer.library(include_user=False)
    except ProfileError:
        return None
